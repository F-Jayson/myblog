#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
	apiAddComment,
	apiCreateDocument,
	apiCreateShareLink,
	apiExportMarkdown,
	apiGetAccess,
	apiGetDocument,
	apiGetTree,
	apiListComments,
	apiListLibraries,
	apiListRevisions,
	apiMoveDocument,
	apiPreviewPublication,
	apiPublishDocument,
	apiRestoreDocument,
	apiRestoreRevision,
	apiRevokeShareLink,
	apiSearch,
	apiSetDocumentAccess,
	apiSetMember,
	apiTrashDocument,
	apiUnpublishDocument,
	apiUpdateDocument,
	apiUploadAttachment,
	connectKnowledge,
	currentKnowledgeProfile,
	disconnectKnowledge,
} from "./client.js";

const server = new McpServer({
	name: "jayson-blog-knowledge",
	version: "1.0.0",
});

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
	const message = error instanceof Error ? error.message : "操作执行失败";
	return textResponse(message, true);
}

// =============================================================================
// 1. 连接与状态工具组
// =============================================================================

server.tool(
	"kb_status",
	"查看当前普通账号个人知识库智能体是否已经授权，以及已授权的库范围、Scope 权限与到期时间。",
	{},
	async () => {
		try {
			const info = await currentKnowledgeProfile();
			if (!info || !info.agentInfo) {
				return textResponse(
					"尚未授权连接个人知识库。\n请调用 kb_connect，将在浏览器打开授权页由普通用户批准授权。",
				);
			}
			const { agentInfo } = info;
			return textResponse(
				`[个人知识库智能体已连接]\n客户端名称: ${agentInfo.clientName}\n授权账号: ${agentInfo.user.nickname || agentInfo.user.username} (ID: ${agentInfo.user.id})\n已授权知识库 ID: ${agentInfo.allowedLibraryIds.join(", ")}\n已授予权限: ${agentInfo.scopes.join(", ")}\n到期时间: ${agentInfo.expiresAt}`,
			);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_connect",
	"发起个人知识库连接。在终端输出配对码并在浏览器打开授权页，由普通博客用户勾选具体知识库与权限。密码与 Cookie 绝不进入智能体。",
	{
		force: z.boolean().optional().describe("是否强制重新授权连接"),
		scopes: z.array(z.string()).optional().describe("申请的 scope 列表 (默认 kb:read)"),
		clientName: z.string().optional().describe("客户端显示名称"),
	},
	async ({ force, scopes, clientName }) => {
		try {
			const res = await connectKnowledge({ force, scopes, clientName });
			return textResponse(res.message);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_disconnect",
	"断开当前本地个人知识库智能体连接并清除存储在本地的访问凭证。",
	{},
	async () => {
		try {
			const msg = await disconnectKnowledge();
			return textResponse(msg);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 2. 浏览与检索工具组 (Scope: kb:read)
// =============================================================================

server.tool(
	"kb_list_libraries",
	"列出当前已授权给智能体访问的知识库列表 (仅包含授权范围内的库)。",
	{},
	async () => {
		try {
			const libs = await apiListLibraries();
			if (!libs.length) return textResponse("当前没有可访问的知识库或尚未获得任何库的授权。");
			return jsonResponse(libs);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_get_tree",
	"获取指定知识库的完整目录结构树 (包含文档与文件夹层级、ID、标题、权限模式)。",
	{
		libraryId: z.number().int().positive().describe("目标知识库 ID"),
	},
	async ({ libraryId }) => {
		try {
			const tree = await apiGetTree(libraryId);
			return jsonResponse(tree);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_search",
	"在已授权的知识库中根据关键词进行全文搜索 (中文 ngram 索引)。",
	{
		query: z.string().min(1).describe("搜索关键词"),
		libraryId: z.number().int().positive().optional().describe("可选限定搜索的知识库 ID"),
	},
	async ({ query, libraryId }) => {
		try {
			const items = await apiSearch(query, libraryId);
			if (!items.length) return textResponse(`未找到与「${query}」匹配的文档。`);
			return jsonResponse(items);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_get_document",
	"读取指定文档的元数据与 Markdown 正文内容 (工作草稿最新版本)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const doc = await apiGetDocument(documentId);
			return jsonResponse(doc);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 3. 写入与编辑工具组 (Scope: kb:write)
// =============================================================================

server.tool(
	"kb_create_document",
	"在指定知识库下新建一篇文档或文件夹。创建后自动生成不可变初始版本 (v1)。",
	{
		libraryId: z.number().int().positive().describe("归属知识库 ID"),
		parentId: z.number().int().positive().nullable().optional().describe("父级目录 ID (根目录填 null)"),
		kind: z.enum(["document", "folder"]).describe("类型: document (文档) 或 folder (文件夹)"),
		title: z.string().min(1).max(255).describe("标题"),
		markdown: z.string().optional().describe("初始 Markdown 正文内容"),
		tags: z.array(z.string()).optional().describe("标签列表"),
		idempotencyKey: z.string().optional().describe("可选幂等键，防止重复执行"),
	},
	async (args) => {
		try {
			const result = await apiCreateDocument(args);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_update_document",
	"更新文档的标题与 Markdown 正文内容。必须携带 expectedVersion 乐观锁版本参数；如果版本冲突将返回 409。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		expectedVersion: z.number().int().nonnegative().describe("期望的当前文档版本号 (用于 409 冲突保护)"),
		title: z.string().min(1).max(255).describe("文档标题"),
		markdown: z.string().describe("更新后的完整 Markdown 正文"),
		tags: z.array(z.string()).optional().describe("标签列表"),
		idempotencyKey: z.string().optional().describe("可选幂等键"),
	},
	async ({ documentId, ...rest }) => {
		try {
			const result = await apiUpdateDocument(documentId, rest);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_move_document",
	"移动文档或文件夹到新的父级目录下 (系统将自动执行防循环嵌套与权限继承检查)。",
	{
		documentId: z.number().int().positive().describe("被移动的文档或文件夹 ID"),
		targetParentId: z.number().int().positive().nullable().describe("目标父级目录 ID (根目录填 null)"),
		sortOrder: z.number().int().optional().describe("排序值"),
	},
	async ({ documentId, targetParentId, sortOrder }) => {
		try {
			const result = await apiMoveDocument(documentId, targetParentId, sortOrder);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 4. 版本追溯工具组 (Scope: kb:read + kb:write)
// =============================================================================

server.tool(
	"kb_list_revisions",
	"查看文档的历史不可变版本 (Revisions) 列表，包含版本号、时间、字节大小与摘要。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const revisions = await apiListRevisions(documentId);
			return jsonResponse(revisions);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_restore_revision",
	"将文档恢复为指定的历史版本。系统将基于该历史版本的内容生成新的递增不可变版本 (需提供 expectedVersion)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		revisionId: z.number().int().positive().describe("要恢复的目标历史版本 ID"),
		expectedVersion: z.number().int().nonnegative().describe("期望的当前文档版本号"),
	},
	async ({ documentId, revisionId, expectedVersion }) => {
		try {
			const result = await apiRestoreRevision(documentId, revisionId, expectedVersion);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 5. 评论工具组 (Scope: kb:comment)
// =============================================================================

server.tool(
	"kb_list_comments",
	"获取文档下的评论讨论列表 (支持 internal 内部讨论与 public 读者评论两种通道)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		channel: z.enum(["internal", "public"]).optional().describe("通道类型 (默认 internal)"),
	},
	async ({ documentId, channel }) => {
		try {
			const comments = await apiListComments(documentId, channel || "internal");
			return jsonResponse(comments);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_add_comment",
	"在文档下发表一条评论讨论 (仅限授权了 kb:comment scope 时使用)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		body: z.string().min(1).max(5000).describe("评论正文内容"),
		channel: z.enum(["internal", "public"]).optional().describe("评论通道 (默认 internal)"),
		parentId: z.number().int().positive().nullable().optional().describe("父评论 ID"),
	},
	async ({ documentId, body, channel, parentId }) => {
		try {
			const result = await apiAddComment(documentId, body, channel || "internal", parentId);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 6. 附件工具组 (Scope: kb:attachments)
// =============================================================================

server.tool(
	"kb_upload_attachment",
	"从智能体本地计算机读取指定路径的文件，并上传作为文档附件 (大小上限 10MB)。仅本地 MCP 进程会读取文件路径，远程服务端不接触本地路径。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		localFilePath: z.string().min(1).describe("本地文件绝对路径 (例如 C:/notes/diagram.png)"),
	},
	async ({ documentId, localFilePath }) => {
		try {
			const result = await apiUploadAttachment(documentId, localFilePath);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 7. 发布快照工具组 (Scope: kb:publish 敏感权限)
// =============================================================================

server.tool(
	"kb_preview_publication",
	"预览文档已发布的公开快照内容 (公开只读通道，与草稿完全隔离)。若未发布则返回 404。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const snapshot = await apiPreviewPublication(documentId);
			return jsonResponse(snapshot);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_publish_document",
	"将指定文档的不可变版本冻结并发布为公开快照。后续对工作草稿的编辑和保存绝不影响已发布的公开内容 (A09 草稿隔离)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		revisionId: z.number().int().positive().optional().describe("要发布的指定历史版本 ID (省略则发布当前草稿版本)"),
	},
	async ({ documentId, revisionId }) => {
		try {
			const result = await apiPublishDocument(documentId, revisionId);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_unpublish_document",
	"撤回文档的公开快照。撤回后公开通道将立即返回 404，外部读者将无法访问。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const result = await apiUnpublishDocument(documentId);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 8. 协作与共享工具组 (Scope: kb:share 敏感权限)
// =============================================================================

server.tool(
	"kb_get_access",
	"查看文档的当前访问模式 (inherit, members_only, restricted) 及显式协作者权限名单。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const access = await apiGetAccess(documentId);
			return jsonResponse(access);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_set_member",
	"为知识库添加协作者或变更成员角色 (manager, editor, commenter, viewer)。需要所有者或管理员权限。",
	{
		libraryId: z.number().int().positive().describe("知识库 ID"),
		userId: z.number().int().positive().describe("目标普通博客用户 ID"),
		role: z.enum(["manager", "editor", "commenter", "viewer"]).describe("角色权限"),
	},
	async ({ libraryId, userId, role }) => {
		try {
			const result = await apiSetMember(libraryId, userId, role);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_set_document_access",
	"配置单篇文档或目录节点的继承访问模式与名单 (支持 restricted 单篇受限名单与上限收缩)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		accessMode: z.enum(["inherit", "members_only", "restricted"]).describe("继承模式"),
		explicitRoles: z
			.array(
				z.object({
					userId: z.number().int().positive(),
					role: z.enum(["editor", "commenter", "viewer"]),
				}),
			)
			.optional()
			.describe("名单成员角色设定"),
	},
	async ({ documentId, accessMode, explicitRoles }) => {
		try {
			const result = await apiSetDocumentAccess(documentId, { accessMode, explicitRoles });
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_create_share_link",
	"为文档生成高熵安全分享链接 (持链接免登录只读访问，服务端仅存 SHA-256 哈希值防猜解)。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
		expiresInDays: z.number().int().min(1).max(30).optional().describe("有效期天数 (1~30 天，默认 7 天)"),
		includeDescendants: z.boolean().optional().describe("如果是文件夹，是否包含子文档"),
	},
	async ({ documentId, expiresInDays, includeDescendants }) => {
		try {
			const result = await apiCreateShareLink(documentId, { expiresInDays, includeDescendants });
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_revoke_share_link",
	"作废指定的分享链接。作废后持有该链接的读者将立即无法访问。",
	{
		linkId: z.number().int().positive().describe("分享链接记录 ID"),
	},
	async ({ linkId }) => {
		try {
			const result = await apiRevokeShareLink(linkId);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 9. 回收站与导出工具组 (Scope: kb:delete / kb:export 敏感权限)
// =============================================================================

server.tool(
	"kb_trash_document",
	"将指定文档或文件夹移入回收站 (软删除，30 天内可恢复)。禁止硬删除整库。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const result = await apiTrashDocument(documentId);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_restore_document",
	"从回收站恢复已被软删除的文档或文件夹。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const result = await apiRestoreDocument(documentId);
			return jsonResponse(result);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

server.tool(
	"kb_export_markdown",
	"导出指定文档的 Markdown 原文。",
	{
		documentId: z.number().int().positive().describe("目标文档 ID"),
	},
	async ({ documentId }) => {
		try {
			const markdown = await apiExportMarkdown(documentId);
			return textResponse(markdown);
		} catch (error) {
			return handleFailure(error);
		}
	},
);

// =============================================================================
// 启动标准 stdio JSON-RPC 2.0 传输
// =============================================================================

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	process.stderr.write(`[Knowledge MCP Fatal] ${error instanceof Error ? error.stack : error}\n`);
	process.exit(1);
});
