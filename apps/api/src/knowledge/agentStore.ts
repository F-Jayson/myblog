import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./repository.js";
import { config } from "../config.js";
import type { KbScope } from "./types.js";

export const ALL_KB_SCOPES = [
	"kb:read",
	"kb:write",
	"kb:comment",
	"kb:attachments",
	"kb:export",
	"kb:publish",
	"kb:share",
	"kb:delete",
] as const;

export const DEFAULT_KB_SCOPES: KbScope[] = ["kb:read"];
export const SENSITIVE_KB_SCOPES: KbScope[] = ["kb:publish", "kb:share", "kb:delete", "kb:export"];

export class KbAgentError extends Error {
	readonly code: string;
	readonly status: number;
	readonly interval?: number;
	constructor(code: string, message: string, status = 400, interval?: number) {
		super(message);
		this.name = "KbAgentError";
		this.code = code;
		this.status = status;
		this.interval = interval;
	}
}

export interface KbAgentGrant {
	id: number;
	userId: number;
	tokenHash: string;
	clientName: string;
	scopes: string[];
	allowedLibraryIds: number[];
	expiresAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
	user?: {
		id: number;
		username: string;
		nickname: string;
		avatar: string;
		email: string;
	};
}

export interface KbDeviceRequestInfo {
	id: number;
	userCode: string;
	clientName: string;
	requestedScopes: string[];
	status: "pending" | "approved" | "denied" | "expired";
	userId: number | null;
	grantId: number | null;
	expiresAt: string;
	approvedAt: string | null;
	createdAt: string;
}

// 轮询速率限制映射：deviceCodeHash -> lastPollTimestamp
const pollLimiter = new Map<string, number>();
const POLL_MIN_INTERVAL_MS = 4500; // 留 500ms 宽限，标称 5 秒

export function resetPollLimiterForTest(): void {
	pollLimiter.clear();
}


function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function getEncryptionKey(): Buffer {
	// 交付令牌是数据库里唯一可逆的敏感字段：密钥缺失时必须失败，不能退回公开的内置常量
	const secret = config.kbAgentTokenSecret || config.adminToken;
	if (!secret) {
		throw new KbAgentError("agent_secret_missing", "缺少 KB_AGENT_TOKEN_SECRET 或 ADMIN_API_TOKEN，无法加解密设备交付令牌", 500);
	}
	return createHash("sha256").update(secret).digest();
}

/**
 * 加密一次性交付 Token
 */
function encryptDeliveryToken(plainToken: string): string {
	const key = getEncryptionKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const encrypted = Buffer.concat([cipher.update(plainToken, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * 解密一次性交付 Token
 */
function decryptDeliveryToken(ciphertext: string): string {
	const [ivHex, tagHex, encryptedHex] = ciphertext.split(":");
	if (!ivHex || !tagHex || !encryptedHex) throw new Error("Invalid delivery token format");
	const key = getEncryptionKey();
	const iv = Buffer.from(ivHex, "hex");
	const tag = Buffer.from(tagHex, "hex");
	const encrypted = Buffer.from(encryptedHex, "hex");
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	// update 可能分块返回，必须用 Buffer.concat 拼接后再统一转 utf8，
	// 直接字符串相加会在多字节字符跨块时产生乱码
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/**
 * 生成 8 位字符的用户配对码（避开易混淆字符 0, O, 1, I, L）
 */
function generateUserCode(): string {
	const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
	let code = "";
	const bytes = randomBytes(8);
	for (let i = 0; i < 8; i++) {
		code += chars[bytes[i] % chars.length];
	}
	return code;
}

/**
 * 解析库里可能以 JSON 数组字符串、逗号分隔字符串或数组三种形态存储的列表字段。
 * JSON.parse 必须带保护：历史数据写坏时不能让整条查询跟着失败
 */
function parseStoredStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value !== "string" || value.trim() === "") {
		return [];
	}
	const trimmed = value.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter((item): item is string => typeof item === "string");
			}
			return [];
		} catch {
			// JSON 解析失败时按逗号分隔兜底
		}
	}
	return trimmed
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
}

/**
 * 解析库里可能以 JSON 数组字符串、逗号分隔字符串或数组三种形态存储的库 ID 列表字段
 */
