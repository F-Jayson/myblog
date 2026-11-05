import { z } from "zod";
import { AgentError, type AgentGrant, assertAgentScope, normalizeSlug, recordAgentAudit, taxonomySlug } from "./agentStore.js";
import {
	createAnnouncementHistory,
	createChangelog,
	createDynamic,
	deleteAnnouncementHistory,
	deleteChangelog,
	deleteComment,
	deleteCommentUser,
	deleteDynamic,
	deleteFeedback,
	deleteManagedPage,
	getAuthorProfile,
	getChangelog,
	getCommentSettings,
	getCurrentAnnouncement,
	getFeedback,
	getManagedPage,
	getSiteSetting,
	listAdminCommentUsers,
	listAdminComments,
	listAdminFeedback,
	listAllCategories,
	listAllDynamics,
	listAllTags,
	listAnnouncementHistory,
	listChangelogs,
	listManagedPages,
	publishAnnouncementHistory,
	saveManagedPage,
	saveSiteConfiguration,
	saveSiteSetting,
	siteSummary,
	updateAnnouncementHistory,
	updateAnnouncementHistoryDisplay,
	updateCategory,
	updateChangelog,
	updateCommentStatus,
	updateCommentUser,
	updateDynamic,
	updateFeedbackStatus,
	updateTag,
	deleteCategory,
	deleteTag,
} from "./repository.js";

const textValue = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

const dynamicInput = z.object({
	body: textValue(10000),
	images: z.array(z.string().trim().min(1).max(2000)).max(9).optional(),
	publishedAt: z.string().datetime({ offset: true }).optional(),
});

const pageInput = z.object({
	page: z.enum(["about", "transfer", "issues"]),
	title: textValue(255),
	content: z.string().max(1_500_000),
	friendLinksIntro: optionalText(500),
	friendLinks: z.array(z.object({
		name: textValue(120),
		url: textValue(2000),
		logo: z.string().trim().max(2000).optional(),
		description: z.string().trim().max(500).optional(),
	})).max(50).optional(),
});

const changelogInput = z.object({
	title: textValue(255),
	content: z.string().max(1_500_000),
	slug: optionalText(180),
	version: optionalText(80),
	date: z.string().trim().max(40).nullable().optional(),
	published: z.boolean().optional(),
});

