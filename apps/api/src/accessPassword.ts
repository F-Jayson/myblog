import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db.js";

export const ACCESS_PASSWORD_MIN = 4;
export const ACCESS_PASSWORD_MAX = 64;
export const ACCESS_PASSWORD_HINT_MAX = 40;
const ACCESS_PASSWORD_KEYLEN = 64;
const GRANT_TTL_MS = 30 * 60 * 1000;

export const STRICT_COOLDOWN_MAX_FAILURES = 3;
export const STRICT_COOLDOWN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

const grantSecret = randomBytes(32);
const recentAttempts = new Map<string, number[]>();

export class AccessPasswordError extends Error {
	statusCode: number;
	remainingAttempts?: number;
	cooldownSeconds?: number;
	lockedUntil?: number;
	constructor(message: string, statusCode = 400, details?: { remainingAttempts?: number; cooldownSeconds?: number; lockedUntil?: number }) {
		super(message);
		this.name = "AccessPasswordError";
		this.statusCode = statusCode;
		if (details) {
			this.remainingAttempts = details.remainingAttempts;
			this.cooldownSeconds = details.cooldownSeconds;
			this.lockedUntil = details.lockedUntil;
		}
	}
}

export function parseAccessPassword(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") throw new AccessPasswordError("访问密码无效");
	if (value.length > ACCESS_PASSWORD_MAX) throw new AccessPasswordError("访问密码不能超过 64 位");
	if (!value) return null;
	if (value.length < ACCESS_PASSWORD_MIN) throw new AccessPasswordError("访问密码至少 4 位");
	if (/[\u0000-\u001f\u007f]/u.test(value)) throw new AccessPasswordError("访问密码包含无效字符");
	return value;
}

export function parseAccessPasswordHint(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") throw new AccessPasswordError("密码提示无效");
	const hint = value.trim();
	if (!hint) return null;
	if (hint.length > ACCESS_PASSWORD_HINT_MAX) throw new AccessPasswordError("密码提示不能超过 40 字");
	if (/[\u0000-\u001f\u007f]/u.test(hint)) throw new AccessPasswordError("密码提示包含无效字符");
	return hint;
}

export function assertHintOmitsPassword(hint: string | null | undefined, password: string | null | undefined) {
	if (hint && password && hint.includes(password)) throw new AccessPasswordError("密码提示不能包含密码");
}

export function resolveAccessSecret(input: {
	accessPassword?: string | null;
	accessPasswordHint?: string | null;
	existingHash?: string | null;
	existingHint?: string | null;
}) {
	const existingHash = input.existingHash ? String(input.existingHash) : null;
	const existingHint = input.existingHint?.trim() || null;
	if (input.accessPassword === null || input.accessPassword === "") {
		if (input.accessPasswordHint) throw new AccessPasswordError("请先设置访问密码");
		return { passwordHash: null as string | null, hint: null as string | null };
	}
	const passwordHash = input.accessPassword === undefined ? existingHash : hashAccessPassword(input.accessPassword);
	const hint = input.accessPasswordHint === undefined ? existingHint : (input.accessPasswordHint?.trim() || null);
	if (hint && !passwordHash) throw new AccessPasswordError("请先设置访问密码");
	if (input.accessPassword) assertHintOmitsPassword(hint, input.accessPassword);
	return { passwordHash, hint: passwordHash ? hint : null };
}

export function readSubmittedAccessPassword(value: unknown) {
	if (typeof value !== "string" || value.length < 1 || value.length > ACCESS_PASSWORD_MAX) return "";
	return value;
}

export function hashAccessPassword(password: string, salt = randomBytes(16).toString("hex")) {
	const derived = scryptSync(password, salt, ACCESS_PASSWORD_KEYLEN).toString("hex");
	return `scrypt$${salt}$${derived}`;
}

