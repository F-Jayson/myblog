import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";

import {
	buildDownloadHeaders,
	buildGitHeaders,
	downloadUserAgent,
	filterHeaders,
	HOP_BY_HOP_HEADERS,
	isRedirectStatus,
	openUpstream,
	ProxyError,
	resolveRedirectUrl,
	type UpstreamFetcher,
	type UpstreamRequest,
} from "../src/proxy.ts";

function fakeResponse(statusCode: number, headers: Record<string, string>, body = ""): IncomingMessage {
	const stream = Readable.from(body === "" ? [] : [Buffer.from(body, "utf8")]);
	return Object.assign(stream, { statusCode, headers }) as unknown as IncomingMessage;
}

function request(url: string, overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
	return { url, method: "GET", headers: {}, timeoutMs: 1000, ...overrides };
}

async function expectProxyError(run: () => Promise<unknown>, code: string): Promise<ProxyError> {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof ProxyError, "应当抛出 ProxyError，实际：" + String(error));
		assert.equal(error.code, code);
		return error;
	}
	assert.fail("没有抛出预期错误：" + code);
}

describe("hop-by-hop 头", () => {
	it("剔除逐跳头与 Connection 点名的字段", () => {
		const filtered = filterHeaders({
			connection: "keep-alive, x-custom",
			"keep-alive": "timeout=5",
			"transfer-encoding": "chunked",
			"x-custom": "1",
			"content-type": "application/zip",
			"content-length": "10",
		});
		assert.deepEqual(filtered, { "content-type": "application/zip", "content-length": "10" });
		assert.equal(HOP_BY_HOP_HEADERS.has("transfer-encoding"), true);
		assert.equal(HOP_BY_HOP_HEADERS.has("content-type"), false);
	});
});

describe("请求头构造", () => {
	it("下载 UA 保留客户端 UA 末尾", () => {
		assert.equal(downloadUserAgent(undefined), "github-accel/1.0");
		assert.equal(downloadUserAgent("curl/8.0.1"), "github-accel/1.0 (curl/8.0.1)");
		const long = "a".repeat(120);
		const ua = downloadUserAgent(long, "2.0");
		assert.equal(ua.startsWith("github-accel/2.0 ("), true);
		assert.equal(ua.endsWith(")"), true);
		assert.equal(ua.length, "github-accel/2.0 (".length + 80 + 1);
	});

	it("下载头强制 identity 且不带凭据", () => {
		const headers = buildDownloadHeaders({ range: "bytes=0-1", ifRange: '"abc"', accept: "*/*", clientUserAgent: "curl/8.0.1" });
		assert.equal(headers["accept-encoding"], "identity");
		assert.equal(headers.range, "bytes=0-1");
		assert.equal(headers["if-range"], '"abc"');
		assert.equal(headers.accept, "*/*");
		assert.equal(headers.cookie, undefined);
		assert.equal(headers.authorization, undefined);
	});

	it("git 头保留客户端 UA 与 git-protocol", () => {
		const headers = buildGitHeaders({
			contentType: "application/x-git-upload-pack-request",
			contentLength: "12",
			gitProtocol: "version=2",
			clientUserAgent: "git/2.43.0",
		});
		assert.equal(headers["user-agent"], "git/2.43.0");
		assert.equal(headers["content-type"], "application/x-git-upload-pack-request");
		assert.equal(headers["content-length"], "12");
		assert.equal(headers["git-protocol"], "version=2");
		assert.equal(buildGitHeaders({})["user-agent"], "git/2.0");
	});
});

describe("3xx 判定与 Location 解析", () => {
	it("只把 301/302/303/307/308 当重定向", () => {
		for (const status of [301, 302, 303, 307, 308]) assert.equal(isRedirectStatus(status), true, String(status));
		for (const status of [200, 204, 304, 400]) assert.equal(isRedirectStatus(status), false, String(status));
	});

	it("相对 Location 以当前 URL 为基准解析", () => {
		assert.equal(
			resolveRedirectUrl("https://github.com/o/r/releases/download/v1/a.zip", "/assets/a.zip"),
			"https://github.com/assets/a.zip",
		);
	});

	it("重定向到白名单外域名直接拒绝", async () => {
		await expectProxyError(async () => resolveRedirectUrl("https://github.com/o/r", "https://evil.com/x"), "HOST_NOT_ALLOWED");
	});

	it("缺少 Location 时报错", async () => {
		await expectProxyError(async () => resolveRedirectUrl("https://github.com/o/r", undefined), "REDIRECT_WITHOUT_LOCATION");
	});
});

