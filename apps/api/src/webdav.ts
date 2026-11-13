import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { contentDispositionAttachment, parseSingleByteRange } from "./adminDrive.js";
import {
	DriveError,
	adminDriveOwner,
	assertDriveUnlocked,
	copyDriveNode,
	createDriveFolder,
	deleteDriveNode,
	driveEtagHeader,
	driveIfHeaderTokens,
	drivePathName,
	getDriveNode,
	listDriveChildren,
	listDriveSubtree,
	lockDriveNode,
	moveDriveNode,
	normalizeDrivePath,
	normalizeLockDepth,
	normalizeLockTimeout,
	openDriveFile,
	saveDriveStream,
	unlockDriveNode,
	userDriveOwner,
	type DriveLockInfo,
	type DriveNode,
	type DriveOwner,
} from "./driveStore.js";
import { resolveClientIp } from "./clientIp.js";
import { loginGate } from "./loginThrottle.js";
import { verifyAdminCredentials, verifyCommentUserCredentials } from "./repository.js";

export const DRIVE_DAV_MOUNT = "/dav";
const AUTH_SUCCESS_TTL_MS = 5 * 60 * 1000;
const AUTH_FAILURE_TTL_MS = 30 * 1000;
const MAX_PROPFIND_DEPTH_INFINITY_NODES = 5000;
const MAX_LOCK_BODY_BYTES = 64 * 1024;

type DrivePrincipal =
	| { kind: "admin"; id: number | null; username: string; displayName: string }
	| { kind: "user"; id: number; username: string; displayName: string; storageLocation: "server" | "cloudflare" | null };

type DriveRequest = Request & { driveOwner?: DriveOwner };

type AuthCacheEntry = { principal: DrivePrincipal | null; expiresAt: number };

const authCache = new Map<string, AuthCacheEntry>();

function authCacheKey(username: string, password: string) {
	return createHash("sha256").update(`${username}\u0000${password}`).digest("hex");
}

function readCachedPrincipal(username: string, password: string) {
	const key = authCacheKey(username, password);
	const cached = authCache.get(key);
	if (!cached) return undefined;
	if (cached.expiresAt <= Date.now()) {
		authCache.delete(key);
		return undefined;
	}
	return cached.principal;
}

function rememberPrincipal(username: string, password: string, principal: DrivePrincipal | null) {
	if (authCache.size > 500) authCache.clear();
	authCache.set(authCacheKey(username, password), {
		principal,
		expiresAt: Date.now() + (principal ? AUTH_SUCCESS_TTL_MS : AUTH_FAILURE_TTL_MS),
	});
}

function challenge(res: Response) {
	res.setHeader("WWW-Authenticate", 'Basic realm="Jayson Blog WebDAV", charset="UTF-8"');
	res.status(401).type("text/plain; charset=utf-8").send("需要 WebDAV 账号和密码");
}

async function authenticate(req: Request, res: Response, isUserWebDavEnabled: () => Promise<boolean>): Promise<DrivePrincipal | null> {
	const header = req.header("authorization") ?? "";
	const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/iu.exec(header);
	if (!match) {
		challenge(res);
		return null;
	}
	let decoded = "";
	try {
		decoded = Buffer.from(match[1], "base64").toString("utf8");
	} catch {
		challenge(res);
		return null;
	}
	const separator = decoded.indexOf(":");
	if (separator <= 0) {
		challenge(res);
		return null;
	}
	const username = decoded.slice(0, separator).trim();
	const password = decoded.slice(separator + 1);
	if (!username || !password) {
		challenge(res);
		return null;
	}
	const ip = resolveClientIp(req) || "unknown";
	const decision = loginGate.check("password", ip, username);
	if (!decision.allowed) {
		res.setHeader("Retry-After", String(decision.retryAfterSeconds));
		res.status(429).type("text/plain; charset=utf-8").send("登录尝试过于频繁，请稍后再试");
		return null;
	}

	const cached = readCachedPrincipal(username, password);
	if (cached !== undefined) {
		if (!cached) {
			loginGate.fail("password", ip, username);
			challenge(res);
			return null;
		}
		if (cached.kind === "user" && !(await isUserWebDavEnabled())) {
			res.status(403).type("text/plain; charset=utf-8").send("WebDAV 云盘当前已关闭");
			return null;
		}
		loginGate.succeed("password", ip, username);
		return cached;
	}

	const admin = await verifyAdminCredentials(username, password);
	if (admin) {
		loginGate.succeed("password", ip, username);
		const principal: DrivePrincipal = { kind: "admin", id: admin.id, username: admin.username, displayName: admin.displayName };
		rememberPrincipal(username, password, principal);
		return principal;
	}
	const user = await verifyCommentUserCredentials(username, password);
	if (user) {
		if (!(await isUserWebDavEnabled())) {
			rememberPrincipal(username, password, null);
			res.status(403).type("text/plain; charset=utf-8").send("WebDAV 云盘当前已关闭");
			return null;
		}
		loginGate.succeed("password", ip, username);
		const principal: DrivePrincipal = {
			kind: "user",
			id: user.id,
			username: user.account,
			displayName: user.nickname || user.account,
			storageLocation: user.storageLocation ?? null,
		};
		rememberPrincipal(username, password, principal);
		return principal;
	}
	loginGate.fail("password", ip, username);
	rememberPrincipal(username, password, null);
	challenge(res);
	return null;
}

