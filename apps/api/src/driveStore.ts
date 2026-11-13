import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, stat, unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type mysql from "mysql2/promise";
import { ADMIN_DRIVE_MAX_BYTES, normalizeDriveFileName, safeDriveMimeType } from "./adminDrive.js";
import { pool } from "./db.js";
import { getUserSpace, getUserSpaceQuotaLimit, lockedUserUsage } from "./repository.js";
import { deleteUserSpaceFile, getR2ObjectStream, saveUserSpaceFile, userSpaceLocalPath } from "./storage.js";

export type DriveOwnerKind = "admin" | "user";

export type DriveOwner = {
	kind: DriveOwnerKind;
	id: number;
	username: string;
	displayName: string;
	limitBytes: number;
	storageLocation: "server" | "cloudflare";
};

export type DriveNode = {
	id: number;
	ownerType: DriveOwnerKind;
	ownerId: number;
	parentId: number | null;
	path: string;
	name: string;
	type: "file" | "folder";
	storageKey: string;
	mimeType: string;
	byteSize: number;
	etag: string;
	createdAt: string;
	updatedAt: string;
};

export type DriveItem = {
	id: number;
	name: string;
	path: string;
	type: "file" | "folder";
	mimeType: string;
	byteSize: number;
	updatedAt: string;
	etag: string;
};

export type DriveQuota = {
	limitBytes: number;
	usedBytes: number;
	remainingBytes: number;
	fileCount: number;
	folderCount: number;
	driveBytes: number;
};

export type DriveLockInfo = {
	path: string;
	token: string;
	owner: string;
	depth: "0" | "infinity";
	expiresAt: string;
};

export class DriveError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "DriveError";
		this.status = status;
	}
}

const MAX_PATH_CHARS = 700;
const MAX_PATH_SEGMENTS = 32;
const MAX_NAME_CHARS = 240;
const MAX_SUBTREE_NODES = 5000;
const ROOT_ETAG = "00000000000000000000000000000000";

type DbConnection = mysql.PoolConnection;
type Queryable = mysql.Pool | DbConnection;

function mapDriveNode(row: RowDataPacket): DriveNode {
	return {
		id: Number(row.id),
		ownerType: row.owner_type as DriveOwnerKind,
		ownerId: Number(row.owner_id),
		parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
		path: String(row.path),
		name: String(row.name),
		type: row.node_type === "folder" ? "folder" : "file",
		storageKey: String(row.storage_key ?? ""),
		mimeType: String(row.mime_type ?? "application/octet-stream"),
		byteSize: Number(row.byte_size ?? 0),
		etag: String(row.etag ?? ""),
		createdAt: String(row.created_at ?? ""),
		updatedAt: String(row.updated_at ?? ""),
	};
}

export function toDriveItem(node: DriveNode): DriveItem {
	return {
		id: node.id,
		name: node.name,
		path: node.path,
		type: node.type,
		mimeType: node.mimeType,
		byteSize: node.byteSize,
		updatedAt: node.updatedAt,
		etag: node.etag,
	};
}

export function normalizeDriveSegment(raw: unknown): string {
	const name = String(raw ?? "").normalize("NFC").trim();
	if (!name) throw new DriveError(400, "名称不能为空");
	if (name === "." || name === "..") throw new DriveError(400, "名称无效");
	if (/[/\\\u0000-\u001f\u007f]/u.test(name)) throw new DriveError(400, "名称中包含非法字符");
	if (Array.from(name).length > MAX_NAME_CHARS) throw new DriveError(400, "名称过长");
	return name;
}

export function normalizeDrivePath(raw: unknown): string {
	const text = String(raw ?? "").replace(/\\/g, "/");
	const segments = text.split("/").filter((segment) => segment.length > 0);
	if (segments.length > MAX_PATH_SEGMENTS) throw new DriveError(400, "目录层级过深");
	const names = segments.map((segment) => normalizeDriveSegment(segment));
	const result = "/" + names.join("/");
	if (Array.from(result).length > MAX_PATH_CHARS) throw new DriveError(400, "路径过长");
	return result;
}