function parseStoredNumberList(value: unknown): number[] {
	return parseStoredStringList(value)
		.map((item) => Number(item))
		.filter((item) => Number.isInteger(item) && item > 0);
}

/**
 * 1. 发起设备授权请求
 */
export async function startKbDeviceRequest(
	clientName: string,
	requestedScopes: string[] = [...DEFAULT_KB_SCOPES],
): Promise<{
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
}> {
	const trimmedClientName = clientName.trim() || "Personal AI Agent";
	const validScopes = requestedScopes.filter((s) => (ALL_KB_SCOPES as readonly string[]).includes(s));
	const scopesToRequest = validScopes.length > 0 ? validScopes : [...DEFAULT_KB_SCOPES];

	const deviceCode = randomBytes(32).toString("hex");
	const deviceCodeHash = sha256(deviceCode);
	const userCode = generateUserCode();
	const expiresInSeconds = 600; // 10 分钟

	await pool.execute(
		`INSERT INTO kb_device_requests 
		(device_code_hash, user_code, client_name, requested_scopes, status, expires_at)
		VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
		[deviceCodeHash, userCode, trimmedClientName, scopesToRequest.join(","), expiresInSeconds],
	);

	const verificationUri = "/knowledge/authorize";
	const verificationUriComplete = `/knowledge/authorize?userCode=${userCode}`;

	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete,
		expiresIn: expiresInSeconds,
		interval: 5,
	};
}

/**
 * 2. 根据 userCode 查询设备授权请求信息 (供浏览器授权页展示)
 */
export async function getKbDeviceRequestByUserCode(userCode: string): Promise<KbDeviceRequestInfo> {
	const cleanCode = userCode.trim().toUpperCase();
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT id, user_code, client_name, requested_scopes, status, user_id, grant_id, expires_at, approved_at, created_at
		FROM kb_device_requests 
		WHERE user_code = ? 
		ORDER BY id DESC LIMIT 1`,
		[cleanCode],
	);

	if (rows.length === 0) {
		throw new KbAgentError("invalid_request", "授权码不存在或已失效", 404);
	}

	const row = rows[0];
	const isExpired = new Date(row.expires_at).getTime() < Date.now();
	const status = isExpired && row.status === "pending" ? "expired" : row.status;

	return {
		id: row.id,
		userCode: row.user_code,
		clientName: row.client_name,
		requestedScopes: row.requested_scopes ? row.requested_scopes.split(",") : [],
		status,
		userId: row.user_id,
		grantId: row.grant_id,
		expiresAt: new Date(row.expires_at).toISOString(),
		approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
		createdAt: new Date(row.created_at).toISOString(),
	};
}

/**
 * 3. 普通用户在浏览器确认批准设备授权
 */
