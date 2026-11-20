/**
 * 加速节点的 HTTP 入口：路由、ticket 鉴权、限流、缓存与上游转发编排。
 *
 * 所有路由只做三件事：校验输入、拿并发额度、把字节从上游搬到客户端（或从磁盘读）。
 * 真正的网络细节在 proxy.ts，磁盘细节在 cache.ts，这里保持"窄"以便单测能直接起服务。
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Transform, pipeline } from "node:stream";
import type { TransformCallback } from "node:stream";
import { pathToFileURL } from "node:url";

import { config, type AccelConfig } from "./config.js";
import { buildRangeHeaders, DiskCache, ifRangeMatches, parseRangeHeader, type CacheEntry, type CacheMeta } from "./cache.js";
import { checkAllowedUrl, fetchReleases, fileNameFromUrl, GithubApiError } from "./github.js";
import { buildDownloadHeaders, buildGitHeaders, filterHeaders, openUpstream, ProxyError, type UpstreamFetcher } from "./proxy.js";
import { AccessGuard } from "./ratelimit.js";
import { createThrottleStream, pipeToClient } from "./throttle.js";
import { verifyTicket, type TicketTier } from "./ticket.js";

export const VERSION = "1.0.0";

const GITHUB_BASE = "https://github.com";
/** 与文档第 2 节一致：ticket = base64url payload + "." + 32 位十六进制签名。 */
const TICKET_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{32}$/u;

type ResponseHeaders = Record<string, string | string[]>;

/** 一次出流的档位与对应速率：档位只决定用哪个配置值，速率本身仍在节点侧配置。 */
interface TierRate {
	readonly tier: TicketTier;
	readonly bytesPerSecond: number;
}

function resolveTierRate(cfg: AccelConfig, tier: TicketTier): TierRate {
	return { tier, bytesPerSecond: tier === "member" ? cfg.memberBytesPerSecond : cfg.guestBytesPerSecond };
}

/** 档位与速率写进响应头：现场 curl -I 就能确认这条连接被算进哪一档、限到多少。 */
function tierHeaders(rate: TierRate): Record<string, string> {
	return { "x-accel-tier": rate.tier, "x-accel-rate": String(rate.bytesPerSecond) };
}

export interface AppDependencies {
	readonly cache?: DiskCache;
	readonly guard?: AccessGuard;
	/** 注入时钟，限流与缓存 TTL 的单测不必真的等时间流逝。 */
	readonly now?: () => number;
	readonly fetcher?: UpstreamFetcher;
}

interface AppContext {
	readonly cfg: AccelConfig;
	readonly cache: DiskCache;
	readonly guard: AccessGuard;
	readonly now: () => number;
	readonly fetcher: UpstreamFetcher | undefined;
}

function corsHeaders(): Record<string, string> {
	return {
		"access-control-allow-origin": "*",
		"x-content-type-options": "nosniff",
	};
}

function sendJson(res: ServerResponse, status: number, payload: unknown, options: { headers?: ResponseHeaders; head?: boolean } = {}): void {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		...corsHeaders(),
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		...options.headers,
	});
	if (options.head) res.end();
	else res.end(body);
}

function respondError(
	res: ServerResponse,
	status: number,
	code: string,
	message: string,
	options: { retryAfterSeconds?: number; head?: boolean; headers?: ResponseHeaders } = {},
): void {
	// 错误响应一律不许缓存：节点现在常被 CDN 顶在前面，一次 429/401 若被边缘缓存住，
	// 后续正常请求会在一段时间内继续吃错误页。调用方显式给了 cache-control 时以调用方为准。
	const headers: ResponseHeaders = { "cache-control": "no-store", ...options.headers };
	// Retry-After 是 RFC 7231 定义的等待秒数，客户端（含浏览器）会据此退避。
	if (options.retryAfterSeconds !== undefined && options.retryAfterSeconds > 0) {
		headers["retry-after"] = String(options.retryAfterSeconds);
	}
	sendJson(res, status, { error: message, code }, { headers, head: options.head });
}