export function verifyAccessPassword(password: string, encoded: string) {
	const [, salt, expectedHex] = encoded.split("$");
	if (!salt || !expectedHex || expectedHex.length % 2 !== 0) return false;
	try {
		const actual = scryptSync(password, salt, expectedHex.length / 2);
		const expected = Buffer.from(expectedHex, "hex");
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

type GrantPayload = { r: string; f: string; e: number };

function passwordFingerprint(passwordHash: string) {
	return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 22);
}

export function issueAccessGrant(resourceKey: string, passwordHash: string) {
	const payload: GrantPayload = { r: resourceKey, f: passwordFingerprint(passwordHash), e: Date.now() + GRANT_TTL_MS };
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signature = createHmac("sha256", grantSecret).update(body).digest("base64url");
	return `${body}.${signature}`;
}

export function readAccessGrant(token: string, resourceKey: string, passwordHash: string) {
	const separator = token.indexOf(".");
	if (separator < 1 || separator !== token.lastIndexOf(".")) return false;
	const body = token.slice(0, separator);
	const signature = token.slice(separator + 1);
	const expected = createHmac("sha256", grantSecret).update(body).digest("base64url");
	const actual = Buffer.from(signature);
	const wanted = Buffer.from(expected);
	if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
	let payload: GrantPayload;
	try {
		payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as GrantPayload;
	} catch {
		return false;
	}
	if (!payload || payload.r !== resourceKey || !Number.isFinite(payload.e) || payload.e < Date.now()) return false;
	const fingerprint = passwordFingerprint(passwordHash);
	const left = Buffer.from(String(payload.f ?? ""));
	const right = Buffer.from(fingerprint);
	return left.length === right.length && timingSafeEqual(left, right);
}

export function allowAccessAttempt(key: string, limit = 8, windowMs = 15 * 60 * 1000) {
	const now = Date.now();
	const hits = (recentAttempts.get(key) ?? []).filter((at) => now - at < windowMs);
	if (hits.length >= limit) {
		recentAttempts.set(key, hits);
		return false;
	}
	hits.push(now);
	recentAttempts.set(key, hits);
	if (recentAttempts.size > 5_000) {
		for (const [entry, times] of recentAttempts) {
			if (times.every((at) => now - at >= windowMs)) recentAttempts.delete(entry);
		}
	}
	return true;
}

export function driveAccessCookie(token: string, grant: string, secure: boolean) {
	const parts = [
		`ffa=${encodeURIComponent(grant)}`,
		"HttpOnly",
		"SameSite=Lax",
		`Path=/${token}/`,
		`Max-Age=${Math.floor(GRANT_TTL_MS / 1000)}`,
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

export function accessGrantsFromRequest(cookieHeader: string | undefined, headerGrant: string | undefined, queryGrant: string | undefined) {
	const grants: string[] = [];
	const header = headerGrant?.trim() ?? "";
	if (header) grants.push(header);
	const query = queryGrant?.trim() ?? "";
	if (query) grants.push(query);
	for (const part of (cookieHeader ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1) continue;
		const name = part.slice(0, separator).trim();
		if (name !== "ffa") continue;
		try {
			const value = decodeURIComponent(part.slice(separator + 1).trim());
			if (value) grants.push(value);
		} catch {
			/* ignore a malformed cookie */
		}
	}
	return grants;
}

// -------------------------------------------------------------
// Strict Multi-Vector Cooldown Engine (IP, Subnet, Fingerprint, DeviceId, UA)
// -------------------------------------------------------------

export type ClientIdentifierRecord = {
	type: "ip" | "subnet" | "fingerprint" | "deviceId" | "ua";
	value: string;
};

export function extractClientIp(req: { header: (name: string) => string | undefined; ip?: string; socket?: { remoteAddress?: string } }): string {
	const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
	return forwarded || req.ip || req.socket?.remoteAddress || "";
}

function calculateSubnet(ip: string): string {
	if (!ip) return "";
	if (ip.includes(".")) {
		const parts = ip.split(".");
		if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
	}
	if (ip.includes(":")) {
		const parts = ip.split(":");
		if (parts.length >= 3) return `${parts.slice(0, 3).join(":")}::/48`;
	}
	return ip;
}

function parseHeaderCookie(cookieHeader: string | undefined, name: string): string | null {
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) {
			try {
				return decodeURIComponent(part.slice(eq + 1).trim());
			} catch {
				return part.slice(eq + 1).trim();
			}
		}
	}
	return null;
}

export function extractClientIdentifiers(req: Request): ClientIdentifierRecord[] {
	const records: ClientIdentifierRecord[] = [];
	const ip = extractClientIp(req).trim().slice(0, 128);
	if (ip) {
		records.push({ type: "ip", value: ip });
		const subnet = calculateSubnet(ip);
		if (subnet && subnet !== ip) {
			records.push({ type: "subnet", value: subnet.slice(0, 128) });
		}
	}

	const bodyFp = typeof req.body === "object" && req.body && typeof req.body.fingerprint === "string" ? req.body.fingerprint : "";
	const fpHeader = (req.header("x-client-fingerprint") ?? bodyFp)?.trim();
	if (fpHeader && /^[A-Za-z0-9_-]{8,128}$/u.test(fpHeader)) {
		records.push({ type: "fingerprint", value: fpHeader });
	}

	const bodyDev = typeof req.body === "object" && req.body && typeof req.body.deviceId === "string" ? req.body.deviceId : "";
	const devHeader = (req.header("x-device-id") ?? parseHeaderCookie(req.header("cookie"), "blog_device_id") ?? bodyDev)?.trim();
	if (devHeader && /^[A-Za-z0-9_-]{8,128}$/u.test(devHeader)) {
		records.push({ type: "deviceId", value: devHeader });
	}

	const ua = (req.header("user-agent") ?? "").trim();
	const lang = (req.header("accept-language") ?? "").trim();
	if (ua || lang) {
		const uaHash = createHash("sha256").update(`${ua}#${lang}`).digest("hex").slice(0, 32);
		records.push({ type: "ua", value: uaHash });
	}

	return records;
}

export function formatCooldownTime(seconds: number): string {
	if (seconds <= 0) return "0秒";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}小时`);
	if (minutes > 0) parts.push(`${minutes}分钟`);
	if (secs > 0 && hours === 0) parts.push(`${secs}秒`);
	return parts.join("") || "1秒";
}

type MemoryCooldown = {
	failedCount: number;
	lockedUntil: number | null;
	lastFailedAt: number;
};

const memoryCooldownMap = new Map<string, MemoryCooldown>();

function memoryKey(targetKey: string, type: string, value: string) {
	return `${targetKey}##${type}:${value}`;
}

