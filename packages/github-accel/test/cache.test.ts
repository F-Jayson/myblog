import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	buildRangeHeaders,
	cacheKey,
	DiskCache,
	ifRangeMatches,
	parseRangeHeader,
	type CacheMeta,
} from "../src/cache.ts";

const META: Omit<CacheMeta, "size" | "storedAt"> = {
	fileName: "a.zip",
	contentType: "application/zip",
	etag: '"abc"',
	lastModified: "Wed, 01 Jan 2026 00:00:00 GMT",
};

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "github-accel-cache-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeEntry(cache: DiskCache, url: string, body: string, now: number): Promise<boolean> {
	const writer = cache.createWriter(url, META, now);
	await writer.write(Buffer.from(body, "utf8"));
	return writer.finish(Buffer.byteLength(body, "utf8"));
}

describe("缓存键", () => {
	it("是 sha256(url) 的 64 位十六进制", async () => {
		const key = cacheKey("https://github.com/o/r/releases/download/v1/a.zip");
		assert.equal(/^[0-9a-f]{64}$/u.test(key), true);
		assert.equal(key, cacheKey("https://github.com/o/r/releases/download/v1/a.zip"));
		assert.notEqual(key, cacheKey("https://github.com/o/r/releases/download/v1/b.zip"));
	});
});

describe("Range 解析", () => {
	it("闭区间、开区间与后缀区间", () => {
		assert.deepEqual(parseRangeHeader("bytes=0-3", 100), { start: 0, end: 3 });
		assert.deepEqual(parseRangeHeader("bytes=95-", 100), { start: 95, end: 99 });
		assert.deepEqual(parseRangeHeader("bytes=-10", 100), { start: 90, end: 99 });
		assert.deepEqual(parseRangeHeader("bytes=0-1000", 100), { start: 0, end: 99 });
		assert.equal(parseRangeHeader(undefined, 100), null);
	});

	it("多段、语法错误按无 Range 处理", () => {
		assert.equal(parseRangeHeader("bytes=0-1,5-6", 100), null);
		assert.equal(parseRangeHeader("bytes=abc", 100), null);
		assert.equal(parseRangeHeader("bytes=5-2", 100), null);
		assert.equal(parseRangeHeader("items=0-3", 100), null);
	});

	it("越界返回 unsatisfiable", () => {
		assert.equal(parseRangeHeader("bytes=100-", 100), "unsatisfiable");
		assert.equal(parseRangeHeader("bytes=-5", 0), "unsatisfiable");
	});
});

describe("If-Range", () => {
	it("强 ETag 匹配才允许切片", () => {
		assert.equal(ifRangeMatches('"abc"', { ...META, size: 1, storedAt: 1 }), true);
		assert.equal(ifRangeMatches('"other"', { ...META, size: 1, storedAt: 1 }), false);
		assert.equal(ifRangeMatches('W/"abc"', { ...META, size: 1, storedAt: 1 }), false);
		assert.equal(ifRangeMatches(undefined, { ...META, size: 1, storedAt: 1 }), false);
	});

	it("不带引号按日期比较", () => {
		assert.equal(ifRangeMatches("Wed, 01 Jan 2026 00:00:00 GMT", { ...META, size: 1, storedAt: 1 }), true);
		assert.equal(ifRangeMatches("Wed, 02 Jan 2026 00:00:00 GMT", { ...META, size: 1, storedAt: 1 }), false);
	});
});

describe("206 响应头", () => {
	it("Content-Length 是切片长度而不是整个文件", () => {
		const built = buildRangeHeaders({ start: 10, end: 19 }, 100, "application/zip");
		assert.equal(built.status, 206);
		assert.equal(built.headers["content-length"], "10");
		assert.equal(built.headers["content-range"], "bytes 10-19/100");
		assert.equal(built.headers["accept-ranges"], "bytes");
	});
});