async function principalOwner(principal: DrivePrincipal) {
	if (principal.kind === "admin") {
		return adminDriveOwner({ id: principal.id, username: principal.username, displayName: principal.displayName });
	}
	return userDriveOwner({
		id: principal.id,
		account: principal.username,
		nickname: principal.displayName,
		storageLocation: principal.storageLocation,
	});
}

function decodeDavPath(req: Request) {
	let decoded = "";
	try {
		decoded = decodeURIComponent(req.path);
	} catch {
		throw new DriveError(400, "请求路径编码无效");
	}
	return normalizeDrivePath(decoded);
}

function xmlEscape(value: string) {
	return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char);
}

function davHref(path: string, isCollection: boolean) {
	const encoded = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
	const href = `${DRIVE_DAV_MOUNT}${encoded.startsWith("/") ? "" : "/"}${encoded}`;
	if (isCollection && !href.endsWith("/")) return `${href}/`;
	return href;
}

function nodeTimestamp(node: DriveNode) {
	const raw = node.updatedAt || node.createdAt;
	if (!raw) return new Date();
	const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
	const date = new Date(normalized);
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function activeLockXml(lock: DriveLockInfo) {
	const timeout = Math.max(1, Math.round((new Date(lock.expiresAt.includes("T") ? lock.expiresAt : lock.expiresAt.replace(" ", "T")).getTime() - Date.now()) / 1000));
	return `<d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>${lock.depth === "0" ? "0" : "infinity"}</d:depth>${lock.owner ? `<d:owner>${xmlEscape(lock.owner)}</d:owner>` : ""}<d:timeout>Second-${Number.isFinite(timeout) && timeout > 0 ? timeout : 3600}</d:timeout><d:locktoken><d:href>${xmlEscape(lock.token)}</d:href></d:locktoken></d:activelock>`;
}

function responseXml(node: DriveNode, lock?: DriveLockInfo | null) {
	const isFolder = node.type === "folder";
	const updated = nodeTimestamp(node);
	const created = nodeTimestamp(node);
	const properties = [
		`<d:displayname>${xmlEscape(isFolder && node.id === 0 ? "全部文件" : node.name)}</d:displayname>`,
		isFolder ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype/>",
		isFolder ? "" : `<d:getcontentlength>${node.byteSize}</d:getcontentlength>`,
		isFolder ? "" : `<d:getcontenttype>${xmlEscape(node.mimeType)}</d:getcontenttype>`,
		`<d:getlastmodified>${updated.toUTCString()}</d:getlastmodified>`,
		`<d:creationdate>${created.toISOString()}</d:creationdate>`,
		`<d:getetag>${xmlEscape(driveEtagHeader(node.etag))}</d:getetag>`,
		"<d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>",
		lock ? `<d:lockdiscovery>${activeLockXml(lock)}</d:lockdiscovery>` : "<d:lockdiscovery/>",
	].filter(Boolean);
	return `<d:response><d:href>${xmlEscape(davHref(node.path, isFolder))}</d:href><d:propstat><d:prop>${properties.join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function multistatus(nodes: DriveNode[], lock?: DriveLockInfo | null) {
	return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${nodes.map((node) => responseXml(node, node.path === nodes[0]?.path ? lock : null)).join("")}</d:multistatus>`;
}

async function readRequestBody(req: Request, limit: number) {
	let body = "";
	for await (const chunk of req as AsyncIterable<Buffer>) {
		body += chunk.toString("utf8");
		if (body.length > limit) throw new DriveError(413, "请求体过大");
	}
	return body;
}

function nodeCollection(nodes: DriveNode[]) {
	return nodes;
}

async function handleOptions(_req: Request, res: Response) {
	res.setHeader("Allow", "OPTIONS, HEAD, GET, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK");
	res.setHeader("DAV", "1, 2");
	res.setHeader("MS-Author-Via", "DAV");
	res.status(200).setHeader("Content-Length", "0").end();
}

async function handlePropfind(req: Request, res: Response, owner: DriveOwner, path: string) {
	void (await readRequestBody(req, 256 * 1024));
	const depthHeader = (req.header("depth") ?? "infinity").trim().toLowerCase();
	const depth = depthHeader === "0" ? 0 : depthHeader === "1" ? 1 : depthHeader === "infinity" ? 2 : 0;
	const target = await getDriveNode(owner, path);
	if (!target) throw new DriveError(404, "文件或目录不存在");
	const nodes: DriveNode[] = [target];
	if (depth >= 1 && target.type === "folder") {
		if (depth === 1) {
			nodes.push(...nodeCollection(await listDriveChildren(owner, path)));
		} else {
			const subtree = await listDriveSubtree(owner, path, MAX_PROPFIND_DEPTH_INFINITY_NODES);
			nodes.push(...subtree.filter((node) => node.path !== path));
		}
	}
	if (nodes.length > MAX_PROPFIND_DEPTH_INFINITY_NODES) nodes.length = MAX_PROPFIND_DEPTH_INFINITY_NODES;
	res.status(207).type("application/xml; charset=utf-8").send(multistatus(nodes));
}

function parseDestination(req: Request) {
	const destination = req.header("destination");
	if (!destination) throw new DriveError(400, "缺少 Destination 请求头");
	let pathname = "";
	try {
		const url = new URL(destination, "http://webdav.local");
		pathname = url.pathname;
	} catch {
		throw new DriveError(400, "Destination 无效");
	}
	let decoded = "";
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		throw new DriveError(400, "Destination 编码无效");
	}
	const mountPrefix = `${DRIVE_DAV_MOUNT}/`;
	if (decoded === DRIVE_DAV_MOUNT) return "/";
	if (!decoded.startsWith(mountPrefix)) throw new DriveError(400, "Destination 不属于本站 WebDAV");
	return normalizeDrivePath(decoded.slice(DRIVE_DAV_MOUNT.length));
}