export type CooldownCheckResult = {
	allowed: boolean;
	remainingAttempts: number;
	lockedUntil?: number;
	cooldownSeconds?: number;
};

export async function checkAccessCooldown(targetKey: string, req: Request): Promise<CooldownCheckResult> {
	const identifiers = extractClientIdentifiers(req);
	if (!identifiers.length) return { allowed: true, remainingAttempts: STRICT_COOLDOWN_MAX_FAILURES };

	const now = Date.now();
	let maxFailures = 0;
	let maxLockedUntil: number | null = null;

	// Check memory cache
	for (const id of identifiers) {
		const key = memoryKey(targetKey, id.type, id.value);
		const cached = memoryCooldownMap.get(key);
		if (cached) {
			if (cached.lockedUntil && cached.lockedUntil > now) {
				maxLockedUntil = Math.max(maxLockedUntil ?? 0, cached.lockedUntil);
			} else if (now - cached.lastFailedAt < STRICT_COOLDOWN_DURATION_MS) {
				maxFailures = Math.max(maxFailures, cached.failedCount);
			}
		}
	}

	// Check DB persistence
	try {
		const values = identifiers.map((item) => item.value);
		const [rows] = await pool.query<RowDataPacket[]>(
			`SELECT identifier_type, identifier_value, failed_count, locked_until, last_failed_at
			 FROM access_cooldown_logs
			 WHERE target_key = ? AND identifier_value IN (?)`,
			[targetKey, values],
		);
		for (const row of rows) {
			const lockedTime = row.locked_until ? new Date(row.locked_until).getTime() : null;
			const lastFailed = row.last_failed_at ? new Date(row.last_failed_at).getTime() : 0;
			if (lockedTime && lockedTime > now) {
				maxLockedUntil = Math.max(maxLockedUntil ?? 0, lockedTime);
			} else if (now - lastFailed < STRICT_COOLDOWN_DURATION_MS) {
				maxFailures = Math.max(maxFailures, Number(row.failed_count || 0));
			}
		}
	} catch {
		// Ignore DB read failure; in-memory cache acts as fallback
	}

	if (maxLockedUntil && maxLockedUntil > now) {
		const cooldownSeconds = Math.max(1, Math.ceil((maxLockedUntil - now) / 1000));
		// Cross-bind lockout to all current identifiers in memory so changes to IP/device during lockout inherit the ban
		for (const id of identifiers) {
			memoryCooldownMap.set(memoryKey(targetKey, id.type, id.value), {
				failedCount: Math.max(3, maxFailures),
				lockedUntil: maxLockedUntil,
				lastFailedAt: now,
			});
		}
		return { allowed: false, remainingAttempts: 0, lockedUntil: maxLockedUntil, cooldownSeconds };
	}

	if (maxFailures >= STRICT_COOLDOWN_MAX_FAILURES) {
		const lockedUntil = now + STRICT_COOLDOWN_DURATION_MS;
		const cooldownSeconds = Math.ceil(STRICT_COOLDOWN_DURATION_MS / 1000);
		for (const id of identifiers) {
			memoryCooldownMap.set(memoryKey(targetKey, id.type, id.value), {
				failedCount: maxFailures,
				lockedUntil,
				lastFailedAt: now,
			});
		}
		return { allowed: false, remainingAttempts: 0, lockedUntil, cooldownSeconds };
	}

	return { allowed: true, remainingAttempts: Math.max(0, STRICT_COOLDOWN_MAX_FAILURES - maxFailures) };
}