export function joinDrivePath(parent: string, name: string): string {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function parentDrivePath(path: string): string {
	if (path === "/") return "/";
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

export function drivePathName(path: string): string {
	if (path === "/") return "";
	return path.slice(path.lastIndexOf("/") + 1);
}

export function drivePathDepth(path: string): number {
	return path === "/" ? 0 : path.split("/").length - 1;
}

export function driveBreadcrumbs(path: string) {
	const crumbs = [{ name: "全部文件", path: "/" }];
	if (path === "/") return crumbs;
	let current = "";
	for (const segment of path.split("/").filter(Boolean)) {
		current += `/${segment}`;
		crumbs.push({ name: segment, path: current });
	}
	return crumbs;
}

function isDriveError(error: unknown): error is DriveError {
	return error instanceof DriveError;
}

function isDuplicateError(error: unknown) {
	return (error as { code?: string }).code === "ER_DUP_ENTRY";
}

function quoteDriveEtag(etag: string) {
	return `"${etag.replace(/"/g, "")}"`;
}

export function driveEtagHeader(etag: string) {
	return quoteDriveEtag(etag);
}

export function newDriveEtag() {
	return createHash("md5").update(`${randomUUID()}${Date.now()}${Math.random()}`).digest("hex");
}

const MIME_BY_EXTENSION: Record<string, string> = {
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".gz": "application/gzip",
	".7z": "application/x-7z-compressed",
	".rar": "application/vnd.rar",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".epub": "application/epub+zip",
	".apk": "application/vnd.android.package-archive",
};

export function guessDriveMimeType(name: string, supplied?: string) {
	if (supplied && supplied.trim()) {
		const safe = safeDriveMimeType(supplied);
		if (safe !== "application/octet-stream") return safe;
	}
	return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export async function adminDriveOwner(admin: { id: number | null; username: string; displayName?: string }): Promise<DriveOwner> {
	return {
		kind: "admin",
		id: admin.id ?? 0,
		username: admin.username,
		displayName: admin.displayName || admin.username,
		limitBytes: ADMIN_DRIVE_MAX_BYTES,
		storageLocation: "server",
	};
}

export async function userDriveOwner(user: { id: number; account: string; nickname?: string; storageLocation?: "server" | "cloudflare" | null }): Promise<DriveOwner> {
	const limitBytes = await getUserSpaceQuotaLimit(user.id);
	return {
		kind: "user",
		id: user.id,
		username: user.account,
		displayName: user.nickname || user.account,
		limitBytes,
		storageLocation: user.storageLocation === "cloudflare" ? "cloudflare" : "server",
	};
}

function rootDriveNode(owner: DriveOwner): DriveNode {
	return {
		id: 0,
		ownerType: owner.kind,
		ownerId: owner.id,
		parentId: null,
		path: "/",
		name: "",
		type: "folder",
		storageKey: "",
		mimeType: "httpd/unix-directory",
		byteSize: 0,
		etag: ROOT_ETAG,
		createdAt: "",
		updatedAt: "",
	};
}

async function queryDriveNode(client: Queryable, owner: DriveOwner, path: string): Promise<DriveNode | null> {
	if (path === "/") return rootDriveNode(owner);
	const [[row]] = await client.query<RowDataPacket[]>(
		"SELECT * FROM drive_nodes WHERE owner_type = ? AND owner_id = ? AND path = ? LIMIT 1",
		[owner.kind, owner.id, path]
	);
	return row ? mapDriveNode(row) : null;
}

export async function getDriveNode(owner: DriveOwner, path: string) {
	return queryDriveNode(pool, owner, path);
}

export async function getDriveNodeOrThrow(owner: DriveOwner, path: string) {
	const node = await queryDriveNode(pool, owner, path);
	if (!node) throw new DriveError(404, "文件或目录不存在");
	return node;
}

export async function listDriveChildren(owner: DriveOwner, path: string): Promise<DriveNode[]> {
	const parent = await getDriveNodeOrThrow(owner, path);
	if (parent.type !== "folder") throw new DriveError(400, "该路径不是目录");
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT * FROM drive_nodes
		 WHERE owner_type = ? AND owner_id = ?
		   AND parent_id ${parent.id === 0 ? "IS NULL" : "= ?"}
		 ORDER BY node_type = 'folder' DESC, name ASC`,
		parent.id === 0 ? [owner.kind, owner.id] : [owner.kind, owner.id, parent.id]
	);
	return rows.map(mapDriveNode);
}

export async function listDriveSubtree(owner: DriveOwner, path: string, limit = MAX_SUBTREE_NODES): Promise<DriveNode[]> {
	if (path === "/") {
		const [rows] = await pool.query<RowDataPacket[]>(
			"SELECT * FROM drive_nodes WHERE owner_type = ? AND owner_id = ? ORDER BY path ASC LIMIT ?",
			[owner.kind, owner.id, limit]
		);
		return rows.map(mapDriveNode);
	}
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT * FROM drive_nodes
		 WHERE owner_type = ? AND owner_id = ?
		   AND (path = ? OR LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/'))
		 ORDER BY path ASC LIMIT ?`,
		[owner.kind, owner.id, path, path, path, limit]
	);
	return rows.map(mapDriveNode);
}

export async function getDriveQuota(owner: DriveOwner): Promise<DriveQuota> {
	const [[row]] = await pool.query<RowDataPacket[]>(
		`SELECT
		   COALESCE(SUM(CASE WHEN node_type = 'file' THEN byte_size ELSE 0 END), 0) AS bytes,
		   COALESCE(SUM(node_type = 'file'), 0) AS files,
		   COALESCE(SUM(node_type = 'folder'), 0) AS folders
		 FROM drive_nodes WHERE owner_type = ? AND owner_id = ?`,
		[owner.kind, owner.id]
	);
	const driveBytes = Number(row?.bytes ?? 0);
	const fileCount = Number(row?.files ?? 0);
	const folderCount = Number(row?.folders ?? 0);
	if (owner.kind === "user") {
		const space = await getUserSpace(owner.id);
		return {
			limitBytes: space.limitBytes,
			usedBytes: space.usedBytes,
			remainingBytes: Math.max(0, space.limitBytes - space.usedBytes),
			fileCount,
			folderCount,
			driveBytes,
		};
	}
	const usedBytes = driveBytes;
	return {
		limitBytes: ADMIN_DRIVE_MAX_BYTES,
		usedBytes,
		remainingBytes: Math.max(0, ADMIN_DRIVE_MAX_BYTES - usedBytes),
		fileCount,
		folderCount,
		driveBytes,
	};
}

async function lockOwnerRow(connection: DbConnection, owner: DriveOwner) {
	if (owner.kind === "user") {
		await connection.query<RowDataPacket[]>("SELECT id FROM comment_users WHERE id = ? FOR UPDATE", [owner.id]);
		return;
	}
	if (owner.id > 0) {
		await connection.query<RowDataPacket[]>("SELECT id FROM admin_users WHERE id = ? FOR UPDATE", [owner.id]);
	}
}

async function sumDriveBytes(connection: DbConnection, owner: DriveOwner) {
	const [[row]] = await connection.query<RowDataPacket[]>(
		"SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM drive_nodes WHERE owner_type = ? AND owner_id = ?",
		[owner.kind, owner.id]
	);
	return Number(row?.bytes ?? 0);
}

/**
 * Check the write against the owner's quota. For users the existing comment-user
 * usage (images, clipboards, stickers, drive) is reused, so WebDAV files share
 * exactly the same 30MB/50MB bucket as every other user-space feature.
 */
async function assertQuota(connection: DbConnection, owner: DriveOwner, incomingBytes: number, replacedBytes: number) {
	await lockOwnerRow(connection, owner);
	if (owner.kind === "user") {
		const usage = await lockedUserUsage(connection, owner.id);
		const nextTotal = usage.total - Math.max(0, replacedBytes) + Math.max(0, incomingBytes);
		if (nextTotal > owner.limitBytes) {
			throw new DriveError(507, `存储空间不足：上限 ${(owner.limitBytes / 1024 / 1024).toFixed(0)}MB，已用 ${(usage.total / 1024 / 1024).toFixed(1)}MB`);
		}
		return;
	}
	const current = await sumDriveBytes(connection, owner);
	if (current - Math.max(0, replacedBytes) + Math.max(0, incomingBytes) > ADMIN_DRIVE_MAX_BYTES) {
		throw new DriveError(507, "管理员网盘空间不足（上限 2GB）");
	}
}

async function withTransaction<T>(work: (connection: DbConnection) => Promise<T>): Promise<T> {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const result = await work(connection);
		await connection.commit();
		return result;
	} catch (error) {
		await connection.rollback().catch(() => undefined);
		throw error;
	} finally {
		connection.release();
	}
}

async function touchDriveParent(connection: DbConnection, owner: DriveOwner, parentId: number | null) {
	if (parentId === null) return;
	await connection.execute("UPDATE drive_nodes SET etag = ?, updated_at = NOW() WHERE owner_type = ? AND owner_id = ? AND id = ?", [
		newDriveEtag(), owner.kind, owner.id, parentId,
	]);
}

async function getParentFolder(client: Queryable, owner: DriveOwner, path: string) {
	if (path === "/") throw new DriveError(409, "不能在根目录上执行该操作");
	const parent = await queryDriveNode(client, owner, parentDrivePath(path));
	if (!parent) throw new DriveError(409, "父目录不存在");
	if (parent.type !== "folder") throw new DriveError(409, "父路径不是目录");
	return parent;
}

function makeStorageKey(owner: DriveOwner, name: string) {
	const extension = extname(name).toLowerCase().replace(/[^.a-z0-9]/gu, "").slice(0, 20);
	const safeExtension = extension && extension !== "." ? extension : "";
	return `dav-${owner.kind}-${owner.id}-${randomUUID()}${safeExtension}`;
}

async function localFileExists(storageKey: string) {
	const path = userSpaceLocalPath(storageKey);
	if (!path) return false;
	return stat(path).then((value) => value.isFile()).catch(() => false);
}

async function removeStoredDriveFile(storageKey: string) {
	if (!storageKey) return;
	await deleteUserSpaceFile(storageKey).catch((error) => {
		console.warn("[drive] failed to delete stored file:", error instanceof Error ? error.message : error);
	});
}

async function streamToDriveFile(source: Readable, targetPath: string, maxBytes: number) {
	let size = 0;
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			size += chunk.length;
			if (size > maxBytes) {
				callback(new DriveError(507, "存储空间不足"));
				return;
			}
			callback(null, chunk);
		},
	});
	try {
		await pipeline(source, limiter, createWriteStream(targetPath, { flags: "wx" }));
		return size;
	} catch (error) {
		await unlink(targetPath).catch(() => undefined);
		throw error;
	}
}

