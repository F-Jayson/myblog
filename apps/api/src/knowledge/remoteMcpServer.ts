import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import {
	addCommentService,
	createKnowledgeDocument,
	createShareLinkService,
	getKnowledgeDocument,
	getKnowledgeDocumentRevisions,
	getUserLibraryTree,
	listCommentsService,
	listUserLibraries,
	moveKnowledgeDocument,
	publishKnowledgeDocumentService,
	resolveCommentService,
	restoreDocumentRevision,
	restoreKnowledgeDocument,
	revokeShareLinkService,
	saveKnowledgeDocument,
	searchKnowledge,
	trashKnowledgeDocument,
	unpublishKnowledgeDocumentService,
} from "./service.js";
import { getDocumentDetail } from "./repository.js";
import { getKbGrantByToken, withIdempotency, type KbAgentGrant } from "./agentStore.js";
import { KbAccessDeniedError, KbNotFoundError, KbVersionConflictError } from "./errors.js";

export const remoteMcpRouter = Router();

interface RemoteMcpSession {
	transport: SSEServerTransport;
	server: McpServer;
	grant: KbAgentGrant;
	token: string;
	createdAt: number;
}

const activeSessions = new Map<string, RemoteMcpSession>();

function textResponse(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		isError,
	};
}

function jsonResponse(data: unknown) {
	return {
		content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
	};
}

function handleFailure(error: unknown) {
	if (error instanceof KbVersionConflictError) {
		return textResponse(`[409 版本冲突] ${error.message}，请重新获取最新版本合并后再保存。`, true);
	}
	if (error instanceof KbAccessDeniedError) {
		return textResponse(`[403 权限拒绝] ${error.message}`, true);
	}
	if (error instanceof KbNotFoundError) {
		return textResponse(`[404 资源不存在] ${error.message}`, true);
	}
	const msg = error instanceof Error ? error.message : "操作执行异常";
	return textResponse(`[错误] ${msg}`, true);
}

/**
 * 校验 Scope 权限辅助
 */
function assertScope(grant: KbAgentGrant, requiredScope: string) {
	if (!grant.scopes.includes(requiredScope)) {
		throw new KbAccessDeniedError(`缺少必需的操作权限 Scope: ${requiredScope}`);
	}
}

/**
 * 校验知识库在授权范围内辅助
 */
function assertLibrary(grant: KbAgentGrant, libraryId: number) {
	if (grant.allowedLibraryIds && grant.allowedLibraryIds.length > 0 && !grant.allowedLibraryIds.includes(libraryId)) {
		throw new KbAccessDeniedError(`知识库 ID ${libraryId} 不在该客户端授权访问列表中`);
	}
}

/**
 * 为指定授权会话创建并初始化 McpServer 实例
 */
