import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { isFeatureKbEnabled, isFeatureKbWriteEnabled } from "./constants.js";
import {
	addCommentService,
	createKnowledgeDocument,
	createShareLinkService,
	createUserLibrary,
	getAuthorizedAttachment,
	getDocumentAccessService,
	getKnowledgeDocument,
	getKnowledgeDocumentRevisions,
	getKnowledgeRevisionDetail,
	getPublicDocumentSnapshotService,
	getSharedDocumentSnapshotService,
	getUserEligibility,
	getUserLibraryTree,
	getVisibleLibraryRecord,
	getUserQuotaUsageService,
	listCommentsService,
	listDocumentAttachmentsService,
	listDocumentShareLinksService,
	listLibraryMembersService,
	listTrashedDocumentsService,
	listUserLibraries,
	moveKnowledgeDocument,
	publishKnowledgeDocumentService,
	registerAttachment,
	removeLibraryMemberService,
	resolveCommentService,
	restoreDocumentRevision,
	restoreKnowledgeDocument,
	revokeShareLinkService,
	saveKnowledgeDocument,
	searchKnowledge,
	trashKnowledgeDocument,
	unpublishKnowledgeDocumentService,
	updateDocumentAccessService,
	upsertLibraryMemberService,
} from "./service.js";
import { getLibraryRecord, softDeleteLibrary, updateLibrary } from "./repository.js";
import { saveUserSpaceFile } from "../storage.js";
import { KbAccessDeniedError, KbNotFoundError, KbVersionConflictError } from "./errors.js";
import {
	checkKbAgentLibraryAllowed,
	kbAgentRoutes,
	loadKbAgentContext,
	requireKbScope,
	type KbAgentRequest,
} from "./agentRoutes.js";
import { withIdempotency } from "./agentStore.js";

export const knowledgeRoutes = Router();

// 挂载普通用户 MCP Agent 认证与端点
knowledgeRoutes.use(loadKbAgentContext);
knowledgeRoutes.use("/agent", kbAgentRoutes);

// 内存中缓存 10MB 内的文件上传
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 10 * 1024 * 1024 },
});

// 知识库全局功能开关守卫
export const requireKnowledgeBaseEnabled: RequestHandler = (_req, res, next) => {
	if (!isFeatureKbEnabled()) {
		res.status(503).json({
			error: "KB_FEATURE_DISABLED",
			message: "个人知识库功能维护中或尚未开启",
		});
		return;
	}
	next();
};

export const requireKnowledgeBaseWriteEnabled: RequestHandler = (_req, res, next) => {
	if (!isFeatureKbWriteEnabled()) {
		res.status(503).json({
			error: "KB_WRITE_DISABLED",
			message: "个人知识库当前处于只读维护模式，暂停所有写入",
		});
		return;
	}
	next();
};

knowledgeRoutes.use(requireKnowledgeBaseEnabled);

// 提取当前登录普通用户中间件
function requireUser(req: Request, res: Response): number | null {
	const user = (req as Request & { commentUser?: { id: number } }).commentUser;
	if (!user?.id) {
		res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通账号" });
		return null;
	}
	return user.id;
}

/**
 * 获取当前登录用户的知识库准入资格与活跃进度
 * GET /api/knowledge/eligibility
 */
knowledgeRoutes.get("/eligibility", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const eligibility = await getUserEligibility(userId);
		res.json(eligibility);
	} catch (error) {
		next(error);
	}
});

/**
 * 获取当前登录用户的知识库配额使用详情
 * GET /api/knowledge/quota
 */
knowledgeRoutes.get("/quota", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const quota = await getUserQuotaUsageService(userId);
		res.json(quota);
	} catch (error) {
		next(error);
	}
});

/**
 * 列出我拥有及参与的所有知识库
 * GET /api/knowledge/libraries
 */