export type DriveWriteOptions = {
	mimeType?: string;
	contentLength?: number;
	ifNoneMatchStar?: boolean;
	ifMatch?: string;
};

/**
 * Save a request body stream as the file at `path`, creating or replacing it.
 * The bytes are written to a unique user-space object first; the database row is
 * only updated after the stream completed and the quota transaction committed.
 */
export async function saveDriveStream(owner: DriveOwner, path: string, source: Readable, options: DriveWriteOptions = {}): Promise<{ node: DriveNode; created: boolean }> {
	const normalized = normalizeDrivePath(path);
	if (normalized === "/") throw new DriveError(405, "不能把文件写入根路径");
	const name = normalizeDriveSegment(drivePathName(normalized));
	const existing = await getDriveNode(owner, normalized);
	if (existing?.type === "folder") throw new DriveError(405, "同名目录已存在");
	if (options.ifNoneMatchStar && existing) throw new DriveError(412, "文件已存在");
	if (options.ifMatch && existing && quoteDriveEtag(existing.etag) !== options.ifMatch.trim()) throw new DriveError(412, "ETag 不匹配");

	const parent = await getParentFolder(pool, owner, normalized);
	const quota = await getDriveQuota(owner);
	const replacedBytes = existing?.byteSize ?? 0;
	const available = Math.max(0, quota.limitBytes - quota.usedBytes + replacedBytes);
	if (options.contentLength !== undefined && Number.isFinite(options.contentLength) && options.contentLength > available) {
		throw new DriveError(507, `存储空间不足：还可写入 ${(available / 1024 / 1024).toFixed(1)}MB`);
	}

	const storageKey = makeStorageKey(owner, name);
	const localPath = userSpaceLocalPath(storageKey);
	if (!localPath) throw new DriveError(500, "无法分配存储位置");
	const mimeType = guessDriveMimeType(name, options.mimeType);
	let byteSize = 0;
	try {
		byteSize = await streamToDriveFile(source, localPath, available);
		if (owner.storageLocation === "cloudflare") {
			const saved = await saveUserSpaceFile({ filename: storageKey, localPath, mimeType, targetStorage: "cloudflare" });
			byteSize = saved.size || byteSize;
		}
	} catch (error) {
		await removeStoredDriveFile(storageKey);
		throw isDriveError(error) ? error : new DriveError(500, error instanceof Error ? error.message : "文件写入失败");
	}

	try {
		const result = await withTransaction(async (connection) => {
			await assertQuota(connection, owner, byteSize, replacedBytes);
			const parentFolder = await getParentFolder(connection, owner, normalized);
			if (existing) {
				await connection.execute(
					"UPDATE drive_nodes SET storage_key = ?, mime_type = ?, byte_size = ?, etag = ?, updated_at = NOW() WHERE owner_type = ? AND owner_id = ? AND path = ?",
					[storageKey, mimeType, byteSize, newDriveEtag(), owner.kind, owner.id, normalized]
				);
			} else {
				await connection.execute(
					"INSERT INTO drive_nodes (owner_type, owner_id, parent_id, path, name, node_type, storage_key, mime_type, byte_size, etag) VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?)",
					[owner.kind, owner.id, parentFolder.id, normalized, name, storageKey, mimeType, byteSize, newDriveEtag()]
				);
			}
			await touchDriveParent(connection, owner, parentFolder.id);
			const saved = await queryDriveNode(connection, owner, normalized);
			if (!saved) throw new DriveError(500, "文件记录保存失败");
			return saved;
		});
		if (existing?.storageKey && existing.storageKey !== storageKey) await removeStoredDriveFile(existing.storageKey);
		return { node: result, created: !existing };
	} catch (error) {
		await removeStoredDriveFile(storageKey);
		throw isDriveError(error) ? error : new DriveError(500, "文件记录保存失败");
	}
}