describe("openUpstream 跟随重定向", () => {
	it("正常响应不额外请求", async () => {
		const calls: string[] = [];
		const fetcher: UpstreamFetcher = async (req) => {
			calls.push(req.url);
			return fakeResponse(200, { "content-length": "2" }, "ok");
		};
		const result = await openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher });
		assert.equal(result.redirects, 0);
		assert.equal(calls.length, 1);
		assert.equal(result.response.statusCode, 200);
	});

	it("跟随一次 302 并返回最终地址", async () => {
		const calls: string[] = [];
		const fetcher: UpstreamFetcher = async (req) => {
			calls.push(req.url);
			return calls.length === 1
				? fakeResponse(302, { location: "/o/r/releases/download/v1/redirected.zip" })
				: fakeResponse(200, { "content-length": "2" }, "ok");
		};
		const result = await openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher });
		assert.equal(result.redirects, 1);
		assert.equal(result.url, "https://github.com/o/r/releases/download/v1/redirected.zip");
		assert.deepEqual(calls, [
			"https://github.com/o/r/releases/download/v1/a.zip",
			"https://github.com/o/r/releases/download/v1/redirected.zip",
		]);
	});

	it("超过跳数上限报 REDIRECT_TOO_MANY", async () => {
		const fetcher: UpstreamFetcher = async () => fakeResponse(302, { location: "/o/r/releases/download/v1/a.zip" });
		await expectProxyError(
			async () => openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher, maxRedirects: 2 }),
			"REDIRECT_TOO_MANY",
		);
	});

	it("每一跳都重新做白名单校验", async () => {
		const fetcher: UpstreamFetcher = async () => fakeResponse(302, { location: "https://evil.com/steal" });
		const error = await expectProxyError(
			async () => openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher }),
			"HOST_NOT_ALLOWED",
		);
		assert.equal(error.statusCode, 502);
	});

	it("带请求体的请求遇到重定向直接失败", async () => {
		const fetcher: UpstreamFetcher = async () => fakeResponse(307, { location: "/o/r.git/git-upload-pack" });
		await expectProxyError(
			async () => openUpstream(request("https://github.com/o/r.git/git-upload-pack", { method: "POST", body: Readable.from([]) }), { fetcher }),
			"REDIRECT_WITH_BODY",
		);
	});

	it("303 把 POST 降级成 GET", async () => {
		const methods: string[] = [];
		const fetcher: UpstreamFetcher = async (req) => {
			methods.push(req.method);
			return methods.length === 1 ? fakeResponse(303, { location: "/o/r" }) : fakeResponse(200, {});
		};
		await openUpstream(request("https://github.com/o/r", { method: "POST" }), { fetcher });
		assert.deepEqual(methods, ["POST", "GET"]);
	});

	it("连接阶段 ECONNRESET 时 GET 重试一次并成功", async () => {
		let calls = 0;
		const fetcher: UpstreamFetcher = async () => {
			calls += 1;
			if (calls === 1) throw new ProxyError("连接上游失败：read ECONNRESET", 502, "UPSTREAM_FAILED");
			return fakeResponse(200, { "content-length": "2" }, "ok");
		};
		const result = await openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher });
		assert.equal(calls, 2);
		assert.equal(result.response.statusCode, 200);
	});

	it("重试一次仍失败就上报 UPSTREAM_FAILED", async () => {
		let calls = 0;
		const fetcher: UpstreamFetcher = async () => {
			calls += 1;
			throw new ProxyError("连接上游失败：read ECONNRESET", 502, "UPSTREAM_FAILED");
		};
		const error = await expectProxyError(
			async () => openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher }),
			"UPSTREAM_FAILED",
		);
		assert.equal(calls, 2);
		assert.equal(error.statusCode, 502);
	});

	it("带请求体的 POST 遇到连接断开不重试", async () => {
		let calls = 0;
		const fetcher: UpstreamFetcher = async () => {
			calls += 1;
			throw new ProxyError("连接上游失败：read ECONNRESET", 502, "UPSTREAM_FAILED");
		};
		await expectProxyError(
			async () => openUpstream(request("https://github.com/o/r.git/git-upload-pack", { method: "POST", body: Readable.from([]) }), { fetcher }),
			"UPSTREAM_FAILED",
		);
		assert.equal(calls, 1);
	});

	it("超时（UPSTREAM_TIMEOUT）不重试", async () => {
		let calls = 0;
		const fetcher: UpstreamFetcher = async () => {
			calls += 1;
			throw new ProxyError("上游响应超时", 504, "UPSTREAM_TIMEOUT");
		};
		await expectProxyError(
			async () => openUpstream(request("https://github.com/o/r/releases/download/v1/a.zip"), { fetcher }),
			"UPSTREAM_TIMEOUT",
		);
		assert.equal(calls, 1);
	});

	it("初始地址不在白名单时返回 400", async () => {
		const fetcher: UpstreamFetcher = async () => fakeResponse(200, {});
		const error = await expectProxyError(
			async () => openUpstream(request("http://github.com/o/r"), { fetcher }),
			"PROTOCOL_NOT_ALLOWED",
		);
		assert.equal(error.statusCode, 400);
	});
});