const announcementInput = z.object({
	content: textValue(20000),
	publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const announcementDisplayInput = z.object({
	isVisible: z.boolean().optional(),
	isPinned: z.boolean().optional(),
	sortOrder: z.number().int().min(-100000).max(100000).optional(),
}).refine((value) => Object.keys(value).length > 0, "请提供要修改的显示设置");

const featureKeys = ["commentsEnabled", "registrationEnabled", "loginEnabled", "imageHostingEnabled", "clipboardEnabled", "userCenterEnabled", "publicResourcesEnabled", "compilerEnabled", "gamesEnabled"] as const;

const featureInput = z.object({
	commentsEnabled: z.boolean().optional(),
	registrationEnabled: z.boolean().optional(),
	loginEnabled: z.boolean().optional(),
	imageHostingEnabled: z.boolean().optional(),
	clipboardEnabled: z.boolean().optional(),
	userCenterEnabled: z.boolean().optional(),
	publicResourcesEnabled: z.boolean().optional(),
	compilerEnabled: z.boolean().optional(),
	gamesEnabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "请提供要修改的功能开关");

const commentFlagInput = z.object({
	commentsEnabled: z.boolean().optional(),
	commentRegistrationEnabled: z.boolean().optional(),
	commentModerationEnabled: z.boolean().optional(),
	allowAnonymous: z.boolean().optional(),
	emailRegistrationEnabled: z.boolean().optional(),
	notifyNewUser: z.boolean().optional(),
	notifyNewComment: z.boolean().optional(),
	notifyPendingComment: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "请提供要修改的评论设置");

const siteAsset = z.string().trim().max(2000).refine((value) => value === "" || value.startsWith("/") || /^https?:\/\//iu.test(value), "地址需要是站内路径或 http(s) 链接");
const siteInput = z.object({
	title: optionalText(120),
	subtitle: optionalText(255),
	description: optionalText(10000),
	hue: z.number().int().min(0).max(360).optional(),
	siteFavicon: siteAsset.optional(),
	siteLogo: siteAsset.optional(),
	siteLogoDark: siteAsset.optional(),
	videoUploadMaxSizeMb: z.number().int().min(1).max(2048).optional(),
	videoAutoTranscodeEnabled: z.boolean().optional(),
	cover: z.object({
		mode: z.enum(["upload", "url", "api"]),
		value: z.string().trim().max(2000),
		apiUrl: optionalText(2000),
		position: optionalText(120),
	}).strict().optional(),
	titleConfig: z.object({
		title: optionalText(120),
		subtitle: optionalText(500),
		subtitleMode: z.enum(["text", "hitokoto"]).optional(),
		hitokotoApi: optionalText(2000),
		titleFontUrl: optionalText(2000),
		subtitleFontUrl: optionalText(2000),
		bodyFontUrl: optionalText(2000),
		postTitleFontUrl: optionalText(2000),
		postContentFontUrl: optionalText(2000),
		tagFontUrl: optionalText(2000),
	}).strict().optional(),
	music: z.object({
		enabled: z.boolean().optional(),
		src: optionalText(2000),
		title: optionalText(255),
		artist: optionalText(255),
		cover: optionalText(2000),
		autoplay: z.boolean().optional(),
		loop: z.boolean().optional(),
	}).strict().optional(),
	author: z.object({
		name: optionalText(120),
		bio: optionalText(255),
		avatar: optionalText(2000),
		email: z.union([z.string().trim().email().max(190), z.literal(""), z.null()]).optional(),
		githubUrl: optionalText(2000),
		qqUrl: optionalText(2000),
		rssUrl: optionalText(2000),
		links: z.array(z.object({ label: textValue(80), url: textValue(2000), icon: optionalText(80) })).max(24).optional(),
	}).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "请提供要修改的站点设置");

const userInput = z.object({
	nickname: optionalText(80),
	isActive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "请提供昵称或启用状态");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new AgentError(400, "invalid_request", "请求参数不正确");
	return parsed.data;
}

function isDuplicate(error: unknown) {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY");
}

function notFound(found: unknown, message: string) {
	if (!found) throw new AgentError(404, "not_found", message);
	return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitSecrets);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value)
		.filter(([key]) => !/password|secret|token|private/iu.test(key))
		.map(([key, item]) => [key, omitSecrets(item)]));
}

function mergeSettings(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		merged[key] = isRecord(value) && isRecord(merged[key]) ? mergeSettings(merged[key], value) : value;
	}
	return merged;
}

function publicComment(item: Awaited<ReturnType<typeof listAdminComments>>[number]) {
	return {
		id: item.id,
		postId: item.postId,
		postTitle: item.postTitle,
		authorName: item.authorName,
		authorEmail: item.authorEmail,
		status: item.status,
		body: item.body,
		createdAt: item.createdAt,
		ipLocation: item.ipLocation,
		isAdmin: item.isAdmin,
	};
}

function publicFeedback(item: NonNullable<Awaited<ReturnType<typeof getFeedback>>>) {
	return { id: item.id, category: item.category, subject: item.subject, content: item.content, contact: item.contact, pageUrl: item.pageUrl, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

export async function agentComments(grant: AgentGrant, status?: string) {
	assertAgentScope(grant, "comments:read", "当前授权不能读取评论");
	const items = await listAdminComments(status);
	return items.slice(0, 100).map(publicComment);
}

export async function agentModerateComment(grant: AgentGrant, id: number, status: unknown) {
	assertAgentScope(grant, "comments:moderate", "当前授权不能审核评论");
	const next = parse(z.enum(["pending", "approved", "spam"]), status);
	if (!await updateCommentStatus(id, next)) throw new AgentError(404, "not_found", "评论不存在");
	await recordAgentAudit(grant, "comment", String(id), next);
	return { id, status: next };
}

export async function agentDeleteComment(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "comments:moderate", "当前授权不能删除评论");
	if (!await deleteComment(id)) throw new AgentError(404, "not_found", "评论不存在");
	await recordAgentAudit(grant, "comment-delete", String(id), "");
	return { deleted: true, id };
}

export async function agentDynamics(grant: AgentGrant) {
	assertAgentScope(grant, "content:read", "当前授权不能读取动态");
	return listAllDynamics();
}

export async function agentSaveDynamic(grant: AgentGrant, id: number | undefined, body: unknown) {
	assertAgentScope(grant, "content:publish", "编辑动态会立即公开，需要「发布站点内容」权限");
	const input = parse(dynamicInput, body);
	if (input.images?.some((image) => !image.startsWith("/") && !/^https?:\/\//iu.test(image))) throw new AgentError(400, "invalid_request", "动态图片需要是站内路径或 http(s) 链接");
	if (id) {
		if (!await updateDynamic(id, input)) throw new AgentError(404, "not_found", "动态不存在");
		await recordAgentAudit(grant, "dynamic", String(id), "updated");
		return { id, action: "updated" as const };
	}
	const created = await createDynamic(input);
	await recordAgentAudit(grant, "dynamic", String(created), "created");
	return { id: created, action: "created" as const };
}

export async function agentDeleteDynamic(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "content:delete", "当前授权不能删除动态");
	if (!await deleteDynamic(id)) throw new AgentError(404, "not_found", "动态不存在");
	await recordAgentAudit(grant, "dynamic-delete", String(id), "");
	return { deleted: true, id };
}

export async function agentPages(grant: AgentGrant) {
	assertAgentScope(grant, "content:read", "当前授权不能读取页面");
	return listManagedPages();
}

export async function agentPage(grant: AgentGrant, page: string) {
	assertAgentScope(grant, "content:read", "当前授权不能读取页面");
	return notFound(await getManagedPage(page), "页面不存在");
}

export async function agentSavePage(grant: AgentGrant, body: unknown) {
	assertAgentScope(grant, "content:publish", "保存页面会立即公开，需要「发布站点内容」权限");
	const input = parse(pageInput, body);
	const saved = await saveManagedPage({
		...input,
		friendLinks: input.friendLinks?.map((item) => ({ name: item.name, url: item.url, logo: item.logo ?? "", description: item.description ?? "" })),
	});
	await recordAgentAudit(grant, "page", input.page, input.title);
	return notFound(saved, "页面保存失败");
}

export async function agentDeletePage(grant: AgentGrant, page: string) {
	assertAgentScope(grant, "content:delete", "当前授权不能删除页面内容");
	if (!await deleteManagedPage(page)) throw new AgentError(404, "not_found", "页面不存在");
	await recordAgentAudit(grant, "page-delete", page, "");
	return { deleted: true, page };
}

export async function agentChangelogs(grant: AgentGrant) {
	assertAgentScope(grant, "content:read", "当前授权不能读取更新日志");
	return listChangelogs({ limit: 100 });
}

export async function agentSaveChangelog(grant: AgentGrant, id: number | undefined, body: unknown) {
	const input = parse(changelogInput, body);
	if (input.published) assertAgentScope(grant, "content:publish", "发布更新日志需要「发布站点内容」权限");
	else assertAgentScope(grant, "content:write", "当前授权不能编辑更新日志");
	const slug = normalizeSlug(input.slug || input.title);
	if (id) {
		const current = await getChangelog(id);
		if (!current) throw new AgentError(404, "not_found", "更新日志不存在");
		const published = input.published === undefined ? current.published : input.published;
		if (published && !grant.scopes.includes("content:publish")) throw new AgentError(403, "insufficient_scope", "发布更新日志需要「发布站点内容」权限");
		const saved = await updateChangelog(id, { slug, title: input.title, version: input.version, date: input.date, published, content: input.content });
		await recordAgentAudit(grant, "changelog", String(id), input.title);
		return notFound(saved, "更新日志不存在");
	}
	const saved = await createChangelog({ slug, title: input.title, version: input.version, date: input.date, published: input.published === true, content: input.content });
	await recordAgentAudit(grant, "changelog", String(saved?.id ?? ""), input.title);
	return notFound(saved, "更新日志保存失败");
}

export async function agentDeleteChangelog(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "content:delete", "当前授权不能删除更新日志");
	if (!await deleteChangelog(id)) throw new AgentError(404, "not_found", "更新日志不存在");
	await recordAgentAudit(grant, "changelog-delete", String(id), "");
	return { deleted: true, id };
}

export async function agentAnnouncements(grant: AgentGrant, page = 1, keyword?: string) {
	assertAgentScope(grant, "content:read", "当前授权不能读取公告");
	const [current, history] = await Promise.all([
		getCurrentAnnouncement(),
		listAnnouncementHistory({ page, limit: 20, keyword }),
	]);
	return { current, history };
}

export async function agentSaveAnnouncement(grant: AgentGrant, id: number | undefined, body: unknown) {
	assertAgentScope(grant, "content:write", "当前授权不能编辑公告草稿");
	const input = parse(announcementInput, body);
	const saved = id ? await updateAnnouncementHistory(id, input) : await createAnnouncementHistory(input);
	if (!saved) throw new AgentError(404, "not_found", "公告不存在");
	await recordAgentAudit(grant, "announcement", String(saved.id ?? id ?? ""), "saved");
	return saved;
}

export async function agentAnnouncementDisplay(grant: AgentGrant, id: number, body: unknown) {
	assertAgentScope(grant, "content:publish", "调整公告展示需要「发布站点内容」权限");
	const input = parse(announcementDisplayInput, body);
	const saved = await updateAnnouncementHistoryDisplay(id, input);
	if (!saved) throw new AgentError(404, "not_found", "公告不存在");
	await recordAgentAudit(grant, "announcement", String(id), "display");
	return saved;
}

export async function agentPublishAnnouncement(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "content:publish", "发布公告需要「发布站点内容」权限");
	const saved = await publishAnnouncementHistory(id);
	if (!saved) throw new AgentError(404, "not_found", "公告不存在");
	await recordAgentAudit(grant, "announcement-publish", String(id), "");
	return saved;
}

export async function agentDeleteAnnouncement(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "content:delete", "当前授权不能删除公告");
	if (!await deleteAnnouncementHistory(id)) throw new AgentError(404, "not_found", "公告不存在");
	await recordAgentAudit(grant, "announcement-delete", String(id), "");
	return { deleted: true, id };
}

export async function agentFeedback(grant: AgentGrant, filters: { page?: number; status?: string; keyword?: string }) {
	assertAgentScope(grant, "content:read", "当前授权不能读取反馈");
	const result = await listAdminFeedback({ page: filters.page, limit: 20, status: filters.status, keyword: filters.keyword });
	return { ...result, items: result.items.map(publicFeedback) };
}

export async function agentUpdateFeedback(grant: AgentGrant, id: number, status: unknown) {
	assertAgentScope(grant, "content:write", "当前授权不能处理反馈");
	const next = parse(z.enum(["open", "processing", "resolved"]), status);
	const saved = await updateFeedbackStatus(id, next);
	if (!saved) throw new AgentError(404, "not_found", "反馈不存在");
	await recordAgentAudit(grant, "feedback", String(id), next);
	return publicFeedback(saved);
}

export async function agentDeleteFeedback(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "content:delete", "当前授权不能删除反馈");
	if (!await deleteFeedback(id)) throw new AgentError(404, "not_found", "反馈不存在");
	await recordAgentAudit(grant, "feedback-delete", String(id), "");
	return { deleted: true, id };
}

