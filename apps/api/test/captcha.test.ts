import assert from "node:assert/strict";
import test from "node:test";
import { CAPTCHA_COOLDOWN_MS, CAPTCHA_TTL_MS, createCaptchaGate, generateCaptchaCode, renderCaptchaSvg } from "../src/captcha.js";

test("captcha codes are six mixed letters and digits without ambiguous characters", () => {
	for (let index = 0; index < 40; index += 1) {
		const code = generateCaptchaCode();
		assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
		assert.match(code, /[A-Z]/u);
		assert.match(code, /[0-9]/u);
	}
	const image = renderCaptchaSvg("A2B3C4");
	assert.match(image, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
	for (const char of "A2B3C4") assert.match(image, new RegExp(`>${char}<`));
});

test("captcha expires after 30 seconds and five wrong answers lock the address", () => {
	let now = 1_000_000;
	const gate = createCaptchaGate({ now: () => now, nextCode: () => "A2B3C4" });
	const issued = gate.issue("203.0.113.8");
	assert.equal(issued.ok, true);
	if (!issued.ok) return;

	now += CAPTCHA_TTL_MS + 1;
	const expired = gate.verify("203.0.113.8", issued.id, "A2B3C4");
	assert.equal(expired.ok, false);
	if (!expired.ok) assert.equal(expired.status, 400);

	for (let attempt = 1; attempt <= 4; attempt += 1) {
		const fresh = gate.issue("203.0.113.8");
		assert.equal(fresh.ok, true);
		if (!fresh.ok) return;
		const wrong = gate.verify("203.0.113.8", fresh.id, "ZZZZZ2");
		assert.equal(wrong.ok, false);
		if (!wrong.ok) assert.equal(wrong.remainingAttempts, 5 - attempt);
	}
	const last = gate.issue("203.0.113.8");
	assert.equal(last.ok, true);
	if (!last.ok) return;
	const locked = gate.verify("203.0.113.8", last.id, "ZZZZZ2");
	assert.equal(locked.ok, false);
	if (!locked.ok) {
		assert.equal(locked.status, 429);
		assert.equal(locked.retryAfterSeconds, CAPTCHA_COOLDOWN_MS / 1000);
	}
	assert.equal(gate.issue("203.0.113.8").ok, false);
	assert.equal(gate.verify("203.0.113.8", last.id, "A2B3C4").ok, false);
	assert.equal(gate.issue("203.0.113.9").ok, true);

	now += CAPTCHA_COOLDOWN_MS + 1;
	const after = gate.issue("203.0.113.8");
	assert.equal(after.ok, true);
	if (!after.ok) return;
	assert.equal(gate.verify("203.0.113.8", after.id, "a2b3c4").ok, true);
});

test("a correct captcha clears the consecutive failure count", () => {
	const gate = createCaptchaGate({ now: () => 5_000_000, nextCode: () => "K7M2P4" });
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const issued = gate.issue("198.51.100.4");
		assert.equal(issued.ok, true);
		if (!issued.ok) return;
		assert.equal(gate.verify("198.51.100.4", issued.id, "WRONG2").ok, false);
	}
	const passed = gate.issue("198.51.100.4");
	assert.equal(passed.ok, true);
	if (!passed.ok) return;
	assert.equal(gate.verify("198.51.100.4", passed.id, "K7M2P4").ok, true);
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const issued = gate.issue("198.51.100.4");
		assert.equal(issued.ok, true);
		if (!issued.ok) return;
		const wrong = gate.verify("198.51.100.4", issued.id, "WRONG2");
		assert.equal(wrong.ok, false);
		if (!wrong.ok) assert.equal(wrong.status, 400);
	}
});
