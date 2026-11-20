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

	it("baseUrl 去掉末尾斜杠，避免拼出双斜杠", () => {
		assert.equal(readConfig({ ACCEL_BASE_URL: "https://accel.example.com/" }).baseUrl, "https://accel.example.com");
		assert.equal(readConfig({ ACCEL_BASE_URL: "  " }).baseUrl, "");
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
