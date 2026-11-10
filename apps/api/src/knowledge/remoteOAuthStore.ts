import { createHash, randomBytes } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./repository.js";
import { ALL_KB_SCOPES, KbAgentError } from "./agentStore.js";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function base64url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 解析库里以 JSON 字符串（或已是数组）形态存储的列表字段。
 * 历史数据写坏时按空数组处理，不能让整条查询跟着失败
 */
function parseStoredJsonList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value !== "string" || value.trim() === "") {
		return [];
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

export interface OAuthClient {
	clientId: string;
	clientName: string;
	redirectUris: string[];
	isConfidential: boolean;
	createdAt: string;
}

export interface OAuthTokenResponse {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	refresh_token: string;
	scope: string;
}

/**
 * 1. 注册 OAuth 客户端 (RFC 7591)
 */
export async function registerOAuthClient(input: {
	clientName: string;
	redirectUris: string[];
	isConfidential?: boolean;
}): Promise<OAuthClient & { clientSecret?: string }> {
	const clientName = input.clientName.trim();
	if (!clientName) throw new KbAgentError("invalid_client_metadata", "客户端名称不能为空", 400);
	if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
		throw new KbAgentError("invalid_redirect_uri", "至少需要一个合法的 redirect_uri", 400);
	}

	for (const uri of input.redirectUris) {
		try {
			const parsed = new URL(uri);
			const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
			// http 只允许 localhost（本机回环调试）；对外必须是 https 或专用协议
			const isSupported =
				isLocalHttp || parsed.protocol === "https:" || uri.startsWith("cursor:") || uri.startsWith("vscode:");
			if (!isSupported) {
				throw new Error("Protocol not supported");
			}
		} catch {
			throw new KbAgentError("invalid_redirect_uri", `非法的 redirect_uri: ${uri}`, 400);
		}
	}

	const clientId = `kbc_${randomBytes(16).toString("hex")}`;
	let clientSecret: string | undefined;
	let secretHash: string | null = null;

	if (input.isConfidential) {
		clientSecret = `kbcs_${randomBytes(32).toString("hex")}`;
		secretHash = sha256(clientSecret);
	}

	await pool.execute(
		`INSERT INTO kb_oauth_clients (client_id, client_name, redirect_uris, client_secret_hash, is_confidential)
		 VALUES (?, ?, ?, ?, ?)`,
		[clientId, clientName, JSON.stringify(input.redirectUris), secretHash, Boolean(input.isConfidential)],
	);

	return {
		clientId,
		clientName,
		redirectUris: input.redirectUris,
		isConfidential: Boolean(input.isConfidential),
		clientSecret,
		createdAt: new Date().toISOString(),
	};
}

/**
 * 2. 查询 OAuth 客户端
 */
export async function getOAuthClient(clientId: string): Promise<OAuthClient | null> {
	if (!clientId || !clientId.trim()) return null;
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT client_id AS clientId, client_name AS clientName, redirect_uris AS redirectUris, is_confidential AS isConfidential, created_at AS createdAt
		 FROM kb_oauth_clients WHERE client_id = ?`,
		[clientId.trim()],
	);

	if (rows.length === 0) return null;
	const row = rows[0];
	return {
		clientId: row.clientId,
		clientName: row.clientName,
		redirectUris: typeof row.redirectUris === "string" ? JSON.parse(row.redirectUris) : row.redirectUris,
		isConfidential: Boolean(row.isConfidential),
		createdAt: String(row.createdAt),
	};
}

/**
 * 查询机密客户端的 client_secret 哈希（仅用于 token 端点认证，不对外下发）
 */
export async function getOAuthClientSecretHash(clientId: string): Promise<string | null> {
	if (!clientId || !clientId.trim()) return null;
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT client_secret_hash FROM kb_oauth_clients WHERE client_id = ?`,
		[clientId.trim()],
	);
	if (rows.length === 0) return null;
	return typeof rows[0].client_secret_hash === "string" ? rows[0].client_secret_hash : null;
}

/**
 * 3. 严格比对 redirect_uri
 */