export async function createDriveFolder(owner: DriveOwner, path: string): Promise<DriveNode> {
	const normalized = normalizeDrivePath(path);
	if (normalized === "/") throw new DriveError(405, "根目录已存在");
	const existing = await getDriveNode(owner, normalized);
	if (existing) throw new DriveError(405, "同名文件或目录已存在");
	return withTransaction(async (connection) => {
		const parent = await getParentFolder(connection, owner, normalized);
		const name = normalizeDriveSegment(drivePathName(normalized));
		try {
			const [result] = await connection.execute<ResultSetHeader>(
				"INSERT INTO drive_nodes (owner_type, owner_id, parent_id, path, name, node_type, storage_key, mime_type, byte_size, etag) VALUES (?, ?, ?, ?, ?, 'folder', '', 'httpd/unix-directory', 0, ?)",
				[owner.kind, owner.id, parent.id, normalized, name, newDriveEtag()]
			);
			await touchDriveParent(connection, owner, parent.id);
			const row = await queryDriveNode(connection, owner, normalized);
			if (!row) throw new DriveError(500, "目录创建失败");
			return { ...row, id: Number(result.insertId) };
		} catch (error) {
			if (isDuplicateError(error)) throw new DriveError(405, "同名文件或目录已存在");
			throw error;
		}
	});
}

