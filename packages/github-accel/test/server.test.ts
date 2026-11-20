import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { DiskCache } from "../src/cache.ts";
import { readConfig, type AccelConfig } from "../src/config.ts";
import { ProxyError, type UpstreamFetcher } from "../src/proxy.ts";
import { createApp, VERSION, type AppDependencies } from "../src/server.ts";
import { createTicket } from "../src/ticket.ts";

const SECRET = "test-secret-0123456789abcdef0123456789";
const DOWNLOAD_URL = "https://github.com/o/r/releases/download/v1/a.zip";

interface TestApp {
	readonly base: string;
	readonly cfg: AccelConfig;
	readonly close: () => Promise<void>;
}

async function startApp(env: NodeJS.ProcessEnv = {}, deps: AppDependencies = {}): Promise<TestApp> {
	const cfg = readConfig({ ACCEL_SECRET: SECRET, ACCEL_CACHE_DIR: "", ...env });
	const server: Server = createApp(cfg, deps);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("测试服务没有拿到 TCP 端口");
	return {
		base: "http://127.0.0.1:" + address.port,
		cfg,
		// fetch 的 keep-alive 连接会让 close() 一直等下去，测试里直接掐断所有连接。
		close: () => new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}

async function withApp(run: (app: TestApp) => Promise<void>, env: NodeJS.ProcessEnv = {}, deps: AppDependencies = {}): Promise<void> {
	const app = await startApp(env, deps);
	try {
		await run(app);
	} finally {
		await app.close();
	}
}

function upstream(status: number, headers: Record<string, string>, body = ""): IncomingMessage {
	const stream = Readable.from(body === "" ? [] : [Buffer.from(body, "utf8")]);
	const finalHeaders: Record<string, string> = { ...headers };
	if (body !== "" && finalHeaders["content-length"] === undefined) {
		finalHeaders["content-length"] = String(Buffer.byteLength(body, "utf8"));
	}
	return Object.assign(stream, { statusCode: status, headers: finalHeaders }) as unknown as IncomingMessage;
}

function bodyFetcher(body: string, headers: Record<string, string> = {}): UpstreamFetcher {
	return async () => upstream(200, { "content-type": "application/zip", etag: '"v1"', "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT", ...headers }, body);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error("等待条件超时");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("基础路由", () => {
	it("GET /api/health 返回节点的公开能力", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/api/health");
			assert.equal(response.status, 200);
			assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			assert.equal(response.headers.get("access-control-allow-origin"), "*");
			assert.deepEqual(await response.json(), { ok: true, version: VERSION, publicAllowed: true });
		});
	});

	it("HEAD /api/health 无响应体", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/api/health", { method: "HEAD" });
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "");
		});
	});

	it("未知路径 404，错误码可被主站识别", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/api/unknown");
			assert.equal(response.status, 404);
			const payload = (await response.json()) as { error: string; code: string };
			assert.equal(payload.code, "NOT_FOUND");
			assert.equal(payload.error.length > 0, true);
		});
	});

	it("OPTIONS 预检返回 204 与允许的方法", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/download", { method: "OPTIONS" });
			assert.equal(response.status, 204);
			assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/u);
		});
	});

	it("/api/health 不支持 POST", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/api/health", { method: "POST" });
			assert.equal(response.status, 405);
			assert.equal(response.headers.get("allow"), "GET, HEAD");
		});
	});

	it("/api/releases 路径段数不对时 404", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/api/releases/onlyowner");
			assert.equal(response.status, 404);
		});
	});
});

describe("/download 鉴权", () => {
	it("缺少 url 参数 400", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/download");
			assert.equal(response.status, 400);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "URL_INVALID");
		});
	});

	it("未开放公开下载时 /download?url= 返回 403", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/download?url=" + encodeURIComponent(DOWNLOAD_URL));
			assert.equal(response.status, 403);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "PUBLIC_DISABLED");
		}, { ACCEL_ALLOW_PUBLIC: "false" });
	});

	it("非白名单地址 400 HOST_NOT_ALLOWED", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/download?url=" + encodeURIComponent("https://evil.com/a.zip"));
			assert.equal(response.status, 400);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "HOST_NOT_ALLOWED");
		});
	});

	it("畸形 ticket 401 TICKET_INVALID", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/download/not-a-ticket");
			assert.equal(response.status, 401);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "TICKET_INVALID");
		});
	});

	it("过期 ticket 401 TICKET_EXPIRED", async () => {
		await withApp(async (app) => {
			const ticket = createTicket({ u: DOWNLOAD_URL, e: Math.floor(Date.now() / 1000) - 60, k: "file" }, SECRET);
			const response = await fetch(app.base + "/download/" + ticket);
			assert.equal(response.status, 401);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "TICKET_EXPIRED");
		});
	});
});