export async function recordAccessFailure(targetKey: string, req: Request): Promise<{
	inCooldown: boolean;
	remainingAttempts: number;
	lockedUntil?: number;
	cooldownSeconds?: number;
}> {
	const identifiers = extractClientIdentifiers(req);
	const now = Date.now();
	let currentMaxFailures = 0;

	for (const id of identifiers) {
		const cached = memoryCooldownMap.get(memoryKey(targetKey, id.type, id.value));
		if (cached && now - cached.lastFailedAt < STRICT_COOLDOWN_DURATION_MS) {
			currentMaxFailures = Math.max(currentMaxFailures, cached.failedCount);
		}
	}

	try {
		if (identifiers.length) {
			const values = identifiers.map((item) => item.value);
			const [rows] = await pool.query<RowDataPacket[]>(
				`SELECT failed_count, last_failed_at FROM access_cooldown_logs WHERE target_key = ? AND identifier_value IN (?)`,
				[targetKey, values],
			);
			for (const row of rows) {
				const lastFailed = row.last_failed_at ? new Date(row.last_failed_at).getTime() : 0;
				if (now - lastFailed < STRICT_COOLDOWN_DURATION_MS) {
					currentMaxFailures = Math.max(currentMaxFailures, Number(row.failed_count || 0));
				}
			}
		}
	} catch {
		// Ignore DB error
	}

	const newCount = currentMaxFailures + 1;
	const enteredCooldown = newCount >= STRICT_COOLDOWN_MAX_FAILURES;
	const lockedUntil = enteredCooldown ? now + STRICT_COOLDOWN_DURATION_MS : null;
	const cooldownSeconds = enteredCooldown ? Math.ceil(STRICT_COOLDOWN_DURATION_MS / 1000) : undefined;

	for (const id of identifiers) {
		memoryCooldownMap.set(memoryKey(targetKey, id.type, id.value), {
			failedCount: newCount,
			lockedUntil,
			lastFailedAt: now,
		});
	}

	try {
		for (const id of identifiers) {
			if (lockedUntil) {
				await pool.execute(
					`INSERT INTO access_cooldown_logs (target_key, identifier_type, identifier_value, failed_count, locked_until, last_failed_at)
					 VALUES (?, ?, ?, ?, FROM_UNIXTIME(? / 1000), NOW())
					 ON DUPLICATE KEY UPDATE failed_count = VALUES(failed_count), locked_until = VALUES(locked_until), last_failed_at = NOW()`,
					[targetKey, id.type, id.value, newCount, lockedUntil],
				);
			} else {
				await pool.execute(
					`INSERT INTO access_cooldown_logs (target_key, identifier_type, identifier_value, failed_count, locked_until, last_failed_at)
					 VALUES (?, ?, ?, ?, NULL, NOW())
					 ON DUPLICATE KEY UPDATE failed_count = VALUES(failed_count), locked_until = NULL, last_failed_at = NOW()`,
					[targetKey, id.type, id.value, newCount],
				);
			}
		}
	} catch {
		// Ignore DB persistence error
	}

	return {
		inCooldown: enteredCooldown,
		remainingAttempts: Math.max(0, STRICT_COOLDOWN_MAX_FAILURES - newCount),
		lockedUntil: lockedUntil ?? undefined,
		cooldownSeconds,
	};
}

export async function recordAccessSuccess(targetKey: string, req: Request): Promise<void> {
	const identifiers = extractClientIdentifiers(req);
	for (const id of identifiers) {
		memoryCooldownMap.delete(memoryKey(targetKey, id.type, id.value));
	}
	try {
		if (identifiers.length) {
			const values = identifiers.map((item) => item.value);
			await pool.query(
				`DELETE FROM access_cooldown_logs WHERE target_key = ? AND identifier_value IN (?)`,
				[targetKey, values],
			);
		}
	} catch {
		// Ignore DB error
	}
}