export async function agentSiteOverview(grant: AgentGrant) {
	assertAgentScope(grant, "site:read", "当前授权不能读取站点设置");
	const [summary, features, comments] = await Promise.all([siteSummary(), getSiteSetting("features"), getCommentSettings()]);
	const featureSource = isRecord(features) ? features : {};
	return {
		stats: summary.stats,
		site: omitSecrets(summary.site),
		author: summary.author,
		features: Object.fromEntries(featureKeys.map((key) => [key, featureSource[key] !== false])),
		comments,
	};
}

export async function agentUpdateSite(grant: AgentGrant, body: unknown) {
	assertAgentScope(grant, "site:write", "当前授权不能修改站点设置");
	const input = parse(siteInput, body);
	const { author: authorPatch, ...sitePatch } = input;
	const [currentSetting, currentAuthor] = await Promise.all([getSiteSetting("site"), getAuthorProfile()]);
	const value = mergeSettings(isRecord(currentSetting) ? currentSetting : {}, sitePatch);
	const author = authorPatch ? {
		name: authorPatch.name || currentAuthor?.name || "Jayson",
		bio: authorPatch.bio ?? currentAuthor?.bio ?? "",
		avatar: authorPatch.avatar ?? currentAuthor?.avatar ?? "",
		email: authorPatch.email === "" ? null : (authorPatch.email ?? currentAuthor?.email ?? null),
		githubUrl: authorPatch.githubUrl ?? currentAuthor?.githubUrl ?? null,
		qqUrl: authorPatch.qqUrl ?? currentAuthor?.qqUrl ?? null,
		rssUrl: authorPatch.rssUrl ?? currentAuthor?.rssUrl ?? null,
		links: authorPatch.links ?? currentAuthor?.links ?? [],
		profile: currentAuthor?.profile,
	} : undefined;
	await saveSiteConfiguration(value, author);
	await recordAgentAudit(grant, "site", "site", authorPatch ? "author" : "settings");
	return agentSiteOverview(grant);
}