async function renameSubtree(connection: DbConnection, owner: DriveOwner, oldPath: string, newPath: string, newNodeName: string) {
	const oldLength = Array.from(oldPath).length;
	const [[root]] = await connection.query<RowDataPacket[]>(
		"SELECT id FROM drive_nodes WHERE owner_type = ? AND owner_id = ? AND path = ?",
		[owner.kind, owner.id, oldPath]
	);
	if (!root) throw new DriveError(404, "文件或目录不存在");
	await connection.execute(
		"UPDATE drive_nodes SET name = ?, path = ?, etag = ?, updated_at = NOW() WHERE owner_type = ? AND owner_id = ? AND path = ?",
		[newNodeName, newPath, newDriveEtag(), owner.kind, owner.id, oldPath]
	);
	// `path` starts with oldPath + "/"; replace that prefix, keeping each
	// descendant's own name (and giving it a fresh ETag).
	await connection.execute(
		`UPDATE drive_nodes
		 SET etag = MD5(CONCAT(?, path)), path = CONCAT(?, SUBSTRING(path, ?)), updated_at = NOW()
		 WHERE owner_type = ? AND owner_id = ?
		   AND LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/')`,
		[randomUUID(), newPath, oldLength + 1, owner.kind, owner.id, oldPath, oldPath]
	);
}

export async function renameDriveNode(owner: DriveOwner, path: string, newNameRaw: string): Promise<DriveNode> {
	const normalized = normalizeDrivePath(path);
	if (normalized === "/") throw new DriveError(405, "不能重命名根目录");
	const node = await getDriveNodeOrThrow(owner, normalized);
	const newName = normalizeDriveSegment(newNameRaw);
	if (newName === node.name) return node;
	const newPath = joinDrivePath(parentDrivePath(normalized), newName);
	if (await getDriveNode(owner, newPath)) throw new DriveError(409, "同名文件或目录已存在");
	const oldParent = parentDrivePath(normalized);
	const newParent = parentDrivePath(newPath);
	return withTransaction(async (connection) => {
		await renameSubtree(connection, owner, normalized, newPath, newName);
		await touchDriveParent(connection, owner, (await queryDriveNode(connection, owner, oldParent))?.id ?? null);
		if (newParent !== oldParent) await touchDriveParent(connection, owner, (await queryDriveNode(connection, owner, newParent))?.id ?? null);
		const row = await queryDriveNode(connection, owner, newPath);
		if (!row) throw new DriveError(500, "重命名失败");
		return row;
	});
}

export async function deleteDriveNode(owner: DriveOwner, path: string, ifHeader?: string): Promise<{ files: number; folders: number }> {
	const normalized = normalizeDrivePath(path);
	if (normalized === "/") throw new DriveError(405, "不能删除根目录");
	const node = await getDriveNodeOrThrow(owner, normalized);
	await assertDriveUnlocked(owner, normalized, ifHeader);
	const subtree = await listDriveSubtree(owner, normalized);
	const storageKeys = subtree.filter((item) => item.type === "file" && item.storageKey).map((item) => item.storageKey);
	const result = await withTransaction(async (connection) => {
		const parentId = node.parentId;
		const subtreeClause = `path = ? OR LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/')`;
		const [deleted] = await connection.execute<ResultSetHeader>(
			`DELETE FROM drive_nodes WHERE owner_type = ? AND owner_id = ? AND (${subtreeClause})`,
			[owner.kind, owner.id, normalized, normalized, normalized]
		);
		await connection.execute(
			`DELETE FROM drive_locks WHERE owner_type = ? AND owner_id = ? AND (path = ? OR LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/'))`,
			[owner.kind, owner.id, normalized, normalized, normalized]
		);
		await touchDriveParent(connection, owner, parentId);
		return deleted;
	});
	for (const storageKey of storageKeys) await removeStoredDriveFile(storageKey);
	const files = subtree.filter((item) => item.type === "file").length;
	const folders = subtree.filter((item) => item.type === "folder").length;
	return { files, folders: Math.max(0, folders) };
}

