import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import nodemailer from "nodemailer";
import { pool } from "./db.js";
import type { AuthorActivityDay, AuthorLearningProgress, AuthorProfile, AuthorProfileDetails, AuthorSkill, Category, Changelog, FeedbackEntry, FriendLink, ManagedPage, ManagedPageKey, Paginated, Post, PostSummary, Tag, UserClipboard, UserStorageItem } from "./types.js";

const ADMIN_PASSWORD_KEYLEN = 64;
const ADMIN_SESSION_DAYS = 7;
const COMMENT_PASSWORD_KEYLEN = 64;
const COMMENT_SESSION_DAYS = 30;
const COMMENT_EMAIL_CODE_TTL_MINUTES = 15;
export const USER_SPACE_LIMIT_BYTES = 30 * 1024 * 1024;
const PRESET_AVATAR_PATHS = Object.freeze([
	...Array.from({ length: 14 }, (_, index) => `/avatars/头像 女孩 (${index}).svg`),
	...Array.from({ length: 7 }, (_, index) => `/avatars/头像 男孩 (${index}).svg`),
]);

type CommentMailSettings = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	password: string;
	from: string;
	siteName: string;
	notificationEmails: string[];
};

let commentMailer: { key: string; transport: nodemailer.Transporter } | null = null;

async function commentMailSettings(): Promise<CommentMailSettings> {
	const stored = await getSiteSetting("comments");
	const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
	const env = process.env;
	const host = String(value.smtpHost ?? env.SMTP_HOST ?? "").trim();
	const port = Number(value.smtpPort ?? env.SMTP_PORT ?? 465) || 465;
	const secure = typeof value.smtpSecure === "boolean" ? value.smtpSecure : String(env.SMTP_SECURE ?? (port === 465)).toLowerCase() !== "false";
	const user = String(value.smtpUsername ?? env.SMTP_USER ?? "").trim();
	const password = String(value.smtpPassword ?? env.SMTP_PASSWORD ?? "");
	const from = String(value.senderEmail ?? value.smtpFrom ?? env.SMTP_FROM ?? user).trim();
	const notificationValue = value.notificationEmails ?? value.adminNotificationEmail ?? env.ADMIN_NOTIFICATION_EMAIL ?? "";
	const notificationEmails = (Array.isArray(notificationValue) ? notificationValue : String(notificationValue).split(/[;,\n]/u)).map(String).map((item) => item.trim()).filter((item) => /^\S+@\S+\.\S+$/u.test(item)).slice(0, 30);
	return { host, port, secure, user, password, from, siteName: String(value.senderName ?? env.SMTP_SITE_NAME ?? "Firefly"), notificationEmails };
}

async function sendCommentMail(to: string | string[], subject: string, text: string) {
	const settings = await commentMailSettings();
	if (!settings.host || !settings.user || !settings.password || !settings.from) return false;
	const key = [settings.host, settings.port, settings.secure, settings.user, settings.password, settings.from].join("|");
	if (!commentMailer || commentMailer.key !== key) {
		commentMailer = { key, transport: nodemailer.createTransport({ host: settings.host, port: settings.port, secure: settings.secure, auth: { user: settings.user, pass: settings.password }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }) };
	}
	await commentMailer.transport.sendMail({ from: settings.from, to, subject: `${settings.siteName} ${subject}`, text });
	return true;
}

async function notifyCommentAdmins(subject: string, lines: string[], enabledKey?: string) {
	try {
		const settings = await commentMailSettings();
		if (enabledKey) {
			const stored = await getSiteSetting("comments");
			const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
			if (value[enabledKey] === false) return;
		}
		if (!settings.notificationEmails.length) return;
		await sendCommentMail(settings.notificationEmails, subject, lines.join("\n"));
	} catch (error) {
		console.warn("[comment-mail] notification failed:", error instanceof Error ? error.message : error);
	}
}

const AUDIT_IP_SQL = "CASE WHEN ip LIKE '::ffff:%' THEN SUBSTRING(ip, 8) ELSE ip END";
const AUDIT_TEXT_LIMITS = {
	ip: 128,
	method: 16,
	path: 512,
	action: 255,
	actorRole: 32,
	actorId: 128,
	actorAccount: 128,
	clientName: 255,
	clientUa: 512,
} as const;
const AUDIT_SENSITIVE_FIELD = /pass(word)?|secret|token|authorization|cookie|session|credential|private[-_]?key|api[-_]?key|otp|captcha|verification[-_]?code|email[-_]?code|recovery|challenge/i;

export type AuditLogInput = {
	createdAt?: Date | string;
	ip?: unknown;
	method?: unknown;
	path?: unknown;
	action?: unknown;
	statusCode?: unknown;
	actorRole?: unknown;
	actorId?: unknown;
	actorAccount?: unknown;
	clientName?: unknown;
	clientUa?: unknown;
	requestPayload?: unknown;
	durationMs?: unknown;
};

export type AuditLogFilters = {
	page?: number;
	limit?: number;
	keyword?: string;
	method?: string;
	actorRole?: string;
	isAdmin?: boolean;
	path?: string;
	viewMode?: "timeline" | "ip";
	groupLogPreviewLimit?: number;
};

export type AdminUser = {
	id: number;
	username: string;
	displayName: string;
	role: "admin" | "superadmin";
	isActive: boolean;
	createdAt: string;
	updatedAt: string;
	lastLoginAt: string | null;
};

export type AdminPrincipal = AdminUser | { id: null; username: string; displayName: string; role: "legacy"; isActive: true };

function hashAdminPassword(password: string, salt = randomBytes(16).toString("hex")) {
	const derived = scryptSync(password, salt, ADMIN_PASSWORD_KEYLEN).toString("hex");
	return `scrypt$${salt}$${derived}`;
}