export async function approveKbDeviceRequest(
	userCode: string,
	userId: number,
	allowedLibraryIds: number[],
	grantedScopes: string[],
	expiresInDays = 7,
): Promise<{ grantId: number }> {
	const cleanCode = userCode.trim().toUpperCase();
	const connection = await pool.getConnection();

	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<RowDataPacket[]>(
			`SELECT * FROM kb_device_requests
			WHERE user_code = ?
			ORDER BY id DESC LIMIT 1
			FOR UPDATE`,
			[cleanCode],
		);

		if (rows.length === 0) {
			throw new KbAgentError("invalid_request", "授权码不存在", 404);
		}

		const reqRow = rows[0];
		if (new Date(reqRow.expires_at).getTime() < Date.now()) {
			throw new KbAgentError("expired_token", "授权请求已过期，请在客户端重新发起", 400);
		}

		if (reqRow.status !== "pending") {
			throw new KbAgentError("invalid_request", `该授权请求已被处理 (${reqRow.status})`, 400);
		}

		// 检查普通用户账号状态
		const [userRows] = await connection.query<RowDataPacket[]>(
			`SELECT id, is_active FROM comment_users WHERE id = ? LIMIT 1`,
			[userId],
		);
		if (userRows.length === 0 || !userRows[0].is_active) {
			throw new KbAgentError("access_denied", "账号不存在或已被封禁", 403);
		}

		// 规范与过滤参数
		const days = Math.max(1, Math.min(30, expiresInDays));
		// 授予的 scope 必须是客户端申请过的子集，不允许审批时擅自扩大授权范围
		const requestedScopes = parseStoredStringList(reqRow.requested_scopes);
		const validGrantedScopes = grantedScopes.filter(
			(s) => (ALL_KB_SCOPES as readonly string[]).includes(s) && requestedScopes.includes(s),
		);
		if (validGrantedScopes.length === 0) {
			throw new KbAgentError("invalid_scope", "至少需要授予一项客户端申请过的权限 (如 kb:read)", 400);
		}
		// 授权的库必须真实存在且归属当前用户，防止把别人的库写进授权范围
		if (allowedLibraryIds.length > 0) {
			const [libRows] = await connection.execute<RowDataPacket[]>(
				`SELECT id FROM kb_libraries WHERE owner_user_id = ? AND id IN (${allowedLibraryIds.map(() => "?").join(",")})`,
				[userId, ...allowedLibraryIds],
			);
			const ownedIds = new Set(libRows.map((row) => Number(row.id)));
			const invalid = allowedLibraryIds.filter((id) => !ownedIds.has(id));
			if (invalid.length > 0) {
				throw new KbAgentError("invalid_target", "授权范围包含不存在的知识库或非本人知识库", 403);
			}
		}

		// 生成 32 字节高熵访问 Token
		const plainToken = "kba_" + randomBytes(32).toString("hex");
		const tokenHash = sha256(plainToken);
		const encryptedDeliveryToken = encryptDeliveryToken(plainToken);

		// 写入 kb_user_grants 表
		const [grantResult] = await connection.execute<ResultSetHeader>(
			`INSERT INTO kb_user_grants 
			(user_id, token_hash, client_name, scopes, allowed_library_ids, expires_at)
			VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
			[
				userId,
				tokenHash,
				reqRow.client_name,
				validGrantedScopes.join(","),
				JSON.stringify(allowedLibraryIds),
				days,
			],
		);

		const grantId = grantResult.insertId;

		// 更新 kb_device_requests 表
		await connection.execute(
			`UPDATE kb_device_requests 
			SET status = 'approved', user_id = ?, grant_id = ?, encrypted_delivery_token = ?, approved_at = NOW()
			WHERE id = ?`,
			[userId, grantId, encryptedDeliveryToken, reqRow.id],
		);

		await connection.commit();
		return { grantId };
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * 4. 普通用户在浏览器拒绝授权
 */
export async function denyKbDeviceRequest(userCode: string, userId?: number): Promise<void> {
	const cleanCode = userCode.trim().toUpperCase();
	await pool.execute(
		`UPDATE kb_device_requests 
		SET status = 'denied', user_id = COALESCE(?, user_id)
		WHERE user_code = ? AND status = 'pending'`,
		[userId ?? null, cleanCode],
	);
}

/**
 * 5. 客户端轮询获取 Token (遵循 RFC 8628 规范与 5 秒限流)
 */
export async function pollKbDeviceToken(deviceCode: string): Promise<{
	accessToken: string;
	tokenType: string;
	expiresIn: number;
	scopes: string[];
	allowedLibraryIds: number[];
	clientName: string;
}> {
	const cleanCode = deviceCode.trim();
	const codeHash = sha256(cleanCode);

	// 限流检查：被限流时不重置时间戳，避免客户端高频轮询把自己饿死在窗口里
	const now = Date.now();
	const lastPoll = pollLimiter.get(codeHash);
	if (lastPoll && now - lastPoll < POLL_MIN_INTERVAL_MS) {
		throw new KbAgentError("slow_down", "轮询过于频繁，请降低请求频率 (至少间隔 5 秒)", 400, 5);
	}
	pollLimiter.set(codeHash, now);
	// 顺带淘汰过期限流记录，防止 Map 随历史设备码无限增长
	if (pollLimiter.size > 0) {
		for (const [key, ts] of pollLimiter) {
			if (now - ts > 60 * 60 * 1000) {
				pollLimiter.delete(key);
			}
		}
	}

	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();

		const [rows] = await connection.query<RowDataPacket[]>(
			`SELECT * FROM kb_device_requests 
			WHERE device_code_hash = ? FOR UPDATE`,
			[codeHash],
		);

		if (rows.length === 0) {
			throw new KbAgentError("invalid_grant", "无效的设备码", 400);
		}

		const reqRow = rows[0];

		// 检查过期
		if (new Date(reqRow.expires_at).getTime() < now) {
			pollLimiter.delete(codeHash);
			throw new KbAgentError("expired_token", "授权请求已超时过期，请重新发起连接", 400);
		}

		if (reqRow.status === "pending") {
			await connection.commit();
			throw new KbAgentError("authorization_pending", "等待用户在浏览器中授权", 400, 5);
		}

		if (reqRow.status === "denied") {
			pollLimiter.delete(codeHash);
			await connection.commit();
			throw new KbAgentError("access_denied", "用户已拒绝授权", 400);
		}

		if (reqRow.status === "approved") {
			if (!reqRow.encrypted_delivery_token || !reqRow.grant_id) {
				pollLimiter.delete(codeHash);
				throw new KbAgentError("expired_token", "该授权凭据已被领取或已失效", 400);
			}

			// 查询 grant（必须仍然有效：未撤销且未过期）
			const [grantRows] = await connection.query<RowDataPacket[]>(
				`SELECT * FROM kb_user_grants WHERE id = ? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`,
				[reqRow.grant_id],
			);

			if (grantRows.length === 0) {
				pollLimiter.delete(codeHash);
				throw new KbAgentError("access_denied", "授权已被撤销或已过期", 400);
			}

			const grant = grantRows[0];

			// 先把交付数据全部解析好再 commit：
			// 若解析在 commit/置空之后才失败，明文 token 已经永久丢失
			const plainToken = decryptDeliveryToken(reqRow.encrypted_delivery_token);
			const allowedLibIds = parseStoredNumberList(grant.allowed_library_ids);
			const grantExpiresAtMs = new Date(grant.expires_at).getTime();
			const expiresInSeconds = Math.max(0, Math.floor((grantExpiresAtMs - Date.now()) / 1000));

			// 一次性交付：交付后立即清空 encrypted_delivery_token
			await connection.execute(
				`UPDATE kb_device_requests SET encrypted_delivery_token = NULL WHERE id = ?`,
				[reqRow.id],
			);

			await connection.commit();
			pollLimiter.delete(codeHash);

			return {
				accessToken: plainToken,
				tokenType: "Bearer",
				expiresIn: expiresInSeconds,
				scopes: parseStoredStringList(grant.scopes),
				allowedLibraryIds: allowedLibIds,
				clientName: grant.client_name,
			};
		}

		pollLimiter.delete(codeHash);
		throw new KbAgentError("invalid_grant", "未知的请求状态", 400);
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * 6. 通过 Bearer Token 鉴权获取 Grant 及普通用户信息
 */
export async function getKbGrantByToken(token: string): Promise<KbAgentGrant | null> {
	if (!token || !token.trim()) return null;
	const tokenHash = sha256(token.trim());

	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT g.*, u.account AS username, u.nickname, u.avatar_url AS avatar, u.email, u.is_active
		FROM kb_user_grants g
		JOIN comment_users u ON u.id = g.user_id
		WHERE g.token_hash = ? AND g.revoked_at IS NULL AND g.expires_at > NOW()
		LIMIT 1`,
		[tokenHash],
	);

	if (rows.length === 0) return null;
	const row = rows[0];

	if (!row.is_active) {
		// 账号已被封禁，授权自动失效
		return null;
	}

	// 异步更新最后使用时间
	void pool
		.execute(`UPDATE kb_user_grants SET last_used_at = NOW() WHERE id = ?`, [row.id])
		.catch(() => undefined);

	const allowedLibIds = parseStoredNumberList(row.allowed_library_ids);

	return {
		id: row.id,
		userId: row.user_id,
		tokenHash: row.token_hash,
		clientName: row.client_name,
		scopes: parseStoredStringList(row.scopes),
		allowedLibraryIds: allowedLibIds,
		expiresAt: new Date(row.expires_at).toISOString(),
		lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
		revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
		createdAt: new Date(row.created_at).toISOString(),
		user: {
			id: row.user_id,
			username: row.username,
			nickname: row.nickname,
			avatar: row.avatar,
			email: row.email,
		},
	};
}

