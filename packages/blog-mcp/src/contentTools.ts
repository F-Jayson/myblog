import { blogJson } from "./blogClient.js";

type Json = Record<string, unknown>;
type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };
type Tool = { name: string; description: string; inputSchema: Json; call: (args: Json) => Promise<ToolResult> };

function text(value: string, isError = false): ToolResult {
	return { isError, content: [{ type: "text", text: value }] };
}

function show(value: unknown): ToolResult {
	const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return text(rendered.length > 12000 ? `${rendered.slice(0, 12000)}\n…（结果已截断）` : rendered);
}

function stringArg(args: Json, key: string) {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanArg(args: Json, key: string) {
	return typeof args[key] === "boolean" ? args[key] : undefined;
}

function integerArg(args: Json, key: string) {
	const value = args[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function objectSchema(properties: Json, required: string[] = []): Json {
	return { type: "object", properties, required, additionalProperties: false };
}

const idSchema = { id: { type: "integer", minimum: 1 } };

export const contentTools: Tool[] = [
	{
		name: "blog_update_category",
		description: "修改分类名称。会改变公开地址，需要额外的分类标签管理权限。",
		inputSchema: objectSchema({ ...idSchema, name: { type: "string" }, description: { type: "string" } }, ["id", "name"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			const name = stringArg(args, "name");
			if (!id || !name) return text("请提供分类 id 和名称。", true);
			return show(await blogJson(`/api/agent/categories/${id}`, { method: "PUT", body: { name, description: stringArg(args, "description") } }));
		},
	},
	{
		name: "blog_delete_category",
		description: "删除分类。需要额外的分类标签管理权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供分类 id。", true);
			return show(await blogJson(`/api/agent/categories/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_update_tag",
		description: "修改标签名称。需要额外的分类标签管理权限。",
		inputSchema: objectSchema({ ...idSchema, name: { type: "string" } }, ["id", "name"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			const name = stringArg(args, "name");
			if (!id || !name) return text("请提供标签 id 和名称。", true);
			return show(await blogJson(`/api/agent/tags/${id}`, { method: "PUT", body: { name } }));
		},
	},
	{
		name: "blog_delete_tag",
		description: "删除标签。需要额外的分类标签管理权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供标签 id。", true);
			return show(await blogJson(`/api/agent/tags/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_list_comments",
		description: "读取评论。可选 status 为 pending、approved 或 spam。需要读取评论权限。",
		inputSchema: objectSchema({ status: { type: "string", enum: ["pending", "approved", "spam"] } }),
		call: async (args) => {
			const status = stringArg(args, "status");
			return show(await blogJson(`/api/agent/comments${status ? `?status=${encodeURIComponent(status)}` : ""}`));
		},
	},
	{
		name: "blog_moderate_comment",
		description: "修改评论状态。需要额外的审核评论权限。",
		inputSchema: objectSchema({ ...idSchema, status: { type: "string", enum: ["pending", "approved", "spam"] } }, ["id", "status"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			const status = stringArg(args, "status");
			if (!id || !status) return text("请提供评论 id 和状态。", true);
			return show(await blogJson(`/api/agent/comments/${id}/status`, { method: "POST", body: { status } }));
		},
	},
	{
		name: "blog_delete_comment",
		description: "删除评论。需要额外的审核评论权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供评论 id。", true);
			return show(await blogJson(`/api/agent/comments/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_list_dynamics",
		description: "读取站点动态。需要读取站点内容权限。",
		inputSchema: objectSchema({}),
		call: async () => show(await blogJson("/api/agent/dynamics")),
	},
	{
		name: "blog_save_dynamic",
		description: "创建或更新动态。动态会立即公开，需要额外的发布站点内容权限。传入 id 时更新。",
		inputSchema: objectSchema({ id: { type: "integer", minimum: 1 }, body: { type: "string" }, images: { type: "array", items: { type: "string" } }, publishedAt: { type: "string" } }, ["body"]),
		call: async (args) => {
			const body = stringArg(args, "body");
			if (!body) return text("请提供动态正文。", true);
			const id = integerArg(args, "id");
			const payload = { body, images: Array.isArray(args.images) ? args.images : undefined, publishedAt: stringArg(args, "publishedAt") };
			return show(await blogJson(id ? `/api/agent/dynamics/${id}` : "/api/agent/dynamics", { method: id ? "PUT" : "POST", body: payload }));
		},
	},
	{
		name: "blog_delete_dynamic",
		description: "删除动态。需要额外的删除站点内容权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供动态 id。", true);
			return show(await blogJson(`/api/agent/dynamics/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_list_pages",
		description: "读取关于、传送和问题总结页面。需要读取站点内容权限。",
		inputSchema: objectSchema({}),
		call: async () => show(await blogJson("/api/agent/pages")),
	},
	{
		name: "blog_get_page",
		description: "读取一个固定页面。page 可以是 about、transfer 或 issues。",
		inputSchema: objectSchema({ page: { type: "string", enum: ["about", "transfer", "issues"] } }, ["page"]),
		call: async (args) => {
			const page = stringArg(args, "page");
			if (!page) return text("请提供页面标识。", true);
			return show(await blogJson(`/api/agent/pages/${encodeURIComponent(page)}`));
		},
	},
	{
		name: "blog_save_page",
		description: "保存固定页面。页面会立即公开，需要额外的发布站点内容权限。",
		inputSchema: objectSchema({
			page: { type: "string", enum: ["about", "transfer", "issues"] },
			title: { type: "string" },
			content: { type: "string" },
			friendLinksIntro: { type: "string" },
			friendLinks: { type: "array", items: { type: "object" } },
		}, ["page", "title", "content"]),
		call: async (args) => {
			const page = stringArg(args, "page");
			const title = stringArg(args, "title");
			const content = typeof args.content === "string" ? args.content : undefined;
			if (!page || !title || content === undefined) return text("请提供页面标识、标题和正文。", true);
			return show(await blogJson("/api/agent/pages", { method: "PUT", body: { page, title, content, friendLinksIntro: stringArg(args, "friendLinksIntro"), friendLinks: args.friendLinks } }));
		},
	},
	{
		name: "blog_delete_page",
		description: "删除固定页面的自定义内容并恢复默认。需要额外的删除站点内容权限。",
		inputSchema: objectSchema({ page: { type: "string", enum: ["about", "transfer", "issues"] } }, ["page"]),
		call: async (args) => {
			const page = stringArg(args, "page");
			if (!page) return text("请提供页面标识。", true);
			return show(await blogJson(`/api/agent/pages/${encodeURIComponent(page)}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_list_changelogs",
		description: "读取更新日志。需要读取站点内容权限。",
		inputSchema: objectSchema({}),
		call: async () => show(await blogJson("/api/agent/changelogs")),
	},
	{
		name: "blog_save_changelog",
		description: "创建或更新更新日志。published 为 true 时需要额外的发布站点内容权限。传入 id 时更新。",
		inputSchema: objectSchema({
			id: { type: "integer", minimum: 1 },
			title: { type: "string" },
			content: { type: "string" },
			slug: { type: "string" },
			version: { type: "string" },
			date: { type: "string" },
			published: { type: "boolean" },
		}, ["title", "content"]),
		call: async (args) => {
			const title = stringArg(args, "title");
			const content = typeof args.content === "string" ? args.content : undefined;
			if (!title || content === undefined) return text("请提供标题和正文。", true);
			const id = integerArg(args, "id");
			const payload = { title, content, slug: stringArg(args, "slug"), version: stringArg(args, "version"), date: stringArg(args, "date"), published: booleanArg(args, "published") };
			return show(await blogJson(id ? `/api/agent/changelogs/${id}` : "/api/agent/changelogs", { method: id ? "PUT" : "POST", body: payload }));
		},
	},
	{
		name: "blog_delete_changelog",
		description: "删除更新日志。需要额外的删除站点内容权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供更新日志 id。", true);
			return show(await blogJson(`/api/agent/changelogs/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_list_announcements",
		description: "读取当前公告和历史公告。需要读取站点内容权限。",
		inputSchema: objectSchema({ page: { type: "integer", minimum: 1 }, q: { type: "string" } }),
		call: async (args) => {
			const params = new URLSearchParams();
			const page = integerArg(args, "page");
			const q = stringArg(args, "q");
			if (page) params.set("page", String(page));
			if (q) params.set("q", q);
			const query = params.toString();
			return show(await blogJson(`/api/agent/announcements${query ? `?${query}` : ""}`));
		},
	},
	{
		name: "blog_save_announcement",
		description: "创建或更新公告草稿，不会直接出现在前台。传入 id 时更新。需要编辑未公开内容权限。",
		inputSchema: objectSchema({ id: { type: "integer", minimum: 1 }, content: { type: "string" }, publishedAt: { type: "string" } }, ["content"]),
		call: async (args) => {
			const content = stringArg(args, "content");
			if (!content) return text("请提供公告内容。", true);
			const id = integerArg(args, "id");
			return show(await blogJson(id ? `/api/agent/announcements/${id}` : "/api/agent/announcements", { method: id ? "PUT" : "POST", body: { content, publishedAt: stringArg(args, "publishedAt") } }));
		},
	},
	{
		name: "blog_publish_announcement",
		description: "把一条历史公告发布为当前公告。需要额外的发布站点内容权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供公告 id。", true);
			return show(await blogJson(`/api/agent/announcements/${id}/publish`, { method: "POST" }));
		},
	},
	{
		name: "blog_delete_announcement",
		description: "删除一条历史公告。需要额外的删除站点内容权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供公告 id。", true);
			return show(await blogJson(`/api/agent/announcements/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_list_feedback",
		description: "读取访客反馈。status 可以是 open、processing 或 resolved。需要读取站点内容权限。",
		inputSchema: objectSchema({ page: { type: "integer", minimum: 1 }, status: { type: "string", enum: ["open", "processing", "resolved"] }, q: { type: "string" } }),
		call: async (args) => {
			const params = new URLSearchParams();
			const page = integerArg(args, "page");
			const status = stringArg(args, "status");
			const q = stringArg(args, "q");
			if (page) params.set("page", String(page));
			if (status) params.set("status", status);
			if (q) params.set("q", q);
			const query = params.toString();
			return show(await blogJson(`/api/agent/feedback${query ? `?${query}` : ""}`));
		},
	},
	{
		name: "blog_update_feedback",
		description: "更新反馈处理状态。需要编辑未公开内容权限。",
		inputSchema: objectSchema({ ...idSchema, status: { type: "string", enum: ["open", "processing", "resolved"] } }, ["id", "status"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			const status = stringArg(args, "status");
			if (!id || !status) return text("请提供反馈 id 和状态。", true);
			return show(await blogJson(`/api/agent/feedback/${id}/status`, { method: "POST", body: { status } }));
		},
	},
	{
		name: "blog_delete_feedback",
		description: "删除一条反馈。需要额外的删除站点内容权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供反馈 id。", true);
			return show(await blogJson(`/api/agent/feedback/${id}`, { method: "DELETE" }));
		},
	},
	{
		name: "blog_site_overview",
		description: "读取站点概况、作者资料、功能开关和评论开关。不返回密码或密钥。",
		inputSchema: objectSchema({}),
		call: async () => show(await blogJson("/api/agent/site")),
	},
	{
		name: "blog_update_site",
		description: "修改站点外观或作者资料。需要额外的修改站点设置权限。只提交要改的字段。",
		inputSchema: objectSchema({
			title: { type: "string" },
			subtitle: { type: "string" },
			description: { type: "string" },
			hue: { type: "integer", minimum: 0, maximum: 360 },
			siteLogo: { type: "string" },
			siteLogoDark: { type: "string" },
			siteFavicon: { type: "string" },
			author: { type: "object" },
		}),
		call: async (args) => {
			const body = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
			if (!Object.keys(body).length) return text("请提供要修改的站点字段。", true);
			return show(await blogJson("/api/agent/site", { method: "PATCH", body }));
		},
	},
	{
		name: "blog_update_features",
		description: "修改功能开关，例如评论、注册、图床和用户中心。需要额外的修改站点设置权限。",
		inputSchema: objectSchema({
			commentsEnabled: { type: "boolean" },
			registrationEnabled: { type: "boolean" },
			loginEnabled: { type: "boolean" },
			imageHostingEnabled: { type: "boolean" },
			clipboardEnabled: { type: "boolean" },
			userCenterEnabled: { type: "boolean" },
			publicResourcesEnabled: { type: "boolean" },
			compilerEnabled: { type: "boolean" },
			gamesEnabled: { type: "boolean" },
		}),
		call: async (args) => {
			const body = Object.fromEntries(Object.entries(args).filter(([, value]) => typeof value === "boolean"));
			if (!Object.keys(body).length) return text("请提供要修改的开关。", true);
			return show(await blogJson("/api/agent/features", { method: "PATCH", body }));
		},
	},
	{
		name: "blog_update_comment_settings",
		description: "修改评论开关。不能读取或写入邮件密码。需要额外的修改站点设置权限。",
		inputSchema: objectSchema({
			commentsEnabled: { type: "boolean" },
			commentRegistrationEnabled: { type: "boolean" },
			commentModerationEnabled: { type: "boolean" },
			allowAnonymous: { type: "boolean" },
			emailRegistrationEnabled: { type: "boolean" },
			notifyNewUser: { type: "boolean" },
			notifyNewComment: { type: "boolean" },
			notifyPendingComment: { type: "boolean" },
		}),
		call: async (args) => {
			const body = Object.fromEntries(Object.entries(args).filter(([, value]) => typeof value === "boolean"));
			if (!Object.keys(body).length) return text("请提供要修改的评论设置。", true);
			return show(await blogJson("/api/agent/comment-settings", { method: "PATCH", body }));
		},
	},
	{
		name: "blog_list_users",
		description: "读取前台用户。需要读取用户权限。",
		inputSchema: objectSchema({}),
		call: async () => show(await blogJson("/api/agent/users")),
	},
	{
		name: "blog_update_user",
		description: "修改前台用户昵称或启用状态。不能重置密码。需要额外的管理用户权限。",
		inputSchema: objectSchema({ ...idSchema, nickname: { type: "string" }, isActive: { type: "boolean" } }, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供用户 id。", true);
			const body: Json = {};
			const nickname = stringArg(args, "nickname");
			if (nickname) body.nickname = nickname;
			if (typeof args.isActive === "boolean") body.isActive = args.isActive;
			if (!Object.keys(body).length) return text("请提供昵称或启用状态。", true);
			return show(await blogJson(`/api/agent/users/${id}`, { method: "PATCH", body }));
		},
	},
	{
		name: "blog_delete_user",
		description: "删除前台用户。不能删除后台管理员。需要额外的管理用户权限。",
		inputSchema: objectSchema(idSchema, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供用户 id。", true);
			return show(await blogJson(`/api/agent/users/${id}`, { method: "DELETE" }));
		},
	},
];