function overwriteFlag(req: Request) {
	const value = (req.header("overwrite") ?? "T").trim().toUpperCase();
	return value !== "F";
}

function ifHeader(req: Request) {
	return req.header("if") ?? undefined;
}

function matchesEtag(header: string | undefined, etag: string) {
	if (!header) return false;
	const target = driveEtagHeader(etag);
	return header.split(",").map((value) => value.trim()).some((value) => value === "*" || value === target);
}

async function handleGet(req: Request, res: Response, owner: DriveOwner, path: string) {
	const handle = await openDriveFile(owner, path);
	if (req.header("if-none-match") && matchesEtag(req.header("if-none-match"), handle.node.etag)) {
		res.status(304).setHeader("ETag", driveEtagHeader(handle.node.etag)).end();
		return;
	}
	if (req.header("if-match") && !matchesEtag(req.header("if-match"), handle.node.etag)) {
		throw new DriveError(412, "ETag 不匹配");
	}
	const size = handle.size;
	let start = 0;
	let end = Math.max(0, size - 1);
	let status = 200;
	const rangeHeader = req.header("range");
	if (rangeHeader && !handle.stream) {
		const range = parseSingleByteRange(rangeHeader, size);
		if (range === "unsatisfiable") {
			res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
			return;
		}
		if (range) {
			start = range.start;
			end = range.end;
			status = 206;
			res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
		}
	}
	res.status(status);
	res.setHeader("Content-Type", handle.node.mimeType || "application/octet-stream");
	res.setHeader("Content-Length", String(handle.stream ? size : Math.max(0, end - start + 1)));
	res.setHeader("Content-Disposition", contentDispositionAttachment(handle.node.name).replace(/^attachment/u, "inline"));
	res.setHeader("Accept-Ranges", "bytes");
	res.setHeader("ETag", driveEtagHeader(handle.node.etag));
	res.setHeader("Last-Modified", nodeTimestamp(handle.node).toUTCString());
	res.setHeader("Cache-Control", "private, no-cache");
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	if (handle.stream) {
		handle.stream.pipe(res);
		return;
	}
	if (!handle.localPath) {
		res.end();
		return;
	}
	createReadStream(handle.localPath, { start, end }).pipe(res);
}

