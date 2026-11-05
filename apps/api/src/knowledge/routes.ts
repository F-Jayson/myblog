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
	getPublicDocumentSnapshotService,
	getSharedDocumentSnapshotService,
	getUserEligibility,
	getUserLibraryTree,
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

export const knowledgeRoutes = Router();

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
		const list = await listUserLibraries(userId);
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
		const lib = await getLibraryRecord(id);
		if (!lib || lib.deletedAt) {
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
knowledgeRoutes.get("/libraries/:id/tree", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.get("/libraries/:id/trash", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
});

/**
 * 创建新文档或文件夹
 * POST /api/knowledge/documents
 */
knowledgeRoutes.post("/documents", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const input = createDocumentSchema.parse(req.body);
		const doc = await createKnowledgeDocument(userId, input);
		res.status(201).json(doc);
	} catch (error) {
		next(error);
	}
});

/**
 * 读取文档详情（包含当前编辑版本草稿内容）
 * GET /api/knowledge/documents/:id
 */
knowledgeRoutes.get("/documents/:id", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);
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
});

/**
 * 更新文档 Markdown 正文 (乐观并发锁版本控制)
 * PUT /api/knowledge/documents/:id
 */
knowledgeRoutes.put("/documents/:id", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const input = saveDocumentSchema.parse(req.body);
		const result = await saveKnowledgeDocument(userId, id, input);
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
knowledgeRoutes.post("/documents/:id/move", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.post("/documents/:id/trash", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.post("/documents/:id/restore", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.get("/documents/:id/revisions", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
		const revisions = await getKnowledgeDocumentRevisions(userId, id);
		res.json({ revisions });
	} catch (error) {
		next(error);
	}
});

/**
 * 恢复历史版本为当前最新版本
 * POST /api/knowledge/documents/:id/revisions/:revisionId/restore
 */
knowledgeRoutes.post("/documents/:id/revisions/:revisionId/restore", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
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
knowledgeRoutes.get("/search", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const query = String(req.query.q ?? "");
		const libraryId = req.query.libraryId ? Number(req.query.libraryId) : undefined;
		const items = await searchKnowledge(userId, query, libraryId);
		res.json({ items });
	} catch (error) {
		next(error);
	}
});

/**
 * 导出文档 Markdown
 * GET /api/knowledge/documents/:id/export
 */
knowledgeRoutes.get("/documents/:id/export", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const id = Number(req.params.id);
		const doc = await getKnowledgeDocument(userId, id);

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
	upload.single("file"),
	async (req: Request, res: Response, next: NextFunction) => {
		try {
			const userId = requireUser(req, res);
			if (!userId) return;
			const docId = Number(req.params.id);

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
knowledgeRoutes.get("/documents/:id/attachments", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const docId = Number(req.params.id);
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
knowledgeRoutes.get("/attachments/:id", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id;
		const id = Number(req.params.id);
		const att = await getAuthorizedAttachment(userId, id);

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
knowledgeRoutes.get("/libraries/:id/members", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.post("/libraries/:id/members", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.delete("/libraries/:id/members/:memberUserId", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const id = Number(req.params.id);
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
knowledgeRoutes.get("/documents/:id/access", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.put("/documents/:id/access", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.post("/documents/:id/publish", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.post("/documents/:id/unpublish", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.post("/documents/:id/share", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.get("/documents/:id/share-links", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.delete("/share-links/:id", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
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
knowledgeRoutes.post("/documents/:id/comments", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = requireUser(req, res);
		if (!userId) return;
		const docId = Number(req.params.id);
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
knowledgeRoutes.get("/documents/:id/comments", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userId = (req as Request & { commentUser?: { id: number } }).commentUser?.id ?? null;
		const docId = Number(req.params.id);
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
knowledgeRoutes.post("/comments/:id/resolve", requireKnowledgeBaseWriteEnabled, async (req: Request, res: Response, next: NextFunction) => {
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