knowledgeRoutes.get("/libraries", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		let list = await listUserLibraries(userId);
		const agentReq = req as KbAgentRequest;
		if (agentReq.kbGrant) {
			list = list.filter((lib) => agentReq.kbGrant!.allowedLibraryIds.includes(lib.id));
		}
		res.json({ libraries: list });
	} catch (error) {
		next(error);
	}
});

const createLibrarySchema = z.object({
	title: z.string().trim().min(1, "知识库标题不能为空").max(120),
	description: z.string().trim().max(500).optional(),
	coverUrl: z.string().trim().max(512).optional(),
	visibility: z.enum(["private", "unlisted", "public"]).optional(),
});

/**
 * 创建新知识库
 * POST /api/knowledge/libraries
 */
knowledgeRoutes.post("/libraries", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const agentReq = req as KbAgentRequest;
		if (agentReq.kbGrant) {
			res.status(403).json({ error: "KB_ACCESS_DENIED", message: "AI 客户端无法直接创建知识库，请在网页中创建" });
			return;
		}
		const userId = requireUser(req, res);
		if (!userId) return;
		const input = createLibrarySchema.parse(req.body);
		const libraryId = await createUserLibrary(userId, input);
		res.status(201).json({ id: libraryId, message: "知识库创建成功" });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取单个知识库概览信息
 * GET /api/knowledge/libraries/:id
 */
knowledgeRoutes.get("/libraries/:id", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const lib = await getVisibleLibraryRecord(userId, id);
		if (!lib) {
			res.status(404).json({ error: "KB_NOT_FOUND", message: "知识库不存在" });
			return;
		}
		res.json(lib);
	} catch (error) {
		next(error);
	}
});

/**
 * 更新知识库基本信息
 * PUT /api/knowledge/libraries/:id
 */
knowledgeRoutes.put("/libraries/:id", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const lib = await getLibraryRecord(id);
		if (!lib || lib.deletedAt) {
			res.status(404).json({ error: "KB_NOT_FOUND", message: "知识库不存在" });
			return;
		}
		if (lib.ownerUserId !== userId) {
			res.status(403).json({ error: "KB_ACCESS_DENIED", message: "仅所有者可修改知识库设置" });
			return;
		}
		const input = createLibrarySchema.partial().parse(req.body);
		await updateLibrary(id, input);
		res.json({ message: "更新成功" });
	} catch (error) {
		next(error);
	}
});

/**
 * 软删除知识库
 * DELETE /api/knowledge/libraries/:id
 */
knowledgeRoutes.delete("/libraries/:id", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const agentReq = req as KbAgentRequest;
		if (agentReq.kbGrant) {
			res.status(403).json({ error: "KB_ACCESS_DENIED", message: "AI 客户端不支持整库硬删除" });
			return;
		}
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const lib = await getLibraryRecord(id);
		if (!lib || lib.deletedAt) {
			res.status(404).json({ error: "KB_NOT_FOUND", message: "知识库不存在" });
			return;
		}
		if (lib.ownerUserId !== userId) {
			res.status(403).json({ error: "KB_ACCESS_DENIED", message: "仅所有者可删除知识库" });
			return;
		}
		await softDeleteLibrary(id);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

/**
 * 获取知识库的目录树
 * GET /api/knowledge/libraries/:id/tree
 */
knowledgeRoutes.get("/libraries/:id/tree", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const tree = await getUserLibraryTree(userId, id);
		res.json({ tree });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取知识库回收站中的软删除文档列表
 * GET /api/knowledge/libraries/:id/trash
 */
knowledgeRoutes.get("/libraries/:id/trash", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const items = await listTrashedDocumentsService(userId, id);
		res.json({ items });
	} catch (error) {
		next(error);
	}
});