async function handlePut(req: Request, res: Response, owner: DriveOwner, path: string) {
	await assertDriveUnlocked(owner, path, ifHeader(req));
	const existing = await getDriveNode(owner, path);
	const ifMatch = req.header("if-match")?.trim();
	if (ifMatch && ifMatch !== "*" && (!existing || !matchesEtag(ifMatch, existing.etag))) throw new DriveError(412, "ETag 不匹配");
	if (ifMatch === "*" && !existing) throw new DriveError(412, "资源不存在");
	const ifNoneMatch = req.header("if-none-match")?.trim();
	if (ifNoneMatch === "*" && existing) throw new DriveError(412, "资源已存在");
	if (ifNoneMatch && ifNoneMatch !== "*" && existing && matchesEtag(ifNoneMatch, existing.etag)) throw new DriveError(412, "ETag 匹配");
	const contentLengthHeader = req.header("content-length");
	const contentLength = contentLengthHeader !== undefined ? Number(contentLengthHeader) : undefined;
	const result = await saveDriveStream(owner, path, req as unknown as Readable, {
		mimeType: req.header("content-type"),
		contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
	});
	res.status(result.created ? 201 : 204);
	res.setHeader("ETag", driveEtagHeader(result.node.etag));
	res.setHeader("Content-Length", "0");
	if (result.created) res.setHeader("Location", davHref(result.node.path, false));
	res.end();
}

async function handleMkcol(req: Request, res: Response, owner: DriveOwner, path: string) {
	const body = await readRequestBody(req, 256 * 1024);
	if (body.trim()) throw new DriveError(415, "MKCOL 不支持请求体");
	const existing = await getDriveNode(owner, path);
	if (existing) throw new DriveError(405, "同名文件或目录已存在");
	await assertDriveUnlocked(owner, path, ifHeader(req));
	await createDriveFolder(owner, path);
	res.status(201).setHeader("Content-Length", "0").end();
}

async function handleDelete(req: Request, res: Response, owner: DriveOwner, path: string) {
	await deleteDriveNode(owner, path, ifHeader(req));
	res.status(204).end();
}

async function handleMove(req: Request, res: Response, owner: DriveOwner, path: string) {
	await assertDriveUnlocked(owner, path, ifHeader(req));
	const destination = parseDestination(req);
	const existing = await getDriveNode(owner, destination);
	await assertDriveUnlocked(owner, destination, ifHeader(req));
	await moveDriveNode(owner, path, destination, overwriteFlag(req));
	res.status(existing ? 204 : 201).setHeader("Content-Length", "0").end();
}

async function handleCopy(req: Request, res: Response, owner: DriveOwner, path: string) {
	const destination = parseDestination(req);
	const depth = (req.header("depth") ?? "infinity").trim().toLowerCase();
	const source = await getDriveNode(owner, path);
	if (!source) throw new DriveError(404, "源文件或目录不存在");
	if (source.type === "folder" && depth === "0") throw new DriveError(400, "暂不支持 Depth: 0 的目录复制");
	const existing = await getDriveNode(owner, destination);
	await copyDriveNode(owner, path, destination, overwriteFlag(req));
	res.status(existing ? 204 : 201).setHeader("Content-Length", "0").end();
}