/**
 * 7. 列出普通用户的所有有效 MCP 连接
 */
export async function listKbUserGrants(userId: number): Promise<KbAgentGrant[]> {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT * FROM kb_user_grants 
		WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
		ORDER BY id DESC`,
		[userId],
	);

	return (rows as RowDataPacket[]).map((row) => ({
		id: row.id,
		userId: row.user_id,
		tokenHash: row.token_hash,
		clientName: row.client_name,
		scopes: parseStoredStringList(row.scopes),
		allowedLibraryIds: parseStoredNumberList(row.allowed_library_ids),
		expiresAt: new Date(row.expires_at).toISOString(),
		lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
		revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
		createdAt: new Date(row.created_at).toISOString(),
	}));
}

/**
 * 8. 撤销指定 MCP 授权
 */
export async function revokeKbUserGrant(userId: number, grantId: number): Promise<boolean> {
	const [result] = await pool.execute<ResultSetHeader>(
		`UPDATE kb_user_grants SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		[grantId, userId],
	);
	return result.affectedRows > 0;
}

/**
 * 9. 撤销用户的所有 MCP 授权 (在修改密码、重置密码、账号封禁时调用)
 */
export async function revokeAllKbUserGrants(userId: number): Promise<number> {
	const [result] = await pool.execute<ResultSetHeader>(
		`UPDATE kb_user_grants SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`,
		[userId],
	);
	return result.affectedRows;
}