async function deleteNodeRows(connection: DbConnection, owner: DriveOwner, path: string) {
	const [rows] = await connection.query<RowDataPacket[]>(
		"SELECT storage_key, node_type FROM drive_nodes WHERE owner_type = ? AND owner_id = ? AND (path = ? OR LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/'))",
		[owner.kind, owner.id, path, path, path]
	);
	await connection.execute(
		"DELETE FROM drive_nodes WHERE owner_type = ? AND owner_id = ? AND (path = ? OR LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/'))",
		[owner.kind, owner.id, path, path, path]
	);
	await connection.execute(
		"DELETE FROM drive_locks WHERE owner_type = ? AND owner_id = ? AND (path = ? OR LEFT(path, CHAR_LENGTH(?) + 1) = CONCAT(?, '/'))",
		[owner.kind, owner.id, path, path, path]
	);
	return rows.filter((row) => row.node_type === "file").map((row) => String(row.storage_key)).filter(Boolean);
}

export async function moveDriveNode(owner: DriveOwner, sourcePath: string, destinationPath: string, overwrite: boolean): Promise<DriveNode> {
	const source = normalizeDrivePath(sourcePath);
	const destination = normalizeDrivePath(destinationPath);
	if (source === "/") throw new DriveError(405, "不能移动根目录");
	if (destination === "/") throw new DriveError(409, "目标路径无效");
	if (source === destination) return getDriveNodeOrThrow(owner, source);
	if (destination.startsWith(`${source}/`)) throw new DriveError(409, "不能把目录移动到自身内部");
	const node = await getDriveNodeOrThrow(owner, source);
	const destinationExisting = await getDriveNode(owner, destination);
	if (destinationExisting && !overwrite) throw new DriveError(412, "目标已存在");
	const replacedStorageKeys = await withTransaction(async (connection) => {
		const destParent = await getParentFolder(connection, owner, destination);
		const removed = destinationExisting ? await deleteNodeRows(connection, owner, destination) : [];
		const newName = normalizeDriveSegment(drivePathName(destination));
		await renameSubtree(connection, owner, source, destination, newName);
		await touchDriveParent(connection, owner, node.parentId);
		await touchDriveParent(connection, owner, destParent.id);
		return removed;
	});
	for (const storageKey of replacedStorageKeys) await removeStoredDriveFile(storageKey);
	return getDriveNodeOrThrow(owner, destination);
}

async function duplicateFileContent(owner: DriveOwner, source: DriveNode, newKey: string, mimeType: string): Promise<number> {
	const targetPath = userSpaceLocalPath(newKey);
	if (!targetPath) throw new DriveError(500, "无法分配存储位置");
	const sourcePath = source.storageKey ? userSpaceLocalPath(source.storageKey) : null;
	const sourceExists = sourcePath ? await stat(sourcePath).then((value) => value.isFile()).catch(() => false) : false;
	if (sourcePath && sourceExists) {
		await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
	} else {
		const stream = source.storageKey ? await getR2ObjectStream(`user-space/${basename(source.storageKey)}`) : null;
		if (!stream) throw new DriveError(500, "源文件内容不可读");
		await pipeline(stream, createWriteStream(targetPath, { flags: "wx" }));
	}
	if (owner.storageLocation === "cloudflare") {
		await saveUserSpaceFile({ filename: newKey, localPath: targetPath, mimeType, targetStorage: "cloudflare" });
	}
	const fileStat = await stat(targetPath).catch(() => null);
	return fileStat?.size ?? source.byteSize;
}