export function validateRedirectUri(client: OAuthClient, redirectUri: string): boolean {
	if (!redirectUri) return false;
	try {
		const targetUrl = new URL(redirectUri);
		return client.redirectUris.some((allowed) => {
			const allowedUrl = new URL(allowed);
			// localhost 允许动态端口测试
			if (
				(targetUrl.hostname === "localhost" || targetUrl.hostname === "127.0.0.1") &&
				(allowedUrl.hostname === "localhost" || allowedUrl.hostname === "127.0.0.1")
			) {
				return targetUrl.protocol === allowedUrl.protocol && targetUrl.pathname === allowedUrl.pathname;
			}
			return allowed === redirectUri;
		});
	} catch {
		return false;
	}
}

/**
 * 4. 生成 OAuth 授权码 (含 PKCE S256 挑战)
 */
export async function createAuthorizationCode(params: {
	clientId: string;
	userId: number;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod?: string;
	scopes: string[];
	allowedLibraryIds: number[];
}): Promise<string> {
	const method = params.codeChallengeMethod || "S256";
	if (method !== "S256") {
		throw new KbAgentError("invalid_request", "仅支持 S256 PKCE 验证方式", 400);
	}
	if (!params.codeChallenge || params.codeChallenge.length < 40) {
		throw new KbAgentError("invalid_request", "code_challenge 长度不合规", 400);
	}
	// scope 白名单：超出系统能力范围的 scope 不允许落库
	const validScopes = params.scopes.filter((scope) => (ALL_KB_SCOPES as readonly string[]).includes(scope));
	if (validScopes.length === 0) {
		throw new KbAgentError("invalid_scope", "至少需要一个合法的授权范围", 400);
	}

	const plainCode = `kboc_${randomBytes(32).toString("hex")}`;
	const codeHash = sha256(plainCode);

	await pool.execute(
		`INSERT INTO kb_oauth_codes
		 (code_hash, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scopes, allowed_library_ids, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
		[
			codeHash,
			params.clientId,
			params.userId,
			params.redirectUri,
			params.codeChallenge,
			method,
			JSON.stringify(validScopes),
			JSON.stringify(params.allowedLibraryIds),
		],
	);

	return plainCode;
}

/**
 * 5. 校验 PKCE code_verifier
 */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
	const calculatedChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
	return calculatedChallenge === codeChallenge;
}

/**
 * 6. 使用授权码换取令牌 (grant_type=authorization_code)
 */
export async function exchangeAuthorizationCode(params: {
	code: string;
	clientId: string;
	redirectUri: string;
	codeVerifier: string;
}): Promise<OAuthTokenResponse> {
	const codeHash = sha256(params.code.trim());
	const conn = await pool.getConnection();

	try {
		await conn.beginTransaction();

		const [rows] = await conn.query<RowDataPacket[]>(
			`SELECT * FROM kb_oauth_codes WHERE code_hash = ? FOR UPDATE`,
			[codeHash],
		);

		if (rows.length === 0) {
			throw new KbAgentError("invalid_grant", "授权码不存在或无效", 400);
		}

		const codeRow = rows[0];

		if (codeRow.used_at) {
			throw new KbAgentError("invalid_grant", "授权码已被使用", 400);
		}

		if (new Date(codeRow.expires_at).getTime() < Date.now()) {
			throw new KbAgentError("invalid_grant", "授权码已过期", 400);
		}

		if (codeRow.client_id !== params.clientId) {
			throw new KbAgentError("invalid_grant", "client_id 不匹配", 400);
		}

		if (codeRow.redirect_uri !== params.redirectUri) {
			throw new KbAgentError("invalid_grant", "redirect_uri 不匹配", 400);
		}

		// PKCE 校验
		if (!verifyPkce(params.codeVerifier, codeRow.code_challenge)) {
			throw new KbAgentError("invalid_grant", "PKCE 校验失败 (code_verifier 不匹配)", 400);
		}

		// 标记授权码已消费
		await conn.execute(`UPDATE kb_oauth_codes SET used_at = NOW() WHERE id = ?`, [codeRow.id]);

		// 解析 scope 与 libraryIds（历史数据可能是 JSON 字符串，解析失败按空处理）
		const scopes: string[] = parseStoredJsonList(codeRow.scopes);
		const allowedLibraryIds: number[] = parseStoredJsonList(codeRow.allowed_library_ids)
			.map((item) => Number(item))
			.filter((item) => Number.isInteger(item) && item > 0);

		// 查客户端名称
		const [clientRows] = await conn.query<RowDataPacket[]>(
			`SELECT client_name FROM kb_oauth_clients WHERE client_id = ?`,
			[params.clientId],
		);
		const clientName = clientRows[0]?.client_name || "Remote MCP Client";

		// 签发短期 access_token (默认 10 分钟，600 秒)
		const plainAccessToken = `kbt_${randomBytes(32).toString("hex")}`;
		const tokenHash = sha256(plainAccessToken);

		const [grantRes] = await conn.execute<ResultSetHeader>(
			`INSERT INTO kb_user_grants
			 (user_id, token_hash, client_name, scopes, allowed_library_ids, expires_at)
			 VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
			[codeRow.user_id, tokenHash, clientName, JSON.stringify(scopes), JSON.stringify(allowedLibraryIds)],
		);
		const grantId = grantRes.insertId;

		// 签发所属家族的 refresh_token (最长 30 天)
		const familyId = `fam_${randomBytes(16).toString("hex")}`;
		const plainRefreshToken = `kbrt_${randomBytes(32).toString("hex")}`;
		const rtHash = sha256(plainRefreshToken);

		await conn.execute(
			`INSERT INTO kb_oauth_refresh_tokens
			 (family_id, token_hash, grant_id, user_id, client_id, is_used, expires_at)
			 VALUES (?, ?, ?, ?, ?, 0, DATE_ADD(NOW(), INTERVAL 30 DAY))`,
			[familyId, rtHash, grantId, codeRow.user_id, params.clientId],
		);

		await conn.commit();

		return {
			access_token: plainAccessToken,
			token_type: "Bearer",
			expires_in: 600,
			refresh_token: plainRefreshToken,
			scope: scopes.join(" "),
		};
	} catch (error) {
		// 事务只有在真正开启后才需要回滚；commit 之后的业务性失败再回滚反而会误伤
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/**
 * 7. Refresh Token 轮换与家族重用检测 (grant_type=refresh_token)
 */
export async function rotateRefreshToken(params: {
	refreshToken: string;
	clientId: string;
}): Promise<OAuthTokenResponse> {
	const rtHash = sha256(params.refreshToken.trim());
	const conn = await pool.getConnection();

	try {
		await conn.beginTransaction();

		const [rows] = await conn.query<RowDataPacket[]>(
			`SELECT * FROM kb_oauth_refresh_tokens WHERE token_hash = ? FOR UPDATE`,
			[rtHash],
		);

		if (rows.length === 0) {
			throw new KbAgentError("invalid_grant", "Refresh Token 无效或不存在", 400);
		}

		const rtRow = rows[0];

		if (rtRow.client_id !== params.clientId) {
			throw new KbAgentError("invalid_grant", "client_id 不匹配", 400);
		}

		if (rtRow.revoked_at || new Date(rtRow.expires_at).getTime() < Date.now()) {
			throw new KbAgentError("invalid_grant", "Refresh Token 已过期或已被撤销", 400);
		}

		// 重用攻击检测 (Replay Attack Detection)：
		// 若发现一个已经被消费过的 refresh_token 再次请求，说明可能发生了令牌窃听重放！
		// 必须立即吊销该家族全部令牌与关联的 Grant！
		if (rtRow.is_used) {
			await conn.execute(
				`UPDATE kb_oauth_refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL`,
				[rtRow.family_id],
			);
			await conn.execute(
				`UPDATE kb_user_grants SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL`,
				[rtRow.grant_id],
			);
			await conn.commit();
			throw new KbAgentError("invalid_grant", "检测到 Refresh Token 异常重用，为保障账号安全已撤销该连接家族全部授权", 400);
		}

		// 将旧 Refresh Token 标记为已消费
		await conn.execute(`UPDATE kb_oauth_refresh_tokens SET is_used = 1 WHERE id = ?`, [rtRow.id]);

		// 获取旧 Grant 信息
		const [grantRows] = await conn.query<RowDataPacket[]>(
			`SELECT * FROM kb_user_grants WHERE id = ?`,
			[rtRow.grant_id],
		);

		if (grantRows.length === 0 || grantRows[0].revoked_at) {
			throw new KbAgentError("invalid_grant", "对应的授权 Grant 已被撤销", 400);
		}
		const grant = grantRows[0];

		// 签发新的短期 access_token (10 分钟)
		const newAccessToken = `kbt_${randomBytes(32).toString("hex")}`;
		const newTokenHash = sha256(newAccessToken);

		// 更新 Grant 表中的 token_hash 与过期时间
		await conn.execute(
			`UPDATE kb_user_grants SET token_hash = ?, expires_at = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE id = ?`,
			[newTokenHash, grant.id],
		);

		// 签发新的轮转 Refresh Token（相同 familyId）：
		// 过期时间取「原 token 剩余有效期 + 30 天」与「原到期时间」的较大者不再顺延——
		// 直接 DATE_ADD(NOW(), 30 DAY) 会让活跃客户端永久续期
		const newRefreshToken = `kbrt_${randomBytes(32).toString("hex")}`;
		const newRtHash = sha256(newRefreshToken);
		const originalExpiryMs = new Date(rtRow.expires_at).getTime();
		const refreshedExpiry = Math.max(
			originalExpiryMs,
			Date.now() + 30 * 24 * 60 * 60 * 1000,
		);

		await conn.execute(
			`INSERT INTO kb_oauth_refresh_tokens
			 (family_id, token_hash, grant_id, user_id, client_id, is_used, expires_at)
			 VALUES (?, ?, ?, ?, ?, 0, ?)`,
			[rtRow.family_id, newRtHash, grant.id, rtRow.user_id, params.clientId, new Date(refreshedExpiry)],
		);

		await conn.commit();

		const scopes: string[] = parseStoredJsonList(grant.scopes);

		return {
			access_token: newAccessToken,
			token_type: "Bearer",
			expires_in: 600,
			refresh_token: newRefreshToken,
			scope: Array.isArray(scopes) ? scopes.join(" ") : "",
		};
	} catch (error) {
		// commit 后抛出的业务性失败（如重放检测）不需要再回滚
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/**
 * 8. 撤销 OAuth 令牌 (RFC 7009)
 */
export async function revokeOAuthToken(token: string): Promise<boolean> {
	if (!token || !token.trim()) return false;
	const tokenHash = sha256(token.trim());

	// 撤销 access_token 命中的 grant 后必须级联吊销其 refresh 家族：
	// 只撤 grant 的话 refresh_token 仍能轮换出新 grant，撤销等于没生效
	const [grantRes] = await pool.execute<ResultSetHeader>(
		`UPDATE kb_user_grants SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL`,
		[tokenHash],
	);

	if (grantRes.affectedRows > 0) {
		const [familyRows] = await pool.query<RowDataPacket[]>(
			`SELECT DISTINCT family_id FROM kb_oauth_refresh_tokens WHERE grant_id = (
				SELECT id FROM kb_user_grants WHERE token_hash = ?
			)`,
			[tokenHash],
		);
		for (const row of familyRows) {
			await pool.execute(
				`UPDATE kb_oauth_refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL`,
				[row.family_id],
			);
		}
		return true;
	}

	// 再尝试按 refresh_token 撤销
	const [rtRows] = await pool.query<RowDataPacket[]>(
		`SELECT family_id, grant_id FROM kb_oauth_refresh_tokens WHERE token_hash = ?`,
		[tokenHash],
	);

	if (rtRows.length > 0) {
		const { family_id, grant_id } = rtRows[0];
		await pool.execute(
			`UPDATE kb_oauth_refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL`,
			[family_id],
		);
		await pool.execute(
			`UPDATE kb_user_grants SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL`,
			[grant_id],
		);
		return true;
	}

	return false;
}
