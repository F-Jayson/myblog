import { fallbackPosts, fallbackPostsFor, fallbackSite } from "./data";
import type { AuthorHeatmap, AuthorProfile, AuthorProfilePayload, ChangelogEntry, CommentRecord, CommentSettings, CompilerRunRequest, CompilerRunResult, EmojiSticker, FeatureSettings, FeedbackSettings, ManagedPage, ManagedPageKey, Paginated, Post, PostSummary, PublicUser, SiteData, UserClipboard, UserSpaceStats, UserStorageItem } from "./types";

const REQUEST_TIMEOUT_MS = 2_000;
const REQUEST_RETRY_DELAY_MS = 10_000;
const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
const requestCache = new Map<string, Promise<unknown>>();
const retryAfter = new Map<string, number>();

const USER_TOKEN_KEY = "firefly-user-token";

function userToken() {
	try { return localStorage.getItem(USER_TOKEN_KEY) ?? ""; } catch { return ""; }
}

function authHeaders(headers?: HeadersInit) {
	const result = new Headers(headers);
	const token = userToken();
	if (token && !result.has("authorization")) result.set("authorization", `Bearer ${token}`);
	return result;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
	const controller = new AbortController();
	const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers = authHeaders(init.headers);
		let body = init.body;
		if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof URLSearchParams) && !(body instanceof ArrayBuffer)) {
			if (!headers.has("content-type")) headers.set("content-type", "application/json");
			if (headers.get("content-type")?.includes("application/json")) body = JSON.stringify(body);
		}
		const response = await fetch(`${API_ORIGIN}${path}`, { ...init, headers, body, signal: controller.signal });
		const text = await response.text();
		let payload: unknown = null;
		if (text) { try { payload = JSON.parse(text); } catch { payload = text; } }
		if (!response.ok) {
			const message = payload && typeof payload === "object" && ("error" in payload || "message" in payload)
				? String((payload as { error?: unknown; message?: unknown }).error ?? (payload as { message?: unknown }).message ?? "")
				: "";
			throw new Error(message || `${response.status} ${response.statusText}`);
		}
		return payload as T;
	} finally {
		window.clearTimeout(timeout);
	}
}

function jsonRequest<T>(path: string, method: string, body: unknown) {
	return request<T>(path, { method, body: body as BodyInit });
}

function putUserToken(token: unknown) {
	if (typeof token !== "string" || !token.trim()) return;
	try { localStorage.setItem(USER_TOKEN_KEY, token.trim()); } catch { /* storage can be unavailable in private contexts */ }
}

function clearUserToken() {
	try { localStorage.removeItem(USER_TOKEN_KEY); } catch { /* ignore */ }
}

function cachedRequest<T>(cacheKey: string, path: string): Promise<T> {
	const cached = requestCache.get(cacheKey) as Promise<T> | undefined;
	if (cached) return cached;
	const nextRetryAt = retryAfter.get(cacheKey);
	if (nextRetryAt && nextRetryAt > Date.now()) return Promise.reject(new Error("Request retry is delayed"));
	retryAfter.delete(cacheKey);

	const pending = request<T>(path);
	requestCache.set(cacheKey, pending);
	void pending.catch(() => {
		if (requestCache.get(cacheKey) === pending) requestCache.delete(cacheKey);
		retryAfter.set(cacheKey, Date.now() + REQUEST_RETRY_DELAY_MS);
	});
	return pending;
}

