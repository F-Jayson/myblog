#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { AGENT_SCOPE_IDS, blogJson, connectBlog, currentProfile, disconnectBlog, scopeText } from "./blogClient.js";
import { contentTools } from "./contentTools.js";
import { collectMarkdown, readMarkdown } from "./files.js";

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
};

type Json = Record<string, unknown>;
type ToolResult = { isError?: boolean; content: Array<{ type: "text"; text: string }> };
type Tool = {
	name: string;
	description: string;
	inputSchema: Json;
	call: (args: Json) => Promise<ToolResult>;
};

type PostResult = { action: string; post: { id: number; title: string; status: string; path: string; slug: string } };

function text(value: string, isError = false): ToolResult {
	return { isError, content: [{ type: "text", text: value }] };
}

function failure(error: unknown): ToolResult {
	return text(error instanceof Error ? error.message : "操作失败", true);
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

function stringList(args: Json, key: string) {
	const value = args[key];
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function objectSchema(properties: Json, required: string[] = []): Json {
	return { type: "object", properties, required, additionalProperties: false };
}

function describePost(result: PostResult) {
	const action = result.action === "created" ? "已创建" : result.action === "updated" ? "已更新" : result.action === "unchanged" ? "内容没有变化" : result.action === "published" ? "已发布" : result.action === "unpublished" ? "已转为草稿" : result.action;
	const status = result.post.status === "published" ? "已发布" : "草稿";
	return `${action}《${result.post.title}》\n状态：${status}\n地址：${result.post.path}\n编号：${result.post.id}`;
}

const scopeSchema = { type: "array", items: { type: "string", enum: AGENT_SCOPE_IDS }, description: "要申请的权限。默认是读取文章、写入草稿、上传图片、读取站点内容和读取站点设置。发布、删除、修改站点和用户管理即使写在这里，也要管理员在授权页额外勾选" };

const tools: Tool[] = [
	{
		name: "blog_status",
		description: "查看博客智能体是否已经授权，以及当前权限和有效期。",
		inputSchema: objectSchema({}),
		call: async () => {
			const profile = await currentProfile();
			if (!profile) return text("尚未授权。调用 blog_connect 后，会打开浏览器，请用博客管理员账号登录并允许。");
			return text(`已连接博客。\n管理员：${profile.admin.username}\n客户端：${profile.clientName}\n权限：${scopeText(profile.scopes)}\n有效期至：${profile.expiresAt}`);
		},
	},
	{
		name: "blog_connect",
		description: "打开浏览器授权页。管理员登录并允许后，智能体才能管理博客。密码不会进入聊天或本工具。发布、删除、修改站点和管理用户默认不勾选，需要管理员在授权页额外允许。",
		inputSchema: objectSchema({ force: { type: "boolean", description: "为 true 时撤销当前授权并重新登录" }, scopes: scopeSchema }),
		call: async (args) => text((await connectBlog({ force: booleanArg(args, "force"), scopes: stringList(args, "scopes") })).message),
	},
	{
		name: "blog_disconnect",
		description: "撤销当前这台电脑上的博客授权。",
		inputSchema: objectSchema({}),
		call: async () => text(await disconnectBlog()),
	},
	{
		name: "blog_list_posts",
		description: "按标题、slug 或摘要搜索博客文章。",
		inputSchema: objectSchema({ query: { type: "string" }, status: { type: "string", enum: ["draft", "published"] }, page: { type: "integer", minimum: 1 } }),
		call: async (args) => {
			const params = new URLSearchParams();
			const query = stringArg(args, "query");
			const status = stringArg(args, "status");
			const page = integerArg(args, "page");
			if (query) params.set("q", query);
			if (status === "draft" || status === "published") params.set("status", status);
			if (page) params.set("page", String(page));
			const result = await blogJson<{ items: Array<{ id: number; title: string; status: string; path: string; externalKey: string | null }>; total: number }>(`/api/agent/posts?${params.toString()}`);
			if (!result.items.length) return text("没有找到文章。");
			const lines = result.items.map((item) => `- [${item.status === "published" ? "已发布" : "草稿"}] ${item.title}（id ${item.id}，${item.path}${item.externalKey ? `，来源 ${item.externalKey}` : ""}）`);
			return text(`共 ${result.total} 篇，本页：\n${lines.join("\n")}`);
		},
	},
	{
		name: "blog_get_post",
		description: "读取一篇文章的 Markdown。可以按 id、slug 或同步时使用的外部编号查找。",
		inputSchema: objectSchema({ id: { type: "integer", minimum: 1 }, slug: { type: "string" }, externalKey: { type: "string" } }),
		call: async (args) => {
			const params = new URLSearchParams();
			const id = integerArg(args, "id");
			const slug = stringArg(args, "slug");
			const externalKey = stringArg(args, "externalKey");
			if (id) params.set("id", String(id));
			if (slug) params.set("slug", slug);
			if (externalKey) params.set("externalKey", externalKey);
			const post = await blogJson<{ title: string; status: string; path: string; content: string }>(`/api/agent/posts/lookup?${params.toString()}`);
			return text(`# ${post.title}\n状态：${post.status === "published" ? "已发布" : "草稿"}\n地址：${post.path}\n\n${post.content}`);
		},
	},
	{
		name: "blog_upsert_post",
		description: "把一篇 Markdown 创建或更新到博客。相同 externalKey 会更新同一篇文章，不会重复发布。不传 status 时，新文章是草稿，已有文章保持原状态。",
		inputSchema: objectSchema({
			title: { type: "string", description: "省略时从 path 的一级标题或文件名取得" },
			content: { type: "string" },
			path: { type: "string", description: "本机 Markdown 文件路径。提供后会读取文件内容" },
			externalKey: { type: "string", description: "稳定编号。重复同步时用来定位同一篇文章，默认使用文件相对路径" },
			excerpt: { type: "string" },
			slug: { type: "string" },
			categories: { type: "array", items: { type: "string" } },
			tags: { type: "array", items: { type: "string" } },
			cover: { type: ["string", "null"] },
			pinned: { type: "boolean" },
			status: { type: "string", enum: ["draft", "published"] },
		}),
		call: async (args) => {
			const path = stringArg(args, "path");
			const file = path ? await readMarkdown(path) : null;
			const content = stringArg(args, "content") ?? file?.content;
			const title = stringArg(args, "title") ?? file?.title;
			const externalKey = stringArg(args, "externalKey") ?? file?.externalKey;
			if (!content || !title || !externalKey) return text("请提供 content 和 title，或提供本机 Markdown 文件 path。", true);
			const status = stringArg(args, "status");
			const cover = args.cover;
			const result = await blogJson<PostResult>("/api/agent/posts", {
				method: "POST",
				body: {
					externalKey,
					title,
					content,
					excerpt: stringArg(args, "excerpt"),
					slug: stringArg(args, "slug"),
					categories: stringList(args, "categories"),
					tags: stringList(args, "tags"),
					cover: typeof cover === "string" || cover === null ? cover : undefined,
					pinned: booleanArg(args, "pinned"),
					status: status === "draft" || status === "published" ? status : undefined,
				},
			});
			return text(describePost(result));
		},
	},
	{
		name: "blog_sync_markdown",
		description: "把一组 Markdown 文件同步为博客文章。相同路径会更新原文。默认保存为草稿；已有文章不传 status 时保持原来的发布状态。",
		inputSchema: objectSchema({
			paths: { type: "array", items: { type: "string" } },
			directory: { type: "string", description: "同步这个目录下的 .md 文件，自动跳过 node_modules、dist 和 .git" },
			recursive: { type: "boolean" },
			category: { type: "string" },
			tags: { type: "array", items: { type: "string" } },
			status: { type: "string", enum: ["draft", "published"] },
		}),
		call: async (args) => {
			const status = stringArg(args, "status");
			const category = stringArg(args, "category");
			const files = await collectMarkdown({ paths: stringList(args, "paths"), directory: stringArg(args, "directory"), recursive: booleanArg(args, "recursive") });
			const lines: string[] = [];
			for (const filePath of files) {
				try {
					const document = await readMarkdown(filePath);
					const result = await blogJson<PostResult>("/api/agent/posts", {
						method: "POST",
						body: {
							externalKey: document.externalKey,
							title: document.title,
							content: document.content,
							categories: category ? [category] : undefined,
							tags: stringList(args, "tags"),
							status: status === "draft" || status === "published" ? status : undefined,
						},
					});
					lines.push(`- ${document.externalKey}：${result.action}《${result.post.title}》${result.post.path}`);
				} catch (error) {
					lines.push(`- ${filePath}：失败，${error instanceof Error ? error.message : "未知错误"}`);
				}
			}
			return text(lines.join("\n"));
		},
	},
	{
		name: "blog_publish_post",
		description: "发布一篇文章。需要授权里额外包含发布文章权限，对智能体同步的文章和后台文章都有效。",
		inputSchema: objectSchema({ id: { type: "integer", minimum: 1 } }, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供文章 id。", true);
			return text(describePost(await blogJson<PostResult>(`/api/agent/posts/${id}/publish`, { method: "POST" })));
		},
	},
	{
		name: "blog_unpublish_post",
		description: "把文章转回草稿。智能体同步过的文章使用写入权限即可；撤回后台文章需要发布文章权限。",
		inputSchema: objectSchema({ id: { type: "integer", minimum: 1 } }, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供文章 id。", true);
			return text(describePost(await blogJson<PostResult>(`/api/agent/posts/${id}/unpublish`, { method: "POST" })));
		},
	},
	{
		name: "blog_delete_post",
		description: "删除一篇文章。需要授权里额外包含删除文章权限，后台手工创建的文章也可以删除。",
		inputSchema: objectSchema({ id: { type: "integer", minimum: 1 } }, ["id"]),
		call: async (args) => {
			const id = integerArg(args, "id");
			if (!id) return text("请提供文章 id。", true);
			const result = await blogJson<{ externalKey: string | null }>(`/api/agent/posts/${id}`, { method: "DELETE" });
			return text(`已删除文章 ${id}${result.externalKey ? `（来源 ${result.externalKey}）` : ""}`);
		},
	},
	{
		name: "blog_upload_image",
		description: "上传一张图片并返回可以写进 Markdown 的地址。",
		inputSchema: objectSchema({ path: { type: "string" }, base64: { type: "string" }, filename: { type: "string" } }),
		call: async (args) => {
			const path = stringArg(args, "path");
			const base64 = stringArg(args, "base64");
			if (!path && !base64) return text("请提供图片 path 或 base64。", true);
			const bytes = path ? await readFile(path) : Buffer.from(base64 ?? "", "base64");
			if (bytes.byteLength > 8 * 1024 * 1024) return text("图片不能超过 8MB。", true);
			const name = stringArg(args, "filename") || (path ? basename(path) : "image.png");
			const type = IMAGE_TYPES[extname(name).toLowerCase()];
			if (!type) return text("只支持 png、jpg、gif、webp 和 avif。", true);
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
			const uploaded = await blogJson<{ url: string; markdown: string }>("/api/agent/images", { method: "POST", form });
			return text(`图片已上传。\n地址：${uploaded.url}\nMarkdown：${uploaded.markdown}`);
		},
	},
	{
		name: "blog_list_categories",
		description: "列出博客分类。",
		inputSchema: objectSchema({}),
		call: async () => {
			const items = await blogJson<Array<{ name: string; slug: string; postCount: number }>>("/api/agent/categories");
			if (!items.length) return text("还没有分类。");
			return text(items.map((item) => `- ${item.name}（${item.slug}，${item.postCount} 篇）`).join("\n"));
		},
	},
	{
		name: "blog_ensure_category",
		description: "按名称查找分类，不存在时创建。",
		inputSchema: objectSchema({ name: { type: "string" }, description: { type: "string" } }, ["name"]),
		call: async (args) => {
			const name = stringArg(args, "name");
			if (!name) return text("请提供分类名称。", true);
			const item = await blogJson<{ name: string; slug: string }>("/api/agent/categories", { method: "POST", body: { name, description: stringArg(args, "description") } });
			return text(`分类「${item.name}」可用，slug 为 ${item.slug}`);
		},
	},
	{
		name: "blog_list_tags",
		description: "列出博客标签。",
		inputSchema: objectSchema({}),
		call: async () => {
			const items = await blogJson<Array<{ name: string; slug: string; postCount: number }>>("/api/agent/tags");
			if (!items.length) return text("还没有标签。");
			return text(items.map((item) => `- ${item.name}（${item.slug}，${item.postCount} 篇）`).join("\n"));
		},
	},
	{
		name: "blog_ensure_tag",
		description: "按名称查找标签，不存在时创建。",
		inputSchema: objectSchema({ name: { type: "string" } }, ["name"]),
		call: async (args) => {
			const name = stringArg(args, "name");
			if (!name) return text("请提供标签名称。", true);
			const item = await blogJson<{ name: string; slug: string }>("/api/agent/tags", { method: "POST", body: { name } });
			return text(`标签「${item.name}」可用，slug 为 ${item.slug}`);
		},
	},
];

const allTools: Tool[] = [...tools, ...contentTools];
const toolMap = new Map(allTools.map((tool) => [tool.name, tool]));

function send(message: unknown) {
	const json = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

async function handleMessage(raw: string) {
	let message: { id?: unknown; method?: string; params?: { protocolVersion?: string; name?: string; arguments?: Json } };
	try { message = JSON.parse(raw) as typeof message; } catch { return; }
	const id = message.id;
	const respond = (result: unknown) => { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); };
	const fail = (code: number, textMessage: string) => { if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code, message: textMessage } }); };
	try {
		if (message.method === "initialize") {
			respond({
				protocolVersion: message.params?.protocolVersion || "2024-11-05",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "jayson-blog", version: "1.0.0" },
			});
			return;
		}
		if (message.method === "ping") { respond({}); return; }
		if (message.method === "tools/list") {
			respond({ tools: allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
			return;
		}
		if (message.method === "tools/call") {
			const tool = toolMap.get(message.params?.name ?? "");
			if (!tool) { fail(-32602, "未知工具"); return; }
			try {
				respond(await tool.call(message.params?.arguments ?? {}));
			} catch (error) {
				respond(failure(error));
			}
			return;
		}
		if (id !== undefined) fail(-32601, "不支持的方法");
	} catch (error) {
		fail(-32603, error instanceof Error ? error.message : "内部错误");
	}
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (buffer.length) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const match = /Content-Length:\s*(\d+)/iu.exec(header);
		if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
		const length = Number(match[1]);
		const start = headerEnd + 4;
		if (buffer.length < start + length) return;
		const body = buffer.subarray(start, start + length).toString("utf8");
		buffer = buffer.subarray(start + length);
		void handleMessage(body);
	}
});
process.stdin.resume();