export function clearCooldownForTest(targetKey: string): void {
	for (const key of memoryCooldownMap.keys()) {
		if (key.startsWith(`${targetKey}:`)) {
			memoryCooldownMap.delete(key);
		}
	}
}

export async function verifyAndApplyAccessPassword(
	targetKey: string,
	submittedPassword: unknown,
	expectedHash: string,
	req: Request,
): Promise<string> {
	const cooldownCheck = await checkAccessCooldown(targetKey, req);
	if (!cooldownCheck.allowed) {
		const durationText = formatCooldownTime(cooldownCheck.cooldownSeconds ?? 86400);
		throw new AccessPasswordError(
			`密码错误次数过多，已被限制访问 24 小时（剩余 ${durationText}）`,
			429,
			{ remainingAttempts: 0, cooldownSeconds: cooldownCheck.cooldownSeconds, lockedUntil: cooldownCheck.lockedUntil },
		);
	}

	const submitted = readSubmittedAccessPassword(submittedPassword);
	if (!submitted || !verifyAccessPassword(submitted, expectedHash)) {
		const failure = await recordAccessFailure(targetKey, req);
		if (failure.inCooldown) {
			const durationText = formatCooldownTime(failure.cooldownSeconds ?? 86400);
			throw new AccessPasswordError(
				`密码错误已达 3 次上限，进入 24 小时冷却期（剩余 ${durationText}）`,
				429,
				{ remainingAttempts: 0, cooldownSeconds: failure.cooldownSeconds, lockedUntil: failure.lockedUntil },
			);
		}
		throw new AccessPasswordError(
			`访问密码不正确，还剩 ${failure.remainingAttempts} 次尝试机会`,
			401,
			{ remainingAttempts: failure.remainingAttempts },
		);
	}

	await recordAccessSuccess(targetKey, req);
	return issueAccessGrant(targetKey, expectedHash);
}

function escapeHtmlText(value: string) {
	return value.replace(/[&<>"']/g, (char) => {
		if (char === "&") return "&amp;";
		if (char === "<") return "&lt;";
		if (char === ">") return "&gt;";
		if (char === "\"") return "&quot;";
		return "&#39;";
	});
}

export function drivePasswordPage(hint = "") {
	const placeholder = escapeHtmlText(hint.trim() || "访问密码");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>需要访问密码</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f7f4; color: #17332b; font: 16px/1.5 "Segoe UI", "PingFang SC", sans-serif; }
  form { width: min(92vw, 26rem); display: grid; gap: .8rem; padding: 1.4rem; border: 1px solid #d5e2da; border-radius: 1rem; background: #fff; }
  h1 { margin: 0; font-size: 1.25rem; }
  p { margin: 0; color: #5d726a; }
  input, button { font: inherit; padding: .7rem .8rem; border-radius: .6rem; }
  input { border: 1px solid #c9d8d1; }
  input::placeholder { color: #5d726a; opacity: 1; }
  button { border: 0; background: #1f8a70; color: #fff; font-weight: 700; cursor: pointer; }
  .error { min-height: 1.2em; color: #a33b32; }
</style>
</head>
<body>
  <form id="gate">
    <h1>此文件需要访问密码</h1>
    <p>只有输入正确的密码才能下载。密码错误达到3次将锁定24小时。</p>
    <input type="password" name="password" autocomplete="off" required maxlength="64" placeholder="${placeholder}" title="${placeholder}">
    <p class="error" id="error"></p>
    <button type="submit">打开文件</button>
  </form>
  <script>
    const form = document.getElementById("gate");
    const error = document.getElementById("error");
    const token = location.pathname.split("/").filter(Boolean)[0] || "";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      const password = new FormData(form).get("password");
      let response;
      try {
        response = await fetch("/" + encodeURIComponent(token) + "/unlock", {
          method: "POST",
          headers: { "content-type": "application/json", "accept": "application/json" },
          body: JSON.stringify({ password })
        });
      } catch {
        error.textContent = "网络错误，请稍后再试";
        return;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        error.textContent = (payload && payload.error) || "访问密码不正确";
        return;
      }
      location.replace(location.pathname);
    });
  </script>
</body>
</html>`;
}