const createDocumentSchema = z.object({
	libraryId: z.number().int().positive(),
	parentId: z.number().int().positive().nullable().optional(),
	kind: z.enum(["document", "folder"]),
	title: z.string().trim().min(1, "标题不能为空").max(255),
	markdown: z.string().max(1024 * 1024, "文档正文不能超过 1 MiB").optional(),
	tags: z.array(z.string().trim().max(50)).max(20).optional(),
	sourceUrl: z.string().trim().max(1000).optional(),
	idempotencyKey: z.string().trim().max(128).optional(),
	externalKey: z.string().trim().max(255).optional(),
});

/**
 * 创建新文档或文件夹
 * POST /api/knowledge/documents
 */
knowledgeRoutes.post("/documents", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:write"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const input = createDocumentSchema.parse(req.body);
		if (!checkKbAgentLibraryAllowed(req, input.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const agentReq = req as KbAgentRequest;
		const doc = await withIdempotency(
			userId,
			agentReq.kbGrant?.id ?? null,
			"create_document",
			input.idempotencyKey,
			input,
			() => createKnowledgeDocument(userId, input),
		);
		res.status(201).json(doc);
	} catch (error) {
		next(error);
	}
});

/**
 * 读取文档详情（包含当前编辑版本草稿内容）
 * GET /api/knowledge/documents/:id
 */
knowledgeRoutes.get("/documents/:id", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		res.json(doc);
	} catch (error) {
		next(error);
	}
});

const saveDocumentSchema = z.object({
	expectedVersion: z.number().int().nonnegative("必须携带 expectedVersion 版本控制参数"),
	title: z.string().trim().min(1, "标题不能为空").max(255),
	markdown: z.string().max(1024 * 1024, "文档正文不能超过 1 MiB"),
	tags: z.array(z.string().trim().max(50)).max(20).optional(),
	sourceUrl: z.string().trim().max(1000).optional(),
	isManualSave: z.boolean().optional(),
	idempotencyKey: z.string().trim().max(128).optional(),
});

/**
 * 更新文档 Markdown 正文 (乐观并发锁版本控制)
 * PUT /api/knowledge/documents/:id
 */
knowledgeRoutes.put("/documents/:id", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:write"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const input = saveDocumentSchema.parse(req.body);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const agentReq = req as KbAgentRequest;
		const result = await withIdempotency(
			userId,
			agentReq.kbGrant?.id ?? null,
			`update_document_${id}`,
			input.idempotencyKey,
			input,
			() => saveKnowledgeDocument(userId, id, input),
		);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

const moveDocumentSchema = z.object({
	targetParentId: z.number().int().positive().nullable(),
	sortOrder: z.number().int().default(0),
});

/**
 * 移动文档树节点
 * POST /api/knowledge/documents/:id/move
 */
knowledgeRoutes.post("/documents/:id/move", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:write"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const input = moveDocumentSchema.parse(req.body);
		await moveKnowledgeDocument(userId, id, input.targetParentId, input.sortOrder);
		res.json({ message: "移动成功" });
	} catch (error) {
		next(error);
	}
});

/**
 * 软删除文档（移入回收站）
 * POST /api/knowledge/documents/:id/trash
 */
knowledgeRoutes.post("/documents/:id/trash", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:delete"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		await trashKnowledgeDocument(userId, id);
		res.json({ message: "文档已移入回收站" });
	} catch (error) {
		next(error);
	}
});

/**
 * 从回收站恢复文档
 * POST /api/knowledge/documents/:id/restore
 */
knowledgeRoutes.post("/documents/:id/restore", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:delete"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		await restoreKnowledgeDocument(userId, id);
		res.json({ message: "文档已恢复" });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取文档历史版本列表
 * GET /api/knowledge/documents/:id/revisions
 */
knowledgeRoutes.get("/documents/:id/revisions", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const revisions = await getKnowledgeDocumentRevisions(userId, id);
		res.json({ revisions });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取指定历史版本详情（含 markdown 正文以供 Diff 和历史预览）
 * GET /api/knowledge/documents/:id/revisions/:revisionId
 */
knowledgeRoutes.get("/documents/:id/revisions/:revisionId", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const revId = Number(req.params.revisionId);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const revision = await getKnowledgeRevisionDetail(userId, docId, revId);
		res.json({ revision });
	} catch (error) {
		next(error);
	}
});