/**
 * 10. 幂等执行包装器 (用于 MCP 写入与文档创建，支持 24 小时去重与冲突防护)
 */
export async function withIdempotency<T>(
	userId: number,
	grantId: number | null,
	actionType: string,
	idempotencyKey: string | undefined,
	requestPayload: unknown,
	execute: () => Promise<T>,
): Promise<T> {
	if (!idempotencyKey || !idempotencyKey.trim()) return execute();
	const cleanKey = idempotencyKey.trim();
	const reqHash = sha256(JSON.stringify(requestPayload));

	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT request_hash, result_payload, expires_at FROM kb_mutation_keys
		WHERE user_id = ? AND action_type = ? AND idempotency_key = ? AND expires_at > NOW()`,
		[userId, actionType, cleanKey],
	);

	if (rows.length > 0) {
		const row = rows[0];
		if (row.request_hash !== reqHash) {
			throw new KbAgentError("idempotency_conflict", "同 idempotencyKey 但请求内容不一致 (409 Conflict)", 409);
		}
		if (typeof row.result_payload === "string") {
			try {
				return JSON.parse(row.result_payload) as T;
			} catch {
				// 存档损坏时按未命中处理，重新执行并覆盖
			}
		} else {
			return row.result_payload as T;
		}
	}

	const result = await execute();

	await pool
		.execute(
			`INSERT INTO kb_mutation_keys
			(user_id, grant_id, action_type, idempotency_key, request_hash, result_payload, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))
			ON DUPLICATE KEY UPDATE request_hash = VALUES(request_hash), result_payload = VALUES(result_payload), expires_at = VALUES(expires_at)`,
			[userId, grantId, actionType, cleanKey, reqHash, JSON.stringify(result)],
		)
		.catch(() => undefined); // 并发写入同一 key 时让唯一约束静默仲裁，不影响主流程结果

	return result;
}

/**
 * 11. 清理过期的设备授权请求
 */
export async function cleanupExpiredKbDeviceRequests(): Promise<number> {
	const [result] = await pool.execute<ResultSetHeader>(
		`DELETE FROM kb_device_requests WHERE expires_at < NOW() AND status IN ('pending', 'expired')`,
	);
	return result.affectedRows;
}

/**
 * 12. 清理过期 Grants 与 过期 Mutation Keys
 */
export async function cleanupExpiredKbGrants(): Promise<number> {
	const [mKeys] = await pool.execute<ResultSetHeader>(
		`DELETE FROM kb_mutation_keys WHERE expires_at < NOW()`,
	);
	// 过期 grant 的 token 已永久失效，一并删除避免表无限增长
	await pool.execute(
		`DELETE FROM kb_user_grants WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY) AND revoked_at IS NOT NULL`,
	);
	return mKeys.affectedRows;
}