export function createRemoteKnowledgeMcpServer(grant: KbAgentGrant): McpServer {
	const server = new McpServer({
		name: "jayson-blog-remote-knowledge-mcp",
		version: "1.1.0",
	});

	const userId = grant.userId;

	// 1. kb_status
	server.tool("kb_status", "查看当前远程连接状态、授权账号、库范围与 Scope 列表", {}, async () => {
		return textResponse(
			`[远程知识库 MCP 已连接]\n客户端名称: ${grant.clientName}\n授权账号: ${grant.user?.nickname || grant.user?.username} (ID: ${userId})\n授权知识库: ${grant.allowedLibraryIds.length > 0 ? grant.allowedLibraryIds.join(", ") : "全部库"}\n生效 Scope: ${grant.scopes.join(", ")}\n有效期至: ${grant.expiresAt}`,
		);
	});

	// 2. kb_list_libraries
	server.tool(
		"kb_list_libraries",
		"获取当前用户有权访问的知识库列表",
		{},
		async () => {
			try {
				assertScope(grant, "kb:read");
				const list = await listUserLibraries(userId);
				const filtered = grant.allowedLibraryIds.length > 0
					? list.filter((l) => grant.allowedLibraryIds.includes(l.id))
					: list;
				return jsonResponse({
					total: filtered.length,
					items: filtered,
				});
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 3. kb_get_tree
	server.tool(
		"kb_get_tree",
		"获取指定知识库的完整文档目录树结构",
		{ libraryId: z.number().int().positive() },
		async ({ libraryId }) => {
			try {
				assertScope(grant, "kb:read");
				assertLibrary(grant, libraryId);
				const tree = await getUserLibraryTree(userId, libraryId);
				return jsonResponse(tree);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 4. kb_search
	server.tool(
		"kb_search",
		"在知识库已授权文档中进行关键词检索",
		{
			query: z.string().trim().min(1),
			libraryId: z.number().int().positive().optional(),
		},
		async ({ query, libraryId }) => {
			try {
				assertScope(grant, "kb:read");
				if (libraryId) assertLibrary(grant, libraryId);
				const results = await searchKnowledge(userId, query, libraryId);
				return jsonResponse(results);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 5. kb_get_document
	server.tool(
		"kb_get_document",
		"获取指定知识库文档的详细内容、当前版本与元数据",
		{ documentId: z.number().int().positive() },
		async ({ documentId }) => {
			try {
				assertScope(grant, "kb:read");
				const doc = await getKnowledgeDocument(userId, documentId);
				assertLibrary(grant, doc.libraryId);
				return jsonResponse(doc);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 6. kb_create_document
	server.tool(
		"kb_create_document",
		"在指定知识库下创建新文档或文件夹",
		{
			libraryId: z.number().int().positive(),
			parentId: z.number().int().positive().nullable().optional(),
			kind: z.enum(["document", "folder"]).default("document"),
			title: z.string().trim().min(1).max(255),
			markdown: z.string().optional().default(""),
			idempotencyKey: z.string().trim().optional(),
		},
		async ({ libraryId, parentId, kind, title, markdown, idempotencyKey }) => {
			try {
				assertScope(grant, "kb:write");
				assertLibrary(grant, libraryId);

				return await withIdempotency(
					userId,
					grant.id,
					"doc_create",
					idempotencyKey,
					{ libraryId, parentId, kind, title },
					async () => {
						const doc = await createKnowledgeDocument(userId, {
							libraryId,
							parentId: parentId ?? null,
							kind,
							title,
							markdown,
						});
						return jsonResponse({
							status: "created",
							documentId: doc.id,
							title: doc.title,
							version: doc.version,
						});
					},
				);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 7. kb_update_document
	server.tool(
		"kb_update_document",
		"更新知识库文档 Markdown 正文或标题 (必须提供 expectedVersion 乐观锁)",
		{
			documentId: z.number().int().positive(),
			expectedVersion: z.number().int().positive(),
			title: z.string().trim().min(1).max(255).optional(),
			markdown: z.string().optional(),
			idempotencyKey: z.string().trim().optional(),
		},
		async ({ documentId, expectedVersion, title, markdown, idempotencyKey }) => {
			try {
				assertScope(grant, "kb:write");
				const docInfo = await getDocumentDetail(documentId);
				if (!docInfo) throw new KbNotFoundError("文档不存在");
				assertLibrary(grant, docInfo.libraryId);

				return await withIdempotency(
					userId,
					grant.id,
					"doc_update",
					idempotencyKey,
					{ documentId, expectedVersion, title },
					async () => {
						const currentDoc = await getKnowledgeDocument(userId, documentId);
						const saved = await saveKnowledgeDocument(userId, documentId, {
							expectedVersion,
							title: title ?? currentDoc.title,
							markdown: markdown ?? currentDoc.markdown,
						});
						return jsonResponse({
							status: saved.status,
							documentId,
							version: saved.version,
						});
					},
				);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 8. kb_move_document
	server.tool(
		"kb_move_document",
		"移动文档节点到新父节点或调整同级排序 (防循环移动)",
		{
			documentId: z.number().int().positive(),
			targetParentId: z.number().int().positive().nullable(),
			targetSortOrder: z.number().int().optional(),
		},
		async ({ documentId, targetParentId, targetSortOrder }) => {
			try {
				assertScope(grant, "kb:write");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				await moveKnowledgeDocument(userId, documentId, targetParentId, targetSortOrder ?? 0);
				return textResponse(`文档 ID ${documentId} 已成功移动至新目标位置。`);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 9. kb_list_revisions
	server.tool(
		"kb_list_revisions",
		"查看指定文档的不可变历史修订版本列表",
		{ documentId: z.number().int().positive() },
		async ({ documentId }) => {
			try {
				assertScope(grant, "kb:read");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				const revs = await getKnowledgeDocumentRevisions(userId, documentId);
				return jsonResponse(revs);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 10. kb_restore_revision
	server.tool(
		"kb_restore_revision",
		"将文档历史版本回滚生成为最新的当前版本",
		{
			documentId: z.number().int().positive(),
			revisionId: z.number().int().positive(),
			expectedVersion: z.number().int().positive(),
		},
		async ({ documentId, revisionId, expectedVersion }) => {
			try {
				assertScope(grant, "kb:write");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				const restored = await restoreDocumentRevision(userId, documentId, revisionId, expectedVersion);
				return jsonResponse({
					status: "restored",
					documentId,
					version: restored.version,
				});
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 11. kb_publish_document
	server.tool(
		"kb_publish_document",
		"将文档当前快照公开发布 (需敏感权限 kb:publish)",
		{ documentId: z.number().int().positive() },
		async ({ documentId }) => {
			try {
				assertScope(grant, "kb:publish");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				await publishKnowledgeDocumentService(userId, documentId);
				return textResponse(`文档 ID ${documentId} 已成功发布公开快照。`);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 12. kb_unpublish_document
	server.tool(
		"kb_unpublish_document",
		"撤回文档的公开发布快照 (公开通道立即失效 404)",
		{ documentId: z.number().int().positive() },
		async ({ documentId }) => {
			try {
				assertScope(grant, "kb:publish");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				await unpublishKnowledgeDocumentService(userId, documentId);
				return textResponse(`文档 ID ${documentId} 已撤销公开快照，公开接口立即失效。`);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 13. kb_create_share_link
	server.tool(
		"kb_create_share_link",
		"创建高熵只读分享链接 (需敏感权限 kb:share)",
		{
			documentId: z.number().int().positive(),
			expireDays: z.number().int().min(1).max(30).default(7),
		},
		async ({ documentId, expireDays }) => {
			try {
				assertScope(grant, "kb:share");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				const link = await createShareLinkService(userId, documentId, { expiresInDays: expireDays });
				return jsonResponse(link);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 14. kb_revoke_share_link
	server.tool(
		"kb_revoke_share_link",
		"立即撤销指定的分享链接",
		{ linkId: z.number().int().positive() },
		async ({ linkId }) => {
			try {
				assertScope(grant, "kb:share");
				await revokeShareLinkService(userId, linkId);
				return textResponse(`分享链接 ID ${linkId} 已成功撤销。`);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 15. kb_trash_document
	server.tool(
		"kb_trash_document",
		"将文档移入回收站 (需敏感权限 kb:delete)",
		{ documentId: z.number().int().positive() },
		async ({ documentId }) => {
			try {
				assertScope(grant, "kb:delete");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				await trashKnowledgeDocument(userId, documentId);
				return textResponse(`文档 ID ${documentId} 已移入回收站。`);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 16. kb_restore_document
	server.tool(
		"kb_restore_document",
		"从回收站恢复已删除的文档",
		{ documentId: z.number().int().positive() },
		async ({ documentId }) => {
			try {
				assertScope(grant, "kb:write");
				await restoreKnowledgeDocument(userId, documentId);
				return textResponse(`文档 ID ${documentId} 已从回收站成功恢复。`);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 17. kb_list_comments
	server.tool(
		"kb_list_comments",
		"查看指定文档的评论列表 (支持 internal 内部协作者评论与 public 公开评论)",
		{
			documentId: z.number().int().positive(),
			channel: z.enum(["internal", "public"]).default("internal"),
		},
		async ({ documentId, channel }) => {
			try {
				assertScope(grant, "kb:read");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				const comments = await listCommentsService(userId, documentId, channel);
				return jsonResponse(comments);
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	// 18. kb_add_comment
	server.tool(
		"kb_add_comment",
		"在文档下发表内部或公开评论",
		{
			documentId: z.number().int().positive(),
			channel: z.enum(["internal", "public"]).default("internal"),
			body: z.string().trim().min(1).max(5000),
			parentId: z.number().int().positive().optional(),
		},
		async ({ documentId, channel, body, parentId }) => {
			try {
				assertScope(grant, "kb:comment");
				const docInfo = await getDocumentDetail(documentId);
				if (docInfo) assertLibrary(grant, docInfo.libraryId);

				const commentId = await addCommentService(userId, documentId, {
					channel,
					body,
					parentId: parentId ?? null,
				});
				return jsonResponse({
					status: "comment_added",
					commentId,
				});
			} catch (err) {
				return handleFailure(err);
			}
		},
	);

	return server;
}

// =============================================================================
// 远程 Streamable HTTP / SSE MCP 路由中间件
// =============================================================================

// 从请求头解析 Bearer 令牌
async function extractGrant(req: Request): Promise<{ grant: KbAgentGrant; token: string } | null> {
	const auth = req.headers.authorization;
	if (!auth || !auth.startsWith("Bearer ")) return null;
	const token = auth.slice(7).trim();
	if (!token) return null;
	const grant = await getKbGrantByToken(token);
	if (!grant) return null;
	return { grant, token };
}

/**
 * GET /mcp/knowledge/sse
 * 建立 Server-Sent Events 流
 */
remoteMcpRouter.get("/sse", async (req: Request, res: Response) => {
	const authResult = await extractGrant(req);
	if (!authResult) {
		res.status(401).json({
			error: "unauthorized",
			message: "远程 MCP 连接需要有效的 Bearer Access Token",
		});
		return;
	}

	const { grant, token } = authResult;
	const transport = new SSEServerTransport("/mcp/knowledge/messages", res);
	const server = createRemoteKnowledgeMcpServer(grant);

	const sessionId = transport.sessionId;
	activeSessions.set(sessionId, {
		transport,
		server,
		grant,
		token,
		createdAt: Date.now(),
	});

	req.on("close", () => {
		activeSessions.delete(sessionId);
	});

	await server.connect(transport);
});

/**
 * POST /mcp/knowledge/messages
 * 接收客户端 JSON-RPC 消息请求
 */
remoteMcpRouter.post("/messages", async (req: Request, res: Response) => {
	const sessionId = String(req.query.sessionId ?? "").trim();
	if (!sessionId) {
		res.status(400).end("Missing sessionId query parameter");
		return;
	}

	const session = activeSessions.get(sessionId);
	if (!session) {
		res.status(404).end("Session not found or expired");
		return;
	}

	// 实时复核令牌状态 (改密、吊销后立即阻断)
	const grantLive = await getKbGrantByToken(session.token);
	if (!grantLive) {
		activeSessions.delete(sessionId);
		await session.transport.close();
		res.status(401).end("Token revoked or expired");
		return;
	}

	await session.transport.handlePostMessage(req, res, req.body);
});