/**
 * 恢复历史版本为当前最新版本
 * POST /api/knowledge/documents/:id/revisions/:revisionId/restore
 */
knowledgeRoutes.post("/documents/:id/revisions/:revisionId/restore", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:write"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const revId = Number(req.params.revisionId);
		const expectedVersion = Number(req.body?.expectedVersion);
		if (!Number.isInteger(expectedVersion)) {
			res.status(400).json({ error: "INVALID_VERSION", message: "缺少合法的 expectedVersion 参数" });
			return;
		}

		const result = await restoreDocumentRevision(userId, docId, revId, expectedVersion);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

/**
 * 全文检索接口
 * GET /api/knowledge/search?q=...&libraryId=...
 */
knowledgeRoutes.get("/search", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const query = String(req.query.q ?? "");
		let libraryId = req.query.libraryId ? Number(req.query.libraryId) : undefined;
		if (libraryId && !checkKbAgentLibraryAllowed(req, libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const agentReq = req as KbAgentRequest;
		let items = await searchKnowledge(userId, query, libraryId);
		if (agentReq.kbGrant) {
			items = items.filter((item) => agentReq.kbGrant!.allowedLibraryIds.includes(item.libraryId));
		}
		res.json({ items });
	} catch (error) {
		next(error);
	}
});

/**
 * 导出文档 Markdown
 * GET /api/knowledge/documents/:id/export
 */
knowledgeRoutes.get("/documents/:id/export", requireKbScope("kb:export"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}

		res.setHeader("Content-Type", "text/markdown; charset=utf-8");
		res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.title || "document")}.md"`);
		res.send(doc.markdown);
	} catch (error) {
		next(error);
	}
});

/**
 * 上传文档附件
 * POST /api/knowledge/documents/:id/attachments
 */
knowledgeRoutes.post(
	"/documents/:id/attachments",
	requireKnowledgeBaseWriteEnabled,
	requireKbScope("kb:attachments"),
	upload.single("file"),
	async (req: Request, res: Response, next: NextFunction) => {
		try {
			const userId = requireUser(req, res);
			if (!userId) return;
			const docId = Number(req.params.id);
			const doc = await getKnowledgeDocument(userId, docId);
			if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
				res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
				return;
			}

			if (!req.file) {
				res.status(400).json({ error: "NO_FILE", message: "请选择要上传的文件" });
				return;
			}

			const originalName = req.file.originalname || "attachment.bin";
			const cleanName = originalName.replace(/[^\w.-]/g, "_");
			const storedFileName = `kb_${randomUUID()}_${cleanName}`;

			// 保存到底层私有存储
			const storageResult = await saveUserSpaceFile({
				filename: storedFileName,
				buffer: req.file.buffer,
				mimeType: req.file.mimetype,
			});

			// 登记到 kb_attachments 元数据表
			const attachmentId = await registerAttachment(userId, docId, {
				storageKey: storageResult.key,
				filename: originalName,
				mimeType: req.file.mimetype,
				byteSize: req.file.size,
			});

			res.status(201).json({
				id: attachmentId,
				filename: originalName,
				byteSize: req.file.size,
				mimeType: req.file.mimetype,
				url: `/api/knowledge/attachments/${attachmentId}`,
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * 获取文档的所有附件列表
 * GET /api/knowledge/documents/:id/attachments
 */
knowledgeRoutes.get("/documents/:id/attachments", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const attachments = await listDocumentAttachmentsService(userId, docId);
		res.json({ attachments });
	} catch (error) {
		next(error);
	}
});

/**
 * 鉴权下载私有附件
 * GET /api/knowledge/attachments/:id
 */
knowledgeRoutes.get("/attachments/:id", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const id = Number(req.params.id);
		const att = await getAuthorizedAttachment(userId, id);
		if (!checkKbAgentLibraryAllowed(req, att.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该附件所属知识库未在当前 AI 授权范围内" });
			return;
		}

		res.setHeader("Content-Type", att.mimeType);
		res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(att.filename)}"`);
		res.setHeader("Cache-Control", "private, no-cache, no-store");

		// 读取文件流或本地文件发送
		const { resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const uploadsDir = fileURLToPath(new URL("../../../../uploads/user-space/", import.meta.url));
		const localPath = resolve(uploadsDir, att.storageKey.replace("user-space/", ""));

		res.sendFile(localPath, (err) => {
			if (err && !res.headersSent) {
				res.status(404).json({ error: "FILE_NOT_FOUND", message: "附件文件实体不存在" });
			}
		});
	} catch (error) {
		next(error);
	}
});

/**
 * =========================================================================
 * P3: 协作、单篇ACL、快照发布、分享链接与多通道评论路由
 * =========================================================================
 */

/**
 * 列出知识库所有成员
 * GET /api/knowledge/libraries/:id/members
 */
knowledgeRoutes.get("/libraries/:id/members", requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const members = await listLibraryMembersService(userId, id);
		res.json({ members });
	} catch (error) {
		next(error);
	}
});

