/**
 * 主站侧的 GitHub 加速支持：链接解析、HMAC ticket、节点状态与克隆信息。
 *
 * 协议见 docs/github-accelerator.md。ticket 算法在 packages/github-accel/src/ticket.ts
 * 还有一份独立实现：主站与加速节点部署在不同机器上，两边不能靠 import 共享代码，
 * 所以任何与签名相关的改动都必须同步另一份，并保证文档第 2 节的固定测试向量两边都过。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "./config.js";

/** 可预期的失败：路由统一转成 { error, code } 的响应体。 */
export class GithubAccelError extends Error {
	readonly statusCode: number;
	readonly code: string;
	readonly retryAfterSeconds: number | undefined;

	constructor(message: string, statusCode = 500, code = "GITHUB_ACCEL_ERROR", retryAfterSeconds?: number) {
		super(message);
		this.name = "GithubAccelError";
		this.statusCode = statusCode;
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** 与文档第 5 节一字不差：前端按 kind 分支渲染，字段名不要改名。 */
export type GithubResolved =
	| { kind: "repo"; owner: string; repo: string; repoUrl: string }
	| { kind: "release"; owner: string; repo: string; tag: string; repoUrl: string }
	| {
		kind: "file";
		owner: string;
		repo: string;
		fileName: string;
		url: string;
		origin: "release" | "archive" | "raw";
		tag?: string;
		ref?: string;
	}
	| { kind: "invalid"; error: string };

const MAX_INPUT_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;
// GitHub 的 owner/repo 实际可用的字符集合；这里同时挡住 "."、".." 这类会拼出奇怪
// 上游路径的名字（它们会被原样放进发给加速节点的 URL）。
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

export const GITHUB_ACCEL_DL_PATH = "/api/tools/github/dl/";

/** 与文档第 3 节的上游白名单一致：节点只转发这些域名，主站提前拦一次能少一次无效跳转。 */
const DOWNLOAD_HOSTS = new Set([
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"raw.githubusercontent.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
]);

function invalid(error: string): GithubResolved {
	return { kind: "invalid", error };
}

function isValidName(value: string) {
	return value.length > 0 && value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value) && value !== "." && value !== "..";
}

const INVALID_NAME_ERROR = "仓库所有者或仓库名不合法：只允许字母、数字、点、下划线与短横线，且不超过 100 个字符";

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

function repoUrl(owner: string, repo: string) {
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
	// 文档只承诺 https，但用户常把浏览器地址栏里的 http 链接一起粘过来，这里按 https 处理。
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	return {
		host: url.hostname.toLowerCase(),
		segments: url.pathname.split("/").filter((segment) => segment.length > 0),
	};
}

function parseRepoText(text: string): GithubResolved {
	const segments = text.split("/").filter((segment) => segment.length > 0);
	if (segments.length !== 2) return invalid("请粘贴 owner/repo 形式的仓库，或完整的 GitHub 链接");
	const owner = segments[0]!;
	const repo = segments[1]!.replace(/\.git$/iu, "");
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	return { kind: "repo", owner, repo, repoUrl: repoUrl(owner, repo) };
}

function parseGithubPath(segments: string[]): GithubResolved {
	if (segments.length < 2) return invalid("链接里缺少 owner/repo");
	const owner = segments[0]!;
	const repo = segments[1]!.replace(/\.git$/iu, "");
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	const rest = segments.slice(2);
	const base = repoUrl(owner, repo);
	if (rest.length === 0) return { kind: "repo", owner, repo, repoUrl: base };

	const head = rest[0]!.toLowerCase();
	const second = rest[1]?.toLowerCase() ?? "";

	// https://github.com/owner/repo/releases/tag/v1.2.3
	if (head === "releases" && second === "tag" && rest.length >= 3) {
		const tag = decodeSegment(rest.slice(2).join("/"));
		if (tag === null || !tag) return invalid("链接里的 tag 含有非法的百分号编码");
		return { kind: "release", owner, repo, tag, repoUrl: base };
	}

	// https://github.com/owner/repo/releases/download/v1.2.3/app.zip
	if (head === "releases" && second === "download" && rest.length >= 4) {
		const tag = decodeSegment(rest[2]!);
		const fileName = decodeSegment(rest[rest.length - 1]!);
		if (tag === null || !tag || fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
		const url = "https://github.com/" + owner + "/" + repo + "/releases/download/" + rest.slice(2).join("/");
		return { kind: "file", owner, repo, fileName, url, origin: "release", tag };
	}

	if (head === "archive") return parseArchivePath(owner, repo, rest);

	return invalid("暂不支持这种 GitHub 链接，请粘贴仓库主页、Release、源码包或 raw 文件地址");
}

/** GitHub 的源码包链接有两种历史写法：/archive/refs/heads|tags/<ref>.<ext> 与 /archive/<ref>.<ext>。 */
function parseArchivePath(owner: string, repo: string, rest: string[]): GithubResolved {
	const tail = rest.slice(1);
	let refLabel: string | null = null;
	let refKind: "heads" | "tags" | null = null;

	if (tail[0]?.toLowerCase() === "refs" && tail.length >= 3) {
		const kind = tail[1]!.toLowerCase();
		if (kind !== "heads" && kind !== "tags") return invalid("源码包链接只支持 archive/refs/heads 或 archive/refs/tags");
		refKind = kind;
		refLabel = decodeSegment(tail.slice(2).join("/"));
	} else if (tail.length > 0) {
		refLabel = decodeSegment(tail.join("/"));
	}
	if (refLabel === null || !refLabel) return invalid("源码包链接缺少分支或标签名");

	const fileName = decodeSegment(rest[rest.length - 1]!);
	if (fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
	// 后缀决定 ref 的截断长度，必须按结尾判断，而不是用正则找第一个匹配。
	const suffix = refLabel.toLowerCase().endsWith(".tar.gz") ? ".tar.gz" : refLabel.toLowerCase().endsWith(".zip") ? ".zip" : "";
	if (!suffix) return invalid("源码包链接需要以 .zip 或 .tar.gz 结尾");
	const ref = refLabel.slice(0, refLabel.length - suffix.length);
	const url = "https://github.com/" + owner + "/" + repo + "/archive/" + rest.slice(1).join("/");
	// heads 是分支、tags 是标签，二者在 UI 上要显示成不同的词，所以分开放进 ref / tag。
	return refKind === "tags"
		? { kind: "file", owner, repo, fileName, url, origin: "archive", tag: ref }
		: { kind: "file", owner, repo, fileName, url, origin: "archive", ref };
}

function parseRawPath(segments: string[]): GithubResolved {
	if (segments.length < 4) return invalid("raw 链接至少需要 owner/repo/分支/文件名四段");
	const owner = segments[0]!;
	const repo = segments[1]!;
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	const ref = decodeSegment(segments[2]!);
	const fileName = decodeSegment(segments[segments.length - 1]!);
	if (ref === null || !ref || fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
	const url = "https://raw.githubusercontent.com/" + segments.join("/");
	return { kind: "file", owner, repo, fileName, url, origin: "raw", ref };
}

function parseCodeloadPath(segments: string[]): GithubResolved {
	if (segments.length < 3) return invalid("codeload 链接缺少打包格式（zip 或 tar.gz）");
	const owner = segments[0]!;
	const repo = segments[1]!;
	if (!isValidName(owner) || !isValidName(repo)) return invalid(INVALID_NAME_ERROR);
	const rest = segments.slice(2);
	const format = rest[0]!.toLowerCase();
	if (format !== "zip" && format !== "tar.gz" && format !== "legacy.zip" && format !== "legacy.tar.gz") {
		return invalid("codeload 链接只支持 zip 或 tar.gz 打包格式");
	}
	const tail = rest.slice(1);
	let ref: string | null = null;
	let refKind: "heads" | "tags" | null = null;
	if (tail[0]?.toLowerCase() === "refs" && tail.length >= 3) {
		const kind = tail[1]!.toLowerCase();
		if (kind !== "heads" && kind !== "tags") return invalid("codeload 链接只支持 refs/heads 或 refs/tags");
		refKind = kind;
		ref = decodeSegment(tail.slice(2).join("/"));
	} else if (tail.length > 0) {
		ref = decodeSegment(tail.join("/"));
	}
	if (ref === null || !ref) return invalid("codeload 链接缺少分支或标签名");
	// 文档规定 fileName 取 URL 最后一段，codeload 的末段就是分支/标签名，这里不另行拼 -。
	const fileName = decodeSegment(segments[segments.length - 1]!);
	if (fileName === null || !fileName) return invalid("链接里含有非法的百分号编码");
	const url = "https://codeload.github.com/" + segments.join("/");
	return refKind === "tags"
		? { kind: "file", owner, repo, fileName, url, origin: "archive", tag: ref }
		: { kind: "file", owner, repo, fileName, url, origin: "archive", ref };
}

/**
 * 解析用户粘贴的 GitHub 链接，纯本地字符串处理，不联网。
 * 支持文档第 5 节列出的全部写法；无法识别时返回 kind "invalid" 与中文原因。
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

// ---------------------------------------------------------------------------
// ticket：base64url(JSON{u,e,k,t}) + "." + hmacSha256Hex 的前 32 个字符
// ---------------------------------------------------------------------------

export type TicketKind = "file" | "git";

/** 速率档位：与 packages/github-accel 里的同名同义，节点只信签名内的 t，不查用户库。 */
export type TicketTier = "guest" | "member";

export interface TicketPayload {
	u: string;
	e: number;
	k: TicketKind;
	/** 缺省表示滚动发布期还在飞的旧 ticket，验签后一律归为 "guest"。 */
	t?: TicketTier;
}

export type TicketVerification =
	| { ok: true; payload: TicketPayload }
	| { ok: false; code: "TICKET_INVALID" | "TICKET_EXPIRED"; error: string };

/** 节点未配置密钥时签名毫无意义，任何调用都直接失败而不是生成空签名。 */
function resolveTicketSecret(secret: string | undefined) {
	const value = (secret ?? config.githubAccel.secret).trim();
	if (!value) throw new GithubAccelError("GitHub 加速节点未配置签名密钥，请联系站点管理员", 503, "GITHUB_ACCEL_NOT_CONFIGURED");
	return value;
}

function signPayload(body: string, secret: string) {
	return createHmac("sha256", secret).update(body).digest("hex").slice(0, 32);
}

function isValidPayload(value: unknown): value is TicketPayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.u === "string" && record.u.length > 0
		&& typeof record.e === "number" && Number.isFinite(record.e)
		&& (record.k === "file" || record.k === "git");
}

// 档位缺失或非法都当游客：旧 ticket 必须继续可用，非法值也不该让下载直接失败。
function normalizeTicketTier(value: unknown): TicketTier {
	return value === "member" ? "member" : "guest";
}

export function createTicket(payload: TicketPayload, secret?: string): string {
	const signingSecret = resolveTicketSecret(secret);
	if (!payload.u || !Number.isFinite(payload.e)) throw new GithubAccelError("ticket 内容不完整", 500, "TICKET_INVALID");
	// 字段顺序必须与文档一致（u、e、k、t）：两端签名 message 是同一个字符串，
	// JSON.stringify 按插入顺序输出，换了顺序签名就对不上。
	const body = Buffer.from(
		JSON.stringify({ u: payload.u, e: payload.e, k: payload.k, t: normalizeTicketTier(payload.t) }),
		"utf8",
	).toString("base64url");
	return body + "." + signPayload(body, signingSecret);
}

export function verifyTicket(
	ticket: string,
	expectedKind?: TicketKind,
	secret?: string,
	now = Math.floor(Date.now() / 1000),
): TicketVerification {
	const signingSecret = resolveTicketSecret(secret);
	const parts = ticket.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, code: "TICKET_INVALID", error: "下载链接格式不正确" };
	const [body, signature] = parts as [string, string];
	const expected = signPayload(body, signingSecret);
	// 定长比较，避免用 === 比较签名留下时序侧信道。
	const expectedBuffer = Buffer.from(expected, "utf8");
	const providedBuffer = Buffer.from(signature.toLowerCase(), "utf8");
	if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
		return { ok: false, code: "TICKET_INVALID", error: "下载链接校验失败，请重新生成" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
	} catch {
		return { ok: false, code: "TICKET_INVALID", error: "下载链接内容已损坏" };
	}
	if (!isValidPayload(parsed)) return { ok: false, code: "TICKET_INVALID", error: "下载链接内容已损坏" };
	if (expectedKind && parsed.k !== expectedKind) return { ok: false, code: "TICKET_INVALID", error: "下载链接类型不匹配" };
	if (parsed.e <= now) return { ok: false, code: "TICKET_EXPIRED", error: "下载链接已过期，请重新生成" };
	// t 缺省或非法值一律归为游客，不报错：主站与节点分别部署，旧 ticket 至少还有 30 分钟有效期。
	return { ok: true, payload: { u: parsed.u, e: parsed.e, k: parsed.k, t: normalizeTicketTier(parsed.t) } };
}

/**
 * 启动时立刻校验文档第 2 节的固定测试向量。两份实现一旦漂移，这里会在服务启动阶段
 * 就炸掉，而不是等用户点下载拿到一堆 401。
 */
export function assertTicketAlgorithm() {
	const secret = "test-secret-0123456789abcdef0123456789";
	// 新向量：t 已进入签名，payload 的字段顺序必须是 u、e、k、t。
	const vectors: { payload: TicketPayload; body: string; ticket: string }[] = [
		{
			payload: { u: "https://github.com/o/r/releases/download/v1/a.zip", e: 1_800_000_000, k: "file", t: "guest" },
			body: "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Imd1ZXN0In0",
			ticket: "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Imd1ZXN0In0.c1f6b1ac1ab2aaac6e0a3c8e5d19f943",
		},
		{
			payload: { u: "https://github.com/o/r/releases/download/v1/a.zip", e: 1_800_000_000, k: "file", t: "member" },
			body: "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Im1lbWJlciJ9",
			ticket: "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Im1lbWJlciJ9.7ef37acc7057c396f905918b914e77cb",
		},
		{
			payload: { u: "/o/r.git", e: 1_800_000_000, k: "git", t: "guest" },
			body: "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Imd1ZXN0In0",
			ticket: "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Imd1ZXN0In0.954481962b3921ce992e13fcb4343fe7",
		},
		{
			payload: { u: "/o/r.git", e: 1_800_000_000, k: "git", t: "member" },
			body: "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Im1lbWJlciJ9",
			ticket: "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Im1lbWJlciJ9.9644aedea787e8ec02ba5bf8a337daff",
		},
	];
	for (const vector of vectors) {
		const actualBody = Buffer.from(
			JSON.stringify({ u: vector.payload.u, e: vector.payload.e, k: vector.payload.k, t: vector.payload.t }),
			"utf8",
		).toString("base64url");
		if (actualBody !== vector.body) throw new Error("ticket 算法的 payload 与文档测试向量不一致");
		if (createTicket(vector.payload, secret) !== vector.ticket) throw new Error("ticket 签名与文档测试向量不一致");
	}

	// 滚动发布窗口里还有大量旧 ticket（无 t）：签名必须逐字节对得上，验签后按游客处理。
	const legacyBody = "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0";
	const legacySignature = "1fdb9326cecbc1dae9177cd18b229837";
	if (signPayload(legacyBody, secret) !== legacySignature) throw new Error("旧版无 t 的 ticket 签名与文档测试向量不一致");
	const legacy = verifyTicket(legacyBody + "." + legacySignature, "file", secret, 1_800_000_000 - 1);
	if (!legacy.ok) throw new Error("旧版无 t 的 ticket 验签失败：" + legacy.error);
	if (legacy.payload.t !== "guest") throw new Error("旧版无 t 的 ticket 未按游客处理");
}

// ---------------------------------------------------------------------------
// 下载 / 克隆
// ---------------------------------------------------------------------------

/** 只接受 https 且域名在白名单内的地址；先拦一次，用户看到的是中文原因而不是节点的 400。 */
export function assertDownloadableUrl(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new GithubAccelError("请粘贴要加速下载的地址", 400, "GITHUB_ACCEL_INVALID_INPUT");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new GithubAccelError("这不是一个合法的链接", 400, "GITHUB_ACCEL_INVALID_INPUT");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new GithubAccelError("只支持 https 链接", 400, "GITHUB_ACCEL_INVALID_INPUT");
	}
	// 带凭据的链接会把 token 原样交给加速节点，一律拒绝。
	if (url.username || url.password) throw new GithubAccelError("链接里不能包含用户名或密码", 400, "GITHUB_ACCEL_INVALID_INPUT");
	if (!DOWNLOAD_HOSTS.has(url.hostname.toLowerCase())) {
		throw new GithubAccelError("只支持 GitHub 域名（当前：" + url.hostname + "）", 400, "HOST_NOT_ALLOWED");
	}
	url.protocol = "https:";
	return url.toString();
}

function fileNameFromUrl(target: string) {
	try {
		const segments = new URL(target).pathname.split("/").filter((segment) => segment.length > 0);
		const last = segments[segments.length - 1];
		return last ? decodeURIComponent(last) : "download.bin";
	} catch {
		return "download.bin";
	}
}

export interface DownloadTicketInfo {
	downloadPath: string;
	fileName: string;
	expiresAt: string;
}

export interface DownloadTicketOptions {
	now?: number;
	ttlMinutes?: number;
	secret?: string;
	/** 速率档位：登录用户传 "member"，缺省按游客签发；具体速率由节点决定。 */
	tier?: TicketTier;
}

/** 签发下载 ticket；返回的 downloadPath 是主站的 302 入口，文件字节不会经过主站。 */
export function buildDownloadTicket(targetUrl: string, options: DownloadTicketOptions = {}): DownloadTicketInfo {
	const url = assertDownloadableUrl(targetUrl);
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const ttlMinutes = options.ttlMinutes ?? config.githubAccel.ticketTtlMinutes;
	const expiresAt = now + Math.round(ttlMinutes * 60);
	const ticket = createTicket({ u: url, e: expiresAt, k: "file", t: options.tier ?? "guest" }, options.secret);
	return {
		downloadPath: GITHUB_ACCEL_DL_PATH + ticket,
		fileName: fileNameFromUrl(url),
		expiresAt: new Date(expiresAt * 1000).toISOString(),
	};
}

/** 拼出节点的签名下载地址；ticket 只含 base64url 与点，encode 只是防御性写法。 */
export function buildDownloadRedirect(ticket: string, baseUrl = config.githubAccel.baseUrl): string {
	if (!baseUrl) throw new GithubAccelError("GitHub 加速节点未配置，请联系站点管理员", 503, "GITHUB_ACCEL_NOT_CONFIGURED");
	return baseUrl.replace(/\/+$/u, "") + "/download/" + encodeURIComponent(ticket);
}

/** 同源预检入口，路径与下载短链一一对应：把 /dl/ 换成 /probe/ 就是它。 */
export const GITHUB_ACCEL_PROBE_PATH = "/api/tools/github/probe/";

export interface DownloadProbeResult {
	/** true 表示可以接着下载；false 时 error 是给页面直接显示的中文原因。 */
	ok: boolean;
	/** 节点回给主站的状态码；0 表示这一次预检没有结论（超时），页面应当照常发起下载。 */
	status: number;
	error?: string;
	code?: string;
}

export interface DownloadProbeOptions {
	baseUrl?: string;
	fetcher?: typeof fetch;
	timeoutMs?: number;
}

/**
 * 主站替浏览器预检一次节点：下载短链会 302 到节点，两点域名不同就是**跨域**，
 * 浏览器读不到节点返回的错误正文，节点一报错用户只会看到一坨 JSON 顶掉整页。
 * 所以由主站 HEAD 一次节点，把状态码翻成中文原因、以同源 JSON 交回页面。
 *
 * 超时不算失败：节点这时可能正在向 GitHub 要文件头，真下载往往还是成功，
 * 因此返回 { ok: true, status: 0 } 让页面放行；只有连不上或节点明确 4xx/5xx 才拦。
 */
export async function probeDownloadTarget(ticket: string, options: DownloadProbeOptions = {}): Promise<DownloadProbeResult> {
	const base = (options.baseUrl ?? requireAcceleratorBaseUrl()).replace(/\/+$/u, "");
	// 允许调用方显式传空（测试与"未配置"同一条路径）：拼出来的地址只会打到主站自己身上。
	if (!base) throw new GithubAccelError("GitHub 加速节点未配置，请联系站点管理员", 503, "GITHUB_ACCEL_NOT_CONFIGURED");
	const fetcher = options.fetcher ?? fetch;
	let response: Response;
	try {
		response = await fetcher(base + "/download/" + encodeURIComponent(ticket), {
			method: "HEAD",
			redirect: "follow",
			signal: AbortSignal.timeout(options.timeoutMs ?? config.githubAccel.timeoutMs),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { ok: true, status: 0 };
		return { ok: false, status: 502, error: "加速节点连不上（网络或 DNS 异常），请稍后重试。", code: "GITHUB_ACCEL_UNREACHABLE" };
	}
	// HEAD 的响应没有正文，读完头就可以放手；不读会在连接上留下半截响应。
	await response.body?.cancel().catch(() => undefined);
	if (response.ok) return { ok: true, status: response.status };
	return { ok: false, status: response.status, ...describeProbeFailure(response.status) };
}

/** HEAD 拿不到节点自己的中文原因（没有响应体），这里按状态码给出等价的说法。 */
function describeProbeFailure(status: number): { error: string; code: string } {
	if (status === 401 || status === 403) return { error: "下载被拒绝：链接无效或已过期，请重新生成。", code: "GITHUB_ACCEL_TICKET_REJECTED" };
	if (status === 404) return { error: "GitHub 返回 404：仓库、Release 或附件不存在，请检查地址。", code: "GITHUB_ACCEL_NOT_FOUND" };
	if (status === 429) return { error: "请求过于频繁，已被限流，请稍后再试。", code: "GITHUB_ACCEL_RATE_LIMITED" };
	if (status === 502 || status === 503 || status === 504) return { error: "加速节点暂时不可用（HTTP " + status + "），请稍后重试。", code: "GITHUB_ACCEL_UPSTREAM" };
	if (status >= 500) return { error: "加速节点处理失败（HTTP " + status + "），请稍后重试。", code: "GITHUB_ACCEL_UPSTREAM" };
	return { error: "加速节点返回 HTTP " + status + "，请稍后重试。", code: "GITHUB_ACCEL_UPSTREAM" };
}

export interface CloneInfo {
	cloneUrl: string;
	command: string;
	insteadOf: string;
}

export interface CloneOptions {
	publicAllowed: boolean;
	baseUrl?: string;
	now?: number;
	ttlMinutes?: number;
	secret?: string;
	/** 速率档位：公开模式走无签名路径，节点一律按游客限速，此时该字段不起作用。 */
	tier?: TicketTier;
}

/**
 * 公开模式走节点的无签名路径，便于 insteadOf 全局复用；
 * 关闭公开下载时用带 ticket 的仓库路径，每次克隆都要重新生成。
 */
export function buildCloneInfo(owner: string, repo: string, options: CloneOptions): CloneInfo {
	if (!isValidName(owner) || !isValidName(repo)) throw new GithubAccelError(INVALID_NAME_ERROR, 400, "GITHUB_ACCEL_INVALID_INPUT");
	const base = (options.baseUrl ?? config.githubAccel.baseUrl).replace(/\/+$/u, "");
	if (!base) throw new GithubAccelError("GitHub 加速节点未配置，请联系站点管理员", 503, "GITHUB_ACCEL_NOT_CONFIGURED");
	const repoPath = "/" + owner + "/" + repo + ".git";

	let cloneUrl: string;
	if (options.publicAllowed) {
		cloneUrl = base + "/git" + repoPath;
	} else {
		const now = options.now ?? Math.floor(Date.now() / 1000);
		const ttlMinutes = options.ttlMinutes ?? config.githubAccel.ticketTtlMinutes;
		const ticket = createTicket({ u: repoPath, e: now + Math.round(ttlMinutes * 60), k: "git", t: options.tier ?? "guest" }, options.secret);
		cloneUrl = base + "/git/" + ticket + repoPath;
	}
	return {
		cloneUrl,
		command: "git clone " + cloneUrl,
		// 非公开模式每个仓库的克隆地址都带独立 ticket，不能给出全局 insteadOf，
		// 否则 git 会改用无 ticket 的地址并被节点拒绝。
		insteadOf: options.publicAllowed ? 'git config --global url."' + base + '/git/".insteadOf "https://github.com/"' : "",
	};
}

// ---------------------------------------------------------------------------
// 加速节点状态与 Release 代理（都带短缓存，避免每次请求都打节点）
// ---------------------------------------------------------------------------

/** 节点 /api/health 上报的两档单连接速率（字节/秒），供前台显示"当前身份"用。 */
export interface AccelRates {
	guest: number;
	member: number;
}

export interface AcceleratorStatus {
	configured: boolean;
	online: boolean;
	publicAllowed: boolean;
	version: string | null;
	/** 旧节点不认档位、不上报速率时整个字段缺省，前端显示"未知"而不是把 0 当成不限速。 */
	rates?: AccelRates;
}

/** /api/tools/github/config 响应里的 rates 字段：节点未上报时整段缺省，不写 0 也不写假值。 */
export function configRatesField(status: AcceleratorStatus): { rates?: AccelRates } {
	return status.rates ? { rates: status.rates } : {};
}

const STATUS_OK_TTL_MS = 30_000;
// 失败也要缓存，否则节点宕机时每个页面加载都会等满一个超时。
const STATUS_FAIL_TTL_MS = 10_000;
const RELEASES_TTL_MS = 60_000;
const RELEASES_CACHE_ENTRIES = 128;
const MAX_ASSETS_PER_RELEASE = 40;
const MAX_RELEASES = 20;

let statusCache: { at: number; value: AcceleratorStatus } | null = null;
const releasesCache = new Map<string, { at: number; value: GithubAccelReleases }>();

const OFFLINE_STATUS: AcceleratorStatus = { configured: true, online: false, publicAllowed: false, version: null };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function numberOf(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return 0;
}

/**
 * 从节点 /api/health 的响应体里读两档速率：0 是合法值（表示不限速），
 * 但字段缺失、类型不对或为负时整体返回 undefined —— 宁可显示"未知"也不能编个 0 出来。
 */
export function readAcceleratorRates(body: unknown): AccelRates | undefined {
	if (!isRecord(body)) return undefined;
	const guest = body.guestBytesPerSecond;
	const member = body.memberBytesPerSecond;
	if (typeof guest !== "number" || !Number.isFinite(guest) || guest < 0) return undefined;
	if (typeof member !== "number" || !Number.isFinite(member) || member < 0) return undefined;
	return { guest, member };
}

async function probeAccelerator(): Promise<AcceleratorStatus> {
	const base = config.githubAccel.baseUrl;
	if (!base) return { configured: false, online: false, publicAllowed: false, version: null };
	try {
		const response = await fetch(base + "/api/health", { signal: AbortSignal.timeout(config.githubAccel.timeoutMs) });
		if (!response.ok) return OFFLINE_STATUS;
		const body: unknown = await response.json().catch(() => null);
		const record = isRecord(body) ? body : {};
		const rates = readAcceleratorRates(record);
		return {
			configured: true,
			// 读到 200 已经证明链路通，只有节点明确写 ok:false 才算下线。
			online: record.ok !== false,
			publicAllowed: record.publicAllowed === true,
			version: typeof record.version === "string" ? record.version : null,
			// 节点还没升级时不带这两个字段，这里保持整段缺省。
			...(rates ? { rates } : {}),
		};
	} catch {
		return OFFLINE_STATUS;
	}
}

export async function getAcceleratorStatus(now = Date.now()): Promise<AcceleratorStatus> {
	if (!config.githubAccel.baseUrl) return { configured: false, online: false, publicAllowed: false, version: null };
	const cached = statusCache;
	if (cached) {
		const ttl = cached.value.online ? STATUS_OK_TTL_MS : STATUS_FAIL_TTL_MS;
		if (now - cached.at < ttl) return cached.value;
	}
	const value = await probeAccelerator();
	statusCache = { at: now, value };
	return value;
}

export interface GithubAccelAsset {
	name: string;
	size: number;
	downloadCount: number;
	url: string;
}

export interface GithubAccelRelease {
	tag: string;
	name: string;
	publishedAt: string;
	prerelease: boolean;
	assets: GithubAccelAsset[];
}

export interface GithubAccelReleases {
	owner: string;
	repo: string;
	releases: GithubAccelRelease[];
}

function normalizeAssets(payload: unknown): GithubAccelAsset[] {
	if (!Array.isArray(payload)) return [];
	const assets: GithubAccelAsset[] = [];
	for (const item of payload) {
		if (!isRecord(item)) continue;
		const name = textOf(item, "name");
		// 优先使用 GitHub 的浏览器下载地址；`url` 是仍需鉴权的 API 地址。
		const url = textOf(item, "browserDownloadUrl", "browser_download_url", "downloadUrl", "download_url", "url");
		if (!name || !url) continue;
		assets.push({
			name,
			size: numberOf(item, "size"),
			downloadCount: numberOf(item, "downloadCount", "download_count"),
			url,
		});
		if (assets.length >= MAX_ASSETS_PER_RELEASE) break;
	}
	return assets;
}

// 节点的字段名由 packages/github-accel 决定，这里同时接受 camelCase 与 GitHub 原始
// snake_case 两种写法，两个包并行开发时不会因为一处命名差异整页空白。
function normalizeRelease(item: Record<string, unknown>): GithubAccelRelease {
	const tag = textOf(item, "tag", "tagName", "tag_name");
	return {
		tag,
		name: textOf(item, "name", "title") || tag,
		publishedAt: textOf(item, "publishedAt", "published_at"),
		prerelease: item.prerelease === true || item.isPrerelease === true,
		assets: normalizeAssets(item.assets ?? item.assetsList),
	};
}

function normalizeReleases(payload: unknown): GithubAccelRelease[] {
	const list = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.releases)
			? payload.releases
			: isRecord(payload) && Array.isArray(payload.items)
				? payload.items
				: [];
	const releases: GithubAccelRelease[] = [];
	for (const item of list) {
		if (!isRecord(item)) continue;
		const release = normalizeRelease(item);
		if (!release.tag) continue;
		releases.push(release);
		if (releases.length >= MAX_RELEASES) break;
	}
	return releases;
}

export function requireAcceleratorBaseUrl() {
	const base = config.githubAccel.baseUrl;
	if (!base) throw new GithubAccelError("GitHub 加速节点未配置，请联系站点管理员", 503, "GITHUB_ACCEL_NOT_CONFIGURED");
	return base;
}

export async function fetchAcceleratorReleases(owner: string, repo: string, now = Date.now()): Promise<GithubAccelReleases> {
	const base = requireAcceleratorBaseUrl();
	if (!isValidName(owner) || !isValidName(repo)) throw new GithubAccelError(INVALID_NAME_ERROR, 400, "GITHUB_ACCEL_INVALID_INPUT");
	// GitHub 的 owner/repo 大小写不敏感，缓存键统一小写，避免同一仓库缓存两份。
	const key = owner.toLowerCase() + "/" + repo.toLowerCase();
	const cached = releasesCache.get(key);
	if (cached && now - cached.at < RELEASES_TTL_MS) return cached.value;

	let status = 0;
	let body: unknown = null;
	try {
		const response = await fetch(base + "/api/releases/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo), {
			signal: AbortSignal.timeout(config.githubAccel.timeoutMs),
		});
		status = response.status;
		body = await response.json().catch(() => null);
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new GithubAccelError("加速节点响应超时，请稍后再试", 504, "GITHUB_ACCEL_TIMEOUT");
		}
		throw new GithubAccelError("加速节点不可达，请稍后再试", 502, "GITHUB_ACCEL_UNREACHABLE");
	}