function verifyAdminPassword(password: string, encoded: string) {
	const [, salt, expectedHex] = encoded.split("$");
	if (!salt || !expectedHex || expectedHex.length % 2 !== 0) return false;
	try {
		const actual = scryptSync(password, salt, expectedHex.length / 2);
		const expected = Buffer.from(expectedHex, "hex");
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

function mapAdminUser(row: RowDataPacket): AdminUser {
	return {
		id: Number(row.id),
		username: String(row.username),
		displayName: String(row.display_name || row.username),
		role: row.role === "superadmin" ? "superadmin" : "admin",
		isActive: Boolean(Number(row.is_active)),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
	};
}

function sessionHash(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

function hashCommentPassword(password: string, salt = randomBytes(16).toString("hex")) {
	const derived = scryptSync(password, salt, COMMENT_PASSWORD_KEYLEN).toString("hex");
	return `scrypt$${salt}$${derived}`;
}

function verifyCommentPassword(password: string, encoded: string) {
	const [, salt, expectedHex] = encoded.split("$");
	if (!salt || !expectedHex || expectedHex.length % 2 !== 0) return false;
	try {
		const actual = scryptSync(password, salt, expectedHex.length / 2);
		const expected = Buffer.from(expectedHex, "hex");
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch { return false; }
}

function randomPresetAvatar() {
	return PRESET_AVATAR_PATHS[Math.floor(Math.random() * PRESET_AVATAR_PATHS.length)] ?? PRESET_AVATAR_PATHS[0];
}

function mapCommentUser(row: RowDataPacket) {
	return {
		id: Number(row.id),
		account: String(row.account),
		username: String(row.account),
		nickname: String(row.nickname),
		displayName: String(row.nickname),
		avatar: String(row.avatar_url || randomPresetAvatar()),
		email: row.email ? String(row.email) : null,
		isAdmin: Boolean(Number(row.is_admin)),
		createdAt: String(row.created_at),
		lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
	};
}

type RawPost = RowDataPacket & {
	id: number;
	slug: string;
	filename: string | null;
	title: string;
	excerpt: string;
	content?: string;
	cover: string | null;
	top_image: string | null;
	category_id: number | null;
	category_name: string | null;
	category_slug: string | null;
	categories_json: string | null;
	tags_json: string | null;
	pinned: number;
	views: number;
	words: number;
	minutes: number;
	published_at: string | null;
	updated_at: string;
};

const tagProjection = `
  COALESCE((
    SELECT JSON_ARRAYAGG(JSON_OBJECT('id', t.id, 'name', t.name, 'slug', t.slug))
    FROM post_tags pt
    INNER JOIN tags t ON t.id = pt.tag_id
    WHERE pt.post_id = p.id
  ), JSON_ARRAY()) AS tags_json`;

const categoryProjection = `
  COALESCE((
    SELECT JSON_ARRAYAGG(JSON_OBJECT('id', c2.id, 'name', c2.name, 'slug', c2.slug))
    FROM post_categories pc
    INNER JOIN categories c2 ON c2.id = pc.category_id
    WHERE pc.post_id = p.id
  ), JSON_ARRAY()) AS categories_json`;

function parseTags(value: unknown): Tag[] {
	if (Array.isArray(value)) return value as Tag[];
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as Tag[]) : [];
	} catch {
		return [];
	}
}

function parseCategories(value: unknown): Pick<Category, "name" | "slug">[] {
	if (Array.isArray(value)) return value as Pick<Category, "name" | "slug">[];
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed as Pick<Category, "name" | "slug">[] : [];
	} catch {
		return [];
	}
}

function parseJsonArray<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function parseJsonObject(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function profileText(value: unknown, maximum: number) {
	return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function profileNumber(value: unknown) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function normalizeAuthorProfile(value: unknown): AuthorProfileDetails {
	const profile = parseJsonObject(value);
	const skills = Array.isArray(profile.skills) ? profile.skills.slice(0, 24).flatMap((item): AuthorSkill[] => {
		const skill = parseJsonObject(item);
		const name = profileText(skill.name, 80);
		return name ? [{ name, level: profileNumber(skill.level), description: profileText(skill.description, 240), icon: profileText(skill.icon, 80) || null }] : [];
	}) : [];
	const learningProgress = Array.isArray(profile.learningProgress) ? profile.learningProgress.slice(0, 24).flatMap((item): AuthorLearningProgress[] => {
		const learning = parseJsonObject(item);
		const name = profileText(learning.name, 120);
		return name ? [{ name, progress: profileNumber(learning.progress), description: profileText(learning.description, 240), status: profileText(learning.status, 80) || null }] : [];
	}) : [];
	return {
		headline: profileText(profile.headline, 160),
		introduction: profileText(profile.introduction, 5000),
		location: profileText(profile.location, 120),
		website: profileText(profile.website, 2000) || null,
		skills,
		learningProgress,
	};
}

function mapAuthor(row: RowDataPacket | undefined): AuthorProfile | null {
	if (!row) return null;
	return {
		name: String(row.name),
		bio: String(row.bio),
		avatar: String(row.avatar),
		email: row.email ? String(row.email) : null,
		githubUrl: row.github_url ? String(row.github_url) : null,
		qqUrl: row.qq_url ? String(row.qq_url) : null,
		rssUrl: row.rss_url ? String(row.rss_url) : null,
		links: parseJsonArray<{ label: string; url: string; icon?: string | null }>(row.links),
		profile: normalizeAuthorProfile(row.profile),
	};
}

function mapPost(row: RawPost): Post {
	const categories = parseCategories(row.categories_json);
	const legacyCategory = row.category_name && row.category_slug
		? { id: Number(row.category_id), name: row.category_name, slug: row.category_slug }
		: null;
	const normalizedCategories = categories.length ? categories : (legacyCategory ? [legacyCategory] : []);
	return {
		id: row.id,
		slug: row.slug,
		filename: row.filename || row.slug,
		title: row.title,
		excerpt: row.excerpt,
		content: row.content ?? "",
		cover: row.cover,
		topImage: row.top_image,
		// Keep the legacy category_id projection stable for existing clients;
		// categories carries the complete multi-category association.
		category: legacyCategory ?? normalizedCategories[0] ?? null,
		categories: normalizedCategories,
		tags: parseTags(row.tags_json),
		pinned: Boolean(row.pinned),
		views: row.views,
		words: row.words,
		minutes: row.minutes,
		publishedAt: row.published_at,
		updatedAt: row.updated_at,
	};
}

function summary(post: Post): PostSummary {
	const { content: _content, ...value } = post;
	return value;
}

export type ListPostFilters = {
	page: number;
	pageSize: number;
	category?: string;
	tag?: string;
	query?: string;
};

export async function listPosts(filters: ListPostFilters): Promise<Paginated<PostSummary>> {
	const where = ["p.status = 'published'"];
	const params: Array<string | number> = [];

	if (filters.category) {
		where.push("(c.slug = ? OR c.name = ? OR EXISTS (SELECT 1 FROM post_categories fpc INNER JOIN categories fc ON fc.id = fpc.category_id WHERE fpc.post_id = p.id AND (fc.slug = ? OR fc.name = ?)))");
		params.push(filters.category);
		params.push(filters.category);
		params.push(filters.category);
		params.push(filters.category);
	}
	if (filters.tag) {
		where.push("EXISTS (SELECT 1 FROM post_tags fpt INNER JOIN tags ft ON ft.id = fpt.tag_id WHERE fpt.post_id = p.id AND (ft.slug = ? OR ft.name = ?))");
		params.push(filters.tag);
		params.push(filters.tag);
	}
	if (filters.query) {
		where.push("(p.title LIKE ? OR p.excerpt LIKE ? OR p.content LIKE ?)");
		const value = `%${filters.query}%`;
		params.push(value, value, value);
	}

	const clause = `WHERE ${where.join(" AND ")}`;
	const [[count]] = await pool.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS total FROM posts p LEFT JOIN categories c ON c.id = p.category_id ${clause}`,
		params,
	);
	const total = Number(count.total ?? 0);
	const offset = (filters.page - 1) * filters.pageSize;
	const [rows] = await pool.query<RawPost[]>(
		`SELECT p.id, p.slug, p.filename, p.title, p.excerpt, p.cover, p.top_image, p.category_id, p.pinned, p.views, p.words, p.minutes,
			 p.published_at, p.updated_at, c.name AS category_name, c.slug AS category_slug, ${categoryProjection}, ${tagProjection}
		 FROM posts p LEFT JOIN categories c ON c.id = p.category_id
		 ${clause}
		 ORDER BY p.pinned DESC,
			CASE p.slug
				WHEN 'firefly' THEN 0
				WHEN 'guide/index' THEN 1
				WHEN 'code-examples' THEN 2
				WHEN 'guide/firefly-layout-system' THEN 3
				WHEN 'guide/firefly-wiki-link' THEN 4
				WHEN 'encrypted-demo' THEN 5
				WHEN 'katex-math-example' THEN 6
				WHEN 'mdx-example' THEN 7
				WHEN 'markdown-extended' THEN 8
				WHEN 'markdown-mermaid' THEN 9
				WHEN 'markdown-plantuml' THEN 10
				WHEN 'markdown-tutorial' THEN 11
				WHEN 'video' THEN 12
				ELSE 999
			END ASC,
			p.published_at DESC, p.id DESC
		 LIMIT ? OFFSET ?`,
		[...params, filters.pageSize, offset],
	);

	return {
		items: rows.map((row) => summary(mapPost(row))),
		page: filters.page,
		pageSize: filters.pageSize,
		total,
		totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
	};
}

export async function getPostBySlug(slug: string, countView = true) {
	const [rows] = await pool.query<RawPost[]>(
		`SELECT p.id, p.slug, p.filename, p.title, p.excerpt, p.content, p.cover, p.top_image, p.category_id, p.pinned, p.views, p.words, p.minutes,
			 p.published_at, p.updated_at, c.name AS category_name, c.slug AS category_slug, ${categoryProjection}, ${tagProjection}
		 FROM posts p LEFT JOIN categories c ON c.id = p.category_id
		 WHERE p.slug = ? AND p.status = 'published' LIMIT 1`,
		[slug],
	);
	if (!rows[0]) return null;
	if (countView) {
		await pool.execute("UPDATE posts SET views = views + 1 WHERE id = ?", [rows[0].id]);
		rows[0].views += 1;
	}
	return mapPost(rows[0]);
}

export async function listCategories(): Promise<Category[]> {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT c.id, c.name, c.slug, c.description, COUNT(DISTINCT p.id) AS postCount
		 FROM categories c LEFT JOIN post_categories pc ON pc.category_id = c.id
		 LEFT JOIN posts p ON p.id = pc.post_id AND p.status = 'published'
		 GROUP BY c.id HAVING COUNT(DISTINCT p.id) > 0 ORDER BY postCount DESC, c.name ASC`,
	);
	return rows.map((row) => ({
		id: Number(row.id),
		name: String(row.name),
		slug: String(row.slug),
		description: String(row.description),
		postCount: Number(row.postCount),
	}));
}

export async function listTags(): Promise<Tag[]> {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT t.id, t.name, t.slug, COUNT(p.id) AS postCount
		 FROM tags t LEFT JOIN post_tags pt ON pt.tag_id = t.id
		 LEFT JOIN posts p ON p.id = pt.post_id AND p.status = 'published'
		 GROUP BY t.id HAVING COUNT(p.id) > 0 ORDER BY postCount DESC, t.name ASC`,
	);
	return rows.map((row) => ({
		id: Number(row.id),
		name: String(row.name),
		slug: String(row.slug),
		postCount: Number(row.postCount),
	}));
}

export async function archivePosts() {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT YEAR(p.published_at) AS year, p.id, p.slug, p.title, p.published_at, c.name AS category
		 FROM posts p LEFT JOIN categories c ON c.id = p.category_id
		 WHERE p.status = 'published'
		 ORDER BY CASE p.slug
			WHEN 'firefly' THEN 0
			WHEN 'guide/index' THEN 1
			WHEN 'code-examples' THEN 2
			WHEN 'guide/firefly-layout-system' THEN 3
			WHEN 'guide/firefly-wiki-link' THEN 4
			WHEN 'encrypted-demo' THEN 5
			WHEN 'katex-math-example' THEN 6
			WHEN 'mdx-example' THEN 7
			WHEN 'markdown-extended' THEN 8
			WHEN 'markdown-mermaid' THEN 9
			WHEN 'markdown-plantuml' THEN 10
			WHEN 'markdown-tutorial' THEN 11
			WHEN 'video' THEN 12
			ELSE 999
		 END ASC, p.published_at DESC`,
	);
	return rows.map((row) => ({
		year: Number(row.year),
		id: Number(row.id),
		slug: String(row.slug),
		title: String(row.title),
		publishedAt: String(row.published_at),
		category: row.category ? String(row.category) : null,
	}));
}

export async function siteSummary() {
	const [[postCount]] = await pool.query<RowDataPacket[]>(
		`SELECT
			COUNT(*) AS total,
			COALESCE(SUM(views), 0) AS views,
			COALESCE(SUM(words), 0) AS totalWords,
			MIN(CASE
				WHEN published_at >= '2000-01-01 00:00:00' THEN published_at
				ELSE created_at
			END) AS startDate,
			MAX(GREATEST(COALESCE(published_at, created_at), updated_at, created_at)) AS lastActivityAt
		 FROM posts
		 WHERE status = 'published'`,
	);
	const [[author]] = await pool.query<RowDataPacket[]>("SELECT * FROM authors ORDER BY id LIMIT 1");
	const [dynamics] = await pool.query<RowDataPacket[]>(
		"SELECT id, body, images, published_at AS publishedAt FROM dynamics ORDER BY published_at DESC LIMIT 5",
	);
	const [[siteSetting]] = await pool.query<RowDataPacket[]>(
		"SELECT setting_value AS value FROM site_settings WHERE setting_key = 'site' LIMIT 1",
	);
	let site: Record<string, unknown> & {
		title?: string;
		subtitle?: string;
		description?: string;
		hue?: number;
		siteFavicon?: string;
		videoUploadMaxSizeMb?: number;
		videoAutoTranscodeEnabled?: boolean;
	} = {};
	if (siteSetting?.value) {
		try {
			site = typeof siteSetting.value === "string" ? JSON.parse(siteSetting.value) : siteSetting.value;
		} catch {
			site = {};
		}
	}
	return {
		site,
		stats: {
			posts: Number(postCount.total),
			views: Number(postCount.views),
			totalWords: Number(postCount.totalWords),
			startDate: postCount.startDate ? String(postCount.startDate) : null,
			lastActivityAt: postCount.lastActivityAt ? String(postCount.lastActivityAt) : null,
		},
		author: mapAuthor(author),
		dynamics: dynamics.map((row) => ({
			id: Number(row.id),
			body: String(row.body),
			images: parseJsonArray<string>(row.images),
			publishedAt: String(row.publishedAt),
		})),
	};
}

export type CommentPrincipal = ReturnType<typeof mapCommentUser>;

function mapPublicComment(row: RowDataPacket) {
	return {
		id: Number(row.id),
		postId: row.post_id === null || row.post_id === undefined ? null : Number(row.post_id),
		parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
		body: String(row.body),
		authorName: String(row.author_name),
		authorEmail: row.author_email ? String(row.author_email) : null,
		avatar: String(row.author_avatar || row.avatar_url || randomPresetAvatar()),
		createdAt: String(row.created_at),
		ipLocation: row.ip_location ? String(row.ip_location) : row.client_ip ? String(row.client_ip) : null,
		ip: row.client_ip ? String(row.client_ip) : null,
		device: row.client_device ? String(row.client_device) : null,
		browser: row.client_browser ? String(row.client_browser) : null,
		isAdmin: Boolean(Number(row.is_admin)),
		badge: Boolean(Number(row.is_admin)) ? "管理员" : null,
		images: parseJsonArray<string>(row.images),
		status: String(row.status),
	};
}

export async function getComments(postId: number) {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT c.id, c.post_id, c.parent_id, c.author_name, c.author_email, c.author_avatar, c.body,
		 c.created_at, c.status, c.client_ip, c.ip_location, c.client_device, c.client_browser, c.images,
		 COALESCE(c.is_admin, u.is_admin, 0) AS is_admin, u.avatar_url
		 FROM comments c LEFT JOIN comment_users u ON u.id = c.user_id
		 WHERE c.post_id = ? AND c.status = 'approved' ORDER BY c.created_at ASC, c.id ASC`,
		[postId],
	);
	const flat = rows.map(mapPublicComment);
	type PublicComment = ReturnType<typeof mapPublicComment> & { children: PublicComment[] };
	const byId = new Map<number, PublicComment>();
	const roots: PublicComment[] = [];
	for (const item of flat) { byId.set(item.id, { ...item, children: [] }); }
	for (const item of flat) {
		const mapped = byId.get(item.id);
		if (!mapped) continue;
		const parent = item.parentId ? byId.get(item.parentId) : undefined;
		if (parent) parent.children.push(mapped);
		else roots.push(mapped);
	}
	return roots;
}

export async function createComment(input: {
	postId: number;
	userId?: number | null;
	authorName: string;
	authorEmail?: string;
	authorAvatar?: string;
	body: string;
	parentId?: number | null;
	images?: string[];
	clientIp?: string;
	ipLocation?: string;
	clientBrowser?: string;
	clientOs?: string;
	clientDevice?: string;
	clientUa?: string;
	status?: "pending" | "approved" | "spam";
	isAdmin?: boolean;
	stickerId?: number | null;
	personalStickerId?: number | null;
}) {
	const [result] = await pool.execute<ResultSetHeader>(
		`INSERT INTO comments
		 (post_id, user_id, parent_id, author_name, author_email, author_avatar, body, status,
		  client_ip, ip_location, client_browser, client_os, client_device, client_ua, images,
		  is_admin, sticker_id, personal_sticker_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[input.postId, input.userId ?? null, input.parentId ?? null, input.authorName, input.authorEmail ?? null,
		 input.authorAvatar ?? randomPresetAvatar(), input.body, input.status ?? "pending", input.clientIp ?? "",
		 input.ipLocation ?? "", input.clientBrowser ?? "", input.clientOs ?? "", input.clientDevice ?? "",
		 input.clientUa ?? "", JSON.stringify((input.images ?? []).slice(0, 3)), Boolean(input.isAdmin),
		 input.stickerId ?? null, input.personalStickerId ?? null],
	);
	void notifyCommentAdmins(input.status === "pending" ? "有新的待审核评论" : "有新的评论", [
		`文章编号：${input.postId}`,
		`评论者：${input.authorName}`,
		`内容：${input.body.slice(0, 500)}`,
	], input.status === "pending" ? "notifyPendingComment" : "notifyNewComment");
	return result.insertId;
}

export async function getCommentSettings() {
	const value = await getSiteSetting("comments");
	const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const avatarPresets = Array.isArray(source.avatarPresets) && source.avatarPresets.length
		? source.avatarPresets.map(String).filter((item) => item.length <= 512)
		: [...PRESET_AVATAR_PATHS];
	return {
		commentsEnabled: source.commentsEnabled !== false,
		commentRegistrationEnabled: source.commentRegistrationEnabled !== false,
		commentModerationEnabled: source.commentModerationEnabled === true || source.requireModeration === true,
		allowAnonymous: source.allowAnonymous === true,
		emailRegistrationEnabled: source.emailRegistrationEnabled === true,
		avatarPresets,
	};
}

export async function authenticateCommentUser(accountOrEmail: string, password: string) {
	const login = accountOrEmail.trim().toLowerCase();
	const [[row]] = await pool.query<RowDataPacket[]>(
		"SELECT * FROM comment_users WHERE (LOWER(account) = ? OR LOWER(email) = ?) AND is_active <> 0 LIMIT 1",
		[login, login],
	);
	if (!row || !verifyCommentPassword(password, String(row.password_hash))) return null;
	const user = mapCommentUser(row);
	await pool.execute("UPDATE comment_users SET last_login_at = NOW() WHERE id = ?", [user.id]);
	const token = randomBytes(32).toString("base64url");
	await pool.execute(`INSERT INTO comment_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ${COMMENT_SESSION_DAYS} DAY))`, [sessionHash(token), user.id]);
	return { token, user: { ...user, lastLoginAt: new Date().toISOString() }, expiresIn: `${COMMENT_SESSION_DAYS}d` };
}

export async function getCommentSession(token: string): Promise<CommentPrincipal | null> {
	if (!token.trim()) return null;
	const [[row]] = await pool.query<RowDataPacket[]>(
		"SELECT u.* FROM comment_sessions s INNER JOIN comment_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.is_active <> 0 LIMIT 1",
		[sessionHash(token)],
	);
	if (!row) return null;
	await pool.execute("UPDATE comment_sessions SET last_used_at = NOW() WHERE token_hash = ?", [sessionHash(token)]);
	return mapCommentUser(row);
}

export async function revokeCommentSession(token: string) {
	if (token.trim()) await pool.execute("DELETE FROM comment_sessions WHERE token_hash = ?", [sessionHash(token)]);
}

export async function registerCommentUser(input: {
	account: string;
	nickname: string;
	password: string;
	email?: string | null;
	avatar?: string | null;
	avatarSource?: "preset" | "upload" | "url";
	registrationIp?: string;
}) {
	const avatar = input.avatar?.trim() || randomPresetAvatar();
	const [result] = await pool.execute<ResultSetHeader>(
		"INSERT INTO comment_users (account, nickname, email, password_hash, avatar_url, avatar_source, registration_ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[input.account.trim(), input.nickname.trim(), input.email?.trim().toLowerCase() || null, hashCommentPassword(input.password), avatar, input.avatarSource ?? "preset", input.registrationIp ?? ""],
	);
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM comment_users WHERE id = ? LIMIT 1", [result.insertId]);
	const user = mapCommentUser(row);
	void notifyCommentAdmins("有新用户注册", [`账号：${user.account}`, `昵称：${user.nickname}`, `邮箱：${user.email ?? "未填写"}`], "notifyNewUser");
	return user;
}

export async function requestCommentEmailCode(email: string) {
	const normalized = email.trim().toLowerCase();
	const code = String(Math.floor(100000 + Math.random() * 900000));
	const hash = createHash("sha256").update(code).digest("hex");
	await pool.execute(
		`INSERT INTO comment_email_codes (email, code_hash, attempts, sent_at, expires_at)
		 VALUES (?, ?, 0, NOW(), DATE_ADD(NOW(), INTERVAL ${COMMENT_EMAIL_CODE_TTL_MINUTES} MINUTE))
		 ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), attempts = 0, sent_at = NOW(), expires_at = VALUES(expires_at)`,
		[normalized, hash],
	);
	const settings = await commentMailSettings();
	let sent = false;
	try { sent = await sendCommentMail(normalized, "注册验证码", `你的注册验证码是 ${code}，${COMMENT_EMAIL_CODE_TTL_MINUTES} 分钟内有效。请勿将验证码提供给他人。`); }
	catch (error) { console.warn("[comment-mail] verification code failed:", error instanceof Error ? error.message : error); }
	return { ok: true, sent, expiresInSeconds: COMMENT_EMAIL_CODE_TTL_MINUTES * 60, debugCode: !sent && process.env.NODE_ENV !== "production" ? code : undefined, mailConfigured: Boolean(settings.host && settings.user && settings.password && settings.from) };
}

export async function verifyCommentEmailCode(email: string, code: string) {
	const normalized = email.trim().toLowerCase();
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT code_hash, attempts, expires_at FROM comment_email_codes WHERE email = ? LIMIT 1", [normalized]);
	if (!row || Number(row.attempts) >= 5 || new Date(String(row.expires_at)).getTime() <= Date.now()) return false;
	const expected = createHash("sha256").update(code.trim()).digest("hex");
	const valid = expected.length === String(row.code_hash).length && timingSafeEqual(Buffer.from(expected), Buffer.from(String(row.code_hash)));
	if (!valid) await pool.execute("UPDATE comment_email_codes SET attempts = attempts + 1 WHERE email = ?", [normalized]);
	else await pool.execute("DELETE FROM comment_email_codes WHERE email = ?", [normalized]);
	return valid;
}

export async function listCommentStickers(userId?: number | null) {
	const [shared] = await pool.query<RowDataPacket[]>("SELECT id, name, image_url AS url, NULL AS owner_id FROM comment_stickers WHERE is_active <> 0 ORDER BY sort_order ASC, id ASC");
	if (!userId) return shared.map((row) => ({ id: Number(row.id), name: String(row.name), url: String(row.url), ownerId: null }));
	const [personal] = await pool.query<RowDataPacket[]>("SELECT id, name, image_url AS url, user_id AS owner_id FROM comment_user_stickers WHERE user_id = ? ORDER BY created_at DESC, id DESC", [userId]);
	return [...personal, ...shared].map((row) => ({ id: Number(row.id), name: String(row.name), url: String(row.url), ownerId: row.owner_id === null ? null : Number(row.owner_id) }));
}

export async function createUserSticker(input: { userId: number; name: string; imageUrl: string; mimeType?: string; byteSize: number }) {
	if (!Number.isFinite(input.byteSize) || input.byteSize < 0 || input.byteSize > USER_SPACE_LIMIT_BYTES) throw new Error("文件大小无效");
	const byteSize = Math.floor(input.byteSize);
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const usage = await lockedUserUsage(connection, input.userId);
		if (usage.total + byteSize > USER_SPACE_LIMIT_BYTES) throw new Error("用户共享空间不足（上限 30MB）");
		const [result] = await connection.execute<ResultSetHeader>("INSERT INTO comment_user_stickers (user_id, name, image_url, mime_type, byte_size) VALUES (?, ?, ?, ?, ?)", [input.userId, input.name.slice(0, 120), input.imageUrl, input.mimeType ?? "image/png", byteSize]);
		await connection.commit();
		return { id: Number(result.insertId), name: input.name, url: input.imageUrl, ownerId: input.userId };
	} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

function mapUserStorageItem(row: RowDataPacket): UserStorageItem {
	const token = row.public_token ? String(row.public_token) : null;
	const publicUrl = token ? `/api/public/resources/${encodeURIComponent(token)}` : null;
	const storageKey = String(row.storage_key ?? "");
	const ownerUrl = storageKey ? `/api/user/storage/${Number(row.id)}/file` : String(row.storage_url);
	return { id: Number(row.id), userId: row.user_id === undefined ? undefined : Number(row.user_id), kind: String(row.kind), name: String(row.name ?? ""), url: Boolean(Number(row.is_public)) && publicUrl ? publicUrl : ownerUrl, storageKey, mimeType: String(row.mime_type ?? "application/octet-stream"), byteSize: Number(row.byte_size ?? 0), isPublic: Boolean(Number(row.is_public)), publicToken: token, publicUrl, viewCount: Number(row.view_count ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function mapUserClipboard(row: RowDataPacket): UserClipboard {
	const token = row.public_token ? String(row.public_token) : null;
	return { id: Number(row.id), userId: row.user_id === undefined ? undefined : Number(row.user_id), title: String(row.title ?? ""), content: row.content === undefined ? undefined : String(row.content ?? ""), byteSize: Number(row.byte_size ?? 0), isPublic: Boolean(Number(row.is_public)), publicToken: token, publicUrl: token ? `/api/public/resources/${encodeURIComponent(token)}` : null, viewCount: Number(row.view_count ?? 0), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

async function lockedUserUsage(connection: Awaited<ReturnType<typeof pool.getConnection>>, userId: number) {
	await connection.query<RowDataPacket[]>("SELECT id FROM comment_users WHERE id = ? FOR UPDATE", [userId]);
	const [[row]] = await connection.query<RowDataPacket[]>(`SELECT
		COALESCE((SELECT SUM(byte_size) FROM user_storage_items WHERE user_id = ?), 0) AS images,
		COALESCE((SELECT SUM(byte_size) FROM user_clipboards WHERE user_id = ?), 0) AS clipboards,
		COALESCE((SELECT SUM(byte_size) FROM comment_user_stickers WHERE user_id = ?), 0) AS stickers`, [userId, userId, userId]);
	return { images: Number(row?.images ?? 0), clipboards: Number(row?.clipboards ?? 0), stickers: Number(row?.stickers ?? 0), total: Number(row?.images ?? 0) + Number(row?.clipboards ?? 0) + Number(row?.stickers ?? 0) };
}

export async function getUserSpace(userId: number) {
	const [[row]] = await pool.query<RowDataPacket[]>(`SELECT
		COALESCE((SELECT SUM(byte_size) FROM user_storage_items WHERE user_id = ?), 0) AS images,
		COALESCE((SELECT SUM(byte_size) FROM user_storage_items WHERE user_id = ? AND kind = 'image_host'), 0) AS imageHost,
		COALESCE((SELECT SUM(byte_size) FROM user_storage_items WHERE user_id = ? AND kind = 'comment_image'), 0) AS commentImages,
		COALESCE((SELECT SUM(byte_size) FROM user_storage_items WHERE user_id = ? AND kind = 'avatar'), 0) AS avatars,
		COALESCE((SELECT SUM(byte_size) FROM user_clipboards WHERE user_id = ?), 0) AS clipboards,
		COALESCE((SELECT SUM(byte_size) FROM comment_user_stickers WHERE user_id = ?), 0) AS stickers`, [userId, userId, userId, userId, userId, userId]);
	const categories = {
		images: Number(row?.images ?? 0),
		imageHost: Number(row?.imageHost ?? 0),
		commentImages: Number(row?.commentImages ?? 0),
		avatars: Number(row?.avatars ?? 0),
		clipboards: Number(row?.clipboards ?? 0),
		stickers: Number(row?.stickers ?? 0),
	};
	const usedBytes = categories.images + categories.clipboards + categories.stickers;
	return { limitBytes: USER_SPACE_LIMIT_BYTES, usedBytes, remainingBytes: Math.max(0, USER_SPACE_LIMIT_BYTES - usedBytes), categories };
}

export async function createUserStorageItem(input: { userId: number; kind?: string; name?: string; url: string; storageKey?: string; mimeType?: string; byteSize: number; isPublic?: boolean }) {
	if (!Number.isFinite(input.byteSize) || input.byteSize < 0 || input.byteSize > USER_SPACE_LIMIT_BYTES) throw new Error("文件大小无效");
	const byteSize = Math.floor(input.byteSize);
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const usage = await lockedUserUsage(connection, input.userId);
		if (usage.total + byteSize > USER_SPACE_LIMIT_BYTES) throw new Error("用户共享空间不足（上限 30MB）");
		const token = input.isPublic ? randomBytes(32).toString("base64url") : null;
		const [result] = await connection.execute<ResultSetHeader>("INSERT INTO user_storage_items (user_id, kind, name, storage_url, storage_key, mime_type, byte_size, is_public, public_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [input.userId, input.kind ?? "image_host", (input.name ?? "").slice(0, 255), input.url, input.storageKey ?? "", input.mimeType ?? "application/octet-stream", byteSize, Boolean(input.isPublic), token]);
		await connection.commit();
		const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM user_storage_items WHERE id = ?", [result.insertId]);
		return row ? mapUserStorageItem(row) : null;
	} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function listUserStorageItems(userId: number) {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM user_storage_items WHERE user_id = ? ORDER BY created_at DESC, id DESC", [userId]);
	return rows.map(mapUserStorageItem);
}

export async function getUserStorageItem(userId: number, id: number) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM user_storage_items WHERE id = ? AND user_id = ? LIMIT 1", [id, userId]);
	return row ? mapUserStorageItem(row) : null;
}

export async function updateUserStorageVisibility(userId: number, id: number, isPublic: boolean) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const [[row]] = await connection.query<RowDataPacket[]>("SELECT * FROM user_storage_items WHERE id = ? AND user_id = ? FOR UPDATE", [id, userId]);
		if (!row) { await connection.rollback(); return null; }
		const token = isPublic ? (row.public_token ? String(row.public_token) : randomBytes(32).toString("base64url")) : null;
		await connection.execute("UPDATE user_storage_items SET is_public = ?, public_token = ? WHERE id = ? AND user_id = ?", [isPublic, token, id, userId]);
		await connection.commit();
		return mapUserStorageItem({ ...row, is_public: isPublic ? 1 : 0, public_token: token });
	} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function deleteUserStorageItem(userId: number, id: number) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT storage_url, storage_key FROM user_storage_items WHERE id = ? AND user_id = ?", [id, userId]);
	if (!row) return null;
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM user_storage_items WHERE id = ? AND user_id = ?", [id, userId]);
	return result.affectedRows ? { url: String(row.storage_url), storageKey: String(row.storage_key ?? "") } : null;
}

export async function createUserClipboard(input: { userId: number; title?: string; content: string; isPublic?: boolean }) {
	const byteSize = Buffer.byteLength(input.content, "utf8");
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const usage = await lockedUserUsage(connection, input.userId);
		if (usage.total + byteSize > USER_SPACE_LIMIT_BYTES) throw new Error("用户共享空间不足（上限 30MB）");
		const token = input.isPublic ? randomBytes(32).toString("base64url") : null;
		const [result] = await connection.execute<ResultSetHeader>("INSERT INTO user_clipboards (user_id, title, content, byte_size, is_public, public_token) VALUES (?, ?, ?, ?, ?, ?)", [input.userId, (input.title ?? "未命名剪贴板").slice(0, 255), input.content, byteSize, Boolean(input.isPublic), token]);
		await connection.commit();
		const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM user_clipboards WHERE id = ?", [result.insertId]);
		return row ? mapUserClipboard(row) : null;
	} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function listUserClipboards(userId: number) {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT id, user_id, title, byte_size, is_public, public_token, view_count, created_at, updated_at FROM user_clipboards WHERE user_id = ? ORDER BY updated_at DESC, id DESC", [userId]);
	return rows.map(mapUserClipboard);
}

export async function getUserClipboard(userId: number, id: number) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM user_clipboards WHERE id = ? AND user_id = ? LIMIT 1", [id, userId]);
	return row ? mapUserClipboard(row) : null;
}

export async function updateUserClipboard(userId: number, id: number, input: { title?: string; content?: string; isPublic?: boolean }) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const usage = await lockedUserUsage(connection, userId);
		const [[row]] = await connection.query<RowDataPacket[]>("SELECT * FROM user_clipboards WHERE id = ? AND user_id = ? FOR UPDATE", [id, userId]);
		if (!row) { await connection.rollback(); return null; }
		const existing = mapUserClipboard(row);
		const content = input.content === undefined ? String(existing.content ?? "") : input.content;
		const byteSize = Buffer.byteLength(content, "utf8");
		if (usage.total - existing.byteSize + byteSize > USER_SPACE_LIMIT_BYTES) throw new Error("用户共享空间不足（上限 30MB）");
		const token = input.isPublic === undefined ? existing.publicToken ?? null : input.isPublic ? existing.publicToken ?? randomBytes(32).toString("base64url") : null;
		await connection.execute("UPDATE user_clipboards SET title = ?, content = ?, byte_size = ?, is_public = ?, public_token = ? WHERE id = ? AND user_id = ?", [input.title === undefined ? existing.title : input.title.slice(0, 255), content, byteSize, input.isPublic === undefined ? existing.isPublic : input.isPublic, token, id, userId]);
		await connection.commit();
		return getUserClipboard(userId, id);
	} catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

export async function deleteUserClipboard(userId: number, id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM user_clipboards WHERE id = ? AND user_id = ?", [id, userId]);
	return result.affectedRows > 0;
}

export async function getPublicUserResource(token: string) {
	const [[image]] = await pool.query<RowDataPacket[]>("SELECT * FROM user_storage_items WHERE public_token = ? AND is_public <> 0 LIMIT 1", [token]);
	if (image) { const [result] = await pool.execute<ResultSetHeader>("UPDATE user_storage_items SET view_count = view_count + 1 WHERE id = ? AND public_token = ? AND is_public <> 0", [image.id, token]); if (result.affectedRows) return { type: "image" as const, item: { ...mapUserStorageItem(image), viewCount: Number(image.view_count ?? 0) + 1 } }; }
	const [[clipboard]] = await pool.query<RowDataPacket[]>("SELECT * FROM user_clipboards WHERE public_token = ? AND is_public <> 0 LIMIT 1", [token]);
	if (clipboard) { const [result] = await pool.execute<ResultSetHeader>("UPDATE user_clipboards SET view_count = view_count + 1 WHERE id = ? AND public_token = ? AND is_public <> 0", [clipboard.id, token]); if (result.affectedRows) return { type: "clipboard" as const, item: { ...mapUserClipboard(clipboard), viewCount: Number(clipboard.view_count ?? 0) + 1 } }; }
	return null;
}

export async function listAdminUserSpace() {
	const [users] = await pool.query<RowDataPacket[]>("SELECT id, account, nickname, email, avatar_url AS avatar, is_active, created_at FROM comment_users ORDER BY created_at DESC");
	return Promise.all(users.map(async (user) => ({ id: Number(user.id), account: String(user.account), nickname: String(user.nickname), email: user.email ? String(user.email) : null, avatar: String(user.avatar ?? ""), isActive: Boolean(Number(user.is_active)), createdAt: String(user.created_at), space: await getUserSpace(Number(user.id)) })));
}

export async function listAdminUserResources(userId: number) {
	const [items] = await pool.query<RowDataPacket[]>("SELECT * FROM user_storage_items WHERE user_id = ? ORDER BY created_at DESC, id DESC", [userId]);
	const [clipboards] = await pool.query<RowDataPacket[]>("SELECT * FROM user_clipboards WHERE user_id = ? ORDER BY updated_at DESC, id DESC", [userId]);
	const [stickers] = await pool.query<RowDataPacket[]>("SELECT id, user_id, name, image_url AS url, mime_type AS mimeType, byte_size AS byteSize, created_at AS createdAt FROM comment_user_stickers WHERE user_id = ? ORDER BY created_at DESC, id DESC", [userId]);
	return { space: await getUserSpace(userId), items: items.map(mapUserStorageItem), clipboards: clipboards.map(mapUserClipboard), stickers: stickers.map((row) => ({ id: Number(row.id), userId: Number(row.user_id), name: String(row.name), url: String(row.url), mimeType: String(row.mimeType), byteSize: Number(row.byteSize), createdAt: String(row.createdAt) })) };
}

export async function deleteUserSticker(userId: number, id: number) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT image_url FROM comment_user_stickers WHERE id = ? AND user_id = ? LIMIT 1", [id, userId]);
	if (!row) return null;
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM comment_user_stickers WHERE id = ? AND user_id = ?", [id, userId]);
	return result.affectedRows ? { url: String(row.image_url) } : null;
}

export async function getCommentUserById(id: number) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM comment_users WHERE id = ? LIMIT 1", [id]);
	return row ? mapCommentUser(row) : null;
}