const memberSchema = z.object({
	userId: z.number().int().positive(),
	role: z.enum(["manager", "editor", "commenter", "viewer"]),
});

/**
 * 添加或更新知识库成员
 * POST /api/knowledge/libraries/:id/members
 */
knowledgeRoutes.post("/libraries/:id/members", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const input = memberSchema.parse(req.body);
		await upsertLibraryMemberService(userId, id, input.userId, input.role);
		res.status(200).json({ message: "成员设置成功" });
	} catch (error) {
		next(error);
	}
});

/**
 * 移除知识库成员
 * DELETE /api/knowledge/libraries/:id/members/:memberUserId
 */
knowledgeRoutes.delete("/libraries/:id/members/:memberUserId", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		if (!checkKbAgentLibraryAllowed(req, id)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该知识库未在当前 AI 授权范围内" });
			return;
		}
		const memberUserId = Number(req.params.memberUserId);
		await removeLibraryMemberService(userId, id, memberUserId);
		res.status(200).json({ message: "成员已移除" });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取单篇文档权限与受限名单
 * GET /api/knowledge/documents/:id/access
 */
knowledgeRoutes.get("/documents/:id/access", requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const result = await getDocumentAccessService(userId, docId);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

const updateAccessSchema = z.object({
	accessMode: z.enum(["inherit", "members_only", "restricted"]),
	explicitRoles: z.array(z.object({
		userId: z.number().int().positive(),
		role: z.enum(["editor", "commenter", "viewer"]),
	})).optional(),
});

/**
 * 更新文档权限继承模式与受限名单
 * PUT /api/knowledge/documents/:id/access
 */
knowledgeRoutes.put("/documents/:id/access", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const input = updateAccessSchema.parse(req.body);
		await updateDocumentAccessService(userId, docId, input);
		res.json({ message: "文档权限已更新" });
	} catch (error) {
		next(error);
	}
});

/**
 * 发布文档快照到公开通道
 * POST /api/knowledge/documents/:id/publish
 */
knowledgeRoutes.post("/documents/:id/publish", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:publish"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const revisionId = req.body?.revisionId ? Number(req.body.revisionId) : undefined;
		const result = await publishKnowledgeDocumentService(userId, docId, revisionId);
		res.json({ message: "文档快照已公开发布", ...result });
	} catch (error) {
		next(error);
	}
});

/**
 * 撤回公开发布快照
 * POST /api/knowledge/documents/:id/unpublish
 */
