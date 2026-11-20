import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readConfig, securityWarnings } from "../src/config.ts";

describe("环境变量解析", () => {
	it("空字符串数字回退默认值（Number('')===0 的陷阱）", () => {
		const cfg = readConfig({ ACCEL_PORT: "", ACCEL_RATE_PER_MINUTE: "  ", ACCEL_MAX_CONCURRENCY: "" });
		assert.equal(cfg.port, 8787);
		assert.equal(cfg.ratePerMinute, 30);
		assert.equal(cfg.maxConcurrency, 64);
	});

	it("非法数字回退默认值，合法数字生效", () => {
		const fallback = readConfig({ ACCEL_PORT: "abc", ACCEL_CACHE_MAX_BYTES: "-1" });
		assert.equal(fallback.port, 8787);
		assert.equal(fallback.cacheMaxBytes, 21_474_836_480);
		const custom = readConfig({ ACCEL_PORT: "9000", ACCEL_CONCURRENCY_PER_IP: "5" });
		assert.equal(custom.port, 9000);
		assert.equal(custom.concurrencyPerIp, 5);
	});

	it("布尔只认约定取值", () => {
		assert.equal(readConfig({}).allowPublic, true);
		assert.equal(readConfig({ ACCEL_ALLOW_PUBLIC: "false" }).allowPublic, false);
		assert.equal(readConfig({ ACCEL_ALLOW_PUBLIC: "0" }).allowPublic, false);
		assert.equal(readConfig({ ACCEL_ALLOW_PUBLIC: "yes" }).allowPublic, true);
		assert.equal(readConfig({ ACCEL_ALLOW_PUBLIC: "" }).allowPublic, true);
	});

	it("限速三项：未配置时用默认档位（游客 10 MiB/s、登录 100 MiB/s、游客并发 1）", () => {
		const cfg = readConfig({});
		assert.equal(cfg.guestBytesPerSecond, 10_485_760);
		assert.equal(cfg.memberBytesPerSecond, 104_857_600);
		assert.equal(cfg.guestConcurrencyPerIp, 1);
	});

	it("限速三项：显式值生效，0 与未配置必须区分开", () => {
		const custom = readConfig({
			ACCEL_GUEST_BYTES_PER_SECOND: "2097152",
			ACCEL_MEMBER_BYTES_PER_SECOND: "52428800",
			ACCEL_GUEST_CONCURRENCY_PER_IP: "3",
		});
		assert.equal(custom.guestBytesPerSecond, 2_097_152);
		assert.equal(custom.memberBytesPerSecond, 52_428_800);
		assert.equal(custom.guestConcurrencyPerIp, 3);

		// 0 是"不限速"的合法配置，不能被当成空值回退成默认速率。
		const unlimited = readConfig({ ACCEL_GUEST_BYTES_PER_SECOND: "0", ACCEL_MEMBER_BYTES_PER_SECOND: "0" });
		assert.equal(unlimited.guestBytesPerSecond, 0);
		assert.equal(unlimited.memberBytesPerSecond, 0);
		// 并发 0 交给 AccessGuard 收敛到 1，配置层只如实透传。
		assert.equal(readConfig({ ACCEL_GUEST_CONCURRENCY_PER_IP: "0" }).guestConcurrencyPerIp, 0);
	});

});

describe("安全告警", () => {
	it("空 secret + 关闭公开访问时告警", () => {
		const warnings = securityWarnings(readConfig({ ACCEL_ALLOW_PUBLIC: "false" }));
		assert.equal(warnings.some((warning) => warning.includes("ACCEL_SECRET 为空")), true);
	});

	it("过短的 secret 告警", () => {
		const warnings = securityWarnings(readConfig({ ACCEL_SECRET: "short" }));
		assert.equal(warnings.some((warning) => warning.includes("少于 32 字符")), true);
	});

	it("正常的 secret 不告警", () => {
		const warnings = securityWarnings(readConfig({ ACCEL_SECRET: "a".repeat(32) }));
		assert.deepEqual(warnings, []);
	});
});
