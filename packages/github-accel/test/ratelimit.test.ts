import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AccessGuard } from "../src/ratelimit.ts";

describe("每分钟计数窗口", () => {
	it("窗口内超过上限返回 RATE_LIMITED 与 Retry-After", () => {
		const guard = new AccessGuard({ perMinute: 2, concurrencyPerIp: 10, maxConcurrency: 10 });
		const now = 1_700_000_000_000;
		for (let i = 0; i < 2; i += 1) {
			const result = guard.acquire("1.1.1.1", now);
			assert.equal(result.ok, true);
			if (result.ok) result.release();
		}
		const blocked = guard.acquire("1.1.1.1", now + 1000);
		assert.equal(blocked.ok, false);
		if (blocked.ok) return;
		assert.equal(blocked.reason, "RATE_LIMITED");
		assert.equal(blocked.retryAfterSeconds >= 1, true);
	});

	it("窗口过期后重新计数", () => {
		const guard = new AccessGuard({ perMinute: 1, concurrencyPerIp: 10, maxConcurrency: 10 });
		const now = 1_700_000_000_000;
		const first = guard.acquire("1.1.1.1", now);
		assert.equal(first.ok, true);
		if (first.ok) first.release();
		assert.equal(guard.acquire("1.1.1.1", now + 59_000).ok, false);
		assert.equal(guard.acquire("1.1.1.1", now + 61_000).ok, true);
	});

	it("perMinute 为 0 表示不限流", () => {
		const guard = new AccessGuard({ perMinute: 0, concurrencyPerIp: 10, maxConcurrency: 10 });
		for (let i = 0; i < 100; i += 1) {
			const result = guard.acquire("1.1.1.1", 1_700_000_000_000);
			assert.equal(result.ok, true);
			if (result.ok) result.release();
		}
	});
});

describe("并发上限", () => {
	it("同一 IP 超过并发上限返回 IP_CONCURRENCY_LIMITED", () => {
		const guard = new AccessGuard({ perMinute: 100, concurrencyPerIp: 1, maxConcurrency: 10 });
		const now = 1_700_000_000_000;
		const held = guard.acquire("1.1.1.1", now);
		assert.equal(held.ok, true);
		const blocked = guard.acquire("1.1.1.1", now);
		assert.equal(blocked.ok, false);
		if (blocked.ok) return;
		assert.equal(blocked.reason, "IP_CONCURRENCY_LIMITED");
		// 另一个 IP 不受影响
		const other = guard.acquire("2.2.2.2", now);
		assert.equal(other.ok, true);
		if (other.ok) other.release();
		if (held.ok) held.release();
		assert.equal(guard.acquire("1.1.1.1", now).ok, true);
	});

	it("全局并发满返回 GLOBAL_CONCURRENCY_LIMITED", () => {
		const guard = new AccessGuard({ perMinute: 100, concurrencyPerIp: 10, maxConcurrency: 1 });
		const held = guard.acquire("1.1.1.1", 1_700_000_000_000);
		assert.equal(held.ok, true);
		const blocked = guard.acquire("2.2.2.2", 1_700_000_000_000);
		assert.equal(blocked.ok, false);
		if (blocked.ok) return;
		assert.equal(blocked.reason, "GLOBAL_CONCURRENCY_LIMITED");
		assert.equal(blocked.retryAfterSeconds, 10);
		if (held.ok) held.release();
		assert.equal(guard.acquire("2.2.2.2", 1_700_000_000_000).ok, true);
	});

	it("重复 release 不会把计数减成负数", () => {
		const guard = new AccessGuard({ perMinute: 100, concurrencyPerIp: 1, maxConcurrency: 1 });
		const result = guard.acquire("1.1.1.1", 1_700_000_000_000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		result.release();
		result.release();
		assert.deepEqual(guard.stats, { active: 0, ips: 0 });
	});
});
