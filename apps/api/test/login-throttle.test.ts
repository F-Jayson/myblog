import assert from "node:assert/strict";
import test from "node:test";
import { LoginThrottle } from "../src/loginThrottle.js";

test("login throttle locks one account after repeated failures and still allows another account", () => {
	let now = 1_000_000;
	const throttle = new LoginThrottle(() => now);
	for (let attempt = 0; attempt < 8; attempt += 1) {
		assert.equal(throttle.check("user", "203.0.113.8", "alice").allowed, true);
		throttle.fail("user", "203.0.113.8", "alice");
	}
	const locked = throttle.check("user", "203.0.113.8", "alice");
	assert.equal(locked.allowed, false);
	if (!locked.allowed) assert.ok(locked.retryAfterSeconds > 0);
	assert.equal(throttle.check("user", "203.0.113.8", "bob").allowed, true);
});

test("login throttle forgets failures after the window and after a successful login", () => {
	let now = 5_000_000;
	const throttle = new LoginThrottle(() => now);
	for (let attempt = 0; attempt < 8; attempt += 1) throttle.fail("admin", "198.51.100.4", "root");
	assert.equal(throttle.check("admin", "198.51.100.4", "root").allowed, false);
	now += 15 * 60 * 1000 + 1;
	assert.equal(throttle.check("admin", "198.51.100.4", "root").allowed, true);

	throttle.fail("admin", "198.51.100.4", "root");
	throttle.succeed("admin", "198.51.100.4", "root");
	for (let attempt = 0; attempt < 7; attempt += 1) throttle.fail("admin", "198.51.100.4", "root");
	assert.equal(throttle.check("admin", "198.51.100.4", "root").allowed, true);
});

test("login throttle locks an address that sprays many accounts", () => {
	const throttle = new LoginThrottle(() => 9_000_000);
	for (let index = 0; index < 30; index += 1) throttle.fail("user", "192.0.2.9", `user-${index}`);
	assert.equal(throttle.check("user", "192.0.2.9", "fresh-account").allowed, false);
	assert.equal(throttle.check("admin", "192.0.2.9", "fresh-account").allowed, true);
});