export async function verifyCommentUserPassword(id: number, password: string) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT password_hash FROM comment_users WHERE id = ? LIMIT 1", [id]);
	return Boolean(row && verifyCommentPassword(password, String(row.password_hash)));
}

export async function listAdminCommentUsers() {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT u.id, u.account, u.nickname, u.email, u.avatar_url AS avatar, u.is_active AS isActive, u.created_at AS createdAt, u.last_login_at AS lastLoginAt, COUNT(c.id) AS commentCount FROM comment_users u LEFT JOIN comments c ON c.user_id = u.id GROUP BY u.id ORDER BY u.created_at DESC");
	return rows.map((row) => { const count = Number(row.commentCount); return { id: Number(row.id), account: String(row.account), nickname: String(row.nickname), email: row.email ? String(row.email) : null, avatar: String(row.avatar), isActive: Boolean(Number(row.isActive)), status: Number(row.isActive) ? "active" : "disabled", createdAt: String(row.createdAt), lastLoginAt: row.lastLoginAt ? String(row.lastLoginAt) : null, commentCount: count, commentsCount: count }; });
}

export async function updateCommentUser(id: number, input: { account?: string; nickname?: string; email?: string | null; avatar?: string | null; password?: string; isActive?: boolean; isAdmin?: boolean }) {
	const fields: string[] = [];
	const values: Array<string | number | boolean | null> = [];
	if (input.account !== undefined) { fields.push("account = ?"); values.push(input.account.trim()); }
	if (input.nickname !== undefined) { fields.push("nickname = ?"); values.push(input.nickname.trim()); }
	if (input.email !== undefined) { fields.push("email = ?"); values.push(input.email?.trim().toLowerCase() || null); }
	if (input.avatar !== undefined) { fields.push("avatar_url = ?"); values.push(input.avatar?.trim() || randomPresetAvatar()); }
	if (input.password !== undefined) { fields.push("password_hash = ?"); values.push(hashCommentPassword(input.password)); }
	if (input.isActive !== undefined) { fields.push("is_active = ?"); values.push(input.isActive); }
	if (input.isAdmin !== undefined) { fields.push("is_admin = ?"); values.push(input.isAdmin); }
	if (!fields.length) return false;
	values.push(id);
	const [result] = await pool.execute<ResultSetHeader>(`UPDATE comment_users SET ${fields.join(", ")} WHERE id = ?`, values);
	if (input.password !== undefined || input.isActive === false) await pool.execute("DELETE FROM comment_sessions WHERE user_id = ?", [id]);
	return result.affectedRows > 0;
}

