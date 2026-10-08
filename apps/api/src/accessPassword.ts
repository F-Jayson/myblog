import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const ACCESS_PASSWORD_MIN = 4;
export const ACCESS_PASSWORD_MAX = 64;
export const ACCESS_PASSWORD_HINT_MAX = 40;
const ACCESS_PASSWORD_KEYLEN = 64;
const GRANT_TTL_MS = 30 * 60 * 1000;

const grantSecret = randomBytes(32);
const recentAttempts = new Map<string, number[]>();

export class AccessPasswordError extends Error {
	statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.name = "AccessPasswordError";
		this.statusCode = statusCode;
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
    <p>只有输入正确的密码才能下载。密码错误时不会提供文件内容。</p>
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
