import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const CAPTCHA_TTL_MS = 30_000;
export const CAPTCHA_LENGTH = 6;
export const CAPTCHA_MAX_FAILURES = 5;
/** 与登录失败锁定同一窗口：连续错满 5 次后 15 分钟内不能再验证，也不能发邮箱验证码。 */
export const CAPTCHA_COOLDOWN_MS = 15 * 60 * 1000;

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const ALPHABET = LETTERS + DIGITS;

export type CaptchaIssue =
	| { ok: true; id: string; image: string; expiresInSeconds: number }
	| { ok: false; error: string; retryAfterSeconds: number };

export type CaptchaVerify =
	| { ok: true }
	| { ok: false; status: 400 | 429; error: string; retryAfterSeconds?: number; remainingAttempts?: number };

type Challenge = { codeHash: string; expiresAt: number; ip: string };
type Strike = { failures: number; lockedUntil: number };

function digest(code: string) {
	return createHash("sha256").update(code).digest("hex");
}

function hashesMatch(actual: string, expected: string) {
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function normalizeCaptchaCode(code: string) {
	return code.trim().replace(/\s+/gu, "").toUpperCase();
}

export function generateCaptchaCode(nextInt: (max: number) => number = (max) => randomInt(max)) {
	const chars = [LETTERS[nextInt(LETTERS.length)] ?? "A", DIGITS[nextInt(DIGITS.length)] ?? "2"];
	while (chars.length < CAPTCHA_LENGTH) chars.push(ALPHABET[nextInt(ALPHABET.length)] ?? "A");
	for (let index = chars.length - 1; index > 0; index -= 1) {
		const swap = nextInt(index + 1);
		const current = chars[index] ?? "A";
		chars[index] = chars[swap] ?? "A";
		chars[swap] = current;
	}
	return chars.join("");
}

function formatWait(seconds: number) {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes <= 0) return `${Math.max(1, rest)} 秒`;
	if (rest === 0) return `${minutes} 分钟`;
	return `${minutes} 分 ${rest} 秒`;
}

export function renderCaptchaSvg(code: string) {
	const width = 168;
	const height = 52;
	const palette = ["#1d4e89", "#0f6b4c", "#8a3d2f", "#3d348b", "#245c4a"];
	const noise: string[] = [];
	for (let index = 0; index < 5; index += 1) {
		const color = palette[randomInt(palette.length)] ?? "#1d4e89";
		noise.push(`<line x1="${randomInt(width)}" y1="${randomInt(height)}" x2="${randomInt(width)}" y2="${randomInt(height)}" stroke="${color}" stroke-width="1" opacity="0.35"/>`);
	}
	for (let index = 0; index < 16; index += 1) {
		noise.push(`<circle cx="${randomInt(width)}" cy="${randomInt(height)}" r="1" fill="#8aa099" opacity="0.7"/>`);
	}
	const letters = code.split("").map((char, index) => {
		const x = 14 + index * 25;
		const y = 34 + randomInt(9) - 4;
		const rotate = randomInt(31) - 15;
		const color = palette[randomInt(palette.length)] ?? "#1d4e89";
		return `<text x="${x}" y="${y}" fill="${color}" font-size="24" font-family="Consolas, ui-monospace, monospace" font-weight="700" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="6" fill="#f4f7f5"/>${noise.join("")}<path d="M2 28 C 40 12, 90 44, 166 24" fill="none" stroke="#9bb0a8" stroke-width="1.4"/>${letters}</svg>`;
}

function captchaImage(code: string) {
	return `data:image/svg+xml;base64,${Buffer.from(renderCaptchaSvg(code)).toString("base64")}`;
}

export function createCaptchaGate(options?: { now?: () => number; nextCode?: () => string }) {
	const now = options?.now ?? Date.now;
	const nextCode = options?.nextCode ?? (() => generateCaptchaCode());
	const challenges = new Map<string, Challenge>();
	const strikes = new Map<string, Strike>();

	const sweep = (current: number) => {
		for (const [id, challenge] of challenges) {
			if (challenge.expiresAt <= current) challenges.delete(id);
		}
		for (const [ip, strike] of strikes) {
			if (strike.lockedUntil <= current && strike.failures === 0) strikes.delete(ip);
		}
	};

	const lockLeft = (ip: string, current: number) => {
		const strike = strikes.get(ip);
		if (!strike || strike.lockedUntil <= current) return 0;
		return Math.max(1, Math.ceil((strike.lockedUntil - current) / 1000));
	};

	const issue = (ip: string): CaptchaIssue => {
		const current = now();
		const normalizedIp = ip.trim() || "unknown";
		if (challenges.size + strikes.size > 4096) sweep(current);
		const retryAfterSeconds = lockLeft(normalizedIp, current);
		if (retryAfterSeconds > 0) {
			return { ok: false, error: `图形验证码已锁定，请 ${formatWait(retryAfterSeconds)} 后再试`, retryAfterSeconds };
		}
		const code = nextCode();
		const id = randomBytes(16).toString("base64url");
		challenges.set(id, { codeHash: digest(normalizeCaptchaCode(code)), expiresAt: current + CAPTCHA_TTL_MS, ip: normalizedIp });
		return { ok: true, id, image: captchaImage(code), expiresInSeconds: CAPTCHA_TTL_MS / 1000 };
	};

	const verify = (ip: string, id: string, code: string): CaptchaVerify => {
		const current = now();
		const normalizedIp = ip.trim() || "unknown";
		const retryAfterSeconds = lockLeft(normalizedIp, current);
		if (retryAfterSeconds > 0) {
			return { ok: false, status: 429, error: `图形验证码已锁定，请 ${formatWait(retryAfterSeconds)} 后再试`, retryAfterSeconds };
		}
		const normalizedCode = normalizeCaptchaCode(code);
		const challengeId = id.trim();
		if (!challengeId || !normalizedCode) return { ok: false, status: 400, error: "请填写图形验证码" };
		const challenge = challenges.get(challengeId);
		if (!challenge || challenge.expiresAt <= current || challenge.ip !== normalizedIp) {
			if (challenge && challenge.ip === normalizedIp && challenge.expiresAt <= current) challenges.delete(challengeId);
			return { ok: false, status: 400, error: "图形验证码已过期，请点击图片刷新" };
		}
		if (!hashesMatch(digest(normalizedCode), challenge.codeHash)) {
			challenges.delete(challengeId);
			const strike = strikes.get(normalizedIp) ?? { failures: 0, lockedUntil: 0 };
			strike.failures += 1;
			if (strike.failures >= CAPTCHA_MAX_FAILURES) {
				strike.failures = 0;
				strike.lockedUntil = current + CAPTCHA_COOLDOWN_MS;
				strikes.set(normalizedIp, strike);
				const lockedFor = Math.ceil(CAPTCHA_COOLDOWN_MS / 1000);
				return { ok: false, status: 429, error: `图形验证码连续错误 5 次，请 ${formatWait(lockedFor)} 后再试`, retryAfterSeconds: lockedFor, remainingAttempts: 0 };
			}
			strikes.set(normalizedIp, strike);
			const remainingAttempts = CAPTCHA_MAX_FAILURES - strike.failures;
			return { ok: false, status: 400, error: `图形验证码错误，还可再试 ${remainingAttempts} 次`, remainingAttempts };
		}
		challenges.delete(challengeId);
		const strike = strikes.get(normalizedIp);
		if (strike) {
			strike.failures = 0;
			if (strike.lockedUntil <= current) strikes.delete(normalizedIp);
		}
		return { ok: true };
	};

	return { issue, verify };
}

export const emailCaptcha = createCaptchaGate();