export async function agentUpdateFeatures(grant: AgentGrant, body: unknown) {
	assertAgentScope(grant, "site:write", "当前授权不能修改功能开关");
	const patch = parse(featureInput, body);
	const current = await getSiteSetting("features");
	const value = { ...(isRecord(current) ? current : {}), ...patch };
	await saveSiteSetting("features", value);
	await recordAgentAudit(grant, "features", Object.keys(patch).join(","), "");
	return Object.fromEntries(featureKeys.map((key) => [key, value[key] !== false]));
}

export async function agentUpdateCommentSettings(grant: AgentGrant, body: unknown) {
	assertAgentScope(grant, "site:write", "当前授权不能修改评论设置");
	const patch = parse(commentFlagInput, body);
	const current = await getSiteSetting("comments");
	const value = { ...(isRecord(current) ? current : {}), ...patch };
	await saveSiteSetting("comments", value);
	await recordAgentAudit(grant, "comments-settings", Object.keys(patch).join(","), "");
	return getCommentSettings();
}

export async function agentUsers(grant: AgentGrant) {
	assertAgentScope(grant, "users:read", "当前授权不能读取用户");
	return listAdminCommentUsers();
}

export async function agentUpdateUser(grant: AgentGrant, id: number, body: unknown) {
	assertAgentScope(grant, "users:manage", "当前授权不能管理用户");
	const input = parse(userInput, body);
	if (input.nickname !== undefined && !input.nickname) throw new AgentError(400, "invalid_request", "昵称不能为空");
	if (!await updateCommentUser(id, { nickname: input.nickname, isActive: input.isActive })) throw new AgentError(404, "not_found", "用户不存在");
	await recordAgentAudit(grant, "user", String(id), input.isActive === false ? "disabled" : "updated");
	const saved = (await listAdminCommentUsers()).find((item) => item.id === id);
	return notFound(saved, "用户不存在");
}