describe("git 智能协议", () => {
	it("git-receive-pack 一律 405（push 被禁用）", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/git/o/r.git/info/refs?service=git-receive-pack");
			assert.equal(response.status, 405);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "GIT_RECEIVE_PACK_DISABLED");
			const post = await fetch(app.base + "/git/o/r.git/git-receive-pack", { method: "POST" });
			assert.equal(post.status, 405);
		});
	});

	it("未开放公开克隆时无 ticket 的 info/refs 返回 403", async () => {
		await withApp(async (app) => {
			const response = await fetch(app.base + "/git/o/r.git/info/refs?service=git-upload-pack");
			assert.equal(response.status, 403);
			const payload = (await response.json()) as { code: string };
			assert.equal(payload.code, "PUBLIC_DISABLED");
		}, { ACCEL_ALLOW_PUBLIC: "false" });
	});

	it("公开模式下把 info/refs 转发到 github.com", async () => {
		const requested: string[] = [];
		const fetcher: UpstreamFetcher = async (request) => {
			requested.push(request.url);
			return upstream(200, { "content-type": "application/x-git-upload-pack-advertisement" }, "# service=git-upload-pack\n");
		};
		await withApp(async (app) => {
			const response = await fetch(app.base + "/git/o/r.git/info/refs?service=git-upload-pack", {
				headers: { "user-agent": "git/2.43.0", "git-protocol": "version=2" },
			});
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "# service=git-upload-pack\n");
			assert.equal(response.headers.get("content-type"), "application/x-git-upload-pack-advertisement");
		}, {}, { fetcher });
		assert.deepEqual(requested, ["https://github.com/o/r.git/info/refs?service=git-upload-pack"]);
	});

	it("POST git-upload-pack 保留请求体转发", async () => {
		const requested: { url: string; method: string }[] = [];
		const fetcher: UpstreamFetcher = async (request) => {
			requested.push({ url: request.url, method: request.method });
			return upstream(200, { "content-type": "application/x-git-upload-pack-result" }, "PACK");
		};
		await withApp(async (app) => {
			const response = await fetch(app.base + "/git/o/r.git/git-upload-pack", {
				method: "POST",
				headers: { "content-type": "application/x-git-upload-pack-request", "user-agent": "git/2.43.0" },
				body: "0032want 0000",
			});
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "PACK");
		}, {}, { fetcher });
		assert.deepEqual(requested, [{ url: "https://github.com/o/r.git/git-upload-pack", method: "POST" }]);
	});

	it("带 ticket 的克隆地址可以访问，仓库不匹配则 401", async () => {
		const fetcher: UpstreamFetcher = async () => upstream(200, { "content-type": "application/x-git-upload-pack-advertisement" }, "ok");
		await withApp(async (app) => {
			const good = createTicket({ u: "/o/r.git", e: Math.floor(Date.now() / 1000) + 600, k: "git" }, SECRET);
			const ok = await fetch(app.base + "/git/" + good + "/o/r.git/info/refs?service=git-upload-pack");
			assert.equal(ok.status, 200);

			const other = createTicket({ u: "/other/repo.git", e: Math.floor(Date.now() / 1000) + 600, k: "git" }, SECRET);
			const mismatch = await fetch(app.base + "/git/" + other + "/o/r.git/info/refs?service=git-upload-pack");
			assert.equal(mismatch.status, 401);
			const payload = (await mismatch.json()) as { code: string };
			assert.equal(payload.code, "TICKET_INVALID");
		}, {}, { fetcher });
	});
});

