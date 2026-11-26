/**
 * 上游转发：手动跟随 3xx、剔除 hop-by-hop 头、双向流式管道。
 *
 * 为什么不用 fetch：fetch 会自动解压 Content-Encoding 并丢掉原始 Content-Length，
 * 断点续传与 git 二进制流都会因此损坏（见文档第 7 节）。
 */
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

import { checkAllowedUrl } from "./github.js";

/** hop-by-hop 头只对单跳连接有意义，转发出去会被上游误读。 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"te",
	"trailer",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
]);

export type ProxyFailureCode = "HOST_NOT_ALLOWED" | "PROTOCOL_NOT_ALLOWED" | "URL_INVALID"
	| "REDIRECT_TOO_MANY" | "REDIRECT_WITHOUT_LOCATION" | "REDIRECT_WITH_BODY" | "UPSTREAM_TIMEOUT" | "UPSTREAM_FAILED";

export class ProxyError extends Error {
	readonly statusCode: number;
	readonly code: ProxyFailureCode;
	readonly retryAfterSeconds: number | undefined;

	constructor(message: string, statusCode: number, code: ProxyFailureCode, retryAfterSeconds?: number) {
		super(message);
		this.name = "ProxyError";
		this.statusCode = statusCode;
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export interface UpstreamRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	/** POST git-upload-pack 时把客户端请求体原样接上去。 */
	readonly body?: Readable;
	readonly timeoutMs: number;
}

export type UpstreamFetcher = (request: UpstreamRequest) => Promise<IncomingMessage>;

export interface OpenUpstreamOptions {
	readonly maxRedirects?: number;
	readonly fetcher?: UpstreamFetcher;
}

export interface UpstreamResult {
	readonly response: IncomingMessage;
	readonly url: string;
	readonly redirects: number;
}

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * 响应头过滤：去掉 hop-by-hop，并去掉 Connection 头里点名的字段
 * （RFC 7230 要求这类字段也是逐跳的）。
 */
export function filterHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
	const connectionListed = new Set<string>();
	const connectionValue = headers.connection;
	const rawConnection = Array.isArray(connectionValue) ? connectionValue.join(",") : connectionValue;
	if (rawConnection) {
		for (const name of rawConnection.split(",")) {
			const trimmed = name.trim().toLowerCase();
			if (trimmed) connectionListed.add(trimmed);
		}
	}

	const result: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower) || connectionListed.has(lower)) continue;
		result[lower] = value;
	}
	return result;
}

const UA_SUFFIX_LIMIT = 80;

/**
 * 下载走本服务标识 + 原始 UA 末尾：同一个 GitHub 出口 IP 下多用户共享节点 UA，
 * 保留末尾能给 GitHub 侧的限流/审计留下一点客户端线索。
 */
export function downloadUserAgent(clientUa: string | undefined, version = "1.0"): string {
	const label = "github-accel/" + version;
	const tail = (clientUa ?? "").trim().replace(/\s+/gu, " ").slice(-UA_SUFFIX_LIMIT);
	return tail ? label + " (" + tail + ")" : label;
}

export interface DownloadHeaderInput {
	readonly range?: string;
	readonly ifRange?: string;
	readonly ifModifiedSince?: string;
	readonly ifNoneMatch?: string;
	readonly accept?: string;
	readonly clientUserAgent?: string;
	readonly version?: string;
}

/**
 * 下载侧只转发与内容协商相关的头。Cookie / Authorization 一律不转发：
 * 本服务不认识客户端身份，转发了就等于替第三方带上凭据。
 */
export function buildDownloadHeaders(input: DownloadHeaderInput): Record<string, string> {
	const headers: Record<string, string> = {
		// 强迫上游返回未压缩字节，否则 Content-Length 与缓存落盘长度都对不上。
		"accept-encoding": "identity",
		"user-agent": downloadUserAgent(input.clientUserAgent, input.version),
	};
	if (input.range) headers.range = input.range;
	if (input.ifRange) headers["if-range"] = input.ifRange;
	if (input.ifModifiedSince) headers["if-modified-since"] = input.ifModifiedSince;
	if (input.ifNoneMatch) headers["if-none-match"] = input.ifNoneMatch;
	if (input.accept) headers.accept = input.accept;
	return headers;
}

export interface GitHeaderInput {
	readonly contentType?: string;
	readonly contentLength?: string;
	readonly accept?: string;
	readonly gitProtocol?: string;
	readonly clientUserAgent?: string;
}

/**
 * git 路径保留客户端 UA：GitHub 依赖 UA 里的 git/2.x 判断是不是 git 客户端，
 * 换成节点自己的 UA 会被当成普通 HTTP 请求。
 */
export function buildGitHeaders(input: GitHeaderInput): Record<string, string> {
	const headers: Record<string, string> = {
		"user-agent": input.clientUserAgent?.trim() || "git/2.0",
		"accept-encoding": "identity",
	};
	if (input.contentType) headers["content-type"] = input.contentType;
	if (input.contentLength) headers["content-length"] = input.contentLength;
	if (input.accept) headers.accept = input.accept;
	if (input.gitProtocol) headers["git-protocol"] = input.gitProtocol;
	return headers;
}

