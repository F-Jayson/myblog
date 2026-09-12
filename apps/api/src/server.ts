import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getDatabaseStatus, pingDatabase } from "./db.js";
import { getProcessSnapshot, getRequestMetrics, recordRequest } from "./telemetry.js";
import { CompilerError, executeCompiler, formatCompilerCode, listCompilerLanguages } from "./compiler.js";
import {
	archivePosts,
	authenticateAdmin,
	authenticateCommentUser,
	clearAuditLogs,
	createAdminUser,
	createAnnouncementHistory,
	createChangelog,
	createComment,
	createSharedCommentSticker,
	deleteSharedCommentSticker,
	createUserSticker,
	createUserStorageItem,
	listUserStorageItems,
	getUserStorageItem,
	updateUserStorageVisibility,
	deleteUserStorageItem,
	getUserSpace,
	createUserClipboard,
	listUserClipboards,
	getUserClipboard,
	updateUserClipboard,
	deleteUserClipboard,
	getPublicUserResource,
	listAdminUserSpace,
	listAdminUserResources,
	deleteUserSticker,
	getCommentUserById,
	verifyCommentUserPassword,
	createCategory,
	createDynamic,
	createFeedback,
	createPost,
	createTag,
	deleteCategory,
	deleteComment,
	deleteCommentUser,
	deleteDynamic,
	deletePost,
	deleteTag,
	deleteAnnouncementHistory,
	deleteAdminUser,
	getCurrentAnnouncement,
	getChangelog,
	getFeedback,
	getAdminPost,
	getAdminSession,
	getCommentSession,
	getCommentSettings,
	getComments,
	getAuthorProfile,
	getAuthorProfileActivity,
	getManagedPage,
	getSiteSetting,
	listAdminComments,
	listAdminCommentUsers,
	listAdminFeedback,
	listCommentStickers,
	listAuditLogs,
	listAdminUsers,
	listAdminPosts,
	listAllCategories,
	listAllDynamics,
	listAllTags,
	listAnnouncementHistory,
	listChangelogs,
	listManagedPages,
	getPostBySlug,
	listCategories,
	listPosts,
	listTags,
	saveSiteSetting,
	saveSiteConfiguration,
	saveAnnouncement,
	saveManagedPage,
	siteSummary,
	updateCategory,
	updateChangelog,
	updateCommentStatus,
	updateDynamic,
	updateFeedbackStatus,
	updatePost,
	updateTag,
	updateAnnouncementHistory,
	updateAnnouncementHistoryDisplay,
	updateAdminUser,
	updateCommentUser,
	deleteChangelog,
	deleteFeedback,
	publishAnnouncementHistory,
	resetAdminPassword,
	resetCommentUserPassword,
	revokeAdminSession,
	revokeCommentSession,
	registerCommentUser,
	requestCommentEmailCode,
	verifyCommentEmailCode,
	writeAuditLog,
} from "./repository.js";

type ApplicationMetadata = { name: string; version: string };

async function readApplicationMetadata(): Promise<ApplicationMetadata> {
	try {
		const packagePath = fileURLToPath(new URL("../../../package.json", import.meta.url));
		const value: unknown = JSON.parse(await readFile(packagePath, "utf8"));
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const metadata = value as Record<string, unknown>;
			const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
			const version = typeof metadata.version === "string" ? metadata.version.trim() : "";
			if (name && version) return { name, version };
		}
	} catch {
		// The site remains available when a deployment intentionally omits package.json.
	}
	return { name: "firefly-rebuild", version: "unknown" };
}

const applicationMetadata = await readApplicationMetadata();

const app = express();
const uploadsDirectory = fileURLToPath(new URL("../../../uploads/", import.meta.url));
await mkdir(uploadsDirectory, { recursive: true });

const publicImageUpload = (maxFileSize: number) => multer({
	storage: multer.diskStorage({
		destination: uploadsDirectory,
		filename: (_req, file, callback) => callback(null, `${Date.now()}-${randomUUID()}${extname(file.originalname).toLowerCase() || ".bin"}`),
	}),
	limits: { files: 1, fileSize: maxFileSize },
	fileFilter: (_req, file, callback) => callback(null, /^image\/(?:jpeg|png|gif|webp|avif)$/iu.test(file.mimetype)),
});
const avatarUpload = publicImageUpload(3 * 1024 * 1024);
const commentImageUpload = publicImageUpload(5 * 1024 * 1024);
const stickerUpload = publicImageUpload(5 * 1024 * 1024);
const userStorageUploadRoot = fileURLToPath(new URL("../../../uploads/user-space/", import.meta.url));
const USER_SPACE_QUOTA_BYTES = 30 * 1024 * 1024;
const USER_STORAGE_KINDS = ["image", "image_host", "avatar", "comment_image", "sticker", "other"] as const;
type UserStorageKind = typeof USER_STORAGE_KINDS[number];
await mkdir(userStorageUploadRoot, { recursive: true });

const userStorageUpload = multer({
	storage: multer.diskStorage({
		destination: userStorageUploadRoot,
		filename: (_req, file, callback) => callback(null, `${Date.now()}-${randomUUID()}${extname(file.originalname).toLowerCase() || ".bin"}`),
	}),
	limits: { files: 1, fileSize: USER_SPACE_QUOTA_BYTES },
	fileFilter: (_req, file, callback) => callback(null, /^image\/(?:jpeg|png|gif|webp|avif)$/iu.test(file.mimetype)),
});

app.disable("x-powered-by");
app.use(cors({ origin: config.clientOrigin.split(","), credentials: false }));
app.use(express.json({ limit: "12mb" }));
app.use("/api/uploads/user-space", (_req, res) => { res.status(404).end(); });
app.use("/api/uploads", express.static(uploadsDirectory, { fallthrough: true, index: false, maxAge: "1d" }));
function auditExcludedRequest(method: string, path: string) {
	if (path === "/api/health" || path === "/api/wallpaper" || path.startsWith("/api/uploads/")) return true;
	// Compiler source and stdin are user code; never persist them in the audit
	// payload, while the request metrics middleware still records duration/status.
	if (path.startsWith("/api/compiler/") || path.startsWith("/api/user/compiler/")) return true;
	// Reading the audit stream must not add another row on every refresh. Keep
	// mutating audit actions (such as clear) observable through the same hook.
	if ((method === "GET" || method === "HEAD") && (path === "/api/admin/audit-logs" || path === "/api/admin/audit")) return true;
	return false;
}
function requestClientIp(req: Request) {
	const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
	return forwarded || req.ip || req.socket.remoteAddress || "";
}
function requestAuditPayload(req: Request) {
	return req.method === "GET" || req.method === "HEAD" ? req.query : req.body;
}
app.use((req, res, next) => {
	// Do not let observability probes count themselves as application traffic.
	if (["/api/health", "/api/admin/monitoring", "/api/admin/db-status", "/api/admin/dashboard"].includes(req.path)) return next();
	const started = performance.now();
	res.on("finish", () => {
		const durationMs = Math.round(performance.now() - started);
		recordRequest({ method: req.method, path: req.path, status: res.statusCode, durationMs });
		if (auditExcludedRequest(req.method, req.path)) return;
		const admin = (req as RequestWithAdmin).adminUser;
		void writeAuditLog({
			ip: requestClientIp(req),
			method: req.method,
			path: req.path,
			action: req.method + " " + req.path,
			statusCode: res.statusCode,
			actorRole: admin?.role,
			actorId: admin?.id,
			actorAccount: admin?.username || admin?.displayName,
			clientName: req.header("sec-ch-ua") || req.header("user-agent"),
			clientUa: req.header("user-agent"),
			requestPayload: requestAuditPayload(req),
			durationMs,
		}).catch((error) => {
			console.warn("[audit-log] request hook failed:", error instanceof Error ? error.message : error);
		});
	});
	next();
});

function parsePositiveInteger(value: unknown, fallback: number, max: number) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, max);
}
function queryText(value: unknown) {
	return typeof value === "string" ? value : undefined;
}

type RequestWithAdmin = Request & { adminUser?: import("./repository.js").AdminPrincipal };
type RequestWithCommentUser = Request & { commentUser?: import("./repository.js").CommentPrincipal };

const FEATURE_KEYS = [
	"commentsEnabled",
	"registrationEnabled",
	"loginEnabled",
	"imageHostingEnabled",
	"clipboardEnabled",
	"userCenterEnabled",
	"publicResourcesEnabled",
	"compilerEnabled",
] as const;
type FeatureKey = typeof FEATURE_KEYS[number];
type FeatureSettings = Record<FeatureKey, boolean>;
const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
	commentsEnabled: true,
	registrationEnabled: true,
	loginEnabled: true,
	imageHostingEnabled: true,
	clipboardEnabled: true,
	userCenterEnabled: true,
	publicResourcesEnabled: true,
	compilerEnabled: true,
};

function normalizeFeatureSettings(value: unknown): FeatureSettings {
	const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
	return FEATURE_KEYS.reduce((result, key) => {
		result[key] = source[key] !== false;
		return result;
	}, { ...DEFAULT_FEATURE_SETTINGS });
}

async function getFeatureSettings() {
	return normalizeFeatureSettings(await getSiteSetting("features"));
}

function requireFeature(key: FeatureKey, message: string) {
	return async (_req: Request, res: Response, next: NextFunction) => {
		try {
			const settings = await getFeatureSettings();
			if (!settings[key]) { res.status(403).json({ error: message }); return; }
			next();
		} catch (error) {
			next(error);
		}
	};
}

async function requireAdmin(req: RequestWithAdmin, res: Response, next: NextFunction) {
	const token = req.header("authorization")?.replace(/^Bearer\s+/iu, "").trim() ?? "";
	if (config.adminToken && token === config.adminToken) {
		req.adminUser = { id: null, username: config.adminName, displayName: config.adminName, role: "legacy", isActive: true };
		next();
		return;
	}
	try {
		const user = await getAdminSession(token);
		if (!user) { res.status(401).json({ error: "登录状态已失效，请重新登录" }); return; }
		req.adminUser = user;
		next();
	} catch (error) {
		next(error);
	}
}

async function loadCommentUser(req: RequestWithCommentUser, _res: Response, next: NextFunction) {
	const token = req.header("authorization")?.replace(/^Bearer\s+/iu, "").trim() ?? "";
	if (!token) { next(); return; }
	try { req.commentUser = await getCommentSession(token) ?? undefined; next(); } catch (error) { next(error); }
}

async function requireCommentUser(req: RequestWithCommentUser, res: Response, next: NextFunction) {
	await loadCommentUser(req, res, () => {
		if (!req.commentUser) { res.status(401).json({ error: "请先登录后再进行此操作" }); return; }
		next();
	});
}

function parseBooleanInput(value: unknown, fallback = false) {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	return /^(?:1|true|yes|on)$/iu.test(String(value));
}

function parseUserStorageKind(value: unknown, fallback: UserStorageKind = "image_host"): UserStorageKind {
	const kind = String(value ?? fallback) as UserStorageKind;
	return USER_STORAGE_KINDS.includes(kind) ? kind : fallback;
}

function safeUserStoragePath(storageKey: string) {
	const root = resolve(userStorageUploadRoot);
	const candidate = resolve(root, storageKey);
	if (!storageKey || (candidate !== root && !candidate.startsWith(root + sep))) return null;
	return candidate;
}

async function removeUserStorageFile(storageKey: string | undefined) {
	if (!storageKey) return;
	const filePath = safeUserStoragePath(storageKey);
	if (filePath) await unlink(filePath).catch(() => undefined);
}

function userImageUploadRoute(kind: UserStorageKind, defaultPublic: boolean) {
	return (req: RequestWithCommentUser, res: Response, next: NextFunction) => {
		userStorageUpload.single("file")(req, res, async (uploadError) => {
			if (uploadError) { next(uploadError); return; }
			if (!req.file || !req.commentUser) { res.status(400).json({ error: "请选择图片文件" }); return; }
			const isPublic = parseBooleanInput(req.body?.isPublic, defaultPublic);
			const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 255) : req.file.originalname.slice(0, 255);
			try {
				const item = await createUserStorageItem({ userId: req.commentUser.id, kind, name, url: "", storageKey: req.file.filename, mimeType: req.file.mimetype, byteSize: req.file.size, isPublic });
				if (!item) throw new Error("图片记录创建失败");
				res.status(201).json(item);
			} catch (error) {
				await removeUserStorageFile(req.file.filename);
				next(error);
			}
		});
	};
}

function uploadResponse(file: Express.Multer.File) {
	const url = `/api/uploads/${encodeURIComponent(file.filename)}`;
	return { url, path: url, src: url, name: file.originalname, size: file.size, mimeType: file.mimetype };
}

function requestClientDevice(userAgent: string) {
	if (/tablet|ipad|playbook|silk/i.test(userAgent) || (/android/i.test(userAgent) && !/mobile/i.test(userAgent))) return "平板";
	if (/mobile|iphone|ipod|android/i.test(userAgent)) return "手机";
	return "电脑";
}

