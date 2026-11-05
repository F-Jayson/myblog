import { createHash, randomBytes } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { config } from "./config.js";
import { pool } from "./db.js";
import {
	createCategory,
	createPost,
	createTag,
	deletePost,
	getAdminPost,
	getSiteSetting,
	listAllCategories,
	listAllTags,
	reviseManagedPost,
	updatePostReadingStats,
} from "./repository.js";

export const AGENT_SCOPES = ["posts:read", "posts:write", "posts:publish", "posts:delete", "media:write"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: AgentScope[] = ["posts:read", "posts:write", "media:write"];

export const AGENT_SCOPE_CATALOG: Array<{ id: AgentScope; label: string; description: string }> = [
	{ id: "posts:read", label: "读取文章", description: "查看文章标题、正文、分类和发布状态" },
	{ id: "posts:write", label: "写入草稿", description: "创建或更新文章、分类和标签。未单独授权发布时，新文章保存为草稿" },
	{ id: "posts:publish", label: "发布文章", description: "把智能体同步的文章发布到前台，并修改已经发布的同步文章" },
	{ id: "posts:delete", label: "删除同步文章", description: "删除由智能体同步到博客的文章" },
	{ id: "media:write", label: "上传图片", description: "上传文章配图并取得可写入 Markdown 的地址" },
];

const DEVICE_MINUTES = 10;
const POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class AgentError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "AgentError";
		this.status = status;
		this.code = code;
	}
}

export type AgentGrant = {
	id: number;
	adminUserId: number;
	username: string;
	clientName: string;
	scopes: AgentScope[];
	expiresAt: string;
};

export type UpsertAgentPostInput = {
	externalKey: string;
	title: string;
	content: string;
	excerpt?: string;
	slug?: string;
	categories?: string[];
	tags?: string[];
	cover?: string | null;
	pinned?: boolean;
	status?: "draft" | "published";
};

type ManagedPost = NonNullable<Awaited<ReturnType<typeof getAdminPost>>>;

const startBuckets = new Map<string, number[]>();

export function assertDeviceStartAllowed(ip: string) {
	const now = Date.now();
	const recent = (startBuckets.get(ip) ?? []).filter((time) => now - time < 10 * 60 * 1000);
	if (recent.length >= 20) throw new AgentError(429, "rate_limited", "授权请求过于频繁，请稍后再试");
	recent.push(now);
	startBuckets.set(ip, recent);
}