	if (status < 200 || status >= 300) {
		const upstreamMessage = isRecord(body) ? textOf(body, "error", "message") : "";
		if (status === 404) throw new GithubAccelError("加速节点上没有该仓库的 Release", 404, "GITHUB_ACCEL_RELEASES_NOT_FOUND");
		if (status === 429) throw new GithubAccelError(upstreamMessage || "GitHub API 请求频率已达上限，请稍后再试", 429, "GITHUB_ACCEL_RATE_LIMITED", 60);
		throw new GithubAccelError(upstreamMessage || "加速节点返回了错误", 502, "GITHUB_ACCEL_UPSTREAM");
	}

	const value: GithubAccelReleases = { owner, repo, releases: normalizeReleases(body) };
	releasesCache.set(key, { at: now, value });
	while (releasesCache.size > RELEASES_CACHE_ENTRIES) {
		const oldest = releasesCache.keys().next();
		if (oldest.done) break;
		releasesCache.delete(oldest.value);
	}
	return value;
}

// ---------------------------------------------------------------------------
// 每 IP 限流：解析 30 次/分钟、签发 60 次/分钟（照 puml.ts 的 checkRate 写法）
// ---------------------------------------------------------------------------

export type GithubAccelRateKind = "resolve" | "issue";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMITS: Record<GithubAccelRateKind, number> = { resolve: 30, issue: 60 };
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export interface RateDecision {
	allowed: boolean;
	retryAfterSeconds: number;
}

export function checkGithubAccelRate(kind: GithubAccelRateKind, ip: string, now = Date.now()): RateDecision {
	const key = kind + ":" + (ip || "unknown");
	const bucket = rateBuckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
		// 顺手清理过期桶，避免长期运行的进程被扫描器灌满。
		if (rateBuckets.size > 4096) {
			for (const [bucketKey, value] of rateBuckets) {
				if (value.resetAt <= now) rateBuckets.delete(bucketKey);
			}
		}
		return { allowed: true, retryAfterSeconds: 0 };
	}
	bucket.count += 1;
	if (bucket.count > RATE_LIMITS[kind]) {
		return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
	}
	return { allowed: true, retryAfterSeconds: 0 };
}

export function requireGithubAccelRate(kind: GithubAccelRateKind, ip: string) {
	const decision = checkGithubAccelRate(kind, ip);
	if (!decision.allowed) {
		throw new GithubAccelError("请求过于频繁，请稍后再试", 429, "GITHUB_ACCEL_RATE_LIMITED", decision.retryAfterSeconds);
	}
}

/** 测试用钩子：窗口状态是模块级的，用例之间需要互不干扰。 */
export function resetGithubAccelRateLimits() {
	rateBuckets.clear();
}

assertTicketAlgorithm();
