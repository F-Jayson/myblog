/**
 * 磁盘 LRU 缓存（文档第 6 节）。
 *
 * 只缓存完整、长度可验证的 200 响应：Range 片段、chunked 响应、被中断的下载一律不落盘，
 * 否则一个半截文件会被后续请求当成完整文件返回，断点续传就永远拿不到正确字节。
 */
import { createHash } from "node:crypto";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import type { ReadStream, WriteStream } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";

export interface CacheMeta {
	readonly fileName: string;
	readonly contentType: string;
	readonly etag: string;
	readonly lastModified: string;
	readonly size: number;
	readonly storedAt: number;
}

export interface CacheEntry {
	readonly key: string;
	readonly meta: CacheMeta;
	readonly binPath: string;
}

export interface DiskCacheOptions {
	readonly dir: string;
	readonly maxBytes: number;
	readonly ttlMs: number;
}

export interface CacheWriter {
	readonly bytesWritten: number;
	write(chunk: Buffer): Promise<void>;
	/** 写入长度与 Content-Length 一致才 rename 成正式文件；返回是否提交成功。 */
	finish(expectedSize: number): Promise<boolean>;
	abort(): Promise<void>;
}

export type RangeSpec =
	| { readonly start: number; readonly end: number }
	| "unsatisfiable"
	| null;

const RANGE_PREFIX = "bytes=";
const META_SUFFIX = ".json";
const BIN_SUFFIX = ".bin";
const PART_SUFFIX = ".part";

/** key = sha256(目标 URL)，同一 URL 的重复下载才会命中同一条缓存。 */
export function cacheKey(url: string): string {
	return createHash("sha256").update(url, "utf8").digest("hex");
}

/**
 * 只支持单段 Range：多段（bytes=0-1,5-6）要拼 multipart 响应，GitHub 下载与
 * 断点续传都不会用到，遇到就当没有 Range 处理，返回完整文件更安全。
 * 语法错误同样按 RFC 忽略；只有"语法正确但越界"才返回 unsatisfiable（416）。
 */
export function parseRangeHeader(value: string | undefined, size: number): RangeSpec {
	if (value === undefined) return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed.startsWith(RANGE_PREFIX)) return null;
	const spec = trimmed.slice(RANGE_PREFIX.length).trim();
	if (spec === "" || spec.includes(",")) return null;

	const dash = spec.indexOf("-");
	if (dash < 0) return null;
	const startText = spec.slice(0, dash).trim();
	const endText = spec.slice(dash + 1).trim();

	if (startText === "") {
		// bytes=-N：最后 N 个字节。
		if (endText === "") return null;
		const suffix = Number(endText);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
		if (size === 0) return "unsatisfiable";
		const start = Math.max(0, size - suffix);
		return { start, end: size - 1 };
	}

	const start = Number(startText);
	if (!Number.isSafeInteger(start) || start < 0) return null;
	if (endText === "") {
		if (start >= size) return "unsatisfiable";
		return { start, end: size - 1 };
	}
	const end = Number(endText);
	if (!Number.isSafeInteger(end) || end < start) return null;
	if (start >= size) return "unsatisfiable";
	return { start, end: Math.min(end, size - 1) };
}

/** If-Range 只有强匹配才允许返回 206，弱 ETag 或日期不符都退回完整 200。 */
export function ifRangeMatches(ifRange: string | undefined, meta: CacheMeta): boolean {
	if (!ifRange) return false;
	const value = ifRange.trim();
	if (value.startsWith("W/")) return false;
	// ETag 一定带引号；带引号就按 ETag 比较，否则按 HTTP-date 比较。
	if (value.startsWith('"')) return meta.etag !== "" && value === meta.etag;
	return meta.lastModified !== "" && value === meta.lastModified;
}

export interface RangeHeaders {
	readonly status: number;
	readonly headers: Record<string, string>;
}

