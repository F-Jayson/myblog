import assert from "node:assert/strict";
import { Readable, Writable, pipeline } from "node:stream";
import test from "node:test";
import { createThrottleStream, pipeToClient } from "../src/throttle.ts";

const KIB = 1024;

interface SinkStats {
	bytes: number;
	/** 第一个字节到达的时刻（Date.now），突发额度就是在这之前全部用掉的。 */
	firstAt: number;
	lastAt: number;
}

/** 计量用下水道：记录字节数与首末字节时间，finish 时兑现 Promise。 */
function makeSink(): { sink: Writable; stats: SinkStats; finished: Promise<void> } {
	const stats: SinkStats = { bytes: 0, firstAt: 0, lastAt: 0 };
	let done: () => void = () => undefined;
	const finished = new Promise<void>((resolve) => {
		done = resolve;
	});
	const sink = new Writable({
		// 故意压小可写缓冲，让背压真的传到上游，而不是全堆在内存里。
		highWaterMark: 16 * KIB,
		write(chunk: Buffer, _encoding, callback) {
			if (stats.bytes === 0) stats.firstAt = Date.now();
			stats.bytes += chunk.length;
			stats.lastAt = Date.now();
			callback();
		},
	});
	sink.on("finish", () => done());
	return { sink, stats, finished };
}

function repeatChunks(totalBytes: number, chunkSize: number): { chunks: Buffer[]; total: number } {
	const chunks: Buffer[] = [];
	let remaining = totalBytes;
	while (remaining > 0) {
		const size = Math.min(chunkSize, remaining);
		chunks.push(Buffer.alloc(size, 0x5a));
		remaining -= size;
	}
	return { chunks, total: totalBytes };
}

test("实测速率与配置值相差不超过 5%", { timeout: 20_000 }, async () => {
	const bytesPerSecond = 4 * 1024 * KIB; // 4 MiB/s
	const chunkSize = 64 * KIB;
	const { chunks, total } = repeatChunks(96 * chunkSize, chunkSize); // 6 MiB
	// 桶容量规则：max(速率 × 0.1, 64 KiB)，开局满桶，这部分字节是"免费"突发的。
	const capacity = Math.max(bytesPerSecond * 0.1, 64 * KIB);

	const { sink, stats, finished } = makeSink();
	await new Promise<void>((resolve, reject) => {
		pipeline(Readable.from(chunks), createThrottleStream({ bytesPerSecond }), sink, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	await finished;

	assert.equal(stats.bytes, total);
	// 扣掉开局就发出去的突发额度再算速率，否则 6 MiB 的流里 100 KiB 的突发会把结果抬高 1.6%。
	const measured = (stats.bytes - capacity) / ((stats.lastAt - stats.firstAt) / 1000);
	const error = Math.abs(measured - bytesPerSecond) / bytesPerSecond;
	assert.ok(
		error <= 0.05,
		"实测速率 " + Math.round(measured) + " B/s 偏离配置值 " + bytesPerSecond + " B/s 超过 5%（" + (error * 100).toFixed(1) + "%）",
	);
});

test("bytesPerSecond=0 表示不限速，大块立刻通过", { timeout: 10_000 }, async () => {
	const total = 8 * 1024 * KIB; // 8 MiB，限速流根本不可能在 1 秒内送完
	const started = Date.now();
	const { sink, stats, finished } = makeSink();
	await new Promise<void>((resolve, reject) => {
		pipeline(Readable.from([Buffer.alloc(total, 1)]), createThrottleStream({ bytesPerSecond: 0 }), sink, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	await finished;
	assert.equal(stats.bytes, total);
	assert.ok(Date.now() - started < 1000, "不限速时 8 MiB 应在 1 秒内送完，实际 " + (Date.now() - started) + " ms");
});

test("单个数据块大于桶容量时按片放行，不卡死也不冲顶", { timeout: 20_000 }, async () => {
	const bytesPerSecond = 1024 * KIB; // 1 MiB/s，容量 max(102.4 KiB, 64 KiB) = 102.4 KiB
	const capacity = Math.max(bytesPerSecond * 0.1, 64 * KIB);
	const chunk = Buffer.alloc(512 * KIB, 2); // 一块就 5 倍容量

	const { sink, stats, finished } = makeSink();
	const started = Date.now();
	await new Promise<void>((resolve, reject) => {
		pipeline(Readable.from([chunk]), createThrottleStream({ bytesPerSecond }), sink, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	await finished;
	const elapsed = Date.now() - started;

	assert.equal(stats.bytes, chunk.length);
	// 扣掉突发额度后仍需约 (512 KiB - 102.4 KiB) / 1 MiB/s ≈ 400 ms。
	assert.ok(elapsed >= 200, "超容量块应当被分片放行，实际只用了 " + elapsed + " ms，说明整块被直接放行了");
});

test("destroy 后清掉定时器，用例不会挂住", { timeout: 10_000 }, async () => {
	// 1 KiB/s 的桶容量是 64 KiB 下限，写 70000 字节就会有一片必须等待约 4 秒。
	const throttle = createThrottleStream({ bytesPerSecond: 1024 });
	throttle.write(Buffer.alloc(70_000, 3));
	// 等一拍，确认已经进入"等令牌"状态（此时内部挂着未 unref 前的 timer）。
	await new Promise((resolve) => setTimeout(resolve, 60));
	throttle.destroy();
	assert.equal(throttle.destroyed, true);
	// 定时器若没被清掉，这里会先等到 4 秒后的 pump；用例自己的超时就会暴露问题。
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(throttle.destroyed, true);
});

test("开局满桶：首个数据块立即可发", { timeout: 10_000 }, async () => {
	const bytesPerSecond = 64 * KIB; // 容量刚好 64 KiB，与块等大
	const { sink, stats, finished } = makeSink();
	const started = Date.now();
	pipeToClient(Readable.from([Buffer.alloc(64 * KIB, 4)]), sink, bytesPerSecond);
	await finished;
	const elapsed = Date.now() - started;
	assert.equal(stats.bytes, 64 * KIB);
	assert.ok(elapsed < 500, "首包应立刻发出，实际等了 " + elapsed + " ms");
});

test("pipeToClient 端到端字节一致", { timeout: 20_000 }, async () => {
	const payload = Buffer.alloc(256 * KIB);
	for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
	const received: Buffer[] = [];
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			received.push(Buffer.from(chunk));
			callback();
		},
	});
	await new Promise<void>((resolve) => {
		sink.on("finish", resolve);
		pipeToClient(Readable.from([payload]), sink, 8 * 1024 * KIB);
	});
	const merged = Buffer.concat(received);
	assert.equal(merged.length, payload.length);
	assert.equal(Buffer.compare(merged, payload), 0, "经过限速流之后字节必须完全一致");
});

test("pipeToClient 在上游出错时销毁 dest", { timeout: 10_000 }, async () => {
	const source = new Readable({
		read() {
			this.destroy(new Error("上游崩了"));
		},
	});
	const destroyed: string[] = [];
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
	await new Promise<void>((resolve) => {
		sink.on("close", () => {
			destroyed.push("close");
			resolve();
		});
		pipeToClient(source, sink, 1024 * KIB);
	});
	assert.deepEqual(destroyed, ["close"]);
});