describe("磁盘缓存", () => {
	it("ACCEL_CACHE_DIR 为空时整个缓存禁用", async () => {
		const cache = new DiskCache({ dir: "", maxBytes: 1024, ttlMs: 1000 });
		assert.equal(cache.enabled, false);
		assert.equal(await cache.read("https://github.com/o/r"), null);
		assert.deepEqual(await cache.list(), []);
		await cache.sweep();
	});

	it("写完才出现正式文件，读出元数据与内容", async () => {
		await withTempDir(async (dir) => {
			const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 60_000 });
			const url = "https://github.com/o/r/releases/download/v1/a.zip";
			const now = 1_700_000_000_000;
			assert.equal(await writeEntry(cache, url, "hello", now), true);

			const entry = await cache.read(url, now + 1);
			assert.ok(entry);
			if (entry === null) return;
			assert.equal(entry.meta.size, 5);
			assert.equal(entry.meta.fileName, "a.zip");
			assert.equal(entry.meta.contentType, "application/zip");

			const raw = await readFile(entry.binPath, "utf8");
			assert.equal(raw, "hello");
			const metaRaw = JSON.parse(await readFile(cache.metaPath(entry.key), "utf8")) as { size: number; storedAt: number };
			assert.equal(metaRaw.size, 5);
			assert.equal(metaRaw.storedAt, now);

			const chunks: Buffer[] = [];
			for await (const chunk of cache.openReadStream(entry)) chunks.push(Buffer.from(chunk));
			assert.equal(Buffer.concat(chunks).toString("utf8"), "hello");
		});
	});

	it("写入长度与 Content-Length 不符时不落盘", async () => {
		await withTempDir(async (dir) => {
			const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 60_000 });
			const url = "https://github.com/o/r/releases/download/v1/truncated.zip";
			const writer = cache.createWriter(url, META, 1_700_000_000_000);
			await writer.write(Buffer.from("0123456789", "utf8"));
			const committed = await writer.finish(100);
			assert.equal(committed, false);
			const key = cacheKey(url);
			assert.equal(existsSync(cache.binPath(key)), false);
			assert.equal(existsSync(cache.metaPath(key)), false);
		});
	});

	it("超过 TTL 视为未命中并删除文件", async () => {
		await withTempDir(async (dir) => {
			const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 1000 });
			const url = "https://github.com/o/r/releases/download/v1/a.zip";
			assert.equal(await writeEntry(cache, url, "hello", 1_700_000_000_000), true);
			const key = cacheKey(url);
			assert.equal(await cache.read(url, 1_700_000_002_000), null);
			assert.equal(existsSync(cache.binPath(key)), false);
		});
	});

	it("超出 ACCEL_CACHE_MAX_BYTES 时按最后访问时间淘汰最旧条目", async () => {
		await withTempDir(async (dir) => {
			const cache = new DiskCache({ dir, maxBytes: 15, ttlMs: 60_000 });
			const now = 1_700_000_000_000;
			const older = "https://github.com/o/r/releases/download/v1/old.zip";
			const newer = "https://github.com/o/r/releases/download/v1/new.zip";
			assert.equal(await writeEntry(cache, older, "0123456789", now), true);
			await writeEntry(cache, newer, "0123456789", now);
			// 让 older 的最后访问时间明显更早，sweep 才会先删它。
			await utimes(cache.binPath(cacheKey(older)), new Date(now - 60_000), new Date(now - 60_000));
			await cache.sweep(now);
			const stats = await cache.stats();
			assert.equal(stats.entries, 1);
			assert.equal(await cache.read(older, now), null);
			assert.notEqual(await cache.read(newer, now), null);
		});
	});

	it("启动清理会删掉 .part 残片", async () => {
		await withTempDir(async (dir) => {
			const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 60_000 });
			const stray = join(dir, cacheKey("https://github.com/o/r/x.zip") + ".part");
			await writeFile(stray, "partial", "utf8");
			await cache.cleanupPartial();
			assert.equal(existsSync(stray), false);
		});
	});

	it("ensureDir 会创建缺失的缓存目录", async () => {
		await withTempDir(async (base) => {
			const dir = join(base, "nested", "cache");
			const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 60_000 });
			assert.equal(existsSync(dir), false);
			await cache.ensureDir();
			assert.equal(existsSync(dir), true);
			assert.equal(await writeEntry(cache, "https://github.com/o/r/x.zip", "hello", 1), true);
		});
	});

	it("缓存目录不存在时写入降级为不缓存，而不是让进程崩掉", async () => {
		await withTempDir(async (base) => {
			const dir = join(base, "missing");
			const cache = new DiskCache({ dir, maxBytes: 1 << 20, ttlMs: 60_000 });
			const writer = cache.createWriter("https://github.com/o/r/x.zip", META, 1);
			await writer.write(Buffer.from("hello", "utf8"));
			// WriteStream 的 'error' 若没有监听器会变成未捕获异常，这条断言就是在守它。
			assert.equal(await writer.finish(5), false);
			assert.equal(existsSync(dir), false);
		});
	});
});