export async function deleteCommentUser(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM comment_users WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

export async function resetCommentUserPassword(id: number, password: string) {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE comment_users SET password_hash = ? WHERE id = ?", [hashCommentPassword(password), id]);
	if (result.affectedRows) await pool.execute("DELETE FROM comment_sessions WHERE user_id = ?", [id]);
	return result.affectedRows > 0;
}

export async function createSharedCommentSticker(input: { name: string; imageUrl: string; mimeType?: string; byteSize?: number }) {
	const [result] = await pool.execute<ResultSetHeader>("INSERT INTO comment_stickers (name, image_url, mime_type, byte_size) VALUES (?, ?, ?, ?)", [input.name.trim(), input.imageUrl, input.mimeType ?? "image/png", input.byteSize ?? 0]);
	return Number(result.insertId);
}

export async function deleteSharedCommentSticker(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM comment_stickers WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

export async function createPost(input: {
	slug: string;
	filename?: string | null;
	title: string;
	excerpt: string;
	content: string;
	cover?: string | null;
	topImage?: string | null;
	categorySlug?: string | null;
	categoryName?: string | null;
	categoryNames?: string[];
	tagSlugs?: string[];
	tagNames?: string[];
	publishedAt?: string | null;
	pinned?: boolean;
	status?: "draft" | "published";
}) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const categoryIds = await resolveCategoryIds(connection, input.categoryNames, input.categoryName, input.categorySlug);
		const categoryId = categoryIds[0] ?? null;
		const words = input.content.trim() ? input.content.trim().split(/\s+/u).length : 0;
		const status = input.status ?? "published";
		const [result] = await connection.execute<ResultSetHeader>(
			`INSERT INTO posts (slug, filename, title, excerpt, content, cover, top_image, category_id, status, pinned, words, minutes, published_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[input.slug, input.filename?.trim() || input.slug, input.title, input.excerpt, input.content, input.cover ?? null, input.topImage ?? null, categoryId, status, Boolean(input.pinned), words, Math.max(1, Math.ceil(words / 200)), postPublishedDate(input.publishedAt, status)],
		);
		await replacePostCategories(connection, result.insertId, categoryIds);
		await replacePostTags(connection, result.insertId, input.tagSlugs, input.tagNames);
		await connection.commit();
		return result.insertId;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function deletePost(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM posts WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

type AdminPostInput = {
	slug: string;
	filename?: string | null;
	title: string;
	excerpt: string;
	content: string;
	cover?: string | null;
	topImage?: string | null;
	categorySlug?: string | null;
	categoryName?: string | null;
	categoryNames?: string[];
	tagSlugs?: string[];
	tagNames?: string[];
	publishedAt?: string | null;
	pinned?: boolean;
	status?: "draft" | "published";
};

function mapAdminPost(row: RawPost & { status?: string }) {
	return { ...mapPost(row), status: row.status === "draft" ? "draft" : "published" };
}

export async function listAdminPosts(filters: { page: number; pageSize: number; status?: string; query?: string }) {
	const where = ["1 = 1"];
	const params: Array<string | number> = [];
	if (filters.status === "draft" || filters.status === "published") {
		where.push("p.status = ?");
		params.push(filters.status);
	}
	if (filters.query) {
		where.push("(p.title LIKE ? OR p.slug LIKE ? OR p.excerpt LIKE ?)");
		const value = `%${filters.query}%`;
		params.push(value, value, value);
	}
	const clause = `WHERE ${where.join(" AND ")}`;
	const [[count]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM posts p ${clause}`, params);
	const offset = (filters.page - 1) * filters.pageSize;
	const [rows] = await pool.query<(RawPost & { status: string })[]>(
		`SELECT p.id, p.slug, p.filename, p.title, p.excerpt, p.content, p.cover, p.top_image, p.category_id, p.status, p.pinned, p.views, p.words, p.minutes,
			 p.published_at, p.updated_at, c.name AS category_name, c.slug AS category_slug, ${categoryProjection}, ${tagProjection}
		 FROM posts p LEFT JOIN categories c ON c.id = p.category_id ${clause}
		 ORDER BY p.pinned DESC, p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
		[...params, filters.pageSize, offset],
	);
	return {
		items: rows.map(mapAdminPost),
		page: filters.page,
		pageSize: filters.pageSize,
		total: Number(count.total ?? 0),
		totalPages: Math.max(1, Math.ceil(Number(count.total ?? 0) / filters.pageSize)),
	};
}

export async function getAdminPost(id: number) {
	const [rows] = await pool.query<(RawPost & { status: string })[]>(
		`SELECT p.id, p.slug, p.filename, p.title, p.excerpt, p.content, p.cover, p.top_image, p.category_id, p.status, p.pinned, p.views, p.words, p.minutes,
			 p.published_at, p.updated_at, c.name AS category_name, c.slug AS category_slug, ${categoryProjection}, ${tagProjection}
		 FROM posts p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? LIMIT 1`,
		[id],
	);
	return rows[0] ? mapAdminPost(rows[0]) : null;
}

type TaxonomyConnection = Awaited<ReturnType<typeof pool.getConnection>>;

function taxonomySlug(value: string) {
	const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 88);
	if (normalized) return normalized;
	const bytes = Buffer.from(value.trim(), "utf8").toString("hex").slice(0, 88);
	return `item-${bytes || "untitled"}`.slice(0, 100);
}

async function resolveTaxonomyId(connection: TaxonomyConnection, table: "categories" | "tags", rawValue: string | null | undefined) {
	const value = String(rawValue ?? "").trim();
	if (!value) return null;
	const [existing] = await connection.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE slug = ? OR name = ? ORDER BY (name = ?) DESC LIMIT 1`, [value, value, value]);
	if (existing[0]) return Number(existing[0].id);
	const name = value.slice(0, 80);
	let slug = taxonomySlug(value);
	const [slugRows] = await connection.query<RowDataPacket[]>(`SELECT id, name FROM ${table} WHERE slug = ? LIMIT 1`, [slug]);
	if (slugRows[0] && String(slugRows[0].name) !== name) {
		const suffix = Buffer.from(value, "utf8").toString("hex").slice(-10);
		slug = `${slug.slice(0, Math.max(1, 89 - suffix.length))}-${suffix}`.slice(0, 100);
	}
	try {
		const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO ${table} (name, slug${table === "categories" ? ", description" : ""}) VALUES (?, ?${table === "categories" ? ", ''" : ""}) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [name, slug]);
		return Number(result.insertId);
	} catch (error) {
		const [retry] = await connection.query<RowDataPacket[]>(`SELECT id FROM ${table} WHERE slug = ? OR name = ? LIMIT 1`, [slug, name]);
		if (retry[0]) return Number(retry[0].id);
		throw error;
	}
}