knowledgeRoutes.post("/documents/:id/unpublish", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:publish"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		await unpublishKnowledgeDocumentService(userId, docId);
		res.json({ message: "文档快照已撤回" });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取公开快照（免登录只读接口，未发布或私有库草稿返回 404）
 * GET /api/knowledge/public/documents/:id
 */
knowledgeRoutes.get("/public/documents/:id", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const docId = Number(req.params.id);
		const snapshot = await getPublicDocumentSnapshotService(docId);
		res.json(snapshot);
	} catch (error) {
		next(error);
	}
});

const createShareLinkSchema = z.object({
	expiresInDays: z.number().int().min(1).max(30).optional(),
	includeDescendants: z.boolean().optional(),
});

/**
 * 创建安全分享链接
 * POST /api/knowledge/documents/:id/share
 */
knowledgeRoutes.post("/documents/:id/share", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const input = createShareLinkSchema.parse(req.body || {});
		const link = await createShareLinkService(userId, docId, input);
		res.status(201).json(link);
	} catch (error) {
		next(error);
	}
});

/**
 * 获取文档已创建的分享链接列表
 * GET /api/knowledge/documents/:id/share-links
 */
knowledgeRoutes.get("/documents/:id/share-links", requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const links = await listDocumentShareLinksService(userId, docId);
		res.json({ links });
	} catch (error) {
		next(error);
	}
});

/**
 * 撤销分享链接
 * DELETE /api/knowledge/share-links/:id
 */
knowledgeRoutes.delete("/share-links/:id", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:share"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const linkId = Number(req.params.id);
		await revokeShareLinkService(userId, linkId);
		res.json({ message: "分享链接已撤销" });
	} catch (error) {
		next(error);
	}
});

/**
 * 通过分享链接安全只读访问文档
 * GET /api/knowledge/shared/:token
 */
knowledgeRoutes.get("/shared/:token", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const token = String(req.params.token);
		const data = await getSharedDocumentSnapshotService(token);
		res.setHeader("Referrer-Policy", "no-referrer");
		res.json(data);
	} catch (error) {
		next(error);
	}
});

const createCommentSchema = z.object({
	body: z.string().trim().min(1, "评论正文不能为空").max(5000),
	channel: z.enum(["internal", "public"]),
	parentId: z.number().int().positive().optional(),
});

/**
 * 添加评论 (支持 internal 与 public 两个通道)
 * POST /api/knowledge/documents/:id/comments
 */
knowledgeRoutes.post("/documents/:id/comments", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:comment"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, docId);
		if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
			res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
			return;
		}
		const input = createCommentSchema.parse(req.body);
		const commentId = await addCommentService(userId, docId, input);
		res.status(201).json({ id: commentId, message: "评论发表成功" });
	} catch (error) {
		next(error);
	}
});

/**
 * 获取文档评论列表
 * GET /api/knowledge/documents/:id/comments
 */
knowledgeRoutes.get("/documents/:id/comments", requireKbScope("kb:read"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id ?? null;
		const docId = Number(req.params.id);
		if (userId) {
			const doc = await getKnowledgeDocument(userId, docId);
			if (!checkKbAgentLibraryAllowed(req, doc.libraryId)) {
				res.status(403).json({ error: "KB_LIBRARY_NOT_ALLOWED", message: "该文档所属知识库未在当前 AI 授权范围内" });
				return;
			}
		}
		const channel = (req.query.channel === "internal" ? "internal" : "public") as "internal" | "public";
		const comments = await listCommentsService(userId, docId, channel);
		res.json({ comments });
	} catch (error) {
		next(error);
	}
});

/**
 * 标记评论已解决
 * POST /api/knowledge/comments/:id/resolve
 */
knowledgeRoutes.post("/comments/:id/resolve", requireKnowledgeBaseWriteEnabled, requireKbScope("kb:comment"), async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const commentId = Number(req.params.id);
		await resolveCommentService(userId, commentId);
		res.json({ message: "评论已标记为已解决" });
	} catch (error) {
		next(error);
	}
});

