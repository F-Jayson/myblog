/**
 * 单连接令牌桶限速。
 *
 * 一条响应流一个桶，不做跨连接共享：多开连接绕过单连接限速的问题由游客并发收窄兜住，
 * 而共享桶要在节点侧维护可回收的每 IP 状态，收益抵不上复杂度（设计第 3 节）。
 */
import { Transform, pipeline, type TransformCallback } from "node:stream";
import type { Readable, Writable } from "node:stream";

export interface ThrottleOptions {
	/** 每秒允许多少字节；<= 0 表示不限速。 */
	readonly bytesPerSecond: number;
	/** 突发额度按多少秒的速率折算，默认 0.1 秒。 */
	readonly burstSeconds?: number;
	/** 注入时钟，单测用。 */
	readonly now?: () => number;
}

const DEFAULT_BURST_SECONDS = 0.1;
/**
 * 桶容量下限 64 KiB：100 MiB/s 下 16 KiB 一块只要 0.16 ms，容量小于一块就会被
 * 1 ms 的定时器粒度拖到跑不满标称速率；下限同时也给首包留出立即可发的余量。
 */
const MIN_CAPACITY_BYTES = 64 * 1024;
/** setTimeout 的最小可靠间隔是 1 ms，再小只会空转。 */
const MIN_WAIT_MS = 1;

interface PendingChunk {
	readonly chunk: Buffer;
	offset: number;
	readonly callback: TransformCallback;
}

class ThrottleStream extends Transform {
	private readonly bytesPerSecond: number;
	private readonly capacity: number;
	private readonly clock: () => number;
	private tokens: number;
	private lastRefill: number;
	private timer: NodeJS.Timeout | null = null;
	/** 正在放行的块：单块可能大于桶容量，所以按片推进。 */
	private pending: PendingChunk | null = null;
	/** destroy 之后不再回调 transform，也不再 push。 */
	private halted = false;

	constructor(options: ThrottleOptions) {
		super();
		this.bytesPerSecond = options.bytesPerSecond;
		const burstSeconds = options.burstSeconds !== undefined && options.burstSeconds > 0
			? options.burstSeconds
			: DEFAULT_BURST_SECONDS;
		this.capacity = Math.max(this.bytesPerSecond * burstSeconds, MIN_CAPACITY_BYTES);
		this.clock = options.now ?? Date.now;
		// 开局满桶：首包立即可发，否则小文件会被硬生生压出一个令牌的延迟。
		this.tokens = this.capacity;
		this.lastRefill = this.clock();
	}

	override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		this.pending = { chunk, offset: 0, callback };
		this.pump();
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.halted = true;
		this.clearTimer();
		// 不再回调：destroy 之后回调只会把数据推进一个已销毁的流。
		this.pending = null;
		callback(error);
	}

	/**
	 * 放行当前块：凑够令牌就 push 一片，不够就等，等的时候不回调 _transform，
	 * pipe 的背压会自然作用到上游 socket，内存不会堆积。
	 */
	private pump(): void {
		const pending = this.pending;
		if (pending === null || this.halted) return;

		for (;;) {
			const remaining = pending.chunk.length - pending.offset;
			if (remaining <= 0) {
				this.pending = null;
				pending.callback();
				return;
			}
			// 单块大于桶容量时必须切片：否则要么永远攒不够令牌（卡死），
			// 要么一次放行超出桶容量（速率冲顶）。
			const pieceLength = Math.min(remaining, this.capacity);
			const waitMs = this.reserve(pieceLength);
			if (waitMs > 0) {
				this.waitThen(waitMs);
				return;
			}
			// push 返回 false 只是可读侧缓冲区满了；这里最多一次推一个桶容量，
			// 上界就是突发额度，继续靠定时器节流即可。
			this.push(pending.chunk.subarray(pending.offset, pending.offset + pieceLength));
			pending.offset += pieceLength;
		}
	}

	/** 令牌够就扣掉并返回 0，不够就返回还需等待的毫秒数（不预扣：等待期间可能被 destroy）。 */
	private reserve(bytes: number): number {
		this.refill();
		if (this.tokens >= bytes) {
			this.tokens -= bytes;
			return 0;
		}
		return ((bytes - this.tokens) / this.bytesPerSecond) * 1000;
	}

	private refill(): void {
		const current = this.clock();
		const elapsedMs = current - this.lastRefill;
		// 时钟倒退（注入时钟的单测里常见）时不动基准点，避免同一段时间被补两次令牌。
		if (elapsedMs <= 0) return;
		this.lastRefill = current;
		this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.bytesPerSecond);
	}

	private waitThen(delayMs: number): void {
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = null;
			this.pump();
		}, Math.max(MIN_WAIT_MS, Math.ceil(delayMs)));
		// unref：被中断的下载不该留下一个把进程（docker stop / systemd stop）钉住的 timer。
		this.timer.unref();
	}

	private clearTimer(): void {
		if (this.timer === null) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
}

/** 不限速时的直通流：接口统一返回 Transform，调用方不用判断档位。 */
function createPassThrough(): Transform {
	return new Transform({
		transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
			callback(null, chunk);
		},
	});
}

export function createThrottleStream(options: ThrottleOptions): Transform {
	const bytesPerSecond = Number.isFinite(options.bytesPerSecond) ? options.bytesPerSecond : 0;
	if (!(bytesPerSecond > 0)) return createPassThrough();
	return new ThrottleStream({ ...options, bytesPerSecond });
}

/**
 * 把 source 限速后送到 dest。
 *
 * 用 pipeline 而不是裸 pipe：出错时它会把上游与 dest 一起拆掉，
 * 这里再显式 destroy 一次 dest，保证中断的响应不会让 socket 半开。
 */
export function pipeToClient(source: Readable, dest: Writable, bytesPerSecond: number, now?: () => number): void {
	if (!(bytesPerSecond > 0)) {
		// 0 表示不限速：保持旧行为（裸 pipe），连一层 Transform 都不额外建。
		// 但仍要接管 source 的错误，否则一个 'error' 事件就能打崩进程。
		source.on("error", () => dest.destroy());
		source.pipe(dest);
		return;
	}
	pipeline(source, createThrottleStream({ bytesPerSecond, now }), dest, (error: Error | null | undefined) => {
		// Node 的 pipeline 成功时回调参数可能是 undefined 而不是 null，两种都要当成功处理。
		if (error !== null && error !== undefined) dest.destroy();
	});
}
