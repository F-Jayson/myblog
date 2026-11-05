import { unlink } from "node:fs/promises";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import type { Multer } from "multer";
import { z } from "zod";
import {
	agentAnnouncementDisplay,
	agentAnnouncements,
	agentChangelogs,
	agentComments,
	agentDeleteAnnouncement,
	agentDeleteChangelog,
	agentDeleteComment,
	agentDeleteDynamic,
	agentDeleteFeedback,
	agentDeletePage,
	agentDeleteTaxonomy,
	agentDeleteUser,
	agentDynamics,
	agentFeedback,
	agentModerateComment,
	agentPage,
	agentPages,
	agentPublishAnnouncement,
	agentSaveAnnouncement,
	agentSaveChangelog,
	agentSaveDynamic,
	agentSavePage,
	agentSiteOverview,
	agentUpdateCommentSettings,
	agentUpdateFeatures,
	agentUpdateFeedback,
	agentUpdateSite,
	agentUpdateTaxonomy,
	agentUpdateUser,
	agentUsers,
} from "./agentContent.js";
import {
	AgentError,
	assertDeviceStartAllowed,
	approveDeviceRequest,
	deleteAgentPost,
	denyDeviceRequest,
	ensureAgentCategory,
	ensureAgentTag,
	getAgentGrantByToken,
	getDeviceRequestPublic,
	listAgentAudit,
	listAgentCategories,
	listAgentGrants,
	listAgentPosts,
	listAgentTags,
	lookupAgentPost,
	pollDeviceToken,
	recordUpload,
	revokeAgentGrant,
	setAgentPostStatus,
	startDeviceAuthorization,
	upsertAgentDocument,
	type AgentGrant,
	type AgentScope,
} from "./agentStore.js";
import { savePublicFile } from "./storage.js";
import type { AdminPrincipal } from "./repository.js";

type AdminRequest = Request & { adminUser?: AdminPrincipal };
type AgentRequest = Request & { agentGrant?: AgentGrant };

const polls = new Map<string, number>();
const POLL_INTERVAL_MS = 5000;

const upsertSchema = z.object({
	externalKey: z.string().trim().min(1).max(255),
	title: z.string().trim().min(1).max(255),
	content: z.string().max(1_500_000),
	excerpt: z.string().max(2000).optional(),
	slug: z.string().trim().min(1).max(180).optional(),
	categories: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
	tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
	cover: z.string().trim().max(500).nullable().optional(),
	pinned: z.boolean().optional(),
	status: z.enum(["draft", "published"]).optional(),
});

function clientIp(req: Request) {
	const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
	return forwarded || req.ip || req.socket.remoteAddress || "unknown";
}

function sendAgentError(res: Response, error: AgentError) {
	const body: { error: string; message: string; interval?: number } = { error: error.code, message: error.message };
	if (error.code === "authorization_pending" || error.code === "slow_down") body.interval = 5;
	res.status(error.status).json(body);
}

function asyncRoute(handler: (req: AgentRequest, res: Response) => Promise<void>): RequestHandler {
	return (req, res, next) => {
		void handler(req as AgentRequest, res).catch((error: unknown) => {
			if (error instanceof AgentError) { sendAgentError(res, error); return; }
			if (error instanceof z.ZodError) { res.status(400).json({ error: "invalid_request", message: "请求参数不正确" }); return; }
			next(error);
		});
	};
}

function requireAgent(scope?: AgentScope): RequestHandler {
	return (req, res, next) => {
		void (async () => {
			const token = req.header("authorization")?.replace(/^Bearer\s+/iu, "").trim() ?? "";
			const grant = await getAgentGrantByToken(token);
			if (!grant) throw new AgentError(401, "unauthorized", "智能体授权已失效，请重新连接");
			if (scope && !grant.scopes.includes(scope)) throw new AgentError(403, "insufficient_scope", "当前授权不包含这项操作");
			(req as AgentRequest).agentGrant = grant;
			next();
		})().catch((error: unknown) => {
			if (error instanceof AgentError) { sendAgentError(res, error); return; }
			next(error);
		});
	};
}

function positiveId(value: unknown) {
	const id = Number(value);
	if (!Number.isInteger(id) || id < 1) throw new AgentError(400, "invalid_request", "文章编号不正确");
	return id;
}

function pageQuery(req: Request) {
	const page = Number(req.query.page ?? 1);
	const pageSize = Number(req.query.pageSize ?? 20);
	return {
		page: Number.isInteger(page) && page > 0 ? page : 1,
		pageSize: Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 50) : 20,
		status: req.query.status === "draft" || req.query.status === "published" ? req.query.status : undefined,
		query: typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : undefined,
	};
}