async function resolveCategoryId(connection: TaxonomyConnection, value: string | null | undefined) {
	return resolveTaxonomyId(connection, "categories", value);
}

function normalizePostDate(value: string | Date | null | undefined): Date | null {
	if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error("Invalid post date");
		return value;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("Invalid post date");
	return date;
}

function splitTaxonomyValues(values: Array<string | null | undefined>) {
	return [...new Set(values.flatMap((value) => String(value ?? "").split(/[,，]/u).map((item) => item.trim()).filter(Boolean)))];
}

async function resolveCategoryIds(connection: TaxonomyConnection, categoryNames?: string[], categoryName?: string | null, categorySlug?: string | null) {
	// Prefer the new multi-value field when present. Legacy callers retain the
	// original categoryName-over-categorySlug precedence.
	const values = categoryNames !== undefined
		? splitTaxonomyValues(categoryNames)
		: splitTaxonomyValues([categoryName?.trim() || categorySlug]);
	const ids: number[] = [];
	for (const value of values) {
		const id = await resolveCategoryId(connection, value);
		if (id !== null) ids.push(id);
	}
	return ids;
}

async function resolveTagIds(connection: TaxonomyConnection, tagSlugs?: string[], tagNames?: string[]) {
	const values = [...(tagNames ?? []), ...(tagSlugs ?? [])].map((item) => String(item).trim()).filter(Boolean);
	const unique = [...new Set(values)];
	const ids: number[] = [];
	for (const value of unique) {
		const id = await resolveTaxonomyId(connection, "tags", value);
		if (id !== null) ids.push(id);
	}
	return ids;
}

async function replacePostTags(connection: TaxonomyConnection, postId: number, tagSlugs?: string[], tagNames?: string[]) {
	await connection.execute("DELETE FROM post_tags WHERE post_id = ?", [postId]);
	const ids = await resolveTagIds(connection, tagSlugs, tagNames);
	for (const id of ids) await connection.execute("INSERT IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)", [postId, id]);
}

async function replacePostCategories(connection: TaxonomyConnection, postId: number, categoryIds: number[]) {
	await connection.execute("DELETE FROM post_categories WHERE post_id = ?", [postId]);
	for (const id of categoryIds) await connection.execute("INSERT IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)", [postId, id]);
}

// mysql DATETIME has no timezone component. Passing the ISO string from the
// admin form directly makes MySQL reject the value because of its trailing
// offset; let mysql2 format a validated Date instance for the configured
// connection timezone instead.
function postPublishedDate(value: string | null | undefined, status: "draft" | "published") {
	return normalizePostDate(value) ?? (status === "published" ? new Date() : null);
}

export async function updatePost(id: number, input: AdminPostInput) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const [existing] = await connection.query<RowDataPacket[]>("SELECT id FROM posts WHERE id = ? FOR UPDATE", [id]);
		if (!existing[0]) {
			await connection.rollback();
			return null;
		}
		const categoryIds = await resolveCategoryIds(connection, input.categoryNames, input.categoryName, input.categorySlug);
		const categoryId = categoryIds[0] ?? null;
		const words = input.content.trim() ? input.content.trim().split(/\s+/u).length : 0;
		const status = input.status ?? "published";
		await connection.execute(
			`UPDATE posts SET slug = ?, filename = ?, title = ?, excerpt = ?, content = ?, cover = ?, top_image = ?, category_id = ?, status = ?, pinned = ?, words = ?, minutes = ?, published_at = ? WHERE id = ?`,
			[input.slug, input.filename?.trim() || input.slug, input.title, input.excerpt, input.content, input.cover ?? null, input.topImage ?? null, categoryId, status, Boolean(input.pinned), words, Math.max(1, Math.ceil(words / 200)), postPublishedDate(input.publishedAt, status), id],
		);
		await replacePostCategories(connection, id, categoryIds);
		await replacePostTags(connection, id, input.tagSlugs, input.tagNames);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
	return getAdminPost(id);
}

export async function listAllTags(): Promise<Tag[]> {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT t.id, t.name, t.slug, COUNT(pt.post_id) AS postCount FROM tags t LEFT JOIN post_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY t.name ASC");
	return rows.map((row) => ({ id: Number(row.id), name: String(row.name), slug: String(row.slug), postCount: Number(row.postCount) }));
}