function requestClientBrowser(userAgent: string) {
	if (/edg\//i.test(userAgent)) return "Edge";
	if (/chrome\//i.test(userAgent)) return "Chrome";
	if (/firefox\//i.test(userAgent)) return "Firefox";
	if (/safari\//i.test(userAgent) && !/chrome\//i.test(userAgent)) return "Safari";
	if (/opera|opr\//i.test(userAgent)) return "Opera";
	return "未知浏览器";
}

function requestClientOs(userAgent: string) {
	if (/windows/i.test(userAgent)) return "Windows";
	if (/android/i.test(userAgent)) return "Android";
	if (/iphone|ipad|ios/i.test(userAgent)) return "iOS";
	if (/mac os|macintosh/i.test(userAgent)) return "macOS";
	if (/linux/i.test(userAgent)) return "Linux";
	return "未知系统";
}

app.post("/api/admin/login", async (req, res, next) => {
	try {
		const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
		const password = typeof req.body?.password === "string" ? req.body.password : "";
		const legacyToken = typeof req.body?.token === "string" ? req.body.token.trim() : "";
		if (legacyToken && config.adminToken && legacyToken === config.adminToken) {
			(req as RequestWithAdmin).adminUser = { id: null, username: config.adminName, displayName: config.adminName, role: "legacy", isActive: true };
			res.json({ token: legacyToken, username: config.adminName, user: { id: null, username: config.adminName, displayName: config.adminName, role: "legacy" }, expiresIn: "session" });
			return;
		}
		if (!username || !password) { res.status(400).json({ error: "请输入管理员账号和密码" }); return; }
		const result = await authenticateAdmin(username, password);
		if (!result) { res.status(401).json({ error: "账号或密码错误" }); return; }
		(req as RequestWithAdmin).adminUser = result.user;
		res.json({ ...result, username: result.user.username });
	} catch (error) {
		next(error);
	}
});

app.post("/api/admin/logout", requireAdmin, async (req, res, next) => {
	try {
		const token = req.header("authorization")?.replace(/^Bearer\s+/iu, "").trim() ?? "";
		if (token && token !== config.adminToken) await revokeAdminSession(token);
		res.status(204).end();
	} catch (error) { next(error); }
});

app.get("/api/admin/me", requireAdmin, (req: RequestWithAdmin, res) => {
	res.json({ user: req.adminUser ?? null });
});

app.get("/api/features", async (_req, res, next) => {
	try {
		res.json(await getFeatureSettings());
	} catch (error) {
		next(error);
	}
});

const commentRegistrationInput = z.object({
	username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	account: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	nickname: z.string().trim().min(1).max(120),
	password: z.string().min(6).max(200),
	email: z.string().trim().email().max(190).optional().nullable(),
	emailCode: z.string().trim().regex(/^\d{6}$/u).optional(),
	avatar: z.string().trim().max(512).regex(/^(?:https?:\/\/|\/)/iu, "头像地址必须是 http(s) 或站内路径").optional().nullable(),
	avatarSource: z.enum(["preset", "upload", "url"]).optional(),
});
const commentLoginInput = z.object({ username: z.string().trim().min(1).max(190).optional(), account: z.string().trim().min(1).max(190).optional(), email: z.string().trim().email().max(190).optional(), password: z.string().min(1).max(200) });

app.get("/api/comment-settings", async (_req, res, next) => {
	try { res.json(await getCommentSettings()); } catch (error) { next(error); }
});

app.post("/api/auth/email-code", async (req, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.registrationEnabled) { res.status(403).json({ error: "用户注册功能未开启" }); return; }
		const settings = await getCommentSettings();
		if (!settings.emailRegistrationEnabled) { res.status(400).json({ error: "邮箱注册功能未开启" }); return; }
		const email = z.string().email().max(190).parse(req.body?.email);
		res.json(await requestCommentEmailCode(email));
	} catch (error) { next(error); }
});
app.post("/api/user/auth/verification-code", async (req, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.registrationEnabled) { res.status(403).json({ error: "用户注册功能未开启" }); return; }
		const settings = await getCommentSettings();
		if (!settings.emailRegistrationEnabled) { res.status(400).json({ error: "邮箱注册功能未开启" }); return; }
		const email = z.string().email().max(190).parse(req.body?.email);
		res.json(await requestCommentEmailCode(email));
	} catch (error) { next(error); }
});
app.post("/api/auth/send-code", async (req, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.registrationEnabled) { res.status(403).json({ error: "用户注册功能未开启" }); return; }
		const settings = await getCommentSettings();
		if (!settings.emailRegistrationEnabled) { res.status(400).json({ error: "邮箱注册功能未开启" }); return; }
		const email = z.string().email().max(190).parse(req.body?.email);
		res.json(await requestCommentEmailCode(email));
	} catch (error) { next(error); }
});
app.post("/api/user/auth/send-code", async (req, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.registrationEnabled) { res.status(403).json({ error: "用户注册功能未开启" }); return; }
		const settings = await getCommentSettings();
		if (!settings.emailRegistrationEnabled) { res.status(400).json({ error: "邮箱注册功能未开启" }); return; }
		const email = z.string().email().max(190).parse(req.body?.email);
		res.json(await requestCommentEmailCode(email));
	} catch (error) { next(error); }
});

app.post("/api/auth/register", async (req: RequestWithCommentUser, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.registrationEnabled) { res.status(403).json({ error: "用户注册功能未开启" }); return; }
		const settings = await getCommentSettings();
		if (!settings.commentRegistrationEnabled) { res.status(403).json({ error: "用户注册功能未开启" }); return; }
		const input = commentRegistrationInput.parse(req.body);
		const account = (input.account ?? input.username ?? "").trim();
		if (!account) { res.status(400).json({ error: "请输入账号" }); return; }
		if (settings.emailRegistrationEnabled) {
			if (!input.email || !input.emailCode || !(await verifyCommentEmailCode(input.email, input.emailCode))) { res.status(400).json({ error: "邮箱验证码错误或已过期" }); return; }
		}
		const avatar = input.avatar?.trim() || undefined;
		const user = await registerCommentUser({ account, nickname: input.nickname, password: input.password, email: input.email, avatar, avatarSource: input.avatarSource, registrationIp: requestClientIp(req) });
		const login = features.loginEnabled ? await authenticateCommentUser(account, input.password) : null;
		if (features.loginEnabled && !login) { res.status(500).json({ error: "注册成功但登录会话创建失败" }); return; }
		res.status(201).json({ ...(login ?? {}), user });
	} catch (error) { next(error); }
});