async function requestFirst<T>(paths: string[], init: RequestInit = {}): Promise<T> {
	let lastError: unknown = null;
	for (const path of paths) {
		try {
			return await request<T>(path, init);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("公开内容接口暂不可用");
}

function unwrapPayload(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	return record.data ?? record.item ?? record.result ?? value;
}

function normalizeManagedPage(value: unknown, page: ManagedPageKey): ManagedPage | null {
	const candidate = unwrapPayload(value);
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const record = candidate as Record<string, unknown>;
	const title = String(record.title ?? "").trim();
	const content = String(record.content ?? record.body ?? "");
	if (!title && !content && !Array.isArray(record.friendLinks)) return null;
	const rawFriendLinks = Array.isArray(record.friendLinks)
		? record.friendLinks
		: typeof record.friendLinks === "string"
			? (() => { try { const parsed = JSON.parse(record.friendLinks as string); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })()
			: [];
	const friendLinks = rawFriendLinks.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const link = item as Record<string, unknown>;
		const name = String(link.name ?? link.label ?? "").trim();
		const url = String(link.url ?? link.href ?? "").trim();
		if (!name || !url) return [];
		return [{
			name,
			url,
			logo: String(link.logo ?? link.logoUrl ?? link.image ?? link.icon ?? "").trim() || null,
			description: String(link.description ?? link.text ?? link.summary ?? "").trim() || null,
		}];
	});
	return {
		page,
		title,
		content,
		friendLinksIntro: String(record.friendLinksIntro ?? record.friend_links_intro ?? ""),
		friendLinks,
		updatedAt: String(record.updatedAt ?? record.updated_at ?? ""),
		relativePath: String(record.relativePath ?? record.relative_path ?? ""),
	};
}

function normalizeChangelogEntries(value: unknown): ChangelogEntry[] {
	const candidate = unwrapPayload(value);
	const list = Array.isArray(candidate)
		? candidate
		: candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).items)
			? (candidate as Record<string, unknown>).items as unknown[]
			: [];
	return list.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		const title = String(record.title ?? "").trim();
		const content = String(record.content ?? record.body ?? "");
		if (!title && !content) return [];
		return [{
			fileName: String(record.fileName ?? record.filename ?? "").trim() || undefined,
			slug: String(record.slug ?? "").trim() || undefined,
			title: title || "更新日志",
			version: String(record.version ?? "").trim() || undefined,
			date: String(record.date ?? record.publishedAt ?? record.published_at ?? record.updatedAt ?? "").trim() || undefined,
			published: record.published === undefined ? true : Boolean(record.published),
			content,
			updatedAt: String(record.updatedAt ?? record.updated_at ?? "").trim() || undefined,
		} satisfies ChangelogEntry];
	});
}

function normalizeAuthorProfile(value: unknown): AuthorProfilePayload | null {
	const candidate = unwrapPayload(value);
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
	const envelope = candidate as Record<string, unknown>;
	const authorRecord = envelope.author && typeof envelope.author === "object" && !Array.isArray(envelope.author)
		? envelope.author as Record<string, unknown>
		: envelope;
	const profileRecord = authorRecord.profile && typeof authorRecord.profile === "object" && !Array.isArray(authorRecord.profile)
		? authorRecord.profile as Record<string, unknown>
		: authorRecord;
	const skills = (value: unknown): AuthorProfile["skills"] => Array.isArray(value) ? value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const entry = item as Record<string, unknown>;
		const name = String(entry.name ?? entry.title ?? entry.label ?? "").trim();
		if (!name) return [];
		const rawLevel = Number(entry.level ?? entry.progress ?? entry.value ?? 0);
		const level = Number.isFinite(rawLevel) ? Math.max(0, Math.min(100, Math.round(rawLevel))) : 0;
		const description = String(entry.description ?? entry.summary ?? entry.detail ?? "").trim() || null;
		const icon = String(entry.icon ?? "").trim() || null;
		return [{ name, level, description, icon }];
	}) : [];
	const learning = (value: unknown): AuthorProfile["learning"] => Array.isArray(value) ? value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const entry = item as Record<string, unknown>;
		const name = String(entry.name ?? entry.title ?? entry.label ?? "").trim();
		if (!name) return [];
		const rawProgress = Number(entry.progress ?? entry.level ?? entry.value ?? 0);
		const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, Math.round(rawProgress))) : 0;
		const description = String(entry.description ?? entry.summary ?? entry.detail ?? "").trim() || null;
		const status = String(entry.status ?? "").trim() || null;
		return [{ name, progress, description, status }];
	}) : [];
	const links = Array.isArray(authorRecord.links) ? authorRecord.links.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const entry = item as Record<string, unknown>;
		const label = String(entry.label ?? entry.name ?? "").trim();
		const url = String(entry.url ?? entry.href ?? "").trim();
		if (!label || !url) return [];
		return [{ label, url, icon: String(entry.icon ?? "").trim() || null }];
	}) : [];
	const name = String(authorRecord.name ?? authorRecord.displayName ?? authorRecord.nickname ?? "").trim();
	const bio = String(authorRecord.bio ?? authorRecord.summary ?? "").trim();
	const avatar = String(authorRecord.avatar ?? authorRecord.avatarUrl ?? "").trim();
	if (!name && !bio && !avatar && !Array.isArray(profileRecord.skills) && !Array.isArray(profileRecord.learningProgress)) return null;
	const author: AuthorProfile = {
		name, bio, avatar,
		email: String(authorRecord.email ?? "").trim() || null,
		githubUrl: String(authorRecord.githubUrl ?? authorRecord.github_url ?? "").trim() || null,
		qqUrl: String(authorRecord.qqUrl ?? authorRecord.qq_url ?? "").trim() || null,
		rssUrl: String(authorRecord.rssUrl ?? authorRecord.rss_url ?? "").trim() || null,
		links,
		headline: String(profileRecord.headline ?? profileRecord.title ?? profileRecord.role ?? "").trim() || null,
		location: String(profileRecord.location ?? "").trim() || null,
		website: String(profileRecord.website ?? profileRecord.url ?? "").trim() || null,
		introduction: String(profileRecord.introduction ?? profileRecord.content ?? profileRecord.description ?? "").trim() || null,
		skills: skills(profileRecord.skills ?? profileRecord.expertise),
		learning: learning(profileRecord.learning ?? profileRecord.learningProgress ?? profileRecord.learning_progress),
	};
	const rawHeatmap = envelope.heatmap && typeof envelope.heatmap === "object" && !Array.isArray(envelope.heatmap)
		? envelope.heatmap as Record<string, unknown>
		: {};
	const days = Array.isArray(rawHeatmap.days) ? rawHeatmap.days.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const entry = item as Record<string, unknown>;
		const date = String(entry.date ?? "").trim();
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return [];
		const count = Number(entry.count);
		return [{ date, count: Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0 }];
	}) : [];
	const heatmap: AuthorHeatmap = {
		from: String(rawHeatmap.from ?? "").trim() || days[0]?.date || null,
		to: String(rawHeatmap.to ?? "").trim() || days.at(-1)?.date || null,
		totalPosts: Number.isFinite(Number(rawHeatmap.totalPosts))
			? Math.max(0, Math.round(Number(rawHeatmap.totalPosts)))
			: days.reduce((total, day) => total + day.count, 0),
		days,
	};
	return { author, heatmap };
}