async function handleLock(req: Request, res: Response, owner: DriveOwner, path: string) {
	const body = await readRequestBody(req, MAX_LOCK_BODY_BYTES);
	const ownerName = /<d:owner[^>]*>([\s\S]*?)<\/d:owner>/iu.exec(body)?.[1]?.replace(/<[^>]+>/gu, "").trim().slice(0, 200) ?? "";
	const existed = Boolean(await getDriveNode(owner, path));
	let lock: DriveLockInfo;
	try {
		const result = await lockDriveNode(owner, path, {
			depth: normalizeLockDepth(req.header("depth")),
			timeoutSeconds: normalizeLockTimeout(req.header("timeout")),
			lockOwner: ownerName,
			ifHeader: ifHeader(req),
		});
		lock = result.lock;
	} catch (error) {
		if (error instanceof DriveError) throw error;
		throw new DriveError(500, "锁定失败");
	}
	const lockdiscovery = `<d:prop xmlns:d="DAV:"><d:lockdiscovery>${activeLockXml(lock)}</d:lockdiscovery></d:prop>`;
	res.status(existed ? 200 : 201);
	res.setHeader("Lock-Token", `<${lock.token}>`);
	res.type("application/xml; charset=utf-8").send(lockdiscovery);
}

async function handleUnlock(req: Request, res: Response, owner: DriveOwner, path: string) {
	const tokenHeader = req.header("lock-token") ?? "";
	const tokenMatch = /<?(opaquelocktoken:[0-9a-f-]{36})>?/iu.exec(tokenHeader);
	const token = tokenMatch?.[1] ?? driveIfHeaderTokens(req.header("if"))[0] ?? "";
	if (!token) throw new DriveError(400, "缺少 Lock-Token 请求头");
	const unlocked = await unlockDriveNode(owner, path, token);
	if (!unlocked) throw new DriveError(409, "锁不存在或令牌不匹配");
	res.status(204).end();
}

async function handleProppatch(req: Request, res: Response, owner: DriveOwner, path: string) {
	await readRequestBody(req, 256 * 1024);
	const node = await getDriveNode(owner, path);
	if (!node) throw new DriveError(404, "文件或目录不存在");
	const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${xmlEscape(davHref(node.path, node.type === "folder"))}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
	res.status(207).type("application/xml; charset=utf-8").send(xml);
}

function driveErrorBody(message: string) {
	return `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:message>${xmlEscape(message)}</d:message></d:error>`;
}

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
	if (res.headersSent) {
		res.end();
		return;
	}
	if (error instanceof DriveError) {
		res.status(error.status).type("application/xml; charset=utf-8").send(driveErrorBody(error.message));
		return;
	}
	if (error instanceof URIError) {
		res.status(400).type("text/plain; charset=utf-8").send("请求路径编码无效");
		return;
	}
	const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { statusCode?: number })?.statusCode;
	if (typeof status === "number" && status >= 400 && status < 600) {
		res.status(status).type("text/plain; charset=utf-8").send(error instanceof Error ? error.message : "请求失败");
		return;
	}
	console.error("[webdav] unhandled error:", error);
	res.status(500).type("text/plain; charset=utf-8").send("WebDAV 服务器内部错误");
}

export function createWebDavRouter(options: { isUserWebDavEnabled: () => Promise<boolean> }): Router {
	const router = express.Router();
	router.use((req: DriveRequest, res: Response, next: NextFunction) => {
		void (async () => {
			const principal = await authenticate(req, res, options.isUserWebDavEnabled);
			if (!principal) return;
			const owner = await principalOwner(principal);
			req.driveOwner = owner;
			const path = decodeDavPath(req);
			switch (req.method.toUpperCase()) {
				case "OPTIONS":
					await handleOptions(req, res);
					return;
				case "PROPFIND":
					await handlePropfind(req, res, owner, path);
					return;
				case "PROPPATCH":
					await handleProppatch(req, res, owner, path);
					return;
				case "GET":
				case "HEAD":
					await handleGet(req, res, owner, path);
					return;
				case "PUT":
					await handlePut(req, res, owner, path);
					return;
				case "MKCOL":
					await handleMkcol(req, res, owner, path);
					return;
				case "DELETE":
					await handleDelete(req, res, owner, path);
					return;
				case "MOVE":
					await handleMove(req, res, owner, path);
					return;
				case "COPY":
					await handleCopy(req, res, owner, path);
					return;
				case "LOCK":
					await handleLock(req, res, owner, path);
					return;
				case "UNLOCK":
					await handleUnlock(req, res, owner, path);
					return;
				default:
					res.setHeader("Allow", "OPTIONS, HEAD, GET, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK");
					res.status(405).type("text/plain; charset=utf-8").send("不支持的 WebDAV 方法");
			}
		})().catch(next);
	});
	router.use(errorHandler);
	return router;
}
