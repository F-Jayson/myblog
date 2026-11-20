/**
 * 访问控制：每 IP 每分钟计数窗口 + 每 IP 并发 + 全局并发。
 *
 * 三类限制放在一个类里，是因为一次下载请求要么整体放行、要么整体拒绝；
 * 拆成多个模块反而要在路由里手工回滚状态，容易漏掉释放额度。
 *
 * 时间可由调用方注入（now 参数）：单测不需要真的等一分钟。
 */

const WINDOW_MS = 60_000;

export type RejectReason = "RATE_LIMITED" | "IP_CONCURRENCY_LIMITED" | "GLOBAL_CONCURRENCY_LIMITED";

export type AcquireResult =
	| { readonly ok: true; readonly release: () => void }
	| { readonly ok: false; readonly reason: RejectReason; readonly retryAfterSeconds: number };

export interface AccessGuardOptions {
	readonly perMinute: number;
	readonly concurrencyPerIp: number;
	readonly maxConcurrency: number;
}

interface WindowBucket {
	count: number;
	resetAt: number;
}

/** 计数器超过这个规模就清一次过期窗口，避免长期运行被扫描器灌满内存。 */
const MAX_BUCKETS = 4096;

export class AccessGuard {
	readonly perMinute: number;
	readonly concurrencyPerIp: number;
	readonly maxConcurrency: number;

	private readonly windows = new Map<string, WindowBucket>();
	private readonly activePerIp = new Map<string, number>();
	private active = 0;

	constructor(options: AccessGuardOptions) {
		this.perMinute = Math.max(0, Math.floor(options.perMinute));
		this.concurrencyPerIp = Math.max(1, Math.floor(options.concurrencyPerIp));
		this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
	}

	/** 只检查计数窗口，不做并发占位；返回剩余可重试时间供 Retry-After 使用。 */
	checkRate(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
		if (this.perMinute <= 0) return { allowed: true, retryAfterSeconds: 0 };
		const key = ip || "unknown";
		const bucket = this.windows.get(key);
		if (bucket === undefined || bucket.resetAt <= now) {
			this.windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
			if (this.windows.size > MAX_BUCKETS) this.prune(now);
			return { allowed: true, retryAfterSeconds: 0 };
		}
		bucket.count += 1;
		if (bucket.count > this.perMinute) {
			return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
		}
		return { allowed: true, retryAfterSeconds: 0 };
	}

	private prune(now: number): void {
		for (const [key, bucket] of this.windows) {
			if (bucket.resetAt <= now) this.windows.delete(key);
		}
	}

	/**
	 * 申请一个并发额度。先算计数再算并发：被限流的请求不应该占用并发槽位。
	 * 放行时返回 release 回调，调用方必须在响应结束时调用一次。
	 */
	acquire(ip: string, now = Date.now()): AcquireResult {
		const rate = this.checkRate(ip, now);
		if (!rate.allowed) {
			return { ok: false, reason: "RATE_LIMITED", retryAfterSeconds: rate.retryAfterSeconds };
		}
		const key = ip || "unknown";
		const current = this.activePerIp.get(key) ?? 0;
		if (current >= this.concurrencyPerIp) {
			// 每 IP 并发超限是客户端行为问题，用 429 让它退避；全局超限是节点容量问题，用 503。
			return { ok: false, reason: "IP_CONCURRENCY_LIMITED", retryAfterSeconds: 5 };
		}
		if (this.active >= this.maxConcurrency) {
			return { ok: false, reason: "GLOBAL_CONCURRENCY_LIMITED", retryAfterSeconds: 10 };
		}

		this.activePerIp.set(key, current + 1);
		this.active += 1;
		let released = false;
		return {
			ok: true,
			release: () => {
				// 防止路由里重复调用 release 把计数减成负数。
				if (released) return;
				released = true;
				this.active -= 1;
				const next = (this.activePerIp.get(key) ?? 1) - 1;
				if (next <= 0) this.activePerIp.delete(key);
				else this.activePerIp.set(key, next);
			},
		};
	}

	/** 当前并发数，健康检查与单测用。 */
	get stats(): { active: number; ips: number } {
		return { active: this.active, ips: this.activePerIp.size };
	}

	reset(): void {
		this.windows.clear();
		this.activePerIp.clear();
		this.active = 0;
	}
}
