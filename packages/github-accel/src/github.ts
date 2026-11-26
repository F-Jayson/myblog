/**
 * GitHub 相关的纯规则与 API 调用：域名白名单、URL/仓库名校验、链接解析、Release 列表。
 *
 * 这里不碰 HTTP 响应对象，所有函数都能直接单测；真正的转发在 proxy.ts。
 */
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { config } from "./config.js";

/** 只有这些域名允许被代理；改动必须同步 docs/github-accelerator.md 第 3 节。 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"raw.githubusercontent.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
]);

const MAX_INPUT_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;
// 同时挡住 "."、".." 这类会拼出奇怪上游路径的名字：它们会被原样拼进 github.com 的 URL。
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

export type GithubResolved =
	| { readonly kind: "repo"; readonly owner: string; readonly repo: string; readonly repoUrl: string }
	| { readonly kind: "release"; readonly owner: string; readonly repo: string; readonly tag: string; readonly repoUrl: string }
	| {
		readonly kind: "file";
		readonly owner: string;
		readonly repo: string;
		readonly fileName: string;
		readonly url: string;
		readonly origin: "release" | "archive" | "raw";
		readonly tag?: string;
		readonly ref?: string;
	}
	| { readonly kind: "invalid"; readonly error: string };

export type UrlFailureCode = "HOST_NOT_ALLOWED" | "PROTOCOL_NOT_ALLOWED" | "URL_INVALID";

export type UrlCheck =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly code: UrlFailureCode; readonly error: string };

export function isValidName(value: string): boolean {
	return value.length > 0 && value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value) && value !== "." && value !== "..";
}

const INVALID_NAME_ERROR = "仓库所有者或仓库名不合法：只允许字母、数字、点、下划线与短横线，且不超过 100 个字符";

/**
 * 上游地址校验。ticket 里的 u 是主站签发的，但仍然要校验：签名只能证明"这条 URL 来自主站"，
 * 不能证明主站当时没被输入一个内网地址。
 */
export function checkAllowedUrl(input: string): UrlCheck {
	const trimmed = input.trim();
	if (!trimmed) return { ok: false, code: "URL_INVALID", error: "缺少要加速的地址" };

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, code: "URL_INVALID", error: "这不是一个合法的链接" };
	}
	// 文档只允许 https：明文回源会让 ticket 与内容一起暴露在链路上。
	if (url.protocol !== "https:") {
		return { ok: false, code: "PROTOCOL_NOT_ALLOWED", error: "只允许加速 https 链接（当前：" + url.protocol + "）" };
	}
	// 带凭据的 URL 会把口令写进日志，一律拒绝。
	if (url.username || url.password) {
		return { ok: false, code: "URL_INVALID", error: "链接里不能包含用户名或密码" };
	}
	const host = url.hostname.toLowerCase();
	if (host.endsWith(".")) {
		return { ok: false, code: "HOST_NOT_ALLOWED", error: "域名不合法：" + url.hostname };
	}
	// 只允许默认 https 端口：带自定义端口的 URL 会把流量引向非 GitHub 服务。
	if (url.port && url.port !== "443") {
		return { ok: false, code: "PORT_NOT_ALLOWED", error: "只允许 GitHub 的默认 https 端口（当前：" + url.port + "）" };
	}
	if (!ALLOWED_HOSTS.has(host)) {
		return { ok: false, code: "HOST_NOT_ALLOWED", error: "只允许 GitHub 域名（当前：" + url.hostname + "）" };
	}
	return { ok: true, url: url.toString() };
}

export function isAllowedUrl(input: string): boolean {
	return checkAllowedUrl(input).ok;
}

/**
 * git 路径校验：/owner/repo.git 或 /owner/repo。
 * 注意不能只校验首段，否则 "../../etc" 这类路径会直接被拼进上游 URL。
 */
export function isAllowedGitPath(path: string): boolean {
	const normalized = path.replace(/^\/+|\/+$/gu, "");
	if (!normalized) return false;
	const segments = normalized.split("/");
	if (segments.length !== 2) return false;
	const owner = segments[0] ?? "";
	const repo = segments[1] ?? "";
	if (!isValidName(owner) || !isValidName(repo)) return false;
	return true;
}