export const api = {
	async site(): Promise<SiteData> {
		return cachedRequest<SiteData>("site", "/api/site").catch(() => fallbackSite);
	},
	async authorProfile(): Promise<AuthorProfilePayload | null> {
		try {
			const payload = await requestFirst<unknown>(["/api/site/author-profile", "/api/author-profile", "/api/site/blogger"]);
			return normalizeAuthorProfile(payload);
		} catch {
			return null;
		}
	},
	async posts(params: { page?: number; pageSize?: number; category?: string; tag?: string; q?: string } = {}) {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") search.set(key, String(value));
		}
		const cacheKey = search.toString();
		return cachedRequest<Paginated<PostSummary>>(`posts:${cacheKey}`, `/api/posts?${cacheKey}`).catch(() => fallbackPostsFor(params));
	},
	async post(slug: string): Promise<Post | null> {
		return cachedRequest<Post>(`post:${slug}`, `/api/posts/${encodeURIComponent(slug)}`).catch(() => fallbackPosts.find((post) => post.slug === slug) ?? null);
	},
	async page(page: ManagedPageKey): Promise<ManagedPage | null> {
		const key = encodeURIComponent(page);
		try {
			const payload = await requestFirst<unknown>([
				"/api/site/pages/" + key,
				"/api/pages/" + key,
				"/api/site/pages/content?page=" + key,
				"/api/pages/content?page=" + key,
			]);
			return normalizeManagedPage(payload, page);
		} catch {
			return null;
		}
	},
	async changelogs(limit = 100): Promise<ChangelogEntry[]> {
		const query = "?limit=" + Math.max(1, Math.min(200, Math.floor(limit))) + "&publishedOnly=true";
		try {
			const payload = await requestFirst<unknown>(["/api/site/changelog" + query, "/api/changelog" + query]);
			return normalizeChangelogEntries(payload);
		} catch {
			return [];
		}
	},
	async feedbackSettings(): Promise<FeedbackSettings> {
		try {
			const payload = unwrapPayload(await requestFirst<unknown>(["/api/site/feedback/settings", "/api/feedback/settings"]));
			const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
			return {
				enabled: record.enabled === undefined ? record.feedbackEnabled !== false : record.enabled === true,
				maxFiles: Number(record.maxFiles ?? 2) || 2,
				maxFileSizeMb: Number(record.maxFileSizeMb ?? 20) || 20,
			};
		} catch {
			return { enabled: true, maxFiles: 2, maxFileSizeMb: 20 };
		}
	},
	async submitFeedback(input: { category: string; subject: string; content: string; contact?: string; pageUrl?: string }) {
		return requestFirst<{ id?: string | number; ok?: boolean }>(["/api/site/feedback", "/api/feedback"], { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
	},
	async authMe(): Promise<PublicUser | null> {
		if (!userToken()) return null;
		try {
			const payload = await request<{ user?: PublicUser | null }>("/api/auth/me");
			return payload.user ?? null;
		} catch { clearUserToken(); return null; }
	},
	async authLogin(input: { username: string; password: string }): Promise<PublicUser> {
		const payload = await jsonRequest<{ token?: string; user?: PublicUser }>("/api/auth/login", "POST", input);
		putUserToken(payload.token);
		if (!payload.user) throw new Error("登录响应缺少用户信息");
		return payload.user;
	},
	async authRegister(input: { username: string; nickname: string; password: string; email?: string; emailCode?: string; avatar?: string }): Promise<PublicUser> {
		const payload = await jsonRequest<{ token?: string; user?: PublicUser }>("/api/auth/register", "POST", input);
		putUserToken(payload.token);
		if (!payload.user) throw new Error("注册响应缺少用户信息");
		return payload.user;
	},
	async authEmailCode(email: string) {
		return jsonRequest<{ ok?: boolean; sent?: boolean; debugCode?: string; expiresInSeconds?: number }>("/api/auth/email-code", "POST", { email });
	},
	async authLogout() {
		try { await request<void>("/api/auth/logout", { method: "POST" }); } finally { clearUserToken(); }
	},
	async commentSettings(): Promise<CommentSettings> {
		const fallback: CommentSettings = { commentsEnabled: true, commentRegistrationEnabled: true, commentModerationEnabled: false, allowAnonymous: false, emailRegistrationEnabled: false, avatarPresets: [] };
		try {
			const result = await request<Partial<CommentSettings>>("/api/comment-settings");
			return { ...fallback, ...result, avatarPresets: Array.isArray(result.avatarPresets) ? result.avatarPresets : [] };
		} catch { return fallback; }
	},
	async features(): Promise<FeatureSettings> {
		const fallback: FeatureSettings = { commentsEnabled: true, registrationEnabled: true, loginEnabled: true, imageHostingEnabled: true, clipboardEnabled: true, userCenterEnabled: true, publicResourcesEnabled: true, compilerEnabled: true };
		try {
			const result = await request<Partial<FeatureSettings>>("/api/features");
			return { ...fallback, ...result };
		} catch { return fallback; }
	},
	async compilerRun(input: CompilerRunRequest): Promise<CompilerRunResult> {
		return request<CompilerRunResult>("/api/compiler/run", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } }, 35_000);
	},
	async compilerFormat(input: { language: string; code: string }): Promise<{ language: string; code: string }> {
		return request<{ language: string; code: string }>("/api/compiler/format", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
	},
	async comments(postId: number): Promise<CommentRecord[]> {
		try {
			const result = await request<CommentRecord[] | { items?: CommentRecord[]; comments?: CommentRecord[] }>(`/api/posts/${postId}/comments`);
			return Array.isArray(result) ? result : result.items ?? result.comments ?? [];
		} catch { return []; }
	},
	async createComment(input: { postId: number; body: string; parentId?: number | string | null; authorName?: string; avatar?: string; images?: string[] }) {
		return jsonRequest<{ id: number | string; status?: string }>("/api/comments", "POST", input);
	},
	async uploadAvatar(file: File) { return uploadFile("/api/uploads/avatar", file); },
	async uploadCommentImage(file: File) { return uploadFile("/api/uploads/comment-image", file); },
	async emojis(): Promise<EmojiSticker[]> {
		try {
			const result = await request<EmojiSticker[] | { items?: EmojiSticker[] }>("/api/emojis");
			return Array.isArray(result) ? result : result.items ?? [];
		} catch { return []; }
	},
	async userStickers(): Promise<EmojiSticker[]> {
		try {
			const result = await request<EmojiSticker[] | { items?: EmojiSticker[] }>("/api/auth/me/stickers");
			return Array.isArray(result) ? result : result.items ?? [];
		} catch { return []; }
	},
	async uploadSticker(file: File, name?: string) {
		const form = new FormData();
		form.append("file", file);
		if (name?.trim()) form.append("name", name.trim());
		return request<EmojiSticker>("/api/user/stickers", { method: "POST", body: form });
	},
	async userSpace(): Promise<UserSpaceStats> {
		const payload = await request<unknown>("/api/user/space");
		const value = unwrapPayload(payload) as Record<string, unknown>;
		return { limitBytes: Number(value.limitBytes ?? value.limit ?? 30 * 1024 * 1024), usedBytes: Number(value.usedBytes ?? value.used ?? 0), remainingBytes: Number(value.remainingBytes ?? value.remaining ?? 0), categories: (value.categories && typeof value.categories === "object") ? value.categories as Record<string, number> : {} };
	},
	async userStorage(): Promise<UserStorageItem[]> {
		const payload = await request<unknown>("/api/user/storage"); const value = unwrapPayload(payload);
		const list = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items : []);
		return (list as Record<string, unknown>[]).map((item) => ({ ...item, storageKey: typeof item.storageKey === "string" ? item.storageKey : undefined, url: String(item.url ?? item.publicUrl ?? "") || null, sizeBytes: Number(item.sizeBytes ?? item.byteSize ?? 0), accessCount: Number(item.accessCount ?? item.viewCount ?? 0) })) as UserStorageItem[];
	},
	async uploadUserStorage(file: File, name?: string, isPublic = false): Promise<UserStorageItem> {
		const form = new FormData(); form.append("file", file); if (name?.trim()) form.append("name", name.trim()); form.append("isPublic", String(isPublic));
		return request<UserStorageItem>("/api/user/storage", { method: "POST", body: form });
	},
	async updateUserStorage(id: number | string, input: { isPublic?: boolean; name?: string }) { return request<UserStorageItem>(`/api/user/storage/${encodeURIComponent(String(id))}`, { method: "PATCH", body: JSON.stringify(input), headers: { "content-type": "application/json" } }); },
	async deleteUserStorage(id: number | string) { return request<void>(`/api/user/storage/${encodeURIComponent(String(id))}`, { method: "DELETE" }); },
	async userStorageFile(id: number | string) { return request<{ url?: string }>(`/api/user/storage/${encodeURIComponent(String(id))}/file`); },
	async userClipboards(): Promise<UserClipboard[]> {
		const payload = await request<unknown>("/api/user/clipboards"); const value = unwrapPayload(payload);
		const list = Array.isArray(value) ? value : (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items : []);
		return (list as Record<string, unknown>[]).map((item) => ({ ...item, sizeBytes: Number(item.sizeBytes ?? item.byteSize ?? 0), accessCount: Number(item.accessCount ?? item.viewCount ?? 0) })) as UserClipboard[];
	},
	async createClipboard(input: { title: string; content: string; isPublic?: boolean }) { return request<UserClipboard>("/api/user/clipboards", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } }); },
	async updateClipboard(id: number | string, input: Partial<{ title: string; content: string; isPublic: boolean }>) { return request<UserClipboard>(`/api/user/clipboards/${encodeURIComponent(String(id))}`, { method: "PATCH", body: JSON.stringify(input), headers: { "content-type": "application/json" } }); },
	async deleteClipboard(id: number | string) { return request<void>(`/api/user/clipboards/${encodeURIComponent(String(id))}`, { method: "DELETE" }); },
	async userProfile(): Promise<PublicUser> { return request<PublicUser>("/api/user/profile"); },
	async updateUserProfile(input: Record<string, unknown>) { return request<PublicUser>("/api/user/profile", { method: "PATCH", body: JSON.stringify(input), headers: { "content-type": "application/json" } }); },
	async userProfileEmailCode(email: string) { return jsonRequest<{ sent?: boolean; debugCode?: string }>("/api/user/profile/email-code", "POST", { email }); },
	publicResourceUrl(token: string) { return `${API_ORIGIN}/api/public/resources/${encodeURIComponent(token)}`; },
	async archive() {
		return cachedRequest<Array<{ year: number; id: number; slug: string; title: string; publishedAt: string; category: string | null }>>("archive", "/api/archive").catch(() => fallbackPosts.map((post) => ({
				year: Number((post.publishedAt ?? "2026").slice(0, 4)),
				id: post.id,
				slug: post.slug,
				title: post.title,
				publishedAt: post.publishedAt ?? "",
				category: post.category?.name ?? null,
			})));
	},
};

async function uploadFile(path: string, file: File): Promise<string> {
	const form = new FormData();
	form.append("file", file);
	const payload = await request<{ url?: string; path?: string; src?: string }>(path, { method: "POST", body: form });
	const url = payload.url ?? payload.path ?? payload.src;
	if (!url) throw new Error("上传响应缺少图片地址");
	return url;
}

export { USER_TOKEN_KEY };
