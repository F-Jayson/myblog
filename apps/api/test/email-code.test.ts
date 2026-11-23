import assert from "node:assert/strict";
import test from "node:test";
import { commentEmailCodeDigest, emailCodeMatches } from "../src/emailCode.js";

test("password reset codes do not satisfy registration checks", () => {
	const code = "123456";
	const resetHash = commentEmailCodeDigest(code, "reset");
	assert.notEqual(resetHash, commentEmailCodeDigest(code, "register"));
	assert.equal(emailCodeMatches(code, resetHash, "reset"), true);
	assert.equal(emailCodeMatches(code, resetHash, "register"), false);
	assert.equal(emailCodeMatches("000000", resetHash, "reset"), false);
	assert.equal(emailCodeMatches(code, "too-short", "reset"), false);
});