function allowMethods(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean {
	const method = (req.method ?? "GET").toUpperCase();
	if (allowed.includes(method)) return true;
	res.writeHead(405, {
		...corsHeaders(),
		// 同 respondError：405 也不该被 CDN 记住。
		"cache-control": "no-store",
		allow: allowed.join(", "),
		"content-type": "application/json; charset=utf-8",
	});
	res.end(JSON.stringify({ error: "只支持 " + allowed.join(" / ") + " 方法", code: "METHOD_NOT_ALLOWED" }));
	return false;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	if (value === undefined) return undefined;
	const text = Array.isArray(value) ? value.join(", ") : value;
	return text === "" ? undefined : text;
}

/**
 * 取 X-Forwarded-For 的最后一个地址：nginx 的 $proxy_add_x_forwarded_for 会把真实客户端
 * 追加在末尾，前面几段是客户端自己可以伪造的内容。
 */
function clientIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
	if (raw !== undefined && raw !== "") {
		const parts = raw.split(",");
		const last = parts[parts.length - 1]?.trim();
		if (last) return last;
	}
	return req.socket.remoteAddress ?? "unknown";
}

function decodeSegment(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function stringHeader(value: string | string[] | undefined): string {
	if (value === undefined) return "";
	return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * 下载一律落成附件：GitHub 的 zip 若被浏览器按 HTML/文本渲染，用户拿到的文件就是坏的。
 * filename* 用 RFC 5987 的 UTF-8 编码，保证中文文件名不丢字。
 */
export function contentDisposition(fileName: string): string {
	const fallback = fileName.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "download.bin";
	const encoded = encodeURIComponent(fileName)
		.replace(/['()*]/gu, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
	return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded;
}

/** 记录一次请求的错误日志：不要把 ticket 打在日志里，它等价于短期口令。 */
function logFailure(req: IncomingMessage, status: number, code: string, error: unknown): void {
	if (status < 500) return;
	const detail = error instanceof Error ? error.message : String(error);
	console.error("[github-accel] " + (req.method ?? "GET") + " " + (req.url ?? "/") + " -> " + status + " " + code + "：" + detail);
}

interface Lease {
	readonly ok: boolean;
}

function acquireLease(ctx: AppContext, req: IncomingMessage, res: ServerResponse, head: boolean, tier: TicketTier): Lease {
	// 游客把每 IP 并发收窄到配置值（默认 1）：单连接限速之下再多开连接也刷不回带宽。
	// 登录用户不传，沿用 ACCEL_CONCURRENCY_PER_IP，游客的收窄不会影响他们。
	const lease = tier === "guest"
		? ctx.guard.acquire(clientIp(req), ctx.now(), { concurrencyPerIp: ctx.cfg.guestConcurrencyPerIp })
		: ctx.guard.acquire(clientIp(req), ctx.now());
	if (!lease.ok) {
		const status = lease.reason === "GLOBAL_CONCURRENCY_LIMITED" ? 503 : 429;
		const messages: Record<string, string> = {
			RATE_LIMITED: "请求过于频繁，请稍后再试",
			IP_CONCURRENCY_LIMITED: "同一 IP 的并发下载过多，请等上一个下载结束后再试",
			GLOBAL_CONCURRENCY_LIMITED: "节点并发已满，请稍后再试",
		};
		respondError(res, status, lease.reason, messages[lease.reason] ?? "请求被拒绝", {
			retryAfterSeconds: lease.retryAfterSeconds,
			head,
		});
		return { ok: false };
	}
	// 'close' 覆盖正常结束、客户端中断与连接重置三种情况，额度一定会归还。
	res.on("close", () => lease.release());
	return { ok: true };
}

// ---------------------------------------------------------------------------
// /download
// ---------------------------------------------------------------------------

interface DownloadTarget {
	readonly url: string;
	/** 带 ticket 的下载取 ticket 里的 t；/download?url= 这类公开路径一律游客。 */
	readonly tier: TicketTier;
}

type DownloadTargetResult = { readonly ok: true; readonly target: DownloadTarget } | { readonly ok: false; readonly status: number; readonly code: string; readonly error: string };

function resolveDownloadTarget(cfg: AccelConfig, url: URL): DownloadTargetResult {
	const path = url.pathname;
	if (path === "/download" || path === "/download/") {
		const raw = url.searchParams.get("url");
		if (raw === null || raw.trim() === "") {
			return { ok: false, status: 400, code: "URL_INVALID", error: "缺少 url 参数" };
		}
		if (!cfg.allowPublic) {
			return { ok: false, status: 403, code: "PUBLIC_DISABLED", error: "本节点未开放公开下载，请使用主站签发的下载链接" };
		}
		const check = checkAllowedUrl(raw);
		if (!check.ok) return { ok: false, status: 400, code: check.code, error: check.error };
		return { ok: true, target: { url: check.url, tier: "guest" } };
	}

	const rawTicket = path.slice("/download/".length);
	const ticket = decodeSegment(rawTicket);
	if (ticket === null || ticket === "") {
		return { ok: false, status: 400, code: "TICKET_INVALID", error: "下载链接缺少 ticket" };
	}
	const verification = verifyTicket(ticket, "file", cfg.secret, Math.floor(Date.now() / 1000));
	if (!verification.ok) return { ok: false, status: 401, code: verification.code, error: verification.error };
	// ticket 里的 u 也要过白名单：签名只证明"来自主站"，不证明目标域名安全。
	const check = checkAllowedUrl(verification.payload.u);
	if (!check.ok) return { ok: false, status: 400, code: check.code, error: check.error };
	return { ok: true, target: { url: check.url, tier: verification.payload.t } };
}

async function handleDownload(req: IncomingMessage, res: ServerResponse, url: URL, ctx: AppContext): Promise<void> {
	const method = (req.method ?? "GET").toUpperCase();
	if (!allowMethods(req, res, ["GET", "HEAD"])) return;
	const head = method === "HEAD";

	const resolved = resolveDownloadTarget(ctx.cfg, url);
	if (!resolved.ok) {
		respondError(res, resolved.status, resolved.code, resolved.error, { head });
		return;
	}
	const target = resolved.target.url;
	const rate = resolveTierRate(ctx.cfg, resolved.target.tier);

	const lease = acquireLease(ctx, req, res, head, rate.tier);
	if (!lease.ok) return;

	const entry = await ctx.cache.read(target, ctx.now());
	if (entry !== null) {
		serveFromCache(ctx, req, res, entry, head, rate);
		return;
	}
	await serveFromUpstream(ctx, req, res, target, head, rate);
}

function cacheResponseHeaders(entry: CacheEntry, extra: ResponseHeaders, rate: TierRate): ResponseHeaders {
	const headers: ResponseHeaders = {
		...corsHeaders(),
		...tierHeaders(rate),
		"content-type": entry.meta.contentType || "application/octet-stream",
		"content-disposition": contentDisposition(entry.meta.fileName),
		"accept-ranges": "bytes",
		"x-cache": "HIT",
	};
	if (entry.meta.etag) headers.etag = entry.meta.etag;
	if (entry.meta.lastModified) headers["last-modified"] = entry.meta.lastModified;
	return { ...headers, ...extra };
}

function serveFromCache(ctx: AppContext, req: IncomingMessage, res: ServerResponse, entry: CacheEntry, head: boolean, rate: TierRate): void {
	const meta = entry.meta;
	const ifNoneMatch = headerValue(req, "if-none-match");
	if (ifNoneMatch !== undefined && meta.etag !== "") {
		const candidates = ifNoneMatch.split(",").map((value) => value.trim());
		if (candidates.includes(meta.etag) || candidates.includes("*")) {
			res.writeHead(304, cacheResponseHeaders(entry, {}, rate));
			res.end();
			return;
		}
	}
	const ifModifiedSince = headerValue(req, "if-modified-since");
	if (ifNoneMatch === undefined && ifModifiedSince !== undefined && meta.lastModified !== "") {
		const since = Date.parse(ifModifiedSince);
		const modified = Date.parse(meta.lastModified);
		// If-Modified-Since 的语义是"不比我手里的新就不用回内容"。
		if (Number.isFinite(since) && Number.isFinite(modified) && since >= modified) {
			res.writeHead(304, cacheResponseHeaders(entry, {}, rate));
			res.end();
			return;
		}
	}

	let range = parseRangeHeader(headerValue(req, "range"), meta.size);
	if (range !== null && range !== "unsatisfiable") {
		const ifRange = headerValue(req, "if-range");
		// If-Range 不匹配说明客户端手里是旧版本，只能回完整 200，不能回错位的切片。
		if (ifRange !== undefined && !ifRangeMatches(ifRange, meta)) range = null;
	}
	if (range === "unsatisfiable") {
		res.writeHead(416, cacheResponseHeaders(entry, { "content-range": "bytes */" + meta.size, "x-cache": "HIT" }, rate));
		res.end();
		return;
	}

	if (range !== null) {
		const rangeHeaders = buildRangeHeaders(range, meta.size, meta.contentType);
		res.writeHead(rangeHeaders.status, cacheResponseHeaders(entry, rangeHeaders.headers, rate));
		if (head) {
			res.end();
			return;
		}
		// 命中缓存也要限速：缓存只解决回源，出节点的带宽照样要按档位卡住。
		pipeToClient(ctx.cache.openReadStream(entry, range), res, rate.bytesPerSecond);
		return;
	}

	res.writeHead(200, cacheResponseHeaders(entry, { "content-length": String(meta.size) }, rate));
	if (head) {
		res.end();
		return;
	}
	pipeToClient(ctx.cache.openReadStream(entry), res, rate.bytesPerSecond);
}

async function serveFromUpstream(ctx: AppContext, req: IncomingMessage, res: ServerResponse, target: string, head: boolean, rate: TierRate): Promise<void> {
	const headers = buildDownloadHeaders({
		range: headerValue(req, "range"),
		ifRange: headerValue(req, "if-range"),
		ifModifiedSince: headerValue(req, "if-modified-since"),
		ifNoneMatch: headerValue(req, "if-none-match"),
		accept: headerValue(req, "accept"),
		clientUserAgent: headerValue(req, "user-agent"),
		version: VERSION,
	});

	const result = await openUpstream({
		url: target,
		method: head ? "HEAD" : "GET",
		headers,
		timeoutMs: ctx.cfg.upstreamTimeoutMs,
	}, { fetcher: ctx.fetcher });
	const upstream = result.response;
	const status = upstream.statusCode ?? 502;

	const responseHeaders: ResponseHeaders = { ...corsHeaders() };
	for (const [name, value] of Object.entries(filterHeaders(upstream.headers))) {
		responseHeaders[name] = value;
	}
	if (responseHeaders["content-disposition"] === undefined) {
		responseHeaders["content-disposition"] = contentDisposition(fileNameFromUrl(target));
	}
	if (responseHeaders["accept-ranges"] === undefined) responseHeaders["accept-ranges"] = "bytes";
	responseHeaders["x-cache"] = "MISS";
	for (const [name, value] of Object.entries(tierHeaders(rate))) responseHeaders[name] = value;

	const upstreamLength = upstream.headers["content-length"];
	const contentLength = typeof upstreamLength === "string" ? Number(upstreamLength) : Number.NaN;
	const clientRange = headerValue(req, "range");
	// 只缓存"完整 200 + 长度可知 + 未压缩"的响应：任何一条不满足，落盘都可能变成半截文件。
	const cacheable = ctx.cache.enabled
		&& !head
		&& status === 200
		&& clientRange === undefined
		&& upstream.headers["content-encoding"] === undefined
		&& Number.isSafeInteger(contentLength)
		&& contentLength >= 0;

	if (cacheable) {
		const meta: Omit<CacheMeta, "size" | "storedAt"> = {
			fileName: fileNameFromUrl(target),
			contentType: stringHeader(upstream.headers["content-type"]) || "application/octet-stream",
			etag: stringHeader(upstream.headers.etag),
			lastModified: stringHeader(upstream.headers["last-modified"]),
		};
		const writer = ctx.cache.createWriter(target, meta, ctx.now());
		res.writeHead(status, responseHeaders);
		streamWithCache(ctx, upstream, res, writer, contentLength, rate);
		return;
	}

	res.writeHead(status, responseHeaders);
	if (head) {
		upstream.resume();
		res.end();
		return;
	}
	// 不可缓存的分支（Range / 长度未知 / 压缩响应）同样要限速，否则改一个请求头就绕过了档位。
	pipeToClient(upstream, res, rate.bytesPerSecond);
}

/**
 * 一边把字节写给客户端，一边把同一份字节写进缓存。
 * 用 Transform 而不是手动 pipe：pipeline 会在客户端中断时同时拆掉上游与文件句柄。
 */
function streamWithCache(ctx: AppContext, upstream: IncomingMessage, res: ServerResponse, writer: ReturnType<DiskCache["createWriter"]>, expectedSize: number, rate: TierRate): void {
	const tee = new Transform({
		transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
			writer.write(chunk).then(
				() => callback(null, chunk),
				(error: Error) => callback(error),
			);
		},
	});

	// Node 的 pipeline 成功时回调参数可能是 undefined 而不是 null，两种都要当成功处理。
	const onDone = (error: Error | null | undefined): void => {
		if (error !== null && error !== undefined) {
			res.destroy();
			void writer.abort();
			return;
		}
		// 长度校验在 finish 里做：只有 bytes === Content-Length 才 rename 成正式缓存。
		void writer.finish(expectedSize).then(
			(committed) => {
				if (committed) void ctx.cache.sweep(ctx.now()).catch(() => undefined);
			},
			() => void writer.abort(),
		);
	};

	if (rate.bytesPerSecond > 0) {
		// 节流挂在 tee 之后：缓存文件仍按上游速度落盘，被卡住的只有发往客户端的那一份。
		pipeline(upstream, tee, createThrottleStream({ bytesPerSecond: rate.bytesPerSecond }), res, onDone);
		return;
	}
	pipeline(upstream, tee, res, onDone);
}

// ---------------------------------------------------------------------------
// /git
// ---------------------------------------------------------------------------

function gitUpstreamUrl(owner: string, repo: string, tail: readonly string[]): string | null {
	const base = GITHUB_BASE + "/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + ".git";
	if (tail.length === 2 && tail[0] === "info" && tail[1] === "refs") return base + "/info/refs?service=git-upload-pack";
	if (tail.length === 1 && tail[0] === "git-upload-pack") return base + "/git-upload-pack";
	return null;
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, ctx: AppContext): Promise<void> {
	const method = (req.method ?? "GET").toUpperCase();
	const path = url.pathname;

	// push 会让节点变成公开仓库的写入口，文档第 10 节明确禁用。
	// service 可能写在查询串里（info/refs?service=git-receive-pack），所以要一并检查。
	if (path.includes("git-receive-pack") || url.searchParams.get("service") === "git-receive-pack") {
		respondError(res, 405, "GIT_RECEIVE_PACK_DISABLED", "本节点不支持 git push（git-receive-pack 已禁用）");
		return;
	}

	const rest = path.slice("/git".length).replace(/^\/+|\/+$/gu, "");
	const segments = rest === "" ? [] : rest.split("/");
	if (segments.length < 3) {
		respondError(res, 404, "NOT_FOUND", "git 路径不完整，应形如 /git/<owner>/<repo>.git/info/refs");
		return;
	}

	let index = 0;
	let signedU: string | null = null;
	// 档位默认游客：无 ticket 的公开克隆（allowPublic）只可能是游客。
	let tier: TicketTier = "guest";
	const first = decodeSegment(segments[0] ?? "");
	if (first === null) {
		respondError(res, 400, "PATH_INVALID", "路径含有非法的百分号编码");
		return;
	}
	if (TICKET_SHAPE.test(first)) {
		const verification = verifyTicket(first, "git", ctx.cfg.secret, Math.floor(ctx.now() / 1000));
		if (!verification.ok) {
			respondError(res, 401, verification.code, verification.error);
			return;
		}
		signedU = verification.payload.u;
		tier = verification.payload.t;
		index = 1;
	}

	const owner = decodeSegment(segments[index] ?? "");
	const repoSegment = decodeSegment(segments[index + 1] ?? "");
	if (owner === null || repoSegment === null || owner === "" || repoSegment === "") {
		respondError(res, 400, "PATH_INVALID", "路径里的 owner/repo 不合法");
		return;
	}
	const repo = repoSegment.replace(/\.git$/iu, "");
	const tail = segments.slice(index + 2);
	const upstreamUrl = gitUpstreamUrl(owner, repo, tail);
	if (upstreamUrl === null) {
		respondError(res, 404, "NOT_FOUND", "只支持 /info/refs?service=git-upload-pack 与 /git-upload-pack");
		return;
	}

	if (signedU !== null && signedU !== "/" + owner + "/" + repoSegment) {
		respondError(res, 401, "TICKET_INVALID", "ticket 与请求的仓库不匹配");
		return;
	}
	if (signedU === null && !ctx.cfg.allowPublic) {
		respondError(res, 403, "PUBLIC_DISABLED", "本节点未开放公开克隆，请使用主站签发的克隆地址");
		return;
	}

	const isAdvertisement = tail[0] === "info";
	if (!allowMethods(req, res, [isAdvertisement ? "GET" : "POST"])) return;

	const headers = buildGitHeaders({
		contentType: headerValue(req, "content-type"),
		contentLength: headerValue(req, "content-length"),
		accept: headerValue(req, "accept"),
		gitProtocol: headerValue(req, "git-protocol"),
		clientUserAgent: headerValue(req, "user-agent"),
	});

	const rate = resolveTierRate(ctx.cfg, tier);
	const lease = acquireLease(ctx, req, res, false, rate.tier);
	if (!lease.ok) return;

	const result = await openUpstream({
		url: upstreamUrl,
		method,
		headers,
		// POST 的请求体（pack 协商数据）直接接上游，不做任何缓冲。
		body: isAdvertisement ? undefined : req,
		timeoutMs: ctx.cfg.upstreamTimeoutMs,
	}, { fetcher: ctx.fetcher });
	const upstream = result.response;

	const responseHeaders: ResponseHeaders = { ...corsHeaders() };
	for (const [name, value] of Object.entries(filterHeaders(upstream.headers))) {
		responseHeaders[name] = value;
	}
	for (const [name, value] of Object.entries(tierHeaders(rate))) responseHeaders[name] = value;
	res.writeHead(upstream.statusCode ?? 502, responseHeaders);
	// git clone/fetch 的 pack 流同样按档位卡住，否则换条协议就能跑满带宽。
	pipeToClient(upstream, res, rate.bytesPerSecond);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
	const method = (req.method ?? "GET").toUpperCase();
	const url = new URL(req.url ?? "/", "http://accel.invalid");
	const path = url.pathname;

	if (method === "OPTIONS") {
		res.writeHead(204, {
			...corsHeaders(),
			"access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
			"access-control-allow-headers": "accept, content-type, range, if-range, if-none-match, if-modified-since, git-protocol",
			"access-control-max-age": "86400",
			"content-length": "0",
		});
		res.end();
		return;
	}

	if (path === "/api/health") {
		if (!allowMethods(req, res, ["GET", "HEAD"])) return;
		sendJson(res, 200, {
			ok: true,
			version: VERSION,
			publicAllowed: ctx.cfg.allowPublic,
			// 主站要按节点回报的速率展示档位说明，节点自己报出来比在主站再抄一份默认值可靠。
			guestBytesPerSecond: ctx.cfg.guestBytesPerSecond,
			memberBytesPerSecond: ctx.cfg.memberBytesPerSecond,
		}, { head: method === "HEAD" });
		return;
	}

	if (path.startsWith("/api/releases/")) {
		if (!allowMethods(req, res, ["GET"])) return;
		const segments = path.slice("/api/releases/".length).split("/");
		if (segments.length !== 2) {
			respondError(res, 404, "NOT_FOUND", "接口不存在，应形如 /api/releases/<owner>/<repo>");
			return;
		}
		const owner = decodeSegment(segments[0] ?? "");
		const repo = decodeSegment(segments[1] ?? "");
		if (owner === null || repo === null || owner === "" || repo === "") {
			respondError(res, 400, "INVALID_INPUT", "路径里的 owner/repo 不合法");
			return;
		}
		const payload = await fetchReleases(owner, repo, { token: ctx.cfg.githubToken, timeoutMs: ctx.cfg.upstreamTimeoutMs });
		sendJson(res, 200, payload, { headers: { "cache-control": "public, max-age=60" } });
		return;
	}

	if (path === "/download" || path.startsWith("/download/")) {
		await handleDownload(req, res, url, ctx);
		return;
	}

	if (path === "/git" || path.startsWith("/git/")) {
		await handleGit(req, res, url, ctx);
		return;
	}

	respondError(res, 404, "NOT_FOUND", "接口不存在");
}

/**
 * 创建一个未监听的 http.Server。测试可以直接用 :0 端口起一个实例，
 * 不必依赖真实配置或真实网络。
 */
export function createApp(cfg: AccelConfig = config, deps: AppDependencies = {}): Server {
	const cache = deps.cache ?? new DiskCache({
		dir: cfg.cacheDir,
		maxBytes: cfg.cacheMaxBytes,
		ttlMs: cfg.cacheTtlHours * 3_600_000,
	});
	const guard = deps.guard ?? new AccessGuard({
		perMinute: cfg.ratePerMinute,
		concurrencyPerIp: cfg.concurrencyPerIp,
		maxConcurrency: cfg.maxConcurrency,
	});
	const ctx: AppContext = {
		cfg,
		cache,
		guard,
		now: deps.now ?? Date.now,
		fetcher: deps.fetcher,
	};

	const server = createHttpServer((req, res) => {
		handleRequest(req, res, ctx).catch((error: unknown) => {
			if (error instanceof ProxyError) {
				logFailure(req, error.statusCode, error.code, error);
				if (!res.headersSent) {
					respondError(res, error.statusCode, error.code, error.message, { retryAfterSeconds: error.retryAfterSeconds });
				} else {
					res.destroy();
				}
				return;
			}
			if (error instanceof GithubApiError) {
				logFailure(req, error.statusCode, error.code, error);
				if (!res.headersSent) {
					respondError(res, error.statusCode, error.code, error.message, { retryAfterSeconds: error.retryAfterSeconds });
				} else {
					res.destroy();
				}
				return;
			}
			logFailure(req, 500, "INTERNAL_ERROR", error);
			if (!res.headersSent) {
				respondError(res, 500, "INTERNAL_ERROR", "节点内部错误，请稍后再试");
			} else {
				res.destroy();
			}
		});
	});

	// 大文件下载与 git pack 传输可能几十分钟没有新进度：socket 超时必须交给上游超时控制，
	// 而不是让 Node 的默认空闲超时在传输中间把连接掐掉。
	server.timeout = 0;
	server.requestTimeout = 0;
	server.keepAliveTimeout = 65_000;
	return server;
}

export async function startServer(cfg: AccelConfig = config): Promise<Server> {
	const cache = new DiskCache({
		dir: cfg.cacheDir,
		maxBytes: cfg.cacheMaxBytes,
		ttlMs: cfg.cacheTtlHours * 3_600_000,
	});
	if (cache.enabled) {
		// 缓存目录不会自己出现：systemd 的 StateDirectory 与 Docker 的 volume 都由外部创建，
		// 裸机或自定义 ACCEL_CACHE_DIR 时必须自己 mkdir，否则第一次下载就写不进 .part。
		await cache.ensureDir();
		// 上次进程被杀会留下 .part 残片，启动时清掉，避免占用 ACCEL_CACHE_MAX_BYTES。
		await cache.cleanupPartial();
		await cache.sweep();
	}
	const server = createApp(cfg, { cache });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(cfg.port, cfg.host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	const shown = typeof address === "object" && address !== null ? String(address.address) + ":" + String(address.port) : String(address);
	console.log("[github-accel] 已启动：监听 " + shown + "，公开下载 " + (cfg.allowPublic ? "开启" : "关闭")
		+ "，缓存 " + (cache.enabled ? cfg.cacheDir : "关闭") + "，限流 " + cfg.ratePerMinute + " 次/分钟/IP，并发 "
		+ cfg.concurrencyPerIp + "/IP（全局 " + cfg.maxConcurrency + "）"
		+ "，限速 游客 " + cfg.guestBytesPerSecond + " B/s（并发 " + cfg.guestConcurrencyPerIp + "/IP）/ 登录 "
		+ cfg.memberBytesPerSecond + " B/s");
	return server;
}

function installShutdown(server: Server): void {
	let closing = false;
	const shutdown = (signal: string) => {
		if (closing) return;
		closing = true;
		console.log("[github-accel] 收到 " + signal + "，等待进行中的下载结束…");
		// 给正在传输的下载 10 秒收尾时间，超时就强制退出，避免进程卡在 close 上。
		const force = setTimeout(() => {
			console.error("[github-accel] 10 秒内未关闭，强制退出");
			process.exit(1);
		}, 10_000);
		force.unref();
		server.close(() => {
			clearTimeout(force);
			console.log("[github-accel] 已关闭");
			process.exit(0);
		});
		server.closeIdleConnections();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	startServer()
		.then((server) => installShutdown(server))
		.catch((error: unknown) => {
			console.error("[github-accel] 启动失败：" + (error instanceof Error ? error.message : String(error)));
			process.exit(1);
		});
}