export function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Location 可以是相对地址，必须以当前 URL 为基准解析；解析后立刻重新做白名单校验，
 * 否则一个被攻陷的上游域名就能把节点变成任意地址的代理。
 */
export function resolveRedirectUrl(currentUrl: string, location: string | string[] | undefined): string {
	const raw = Array.isArray(location) ? location[0] : location;
	if (!raw) throw new ProxyError("上游返回了 3xx，但没有 Location 头", 502, "REDIRECT_WITHOUT_LOCATION");
	let resolved: string;
	try {
		resolved = new URL(raw, currentUrl).toString();
	} catch {
		throw new ProxyError("上游返回的 Location 无法解析：" + raw, 502, "REDIRECT_WITHOUT_LOCATION");
	}
	const check = checkAllowedUrl(resolved);
	if (!check.ok) {
		throw new ProxyError("上游重定向到了不允许的地址：" + check.error, 502, check.code);
	}
	return check.url;
}

function defaultFetcher(request: UpstreamRequest): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const clientRequest = httpsRequest(request.url, { method: request.method, headers: request.headers }, resolve);
		// 上游卡住不响应时不能无限占用并发额度。
		// 报错里带上实际等待时长：GitHub 侧偶发丢包时，"等了多久才超时"是现场唯一能区分
		// "配置的阈值太小" 与 "上游真的没回包" 的证据。
		clientRequest.setTimeout(request.timeoutMs, () => {
			const waited = Date.now() - startedAt;
			clientRequest.destroy(new ProxyError("上游响应超时（已等待 " + waited + "ms，上限 " + request.timeoutMs + "ms）", 504, "UPSTREAM_TIMEOUT"));
		});
		clientRequest.on("error", (error: Error) => {
			reject(error instanceof ProxyError
				? error
				: new ProxyError("连接上游失败：" + error.message, 502, "UPSTREAM_FAILED"));
		});
		if (request.body) {
			request.body.on("error", (error: Error) => {
				clientRequest.destroy(error);
			});
			request.body.pipe(clientRequest);
		} else {
			clientRequest.end();
		}
	});
}

/**
 * 打开发起请求并跟随 3xx（最多 maxRedirects 跳）。返回最终的、非 3xx 的响应。
 * fetcher 可注入，测试里不需要真的联网也能覆盖跳转上限与白名单重校验。
 */
/** 连接阶段的抖动只重试一次：多试无益，且会把用户等待时间翻倍。 */
const UPSTREAM_MAX_ATTEMPTS = 2;
const UPSTREAM_RETRY_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		// 重试等待不该拖住进程退出（docker stop / systemd stop）。
		timer.unref();
	});
}

async function fetchWithRetry(fetcher: UpstreamFetcher, request: UpstreamRequest, retryable: boolean): Promise<IncomingMessage> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await fetcher(request);
		} catch (error) {
			const transient = error instanceof ProxyError && error.code === "UPSTREAM_FAILED";
			if (!retryable || !transient || attempt >= UPSTREAM_MAX_ATTEMPTS) throw error;
			await delay(UPSTREAM_RETRY_DELAY_MS);
		}
	}
}

export async function openUpstream(request: UpstreamRequest, options: OpenUpstreamOptions = {}): Promise<UpstreamResult> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const fetcher = options.fetcher ?? defaultFetcher;

	const first = checkAllowedUrl(request.url);
	if (!first.ok) throw new ProxyError(first.error, 400, first.code);

	let url = first.url;
	let method = request.method;
	let redirects = 0;
	// 请求体只能发送一次，跟随重定向无法重放，碰到就直接失败而不是静默丢包。
	const hasBody = request.body !== undefined;
	// 真机上 GitHub 的边缘节点偶尔在 TLS 握手后直接 ECONNRESET；只有无请求体的 GET/HEAD
	// 才是幂等的，POST 即使没有 body 也不能重放。
	const retryable = !hasBody && (method === "GET" || method === "HEAD");

	for (;;) {
		const response = await fetchWithRetry(fetcher, { ...request, url, method }, retryable);
		const status = response.statusCode ?? 0;
		if (!isRedirectStatus(status)) return { response, url, redirects };

		if (redirects >= maxRedirects) {
			response.destroy();
			throw new ProxyError("上游重定向超过 " + maxRedirects + " 跳，已中止", 502, "REDIRECT_TOO_MANY");
		}
		let nextUrl: string;
		try {
			nextUrl = resolveRedirectUrl(url, response.headers.location);
		} catch (error) {
			// 解析失败也必须释放上游连接，否则 socket 会一直挂到超时。
			response.destroy();
			throw error;
		}
		response.resume();
		redirects += 1;
		url = nextUrl;
		// 请求体已经随第一跳发了出去，重定向后没法重放，直接失败好过静默丢包。
		if (hasBody) throw new ProxyError("上游对带请求体的请求返回了 " + status + " 重定向，无法重放请求体", 502, "REDIRECT_WITH_BODY");
		// 303 明确要求换成 GET；其余 3xx 保持方法（git 的 POST 不能变成 GET）。
		if (status === 303 && method !== "HEAD") method = "GET";
	}
}