export async function listAllCategories(): Promise<Category[]> {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT c.id, c.name, c.slug, c.description, COUNT(DISTINCT p.id) AS postCount
		 FROM categories c LEFT JOIN post_categories pc ON pc.category_id = c.id
		 LEFT JOIN posts p ON p.id = pc.post_id
		 GROUP BY c.id ORDER BY c.name ASC`,
	);
	return rows.map((row) => ({
		id: Number(row.id),
		name: String(row.name),
		slug: String(row.slug),
		description: String(row.description ?? ""),
		postCount: Number(row.postCount),
	}));
}

export async function createCategory(input: { name: string; slug: string; description?: string }) {
	const [result] = await pool.execute<ResultSetHeader>("INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)", [input.name, input.slug, input.description ?? ""]);
	return result.insertId;
}

export async function updateCategory(id: number, input: { name: string; slug: string; description?: string }) {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?", [input.name, input.slug, input.description ?? "", id]);
	return result.affectedRows > 0;
}

export async function deleteCategory(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM categories WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

export async function createTag(input: { name: string; slug: string }) {
	const [result] = await pool.execute<ResultSetHeader>("INSERT INTO tags (name, slug) VALUES (?, ?)", [input.name, input.slug]);
	return result.insertId;
}

export async function updateTag(id: number, input: { name: string; slug: string }) {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE tags SET name = ?, slug = ? WHERE id = ?", [input.name, input.slug, id]);
	return result.affectedRows > 0;
}

export async function deleteTag(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM tags WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

export async function listAllDynamics() {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT id, body, images, published_at AS publishedAt, created_at AS createdAt FROM dynamics ORDER BY published_at DESC, id DESC");
	return rows.map((row) => ({ id: Number(row.id), body: String(row.body), images: parseJsonArray<string>(row.images), publishedAt: String(row.publishedAt), createdAt: String(row.createdAt) }));
}

export async function createDynamic(input: { body: string; images?: string[]; publishedAt?: string }) {
	const [result] = await pool.execute<ResultSetHeader>("INSERT INTO dynamics (body, images, published_at) VALUES (?, ?, COALESCE(?, NOW()))", [input.body, JSON.stringify(input.images ?? []), input.publishedAt ?? null]);
	return result.insertId;
}

export async function updateDynamic(id: number, input: { body: string; images?: string[]; publishedAt?: string }) {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE dynamics SET body = ?, images = ?, published_at = COALESCE(?, published_at) WHERE id = ?", [input.body, JSON.stringify(input.images ?? []), input.publishedAt ?? null, id]);
	return result.affectedRows > 0;
}

export async function deleteDynamic(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM dynamics WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

const managedPageDefaults: Record<ManagedPageKey, { title: string; content: string }> = {
	about: { title: "关于", content: "# 关于\n\n这里是站点的关于页面。" },
	transfer: { title: "传送", content: "# 传送\n\n这里是站点的传送页。" },
	issues: { title: "问题总结", content: "# 问题总结\n\n这里记录常见问题与解决方案。" },
};

function normalizeManagedPageKey(value: unknown): ManagedPageKey | null {
	return value === "about" || value === "transfer" || value === "issues" ? value : null;
}

function normalizeFriendLinks(value: unknown): FriendLink[] {
	let source: unknown = value;
	if (typeof source === "string") {
		try { source = JSON.parse(source); } catch { source = []; }
	}
	if (!Array.isArray(source)) return [];
	return source.slice(0, 50).map((item) => {
		const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
		const url = String(row.url ?? row.href ?? row.link ?? "").trim().slice(0, 2000);
		const logo = String(row.logo ?? row.icon ?? row.image ?? "").trim().slice(0, 2000);
		return {
			name: String(row.name ?? row.title ?? row.label ?? "").trim().slice(0, 120),
			url,
			logo,
			description: String(row.description ?? row.text ?? "").trim().slice(0, 500),
		};
	}).filter((item) => {
		if (!item.name || !item.url) return false;
		try {
			const parsed = item.url.startsWith("/") ? null : new URL(item.url);
			if (parsed && !["http:", "https:"].includes(parsed.protocol.toLowerCase())) return false;
		} catch { return false; }
		if (item.logo) {
			try {
				const parsedLogo = item.logo.startsWith("/") ? null : new URL(item.logo);
				if (parsedLogo && !["http:", "https:"].includes(parsedLogo.protocol.toLowerCase())) return false;
			} catch { return false; }
		}
		return true;
	});
}

function mapManagedPage(row: RowDataPacket | undefined, page: ManagedPageKey): ManagedPage {
	const defaults = managedPageDefaults[page];
	return {
		page,
		title: String(row?.title ?? defaults.title),
		content: String(row?.content ?? defaults.content),
		friendLinksIntro: String(row?.friendLinksIntro ?? row?.friend_links_intro ?? ""),
		friendLinks: normalizeFriendLinks(row?.friendLinks ?? row?.friend_links),
		updatedAt: String(row?.updatedAt ?? row?.updated_at ?? ""),
	};
}

export async function getManagedPage(pageInput: unknown): Promise<ManagedPage | null> {
	const page = normalizeManagedPageKey(pageInput);
	if (!page) return null;
	const [rows] = await pool.query<RowDataPacket[]>("SELECT page_key AS page, title, content, friend_links_intro AS friendLinksIntro, friend_links AS friendLinks, updated_at AS updatedAt FROM managed_pages WHERE page_key = ? LIMIT 1", [page]);
	return mapManagedPage(rows[0], page);
}

export async function listManagedPages(): Promise<ManagedPage[]> {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT page_key AS page, title, content, friend_links_intro AS friendLinksIntro, friend_links AS friendLinks, updated_at AS updatedAt FROM managed_pages ORDER BY page_key ASC");
	const byPage = new Map(rows.map((row) => [String(row.page), row]));
	return (["about", "transfer", "issues"] as ManagedPageKey[]).map((page) => mapManagedPage(byPage.get(page), page));
}

export async function saveManagedPage(input: { page: ManagedPageKey; title: string; content: string; friendLinksIntro?: string; friendLinks?: FriendLink[] }) {
	const page = normalizeManagedPageKey(input.page);
	if (!page) return null;
	const title = input.title.trim().slice(0, 255);
	const content = input.content.trim();
	const friendLinksIntro = page === "transfer" ? String(input.friendLinksIntro ?? "").trim().slice(0, 500) : "";
	const friendLinks = page === "transfer" ? normalizeFriendLinks(input.friendLinks) : [];
	await pool.execute("INSERT INTO managed_pages (page_key, title, content, friend_links_intro, friend_links) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = VALUES(title), content = VALUES(content), friend_links_intro = VALUES(friend_links_intro), friend_links = VALUES(friend_links)", [page, title, content, friendLinksIntro, JSON.stringify(friendLinks)]);
	return getManagedPage(page);
}

export async function deleteManagedPage(pageInput: unknown) {
	const page = normalizeManagedPageKey(pageInput);
	if (!page) return false;
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM managed_pages WHERE page_key = ?", [page]);
	return result.affectedRows > 0;
}

function mapChangelog(row: RowDataPacket): Changelog {
	return {
		id: Number(row.id),
		slug: String(row.slug ?? ""),
		title: String(row.title ?? ""),
		version: String(row.version ?? ""),
		date: String(row.date ?? row.releaseDate ?? row.release_date ?? ""),
		published: Boolean(Number(row.published)),
		content: String(row.content ?? ""),
		updatedAt: String(row.updatedAt ?? row.updated_at ?? ""),
	};
}

export async function listChangelogs(options: { publishedOnly?: boolean; limit?: number } = {}): Promise<Changelog[]> {
	const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
	const where = options.publishedOnly ? "WHERE published <> 0" : "";
	const sql = "SELECT id, slug, title, version, release_date AS date, published, content, updated_at AS updatedAt FROM changelogs " + where + " ORDER BY release_date DESC, id DESC LIMIT ?";
	const [rows] = await pool.query<RowDataPacket[]>(sql, [limit]);
	return rows.map(mapChangelog);
}

export async function getChangelog(idOrSlug: number | string): Promise<Changelog | null> {
	const parsedId = typeof idOrSlug === "number" || /^\d+$/u.test(String(idOrSlug)) ? Number(idOrSlug) : null;
	const byId = parsedId !== null && Number.isSafeInteger(parsedId);
	const sql = "SELECT id, slug, title, version, release_date AS date, published, content, updated_at AS updatedAt FROM changelogs WHERE " + (byId ? "id = ?" : "slug = ?") + " LIMIT 1";
	const [rows] = await pool.query<RowDataPacket[]>(sql, [byId ? parsedId : String(idOrSlug)]);
	return rows[0] ? mapChangelog(rows[0]) : null;
}

export async function createChangelog(input: { slug: string; title: string; version?: string; date?: string | null; published?: boolean; content: string }) {
	const [result] = await pool.execute<ResultSetHeader>("INSERT INTO changelogs (slug, title, version, release_date, published, content) VALUES (?, ?, ?, COALESCE(?, NOW()), ?, ?)", [input.slug, input.title, input.version ?? "", input.date ?? null, input.published ? 1 : 0, input.content]);
	return getChangelog(Number(result.insertId));
}

export async function updateChangelog(id: number, input: { slug?: string; title?: string; version?: string; date?: string | null; published?: boolean; content?: string }) {
	const current = await getChangelog(id);
	if (!current) return null;
	const published = input.published === undefined ? (current.published ? 1 : 0) : (input.published ? 1 : 0);
	await pool.execute("UPDATE changelogs SET slug = ?, title = ?, version = ?, release_date = COALESCE(?, release_date), published = ?, content = ? WHERE id = ?", [input.slug ?? current.slug, input.title ?? current.title, input.version ?? current.version, input.date ?? null, published, input.content ?? current.content, id]);
	return getChangelog(id);
}

export async function deleteChangelog(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM changelogs WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

function mapFeedback(row: RowDataPacket): FeedbackEntry {
	const status = row.status === "processing" || row.status === "resolved" ? row.status : "open";
	return { id: Number(row.id), category: String(row.category ?? "other"), subject: String(row.subject ?? ""), content: String(row.content ?? ""), contact: String(row.contact ?? ""), pageUrl: String(row.pageUrl ?? row.page_url ?? ""), status, clientIp: String(row.clientIp ?? row.client_ip ?? ""), clientUa: String(row.clientUa ?? row.client_ua ?? ""), createdAt: String(row.createdAt ?? row.created_at ?? ""), updatedAt: String(row.updatedAt ?? row.updated_at ?? "") };
}

export async function createFeedback(input: { category?: string; subject: string; content: string; contact?: string; pageUrl?: string; clientIp?: string; clientUa?: string }) {
	const [result] = await pool.execute<ResultSetHeader>("INSERT INTO feedback_entries (category, subject, content, contact, page_url, status, client_ip, client_ua) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)", [input.category ?? "other", input.subject, input.content, input.contact ?? "", input.pageUrl ?? "", input.clientIp ?? "", input.clientUa ?? ""]);
	return getFeedback(Number(result.insertId));
}

export async function getFeedback(id: number): Promise<FeedbackEntry | null> {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT id, category, subject, content, contact, page_url AS pageUrl, status, client_ip AS clientIp, client_ua AS clientUa, created_at AS createdAt, updated_at AS updatedAt FROM feedback_entries WHERE id = ? LIMIT 1", [id]);
	return rows[0] ? mapFeedback(rows[0]) : null;
}

export async function listAdminFeedback(options: { page?: number; limit?: number; status?: string; keyword?: string } = {}) {
	const page = Math.max(1, Math.min(100000, Math.trunc(options.page ?? 1)));
	const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
	const params: Array<string | number> = [];
	const where: string[] = [];
	if (options.status && ["open", "processing", "resolved"].includes(options.status)) { where.push("status = ?"); params.push(options.status); }
	if (options.keyword?.trim()) { const keyword = "%" + options.keyword.trim().slice(0, 120) + "%"; where.push("(subject LIKE ? OR content LIKE ? OR contact LIKE ? OR page_url LIKE ?)"); params.push(keyword, keyword, keyword, keyword); }
	const clause = where.length ? "WHERE " + where.join(" AND ") : "";
	const [[count]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM feedback_entries " + clause, params);
	const [rows] = await pool.query<RowDataPacket[]>("SELECT id, category, subject, content, contact, page_url AS pageUrl, status, client_ip AS clientIp, client_ua AS clientUa, created_at AS createdAt, updated_at AS updatedAt FROM feedback_entries " + clause + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", [...params, limit, (page - 1) * limit]);
	const total = Number(count?.total ?? 0);
	return { items: rows.map(mapFeedback), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export async function updateFeedbackStatus(id: number, status: "open" | "processing" | "resolved") {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE feedback_entries SET status = ? WHERE id = ?", [status, id]);
	return result.affectedRows > 0 ? getFeedback(id) : null;
}

export async function deleteFeedback(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM feedback_entries WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

export async function listAdminComments(status?: string) {
	const params: string[] = [];
	const validStatus = status === "pending" || status === "approved" || status === "spam" ? status : undefined;
	const clause = validStatus ? "WHERE c.status = ?" : "";
	if (validStatus) params.push(validStatus);
	const [rows] = await pool.query<RowDataPacket[]>(`SELECT c.id, c.post_id AS postId, c.user_id AS userId, c.parent_id AS parentId, c.author_name AS authorName, c.author_email AS authorEmail, c.author_avatar AS authorAvatar, c.body, c.status, c.created_at AS createdAt, c.client_ip AS ip, c.ip_location AS ipLocation, c.client_device AS device, c.client_browser AS browser, c.client_ua AS userAgent, c.is_admin AS isAdmin, p.title AS postTitle FROM comments c LEFT JOIN posts p ON p.id = c.post_id ${clause} ORDER BY c.created_at DESC`, params);
	return rows.map((row) => ({ id: Number(row.id), postId: row.postId ? Number(row.postId) : null, userId: row.userId ? Number(row.userId) : null, parentId: row.parentId ? Number(row.parentId) : null, authorName: String(row.authorName), authorEmail: row.authorEmail ? String(row.authorEmail) : null, authorAvatar: row.authorAvatar ? String(row.authorAvatar) : null, body: String(row.body), status: String(row.status), createdAt: String(row.createdAt), ip: row.ip ? String(row.ip) : null, ipLocation: row.ipLocation ? String(row.ipLocation) : null, device: row.device ? String(row.device) : null, browser: row.browser ? String(row.browser) : null, userAgent: row.userAgent ? String(row.userAgent) : null, isAdmin: Boolean(Number(row.isAdmin)), postTitle: row.postTitle ? String(row.postTitle) : null }));
}

export async function updateCommentStatus(id: number, status: "pending" | "approved" | "spam") {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE comments SET status = ? WHERE id = ?", [status, id]);
	return result.affectedRows > 0;
}

export async function deleteComment(id: number) {
	const [result] = await pool.execute<ResultSetHeader>("DELETE FROM comments WHERE id = ?", [id]);
	return result.affectedRows > 0;
}

export async function authenticateAdmin(username: string, password: string) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM admin_users WHERE username = ? LIMIT 1", [username]);
	if (!row || !Boolean(Number(row.is_active)) || !verifyAdminPassword(password, String(row.password_hash))) return null;
	const user = mapAdminUser(row);
	await pool.execute("UPDATE admin_users SET last_login_at = NOW() WHERE id = ?", [user.id]);
	const token = randomBytes(32).toString("base64url");
	await pool.execute(`INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ${ADMIN_SESSION_DAYS} DAY))`, [sessionHash(token), user.id]);
	return { token, user: { ...user, lastLoginAt: new Date().toISOString() }, expiresIn: `${ADMIN_SESSION_DAYS}d` };
}

export async function getAdminSession(token: string): Promise<AdminUser | null> {
	if (!token.trim()) return null;
	const [[row]] = await pool.query<RowDataPacket[]>(
		"SELECT u.* FROM admin_sessions s INNER JOIN admin_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.is_active <> 0 LIMIT 1",
		[sessionHash(token)],
	);
	if (!row) return null;
	await pool.execute("UPDATE admin_sessions SET last_used_at = NOW() WHERE token_hash = ?", [sessionHash(token)]);
	return mapAdminUser(row);
}

export async function revokeAdminSession(token: string) {
	if (!token.trim()) return;
	await pool.execute("DELETE FROM admin_sessions WHERE token_hash = ?", [sessionHash(token)]);
}

export async function listAdminUsers() {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT id, username, display_name, role, is_active, created_at, updated_at, last_login_at FROM admin_users ORDER BY username ASC");
	return rows.map(mapAdminUser);
}

export async function createAdminUser(input: { username: string; password: string; displayName?: string; role?: "admin" | "superadmin" }) {
	const [result] = await pool.execute<ResultSetHeader>(
		"INSERT INTO admin_users (username, display_name, password_hash, role, is_active) VALUES (?, ?, ?, ?, TRUE)",
		[input.username, input.displayName?.trim() || input.username, hashAdminPassword(input.password), input.role ?? "admin"],
	);
	return Number(result.insertId);
}

export async function updateAdminUser(id: number, input: { username?: string; password?: string; displayName?: string; role?: "admin" | "superadmin"; isActive?: boolean }) {
	const fields: string[] = [];
	const values: Array<string | number | boolean> = [];
	if (input.username !== undefined) { fields.push("username = ?"); values.push(input.username); }
	if (input.password !== undefined) { fields.push("password_hash = ?"); values.push(hashAdminPassword(input.password)); }
	if (input.displayName !== undefined) { fields.push("display_name = ?"); values.push(input.displayName.trim() || input.username || ""); }
	if (input.role !== undefined) { fields.push("role = ?"); values.push(input.role); }
	if (input.isActive !== undefined) { fields.push("is_active = ?"); values.push(input.isActive); }
	if (!fields.length) return false;
	const [[existing]] = await pool.query<RowDataPacket[]>("SELECT id FROM admin_users WHERE id = ? LIMIT 1", [id]);
	if (!existing) return false;
	values.push(id);
	await pool.execute(`UPDATE admin_users SET ${fields.join(", ")} WHERE id = ?`, values);
	if (input.password !== undefined || input.isActive === false) {
		await pool.execute("DELETE FROM admin_sessions WHERE user_id = ?", [id]);
	}
	return true;
}

export async function resetAdminPassword(id: number, password: string) {
	const [result] = await pool.execute<ResultSetHeader>("UPDATE admin_users SET password_hash = ? WHERE id = ?", [hashAdminPassword(password), id]);
	if (result.affectedRows) await pool.execute("DELETE FROM admin_sessions WHERE user_id = ?", [id]);
	return result.affectedRows > 0;
}

export async function deleteAdminUser(id: number) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		await connection.execute("DELETE FROM admin_sessions WHERE user_id = ?", [id]);
		const [result] = await connection.execute<ResultSetHeader>("DELETE FROM admin_users WHERE id = ?", [id]);
		await connection.commit();
		return result.affectedRows > 0;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

function auditText(value: unknown, maximum: number) {
	const text = value === null || value === undefined ? "" : String(value).trim();
	return text.length > maximum ? text.slice(0, Math.max(0, maximum - 3)) + "..." : text;
}

function normalizeAuditIp(value: unknown) {
	let ip = auditText(value, AUDIT_TEXT_LIMITS.ip);
	if (ip.includes(",")) ip = ip.split(",", 1)[0]?.trim() ?? "";
	if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
	const zoneIndex = ip.indexOf("%");
	if (zoneIndex >= 0) ip = ip.slice(0, zoneIndex);
	// IPv6 text is case-insensitive. Lowercase it before unwrapping mapped IPv4
	// addresses so equivalent spellings share one audit group.
	if (ip.includes(":")) ip = ip.toLowerCase();
	if (ip.startsWith("::ffff:")) ip = ip.slice(7);
	return auditText(ip, AUDIT_TEXT_LIMITS.ip);
}

function redactAuditValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[MaxDepth]";
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return auditText(value, 240);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Buffer.isBuffer(value)) return "[Binary]";
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactAuditValue(item, depth + 1));
	if (typeof value === "object") {
		const output: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
			output[key] = AUDIT_SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactAuditValue(item, depth + 1);
		}
		return output;
	}
	return auditText(value, 240);
}

function serializeAuditPayload(value: unknown) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") {
		const text = auditText(value, 12000);
		try {
			return auditText(JSON.stringify(redactAuditValue(JSON.parse(text))), 6000);
		} catch {
			return AUDIT_SENSITIVE_FIELD.test(text) ? "[REDACTED]" : auditText(text, 6000);
		}
	}
	try {
		return auditText(JSON.stringify(redactAuditValue(value)), 6000);
	} catch {
		return "";
	}
}

function auditNumber(value: unknown, fallback = 0, maximum = 2_147_483_647) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(maximum, Math.max(0, Math.trunc(parsed)));
}

function auditNullableText(value: unknown, maximum: number) {
	return auditText(value, maximum);
}

function mapAuditLogRow(row: RowDataPacket) {
	const statusCode = auditNumber(row.statusCode ?? row.status_code);
	const durationMs = auditNumber(row.durationMs ?? row.duration_ms);
	return {
		id: String(row.id),
		createdAt: String(row.createdAt ?? row.created_at ?? ""),
		ip: normalizeAuditIp(row.ip),
		ipLocation: null,
		method: auditNullableText(row.method, AUDIT_TEXT_LIMITS.method),
		path: auditNullableText(row.path, AUDIT_TEXT_LIMITS.path),
		action: auditNullableText(row.action ?? row.action_name, AUDIT_TEXT_LIMITS.action),
		statusCode,
		status: statusCode,
		actorRole: auditNullableText(row.actorRole ?? row.actor_role, AUDIT_TEXT_LIMITS.actorRole),
		actorId: auditNullableText(row.actorId ?? row.actor_id, AUDIT_TEXT_LIMITS.actorId),
		actorAccount: auditNullableText(row.actorAccount ?? row.actor_account, AUDIT_TEXT_LIMITS.actorAccount),
		clientName: auditNullableText(row.clientName ?? row.client_name, AUDIT_TEXT_LIMITS.clientName),
		clientUa: auditNullableText(row.clientUa ?? row.client_ua, AUDIT_TEXT_LIMITS.clientUa),
		durationMs,
		duration: durationMs,
	};
}

function normalizeAuditPage(value: unknown, fallback: number, maximum: number) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, maximum);
}

function auditQueryString(value: unknown) {
	if (Array.isArray(value)) return auditText(value[0], 200);
	return auditText(value, 200);
}

export async function writeAuditLog(input: AuditLogInput) {
	try {
		const createdAt = input.createdAt instanceof Date ? input.createdAt : new Date(input.createdAt ?? Date.now());
		const safeDate = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
		const method = auditText(input.method, AUDIT_TEXT_LIMITS.method).toUpperCase();
		const path = auditText(input.path, AUDIT_TEXT_LIMITS.path) || "/";
		await pool.execute(
			"INSERT INTO audit_logs (created_at, ip, method, path, action_name, status_code, actor_role, actor_id, actor_account, client_name, client_ua, request_payload, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				safeDate,
				normalizeAuditIp(input.ip),
				method,
				path,
				auditText(input.action ?? (method + " " + path), AUDIT_TEXT_LIMITS.action),
				auditNumber(input.statusCode),
				auditText(input.actorRole, AUDIT_TEXT_LIMITS.actorRole),
				auditText(input.actorId, AUDIT_TEXT_LIMITS.actorId),
				auditText(input.actorAccount, AUDIT_TEXT_LIMITS.actorAccount),
				auditText(input.clientName, AUDIT_TEXT_LIMITS.clientName),
				auditText(input.clientUa, AUDIT_TEXT_LIMITS.clientUa),
				serializeAuditPayload(input.requestPayload),
				auditNumber(input.durationMs),
			],
		);
	} catch (error) {
		// Observability must never turn a successful request into a failed one.
		console.warn("[audit-log] write failed:", error instanceof Error ? error.message : error);
	}
}

export async function listAuditLogs(filters: AuditLogFilters = {}) {
	const page = normalizeAuditPage(filters.page, 1, 1_000_000);
	const limit = normalizeAuditPage(filters.limit, 50, 200);
	const groupLogPreviewLimit = normalizeAuditPage(filters.groupLogPreviewLimit, 5, 50);
	const viewMode = filters.viewMode === "ip" ? "ip" : "timeline";
	const where: string[] = ["1 = 1"];
	const params: Array<string | number> = [];
	const keyword = auditQueryString(filters.keyword);
	if (keyword) {
		const pattern = "%" + keyword + "%";
		where.push("(" + AUDIT_IP_SQL + " LIKE ? OR action_name LIKE ? OR path LIKE ? OR actor_account LIKE ? OR actor_id LIKE ? OR client_name LIKE ? OR client_ua LIKE ? OR request_payload LIKE ?)");
		params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
	}
	const method = auditQueryString(filters.method).toUpperCase();
	if (method) { where.push("method = ?"); params.push(method); }
	const actorRole = auditQueryString(filters.actorRole).toLowerCase();
	if (actorRole) { where.push("LOWER(actor_role) = ?"); params.push(actorRole); }
	if (filters.isAdmin === true) where.push("COALESCE(actor_role, '') <> ''");
	if (filters.isAdmin === false) where.push("COALESCE(actor_role, '') = ''");
	const path = auditQueryString(filters.path);
	if (path) { where.push("path LIKE ?"); params.push("%" + path + "%"); }
	const whereSql = "WHERE " + where.join(" AND ");

	const [[summaryRow]] = await pool.query<RowDataPacket[]>(
		"SELECT COUNT(*) AS totalLogs, COUNT(DISTINCT " + AUDIT_IP_SQL + ") AS uniqueIpCount FROM audit_logs " + whereSql,
		params,
	);
	const summary = { totalLogs: Number(summaryRow?.totalLogs ?? 0), uniqueIpCount: Number(summaryRow?.uniqueIpCount ?? 0) };
	const offset = (page - 1) * limit;

	if (viewMode === "ip") {
		const [[totalRow]] = await pool.query<RowDataPacket[]>(
			"SELECT COUNT(*) AS total FROM (SELECT " + AUDIT_IP_SQL + " AS groupedIp FROM audit_logs " + whereSql + " GROUP BY groupedIp) grouped",
			params,
		);
		const total = Number(totalRow?.total ?? 0);
		const [groupRows] = await pool.query<RowDataPacket[]>(
			"SELECT grouped.groupedIp AS ip, grouped.hitCount, grouped.errorCount, grouped.avgDurationMs, grouped.maxDurationMs, " +
			"latestLog.id AS latestId, latestLog.created_at AS latestAt, latestLog.method AS latestMethod, latestLog.path AS latestPath, " +
			"latestLog.action_name AS latestAction, latestLog.status_code AS latestStatusCode, latestLog.actor_role AS latestActorRole, " +
			"latestLog.actor_account AS latestActorAccount, latestLog.client_name AS latestClientName " +
			"FROM (SELECT " + AUDIT_IP_SQL + " AS groupedIp, COUNT(*) AS hitCount, " +
			"SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errorCount, AVG(duration_ms) AS avgDurationMs, " +
			"MAX(duration_ms) AS maxDurationMs, MAX(id) AS latestId FROM audit_logs " + whereSql +
			" GROUP BY groupedIp ORDER BY latestId DESC LIMIT ? OFFSET ?) grouped " +
			"INNER JOIN audit_logs latestLog ON latestLog.id = grouped.latestId ORDER BY grouped.latestId DESC",
			[...params, limit, offset],
		);
		const groups = groupRows.map((row) => ({
			ip: normalizeAuditIp(row.ip),
			ipLocation: null,
			hitCount: Number(row.hitCount ?? 0),
			errorCount: Number(row.errorCount ?? 0),
			avgDurationMs: Number.isFinite(Number(row.avgDurationMs)) ? Math.round(Number(row.avgDurationMs)) : 0,
			maxDurationMs: auditNumber(row.maxDurationMs),
			latestAt: String(row.latestAt ?? ""),
			latestMethod: auditNullableText(row.latestMethod, AUDIT_TEXT_LIMITS.method),
			latestPath: auditNullableText(row.latestPath, AUDIT_TEXT_LIMITS.path),
			latestAction: auditNullableText(row.latestAction, AUDIT_TEXT_LIMITS.action),
			latestStatusCode: auditNumber(row.latestStatusCode),
			latestActorRole: auditNullableText(row.latestActorRole, AUDIT_TEXT_LIMITS.actorRole),
			latestActorAccount: auditNullableText(row.latestActorAccount, AUDIT_TEXT_LIMITS.actorAccount),
			latestClientName: auditNullableText(row.latestClientName, AUDIT_TEXT_LIMITS.clientName),
			recent: [] as ReturnType<typeof mapAuditLogRow>[],
		}));
		if (groups.length) {
			const ips = groups.map((item) => item.ip);
			const placeholders = ips.map(() => "?").join(", ");
			const [recentRows] = await pool.query<RowDataPacket[]>(
				"SELECT * FROM (SELECT id, created_at AS createdAt, ip, method, path, action_name AS action, status_code AS statusCode, " +
				"actor_role AS actorRole, actor_id AS actorId, actor_account AS actorAccount, client_name AS clientName, client_ua AS clientUa, " +
				"duration_ms AS durationMs, ROW_NUMBER() OVER (PARTITION BY " + AUDIT_IP_SQL + " ORDER BY id DESC) AS rowNumber " +
				"FROM audit_logs " + whereSql + " AND " + AUDIT_IP_SQL + " IN (" + placeholders + ")) ranked " +
				"WHERE rowNumber <= ? ORDER BY id DESC",
				[...params, ...ips, groupLogPreviewLimit],
			);
			const recentByIp = new Map<string, ReturnType<typeof mapAuditLogRow>[]>();
			for (const row of recentRows) {
				const ip = normalizeAuditIp(row.ip);
				const list = recentByIp.get(ip) ?? [];
				list.push(mapAuditLogRow(row));
				recentByIp.set(ip, list);
			}
			for (const group of groups) group.recent = recentByIp.get(group.ip) ?? [];
		}
		return { page, limit, groupLogPreviewLimit, total, viewMode, summary, items: groups };
	}

	const [rows] = await pool.query<RowDataPacket[]>(
		"SELECT id, created_at AS createdAt, ip, method, path, action_name AS action, status_code AS statusCode, " +
		"actor_role AS actorRole, actor_id AS actorId, actor_account AS actorAccount, client_name AS clientName, " +
		"client_ua AS clientUa, duration_ms AS durationMs FROM audit_logs " + whereSql + " ORDER BY id DESC LIMIT ? OFFSET ?",
		[...params, limit, offset],
	);
	return { page, limit, groupLogPreviewLimit, total: summary.totalLogs, viewMode, summary, items: rows.map(mapAuditLogRow) };
}

export async function clearAuditLogs() {
	try {
		const [result] = await pool.execute<ResultSetHeader>("DELETE FROM audit_logs");
		return Number(result.affectedRows ?? 0);
	} catch (error) {
		console.warn("[audit-log] clear failed:", error instanceof Error ? error.message : error);
		throw error;
	}
}

export async function getSiteSetting(key: string) {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT setting_value AS value FROM site_settings WHERE setting_key = ? LIMIT 1", [key]);
	if (!row?.value) return null;
	if (typeof row.value !== "string") return row.value;
	try { return JSON.parse(row.value); } catch { return null; }
}

export async function saveSiteSetting(key: string, value: unknown) {
	await pool.execute("INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [key, JSON.stringify(value)]);
}

export async function getAuthorProfile() {
	const [[row]] = await pool.query<RowDataPacket[]>("SELECT * FROM authors ORDER BY id LIMIT 1");
	return mapAuthor(row);
}

export async function getAuthorProfileActivity(daysInput = 365) {
	const days = Math.max(28, Math.min(730, Math.trunc(daysInput)));
	const [rows] = await pool.query<RowDataPacket[]>(
		"SELECT DATE_FORMAT(published_at, '%Y-%m-%d') AS date, COUNT(*) AS count FROM posts WHERE status = 'published' AND published_at IS NOT NULL AND published_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY DATE_FORMAT(published_at, '%Y-%m-%d') ORDER BY date ASC",
		[days - 1],
	);
	const counts = new Map(rows.map((row) => [String(row.date), Number(row.count)]));
	const today = new Date();
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1);
	const activity: AuthorActivityDay[] = [];
	for (let index = 0; index < days; index += 1) {
		const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
		const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		activity.push({ date: key, count: counts.get(key) ?? 0 });
	}
	return {
		from: activity[0]?.date ?? null,
		to: activity.at(-1)?.date ?? null,
		totalPosts: activity.reduce((total, day) => total + day.count, 0),
		days: activity,
	};
}

export type AuthorProfileInput = {
	name: string;
	bio: string;
	avatar: string;
	email?: string | null;
	githubUrl?: string | null;
	qqUrl?: string | null;
	rssUrl?: string | null;
	links?: Array<{ label: string; url: string; icon?: string | null }>;
	// API requests may carry a partial profile; normalizeAuthorProfile makes the
	// persisted document complete and clamps all public-facing values.
	profile?: unknown;
};

export async function saveSiteConfiguration(value: unknown, author?: AuthorProfileInput | null) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		await connection.execute("INSERT INTO site_settings (setting_key, setting_value) VALUES ('site', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [JSON.stringify(value)]);
		if (author) {
			const [[existing]] = await connection.query<RowDataPacket[]>("SELECT id FROM authors ORDER BY id LIMIT 1 FOR UPDATE");
			const values = [author.name, author.bio, author.avatar, author.email ?? null, author.githubUrl ?? null, author.qqUrl ?? null, author.rssUrl ?? null, JSON.stringify(author.links ?? []), JSON.stringify(normalizeAuthorProfile(author.profile))];
			if (existing) {
				await connection.execute("UPDATE authors SET name = ?, bio = ?, avatar = ?, email = ?, github_url = ?, qq_url = ?, rss_url = ?, links = ?, profile = ? WHERE id = ?", [...values, existing.id]);
			} else {
				await connection.execute("INSERT INTO authors (name, bio, avatar, email, github_url, qq_url, rss_url, links, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", values);
			}
		}
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

type AnnouncementHistoryRecord = {
	id: number | string;
	content: string;
	publishedAt: string;
	updatedAt: string;
	isVisible: boolean;
	isPinned: boolean;
	sortOrder: number;
	isCurrent?: boolean;
	readOnly?: boolean;
};

export type AnnouncementResponse = {
	content: string;
	updatedAt: string;
	storage: "mysql";
	displayItems: AnnouncementHistoryRecord[];
};

type AnnouncementConnection = Awaited<ReturnType<typeof pool.getConnection>>;
type AnnouncementDb = typeof pool | AnnouncementConnection;

const announcementHistoryProjection =
	"id, content, published_at AS publishedAt, updated_at AS updatedAt, is_visible AS isVisible, is_pinned AS isPinned, sort_order AS sortOrder";

function mapAnnouncementHistory(row: RowDataPacket): AnnouncementHistoryRecord {
	return {
		id: Number(row.id),
		content: String(row.content ?? ""),
		publishedAt: String(row.publishedAt ?? row.published_at ?? ""),
		updatedAt: String(row.updatedAt ?? row.updated_at ?? ""),
		isVisible: Boolean(Number(row.isVisible ?? row.is_visible ?? 0)),
		isPinned: Boolean(Number(row.isPinned ?? row.is_pinned ?? 0)),
		sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0),
		...(row.isCurrent === undefined ? {} : { isCurrent: Boolean(row.isCurrent) }),
	};
}

function parseAnnouncementSetting(value: unknown): { content: string; historyId: number | null } {
	let parsed: unknown = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return { content: String(parsed), historyId: null };
		}
	}
	if (typeof parsed === "string") return { content: parsed, historyId: null };
	if (!parsed || typeof parsed !== "object") return { content: "", historyId: null };
	const record = parsed as { content?: unknown; historyId?: unknown };
	const historyId = Number(record.historyId);
	return {
		content: typeof record.content === "string" ? record.content : "",
		historyId: Number.isInteger(historyId) && historyId > 0 ? historyId : null,
	};
}

function parseAnnouncementDate(value: string | Date | null | undefined): Date {
	if (value instanceof Date) return value;
	if (!value || !String(value).trim()) return new Date();
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("Invalid announcement date");
	return date;
}

async function readAnnouncementSetting(connection: AnnouncementDb = pool, forUpdate = false) {
	const [[row]] = await connection.query<RowDataPacket[]>(
		"SELECT setting_value AS value, updated_at AS updatedAt FROM site_settings WHERE setting_key = 'announcement' LIMIT 1" + (forUpdate ? " FOR UPDATE" : ""),
	);
	const setting = parseAnnouncementSetting(row?.value);
	return { ...setting, updatedAt: String(row?.updatedAt ?? "") };
}

async function lockAnnouncementSetting(connection: AnnouncementConnection) {
	await connection.execute(
		"INSERT INTO site_settings (setting_key, setting_value) VALUES ('announcement', ?) ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key)",
		[JSON.stringify({ content: "", historyId: null })],
	);
	return readAnnouncementSetting(connection, true);
}

async function writeAnnouncementSetting(connection: AnnouncementConnection, content: string, historyId: number | null) {
	await connection.execute(
		"UPDATE site_settings SET setting_value = ? WHERE setting_key = 'announcement'",
		[JSON.stringify({ content, historyId })],
	);
}

async function readAnnouncementHistoryById(connection: AnnouncementDb, id: number, forUpdate = false) {
	const [rows] = await connection.query<RowDataPacket[]>(
		"SELECT " + announcementHistoryProjection + " FROM announcement_history WHERE id = ? LIMIT 1" + (forUpdate ? " FOR UPDATE" : ""),
		[id],
	);
	return rows[0] ?? null;
}

async function archiveUnlinkedCurrent(connection: AnnouncementConnection, current: Awaited<ReturnType<typeof readAnnouncementSetting>>) {
	const content = current.content.trim();
	if (current.historyId !== null || !content) return null;
	const [result] = await connection.execute<ResultSetHeader>(
		"INSERT INTO announcement_history (content, published_at, is_visible, is_pinned, sort_order) VALUES (?, ?, FALSE, FALSE, 0)",
		[content, parseAnnouncementDate(current.updatedAt)],
	);
	return Number(result.insertId);
}

async function readAnnouncementDisplayItems(connection: AnnouncementDb = pool) {
	const [rows] = await connection.query<RowDataPacket[]>(
		"SELECT " + announcementHistoryProjection + " FROM announcement_history WHERE is_visible = 1 ORDER BY is_pinned DESC, sort_order ASC, published_at DESC, id DESC LIMIT 50",
	);
	return rows.map((row) => mapAnnouncementHistory(row));
}

async function readAnnouncementResponse(connection: AnnouncementDb = pool): Promise<AnnouncementResponse> {
	const current = await readAnnouncementSetting(connection);
	const displayItems = await readAnnouncementDisplayItems(connection);
	return {
		content: current.content,
		updatedAt: current.updatedAt,
		storage: "mysql",
		displayItems: displayItems.map((item) => ({ ...item, isCurrent: item.id === current.historyId })),
	};
}

export async function getCurrentAnnouncement(): Promise<AnnouncementResponse> {
	return readAnnouncementResponse();
}

export async function saveAnnouncement(content: string, publishedAt?: string | Date | null) {
	const normalized = String(content ?? "").trim();
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const current = await lockAnnouncementSetting(connection);
		await archiveUnlinkedCurrent(connection, current);

		let historyId: number | null = null;
		if (normalized) {
			const [historyResult] = await connection.execute<ResultSetHeader>(
				"INSERT INTO announcement_history (content, published_at, is_visible, is_pinned, sort_order) VALUES (?, ?, FALSE, FALSE, 0)",
				[normalized, parseAnnouncementDate(publishedAt)],
			);
			historyId = Number(historyResult.insertId);
		}
		await writeAnnouncementSetting(connection, normalized, historyId);
		const response = await readAnnouncementResponse(connection);
		await connection.commit();
		return response;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function listAnnouncementHistory(filters: { page: number; limit: number; keyword?: string }, visibleOnly = false) {
	const where: string[] = [];
	const params: Array<string | number> = [];
	if (filters.keyword) {
		where.push("content LIKE ?");
		params.push("%" + filters.keyword + "%");
	}
	if (visibleOnly) where.push("is_visible = 1");
	const clause = where.length ? "WHERE " + where.join(" AND ") : "";
	const current = await readAnnouncementSetting();
	const [[count]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM announcement_history " + clause, params);
	const keyword = filters.keyword?.toLocaleLowerCase();
	const includeReadOnlyCurrent =
		!visibleOnly &&
		current.historyId === null &&
		Boolean(current.content.trim()) &&
		(!keyword || current.content.toLocaleLowerCase().includes(keyword));
	const logicalOffset = (filters.page - 1) * filters.limit;
	// The legacy unlinked current announcement is a virtual row. Its chronological
	// position, rather than an always-first position, keeps every page consistent.
	let virtualIndex = -1;
	if (includeReadOnlyCurrent) {
		const [[before]] = await pool.query<RowDataPacket[]>(
			"SELECT COUNT(*) AS total FROM announcement_history " + clause + (clause ? " AND " : "WHERE ") + "published_at > ?",
			[...params, current.updatedAt],
		);
		virtualIndex = Number(before?.total ?? 0);
	}
	const includeVirtualOnPage = virtualIndex >= logicalOffset && virtualIndex < logicalOffset + filters.limit;
	const historyOffset = logicalOffset - (virtualIndex >= 0 && logicalOffset > virtualIndex ? 1 : 0);
	const historyLimit = Math.max(0, filters.limit - (includeVirtualOnPage ? 1 : 0));
	const [rows] = historyLimit > 0
		? await pool.query<RowDataPacket[]>(
			"SELECT " + announcementHistoryProjection + " FROM announcement_history " + clause + " ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?",
			[...params, historyLimit, historyOffset],
		)
		: [[] as RowDataPacket[]];
	const items: AnnouncementHistoryRecord[] = rows.map((row) => mapAnnouncementHistory({ ...row, isCurrent: Number(row.id) === current.historyId }));
	if (includeVirtualOnPage) {
		items.splice(virtualIndex - logicalOffset, 0, {
			id: "current",
			content: current.content,
			publishedAt: current.updatedAt,
			updatedAt: current.updatedAt,
			isVisible: false,
			isPinned: false,
			sortOrder: 0,
			isCurrent: true,
			readOnly: true,
		});
	}
	return { items, total: Number(count?.total ?? 0) + (includeReadOnlyCurrent ? 1 : 0), page: filters.page, limit: filters.limit, storage: "mysql" as const };
}

export async function createAnnouncementHistory(input: { content: string; publishedAt?: string | null }) {
	const content = String(input.content ?? "").trim();
	if (!content) throw new Error("Announcement content cannot be empty");
	const [result] = await pool.execute<ResultSetHeader>(
		"INSERT INTO announcement_history (content, published_at, is_visible, is_pinned, sort_order) VALUES (?, ?, FALSE, FALSE, 0)",
		[content, parseAnnouncementDate(input.publishedAt)],
	);
	const row = await readAnnouncementHistoryById(pool, Number(result.insertId));
	return row ? mapAnnouncementHistory(row) : null;
}

export async function updateAnnouncementHistory(id: number, input: { content: string; publishedAt?: string | null }) {
	const content = String(input.content ?? "").trim();
	if (!content) throw new Error("Announcement content cannot be empty");
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const current = await lockAnnouncementSetting(connection);
		const existing = await readAnnouncementHistoryById(connection, id, true);
		if (!existing) {
			await connection.rollback();
			return null;
		}
		await connection.execute("UPDATE announcement_history SET content = ?, published_at = ? WHERE id = ?", [content, parseAnnouncementDate(input.publishedAt ?? String(existing.publishedAt ?? "")), id]);
		if (current.historyId === id) await writeAnnouncementSetting(connection, content, id);
		const updated = await readAnnouncementHistoryById(connection, id);
		await connection.commit();
		return updated ? mapAnnouncementHistory(updated) : null;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function updateAnnouncementHistoryDisplay(id: number, changes: { isVisible?: boolean; isPinned?: boolean; sortOrder?: number }) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		await lockAnnouncementSetting(connection);
		const existing = await readAnnouncementHistoryById(connection, id, true);
		if (!existing) {
			await connection.rollback();
			return null;
		}
		let isVisible = changes.isVisible ?? Boolean(Number(existing.isVisible));
		let isPinned = changes.isPinned ?? Boolean(Number(existing.isPinned));
		const sortOrder = changes.sortOrder ?? Number(existing.sortOrder ?? 0);
		if (isPinned) isVisible = true;
		if (!isVisible) isPinned = false;
		if (isPinned) await connection.execute("UPDATE announcement_history SET is_pinned = FALSE WHERE id <> ? AND is_pinned <> FALSE", [id]);
		await connection.execute("UPDATE announcement_history SET is_visible = ?, is_pinned = ?, sort_order = ? WHERE id = ?", [isVisible, isPinned, sortOrder, id]);
		const updated = await readAnnouncementHistoryById(connection, id);
		await connection.commit();
		return updated ? mapAnnouncementHistory(updated) : null;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function deleteAnnouncementHistory(id: number) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const current = await lockAnnouncementSetting(connection);
		const existing = await readAnnouncementHistoryById(connection, id, true);
		if (!existing) {
			await connection.rollback();
			return false;
		}
		if (current.historyId === id) await writeAnnouncementSetting(connection, "", null);
		await connection.execute("DELETE FROM announcement_history WHERE id = ?", [id]);
		await connection.commit();
		return true;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function publishAnnouncementHistory(id: number) {
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const current = await lockAnnouncementSetting(connection);
		const history = await readAnnouncementHistoryById(connection, id, true);
		if (!history) {
			await connection.rollback();
			return null;
		}
		await archiveUnlinkedCurrent(connection, current);
		await writeAnnouncementSetting(connection, String(history.content), id);
		const response = await readAnnouncementResponse(connection);
		await connection.commit();
		return response;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}