/** 把 /owner/repo.git 归一成 { owner, repo }；repo 去掉 .git 后缀。 */
export function parseGitPath(path: string): { owner: string; repo: string } | null {
	const normalized = path.replace(/^\/+|\/+$/gu, "");
	const segments = normalized.split("/");
	if (segments.length !== 2) return null;
	const owner = segments[0] ?? "";
	const repo = (segments[1] ?? "").replace(/\.git$/iu, "");
	if (!isValidName(owner) || !isValidName(repo)) return null;
	return { owner, repo };
}

function invalid(error: string): GithubResolved {
	return { kind: "invalid", error };
}

function decodeSegment(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function stripQueryAndFragment(value: string) {
	const index = value.search(/[?#]/u);
	return index >= 0 ? value.slice(0, index) : value;
}

export function repoUrl(owner: string, repo: string) {
	return "https://github.com/" + owner + "/" + repo;
}

type ParsedUrl = { host: string; segments: string[] };

function parseAbsoluteUrl(text: string): ParsedUrl | null {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	// 用户常把地址栏里的 http 链接一起粘过来，解析阶段按 https 对待（回源时仍只允许 https）。
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	return {
		host: url.hostname.toLowerCase(),
		segments: url.pathname.split("/").filter((segment) => segment.length > 0),
	};
}

function parseRepoText(text: string): GithubResolved {
	const segments = text.split("/").filter((segment) => segment.length > 0);
	if (segments.length !== 2) return invalid("请粘贴 owner/repo 形式的仓库，或完整的 GitHub 链接");
	const owner = segments[0] ?? "";
	const repo = (segments[1] ?? "").replace(/\.git$/iu, "");
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	return { kind: "repo", owner, repo, repoUrl: repoUrl(owner, repo) };
}

function parseArchivePath(owner: string, repo: string, rest: string[]): GithubResolved {
	const tail = rest.slice(1);
	let refLabel: string | null = null;
	let refKind: "heads" | "tags" | null = null;

	if (tail[0]?.toLowerCase() === "refs" && tail.length >= 3) {
		const kind = tail[1]?.toLowerCase();
		if (kind !== "heads" && kind !== "tags") return invalid("源码包链接只支持 archive/refs/heads 或 archive/refs/tags");
		refKind = kind;
		refLabel = decodeSegment(tail.slice(2).join("/"));
	} else if (tail.length > 0) {
		refLabel = decodeSegment(tail.join("/"));
	}
	if (refLabel === null || !refLabel) return invalid("源码包链接缺少分支或标签名");

	const fileName = decodeSegment(rest[rest.length - 1] ?? "");
	if (fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
	// 后缀决定 ref 的截断长度，必须按结尾判断，不能用正则找第一个匹配。
	const lower = refLabel.toLowerCase();
	const suffix = lower.endsWith(".tar.gz") ? ".tar.gz" : lower.endsWith(".zip") ? ".zip" : "";
	if (!suffix) return invalid("源码包链接需要以 .zip 或 .tar.gz 结尾");
	const ref = refLabel.slice(0, refLabel.length - suffix.length);
	const url = "https://github.com/" + owner + "/" + repo + "/archive/" + rest.slice(1).join("/");
	// heads 是分支、tags 是标签，UI 上要显示成不同的词，所以分开放进 ref / tag。
	return refKind === "tags"
		? { kind: "file", owner, repo, fileName, url, origin: "archive", tag: ref }
		: { kind: "file", owner, repo, fileName, url, origin: "archive", ref };
}

function parseGithubPath(segments: string[]): GithubResolved {
	if (segments.length < 2) return invalid("链接里缺少 owner/repo");
	const owner = segments[0] ?? "";
	const repo = (segments[1] ?? "").replace(/\.git$/iu, "");
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	const rest = segments.slice(2);
	const base = repoUrl(owner, repo);
	if (rest.length === 0) return { kind: "repo", owner, repo, repoUrl: base };

	const head = rest[0]?.toLowerCase() ?? "";
	const second = rest[1]?.toLowerCase() ?? "";

	// https://github.com/owner/repo/releases/tag/v1.2.3
	if (head === "releases" && second === "tag" && rest.length >= 3) {
		const tag = decodeSegment(rest.slice(2).join("/"));
		if (tag === null || !tag) return invalid("链接里的 tag 含有非法的百分号编码");
		return { kind: "release", owner, repo, tag, repoUrl: base };
	}

	// https://github.com/owner/repo/releases/download/v1.2.3/app.zip
	if (head === "releases" && second === "download" && rest.length >= 4) {
		const tag = decodeSegment(rest[2] ?? "");
		const fileName = decodeSegment(rest[rest.length - 1] ?? "");
		if (tag === null || !tag || fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
		const url = "https://github.com/" + owner + "/" + repo + "/releases/download/" + rest.slice(2).join("/");
		return { kind: "file", owner, repo, fileName, url, origin: "release", tag };
	}

	if (head === "archive") return parseArchivePath(owner, repo, rest);

	return invalid("暂不支持这种 GitHub 链接，请粘贴仓库主页、Release、源码包或 raw 文件地址");
}

function parseRawPath(segments: string[]): GithubResolved {
	if (segments.length < 4) return invalid("raw 链接至少需要 owner/repo/分支/文件名四段");
	const owner = segments[0] ?? "";
	const repo = segments[1] ?? "";
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	const ref = decodeSegment(segments[2] ?? "");
	const fileName = decodeSegment(segments[segments.length - 1] ?? "");
	if (ref === null || !ref || fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
	const url = "https://raw.githubusercontent.com/" + segments.join("/");
	return { kind: "file", owner, repo, fileName, url, origin: "raw", ref };
}

function parseCodeloadPath(segments: string[]): GithubResolved {
	if (segments.length < 3) return invalid("codeload 链接缺少打包格式（zip 或 tar.gz）");
	const owner = segments[0] ?? "";
	const repo = segments[1] ?? "";
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	const rest = segments.slice(2);
	const format = rest[0]?.toLowerCase() ?? "";
	if (format !== "zip" && format !== "tar.gz" && format !== "legacy.zip" && format !== "legacy.tar.gz") {
		return invalid("codeload 链接只支持 zip 或 tar.gz 打包格式");
	}
	const tail = rest.slice(1);
	let ref: string | null = null;
	let refKind: "heads" | "tags" | null = null;
	if (tail[0]?.toLowerCase() === "refs" && tail.length >= 3) {
		const kind = tail[1]?.toLowerCase();
		if (kind !== "heads" && kind !== "tags") return invalid("codeload 链接只支持 refs/heads 或 refs/tags");
		refKind = kind;
		ref = decodeSegment(tail.slice(2).join("/"));
	} else if (tail.length > 0) {
		ref = decodeSegment(tail.join("/"));
	}
	if (ref === null || !ref) return invalid("codeload 链接缺少分支或标签名");
	// 文档规定 fileName 取 URL 最后一段，codeload 的末段就是分支/标签名。
	const fileName = decodeSegment(segments[segments.length - 1] ?? "");
	if (fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
	const url = "https://codeload.github.com/" + segments.join("/");
	return refKind === "tags"
		? { kind: "file", owner, repo, fileName, url, origin: "archive", tag: ref }
		: { kind: "file", owner, repo, fileName, url, origin: "archive", ref };
}

/**
 * 解析用户粘贴的 GitHub 链接，纯本地字符串处理，不联网（与主站同一套规则，见文档第 5 节）。
 */
export function parseGithubInput(input: string): GithubResolved {
	const trimmed = stripQueryAndFragment(input.trim()).trim();
	if (!trimmed) return invalid("请输入 GitHub 链接或 owner/repo");
	if (trimmed.length > MAX_INPUT_LENGTH) return invalid("输入过长，请一次粘贴一个 GitHub 链接");

	const ssh = /^git@github\.com:(?<path>[^\s]+)$/iu.exec(trimmed);
	if (ssh?.groups?.path) return parseRepoText(ssh.groups.path);

	const absolute = parseAbsoluteUrl(trimmed);
	if (absolute) {
		if (absolute.host === "raw.githubusercontent.com") return parseRawPath(absolute.segments);
		if (absolute.host === "codeload.github.com") return parseCodeloadPath(absolute.segments);
		if (absolute.host === "github.com" || absolute.host === "www.github.com") return parseGithubPath(absolute.segments);
		return invalid("只支持 github.com 的链接（当前域名：" + absolute.host + "）");
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
		return invalid("只支持 https://github.com/、raw.githubusercontent.com 与 codeload.github.com 的链接");
	}

	// 从地址栏复制的链接常常没有协议头，按 github.com 路径处理。
	const bare = /^(?:www\.)?github\.com\/(?<path>.+)$/iu.exec(trimmed);
	if (bare?.groups?.path) return parseGithubPath(bare.groups.path.split("/").filter((segment) => segment.length > 0));

	return parseRepoText(trimmed);
}

export function fileNameFromUrl(target: string): string {
	try {
		const segments = new URL(target).pathname.split("/").filter((segment) => segment.length > 0);
		const last = segments[segments.length - 1];
		if (!last) return "download.bin";
		return decodeSegment(last) ?? "download.bin";
	} catch {
		return "download.bin";
	}
}

// ---------------------------------------------------------------------------
// Release 列表：节点自己调 api.github.com，内存缓存 10 分钟
// ---------------------------------------------------------------------------

export interface GithubAsset {
	readonly name: string;
	readonly size: number;
	readonly downloadCount: number;
	readonly url: string;
}

export interface GithubRelease {
	readonly tag: string;
	readonly name: string;
	readonly publishedAt: string;
	readonly prerelease: boolean;
	readonly assets: GithubAsset[];
}

export interface ReleasesPayload {
	readonly owner: string;
	readonly repo: string;
	readonly releases: GithubRelease[];
}

export type GithubApiErrorCode = "RELEASES_NOT_FOUND" | "RATE_LIMITED" | "UPSTREAM_TIMEOUT" | "UPSTREAM_FAILED" | "INVALID_INPUT";

export class GithubApiError extends Error {
	readonly statusCode: number;
	readonly code: GithubApiErrorCode;
	readonly retryAfterSeconds: number | undefined;

	constructor(message: string, statusCode: number, code: GithubApiErrorCode, retryAfterSeconds?: number) {
		super(message);
		this.name = "GithubApiError";
		this.statusCode = statusCode;
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export const RELEASES_CACHE_TTL_MS = 10 * 60 * 1000;
const RELEASES_CACHE_ENTRIES = 256;
// 导出上限是为了让测试能锁住"不会把一次 API 响应放大成无界 JSON"这条约束。
export const MAX_RELEASES = 20;
export const MAX_ASSETS_PER_RELEASE = 40;
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

interface ReleasesCacheEntry {
	readonly at: number;
	readonly value: ReleasesPayload;
}

const releasesCache = new Map<string, ReleasesCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(record: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function numberOf(record: Record<string, unknown>, ...keys: string[]): number {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return 0;
}

/** GitHub 原始 JSON 字段是 snake_case；主站同时接受两种命名，这里输出 camelCase 作为节点契约。 */
export function normalizeReleases(payload: unknown): GithubRelease[] {
	if (!Array.isArray(payload)) return [];
	const releases: GithubRelease[] = [];
	for (const item of payload) {
		if (!isRecord(item)) continue;
		const tag = textOf(item, "tag_name", "tag");
		if (!tag) continue;
		const assets: GithubAsset[] = [];
		const rawAssets = Array.isArray(item.assets) ? item.assets : [];
		for (const asset of rawAssets) {
			if (!isRecord(asset)) continue;
			const name = textOf(asset, "name");
			const url = textOf(asset, "browser_download_url", "url");
			if (!name || !url) continue;
			assets.push({
				name,
				size: numberOf(asset, "size"),
				downloadCount: numberOf(asset, "download_count", "downloadCount"),
				url,
			});
			if (assets.length >= MAX_ASSETS_PER_RELEASE) break;
		}
		releases.push({
			tag,
			name: textOf(item, "name", "title") || tag,
			publishedAt: textOf(item, "published_at", "publishedAt"),
			prerelease: item.prerelease === true,
			assets,
		});
		if (releases.length >= MAX_RELEASES) break;
	}
	return releases;
}

export interface FetchReleasesOptions {
	readonly token?: string;
	readonly now?: number;
	readonly timeoutMs?: number;
	readonly force?: boolean;
}

function githubApiUrl(owner: string, repo: string) {
	return "https://api.github.com/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/releases?per_page=20";
}

interface JsonResponse {
	readonly status: number;
	readonly body: unknown;
	readonly headers: Record<string, string | string[] | undefined>;
}

function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<JsonResponse> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest(url, { method: "GET", headers }, (response: IncomingMessage) => {
			const chunks: Buffer[] = [];
			let total = 0;
			response.on("data", (chunk: Buffer) => {
				total += chunk.length;
				// GitHub 的 Release 列表正常几 KB，超过上限说明拿到的不是 JSON，直接截断。
				if (total <= MAX_API_BODY_BYTES) chunks.push(chunk);
			});
			response.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let body: unknown = null;
				try {
					body = text ? JSON.parse(text) : null;
				} catch {
					body = null;
				}
				resolve({ status: response.statusCode ?? 0, body, headers: response.headers });
			});
			response.on("error", reject);
		});
		request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
		request.on("error", reject);
		request.end();
	});
}

function cacheKey(owner: string, repo: string) {
	// GitHub 的 owner/repo 大小写不敏感，缓存键统一小写，避免同一仓库缓存两份。
	return (owner + "/" + repo).toLowerCase();
}

export function resetReleasesCache(): void {
	releasesCache.clear();
}

export async function fetchReleases(owner: string, repo: string, options: FetchReleasesOptions = {}): Promise<ReleasesPayload> {
	if (!isValidName(owner) || !isValidName(repo)) throw new GithubApiError(INVALID_NAME_ERROR, 400, "INVALID_INPUT");

	const now = options.now ?? Date.now();
	const key = cacheKey(owner, repo);
	if (!options.force) {
		const cached = releasesCache.get(key);
		if (cached && now - cached.at < RELEASES_CACHE_TTL_MS) return cached.value;
	}

	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		// GitHub 要求所有请求带 UA，否则直接 403。
		"user-agent": "github-accel/1.0",
	};
	const token = options.token ?? config.githubToken;
	if (token) headers.authorization = "Bearer " + token;

	let response: JsonResponse;
	try {
		response = await getJson(githubApiUrl(owner, repo), headers, options.timeoutMs ?? config.upstreamTimeoutMs);
	} catch (error) {
		if (error instanceof Error && error.message === "timeout") {
			throw new GithubApiError("访问 GitHub API 超时，请稍后重试", 504, "UPSTREAM_TIMEOUT");
		}
		throw new GithubApiError("访问 GitHub API 失败：" + (error instanceof Error ? error.message : "未知错误"), 502, "UPSTREAM_FAILED");
	}

	if (response.status === 404) {
		throw new GithubApiError("GitHub 上找不到该仓库，或仓库没有发布 Release", 404, "RELEASES_NOT_FOUND");
	}
	if (response.status === 403 || response.status === 429) {
		const remaining = response.headers["x-ratelimit-remaining"];
		const reset = response.headers["x-ratelimit-reset"];
		const limited = response.status === 429 || remaining === "0";
		if (limited) {
			const resetSeconds = typeof reset === "string" ? Number(reset) : Number.NaN;
			const retryAfter = Number.isFinite(resetSeconds) ? Math.max(1, Math.ceil(resetSeconds - now / 1000)) : 60;
			throw new GithubApiError(
				"GitHub API 请求频率已达上限" + (token ? "" : "（节点未配置 ACCEL_GITHUB_TOKEN）") + "，请稍后再试",
				429,
				"RATE_LIMITED",
				retryAfter,
			);
		}
		throw new GithubApiError("GitHub API 拒绝了请求（403）", 502, "UPSTREAM_FAILED");
	}
	if (response.status < 200 || response.status >= 300) {
		throw new GithubApiError("GitHub API 返回了 " + response.status, 502, "UPSTREAM_FAILED");
	}

	const value: ReleasesPayload = { owner, repo, releases: normalizeReleases(response.body) };
	releasesCache.set(key, { at: now, value });
	// 简单上限：进程长期运行，缓存条目不能无限增长。
	while (releasesCache.size > RELEASES_CACHE_ENTRIES) {
		const oldest = releasesCache.keys().next();
		if (oldest.done) break;
		releasesCache.delete(oldest.value);
	}
	return value;
}