export function formatUserCode(code: string) {
	const raw = code.toUpperCase();
	return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export function normalizeUserCode(value: string) {
	return value.replace(/[^a-z0-9]/giu, "").toUpperCase();
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function cleanClientName(value: unknown) {
	const text = typeof value === "string" ? value.replace(/[\u0000-\u001f]/gu, "").trim() : "";
	return (text || "Cursor 智能体").slice(0, 120);
}

function parseScopeList(value: unknown): AgentScope[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const selected = new Set<AgentScope>();
	for (const item of raw) {
		const scope = String(item).trim() as AgentScope;
		if ((AGENT_SCOPES as readonly string[]).includes(scope)) selected.add(scope);
	}
	return AGENT_SCOPES.filter((scope) => selected.has(scope));
}

export function expandScopes(scopes: AgentScope[]) {
	const selected = new Set<AgentScope>(scopes);
	if (selected.has("posts:write") || selected.has("posts:publish") || selected.has("posts:delete") || selected.has("media:write")) selected.add("posts:read");
	if (selected.has("posts:publish")) selected.add("posts:write");
	return AGENT_SCOPES.filter((scope) => selected.has(scope));
}

export function normalizeScopes(value: unknown, fallback = DEFAULT_AGENT_SCOPES) {
	const parsed = parseScopeList(value);
	return expandScopes(parsed.length ? parsed : fallback);
}

function scopeText(scopes: AgentScope[]) {
	return scopes.join(",");
}

function browserOrigin() {
	const origin = config.clientOrigin.split(",")[0]?.trim().replace(/\/+$/u, "") ?? "";
	if (!origin) throw new AgentError(500, "server_misconfigured", "未配置 CLIENT_ORIGIN，无法打开授权页");
	return origin;
}

function createUserCode() {
	const bytes = randomBytes(8);
	return [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

async function unusedUserCode() {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const code = createUserCode();
		const [rows] = await pool.query<RowDataPacket[]>(
			"SELECT id FROM agent_device_requests WHERE user_code = ? AND status = 'pending' AND expires_at > NOW() LIMIT 1",
			[code],
		);
		if (!rows[0]) return code;
	}
	throw new AgentError(503, "unavailable", "暂时无法创建授权请求，请稍后重试");
}

async function expireDeviceRequests() {
	await pool.execute("UPDATE agent_device_requests SET status = 'expired', delivery_token = NULL WHERE status = 'pending' AND expires_at <= NOW()");
	await pool.execute("UPDATE agent_device_requests SET delivery_token = NULL WHERE delivery_token IS NOT NULL AND expires_at <= NOW()");
}

function scopeViews(scopes: AgentScope[]) {
	return AGENT_SCOPE_CATALOG.filter((item) => scopes.includes(item.id));
}

async function siteTitle() {
	try {
		const value = await getSiteSetting("site");
		if (!value || typeof value !== "object") return "";
		const record = value as Record<string, unknown>;
		for (const key of ["title", "siteTitle", "name"]) {
			if (typeof record[key] === "string" && record[key].trim()) return record[key].trim().slice(0, 120);
		}
	} catch {
		return "";
	}
	return "";
}

export async function startDeviceAuthorization(input: { clientName?: unknown; scopes?: unknown }) {
	await expireDeviceRequests();
	const scopes = normalizeScopes(input.scopes);
	const clientName = cleanClientName(input.clientName);
	const userCode = await unusedUserCode();
	const deviceCode = randomBytes(32).toString("base64url");
	await pool.execute(
		`INSERT INTO agent_device_requests (device_code_hash, user_code, client_name, requested_scopes, status, expires_at)
		 VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ${DEVICE_MINUTES} MINUTE))`,
		[sha256(deviceCode), userCode, clientName, scopeText(scopes)],
	);
	const origin = browserOrigin();
	const verificationUri = `${origin}/agent/authorize`;
	return {
		deviceCode,
		userCode,
		userCodeDisplay: formatUserCode(userCode),
		verificationUri,
		verificationUriComplete: `${verificationUri}?code=${userCode}`,
		expiresIn: DEVICE_MINUTES * 60,
		interval: POLL_INTERVAL_SECONDS,
		scopes,
		clientName,
	};
}

export async function getDeviceRequestPublic(userCode: string) {
	await expireDeviceRequests();
	const normalized = normalizeUserCode(userCode);
	if (normalized.length !== 8) throw new AgentError(404, "not_found", "找不到这次授权请求");
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT user_code AS userCode, client_name AS clientName, requested_scopes AS requestedScopes, status, expires_at AS expiresAt
		 FROM agent_device_requests WHERE user_code = ? ORDER BY id DESC LIMIT 1`,
		[normalized],
	);
	const row = rows[0];
	if (!row) throw new AgentError(404, "not_found", "找不到这次授权请求");
	const scopes = normalizeScopes(String(row.requestedScopes ?? ""), []);
	return {
		userCode: String(row.userCode),
		userCodeDisplay: formatUserCode(String(row.userCode)),
		clientName: String(row.clientName),
		scopes: scopeViews(scopes),
		status: String(row.status),
		expiresAt: String(row.expiresAt ?? ""),
		siteName: await siteTitle(),
	};
}

export async function approveDeviceRequest(userCode: string, adminUserId: number, requested: unknown) {
	await expireDeviceRequests();
	const normalized = normalizeUserCode(userCode);
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT id, requested_scopes AS requestedScopes, client_name AS clientName, status
		 FROM agent_device_requests WHERE user_code = ? AND status = 'pending' AND expires_at > NOW() ORDER BY id DESC LIMIT 1`,
		[normalized],
	);
	const row = rows[0];
	if (!row) throw new AgentError(404, "not_found", "授权请求已过期或不存在，请回到智能体重新发起");
	const allowed = normalizeScopes(String(row.requestedScopes ?? ""), []);
	const chosen = requested === undefined ? allowed : expandScopes(parseScopeList(requested));
	if (!chosen.length || chosen.some((scope) => !allowed.includes(scope))) {
		throw new AgentError(400, "invalid_scope", "只能同意这次申请里列出的权限");
	}
	const token = `ag_${randomBytes(32).toString("base64url")}`;
	const clientName = String(row.clientName);
	const [grant] = await pool.execute<ResultSetHeader>(
		`INSERT INTO agent_grants (token_hash, admin_user_id, client_name, scopes, expires_at)
		 VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${config.agentGrantDays} DAY))`,
		[sha256(token), adminUserId, clientName, scopeText(chosen)],
	);
	const [updated] = await pool.execute<ResultSetHeader>(
		`UPDATE agent_device_requests
		 SET status = 'approved', admin_user_id = ?, grant_id = ?, delivery_token = ?, approved_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 2 MINUTE)
		 WHERE id = ? AND status = 'pending'`,
		[adminUserId, grant.insertId, token, row.id],
	);
	if (!updated.affectedRows) {
		await pool.execute("DELETE FROM agent_grants WHERE id = ?", [grant.insertId]);
		throw new AgentError(409, "conflict", "这次授权已经被处理");
	}
	await recordAudit({ grantId: Number(grant.insertId), adminUserId, action: "approve", target: clientName, detail: chosen.join(",") });
	return { approved: true, clientName, scopes: chosen };
}

export async function denyDeviceRequest(userCode: string, adminUserId: number) {
	await expireDeviceRequests();
	const normalized = normalizeUserCode(userCode);
	const [result] = await pool.execute<ResultSetHeader>(
		`UPDATE agent_device_requests SET status = 'denied', admin_user_id = ?, delivery_token = NULL
		 WHERE user_code = ? AND status = 'pending' AND expires_at > NOW()`,
		[adminUserId, normalized],
	);
	if (!result.affectedRows) throw new AgentError(404, "not_found", "授权请求已过期或不存在");
	await recordAudit({ grantId: null, adminUserId, action: "deny", target: normalized, detail: "" });
	return { denied: true };
}

export async function pollDeviceToken(deviceCode: string) {
	await expireDeviceRequests();
	const secret = deviceCode.trim();
	if (secret.length < 20 || secret.length > 200) throw new AgentError(404, "not_found", "授权请求不存在");
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT status, delivery_token AS deliveryToken, expires_at AS expiresAt, client_name AS clientName, grant_id AS grantId
		 FROM agent_device_requests WHERE device_code_hash = ? ORDER BY id DESC LIMIT 1`,
		[sha256(secret)],
	);
	const row = rows[0];
	if (!row) throw new AgentError(404, "not_found", "授权请求不存在");
	const status = String(row.status);
	if (status === "denied") throw new AgentError(400, "access_denied", "管理员拒绝了这次授权");
	if (status === "expired" || !row.deliveryToken) {
		if (status === "pending") throw new AgentError(400, "authorization_pending", "等待管理员在浏览器中确认授权");
		throw new AgentError(400, "expired_token", "授权请求已过期，请重新发起");
	}
	if (status !== "approved") throw new AgentError(400, "authorization_pending", "等待管理员在浏览器中确认授权");
	const grant = await getGrantById(Number(row.grantId));
	if (!grant) throw new AgentError(400, "expired_token", "授权已经失效，请重新发起");
	const expiresAt = new Date(String(row.expiresAt).replace(" ", "T"));
	return {
		accessToken: String(row.deliveryToken),
		tokenType: "Bearer" as const,
		expiresAt: grant.expiresAt,
		expiresIn: Math.max(0, Math.floor((Date.parse(grant.expiresAt.includes("T") ? grant.expiresAt : grant.expiresAt.replace(" ", "T")) - Date.now()) / 1000)),
		scopes: grant.scopes,
		clientName: grant.clientName,
		deliveryExpiresAt: Number.isNaN(expiresAt.getTime()) ? "" : expiresAt.toISOString(),
		interval: POLL_INTERVAL_SECONDS,
	};
}

async function getGrantById(id: number): Promise<AgentGrant | null> {
	if (!Number.isInteger(id) || id < 1) return null;
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT g.id, g.admin_user_id AS adminUserId, g.client_name AS clientName, g.scopes, g.expires_at AS expiresAt, u.username
		 FROM agent_grants g INNER JOIN admin_users u ON u.id = g.admin_user_id
		 WHERE g.id = ? AND g.revoked_at IS NULL AND g.expires_at > NOW() AND u.is_active <> 0 LIMIT 1`,
		[id],
	);
	return rows[0] ? mapGrant(rows[0]) : null;
}

function mapGrant(row: RowDataPacket): AgentGrant {
	return {
		id: Number(row.id),
		adminUserId: Number(row.adminUserId),
		username: String(row.username),
		clientName: String(row.clientName),
		scopes: normalizeScopes(String(row.scopes ?? ""), []),
		expiresAt: String(row.expiresAt ?? ""),
	};
}

export async function getAgentGrantByToken(token: string): Promise<AgentGrant | null> {
	const secret = token.trim();
	if (!secret.startsWith("ag_")) return null;
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT g.id, g.admin_user_id AS adminUserId, g.client_name AS clientName, g.scopes, g.expires_at AS expiresAt, u.username
		 FROM agent_grants g INNER JOIN admin_users u ON u.id = g.admin_user_id
		 WHERE g.token_hash = ? AND g.revoked_at IS NULL AND g.expires_at > NOW() AND u.is_active <> 0 LIMIT 1`,
		[sha256(secret)],
	);
	const grant = rows[0] ? mapGrant(rows[0]) : null;
	if (!grant) return null;
	await pool.execute(
		"UPDATE agent_grants SET last_used_at = NOW() WHERE id = ? AND (last_used_at IS NULL OR last_used_at < DATE_SUB(NOW(), INTERVAL 1 MINUTE))",
		[grant.id],
	);
	return grant;
}

export async function revokeAgentGrant(id: number, adminUserId: number | null, action: "revoke" | "disconnect") {
	const [result] = await pool.execute<ResultSetHeader>(
		"UPDATE agent_grants SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL",
		[id],
	);
	if (!result.affectedRows && action === "revoke") return false;
	await recordAudit({ grantId: id, adminUserId, action, target: String(id), detail: "" });
	return true;
}

export async function listAgentGrants() {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT g.id, g.client_name AS clientName, g.scopes, g.expires_at AS expiresAt, g.last_used_at AS lastUsedAt,
		        g.revoked_at AS revokedAt, g.created_at AS createdAt, u.username,
		        (SELECT COUNT(*) FROM agent_documents d WHERE d.admin_user_id = g.admin_user_id) AS documentCount
		 FROM agent_grants g INNER JOIN admin_users u ON u.id = g.admin_user_id
		 ORDER BY g.created_at DESC, g.id DESC LIMIT 100`,
	);
	return rows.map((row) => {
		const revoked = Boolean(row.revokedAt);
		const expiresAt = String(row.expiresAt ?? "");
		const expired = Date.parse(expiresAt.includes("T") ? expiresAt : expiresAt.replace(" ", "T")) <= Date.now();
		return {
			id: Number(row.id),
			clientName: String(row.clientName),
			username: String(row.username),
			scopes: normalizeScopes(String(row.scopes ?? ""), []),
			expiresAt,
			lastUsedAt: row.lastUsedAt ? String(row.lastUsedAt) : null,
			revokedAt: row.revokedAt ? String(row.revokedAt) : null,
			createdAt: String(row.createdAt ?? ""),
			documentCount: Number(row.documentCount ?? 0),
			status: revoked ? "revoked" : expired ? "expired" : "active",
		};
	});
}