export function mountAgentRoutes(app: express.Express, options: { requireAdmin: RequestHandler; imageUpload: Multer }) {
	const router = express.Router();
	router.use((_req, res, next) => { res.setHeader("cache-control", "no-store"); next(); });

	router.post("/device/start", asyncRoute(async (req, res) => {
		assertDeviceStartAllowed(clientIp(req));
		res.status(201).json(await startDeviceAuthorization({ clientName: req.body?.clientName, scopes: req.body?.scopes }));
	}));

	router.post("/device/token", asyncRoute(async (req, res) => {
		const deviceCode = typeof req.body?.deviceCode === "string" ? req.body.deviceCode.trim() : "";
		if (!deviceCode) throw new AgentError(400, "invalid_request", "缺少 deviceCode");
		const now = Date.now();
		const previous = polls.get(deviceCode) ?? 0;
		if (now - previous < POLL_INTERVAL_MS) throw new AgentError(400, "slow_down", "轮询间隔过短");
		polls.set(deviceCode, now);
		res.json(await pollDeviceToken(deviceCode));
	}));

	router.get("/device/:userCode", asyncRoute(async (req, res) => {
		res.json(await getDeviceRequestPublic(String(req.params.userCode ?? "")));
	}));

	router.post("/device/:userCode/approve", options.requireAdmin, asyncRoute(async (req, res) => {
		const admin = (req as AdminRequest).adminUser;
		if (!admin?.id) throw new AgentError(403, "admin_account_required", "请使用数据库中的管理员账号授权。旧版固定令牌不能连接智能体。");
		res.json(await approveDeviceRequest(String(req.params.userCode ?? ""), admin.id, req.body?.scopes));
	}));

	router.post("/device/:userCode/deny", options.requireAdmin, asyncRoute(async (req, res) => {
		const admin = (req as AdminRequest).adminUser;
		if (!admin?.id) throw new AgentError(403, "admin_account_required", "请使用数据库中的管理员账号授权。旧版固定令牌不能连接智能体。");
		res.json(await denyDeviceRequest(String(req.params.userCode ?? ""), admin.id));
	}));

	router.get("/me", requireAgent(), asyncRoute(async (req, res) => {
		const grant = req.agentGrant!;
		res.json({ clientName: grant.clientName, scopes: grant.scopes, expiresAt: grant.expiresAt, admin: { username: grant.username } });
	}));

	router.post("/revoke", requireAgent(), asyncRoute(async (req, res) => {
		await revokeAgentGrant(req.agentGrant!.id, req.agentGrant!.adminUserId, "disconnect");
		res.status(204).end();
	}));

	router.get("/posts", requireAgent("posts:read"), asyncRoute(async (req, res) => {
		res.json(await listAgentPosts(req.agentGrant!, pageQuery(req)));
	}));

	router.get("/posts/lookup", requireAgent("posts:read"), asyncRoute(async (req, res) => {
		const id = req.query.id === undefined ? undefined : positiveId(req.query.id);
		const slug = typeof req.query.slug === "string" ? req.query.slug : undefined;
		const externalKey = typeof req.query.externalKey === "string" ? req.query.externalKey : undefined;
		res.json(await lookupAgentPost(req.agentGrant!, { id, slug, externalKey }));
	}));

	router.get("/posts/:id", requireAgent("posts:read"), asyncRoute(async (req, res) => {
		res.json(await getAgentPostRoute(req));
	}));

	router.post("/posts", requireAgent("posts:write"), asyncRoute(async (req, res) => {
		const input = upsertSchema.parse(req.body);
		const result = await upsertAgentDocument(req.agentGrant!, input);
		res.status(result.action === "created" ? 201 : 200).json(result);
	}));

	router.post("/posts/:id/publish", requireAgent("posts:publish"), asyncRoute(async (req, res) => {
		res.json(await setAgentPostStatus(req.agentGrant!, positiveId(req.params.id), "published"));
	}));

	router.post("/posts/:id/unpublish", requireAgent("posts:write"), asyncRoute(async (req, res) => {
		res.json(await setAgentPostStatus(req.agentGrant!, positiveId(req.params.id), "draft"));
	}));

	router.delete("/posts/:id", requireAgent("posts:delete"), asyncRoute(async (req, res) => {
		res.json(await deleteAgentPost(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.get("/categories", requireAgent("posts:read"), asyncRoute(async (req, res) => {
		res.json(await listAgentCategories(req.agentGrant!));
	}));

	router.post("/categories", requireAgent("posts:write"), asyncRoute(async (req, res) => {
		const name = typeof req.body?.name === "string" ? req.body.name : "";
		const description = typeof req.body?.description === "string" ? req.body.description : undefined;
		res.status(201).json(await ensureAgentCategory(req.agentGrant!, { name, description }));
	}));

	router.get("/tags", requireAgent("posts:read"), asyncRoute(async (req, res) => {
		res.json(await listAgentTags(req.agentGrant!));
	}));

	router.post("/tags", requireAgent("posts:write"), asyncRoute(async (req, res) => {
		const name = typeof req.body?.name === "string" ? req.body.name : "";
		res.status(201).json(await ensureAgentTag(req.agentGrant!, { name }));
	}));

	router.put("/categories/:id", requireAgent("taxonomy:manage"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateTaxonomy(req.agentGrant!, "category", positiveId(req.params.id), req.body));
	}));
	router.delete("/categories/:id", requireAgent("taxonomy:manage"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteTaxonomy(req.agentGrant!, "category", positiveId(req.params.id)));
	}));
	router.put("/tags/:id", requireAgent("taxonomy:manage"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateTaxonomy(req.agentGrant!, "tag", positiveId(req.params.id), req.body));
	}));
	router.delete("/tags/:id", requireAgent("taxonomy:manage"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteTaxonomy(req.agentGrant!, "tag", positiveId(req.params.id)));
	}));

	router.get("/comments", requireAgent("comments:read"), asyncRoute(async (req, res) => {
		res.json(await agentComments(req.agentGrant!, typeof req.query.status === "string" ? req.query.status : undefined));
	}));
	router.post("/comments/:id/status", requireAgent("comments:moderate"), asyncRoute(async (req, res) => {
		res.json(await agentModerateComment(req.agentGrant!, positiveId(req.params.id), req.body?.status));
	}));
	router.delete("/comments/:id", requireAgent("comments:moderate"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteComment(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.get("/dynamics", requireAgent("content:read"), asyncRoute(async (req, res) => {
		res.json(await agentDynamics(req.agentGrant!));
	}));
	router.post("/dynamics", requireAgent("content:publish"), asyncRoute(async (req, res) => {
		const saved = await agentSaveDynamic(req.agentGrant!, undefined, req.body);
		res.status(201).json(saved);
	}));
	router.put("/dynamics/:id", requireAgent("content:publish"), asyncRoute(async (req, res) => {
		res.json(await agentSaveDynamic(req.agentGrant!, positiveId(req.params.id), req.body));
	}));
	router.delete("/dynamics/:id", requireAgent("content:delete"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteDynamic(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.get("/pages", requireAgent("content:read"), asyncRoute(async (req, res) => {
		res.json(await agentPages(req.agentGrant!));
	}));
	router.get("/pages/:page", requireAgent("content:read"), asyncRoute(async (req, res) => {
		res.json(await agentPage(req.agentGrant!, String(req.params.page ?? "")));
	}));
	router.put("/pages", requireAgent("content:publish"), asyncRoute(async (req, res) => {
		res.json(await agentSavePage(req.agentGrant!, req.body));
	}));
	router.delete("/pages/:page", requireAgent("content:delete"), asyncRoute(async (req, res) => {
		res.json(await agentDeletePage(req.agentGrant!, String(req.params.page ?? "")));
	}));

	router.get("/changelogs", requireAgent("content:read"), asyncRoute(async (req, res) => {
		res.json(await agentChangelogs(req.agentGrant!));
	}));
	router.post("/changelogs", requireAgent("content:write"), asyncRoute(async (req, res) => {
		const saved = await agentSaveChangelog(req.agentGrant!, undefined, req.body);
		res.status(201).json(saved);
	}));
	router.put("/changelogs/:id", requireAgent("content:write"), asyncRoute(async (req, res) => {
		res.json(await agentSaveChangelog(req.agentGrant!, positiveId(req.params.id), req.body));
	}));
	router.delete("/changelogs/:id", requireAgent("content:delete"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteChangelog(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.get("/announcements", requireAgent("content:read"), asyncRoute(async (req, res) => {
		const page = Number(req.query.page ?? 1);
		res.json(await agentAnnouncements(req.agentGrant!, Number.isInteger(page) && page > 0 ? page : 1, typeof req.query.q === "string" ? req.query.q : undefined));
	}));
	router.post("/announcements", requireAgent("content:write"), asyncRoute(async (req, res) => {
		const saved = await agentSaveAnnouncement(req.agentGrant!, undefined, req.body);
		res.status(201).json(saved);
	}));
	router.put("/announcements/:id", requireAgent("content:write"), asyncRoute(async (req, res) => {
		res.json(await agentSaveAnnouncement(req.agentGrant!, positiveId(req.params.id), req.body));
	}));
	router.patch("/announcements/:id/display", requireAgent("content:publish"), asyncRoute(async (req, res) => {
		res.json(await agentAnnouncementDisplay(req.agentGrant!, positiveId(req.params.id), req.body));
	}));
	router.post("/announcements/:id/publish", requireAgent("content:publish"), asyncRoute(async (req, res) => {
		res.json(await agentPublishAnnouncement(req.agentGrant!, positiveId(req.params.id)));
	}));
	router.delete("/announcements/:id", requireAgent("content:delete"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteAnnouncement(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.get("/feedback", requireAgent("content:read"), asyncRoute(async (req, res) => {
		const page = Number(req.query.page ?? 1);
		res.json(await agentFeedback(req.agentGrant!, {
			page: Number.isInteger(page) && page > 0 ? page : 1,
			status: typeof req.query.status === "string" ? req.query.status : undefined,
			keyword: typeof req.query.q === "string" ? req.query.q : undefined,
		}));
	}));
	router.post("/feedback/:id/status", requireAgent("content:write"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateFeedback(req.agentGrant!, positiveId(req.params.id), req.body?.status));
	}));
	router.delete("/feedback/:id", requireAgent("content:delete"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteFeedback(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.get("/site", requireAgent("site:read"), asyncRoute(async (req, res) => {
		res.json(await agentSiteOverview(req.agentGrant!));
	}));
	router.patch("/site", requireAgent("site:write"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateSite(req.agentGrant!, req.body));
	}));
	router.patch("/features", requireAgent("site:write"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateFeatures(req.agentGrant!, req.body));
	}));
	router.patch("/comment-settings", requireAgent("site:write"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateCommentSettings(req.agentGrant!, req.body));
	}));

	router.get("/users", requireAgent("users:read"), asyncRoute(async (req, res) => {
		res.json(await agentUsers(req.agentGrant!));
	}));
	router.patch("/users/:id", requireAgent("users:manage"), asyncRoute(async (req, res) => {
		res.json(await agentUpdateUser(req.agentGrant!, positiveId(req.params.id), req.body));
	}));
	router.delete("/users/:id", requireAgent("users:manage"), asyncRoute(async (req, res) => {
		res.json(await agentDeleteUser(req.agentGrant!, positiveId(req.params.id)));
	}));

	router.post("/images", requireAgent("media:write"), (req, res, next) => {
		options.imageUpload.single("file")(req, res, (error) => {
			if (error) { next(error); return; }
			void storeAgentImage(req as AgentRequest, res, next);
		});
	});

	app.use("/api/agent", router);

	app.get("/api/admin/agent-grants", options.requireAdmin, asyncRoute(async (_req, res) => {
		res.json(await listAgentGrants());
	}));
	app.delete("/api/admin/agent-grants/:id", options.requireAdmin, asyncRoute(async (req, res) => {
		const admin = (req as AdminRequest).adminUser;
		const removed = await revokeAgentGrant(positiveId(req.params.id), admin?.id ?? null, "revoke");
		if (!removed) throw new AgentError(404, "not_found", "授权不存在或已经撤销");
		res.status(204).end();
	}));
	app.get("/api/admin/agent-audit", options.requireAdmin, asyncRoute(async (req, res) => {
		const limit = Number(req.query.limit ?? 30);
		res.json(await listAgentAudit(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30));
	}));
}

async function getAgentPostRoute(req: AgentRequest) {
	return lookupAgentPost(req.agentGrant!, { id: positiveId(req.params.id) });
}

async function storeAgentImage(req: AgentRequest, res: Response, next: NextFunction) {
	if (!req.file || !req.agentGrant) { res.status(400).json({ error: "invalid_request", message: "请上传 jpeg、png、gif、webp 或 avif 图片" }); return; }
	try {
		const stored = await savePublicFile({ filename: req.file.filename, localPath: req.file.path, mimeType: req.file.mimetype });
		await recordUpload(req.agentGrant, req.file.originalname || req.file.filename, stored.url);
		res.status(201).json({ url: stored.url, name: req.file.originalname, size: req.file.size, mimeType: req.file.mimetype, markdown: `![](${stored.url})` });
	} catch (error) {
		if (req.file.path) await unlink(req.file.path).catch(() => undefined);
		next(error);
	}
}