app.post("/api/user/auth/register", async (req, res, next) => {
	try {
		const response = await fetch(`http://127.0.0.1:${config.port}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
		const payload = await response.json();
		res.status(response.status).json(payload);
	} catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.loginEnabled) { res.status(403).json({ error: "用户登录功能未开启" }); return; }
		const input = commentLoginInput.parse(req.body);
		const result = await authenticateCommentUser(input.account ?? input.username ?? input.email ?? "", input.password);
		if (!result) { res.status(401).json({ error: "账号或密码错误" }); return; }
		res.json(result);
	} catch (error) { next(error); }
});
app.post("/api/user/auth/login", async (req, res, next) => {
	try {
		const features = await getFeatureSettings();
		if (!features.loginEnabled) { res.status(403).json({ error: "用户登录功能未开启" }); return; }
		const input = commentLoginInput.parse(req.body);
		const result = await authenticateCommentUser(input.account ?? input.username ?? input.email ?? "", input.password);
		if (!result) { res.status(401).json({ error: "账号或密码错误" }); return; }
		res.json(result);
	} catch (error) { next(error); }
});
app.get("/api/auth/me", loadCommentUser, (req: RequestWithCommentUser, res) => res.json({ user: req.commentUser ?? null }));
app.get("/api/user/auth/me", loadCommentUser, (req: RequestWithCommentUser, res) => res.json({ user: req.commentUser ?? null }));
app.post("/api/auth/logout", loadCommentUser, async (req, res, next) => {
	try { const token = req.header("authorization")?.replace(/^Bearer\s+/iu, "").trim() ?? ""; await revokeCommentSession(token); res.status(204).end(); } catch (error) { next(error); }
});
app.post("/api/user/auth/logout", loadCommentUser, async (req, res, next) => {
	try { const token = req.header("authorization")?.replace(/^Bearer\s+/iu, "").trim() ?? ""; await revokeCommentSession(token); res.status(204).end(); } catch (error) { next(error); }
});

// The compiler is intentionally behind both the feature flag and the normal
// comment-user session guard. Keeping the aliases here lets the frontend use
// either the historical /api/compiler path or the /api/user namespace.
const compilerRequestInput = z.object({
	language: z.string().trim().min(1).max(32),
	code: z.string().min(1).max(config.compiler.maxSourceBytes),
	stdin: z.string().max(config.compiler.maxStdinBytes).optional(),
	timeoutMs: z.coerce.number().int().min(250).max(config.compiler.maxTimeoutMs).optional(),
	breakpoints: z.array(z.coerce.number().int().min(1).max(100000)).max(200).optional(),
	debug: z.boolean().optional(),
}).strict();
const compilerRoutePaths = (name: string) => [`/api/compiler/${name}`, `/api/user/compiler/${name}`];

function compilerErrorResponse(error: unknown, res: Response, next: NextFunction) {
	if (error instanceof CompilerError) {
		res.status(error.statusCode).json({ error: error.message, code: error.code });
		return;
	}
	next(error);
}

app.get(compilerRoutePaths("languages"), requireFeature("compilerEnabled", "在线编译功能当前已关闭"), requireCommentUser, (_req: RequestWithCommentUser, res) => {
	const languages = listCompilerLanguages();
	res.json({ items: languages, languages });
});

app.post(compilerRoutePaths("run"), requireFeature("compilerEnabled", "在线编译功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const input = compilerRequestInput.parse(req.body);
		res.json(await executeCompiler({ ...input, debug: input.debug === true }));
	} catch (error) {
		compilerErrorResponse(error, res, next);
	}
});

app.post(compilerRoutePaths("debug"), requireFeature("compilerEnabled", "在线编译功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const input = compilerRequestInput.parse(req.body);
		res.json(await executeCompiler({ ...input, debug: true }));
	} catch (error) {
		compilerErrorResponse(error, res, next);
	}
});

app.post(compilerRoutePaths("format"), requireFeature("compilerEnabled", "在线编译功能当前已关闭"), requireCommentUser, (req: RequestWithCommentUser, res, next) => {
	try {
		const input = z.object({ language: z.string().trim().min(1).max(32), code: z.string() }).strict().parse(req.body);
		const formattedCode = formatCompilerCode(input.language, input.code);
		res.json({ language: input.language.trim().toLowerCase(), code: formattedCode, formattedCode });
	} catch (error) {
		compilerErrorResponse(error, res, next);
	}
});

const userProfilePatchInput = z.object({
	nickname: z.string().trim().min(1).max(120).optional(),
	account: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	email: z.union([z.string().trim().email().max(190), z.literal(""), z.null()]).optional(),
	avatar: z.union([z.string().trim().max(1000).refine((value) => /^(?:https?:\/\/|\/)/iu.test(value), "头像地址必须是 http(s) 或站内路径"), z.literal(""), z.null()]).optional(),
	password: z.string().min(6).max(200).optional(),
	currentPassword: z.string().max(200).optional(),
	emailCode: z.string().trim().regex(/^\d{6}$/u).optional(),
});

app.get("/api/user/space", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try { res.json(await getUserSpace(req.commentUser!.id)); } catch (error) { next(error); }
});
app.get("/api/user/storage", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图床功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try { res.json(await listUserStorageItems(req.commentUser!.id)); } catch (error) { next(error); }
});
app.post("/api/user/storage", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图床功能当前已关闭"), requireCommentUser, userImageUploadRoute("image_host", false));
app.get("/api/user/storage/:id/file", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图床功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const id = parseCommentUserId(String(req.params.id));
		if (!id) { res.status(400).json({ error: "资源编号无效" }); return; }
		const item = await getUserStorageItem(req.commentUser!.id, id);
		if (!item) { res.status(404).json({ error: "资源不存在" }); return; }
		const filePath = safeUserStoragePath(item.storageKey ?? "");
		if (!filePath) { res.status(404).json({ error: "资源文件不存在" }); return; }
		res.type(item.mimeType);
		res.sendFile(filePath, (error) => { if (error && !res.headersSent) next(error); });
	} catch (error) { next(error); }
});
app.patch("/api/user/storage/:id", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图床功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const id = parseCommentUserId(String(req.params.id));
		if (!id) { res.status(400).json({ error: "资源编号无效" }); return; }
		if (typeof req.body?.isPublic !== "boolean") { res.status(400).json({ error: "公开状态无效" }); return; }
		const item = await updateUserStorageVisibility(req.commentUser!.id, id, req.body.isPublic);
		if (!item) { res.status(404).json({ error: "资源不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
});
app.delete("/api/user/storage/:id", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图床功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const id = parseCommentUserId(String(req.params.id));
		if (!id) { res.status(400).json({ error: "资源编号无效" }); return; }
		const deleted = await deleteUserStorageItem(req.commentUser!.id, id);
		if (!deleted) { res.status(404).json({ error: "资源不存在" }); return; }
		await removeUserStorageFile(deleted.storageKey);
		res.status(204).end();
	} catch (error) { next(error); }
});

app.get("/api/user/clipboards", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("clipboardEnabled", "在线剪贴板功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try { res.json(await listUserClipboards(req.commentUser!.id)); } catch (error) { next(error); }
});
app.post("/api/user/clipboards", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("clipboardEnabled", "在线剪贴板功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const input = z.object({ title: z.string().trim().max(255).optional(), content: z.string().max(USER_SPACE_QUOTA_BYTES).default(""), isPublic: z.boolean().optional() }).parse(req.body);
		res.status(201).json(await createUserClipboard({ userId: req.commentUser!.id, title: input.title, content: input.content, isPublic: input.isPublic }));
	} catch (error) { next(error); }
});
app.get("/api/user/clipboards/:id", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("clipboardEnabled", "在线剪贴板功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const id = parseCommentUserId(String(req.params.id));
		if (!id) { res.status(400).json({ error: "剪贴板编号无效" }); return; }
		const item = await getUserClipboard(req.commentUser!.id, id);
		if (!item) { res.status(404).json({ error: "剪贴板不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
});
app.patch("/api/user/clipboards/:id", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("clipboardEnabled", "在线剪贴板功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const id = parseCommentUserId(String(req.params.id));
		if (!id) { res.status(400).json({ error: "剪贴板编号无效" }); return; }
		const input = z.object({ title: z.string().trim().max(255).optional(), content: z.string().max(USER_SPACE_QUOTA_BYTES).optional(), isPublic: z.boolean().optional() }).parse(req.body);
		const item = await updateUserClipboard(req.commentUser!.id, id, input);
		if (!item) { res.status(404).json({ error: "剪贴板不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
});
app.delete("/api/user/clipboards/:id", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("clipboardEnabled", "在线剪贴板功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const id = parseCommentUserId(String(req.params.id));
		if (!id) { res.status(400).json({ error: "剪贴板编号无效" }); return; }
		const ok = await deleteUserClipboard(req.commentUser!.id, id);
		res.status(ok ? 204 : 404).end();
	} catch (error) { next(error); }
});

app.get("/api/public/resources/:token", requireFeature("publicResourcesEnabled", "公开资源访问当前已关闭"), async (req, res, next) => {
	try {
		const token = String(req.params.token ?? "").trim();
		if (!/^[A-Za-z0-9_-]{20,80}$/u.test(token)) { res.status(404).json({ error: "公开资源不存在" }); return; }
		const result = await getPublicUserResource(token);
		if (!result) { res.status(404).json({ error: "公开资源不存在或已关闭" }); return; }
		if (result.type === "image") {
			const filePath = safeUserStoragePath(result.item.storageKey ?? "");
			if (!filePath) { res.status(404).json({ error: "公开资源文件不存在" }); return; }
			res.type(result.item.mimeType);
			res.sendFile(filePath, (error) => { if (error && !res.headersSent) next(error); });
			return;
		}
		res.json({ type: "clipboard", id: result.item.id, title: result.item.title, content: result.item.content ?? "", byteSize: result.item.byteSize, viewCount: result.item.viewCount, updatedAt: result.item.updatedAt });
	} catch (error) { next(error); }
});

app.get("/api/user/profile", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const user = await getCommentUserById(req.commentUser!.id);
		if (!user) { res.status(404).json({ error: "用户不存在" }); return; }
		res.json(user);
	} catch (error) { next(error); }
});
app.post("/api/user/profile/email-code", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const settings = await getCommentSettings();
		if (!settings.emailRegistrationEnabled) { res.status(400).json({ error: "邮箱验证码功能未开启" }); return; }
		const user = await getCommentUserById(req.commentUser!.id);
		const requested = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
		const email = user?.email || requested;
		if (!email) { res.status(400).json({ error: "请先填写邮箱" }); return; }
		res.json(await requestCommentEmailCode(z.string().email().max(190).parse(email)));
	} catch (error) { next(error); }
});
app.patch("/api/user/profile", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const input = userProfilePatchInput.parse(req.body);
		const current = await getCommentUserById(req.commentUser!.id);
		if (!current) { res.status(404).json({ error: "用户不存在" }); return; }
		const sensitive = input.account !== undefined || input.email !== undefined || input.password !== undefined;
		if (input.password !== undefined && (!input.currentPassword || !(await verifyCommentUserPassword(current.id, input.currentPassword)))) { res.status(400).json({ error: "修改密码需要填写正确的当前密码" }); return; }
		if (sensitive && (await getCommentSettings()).emailRegistrationEnabled) {
			const verificationEmail = current.email || (typeof input.email === "string" ? input.email : "");
			if (!verificationEmail || !input.emailCode || !(await verifyCommentEmailCode(verificationEmail, input.emailCode))) { res.status(400).json({ error: "邮箱验证码错误或已过期" }); return; }
		}
		const ok = await updateCommentUser(current.id, { account: input.account, nickname: input.nickname, email: input.email === undefined ? undefined : (input.email || null), avatar: input.avatar === undefined ? undefined : (input.avatar || null), password: input.password });
		if (!ok) { res.status(400).json({ error: "资料未发生变化" }); return; }
		res.json(await getCommentUserById(current.id));
	} catch (error) { next(error); }
});

function handlePublicUpload(upload: multer.Multer, field: string) {
	return (req: Request, res: Response, next: NextFunction) => {
		upload.single(field)(req, res, async (error) => {
			if (error) { next(error); return; }
			if (!req.file) { res.status(400).json({ error: "请选择图片文件" }); return; }
			res.status(201).json(uploadResponse(req.file));
		});
	};
}

app.post("/api/uploads/avatar", requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图片上传功能当前已关闭"), loadCommentUser, (req: RequestWithCommentUser, res, next) => {
	if (req.commentUser) { userImageUploadRoute("avatar", true)(req, res, next); return; }
	handlePublicUpload(avatarUpload, "file")(req, res, next);
});
app.post("/api/uploads/avatar/comment-image", requireFeature("commentsEnabled", "评论功能当前已关闭"), requireFeature("imageHostingEnabled", "图片上传功能当前已关闭"), loadCommentUser, (req: RequestWithCommentUser, res, next) => {
	if (req.commentUser) { userImageUploadRoute("comment_image", true)(req, res, next); return; }
	handlePublicUpload(commentImageUpload, "file")(req, res, next);
});
app.post("/api/uploads/comment-image", requireFeature("commentsEnabled", "评论功能当前已关闭"), requireFeature("imageHostingEnabled", "图片上传功能当前已关闭"), loadCommentUser, (req: RequestWithCommentUser, res, next) => {
	if (req.commentUser) { userImageUploadRoute("comment_image", true)(req, res, next); return; }
	handlePublicUpload(commentImageUpload, "file")(req, res, next);
});

app.get("/api/emojis", requireFeature("commentsEnabled", "评论功能当前已关闭"), loadCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try { res.json(await listCommentStickers(req.commentUser?.id ?? null)); } catch (error) { next(error); }
});
app.get("/api/auth/me/stickers", requireFeature("commentsEnabled", "评论功能当前已关闭"), requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try { res.json(await listCommentStickers(req.commentUser?.id ?? null)); } catch (error) { next(error); }
});
app.get("/api/user/stickers", requireFeature("commentsEnabled", "评论功能当前已关闭"), requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try { res.json(await listCommentStickers(req.commentUser?.id ?? null)); } catch (error) { next(error); }
});
app.post("/api/user/stickers", requireFeature("commentsEnabled", "评论功能当前已关闭"), requireFeature("userCenterEnabled", "用户中心功能当前已关闭"), requireFeature("imageHostingEnabled", "图片上传功能当前已关闭"), requireCommentUser, (req: RequestWithCommentUser, res, next) => {
	stickerUpload.single("file")(req, res, async (error) => {
		if (error) { next(error); return; }
		try {
			if (!req.file || !req.commentUser) { res.status(400).json({ error: "请选择表情图片" }); return; }
			const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : "我的表情";
			const item = await createUserSticker({ userId: req.commentUser.id, name, imageUrl: uploadResponse(req.file).url, mimeType: req.file.mimetype, byteSize: req.file.size });
			res.status(201).json(item);
		} catch (uploadError) { next(uploadError); }
	});
});

app.get("/api/admin/audit-logs", requireAdmin, async (req, res, next) => {
	try {
		const rawIsAdmin = typeof req.query.isAdmin === "string" ? req.query.isAdmin.trim().toLowerCase() : "";
		const isAdmin = rawIsAdmin === "true" || rawIsAdmin === "1" ? true : rawIsAdmin === "false" || rawIsAdmin === "0" ? false : undefined;
		const viewMode = req.query.viewMode === "ip" ? "ip" : "timeline";
		const actorRole = typeof req.query.actorRole === "string"
			? req.query.actorRole
			: typeof req.query.role === "string" ? req.query.role : undefined;
		res.json(await listAuditLogs({
			page: parsePositiveInteger(req.query.page, 1, 1_000_000),
			limit: parsePositiveInteger(req.query.limit, 50, 200),
			groupLogPreviewLimit: parsePositiveInteger(req.query.groupLogPreviewLimit, 5, 50),
			keyword: queryText(req.query.keyword),
			method: queryText(req.query.method),
			actorRole,
			isAdmin,
			path: queryText(req.query.path),
			viewMode,
		}));
	} catch (error) { next(error); }
});

app.post("/api/admin/audit-logs/clear", requireAdmin, async (_req, res, next) => {
	try {
		const deleted = await clearAuditLogs();
		res.json({ ok: true, deleted });
	} catch (error) { next(error); }
});

app.delete("/api/admin/audit-logs/clear", requireAdmin, async (_req, res, next) => {
	try {
		const deleted = await clearAuditLogs();
		res.json({ ok: true, deleted });
	} catch (error) { next(error); }
});

function databaseErrorCode(error: unknown) {
	if (typeof error !== "object" || error === null || !("code" in error)) return null;
	return String((error as { code?: unknown }).code ?? "") || null;
}

const unavailableDatabaseErrors = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"PROTOCOL_CONNECTION_LOST",
	"PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
	"PROTOCOL_PACKETS_OUT_OF_ORDER",
]);

const conflictingDatabaseErrors = new Set([
	"ER_DUP_ENTRY",
	"ER_NO_REFERENCED_ROW_2",
	"ER_ROW_IS_REFERENCED_2",
	"ER_CHECK_CONSTRAINT_VIOLATED",
]);

const invalidDatabaseValueErrors = new Set([
	"ER_BAD_NULL_ERROR",
	"ER_DATA_TOO_LONG",
	"ER_TRUNCATED_WRONG_VALUE",
	"ER_WARN_DATA_OUT_OF_RANGE",
]);

app.get("/api/health", async (_req, res) => {
	try {
		await pingDatabase();
		res.json({ status: "ok", database: "connected" });
	} catch {
		res.status(503).json({ status: "degraded", database: "unavailable" });
	}
});

app.get("/api/site", async (_req, res, next) => {
	try {
		const [summary, categories, tags, announcement] = await Promise.all([siteSummary(), listCategories(), listTags(), getCurrentAnnouncement()]);
		const favicon = typeof summary.site.siteFavicon === "string" ? summary.site.siteFavicon.trim() : "";
		const videoUploadLimit = Number(summary.site.videoUploadMaxSizeMb);
		res.json({
			...summary.site,
			title: summary.site.title ?? "Firefly",
			subtitle: summary.site.subtitle ?? "Demo site",
			description: summary.site.description ?? "Firefly 是一款清新美观的个人博客。",
			hue: summary.site.hue ?? 165,
			siteFavicon: favicon,
			videoUploadMaxSizeMb: Number.isInteger(videoUploadLimit) && videoUploadLimit >= 1 && videoUploadLimit <= 2048 ? videoUploadLimit : 1024,
			videoAutoTranscodeEnabled: summary.site.videoAutoTranscodeEnabled === true,
			runtime: {
				application: applicationMetadata,
				node: process.version,
				platform: process.platform,
				architecture: process.arch,
				startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
			},
			...summary,
			categories,
			tags,
			announcement: {
				content: announcement.content,
				updatedAt: announcement.updatedAt,
				displayItems: announcement.displayItems,
			},
		});
	} catch (error) {
		next(error);
	}
});

async function respondAuthorProfile(_req: Request, res: Response, next: NextFunction) {
	try {
		const [author, heatmap] = await Promise.all([getAuthorProfile(), getAuthorProfileActivity()]);
		res.json({ author, heatmap });
	} catch (error) { next(error); }
}

app.get("/api/author-profile", respondAuthorProfile);
app.get("/api/site/author-profile", respondAuthorProfile);

const WALLPAPER_FETCH_TIMEOUT_MS = 12_000;
const WALLPAPER_MAX_BYTES = 12 * 1024 * 1024;
const WALLPAPER_MAX_REDIRECTS = 5;

function isPrivateIpAddress(address: string) {
	const ip = address.toLowerCase();
	if (ip === "::1" || ip === "::" || ip === "0.0.0.0") return true;
	if (ip.startsWith("::ffff:")) return isPrivateIpAddress(ip.slice(7));
	if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
	if (/^172\.(1[6-9]|2\d|3[0-1])\./u.test(ip)) return true;
	if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;
	return false;
}

async function assertPublicHttpUrl(value: string) {
	let parsed: URL;
	try { parsed = new URL(value); } catch { throw new Error("壁纸地址无效"); }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("壁纸地址无效");
	if (parsed.username || parsed.password) throw new Error("壁纸地址无效");
	const hostname = parsed.hostname.toLowerCase();
	if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) {
		throw new Error("壁纸地址不可用");
	}
	const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((item) => item.address);
	if (!addresses.length || addresses.some(isPrivateIpAddress)) throw new Error("壁纸地址不可用");
	return parsed;
}

function sniffImageType(buffer: Buffer) {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
	if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return "image/avif";
	return "";
}

function wallpaperFilename(url: URL, contentType: string) {
	const raw = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
	if (/\.(?:jpe?g|png|gif|webp|avif|bmp)$/iu.test(raw)) return raw.slice(-120);
	if (contentType.includes("png")) return "wallpaper.png";
	if (contentType.includes("webp")) return "wallpaper.webp";
	if (contentType.includes("avif")) return "wallpaper.avif";
	if (contentType.includes("gif")) return "wallpaper.gif";
	return "wallpaper.jpg";
}

async function fetchRemoteWallpaper(initialUrl: string) {
	let current = initialUrl;
	for (let hop = 0; hop <= WALLPAPER_MAX_REDIRECTS; hop++) {
		const url = await assertPublicHttpUrl(current);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), WALLPAPER_FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(url, {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
				headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8", "user-agent": "FireflyBlogWallpaper/1.0" },
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (!location) throw new Error("壁纸跳转失败");
				current = new URL(location, url).href;
				continue;
			}
			if (!response.ok) throw new Error("壁纸获取失败");
			const declaredLength = Number(response.headers.get("content-length") || 0);
			if (declaredLength > WALLPAPER_MAX_BYTES) throw new Error("壁纸文件过大");
			const buffer = Buffer.from(await response.arrayBuffer());
			if (buffer.length > WALLPAPER_MAX_BYTES) throw new Error("壁纸文件过大");
			const sniffed = sniffImageType(buffer);
			const reported = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
			const contentType = sniffed || (reported.startsWith("image/") ? reported : "");
			if (!contentType) throw new Error("壁纸不是图片");
			return { buffer, contentType, filename: wallpaperFilename(url, contentType) };
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error("壁纸跳转次数过多");
}

app.get("/api/wallpaper", async (_req, res, next) => {
	try {
		const summary = await siteSummary();
		const cover = summary.site.cover && typeof summary.site.cover === "object" && !Array.isArray(summary.site.cover)
			? summary.site.cover as Record<string, unknown>
			: {};
		const mode = cover.mode === "api" || cover.mode === "url" || cover.mode === "upload" ? cover.mode : "";
		const source = String(mode === "api" ? (cover.apiUrl || cover.value || "") : (cover.value || "")).trim();
		if (!source || source.startsWith("/")) {
			res.status(404).json({ error: "当前未使用在线壁纸接口" });
			return;
		}
		const wallpaper = await fetchRemoteWallpaper(source);
		res.setHeader("content-type", wallpaper.contentType);
		res.setHeader("cache-control", "no-store");
		res.setHeader("content-disposition", `inline; filename="${wallpaper.filename.replace(/["\\\r\n]/gu, "")}"`);
		res.send(wallpaper.buffer);
	} catch (error) {
		next(error);
	}
});