/** 206 的响应头；Content-Length 必须是切片长度，不能沿用整个文件的大小。 */
export function buildRangeHeaders(range: { start: number; end: number }, size: number, contentType: string): RangeHeaders {
	const headers: Record<string, string> = {
		"content-type": contentType || "application/octet-stream",
		"content-range": "bytes " + range.start + "-" + range.end + "/" + size,
		"content-length": String(range.end - range.start + 1),
		"accept-ranges": "bytes",
	};
	return { status: 206, headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMeta(raw: string): CacheMeta | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const size = parsed.size;
	const storedAt = parsed.storedAt;
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
	if (typeof storedAt !== "number" || !Number.isFinite(storedAt)) return null;
	return {
		fileName: typeof parsed.fileName === "string" ? parsed.fileName : "download.bin",
		contentType: typeof parsed.contentType === "string" ? parsed.contentType : "application/octet-stream",
		etag: typeof parsed.etag === "string" ? parsed.etag : "",
		lastModified: typeof parsed.lastModified === "string" ? parsed.lastModified : "",
		size,
		storedAt,
	};
}

export class DiskCache {
	readonly dir: string;
	readonly maxBytes: number;
	readonly ttlMs: number;

	constructor(options: DiskCacheOptions) {
		this.dir = options.dir;
		this.maxBytes = options.maxBytes;
		this.ttlMs = options.ttlMs;
	}

	/** ACCEL_CACHE_DIR 为空表示不缓存，纯流式转发。 */
	get enabled(): boolean {
		return this.dir !== "";
	}

	binPath(key: string): string {
		return join(this.dir, key + BIN_SUFFIX);
	}

	metaPath(key: string): string {
		return join(this.dir, key + META_SUFFIX);
	}

	private partPath(key: string): string {
		return join(this.dir, key + PART_SUFFIX);
	}

	private metaTmpPath(key: string): string {
		return join(this.dir, key + META_SUFFIX + PART_SUFFIX);
	}

	async ensureDir(): Promise<void> {
		if (!this.enabled) return;
		await fs.mkdir(this.dir, { recursive: true });
	}

	/** 读缓存元数据；过期、与 bin 长度不一致、内容损坏都视为未命中并顺手清理。 */
	async read(url: string, now = Date.now()): Promise<CacheEntry | null> {
		if (!this.enabled) return null;
		const key = cacheKey(url);
		let raw: string;
		try {
			raw = await fs.readFile(this.metaPath(key), "utf8");
		} catch {
			return null;
		}
		const meta = parseMeta(raw);
		if (meta === null) {
			await this.remove(key);
			return null;
		}
		if (now - meta.storedAt > this.ttlMs) {
			await this.remove(key);
			return null;
		}
		const binPath = this.binPath(key);
		let stat;
		try {
			stat = await fs.stat(binPath);
		} catch {
			await this.remove(key);
			return null;
		}
		if (stat.size !== meta.size) {
			await this.remove(key);
			return null;
		}
		// 命中即刷新 mtime：淘汰排序用的是"最后访问时间"，这里不做额外索引文件。
		const touched = new Date(now);
		await fs.utimes(binPath, touched, touched).catch(() => undefined);
		return { key, meta, binPath };
	}

	openReadStream(entry: CacheEntry, range?: { start: number; end: number }): ReadStream {
		return range
			? createReadStream(entry.binPath, { start: range.start, end: range.end })
			: createReadStream(entry.binPath);
	}

	createWriter(url: string, meta: Omit<CacheMeta, "size" | "storedAt">, now = Date.now()): CacheWriter {
		const key = cacheKey(url);
		// 同一 URL 可能被并发下载：每个 writer 用独立 .part 文件，避免两个流交叉写坏缓存。
		const partPath = `${this.partPath(key)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
		const binPath = this.binPath(key);
		const metaPath = this.metaPath(key);
		const metaTmpPath = this.metaTmpPath(key);
		const stream: WriteStream = createWriteStream(partPath, { flags: "w" });
		let bytes = 0;
		let settled = false;
		// WriteStream 的 'error' 没有监听器时会变成未捕获异常直接杀死节点（缓存目录不存在、
		// 磁盘写满、权限不足都会触发）。缓存只是加速手段，写失败必须降级成"不缓存"，
		// 而不是让正在下载的用户拿到一个断连。
		let failed: Error | null = null;
		stream.on("error", (error: Error) => {
			failed = error;
		});

		const cleanup = async () => {
			await fs.unlink(partPath).catch(() => undefined);
			await fs.unlink(metaTmpPath).catch(() => undefined);
		};

		return {
			get bytesWritten() {
				return bytes;
			},
			async write(chunk: Buffer): Promise<void> {
				if (settled || failed !== null) return;
				bytes += chunk.length;
				if (stream.write(chunk)) return;
				try {
					// 写入失败时 'drain' 永远不会触发，必须同时等 'error'/'close' 才不挂死。
					await new Promise<void>((resolve) => {
						const done = () => {
							stream.off("drain", done);
							stream.off("error", done);
							stream.off("close", done);
							resolve();
						};
						stream.once("drain", done);
						stream.once("error", done);
						stream.once("close", done);
					});
				} catch {
					// 失败原因已经记在 failed 里，交给 finish 统一收尾。
				}
			},
			async finish(expectedSize: number): Promise<boolean> {
				if (settled) return false;
				settled = true;
				if (failed !== null) {
					await cleanup();
					return false;
				}
				try {
					await new Promise<void>((resolve, reject) => {
						if (failed !== null) {
							reject(failed);
							return;
						}
						// 打开失败时 end() 的回调不会被调用，必须直接监听 'error' 才能结束等待。
						stream.once("error", reject);
						stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
					});
				} catch {
					await cleanup();
					return false;
				}
				// 长度对不上说明上游提前断开或 Content-Length 在撒谎，绝不能落盘。
				if (bytes !== expectedSize) {
					await cleanup();
					return false;
				}
				const finalMeta: CacheMeta = { ...meta, size: bytes, storedAt: now };
				let binReplaced = false;
				try {
					await fs.writeFile(metaTmpPath, JSON.stringify(finalMeta), "utf8");
					await fs.rename(partPath, binPath);
					binReplaced = true;
					await fs.rename(metaTmpPath, metaPath);
				} catch {
					// rename 失败时保留 .part 没有意义，清掉避免脏数据堆积。
					await cleanup();
					// 只有确实替换过 bin 才删除它；否则会把之前仍有效的缓存一起删掉。
					if (binReplaced) {
						await fs.unlink(binPath).catch(() => undefined);
						await fs.unlink(metaPath).catch(() => undefined);
					}
					return false;
				}
				return true;
			},
			async abort(): Promise<void> {
				if (settled) return;
				settled = true;
				stream.destroy();
				await cleanup();
			},
		};
	}

	async remove(key: string): Promise<void> {
		await Promise.all([
			fs.unlink(this.binPath(key)).catch(() => undefined),
			fs.unlink(this.metaPath(key)).catch(() => undefined),
			fs.unlink(this.partPath(key)).catch(() => undefined),
			fs.unlink(this.metaTmpPath(key)).catch(() => undefined),
		]);
	}

	async list(): Promise<{ key: string; size: number; storedAt: number; mtimeMs: number }[]> {
		if (!this.enabled) return [];
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch {
			return [];
		}
		const entries: { key: string; size: number; storedAt: number; mtimeMs: number }[] = [];
		for (const name of names) {
			if (!name.endsWith(META_SUFFIX)) continue;
			const key = name.slice(0, -META_SUFFIX.length);
			try {
				const raw = await fs.readFile(join(this.dir, name), "utf8");
				const meta = parseMeta(raw);
				if (meta === null) continue;
				const stat = await fs.stat(this.binPath(key));
				entries.push({ key, size: stat.size, storedAt: meta.storedAt, mtimeMs: stat.mtimeMs });
			} catch {
				continue;
			}
		}
		return entries;
	}

	/** 先按 TTL 删过期，再按最后访问时间（bin 的 mtime）删到总量不超上限。 */
	async sweep(now = Date.now()): Promise<void> {
		if (!this.enabled) return;
		const entries = await this.list();
		let total = 0;
		const alive: typeof entries = [];
		for (const entry of entries) {
			if (now - entry.storedAt > this.ttlMs) {
				await this.remove(entry.key);
				continue;
			}
			alive.push(entry);
			total += entry.size;
		}
		if (total <= this.maxBytes) return;
		alive.sort((left, right) => left.mtimeMs - right.mtimeMs);
		for (const entry of alive) {
			if (total <= this.maxBytes) break;
			await this.remove(entry.key);
			total -= entry.size;
		}
	}

	async stats(): Promise<{ entries: number; bytes: number }> {
		const entries = await this.list();
		return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
	}

	/** 启动时清理上次进程留下的 .part 残片。 */
	async cleanupPartial(): Promise<void> {
		if (!this.enabled) return;
		let names: string[];
		try {
			names = await fs.readdir(this.dir);
		} catch {
			return;
		}
		await Promise.all(names
			.filter((name) => name.endsWith(PART_SUFFIX))
			.map((name) => fs.unlink(join(this.dir, name)).catch(() => undefined)));
	}
}