describe("/download 流式转发与磁盘缓存", () => {
	it("首次下载 MISS 后落盘，再次命中且支持 Range/304/416/HEAD", async () => {
		const dir = await mkdtemp(join(tmpdir(), "github-accel-server-"));
		const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 3_600_000 });
		const body = "0123456789";
		try {
			const ticket = createTicket({ u: DOWNLOAD_URL, e: Math.floor(Date.now() / 1000) + 600, k: "file" }, SECRET);
			await withApp(async (app) => {
				const first = await fetch(app.base + "/download/" + ticket);
				assert.equal(first.status, 200);
				assert.equal(await first.text(), body);
				assert.equal(first.headers.get("x-cache"), "MISS");
				assert.equal(first.headers.get("accept-ranges"), "bytes");
				assert.match(first.headers.get("content-disposition") ?? "", /^attachment;/u);

				await waitFor(async () => (await cache.read(DOWNLOAD_URL, Date.now())) !== null);

				// 后端已缓存：把 fetcher 换成必失败，命中仍应成功。
				const broken: UpstreamFetcher = async () => {
					throw new ProxyError("不该访问上游", 502, "UPSTREAM_FAILED");
				};
				const hit = await fetch(app.base + "/download/" + ticket);
				assert.equal(hit.status, 200);
				assert.equal(hit.headers.get("x-cache"), "HIT");
				assert.equal(await hit.text(), body);

				const ranged = await fetch(app.base + "/download/" + ticket, { headers: { range: "bytes=0-3" } });
				assert.equal(ranged.status, 206);
				assert.equal(ranged.headers.get("content-range"), "bytes 0-3/10");
				assert.equal(ranged.headers.get("content-length"), "4");
				assert.equal(await ranged.text(), "0123");

				const notModified = await fetch(app.base + "/download/" + ticket, { headers: { "if-none-match": '"v1"' } });
				assert.equal(notModified.status, 304);

				const unsatisfiable = await fetch(app.base + "/download/" + ticket, { headers: { range: "bytes=100-" } });
				assert.equal(unsatisfiable.status, 416);
				assert.equal(unsatisfiable.headers.get("content-range"), "bytes */10");

				const head = await fetch(app.base + "/download/" + ticket, { method: "HEAD" });
				assert.equal(head.status, 200);
				assert.equal(head.headers.get("content-length"), "10");
				assert.equal(await head.text(), "");
			}, { ACCEL_CACHE_DIR: dir, ACCEL_ALLOW_PUBLIC: "false" }, { cache, fetcher: bodyFetcher(body) });

			// createApp 默认用 deps.fetcher；重新走一遍带 broken fetcher 的实例验证 HIT 不碰上游
			const broken = await startApp({ ACCEL_CACHE_DIR: dir }, {
				cache,
				fetcher: async () => {
					throw new ProxyError("不该访问上游", 502, "UPSTREAM_FAILED");
				},
			});
			try {
				const hit = await fetch(broken.base + "/download/" + ticket);
				assert.equal(hit.status, 200);
				assert.equal(hit.headers.get("x-cache"), "HIT");
				assert.equal(await hit.text(), body);
			} finally {
				await broken.close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("上游 404 原样透传", async () => {
		const fetcher: UpstreamFetcher = async () => upstream(404, { "content-type": "text/plain" }, "not found");
		await withApp(async (app) => {
			const response = await fetch(app.base + "/download?url=" + encodeURIComponent(DOWNLOAD_URL));
			assert.equal(response.status, 404);
			assert.equal(await response.text(), "not found");
		}, {}, { fetcher });
	});

	it("每 IP 每分钟超限返回 429 + Retry-After", async () => {
		await withApp(async (app) => {
			const target = "/download?url=" + encodeURIComponent(DOWNLOAD_URL);
			const first = await fetch(app.base + target);
			assert.equal(first.status, 200);
			await first.text();
			const second = await fetch(app.base + target);
			assert.equal(second.status, 429);
			assert.equal(second.headers.get("retry-after") !== null, true);
			const payload = (await second.json()) as { code: string };
			assert.equal(payload.code, "RATE_LIMITED");
		}, { ACCEL_RATE_PER_MINUTE: "1" }, { fetcher: bodyFetcher("ok") });
	});
});