const managedPageKeyInput = z.enum(["about", "transfer", "issues"]);
const friendLinkUrlInput = z.string().trim().min(1).max(2000).refine((value) => {
	if (value.startsWith("/")) return true;
	try { return ["http:", "https:"].includes(new URL(value).protocol.toLowerCase()); } catch { return false; }
}, "友情链接地址必须是站内路径或 http(s) 地址");
const friendLinkInput = z.object({
	name: z.string().trim().min(1).max(120),
	url: friendLinkUrlInput,
	logo: friendLinkUrlInput.optional().or(z.literal("")),
	description: z.string().trim().max(500).optional(),
});
const managedPageInput = z.object({
	page: managedPageKeyInput,
	title: z.string().trim().min(1).max(255),
	content: z.string().max(200000),
	friendLinksIntro: z.string().trim().max(500).optional(),
	friendLinks: z.array(friendLinkInput).max(50).optional(),
});

function requestedManagedPage(req: Request) {
	return typeof req.params.page === "string" ? req.params.page : typeof req.query.page === "string" ? req.query.page : typeof req.body?.page === "string" ? req.body.page : "";
}

async function respondManagedPage(req: Request, res: Response, next: NextFunction) {
	try {
		const page = managedPageKeyInput.safeParse(requestedManagedPage(req));
		if (!page.success) { res.status(404).json({ error: "页面不存在" }); return; }
		const item = await getManagedPage(page.data);
		if (!item) { res.status(404).json({ error: "页面不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
}

app.get("/api/site/pages/content", respondManagedPage);
app.get("/api/pages/content", respondManagedPage);
app.get("/api/site/pages/:page", respondManagedPage);
app.get("/api/pages/:page", respondManagedPage);

function changelogPublicResponse(item: Awaited<ReturnType<typeof getChangelog>>) {
	if (!item) return null;
	return { ...item, publishedAt: item.date, status: item.published ? "published" : "draft" };
}

app.get("/api/site/changelog", async (req, res, next) => {
	try {
		const limit = parsePositiveInteger(req.query.limit, 100, 200);
		res.json((await listChangelogs({ publishedOnly: true, limit })).map((item) => changelogPublicResponse(item)));
	} catch (error) { next(error); }
});
app.get("/api/changelog", async (req, res, next) => {
	try {
		const limit = parsePositiveInteger(req.query.limit, 100, 200);
		res.json((await listChangelogs({ publishedOnly: true, limit })).map((item) => changelogPublicResponse(item)));
	} catch (error) { next(error); }
});

async function respondFeedbackSettings(_req: Request, res: Response, next: NextFunction) {
	try {
		const setting = await getSiteSetting("feedback");
		const value = isRecord(setting) ? setting : {};
		res.json({ enabled: value.enabled !== false && value.feedbackEnabled !== false, maxFiles: Number(value.maxFiles ?? 2) || 2, maxFileSizeMb: Number(value.maxFileSizeMb ?? 20) || 20 });
	} catch (error) { next(error); }
}
app.get("/api/site/feedback/settings", respondFeedbackSettings);
app.get("/api/feedback/settings", respondFeedbackSettings);

const publicFeedbackInput = z.object({
	category: z.string().trim().min(1).max(32).optional(),
	subject: z.string().trim().min(1).max(160),
	content: z.string().trim().min(1).max(20000),
	contact: z.string().trim().max(254).optional(),
	pageUrl: z.string().trim().max(1024).optional(),
});
async function submitPublicFeedback(req: Request, res: Response, next: NextFunction) {
	try {
		const setting = await getSiteSetting("feedback");
		const value = isRecord(setting) ? setting : {};
		if (value.enabled === false || value.feedbackEnabled === false) { res.status(403).json({ error: "反馈入口当前未开放" }); return; }
		const input = publicFeedbackInput.parse(req.body);
		const item = await createFeedback({ ...input, clientIp: requestClientIp(req), clientUa: (req.header("user-agent") ?? "").slice(0, 512) });
		res.status(201).json({ ok: true, id: item?.id ?? null, item });
	} catch (error) { next(error); }
}
app.post("/api/site/feedback", submitPublicFeedback);
app.post("/api/feedback", submitPublicFeedback);

async function respondAdminManagedPage(req: Request, res: Response, next: NextFunction) {
	try {
		const rawPage = typeof req.query.page === "string" ? req.query.page : undefined;
		if (!rawPage) { res.json(await listManagedPages()); return; }
		const page = managedPageKeyInput.safeParse(rawPage);
		if (!page.success) { res.status(400).json({ error: "页面标识无效" }); return; }
		const item = await getManagedPage(page.data);
		if (!item) { res.status(404).json({ error: "页面不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
}

async function saveAdminManagedPage(req: Request, res: Response, next: NextFunction) {
	try {
		const input = managedPageInput.parse({ ...(isRecord(req.body) ? req.body : {}), page: req.body?.page ?? req.query.page });
		const item = await saveManagedPage({
			...input,
			friendLinks: input.friendLinks?.map((link) => ({ ...link, logo: link.logo ?? "", description: link.description ?? "" })),
		});
		if (!item) { res.status(400).json({ error: "页面标识无效" }); return; }
		res.json(item);
	} catch (error) { next(error); }
}

app.get("/api/admin/pages/content", requireAdmin, respondAdminManagedPage);
app.post("/api/admin/pages/content", requireAdmin, saveAdminManagedPage);
app.put("/api/admin/pages/content", requireAdmin, saveAdminManagedPage);

const changelogDateInput = z.union([
	z.string().trim().max(80).refine((value) => !Number.isNaN(Date.parse(value)), "日期格式无效"),
	z.null(),
]).optional();
const adminChangelogInput = z.object({
	slug: z.string().trim().max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/u).optional(),
	title: z.string().trim().min(1).max(255).optional(),
	version: z.string().trim().max(80).optional(),
	publishedAt: changelogDateInput,
	date: changelogDateInput,
	status: z.enum(["draft", "published"]).optional(),
	published: z.boolean().optional(),
	content: z.string().max(200000).optional(),
}).passthrough();

function sqlDate(value: string | null | undefined) {
	if (value === undefined) return undefined;
	if (value === null || value.trim() === "") return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const pad = (part: number) => String(part).padStart(2, "0");
	return String(date.getUTCFullYear()) + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate()) + " " + pad(date.getUTCHours()) + ":" + pad(date.getUTCMinutes()) + ":" + pad(date.getUTCSeconds());
}

function changelogSlug(title: string, version: string, provided?: string) {
	const base = (provided ?? (title + "-" + version)).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
	return (base || "changelog") + "-" + Date.now().toString(36);
}

function adminChangelogResponse(item: Awaited<ReturnType<typeof getChangelog>>) {
	if (!item) return null;
	return { ...item, date: item.date, published: item.published, publishedAt: item.date, status: item.published ? "published" : "draft" };
}

app.get("/api/admin/changelog", requireAdmin, async (req, res, next) => {
	try {
		const limit = parsePositiveInteger(req.query.limit, 200, 200);
		res.json({ items: (await listChangelogs({ limit })).map(adminChangelogResponse) });
	} catch (error) { next(error); }
});
app.get("/api/admin/changelog/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "更新日志编号无效" }); return; }
		const item = await getChangelog(id);
		if (!item) { res.status(404).json({ error: "更新日志不存在" }); return; }
		res.json(adminChangelogResponse(item));
	} catch (error) { next(error); }
});
app.post("/api/admin/changelog", requireAdmin, async (req, res, next) => {
	try {
		const input = adminChangelogInput.parse(req.body);
		if (!input.title?.trim() || input.content === undefined) { res.status(400).json({ error: "标题和正文不能为空" }); return; }
		const published = input.published ?? input.status === "published";
		const item = await createChangelog({ slug: changelogSlug(input.title, input.version ?? "", input.slug), title: input.title, version: input.version ?? "", date: sqlDate(input.publishedAt ?? input.date), published, content: input.content });
		res.status(201).json(adminChangelogResponse(item));
	} catch (error) { next(error); }
});
async function updateAdminChangelog(req: Request, res: Response, next: NextFunction) {
	try {
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "更新日志编号无效" }); return; }
		const input = adminChangelogInput.parse(req.body);
		const item = await updateChangelog(id, { slug: input.slug, title: input.title, version: input.version, date: sqlDate(input.publishedAt ?? input.date), published: input.published ?? (input.status === undefined ? undefined : input.status === "published"), content: input.content });
		if (!item) { res.status(404).json({ error: "更新日志不存在" }); return; }
		res.json(adminChangelogResponse(item));
	} catch (error) { next(error); }
}
app.put("/api/admin/changelog/:id", requireAdmin, updateAdminChangelog);
app.patch("/api/admin/changelog/:id", requireAdmin, updateAdminChangelog);
app.delete("/api/admin/changelog/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "更新日志编号无效" }); return; }
		res.status(await deleteChangelog(id) ? 204 : 404).end();
	} catch (error) { next(error); }
});

app.get("/api/admin/feedback", requireAdmin, async (req, res, next) => {
	try {
		const status = typeof req.query.status === "string" ? z.enum(["open", "processing", "resolved"]).parse(req.query.status) : undefined;
		res.json(await listAdminFeedback({ page: parsePositiveInteger(req.query.page, 1, 100000), limit: parsePositiveInteger(req.query.limit, 20, 100), status, keyword: queryText(req.query.keyword) }));
	} catch (error) { next(error); }
});
app.get("/api/admin/feedback/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "反馈编号无效" }); return; }
		const item = await getFeedback(id);
		if (!item) { res.status(404).json({ error: "反馈不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
});
const feedbackStatusInput = z.object({ status: z.enum(["open", "processing", "resolved"]) });
async function updateAdminFeedback(req: Request, res: Response, next: NextFunction) {
	try {
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "反馈编号无效" }); return; }
		const item = await updateFeedbackStatus(id, feedbackStatusInput.parse(req.body).status);
		if (!item) { res.status(404).json({ error: "反馈不存在" }); return; }
		res.json(item);
	} catch (error) { next(error); }
}
app.patch("/api/admin/feedback/:id", requireAdmin, updateAdminFeedback);
app.put("/api/admin/feedback/:id", requireAdmin, updateAdminFeedback);
app.delete("/api/admin/feedback/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: "反馈编号无效" }); return; }
		res.status(await deleteFeedback(id) ? 204 : 404).end();
	} catch (error) { next(error); }
});

