import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTicket, verifyTicket } from "../src/ticket.ts";

const SECRET = "test-secret-0123456789abcdef0123456789";
const VECTOR_FILE_PAYLOAD = "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0";
const VECTOR_FILE_TICKET = VECTOR_FILE_PAYLOAD + ".1fdb9326cecbc1dae9177cd18b229837";
const VECTOR_GIT_TICKET = "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0.e3b1ec8cf96bc251c12bcf34aa369b7c";

describe("ticket：文档第 2 节的固定测试向量", () => {
	it("file ticket 与文档逐字节一致", () => {
		const ticket = createTicket({ u: "https://github.com/o/r/releases/download/v1/a.zip", e: 1_800_000_000, k: "file" }, SECRET);
		assert.equal(ticket, VECTOR_FILE_TICKET);
	});

	it("git ticket 与文档逐字节一致", () => {
		const ticket = createTicket({ u: "/o/r.git", e: 1_800_000_000, k: "git" }, SECRET);
		assert.equal(ticket, VECTOR_GIT_TICKET);
	});

	it("payload 就是签名 message 本身（base64url 无填充）", () => {
		assert.equal(VECTOR_FILE_TICKET.split(".")[0], VECTOR_FILE_PAYLOAD);
		assert.equal(VECTOR_FILE_PAYLOAD.includes("="), false);
	});
});

describe("ticket：校验", () => {
	it("往返校验通过并还原 payload", () => {
		const ticket = createTicket({ u: "https://github.com/o/r/releases/download/v1/a.zip", e: 1_800_000_000, k: "file" }, SECRET);
		const result = verifyTicket(ticket, "file", SECRET, 1_700_000_000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.payload.u, "https://github.com/o/r/releases/download/v1/a.zip");
		assert.equal(result.payload.e, 1_800_000_000);
		assert.equal(result.payload.k, "file");
	});

	it("过期返回 TICKET_EXPIRED", () => {
		const ticket = createTicket({ u: "/o/r.git", e: 1_000, k: "git" }, SECRET);
		const result = verifyTicket(ticket, "git", SECRET, 1_001);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "TICKET_EXPIRED");
	});

	it("换密钥后签名校验失败", () => {
		const ticket = createTicket({ u: "/o/r.git", e: 1_800_000_000, k: "git" }, SECRET);
		const result = verifyTicket(ticket, "git", SECRET + "x", 1_700_000_000);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "TICKET_INVALID");
	});

	it("篡改 payload 后签名不匹配", () => {
		const ticket = createTicket({ u: "/o/r.git", e: 1_800_000_000, k: "git" }, SECRET);
		const [payload, signature] = ticket.split(".") as [string, string];
		const tamperedPayload = Buffer.from(JSON.stringify({ u: "/o/evil.git", e: 1_800_000_000, k: "git" }), "utf8").toString("base64url");
		const result = verifyTicket(tamperedPayload + "." + signature, "git", SECRET, 1_700_000_000);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "TICKET_INVALID");
		assert.equal(payload.length > 0, true);
	});

	it("kind 不匹配时拒绝", () => {
		const ticket = createTicket({ u: "https://github.com/o/r", e: 1_800_000_000, k: "file" }, SECRET);
		const result = verifyTicket(ticket, "git", SECRET, 1_700_000_000);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "TICKET_INVALID");
	});

	it("格式错误的 ticket 不会抛异常", () => {
		for (const bad of ["", "no-dot", "a.b", "..", "x.".repeat(1) + "1", "abc.zzzz"]) {
			const result = verifyTicket(bad, "file", SECRET, 1_700_000_000);
			assert.equal(result.ok, false, "应当拒绝：" + bad);
		}
	});

	it("secret 为空时不校验签名（调试模式）但仍校验过期", () => {
		const ticket = createTicket({ u: "/o/r.git", e: 1_800_000_000, k: "git" }, "");
		assert.equal(verifyTicket(ticket, "git", "", 1_700_000_000).ok, true);
		assert.equal(verifyTicket(ticket, "git", "", 1_900_000_000).ok, false);
	});
});