export async function copyDriveNode(owner: DriveOwner, sourcePath: string, destinationPath: string, overwrite: boolean): Promise<DriveNode> {
	const source = normalizeDrivePath(sourcePath);
	const destination = normalizeDrivePath(destinationPath);
	if (source === "/") throw new DriveError(405, "不能复制根目录");
	if (destination === "/") throw new DriveError(409, "目标路径无效");
	if (source === destination) throw new DriveError(409, "源和目标相同");
	if (destination.startsWith(`${source}/`)) throw new DriveError(409, "不能把目录复制到自身内部");
	const sourceNode = await getDriveNodeOrThrow(owner, source);
	const subtree = await listDriveSubtree(owner, source);
	if (!subtree.length) throw new DriveError(404, "源文件不存在");
	const destinationExisting = await getDriveNode(owner, destination);
	if (destinationExisting && !overwrite) throw new DriveError(412, "目标已存在");
	await getParentFolder(pool, owner, destination);

	const totalBytes = subtree.filter((node) => node.type === "file").reduce((total, node) => total + node.byteSize, 0);
	const replacedNodes = destinationExisting ? await listDriveSubtree(owner, destination) : [];
	const replacedBytes = replacedNodes.filter((node) => node.type === "file").reduce((total, node) => total + node.byteSize, 0);
	const quota = await getDriveQuota(owner);
	if (quota.usedBytes - replacedBytes + totalBytes > quota.limitBytes) throw new DriveError(507, "存储空间不足，无法复制");
	const replacedStorageKeys = replacedNodes.filter((node) => node.type === "file").map((node) => node.storageKey).filter(Boolean);

	const createdKeys: string[] = [];
	try {
		const copied = await withTransaction(async (connection) => {
			const destParent = await getParentFolder(connection, owner, destination);
			if (destinationExisting) await deleteNodeRows(connection, owner, destination);
			await assertQuota(connection, owner, totalBytes, 0);
			const idByPath = new Map<string, number>();
			const newRootName = normalizeDriveSegment(drivePathName(destination));
			for (const node of subtree) {
				const relative = node.path === source ? "" : node.path.slice(source.length);
				const newPath = destination + relative;
				const newName = relative ? node.name : newRootName;
				const parentPath = parentDrivePath(newPath);
				const parentId = parentPath === "/" ? null : idByPath.get(parentPath) ?? null;
				if (node.type === "folder") {
					const [result] = await connection.execute<ResultSetHeader>(
						"INSERT INTO drive_nodes (owner_type, owner_id, parent_id, path, name, node_type, storage_key, mime_type, byte_size, etag) VALUES (?, ?, ?, ?, ?, 'folder', '', 'httpd/unix-directory', 0, ?)",
						[owner.kind, owner.id, parentId, newPath, newName, newDriveEtag()]
					);
					idByPath.set(newPath, Number(result.insertId));
					continue;
				}
				const newKey = makeStorageKey(owner, newName);
				createdKeys.push(newKey);
				const size = await duplicateFileContent(owner, node, newKey, node.mimeType);
				const [result] = await connection.execute<ResultSetHeader>(
					"INSERT INTO drive_nodes (owner_type, owner_id, parent_id, path, name, node_type, storage_key, mime_type, byte_size, etag) VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, ?)",
					[owner.kind, owner.id, parentId, newPath, newName, newKey, node.mimeType, size, newDriveEtag()]
				);
				idByPath.set(newPath, Number(result.insertId));
			}
			await touchDriveParent(connection, owner, destParent.id);
			const rootCopy = await queryDriveNode(connection, owner, destination);
			if (!rootCopy) throw new DriveError(500, "复制失败");
			return rootCopy;
		});
		for (const storageKey of replacedStorageKeys) await removeStoredDriveFile(storageKey);
		return copied;
	} catch (error) {
		for (const storageKey of createdKeys) await removeStoredDriveFile(storageKey);
		throw isDriveError(error) ? error : new DriveError(500, error instanceof Error ? error.message : "复制失败");
	}
}

export type DriveFileHandle = {
	node: DriveNode;
	localPath: string | null;
	stream: Readable | null;
	size: number;
};

export async function openDriveFile(owner: DriveOwner, path: string): Promise<DriveFileHandle> {
	const node = await getDriveNodeOrThrow(owner, path);
	if (node.type !== "file") throw new DriveError(405, "该路径不是文件");
	const localPath = node.storageKey ? userSpaceLocalPath(node.storageKey) : null;
	if (localPath && await localFileExists(node.storageKey)) {
		const fileStat = await stat(localPath);
		return { node, localPath, stream: null, size: Number(fileStat.size) };
	}
	if (!node.storageKey) throw new DriveError(404, "文件内容不存在");
	const stream = await getR2ObjectStream(`user-space/${basename(node.storageKey)}`);
	if (!stream) throw new DriveError(404, "文件内容不存在");
	return { node, localPath: null, stream, size: node.byteSize };
}

export function driveLockTokenFromHeader(value: string | undefined) {
	if (!value) return null;
	const match = /opaquelocktoken:[0-9a-f-]{36}/iu.exec(value);
	return match ? match[0].toLowerCase() : null;
}

export function driveIfHeaderTokens(value: string | undefined) {
	if (!value) return [];
	return Array.from(new Set((value.match(/opaquelocktoken:[0-9a-f-]{36}/giu) ?? []).map((token) => token.toLowerCase())));
}

function mapDriveLock(row: RowDataPacket): DriveLockInfo {
	return {
		path: String(row.path),
		token: String(row.lock_token),
		owner: String(row.lock_owner ?? ""),
		depth: row.depth === "0" ? "0" : "infinity",
		expiresAt: String(row.expires_at),
	};
}

export async function cleanupExpiredDriveLocks() {
	await pool.execute("DELETE FROM drive_locks WHERE expires_at <= NOW()").catch(() => undefined);
}

export async function getDriveLockAtPath(owner: DriveOwner, path: string): Promise<DriveLockInfo | null> {
	const [[row]] = await pool.query<RowDataPacket[]>(
		"SELECT * FROM drive_locks WHERE owner_type = ? AND owner_id = ? AND path = ? AND expires_at > NOW() LIMIT 1",
		[owner.kind, owner.id, path]
	);
	return row ? mapDriveLock(row) : null;
}

/**
 * Locks that apply to `path`: its own lock plus depth-infinity locks on any
 * ancestor directory. Directory boundaries are checked with a "/" suffix so
 * `/a` never covers `/ab`.
 */