export async function listAgentAudit(limit: number) {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT a.id, a.action_name AS action, a.target, a.detail, a.created_at AS createdAt,
		        g.client_name AS clientName, u.username
		 FROM agent_audit a
		 LEFT JOIN agent_grants g ON g.id = a.grant_id
		 LEFT JOIN admin_users u ON u.id = a.admin_user_id
		 ORDER BY a.id DESC LIMIT ?`,
		[limit],
	);
	return rows.map((row) => ({
		id: Number(row.id),
		action: String(row.action),
		target: String(row.target ?? ""),
		detail: String(row.detail ?? ""),
		createdAt: String(row.createdAt ?? ""),
		clientName: row.clientName ? String(row.clientName) : "",
		username: row.username ? String(row.username) : "",
	}));
}

function requireScope(grant: AgentGrant, scope: AgentScope, message: string) {
	if (!grant.scopes.includes(scope)) throw new AgentError(403, "insufficient_scope", message);
}

function taxonomySlug(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 88);
	if (normalized) return normalized;
	const bytes = Buffer.from(value.trim(), "utf8").toString("hex").slice(0, 88);
	return `item-${bytes || "untitled"}`.slice(0, 100);
}

export function normalizeSlug(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
	if (normalized.length >= 2) return normalized;
	const hex = Buffer.from(value.trim(), "utf8").toString("hex").slice(0, 24);
	return `doc-${hex || "untitled"}`.slice(0, 80);
}

export function countDocumentWords(content: string) {
	const text = content
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
		.replace(/\[[^\]]*\]\([^)]*\)/gu, " ")
		.replace(/https?:\/\/\S+/gu, " ");
	const cjk = text.match(/\p{Script=Han}/gu)?.length ?? 0;
	const words = text.replace(/\p{Script=Han}/gu, " ").split(/\s+/u).filter((item) => /[A-Za-z0-9]/u.test(item)).length;
	return cjk + words;
}

function excerptFromMarkdown(content: string) {
	const withoutTitle = content.replace(/^\s*#[^\n]*\n+/u, "");
	return withoutTitle
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/`[^`]*`/gu, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
		.replace(/\[[^\]]*\]\([^)]*\)/gu, " ")
		.replace(/^#{1,6}\s+/gmu, "")
		.replace(/https?:\/\/\S+/gu, " ")
		.replace(/[`>#*_~]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function assertCover(value: string) {
	if (value.startsWith("/") || /^https?:\/\//iu.test(value)) return value.slice(0, 500);
	throw new AgentError(400, "invalid_cover", "封面地址需要是站内路径或 http(s) 链接");
}

function cleanExternalKey(value: string) {
	const key = value.trim();
	if (!key || key.length > 255 || /[\u0000-\u001f]/u.test(key)) throw new AgentError(400, "invalid_request", "外部编号需要是 1 到 255 个可见字符");
	return key;
}

function categoryNamesOf(post: ManagedPost) {
	const names = (post.categories ?? []).map((item) => item.name).filter(Boolean);
	if (names.length) return names;
	return post.category?.name ? [post.category.name] : [];
}

function presentPost(post: ManagedPost, externalKey: string | null, includeContent: boolean) {
	return {
		id: post.id,
		slug: post.slug,
		title: post.title,
		excerpt: post.excerpt,
		...(includeContent ? { content: post.content } : {}),
		cover: post.cover,
		category: post.category ? { name: post.category.name, slug: post.category.slug } : null,
		categories: (post.categories ?? []).map((item) => ({ name: item.name, slug: item.slug })),
		tags: post.tags.map((item) => ({ name: item.name, slug: item.slug })),
		pinned: post.pinned,
		status: post.status,
		views: post.views,
		words: post.words,
		minutes: post.minutes,
		publishedAt: post.publishedAt,
		updatedAt: post.updatedAt,
		externalKey,
		path: `/posts/${post.slug}`,
	};
}

function canonicalHash(input: { title: string; content: string; excerpt: string; slug: string; cover: string; categories: string[]; tags: string[]; pinned: boolean; status: string }) {
	return sha256(JSON.stringify({
		title: input.title,
		content: input.content,
		excerpt: input.excerpt,
		slug: input.slug,
		cover: input.cover,
		categories: [...input.categories].sort(),
		tags: [...input.tags].sort(),
		pinned: input.pinned,
		status: input.status,
	}));
}

async function allocateSlug(base: string, exceptPostId?: number) {
	const root = base.slice(0, 160);
	for (let index = 0; index < 25; index += 1) {
		const candidate = (index === 0 ? root : `${root.slice(0, 148)}-${index + 1}`).slice(0, 180);
		const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM posts WHERE slug = ? LIMIT 1", [candidate]);
		if (!rows[0] || Number(rows[0].id) === exceptPostId) return candidate;
	}
	return `${root.slice(0, 140)}-${randomBytes(4).toString("hex")}`.slice(0, 180);
}

async function findDocument(adminUserId: number, externalKey: string) {
	const [rows] = await pool.query<RowDataPacket[]>(
		"SELECT id, post_id AS postId, external_key AS externalKey FROM agent_documents WHERE admin_user_id = ? AND external_key = ? LIMIT 1",
		[adminUserId, externalKey],
	);
	const row = rows[0];
	return row ? { id: Number(row.id), postId: Number(row.postId), externalKey: String(row.externalKey) } : null;
}

async function findDocumentByPost(adminUserId: number, postId: number) {
	const [rows] = await pool.query<RowDataPacket[]>(
		"SELECT external_key AS externalKey FROM agent_documents WHERE admin_user_id = ? AND post_id = ? ORDER BY id DESC LIMIT 1",
		[adminUserId, postId],
	);
	return rows[0] ? String(rows[0].externalKey) : null;
}

async function saveDocumentLink(grant: AgentGrant, externalKey: string, postId: number, contentHash: string) {
	await pool.execute(
		`INSERT INTO agent_documents (admin_user_id, grant_id, external_key, post_id, content_hash)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE grant_id = VALUES(grant_id), post_id = VALUES(post_id), content_hash = VALUES(content_hash), updated_at = CURRENT_TIMESTAMP`,
		[grant.adminUserId, grant.id, externalKey, postId, contentHash],
	);
}

function isDuplicate(error: unknown) {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

export async function upsertAgentDocument(grant: AgentGrant, input: UpsertAgentPostInput) {
	requireScope(grant, "posts:write", "当前授权不能写入文章");
	const externalKey = cleanExternalKey(input.externalKey);
	const title = input.title.trim().slice(0, 255);
	if (!title) throw new AgentError(400, "invalid_request", "请填写文章标题");
	if (input.content.length > 1_500_000) throw new AgentError(400, "invalid_request", "正文超过 150 万字，请拆分后再同步");
	const link = await findDocument(grant.adminUserId, externalKey);
	const current = link ? await getAdminPost(link.postId) : null;
	const categories = input.categories !== undefined ? input.categories.map((item) => item.trim()).filter(Boolean).slice(0, 20) : current ? categoryNamesOf(current) : [];
	const tags = input.tags !== undefined ? input.tags.map((item) => item.trim()).filter(Boolean).slice(0, 30) : current ? current.tags.map((item) => item.name) : [];
	const cover = input.cover === undefined ? (current?.cover ?? null) : input.cover ? assertCover(input.cover.trim()) : null;
	const pinned = input.pinned === undefined ? Boolean(current?.pinned) : input.pinned;
	const status = input.status ?? (current?.status === "published" ? "published" : "draft");
	const excerpt = input.excerpt !== undefined ? input.excerpt.trim().slice(0, 2000) : (excerptFromMarkdown(input.content).slice(0, 180) || title.slice(0, 180));
	const slug = await allocateSlug(input.slug ? normalizeSlug(input.slug) : current ? current.slug : normalizeSlug(title || externalKey), current?.id);
	const desired = { title, content: input.content, excerpt, slug, cover: cover ?? "", categories, tags, pinned, status };
	if (current && canonicalHash(desired) === canonicalHash({
		title: current.title,
		content: current.content,
		excerpt: current.excerpt,
		slug: current.slug,
		cover: current.cover ?? "",
		categories: categoryNamesOf(current),
		tags: current.tags.map((item) => item.name),
		pinned: current.pinned,
		status: current.status,
	})) {
		return { action: "unchanged" as const, post: presentPost(current, externalKey, true) };
	}
	if (status === "published") requireScope(grant, "posts:publish", "当前授权不能发布或修改已发布文章。可以重新授权并勾选「发布文章」，或先保存为草稿。");
	const words = countDocumentWords(input.content);
	let postId = current?.id ?? 0;
	let created = false;
	if (!current) {
		let candidate = slug;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				postId = await createPost({
					slug: candidate,
					filename: candidate,
					title,
					excerpt,
					content: input.content,
					cover,
					categoryNames: categories,
					tagNames: tags,
					pinned,
					status,
				});
				created = true;
				break;
			} catch (error) {
				if (!isDuplicate(error) || attempt === 2) throw error;
				candidate = await allocateSlug(`${candidate}-${randomBytes(2).toString("hex")}`);
			}
		}
		await updatePostReadingStats(postId, words);
	} else {
		const revised = await reviseManagedPost(current.id, { slug, title, excerpt, content: input.content, cover, categoryNames: categories, tagNames: tags, pinned, status, words });
		if (!revised) throw new AgentError(404, "not_found", "文章不存在");
		postId = revised.id;
	}
	const saved = await getAdminPost(postId);
	if (!saved) throw new AgentError(500, "write_failed", "文章保存失败");
	await saveDocumentLink(grant, externalKey, saved.id, canonicalHash({
		title: saved.title,
		content: saved.content,
		excerpt: saved.excerpt,
		slug: saved.slug,
		cover: saved.cover ?? "",
		categories: categoryNamesOf(saved),
		tags: saved.tags.map((item) => item.name),
		pinned: saved.pinned,
		status: saved.status,
	}));
	await recordAudit({ grantId: grant.id, adminUserId: grant.adminUserId, action: "upsert", target: externalKey, detail: title });
	return { action: created ? "created" as const : "updated" as const, post: presentPost(saved, externalKey, true) };
}

export async function listAgentPosts(grant: AgentGrant, filters: { page: number; pageSize: number; status?: string; query?: string }) {
	requireScope(grant, "posts:read", "当前授权不能读取文章");
	const where = ["1 = 1"];
	const params: Array<string | number> = [grant.adminUserId];
	if (filters.status === "draft" || filters.status === "published") {
		where.push("p.status = ?");
		params.push(filters.status);
	}
	if (filters.query) {
		where.push("(p.title LIKE ? OR p.slug LIKE ? OR p.excerpt LIKE ?)");
		const value = `%${filters.query.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
		params.push(value, value, value);
	}
	const clause = `WHERE ${where.join(" AND ")}`;
	const [[count]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM posts p ${clause}`, params.slice(1));
	const offset = (filters.page - 1) * filters.pageSize;
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT p.id, p.slug, p.title, p.excerpt, p.cover, p.status, p.pinned, p.views, p.words, p.minutes,
		        p.published_at AS publishedAt, p.updated_at AS updatedAt, c.name AS categoryName, c.slug AS categorySlug,
		        (SELECT d.external_key FROM agent_documents d WHERE d.post_id = p.id AND d.admin_user_id = ? ORDER BY d.id DESC LIMIT 1) AS externalKey
		 FROM posts p LEFT JOIN categories c ON c.id = p.category_id
		 ${clause}
		 ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
		[...params, filters.pageSize, offset],
	);
	const total = Number(count?.total ?? 0);
	return {
		items: rows.map((row) => ({
			id: Number(row.id),
			slug: String(row.slug),
			title: String(row.title),
			excerpt: String(row.excerpt ?? ""),
			cover: row.cover ? String(row.cover) : null,
			category: row.categoryName ? { name: String(row.categoryName), slug: String(row.categorySlug ?? "") } : null,
			pinned: Boolean(Number(row.pinned)),
			status: row.status === "draft" ? "draft" : "published",
			views: Number(row.views ?? 0),
			words: Number(row.words ?? 0),
			minutes: Number(row.minutes ?? 1),
			publishedAt: row.publishedAt ? String(row.publishedAt) : null,
			updatedAt: String(row.updatedAt ?? ""),
			externalKey: row.externalKey ? String(row.externalKey) : null,
			path: `/posts/${row.slug}`,
		})),
		page: filters.page,
		pageSize: filters.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
	};
}

export async function getAgentPost(grant: AgentGrant, id: number) {
	requireScope(grant, "posts:read", "当前授权不能读取文章");
	const post = await getAdminPost(id);
	if (!post) throw new AgentError(404, "not_found", "文章不存在");
	return presentPost(post, await findDocumentByPost(grant.adminUserId, id), true);
}

export async function lookupAgentPost(grant: AgentGrant, query: { id?: number; slug?: string; externalKey?: string }) {
	requireScope(grant, "posts:read", "当前授权不能读取文章");
	if (query.externalKey) {
		const link = await findDocument(grant.adminUserId, cleanExternalKey(query.externalKey));
		if (!link) throw new AgentError(404, "not_found", "没有找到这个外部编号对应的文章");
		return getAgentPost(grant, link.postId);
	}
	if (query.slug) {
		const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM posts WHERE slug = ? LIMIT 1", [query.slug.trim()]);
		if (!rows[0]) throw new AgentError(404, "not_found", "文章不存在");
		return getAgentPost(grant, Number(rows[0].id));
	}
	if (query.id) return getAgentPost(grant, query.id);
	throw new AgentError(400, "invalid_request", "请提供文章 id、slug 或外部编号");
}

export async function setAgentPostStatus(grant: AgentGrant, postId: number, status: "draft" | "published") {
	if (status === "published") requireScope(grant, "posts:publish", "当前授权不能发布文章");
	else requireScope(grant, "posts:write", "当前授权不能把文章转为草稿");
	const externalKey = await findDocumentByPost(grant.adminUserId, postId);
	if (!externalKey) throw new AgentError(404, "not_linked", "只能更改由当前管理员的智能体同步过的文章");
	const current = await getAdminPost(postId);
	if (!current) throw new AgentError(404, "not_found", "文章不存在");
	if (current.status !== status) {
		if (status === "published") await pool.execute("UPDATE posts SET status = 'published', published_at = COALESCE(published_at, NOW()) WHERE id = ?", [postId]);
		else await pool.execute("UPDATE posts SET status = 'draft' WHERE id = ?", [postId]);
		await recordAudit({ grantId: grant.id, adminUserId: grant.adminUserId, action: status === "published" ? "publish" : "unpublish", target: externalKey, detail: current.title });
	}
	const saved = await getAdminPost(postId);
	if (!saved) throw new AgentError(404, "not_found", "文章不存在");
	return { action: current.status === status ? "unchanged" as const : status === "published" ? "published" as const : "unpublished" as const, post: presentPost(saved, externalKey, false) };
}

export async function deleteAgentPost(grant: AgentGrant, postId: number) {
	requireScope(grant, "posts:delete", "当前授权不能删除文章");
	const externalKey = await findDocumentByPost(grant.adminUserId, postId);
	if (!externalKey) throw new AgentError(404, "not_linked", "只能删除由当前管理员的智能体同步过的文章");
	const current = await getAdminPost(postId);
	const removed = await deletePost(postId);
	if (!removed) throw new AgentError(404, "not_found", "文章不存在");
	await recordAudit({ grantId: grant.id, adminUserId: grant.adminUserId, action: "delete", target: externalKey, detail: current?.title ?? "" });
	return { deleted: true, id: postId, externalKey };
}

export async function listAgentCategories(grant: AgentGrant) {
	requireScope(grant, "posts:read", "当前授权不能读取分类");
	const items = await listAllCategories();
	return items.map((item) => ({ id: item.id, name: item.name, slug: item.slug, description: item.description, postCount: item.postCount ?? 0 }));
}

export async function ensureAgentCategory(grant: AgentGrant, input: { name: string; description?: string }) {
	requireScope(grant, "posts:write", "当前授权不能创建分类");
	const name = input.name.trim().slice(0, 80);
	if (!name) throw new AgentError(400, "invalid_request", "请填写分类名称");
	const slug = taxonomySlug(name);
	try {
		await createCategory({ name, slug, description: input.description?.trim().slice(0, 255) ?? "" });
		await recordAudit({ grantId: grant.id, adminUserId: grant.adminUserId, action: "category", target: name, detail: "created" });
	} catch (error) {
		if (!isDuplicate(error)) throw error;
	}
	const found = (await listAllCategories()).find((item) => item.name === name || item.slug === slug);
	if (!found) throw new AgentError(500, "category_failed", "分类保存失败");
	return { id: found.id, name: found.name, slug: found.slug, description: found.description };
}

export async function listAgentTags(grant: AgentGrant) {
	requireScope(grant, "posts:read", "当前授权不能读取标签");
	const items = await listAllTags();
	return items.map((item) => ({ id: item.id, name: item.name, slug: item.slug, postCount: item.postCount ?? 0 }));
}

export async function ensureAgentTag(grant: AgentGrant, input: { name: string }) {
	requireScope(grant, "posts:write", "当前授权不能创建标签");
	const name = input.name.trim().slice(0, 80);
	if (!name) throw new AgentError(400, "invalid_request", "请填写标签名称");
	const slug = taxonomySlug(name);
	try {
		await createTag({ name, slug });
		await recordAudit({ grantId: grant.id, adminUserId: grant.adminUserId, action: "tag", target: name, detail: "created" });
	} catch (error) {
		if (!isDuplicate(error)) throw error;
	}
	const found = (await listAllTags()).find((item) => item.name === name || item.slug === slug);
	if (!found) throw new AgentError(500, "tag_failed", "标签保存失败");
	return { id: found.id, name: found.name, slug: found.slug };
}

export async function recordUpload(grant: AgentGrant, filename: string, url: string) {
	await recordAudit({ grantId: grant.id, adminUserId: grant.adminUserId, action: "upload", target: filename.slice(0, 255), detail: url.slice(0, 500) });
}

async function recordAudit(input: { grantId: number | null; adminUserId: number | null; action: string; target: string; detail: string }) {
	await pool.execute(
		"INSERT INTO agent_audit (grant_id, admin_user_id, action_name, target, detail) VALUES (?, ?, ?, ?, ?)",
		[input.grantId, input.adminUserId, input.action.slice(0, 40), input.target.slice(0, 255), input.detail.slice(0, 500)],
	);
}