export async function agentDeleteUser(grant: AgentGrant, id: number) {
	assertAgentScope(grant, "users:manage", "当前授权不能删除用户");
	if (!await deleteCommentUser(id)) throw new AgentError(404, "not_found", "用户不存在");
	await recordAgentAudit(grant, "user-delete", String(id), "");
	return { deleted: true, id };
}

export async function agentUpdateTaxonomy(grant: AgentGrant, kind: "category" | "tag", id: number, body: unknown) {
	assertAgentScope(grant, "taxonomy:manage", "当前授权不能修改分类或标签");
	const input = parse(z.object({ name: textValue(80), description: optionalText(255) }).strict(), body);
	const slug = taxonomySlug(input.name);
	try {
		if (kind === "category") {
			const current = (await listAllCategories()).find((item) => item.id === id);
			if (!current) throw new AgentError(404, "not_found", "分类不存在");
			if (!await updateCategory(id, { name: input.name, slug, description: input.description ?? current.description })) throw new AgentError(404, "not_found", "分类不存在");
		} else if (!await updateTag(id, { name: input.name, slug })) throw new AgentError(404, "not_found", "标签不存在");
	} catch (error) {
		if (error instanceof AgentError) throw error;
		if (isDuplicate(error)) throw new AgentError(409, "conflict", "已经有同名分类或标签");
		throw error;
	}
	await recordAgentAudit(grant, kind, String(id), input.name);
	return { id, name: input.name, slug };
}

export async function agentDeleteTaxonomy(grant: AgentGrant, kind: "category" | "tag", id: number) {
	assertAgentScope(grant, "taxonomy:manage", "当前授权不能删除分类或标签");
	const removed = kind === "category" ? await deleteCategory(id) : await deleteTag(id);
	if (!removed) throw new AgentError(404, "not_found", kind === "category" ? "分类不存在" : "标签不存在");
	await recordAgentAudit(grant, `${kind}-delete`, String(id), "");
	return { deleted: true, id };
}