export async function listDriveLocks(owner: DriveOwner, path: string): Promise<DriveLockInfo[]> {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT * FROM drive_locks
		 WHERE owner_type = ? AND owner_id = ? AND expires_at > NOW()
		   AND (path = ? OR (depth = 'infinity' AND LEFT(?, CHAR_LENGTH(path) + 1) = CONCAT(path, '/')))`,
		[owner.kind, owner.id, path, path]
	);
	return rows.map(mapDriveLock);
}

export async function assertDriveUnlocked(owner: DriveOwner, path: string, ifHeader?: string) {
	const submitted = new Set(driveIfHeaderTokens(ifHeader));
	const locks = await listDriveLocks(owner, path);
	if (!locks.length) return;
	if (locks.every((lock) => submitted.has(lock.token))) return;
	throw new DriveError(423, "资源已被锁定");
}

export async function lockDriveNode(owner: DriveOwner, path: string, options: {
	depth: "0" | "infinity";
	timeoutSeconds: number;
	lockOwner: string;
	ifHeader?: string;
}): Promise<{ lock: DriveLockInfo; created: boolean }> {
	await cleanupExpiredDriveLocks();
	const normalized = normalizeDrivePath(path);
	if (normalized === "/") throw new DriveError(403, "不能锁定根目录");
	const submitted = new Set(driveIfHeaderTokens(options.ifHeader));
	const applicable = await listDriveLocks(owner, normalized);
	const conflicting = applicable.filter((lock) => !submitted.has(lock.token));
	if (conflicting.length) throw new DriveError(423, "资源已被其他客户端锁定");
	const existingExact = applicable.find((lock) => lock.path === normalized);
	if (existingExact && submitted.has(existingExact.token)) {
		const expiresAt = new Date(Date.now() + options.timeoutSeconds * 1000);
		await pool.execute(
			"UPDATE drive_locks SET expires_at = ?, lock_owner = ? WHERE owner_type = ? AND owner_id = ? AND path = ?",
			[expiresAt, options.lockOwner.slice(0, 255), owner.kind, owner.id, normalized]
		);
		return { lock: { ...existingExact, owner: options.lockOwner.slice(0, 255), expiresAt: expiresAt.toISOString() }, created: false };
	}

	const node = await getDriveNode(owner, normalized);
	if (!node) {
		// Lock-null: WebDAV clients may LOCK a path before uploading the file.
		await withTransaction(async (connection) => {
			const parent = await getParentFolder(connection, owner, normalized);
			await connection.execute(
				"INSERT INTO drive_nodes (owner_type, owner_id, parent_id, path, name, node_type, storage_key, mime_type, byte_size, etag) VALUES (?, ?, ?, ?, ?, 'file', '', 'application/octet-stream', 0, ?)",
				[owner.kind, owner.id, parent.id, normalized, normalizeDriveSegment(drivePathName(normalized)), newDriveEtag()]
			);
			await touchDriveParent(connection, owner, parent.id);
		}).catch((error) => {
			if (isDuplicateError(error)) throw new DriveError(423, "资源已被其他客户端锁定");
			throw error;
		});
	} else {
		await assertDriveUnlocked(owner, normalized, options.ifHeader);
	}

	const token = `opaquelocktoken:${randomUUID()}`;
	const expiresAt = new Date(Date.now() + options.timeoutSeconds * 1000);
	try {
		await pool.execute(
			"INSERT INTO drive_locks (owner_type, owner_id, path, lock_token, lock_owner, depth, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[owner.kind, owner.id, normalized, token, options.lockOwner.slice(0, 255), options.depth, expiresAt]
		);
	} catch (error) {
		if (isDuplicateError(error)) throw new DriveError(423, "资源已被其他客户端锁定");
		throw error;
	}
	return { lock: { path: normalized, token, owner: options.lockOwner.slice(0, 255), depth: options.depth, expiresAt: expiresAt.toISOString() }, created: true };
}

export async function unlockDriveNode(owner: DriveOwner, path: string, token: string): Promise<boolean> {
	const normalized = normalizeDrivePath(path);
	const [[row]] = await pool.query<RowDataPacket[]>(
		"SELECT * FROM drive_locks WHERE owner_type = ? AND owner_id = ? AND path = ? AND expires_at > NOW() LIMIT 1",
		[owner.kind, owner.id, normalized]
	);
	if (!row) return false;
	if (String(row.lock_token).toLowerCase() !== token.toLowerCase()) return false;
	await pool.execute("DELETE FROM drive_locks WHERE id = ?", [row.id]);
	return true;
}

export function normalizeLockTimeout(value: string | undefined) {
	const text = String(value ?? "").trim();
	if (!text || /infinite/iu.test(text)) return 3600;
	const match = /Second-(\d+)/iu.exec(text);
	const seconds = match ? Number(match[1]) : 3600;
	if (!Number.isFinite(seconds) || seconds <= 0) return 3600;
	return Math.min(Math.max(Math.trunc(seconds), 60), 7 * 24 * 3600);
}

export function normalizeLockDepth(value: unknown): "0" | "infinity" {
	return String(value ?? "").trim() === "0" ? "0" : "infinity";
}
