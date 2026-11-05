import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { isFeatureKbEnabled, isFeatureKbWriteEnabled } from "./constants.js";
import {
	createKnowledgeDocument,
	createUserLibrary,
	getAuthorizedAttachment,
	getKnowledgeDocument,
	getKnowledgeDocumentRevisions,
	getUserEligibility,
	getUserLibraryTree,
	getUserQuotaUsageService,
	listDocumentAttachmentsService,
	listTrashedDocumentsService,
	listUserLibraries,
	moveKnowledgeDocument,
	registerAttachment,
	restoreDocumentRevision,
	restoreKnowledgeDocument,
	saveKnowledgeDocument,
	searchKnowledge,
	trashKnowledgeDocument,
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
