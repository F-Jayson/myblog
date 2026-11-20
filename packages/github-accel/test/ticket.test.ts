import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHmac } from "node:crypto";

import { createTicket, verifyTicket } from "../src/ticket.ts";

const SECRET = "test-secret-0123456789abcdef0123456789";
const FILE_URL = "https://github.com/o/r/releases/download/v1/a.zip";
const GIT_URL = "/o/r.git";
const EXPIRES = 1_800_000_000;

const VECTOR_FILE_GUEST_PAYLOAD =
	"eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Imd1ZXN0In0";
const VECTOR_FILE_GUEST = VECTOR_FILE_GUEST_PAYLOAD + ".c1f6b1ac1ab2aaac6e0a3c8e5d19f943";
const VECTOR_FILE_MEMBER_PAYLOAD =
	"eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Im1lbWJlciJ9";
const VECTOR_FILE_MEMBER = VECTOR_FILE_MEMBER_PAYLOAD + ".7ef37acc7057c396f905918b914e77cb";
const VECTOR_GIT_GUEST_PAYLOAD = "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Imd1ZXN0In0";
const VECTOR_GIT_GUEST = VECTOR_GIT_GUEST_PAYLOAD + ".954481962b3921ce992e13fcb4343fe7";
const VECTOR_GIT_MEMBER_PAYLOAD = "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Im1lbWJlciJ9";
const VECTOR_GIT_MEMBER = VECTOR_GIT_MEMBER_PAYLOAD + ".9644aedea787e8ec02ba5bf8a337daff";
/** 旧向量：payload 里没有 t，滚动发布窗口里主站可能还在签发这种 ticket。 */
const LEGACY_FILE_PAYLOAD =
	"eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0";
const LEGACY_FILE_TICKET = LEGACY_FILE_PAYLOAD + ".1fdb9326cecbc1dae9177cd18b229837";
const LEGACY_GIT_TICKET = "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0.e3b1ec8cf96bc251c12bcf34aa369b7c";

/** 和 src/ticket.ts 同一套算法：HMAC-SHA256 十六进制前 32 个字符。 */
function signForTest(payload: string): string {
	return createHmac("sha256", SECRET).update(payload).digest("hex").slice(0, 32);
}

/** 手写一段 payload 并签名，用来构造 createTicket 产不出来的非法输入。 */
function handcraftedTicket(payload: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return body + "." + signForTest(body);
}

describe("ticket：文档第 2 节的固定测试向量", () => {
	it("file/guest ticket 与文档逐字节一致", () => {
		const ticket = createTicket({ u: FILE_URL, e: EXPIRES, k: "file", t: "guest" }, SECRET);
		assert.equal(ticket, VECTOR_FILE_GUEST);
	});

	it("file/member ticket 与文档逐字节一致", () => {
		const ticket = createTicket({ u: FILE_URL, e: EXPIRES, k: "file", t: "member" }, SECRET);
		assert.equal(ticket, VECTOR_FILE_MEMBER);
	});

	it("git/guest ticket 与文档逐字节一致", () => {
		const ticket = createTicket({ u: GIT_URL, e: EXPIRES, k: "git", t: "guest" }, SECRET);
		assert.equal(ticket, VECTOR_GIT_GUEST);
	});

	it("git/member ticket 与文档逐字节一致", () => {
		const ticket = createTicket({ u: GIT_URL, e: EXPIRES, k: "git", t: "member" }, SECRET);
		assert.equal(ticket, VECTOR_GIT_MEMBER);
	});

	it("不传 t 时按游客签发", () => {
		const ticket = createTicket({ u: FILE_URL, e: EXPIRES, k: "file" }, SECRET);
		assert.equal(ticket, VECTOR_FILE_GUEST);
	});

	it("payload 就是签名 message 本身（base64url 无填充，字段顺序 u,e,k,t）", () => {
		assert.equal(VECTOR_FILE_GUEST.split(".")[0], VECTOR_FILE_GUEST_PAYLOAD);
		assert.equal(VECTOR_FILE_GUEST_PAYLOAD.includes("="), false);
		const decoded = Buffer.from(VECTOR_FILE_GUEST_PAYLOAD, "base64url").toString("utf8");
		assert.equal(decoded, JSON.stringify({ u: FILE_URL, e: EXPIRES, k: "file", t: "guest" }));
		const gitDecoded = Buffer.from(VECTOR_GIT_MEMBER_PAYLOAD, "base64url").toString("utf8");
		assert.equal(gitDecoded, JSON.stringify({ u: GIT_URL, e: EXPIRES, k: "git", t: "member" }));
	});
});

describe("ticket：旧格式与非法档位", () => {
	it("旧的无 t file ticket 仍然验签成功，档位归一化为游客", () => {
		const result = verifyTicket(LEGACY_FILE_TICKET, "file", SECRET, 1_700_000_000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.payload.t, "guest");
		assert.equal(result.payload.u, FILE_URL);
	});

	it("旧的无 t git ticket 仍然验签成功，档位归一化为游客", () => {
		const result = verifyTicket(LEGACY_GIT_TICKET, "git", SECRET, 1_700_000_000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.payload.t, "guest");
	});

	it("非法 t 归一化为游客，而不是让请求失败", () => {
		// 手工签名一段 t 非法的 payload：签名有效，只有档位不合法。
		const ticket = handcraftedTicket({ u: GIT_URL, e: EXPIRES, k: "git", t: "root" });
		const result = verifyTicket(ticket, "git", SECRET, 1_700_000_000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.payload.t, "guest");
	});

	it("t 为空字符串或数字时同样归一化为游客", () => {
		for (const illegal of ["", 1, null]) {
			const ticket = handcraftedTicket({ u: GIT_URL, e: EXPIRES, k: "git", t: illegal });
			const result = verifyTicket(ticket, "git", SECRET, 1_700_000_000);
			assert.equal(result.ok, true, "签名字合法就不该因为 t 被拒绝");
			if (!result.ok) continue;
			assert.equal(result.payload.t, "guest");
		}
	});
});

describe("ticket：校验", () => {
	it("往返校验通过并还原 payload", () => {
		const ticket = createTicket({ u: FILE_URL, e: EXPIRES, k: "file", t: "member" }, SECRET);
		const result = verifyTicket(ticket, "file", SECRET, 1_700_000_000);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.payload.u, FILE_URL);
		assert.equal(result.payload.e, EXPIRES);
		assert.equal(result.payload.k, "file");
		assert.equal(result.payload.t, "member");
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