app.get("/api/posts", async (req, res, next) => {
	try {
		const page = parsePositiveInteger(req.query.page, 1, 100000);
		const pageSize = parsePositiveInteger(req.query.pageSize, 10, 50);
		const category = typeof req.query.category === "string" ? req.query.category : undefined;
		const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
		const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : undefined;
		res.json(await listPosts({ page, pageSize, category, tag, query }));
	} catch (error) {
		next(error);
	}
});

app.get("/api/posts/:slug", async (req, res, next) => {
	try {
		const post = await getPostBySlug(req.params.slug);
		if (!post) {
			res.status(404).json({ error: "Post not found" });
			return;
		}
		res.json(post);
	} catch (error) {
		next(error);
	}
});

app.get("/api/categories", async (_req, res, next) => {
	try {
		res.json(await listCategories());
	} catch (error) {
		next(error);
	}
});

app.get("/api/tags", async (_req, res, next) => {
	try {
		res.json(await listTags());
	} catch (error) {
		next(error);
	}
});

app.get("/api/archive", async (_req, res, next) => {
	try {
		res.json(await archivePosts());
	} catch (error) {
		next(error);
	}
});

app.get("/api/dynamics", async (_req, res, next) => {
	try {
		const { dynamics } = await siteSummary();
		res.json(dynamics);
	} catch (error) {
		next(error);
	}
});

app.get("/api/allPostMeta.json", async (_req, res, next) => {
	try {
		const posts = await listPosts({ page: 1, pageSize: 50 });
		res.json(posts.items);
	} catch (error) {
		next(error);
	}
});

