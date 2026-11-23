import { createHash, timingSafeEqual } from "node:crypto";

export type EmailCodeScope = "register" | "reset";

/** 找回密码和注册共用同一张验证码表，用用途前缀把两种验证码隔开。 */
export function commentEmailCodeDigest(code: string, scope: EmailCodeScope = "register") {
	const material = scope === "reset" ? `reset:${code.trim()}` : code.trim();
	return createHash("sha256").update(material).digest("hex");
}

export function emailCodeMatches(code: string, storedHash: string, scope: EmailCodeScope = "register") {
	const expected = commentEmailCodeDigest(code, scope);
	const actual = String(storedHash);
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