app.get("/api/rss.xml", async (_req, res, next) => {
	try {
		const posts = await listPosts({ page: 1, pageSize: 50 });
		const escapeXml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
		const siteOrigin = config.clientOrigin.split(",")[0].trim().replace(/\/+$/u, "");
		const items = posts.items.map((post) => `<item><title>${escapeXml(post.title)}</title><link>${siteOrigin}/posts/${post.slug}</link><description>${escapeXml(post.excerpt)}</description><pubDate>${post.publishedAt ?? ""}</pubDate><guid>${post.slug}</guid></item>`).join("");
		res.type("application/rss+xml").send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Firefly</title><link>${siteOrigin}/</link><description>Firefly Demo site</description>${items}</channel></rss>`);
	} catch (error) {
		next(error);
	}
});

app.get("/api/posts/:postId/comments", requireFeature("commentsEnabled", "评论功能当前已关闭"), async (req, res, next) => {
	try {
		const postId = Number(req.params.postId);
		if (!Number.isInteger(postId) || postId < 1) {
			res.status(400).json({ error: "Invalid post id" });
			return;
		}
		res.json(await getComments(postId));
	} catch (error) {
		next(error);
	}
});

const commentInput = z.object({
	postId: z.coerce.number().int().positive(),
	authorName: z.string().trim().min(1).max(120).optional(),
	authorEmail: z.string().email().max(190).optional().nullable(),
	avatar: z.string().trim().max(512).optional().nullable(),
	body: z.string().trim().min(1).max(20000),
	parentId: z.coerce.number().int().positive().optional().nullable(),
	images: z.array(z.string().trim().min(1).max(2000).refine((value) => /^(?:https?:|\/api\/uploads\/|\/api\/public\/resources\/[A-Za-z0-9_-]{20,80}$)/iu.test(value), "Unsupported image URL")).max(3).optional(),
	stickerId: z.coerce.number().int().positive().optional().nullable(),
	personalStickerId: z.coerce.number().int().positive().optional().nullable(),
});

app.post("/api/comments", requireFeature("commentsEnabled", "评论功能当前已关闭"), loadCommentUser, async (req: RequestWithCommentUser, res, next) => {
	try {
		const settings = await getCommentSettings();
		if (!settings.commentsEnabled) { res.status(403).json({ error: "评论功能当前已关闭" }); return; }
		const input = commentInput.parse(req.body);
		if (!req.commentUser && !settings.allowAnonymous) { res.status(401).json({ error: "请登录后发表评论" }); return; }
		const ua = req.header("user-agent") ?? "";
		const user = req.commentUser;
		const id = await createComment({
			postId: input.postId,
			userId: user?.id,
			authorName: user?.nickname ?? input.authorName ?? "匿名用户",
			authorEmail: user?.email ?? input.authorEmail ?? undefined,
			authorAvatar: user?.avatar ?? input.avatar ?? undefined,
			body: input.body,
			parentId: input.parentId,
			images: input.images,
			clientIp: requestClientIp(req),
			ipLocation: "",
			clientBrowser: requestClientBrowser(ua),
			clientOs: requestClientOs(ua),
			clientDevice: requestClientDevice(ua),
			clientUa: ua.slice(0, 512),
			status: settings.commentModerationEnabled ? "pending" : "approved",
			isAdmin: user?.isAdmin,
			stickerId: input.stickerId,
			personalStickerId: input.personalStickerId,
		});
		res.status(201).json({ id, status: settings.commentModerationEnabled ? "pending" : "approved" });
	} catch (error) {
		next(error);
	}
});

app.post("/api/uploads/comment-images", requireFeature("commentsEnabled", "评论功能当前已关闭"), requireFeature("imageHostingEnabled", "图片上传功能当前已关闭"), (req, res, next) => {
	commentImageUpload.array("files", 3)(req, res, (error) => {
		if (error) { next(error); return; }
		const files = (req.files as Express.Multer.File[] | undefined) ?? [];
		if (!files.length) { res.status(400).json({ error: "请选择图片" }); return; }
		res.status(201).json({ items: files.map(uploadResponse) });
	});
});

const postInput = z.object({
	slug: z.string().trim().regex(/^[a-z0-9][a-z0-9/-]*$/u).max(180),
	filename: z.string().trim().max(255).nullable().optional(),
	title: z.string().trim().min(1).max(255),
	excerpt: z.string().trim().min(1).max(5000),
	content: z.string().trim().min(1),
	cover: z.string().trim().max(500).nullable().optional(),
	topImage: z.string().trim().max(500).nullable().optional(),
	categorySlug: z.string().trim().max(100).nullable().optional(),
	categoryName: z.string().trim().max(80).nullable().optional(),
	categoryNames: z.preprocess((value) => typeof value === "string" ? value.split(/[,，]/u) : value, z.array(z.string().trim().max(80)).max(24)).optional(),
	tagSlugs: z.array(z.string().trim().max(100)).max(12).optional(),
	tagNames: z.preprocess((value) => typeof value === "string" ? value.split(/[,，]/u) : value, z.array(z.string().trim().max(80)).max(12)).optional(),
	publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
	pinned: z.boolean().optional(),
	status: z.enum(["draft", "published"]).optional(),
});

const taxonomyInput = z.object({
	name: z.string().trim().min(1).max(80),
	slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/u).max(100),
});
const categoryInput = taxonomyInput.extend({ description: z.string().trim().max(255).optional() });
const dynamicInput = z.object({
	body: z.string().trim().min(1).max(10000),
	images: z.array(z.string().trim().min(1).max(2000).refine((value) => /^(?:https?:|\/)/iu.test(value), "Unsupported image URL")).max(9).optional(),
	publishedAt: z.string().datetime({ offset: true }).optional(),
});
const announcementContent = z.string().trim().min(1).max(20000);
const currentAnnouncementContent = z.string().trim().max(20000);
const announcementDate = z.string().trim().max(80).datetime({ offset: true });
const announcementInput = z.object({ content: announcementContent, publishedAt: announcementDate.optional().nullable() });
const currentAnnouncementInput = z.object({ content: currentAnnouncementContent, publishedAt: announcementDate.optional().nullable() });
const announcementDisplayInput = z.object({ isVisible: z.boolean().optional(), isPinned: z.boolean().optional(), sortOrder: z.number().int().min(-100000).max(100000).optional() });

app.post("/api/admin/posts", requireAdmin, async (req, res, next) => {
	try {
		const id = await createPost(postInput.parse(req.body));
		res.status(201).json({ id });
	} catch (error) {
		next(error);
	}
});

app.get("/api/admin/posts", requireAdmin, async (req, res, next) => {
	try {
		const page = parsePositiveInteger(req.query.page, 1, 100000);
		const pageSize = parsePositiveInteger(req.query.pageSize, 20, 100);
		const status = typeof req.query.status === "string" ? req.query.status : undefined;
		const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : undefined;
		res.json(await listAdminPosts({ page, pageSize, status, query }));
	} catch (error) { next(error); }
});

app.get("/api/admin/posts/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid post id" }); return; }
		const post = await getAdminPost(id);
		if (!post) { res.status(404).json({ error: "Post not found" }); return; }
		res.json(post);
	} catch (error) { next(error); }
});

app.put("/api/admin/posts/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid post id" }); return; }
		const post = await updatePost(id, postInput.parse(req.body));
		if (!post) { res.status(404).json({ error: "Post not found" }); return; }
		res.json(post);
	} catch (error) { next(error); }
});

app.delete("/api/admin/posts/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) {
			res.status(400).json({ error: "Invalid post id" });
			return;
		}
		const deleted = await deletePost(id);
		res.status(deleted ? 204 : 404).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/admin/taxonomy", requireAdmin, async (_req, res, next) => {
	try { res.json({ categories: await listAllCategories(), tags: await listAllTags() }); } catch (error) { next(error); }
});
app.post("/api/admin/categories", requireAdmin, async (req, res, next) => {
	try { res.status(201).json({ id: await createCategory(categoryInput.parse(req.body)) }); } catch (error) { next(error); }
});
app.put("/api/admin/categories/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await updateCategory(Number(req.params.id), categoryInput.parse(req.body)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.delete("/api/admin/categories/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await deleteCategory(Number(req.params.id)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.post("/api/admin/tags", requireAdmin, async (req, res, next) => {
	try { res.status(201).json({ id: await createTag(taxonomyInput.parse(req.body)) }); } catch (error) { next(error); }
});
app.put("/api/admin/tags/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await updateTag(Number(req.params.id), taxonomyInput.parse(req.body)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.delete("/api/admin/tags/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await deleteTag(Number(req.params.id)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});

app.get("/api/admin/dynamics", requireAdmin, async (_req, res, next) => {
	try { res.json(await listAllDynamics()); } catch (error) { next(error); }
});
app.post("/api/admin/dynamics", requireAdmin, async (req, res, next) => {
	try { res.status(201).json({ id: await createDynamic(dynamicInput.parse(req.body)) }); } catch (error) { next(error); }
});
app.put("/api/admin/dynamics/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await updateDynamic(Number(req.params.id), dynamicInput.parse(req.body)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.delete("/api/admin/dynamics/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await deleteDynamic(Number(req.params.id)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});

app.get("/api/admin/comments", requireAdmin, async (req, res, next) => {
	try { res.json(await listAdminComments(typeof req.query.status === "string" ? req.query.status : undefined)); } catch (error) { next(error); }
});

// Comment system administration is kept separate from the site presentation
// settings so a deployment can turn moderation and mail notifications on
// without changing the public site payload.
const adminCommentSettingsInput = z.object({
	commentsEnabled: z.boolean().optional(),
	commentRegistrationEnabled: z.boolean().optional(),
	commentModerationEnabled: z.boolean().optional(),
	allowAnonymous: z.boolean().optional(),
	emailRegistrationEnabled: z.boolean().optional(),
	avatarPresets: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
	smtpHost: z.string().trim().max(255).optional(),
	smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
	smtpSecure: z.boolean().optional(),
	smtpUsername: z.string().trim().max(255).optional(),
	smtpPassword: z.string().max(255).optional(),
	senderEmail: z.union([z.string().trim().email().max(190), z.literal("")]).optional(),
	senderName: z.string().trim().max(120).optional(),
	notificationEmails: z.union([z.array(z.string().trim().email().max(190)).max(30), z.string().max(4000)]).optional(),
	notifyNewUser: z.boolean().optional(),
	notifyNewComment: z.boolean().optional(),
	notifyPendingComment: z.boolean().optional(),
}).passthrough();

function normalizeNotificationEmails(value: unknown) {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;,\n]/u) : [];
	return values.map((item) => String(item).trim().toLowerCase()).filter(Boolean).slice(0, 30);
}

function publicCommentSettings(value: Record<string, unknown>, basic: unknown) {
	const safe = { ...value };
	delete safe.smtpPassword;
	return { ...safe, ...(basic && typeof basic === "object" ? basic : {}), smtpPassword: "", notificationEmails: normalizeNotificationEmails(value.notificationEmails) };
}

app.get("/api/admin/comment-settings", requireAdmin, async (_req, res, next) => {
	try {
		const [stored, basic] = await Promise.all([getSiteSetting("comments"), getCommentSettings()]);
		const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
		res.json(publicCommentSettings(value, basic));
	} catch (error) { next(error); }
});

const featureSettingsInput = z.object({
	commentsEnabled: z.boolean().optional(),
	registrationEnabled: z.boolean().optional(),
	loginEnabled: z.boolean().optional(),
	imageHostingEnabled: z.boolean().optional(),
	clipboardEnabled: z.boolean().optional(),
	userCenterEnabled: z.boolean().optional(),
	publicResourcesEnabled: z.boolean().optional(),
	compilerEnabled: z.boolean().optional(),
}).strict();

app.get("/api/admin/features", requireAdmin, async (_req, res, next) => {
	try {
		res.json(await getFeatureSettings());
	} catch (error) {
		next(error);
	}
});

async function saveAdminFeatures(req: Request, res: Response, next: NextFunction) {
	try {
		const patch = featureSettingsInput.parse(req.body);
		const value = { ...await getFeatureSettings(), ...patch };
		await saveSiteSetting("features", value);
		res.json(normalizeFeatureSettings(value));
	} catch (error) {
		next(error);
	}
}

app.patch("/api/admin/features", requireAdmin, saveAdminFeatures);
app.put("/api/admin/features", requireAdmin, saveAdminFeatures);

app.get("/api/admin/settings/comments", requireAdmin, async (_req, res, next) => {
	try {
		const [stored, basic] = await Promise.all([getSiteSetting("comments"), getCommentSettings()]);
		const value = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
		res.json(publicCommentSettings(value, basic));
	} catch (error) { next(error); }
});
async function saveAdminCommentSettings(req: Request, res: Response, next: NextFunction) {
	try {
		const patch = adminCommentSettingsInput.parse(req.body);
		const existingValue = await getSiteSetting("comments");
		const existing = existingValue && typeof existingValue === "object" ? existingValue as Record<string, unknown> : {};
		const value: Record<string, unknown> = { ...existing, ...patch };
		if (patch.notificationEmails !== undefined) value.notificationEmails = normalizeNotificationEmails(patch.notificationEmails);
		// An empty password from the UI means “keep the current secret”.
		if (patch.smtpPassword === "" && typeof existing.smtpPassword === "string" && existing.smtpPassword) value.smtpPassword = existing.smtpPassword;
		await saveSiteSetting("comments", value);
		res.json(publicCommentSettings(value, await getCommentSettings()));
	} catch (error) { next(error); }
}
app.put("/api/admin/comment-settings", requireAdmin, saveAdminCommentSettings);
app.put("/api/admin/settings/comments", requireAdmin, saveAdminCommentSettings);

const adminCommentUserBaseInput = z.object({
	username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	account: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	nickname: z.string().trim().min(1).max(120),
	email: z.union([z.string().trim().email().max(190), z.literal(""), z.null()]).optional(),
	avatar: z.union([z.string().trim().max(512).regex(/^(?:https?:\/\/|\/)/iu), z.literal(""), z.null()]).optional(),
	password: z.string().min(6).max(200).optional(),
	isActive: z.boolean().optional(),
	role: z.string().trim().max(40).optional(),
	isAdmin: z.boolean().optional(),
});
const adminCommentUserInput = adminCommentUserBaseInput.refine((value) => Boolean(value.username?.trim() || value.account?.trim()), { message: "请输入用户账号", path: ["username"] });
const adminCommentUserUpdateInput = z.object({
	username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	account: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/u).optional(),
	nickname: z.string().trim().min(1).max(120).optional(),
	email: z.union([z.string().trim().email().max(190), z.literal(""), z.null()]).optional(),
	avatar: z.union([z.string().trim().max(512).regex(/^(?:https?:\/\/|\/)/iu), z.literal(""), z.null()]).optional(),
	password: z.string().min(6).max(200).optional(),
	isActive: z.boolean().optional(),
	role: z.string().trim().max(40).optional(),
	isAdmin: z.boolean().optional(),
});
const adminCommentUserCreateInput = adminCommentUserBaseInput.extend({ password: z.string().min(6).max(200) }).refine((value) => Boolean(value.username?.trim() || value.account?.trim()), { message: "请输入用户账号", path: ["username"] });
const adminCommentPasswordInput = z.object({ password: z.string().min(6).max(200) });
function parseCommentUserId(value: string) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; }
function commentUserAccount(input: { username?: string; account?: string }) { return (input.account ?? input.username ?? "").trim(); }
function commentUserIsAdmin(input: { role?: string; isAdmin?: boolean }) { return input.isAdmin ?? (input.role === "admin" || input.role === "moderator"); }
app.get("/api/admin/users", requireAdmin, async (_req, res, next) => { try { res.json(await listAdminCommentUsers()); } catch (error) { next(error); } });
app.get("/api/admin/comment-users", requireAdmin, async (_req, res, next) => { try { res.json(await listAdminCommentUsers()); } catch (error) { next(error); } });
app.post("/api/admin/users", requireAdmin, async (req, res, next) => {
	try {
		const input = adminCommentUserCreateInput.parse(req.body);
		const user = await registerCommentUser({ account: commentUserAccount(input), nickname: input.nickname, password: input.password, email: input.email, avatar: input.avatar, avatarSource: input.avatar ? "url" : "preset", registrationIp: requestClientIp(req) });
		if (commentUserIsAdmin(input)) await updateCommentUser(user.id, { isAdmin: true });
		res.status(201).json({ id: user.id });
	} catch (error) { next(error); }
});
app.post("/api/admin/comment-users", requireAdmin, async (req, res, next) => {
	try {
		const input = adminCommentUserCreateInput.parse(req.body);
		const user = await registerCommentUser({ account: commentUserAccount(input), nickname: input.nickname, password: input.password, email: input.email, avatar: input.avatar, avatarSource: input.avatar ? "url" : "preset", registrationIp: requestClientIp(req) });
		if (commentUserIsAdmin(input)) await updateCommentUser(user.id, { isAdmin: true });
		res.status(201).json({ id: user.id });
	} catch (error) { next(error); }
});
async function updateCommentUserRoute(req: Request, res: Response, next: NextFunction) {
	try {
		const id = parseCommentUserId(String(req.params.id)); if (!id) { res.status(400).json({ error: "用户编号无效" }); return; }
		const input = adminCommentUserUpdateInput.parse(req.body);
		const patch: Parameters<typeof updateCommentUser>[1] = {};
		if (input.account !== undefined || input.username !== undefined) patch.account = input.account ?? input.username;
		if (input.nickname !== undefined) patch.nickname = input.nickname;
		if (input.email !== undefined) patch.email = input.email;
		if (input.avatar !== undefined) patch.avatar = input.avatar;
		if (input.password !== undefined) patch.password = input.password;
		if (input.isActive !== undefined) patch.isActive = input.isActive;
		if (input.isAdmin !== undefined || input.role !== undefined) patch.isAdmin = commentUserIsAdmin(input);
		const ok = await updateCommentUser(id, patch);
		res.status(ok ? 204 : 404).end();
	} catch (error) { next(error); }
}
app.patch("/api/admin/users/:id", requireAdmin, updateCommentUserRoute);
app.put("/api/admin/users/:id", requireAdmin, updateCommentUserRoute);
app.patch("/api/admin/comment-users/:id", requireAdmin, updateCommentUserRoute);
app.put("/api/admin/comment-users/:id", requireAdmin, updateCommentUserRoute);

function adminSpaceResourceUrl(userId: number, itemId: number) {
	return `/api/admin/user-space/${userId}/items/${itemId}/file`;
}

app.get("/api/admin/user-space", requireAdmin, async (_req, res, next) => {
	try { res.json(await listAdminUserSpace()); } catch (error) { next(error); }
});
app.get("/api/admin/user-space/:userId", requireAdmin, async (req, res, next) => {
	try {
		const userId = parseCommentUserId(String(req.params.userId));
		if (!userId) { res.status(400).json({ error: "用户编号无效" }); return; }
		if (!await getCommentUserById(userId)) { res.status(404).json({ error: "用户不存在" }); return; }
		const detail = await listAdminUserResources(userId);
		res.json({ ...detail, items: detail.items.map((item) => ({ ...item, url: item.storageKey ? adminSpaceResourceUrl(userId, Number(item.id)) : item.url })) });
	} catch (error) { next(error); }
});
app.get("/api/admin/user-space/:userId/items/:itemId/file", requireAdmin, async (req, res, next) => {
	try {
		const userId = parseCommentUserId(String(req.params.userId));
		const itemId = parseCommentUserId(String(req.params.itemId));
		if (!userId || !itemId) { res.status(400).json({ error: "资源编号无效" }); return; }
		const item = await getUserStorageItem(userId, itemId);
		if (!item) { res.status(404).json({ error: "资源不存在" }); return; }
		const filePath = safeUserStoragePath(item.storageKey ?? "");
		if (!filePath) { res.status(404).json({ error: "资源文件不存在" }); return; }
		res.type(item.mimeType);
		res.sendFile(filePath, (error) => { if (error && !res.headersSent) next(error); });
	} catch (error) { next(error); }
});
app.delete("/api/admin/user-space/:userId/items/:itemId", requireAdmin, async (req, res, next) => {
	try {
		const userId = parseCommentUserId(String(req.params.userId));
		const itemId = parseCommentUserId(String(req.params.itemId));
		if (!userId || !itemId) { res.status(400).json({ error: "资源编号无效" }); return; }
		const deleted = await deleteUserStorageItem(userId, itemId);
		if (!deleted) { res.status(404).json({ error: "资源不存在" }); return; }
		await removeUserStorageFile(deleted.storageKey);
		res.status(204).end();
	} catch (error) { next(error); }
});
app.delete("/api/admin/user-space/:userId/clipboards/:clipboardId", requireAdmin, async (req, res, next) => {
	try {
		const userId = parseCommentUserId(String(req.params.userId));
		const clipboardId = parseCommentUserId(String(req.params.clipboardId));
		if (!userId || !clipboardId) { res.status(400).json({ error: "剪贴板编号无效" }); return; }
		const deleted = await deleteUserClipboard(userId, clipboardId);
		res.status(deleted ? 204 : 404).end();
	} catch (error) { next(error); }
});
app.delete("/api/admin/user-space/:userId/stickers/:stickerId", requireAdmin, async (req, res, next) => {
	try {
		const userId = parseCommentUserId(String(req.params.userId));
		const stickerId = parseCommentUserId(String(req.params.stickerId));
		if (!userId || !stickerId) { res.status(400).json({ error: "表情编号无效" }); return; }
		const deleted = await deleteUserSticker(userId, stickerId);
		res.status(deleted ? 204 : 404).end();
	} catch (error) { next(error); }
});
async function resetCommentUserRoute(req: Request, res: Response, next: NextFunction) {
	try { const id = parseCommentUserId(String(req.params.id)); if (!id) { res.status(400).json({ error: "用户编号无效" }); return; } const ok = await resetCommentUserPassword(id, adminCommentPasswordInput.parse(req.body).password); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
}
app.post("/api/admin/users/:id/reset-password", requireAdmin, resetCommentUserRoute);
app.post("/api/admin/comment-users/:id/reset-password", requireAdmin, resetCommentUserRoute);
async function deleteCommentUserRoute(req: Request, res: Response, next: NextFunction) {
	try { const id = parseCommentUserId(String(req.params.id)); if (!id) { res.status(400).json({ error: "用户编号无效" }); return; } const ok = await deleteCommentUser(id); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
}
app.delete("/api/admin/users/:id", requireAdmin, deleteCommentUserRoute);
app.delete("/api/admin/comment-users/:id", requireAdmin, deleteCommentUserRoute);

app.get("/api/admin/emojis", requireAdmin, async (_req, res, next) => { try { res.json(await listCommentStickers()); } catch (error) { next(error); } });
app.get("/api/admin/comment-emojis", requireAdmin, async (_req, res, next) => { try { res.json(await listCommentStickers()); } catch (error) { next(error); } });
const adminEmojiInput = z.object({ name: z.string().trim().min(1).max(120), url: z.string().trim().min(1).max(1000), imageUrl: z.string().trim().min(1).max(1000).optional(), mimeType: z.string().trim().max(128).optional(), size: z.coerce.number().int().min(0).max(20 * 1024 * 1024).optional(), byteSize: z.coerce.number().int().min(0).max(20 * 1024 * 1024).optional() });
async function createAdminEmojiRoute(req: Request, res: Response, next: NextFunction) { try { const input = adminEmojiInput.parse(req.body); const id = await createSharedCommentSticker({ name: input.name, imageUrl: input.imageUrl ?? input.url, mimeType: input.mimeType, byteSize: input.byteSize ?? input.size }); res.status(201).json({ id, name: input.name, url: input.imageUrl ?? input.url }); } catch (error) { next(error); } }
app.post("/api/admin/emojis", requireAdmin, createAdminEmojiRoute);
app.post("/api/admin/comment-emojis", requireAdmin, createAdminEmojiRoute);
async function deleteAdminEmojiRoute(req: Request, res: Response, next: NextFunction) { try { const id = parseCommentUserId(String(req.params.id)); if (!id) { res.status(400).json({ error: "表情编号无效" }); return; } const ok = await deleteSharedCommentSticker(id); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); } }
app.delete("/api/admin/emojis/:id", requireAdmin, deleteAdminEmojiRoute);
app.delete("/api/admin/comment-emojis/:id", requireAdmin, deleteAdminEmojiRoute);

const adminUserCreateInput = z.object({ username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/u), password: z.string().min(8).max(200), displayName: z.string().trim().max(120).optional(), role: z.enum(["admin", "superadmin"]).optional() });
const adminUserUpdateInput = z.object({ username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9_.-]+$/u).optional(), password: z.string().min(8).max(200).optional(), displayName: z.string().trim().max(120).optional(), role: z.enum(["admin", "superadmin"]).optional(), isActive: z.boolean().optional() });
const adminPasswordInput = z.object({ password: z.string().min(8).max(200) });
function parseAdminUserId(value: string) {
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function ensureOtherUser(req: RequestWithAdmin, res: Response, id: number | null): id is number {
	if (id === null) { res.status(400).json({ error: "管理员账号编号无效" }); return false; }
	if (req.adminUser?.id !== null && req.adminUser?.id === id) { res.status(400).json({ error: "不能管理当前登录账号" }); return false; }
	return true;
}
app.get("/api/admin/accounts", requireAdmin, async (req: RequestWithAdmin, res, next) => {
	try { res.json(await listAdminUsers()); } catch (error) { next(error); }
});
app.post("/api/admin/accounts", requireAdmin, async (req: RequestWithAdmin, res, next) => {
	try { const input = adminUserCreateInput.parse(req.body); const id = await createAdminUser(input); res.status(201).json({ id }); } catch (error) { next(error); }
});
app.put("/api/admin/accounts/:id", requireAdmin, async (req: RequestWithAdmin, res, next) => {
	try { const id = parseAdminUserId(typeof req.params.id === "string" ? req.params.id : ""); if (!ensureOtherUser(req, res, id)) return; const ok = await updateAdminUser(id, adminUserUpdateInput.parse(req.body)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.post("/api/admin/accounts/:id/reset-password", requireAdmin, async (req: RequestWithAdmin, res, next) => {
	try { const id = parseAdminUserId(typeof req.params.id === "string" ? req.params.id : ""); if (!ensureOtherUser(req, res, id)) return; const ok = await resetAdminPassword(id, adminPasswordInput.parse(req.body).password); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.delete("/api/admin/accounts/:id", requireAdmin, async (req: RequestWithAdmin, res, next) => {
	try { const id = parseAdminUserId(typeof req.params.id === "string" ? req.params.id : ""); if (!ensureOtherUser(req, res, id)) return; const ok = await deleteAdminUser(id); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.patch("/api/admin/comments/:id", requireAdmin, async (req, res, next) => {
	try { const status = z.enum(["pending", "approved", "spam"]).parse(req.body?.status); const ok = await updateCommentStatus(Number(req.params.id), status); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});
app.delete("/api/admin/comments/:id", requireAdmin, async (req, res, next) => {
	try { const ok = await deleteComment(Number(req.params.id)); res.status(ok ? 204 : 404).end(); } catch (error) { next(error); }
});

async function respondWithAdminSite(_req: Request, res: Response, next: NextFunction) {
	try {
		const [setting, author] = await Promise.all([getSiteSetting("site"), getAuthorProfile()]);
		res.json({ ...(isRecord(setting) ? setting : {}), author });
	} catch (error) { next(error); }
}

app.get("/api/admin/site", requireAdmin, respondWithAdminSite);
app.get("/api/admin/site-settings", requireAdmin, respondWithAdminSite);

app.get("/api/admin/dashboard", requireAdmin, async (_req, res, next) => {
	try {
		const database = await getDatabaseStatus();
		res.json({ administrator: { name: config.adminName }, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), checkedAt: database.checkedAt, lastSyncAt: database.lastWriteAt, lastDatabaseActivityAt: database.lastActivityAt, database });
	} catch (error) { next(error); }
});

app.get("/api/admin/db-status", requireAdmin, async (_req, res, next) => {
	try {
		const database = await getDatabaseStatus();
		res.json({ administrator: { name: config.adminName }, checkedAt: database.checkedAt, lastSyncAt: database.lastWriteAt, lastDatabaseActivityAt: database.lastActivityAt, database });
	} catch (error) { next(error); }
});

app.get("/api/admin/monitoring", requireAdmin, async (req, res, next) => {
	try {
		const hoursValue = Number(req.query.hours);
		const hours = hoursValue === 1 || hoursValue === 6 || hoursValue === 24 || hoursValue === 168 ? hoursValue : 24;
		const range = ({ 1: "1h", 6: "6h", 24: "24h", 168: "7d" } as const)[hours];
		const [database] = await Promise.all([getDatabaseStatus()]);
		const metrics = getRequestMetrics(range, config.monitorSlowRequestMs, config.monitorSlowSqlMs);
		res.json({
			available: true,
			hours,
			generatedAt: new Date().toISOString(),
			thresholds: { slowRequestMs: config.monitorSlowRequestMs, slowSqlMs: config.monitorSlowSqlMs },
			resources: { server: getProcessSnapshot(), project: { name: "firefly-api", startedAt: metrics.collectedSince, database } },
			summary: { ...metrics.requests, slowSql: metrics.sql.slow, sql: metrics.sql },
			trend: metrics.trends,
			paths: metrics.frequentPaths,
			recent: metrics.recentExceptions,
			retention: metrics.retention,
			dataScope: metrics.retention.truncated
				? "当前时间范围已超过内存保留上限；请求和 SQL 各仅保留最近 " + metrics.retention.maxRecordsPerStream + " 条记录。"
				: "请求和 SQL 指标从本次 API 进程启动后开始在内存中采集，每类最多保留 " + metrics.retention.maxRecordsPerStream + " 条记录。",
		});
	} catch (error) { next(error); }
});

app.get("/api/admin/announcement", requireAdmin, async (_req, res, next) => {
	try { res.json(await getCurrentAnnouncement()); } catch (error) { next(error); }
});
app.post("/api/admin/announcement", requireAdmin, async (req, res, next) => {
	try {
		const input = currentAnnouncementInput.parse(req.body);
		res.json(await saveAnnouncement(input.content, input.publishedAt));
	} catch (error) { next(error); }
});
app.get("/api/admin/announcements/history", requireAdmin, async (req, res, next) => {
	try {
		const page = parsePositiveInteger(req.query.page, 1, 100000);
		const limit = parsePositiveInteger(req.query.limit, 20, 100);
		const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim().slice(0, 200) : undefined;
		res.json(await listAnnouncementHistory({ page, limit, keyword }));
	} catch (error) { next(error); }
});
app.post("/api/admin/announcements/history", requireAdmin, async (req, res, next) => {
	try {
		const item = await createAnnouncementHistory(announcementInput.parse(req.body));
		if (!item) { res.status(500).json({ error: "Announcement history insert failed" }); return; }
		res.status(201).json({ ok: true, item });
	} catch (error) { next(error); }
});
app.put("/api/admin/announcements/history/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid announcement id" }); return; }
		const item = await updateAnnouncementHistory(id, announcementInput.parse(req.body));
		if (!item) { res.status(404).json({ error: "Announcement history not found" }); return; }
		res.json({ ok: true, item });
	} catch (error) { next(error); }
});
app.patch("/api/admin/announcements/history/:id/display", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid announcement id" }); return; }
		const item = await updateAnnouncementHistoryDisplay(id, announcementDisplayInput.parse(req.body));
		if (!item) { res.status(404).json({ error: "Announcement history not found" }); return; }
		res.json({ ok: true, item });
	} catch (error) { next(error); }
});
app.delete("/api/admin/announcements/history/:id", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid announcement id" }); return; }
		const deleted = await deleteAnnouncementHistory(id);
		res.status(deleted ? 204 : 404).end();
	} catch (error) { next(error); }
});
app.post("/api/admin/announcements/history/:id/publish", requireAdmin, async (req, res, next) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: "Invalid announcement id" }); return; }
		const current = await publishAnnouncementHistory(id);
		if (!current) { res.status(404).json({ error: "Announcement history not found" }); return; }
		res.json({ ...current, sourceId: String(id) });
	} catch (error) { next(error); }
});
const optionalText = (maximum: number) => z.string().trim().max(maximum).optional();
const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();
const safeUrl = (maximum: number) => z.string().trim().min(1).max(maximum).refine((value) => value.startsWith("/") || /^(?:https?:|mailto:|tel:)/iu.test(value), "Unsupported URL scheme");
const siteAssetUrl = z.string().trim().max(2000).refine((value) => {
	if (!value) return true;
	if (/[\\"'<>\u0000-\u001f\u007f]/u.test(value)) return false;
	if (/^\/(?!\/)/u.test(value)) return true;
	if (!/^https?:\/\//iu.test(value)) return false;
	try {
		const parsed = new URL(value);
		return ["http:", "https:"].includes(parsed.protocol.toLowerCase()) && !parsed.username && !parsed.password;
	} catch { return false; }
}, "Site asset URL must be an http(s) URL or site-relative path");
const authorLinkInput = z.object({ label: z.string().trim().min(1).max(80), url: safeUrl(2000), icon: nullableText(80) });
const authorPatchInput = z.object({
	name: optionalText(120),
	bio: optionalText(255),
	avatar: optionalText(2000),
	email: z.union([z.string().trim().email().max(190), z.literal(""), z.null()]).optional(),
	githubUrl: nullableText(2000),
	qqUrl: nullableText(2000),
	rssUrl: nullableText(2000),
	links: z.array(authorLinkInput).max(24).optional(),
	profile: z.object({
		headline: optionalText(160),
		introduction: optionalText(5000),
		location: optionalText(120),
		website: z.union([safeUrl(2000), z.literal(""), z.null()]).optional(),
		skills: z.array(z.object({ name: z.string().trim().min(1).max(80), level: z.coerce.number().min(0).max(100), description: optionalText(240), icon: nullableText(80) })).max(24).optional(),
		learningProgress: z.array(z.object({ name: z.string().trim().min(1).max(120), progress: z.coerce.number().min(0).max(100), description: optionalText(240), status: nullableText(80) })).max(24).optional(),
	}).partial().optional(),
}).passthrough();
const siteSettingsInput = z.object({
	title: optionalText(120),
	subtitle: optionalText(255),
	description: optionalText(10000),
	hue: z.number().int().min(0).max(360).optional(),
	siteFavicon: siteAssetUrl.optional(),
	videoUploadMaxSizeMb: z.number().int().min(1).max(2048).optional(),
	videoAutoTranscodeEnabled: z.boolean().optional(),
	cover: z.object({ mode: z.enum(["upload", "url", "api"]), value: z.string().trim().max(2000), apiUrl: optionalText(2000), position: optionalText(120) }).passthrough().nullable().optional(),
	titleConfig: z.object({
		title: optionalText(120), subtitle: optionalText(500), subtitleMode: z.enum(["text", "hitokoto"]).optional(), hitokotoApi: optionalText(2000),
		titleFontUrl: optionalText(2000), subtitleFontUrl: optionalText(2000), bodyFontUrl: optionalText(2000), postTitleFontUrl: optionalText(2000), postContentFontUrl: optionalText(2000), tagFontUrl: optionalText(2000),
	}).passthrough().nullable().optional(),
	music: z.object({ enabled: z.boolean().optional(), src: optionalText(2000), title: optionalText(255), artist: optionalText(255), cover: optionalText(2000), autoplay: z.boolean().optional(), loop: z.boolean().optional() }).passthrough().nullable().optional(),
	author: authorPatchInput.nullable().optional(),
}).passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		merged[key] = isRecord(value) && isRecord(merged[key]) ? mergeSettings(merged[key] as Record<string, unknown>, value) : value;
	}
	return merged;
}

async function saveAdminSite(req: Request, res: Response, next: NextFunction) {
	try {
		const parsed = siteSettingsInput.parse(req.body);
		const { author: authorPatch, ...sitePatch } = parsed;
		const [currentSetting, currentAuthor] = await Promise.all([getSiteSetting("site"), getAuthorProfile()]);
		const value = mergeSettings(isRecord(currentSetting) ? currentSetting : {}, sitePatch);
		const author = authorPatch
			? {
				name: authorPatch.name ?? currentAuthor?.name ?? "Firefly",
				bio: authorPatch.bio ?? currentAuthor?.bio ?? "",
				avatar: authorPatch.avatar ?? currentAuthor?.avatar ?? "",
				email: authorPatch.email === "" ? null : (authorPatch.email ?? currentAuthor?.email ?? null),
				githubUrl: authorPatch.githubUrl ?? currentAuthor?.githubUrl ?? null, qqUrl: authorPatch.qqUrl ?? currentAuthor?.qqUrl ?? null, rssUrl: authorPatch.rssUrl ?? currentAuthor?.rssUrl ?? null,
				links: authorPatch.links ?? currentAuthor?.links ?? [],
				profile: { ...currentAuthor?.profile, ...authorPatch.profile },
			}
			: undefined;
		await saveSiteConfiguration(value, author);
		res.json({ ...value, author: author ?? currentAuthor });
	} catch (error) { next(error); }
}

app.put("/api/admin/site", requireAdmin, saveAdminSite);
app.put("/api/admin/site-settings", requireAdmin, saveAdminSite);

// The standalone endpoint is intentionally strict about its writable shape.
// Site settings preserve their legacy passthrough behavior independently.
const authorProfileOnlyInput = authorPatchInput.strip().refine((value) => Object.keys(value).length > 0, "author profile patch is required");

app.get("/api/admin/author-profile", requireAdmin, async (_req, res, next) => {
	try {
		const [author, heatmap] = await Promise.all([getAuthorProfile(), getAuthorProfileActivity()]);
		res.json({ author, heatmap });
	} catch (error) { next(error); }
});

app.put("/api/admin/author-profile", requireAdmin, async (req, res, next) => {
	try {
		const patch = authorProfileOnlyInput.parse(req.body);
		const [currentSetting, currentAuthor] = await Promise.all([getSiteSetting("site"), getAuthorProfile()]);
		const author = {
			name: patch.name ?? currentAuthor?.name ?? "Firefly", bio: patch.bio ?? currentAuthor?.bio ?? "", avatar: patch.avatar ?? currentAuthor?.avatar ?? "",
			email: patch.email === "" ? null : (patch.email ?? currentAuthor?.email ?? null), githubUrl: patch.githubUrl ?? currentAuthor?.githubUrl ?? null, qqUrl: patch.qqUrl ?? currentAuthor?.qqUrl ?? null, rssUrl: patch.rssUrl ?? currentAuthor?.rssUrl ?? null, links: patch.links ?? currentAuthor?.links ?? [],
			profile: { ...currentAuthor?.profile, ...patch.profile },
		};
		await saveSiteConfiguration(isRecord(currentSetting) ? currentSetting : {}, author);
		const [saved, heatmap] = await Promise.all([getAuthorProfile(), getAuthorProfileActivity()]);
		res.json({ author: saved, heatmap });
	} catch (error) { next(error); }
});

type AdminMediaType = { extension: string; kind: "image" | "font" | "audio" };
const svgMediaType: AdminMediaType = { extension: ".svg", kind: "image" };
const iconMediaType: AdminMediaType = { extension: ".ico", kind: "image" };
const mediaTypes: Record<string, AdminMediaType> = {
	"image/jpeg": { extension: ".jpg", kind: "image" }, "image/png": { extension: ".png", kind: "image" }, "image/gif": { extension: ".gif", kind: "image" }, "image/webp": { extension: ".webp", kind: "image" }, "image/avif": { extension: ".avif", kind: "image" },
	"image/svg+xml": svgMediaType, "application/xml": svgMediaType, "text/xml": svgMediaType,
	"image/x-icon": iconMediaType, "image/vnd.microsoft.icon": iconMediaType, "image/ico": iconMediaType, "image/icon": iconMediaType, "application/ico": iconMediaType,
	"font/woff": { extension: ".woff", kind: "font" }, "font/woff2": { extension: ".woff2", kind: "font" }, "font/ttf": { extension: ".ttf", kind: "font" }, "font/otf": { extension: ".otf", kind: "font" }, "application/font-woff": { extension: ".woff", kind: "font" }, "application/x-font-ttf": { extension: ".ttf", kind: "font" },
	"audio/mpeg": { extension: ".mp3", kind: "audio" }, "audio/wav": { extension: ".wav", kind: "audio" }, "audio/x-wav": { extension: ".wav", kind: "audio" }, "audio/ogg": { extension: ".ogg", kind: "audio" }, "audio/mp4": { extension: ".m4a", kind: "audio" }, "audio/flac": { extension: ".flac", kind: "audio" },
};
const mediaTypesByExtension: Record<string, AdminMediaType> = {
	".jpg": mediaTypes["image/jpeg"], ".jpeg": mediaTypes["image/jpeg"], ".png": mediaTypes["image/png"], ".gif": mediaTypes["image/gif"], ".webp": mediaTypes["image/webp"], ".avif": mediaTypes["image/avif"],
	".svg": svgMediaType, ".ico": iconMediaType,
	".woff": mediaTypes["font/woff"], ".woff2": mediaTypes["font/woff2"], ".ttf": mediaTypes["font/ttf"], ".otf": mediaTypes["font/otf"],
	".mp3": mediaTypes["audio/mpeg"], ".wav": mediaTypes["audio/wav"], ".ogg": mediaTypes["audio/ogg"], ".oga": mediaTypes["audio/ogg"], ".m4a": mediaTypes["audio/mp4"], ".flac": mediaTypes["audio/flac"],
};

const SVG_MAX_BYTES = 2 * 1024 * 1024;
const ICO_MAX_BYTES = 5 * 1024 * 1024;
const svgMimeTypes = new Set(["image/svg+xml", "application/xml", "text/xml", "application/octet-stream"]);
const icoMimeTypes = new Set(["image/x-icon", "image/vnd.microsoft.icon", "image/ico", "image/icon", "application/ico", "application/octet-stream"]);

function inferMediaType(originalName: string, mimeType: string, requestedKind?: unknown) {
	const normalizedMime = mimeType.toLowerCase();
	const extension = extname(originalName).toLowerCase();
	const byMime = mediaTypes[normalizedMime];
	const byExtension = mediaTypesByExtension[extension];
	if (extension === ".svg" && !svgMimeTypes.has(normalizedMime)) return null;
	if (extension === ".ico" && !icoMimeTypes.has(normalizedMime)) return null;
	if (byMime === svgMediaType && extension !== ".svg") return null;
	if (byMime === iconMediaType && extension !== ".ico") return null;
	const inferred = extension === ".svg" || extension === ".ico" ? byExtension : (byMime ?? byExtension);
	if (!inferred) return null;
	// A multipart `kind` field is advisory, but never permits a mismatched type.
	if (requestedKind === "image" || requestedKind === "font" || requestedKind === "audio") {
		if (inferred.kind !== requestedKind) return null;
	}
	return inferred;
}

function validateSvg(data: Buffer) {
	if (!data.length || data.length > SVG_MAX_BYTES) return "SVG favicon must be between 1 byte and 2 MB";
	const source = data.toString("utf8").replace(/^\uFEFF/u, "").trim();
	if (!source || source.includes("\u0000") || source.includes("\uFFFD")) return "SVG favicon is not valid UTF-8 text";
	const document = source.replace(/^<\?xml\s+[\s\S]*?\?>\s*/iu, "").replace(/^(?:\s|<!--[\s\S]*?-->)+/u, "");
	if (!/^<svg(?:\s|>)/iu.test(document)) return "SVG favicon must have an svg root element";
	if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/iu.test(source)) return "SVG favicon contains unsupported XML declarations";
	if (/<(?:[a-z][\w.-]*:)?(?:script|foreignObject|iframe|object|embed|link|image|audio|video|canvas|style|a|animate|animateMotion|animateTransform|set|discard)\b/iu.test(source)) return "SVG favicon contains active or external content";
	if (/\bon[a-z][\w:.-]*\s*=/iu.test(source) || /(?:javascript|vbscript)\s*:/iu.test(source) || /(?:@import|expression\s*\(|-moz-binding|behavior\s*:)/iu.test(source)) return "SVG favicon contains executable content";
	for (const match of source.matchAll(/\b(?:href|xlink:href|src)\s*=\s*(["'])([\s\S]*?)\1/giu)) {
		if (match[2].trim() && !match[2].trim().startsWith("#")) return "SVG favicon may only use internal fragment references";
	}
	for (const match of source.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu)) {
		if (!match[2].trim().startsWith("#")) return "SVG favicon may only use internal fragment URLs";
	}
	return null;
}

function validateIco(data: Buffer) {
	if (!data.length || data.length > ICO_MAX_BYTES) return "ICO favicon must be between 1 byte and 5 MB";
	if (data.length < 22 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return "ICO favicon has an invalid file header";
	const imageCount = data.readUInt16LE(4);
	const directoryEnd = 6 + imageCount * 16;
	if (imageCount < 1 || imageCount > 256 || data.length < directoryEnd) return "ICO favicon has an invalid image directory";
	for (let index = 0; index < imageCount; index += 1) {
		const entry = 6 + index * 16;
		const byteSize = data.readUInt32LE(entry + 8);
		const offset = data.readUInt32LE(entry + 12);
		if (!byteSize || offset < directoryEnd || offset + byteSize > data.length) return "ICO favicon contains an invalid image entry";
	}
	return null;
}

function validateSensitiveMedia(data: Buffer, originalName: string, mimeType: string, media: AdminMediaType) {
	const extension = extname(originalName).toLowerCase();
	const normalizedMime = mimeType.toLowerCase();
	if (media === svgMediaType) {
		if (extension !== ".svg" || !svgMimeTypes.has(normalizedMime)) return "SVG favicon extension and MIME type do not match";
		return validateSvg(data);
	}
	if (media === iconMediaType) {
		if (extension !== ".ico" || !icoMimeTypes.has(normalizedMime)) return "ICO favicon extension and MIME type do not match";
		return validateIco(data);
	}
	return null;
}
const mediaUpload = multer({
	storage: multer.diskStorage({ destination: uploadsDirectory, filename: (req, file, callback) => { const media = inferMediaType(file.originalname, file.mimetype, req.body?.kind); callback(null, `${Date.now()}-${randomUUID()}${media?.extension ?? extname(file.originalname).toLowerCase()}`); } }),
	limits: { files: 1, fileSize: 50 * 1024 * 1024 },
	fileFilter: (req, file, callback) => inferMediaType(file.originalname, file.mimetype, req.body?.kind) ? callback(null, true) : callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "file")),
});
const dataUploadInput = z.object({ dataUrl: z.string().max(11_000_000), name: z.string().trim().min(1).max(255) });

function mediaResponse(name: string, originalName: string, size: number, mimeType: string, media = mediaTypes[mimeType.toLowerCase()] ?? mediaTypesByExtension[extname(originalName).toLowerCase()]) {
	const url = `/api/uploads/${encodeURIComponent(name)}`;
	return { url, path: url, kind: media?.kind ?? "image", name: originalName, fileName: name, size, mimeType };
}

function uploadMedia(req: Request, res: Response, next: NextFunction) {
	mediaUpload.single("file")(req, res, async (uploadError) => {
		if (uploadError) { next(uploadError); return; }
		try {
			if (req.file) {
				const media = inferMediaType(req.file.originalname, req.file.mimetype);
				const requestedKind = req.body?.kind;
				if (!media || ((requestedKind === "image" || requestedKind === "font" || requestedKind === "audio") && media.kind !== requestedKind)) {
					await unlink(req.file.path).catch(() => undefined);
					res.status(400).json({ error: "Media kind does not match upload" });
					return;
				}
				const exceedsSensitiveLimit = (media === svgMediaType && req.file.size > SVG_MAX_BYTES)
					|| (media === iconMediaType && req.file.size > ICO_MAX_BYTES);
				const validationError = exceedsSensitiveLimit
					? media === svgMediaType ? "SVG favicon must be between 1 byte and 2 MB" : "ICO favicon must be between 1 byte and 5 MB"
					: media === svgMediaType || media === iconMediaType
						? validateSensitiveMedia(await readFile(req.file.path), req.file.originalname, req.file.mimetype, media)
						: null;
				if (validationError) {
					await unlink(req.file.path).catch(() => undefined);
					res.status(400).json({ error: validationError });
					return;
				}
				res.status(201).json(mediaResponse(req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, media));
				return;
			}
			const input = dataUploadInput.parse(req.body);
			const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(input.dataUrl);
			if (!matched) { res.status(400).json({ error: "Unsupported media data URL" }); return; }
			const data = Buffer.from(matched[2], "base64");
			if (!data.length || data.length > 8 * 1024 * 1024) { res.status(400).json({ error: "Invalid media size" }); return; }
			const media = inferMediaType(input.name, matched[1]);
			if (!media) { res.status(400).json({ error: "Unsupported media data URL" }); return; }
			const requestedKind = req.body?.kind;
			if ((requestedKind === "image" || requestedKind === "font" || requestedKind === "audio") && media.kind !== requestedKind) { res.status(400).json({ error: "Media kind does not match data URL" }); return; }
			const validationError = validateSensitiveMedia(data, input.name, matched[1], media);
			if (validationError) { res.status(400).json({ error: validationError }); return; }
			const fileName = `${Date.now()}-${randomUUID()}${media.extension}`;
			await writeFile(fileURLToPath(new URL(fileName, new URL("../../../uploads/", import.meta.url))), data, { flag: "wx" });
			res.status(201).json(mediaResponse(fileName, input.name, data.length, matched[1]));
		} catch (error) {
			if (req.file) await unlink(req.file.path).catch(() => undefined);
			next(error);
		}
	});
}

app.post("/api/admin/media/upload", requireAdmin, uploadMedia);
app.post("/api/admin/uploads", requireAdmin, uploadMedia);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
	if (error instanceof CompilerError) {
		res.status(error.statusCode).json({ error: error.message, code: error.code });
		return;
	}
	if (error instanceof multer.MulterError) {
		res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Media file is too large" : "Unsupported media upload" });
		return;
	}
	if (error instanceof z.ZodError) {
		res.status(400).json({ error: "Invalid request", details: error.flatten() });
		return;
	}
	const code = databaseErrorCode(error);
	if (code && unavailableDatabaseErrors.has(code)) {
		res.status(503).json({ error: "Database unavailable" });
		return;
	}
	if (code && conflictingDatabaseErrors.has(code)) {
		res.status(409).json({ error: "Database conflict" });
		return;
	}
	if (code && invalidDatabaseValueErrors.has(code)) {
		res.status(400).json({ error: "Invalid database value" });
		return;
	}
	console.error(error);
	res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, config.host, () => {
	const displayHost = config.host.includes(":") ? `[${config.host}]` : config.host;
	console.log(`Firefly API listening on http://${displayHost}:${config.port}`);
});
