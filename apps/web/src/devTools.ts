export type Rgba = { r: number; g: number; b: number; a: number };

export const MAX_TOOL_FILE_BYTES = 2 * 1024 * 1024;

const NAMED_COLORS: Record<string, string> = {
	black: "#000000",
	white: "#ffffff",
	red: "#ff0000",
	green: "#008000",
	blue: "#0000ff",
	yellow: "#ffff00",
	orange: "#ffa500",
	purple: "#800080",
	gray: "#808080",
	grey: "#808080",
	cyan: "#00ffff",
	magenta: "#ff00ff",
	pink: "#ffc0cb",
	teal: "#008080",
	navy: "#000080",
	silver: "#c0c0c0",
	maroon: "#800000",
	lime: "#00ff00",
	aqua: "#00ffff",
	fuchsia: "#ff00ff",
	olive: "#808000",
	transparent: "#00000000",
};

const clampByte = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
const clampUnit = (value: number) => Math.min(1, Math.max(0, value));
const clampHue = (value: number) => ((value % 360) + 360) % 360;

function tidy(value: number, digits: number) {
	const factor = 10 ** digits;
	return String(Math.round(value * factor) / factor);
}

function channel(token: string) {
	const text = token.trim();
	if (!text) return null;
	if (text.endsWith("%")) {
		const value = Number(text.slice(0, -1));
		if (!Number.isFinite(value)) return null;
		return clampByte((value / 100) * 255);
	}
	const value = Number(text);
	if (!Number.isFinite(value)) return null;
	return clampByte(value);
}

function percent(token: string) {
	const text = token.trim();
	if (!text) return null;
	const hasPercent = text.endsWith("%");
	const value = Number(hasPercent ? text.slice(0, -1) : text);
	if (!Number.isFinite(value)) return null;
	const scaled = !hasPercent && Math.abs(value) <= 1 ? value * 100 : value;
	return Math.min(100, Math.max(0, scaled));
}

function alpha(token: string | undefined) {
	if (token == null || token.trim() === "") return 1;
	const text = token.trim();
	if (text.endsWith("%")) {
		const value = Number(text.slice(0, -1));
		if (!Number.isFinite(value)) return null;
		return clampUnit(value / 100);
	}
	const value = Number(text);
	if (!Number.isFinite(value) || value < 0 || value > 1) return null;
	return value;
}

function hue(token: string) {
	const match = /^(-?\d*\.?\d+)(deg|turn|rad)?$/i.exec(token.trim());
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;
	if (match[2]?.toLowerCase() === "turn") return clampHue(value * 360);
	if (match[2]?.toLowerCase() === "rad") return clampHue((value * 180) / Math.PI);
	return clampHue(value);
}

function hexByte(token: string) {
	const expanded = token.length === 1 ? token + token : token;
	const value = Number.parseInt(expanded, 16);
	return Number.isNaN(value) ? null : value;
}

function parseHex(input: string): Rgba | null {
	const hex = input.replace(/^#/, "");
	if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/i.test(hex)) return null;
	const size = hex.length <= 4 ? 1 : 2;
	const parts = hex.match(new RegExp(`.{${size}}`, "g"));
	if (!parts) return null;
	const [r, g, b, a] = parts.map(hexByte);
	if (r == null || g == null || b == null) return null;
	return { r, g, b, a: a == null ? 1 : a / 255 };
}

export function parseColor(input: string): Rgba | null {
	const text = input.trim();
	if (!text) return null;
	const named = NAMED_COLORS[text.toLowerCase()];
	if (named) return parseHex(named);
	if (text.startsWith("#") || /^[0-9a-f]{3,8}$/i.test(text)) return parseHex(text);
	const match = /^(rgb|rgba|hsl|hsla|hsv|hsva)\((.+)\)$/i.exec(text);
	if (!match) return null;
	const kind = match[1].toLowerCase();
	const [main, slashAlpha] = match[2].split("/");
	const pieces = main.includes(",") ? main.split(",") : main.trim().split(/\s+/);
	const values = pieces.map((item) => item.trim()).filter(Boolean);
	let alphaToken = slashAlpha;
	let channels = values;
	if (alphaToken == null && values.length === 4) {
		alphaToken = values[3];
		channels = values.slice(0, 3);
	}
	if (channels.length !== 3) return null;
	const a = alpha(alphaToken);
	if (a == null) return null;
	if (kind.startsWith("rgb")) {
		const [r, g, b] = channels.map(channel);
		if (r == null || g == null || b == null) return null;
		return { r, g, b, a };
	}
	const h = hue(channels[0]);
	const s = percent(channels[1]);
	const third = percent(channels[2]);
	if (h == null || s == null || third == null) return null;
	const rgb = kind.startsWith("hsv") ? hsvToRgb(h, s, third) : hslToRgb(h, s, third);
	return { ...rgb, a };
}

export function rgbToHsl(color: Rgba) {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	const lightness = (max + min) / 2;
	let hueValue = 0;
	let saturation = 0;
	if (delta !== 0) {
		saturation = delta / (1 - Math.abs(2 * lightness - 1));
		if (max === r) hueValue = ((g - b) / delta) % 6;
		else if (max === g) hueValue = (b - r) / delta + 2;
		else hueValue = (r - g) / delta + 4;
		hueValue *= 60;
		if (hueValue < 0) hueValue += 360;
	}
	return { h: hueValue, s: saturation * 100, l: lightness * 100 };
}

export function rgbToHsv(color: Rgba) {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	let hueValue = 0;
	if (delta !== 0) {
		if (max === r) hueValue = ((g - b) / delta) % 6;
		else if (max === g) hueValue = (b - r) / delta + 2;
		else hueValue = (r - g) / delta + 4;
		hueValue *= 60;
		if (hueValue < 0) hueValue += 360;
	}
	return { h: hueValue, s: max === 0 ? 0 : (delta / max) * 100, v: max * 100 };
}

export function hslToRgb(h: number, s: number, l: number) {
	const saturation = s / 100;
	const lightness = l / 100;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const hp = h / 60;
	const x = chroma * (1 - Math.abs((hp % 2) - 1));
	const m = lightness - chroma / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [chroma, x, 0];
	else if (hp < 2) [r, g, b] = [x, chroma, 0];
	else if (hp < 3) [r, g, b] = [0, chroma, x];
	else if (hp < 4) [r, g, b] = [0, x, chroma];
	else if (hp < 5) [r, g, b] = [x, 0, chroma];
	else [r, g, b] = [chroma, 0, x];
	return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

export function hsvToRgb(h: number, s: number, v: number) {
	const saturation = s / 100;
	const value = v / 100;
	const chroma = value * saturation;
	const hp = h / 60;
	const x = chroma * (1 - Math.abs((hp % 2) - 1));
	const m = value - chroma;
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [chroma, x, 0];
	else if (hp < 2) [r, g, b] = [x, chroma, 0];
	else if (hp < 3) [r, g, b] = [0, chroma, x];
	else if (hp < 4) [r, g, b] = [0, x, chroma];
	else if (hp < 5) [r, g, b] = [x, 0, chroma];
	else [r, g, b] = [chroma, 0, x];
	return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

export function formatHex(color: Rgba) {
	const body = [color.r, color.g, color.b].map((value) => clampByte(value).toString(16).padStart(2, "0")).join("");
	if (color.a >= 0.999) return `#${body}`;
	const alphaByte = clampByte(clampUnit(color.a) * 255).toString(16).padStart(2, "0");
	return `#${body}${alphaByte}`;
}

export function formatRgb(color: Rgba) {
	const body = `${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}`;
	if (color.a >= 0.999) return `rgb(${body})`;
	return `rgba(${body}, ${tidy(clampUnit(color.a), 3)})`;
}

export function formatHsl(color: Rgba) {
	const { h, s, l } = rgbToHsl(color);
	const body = `${tidy(h, 1)}, ${tidy(s, 1)}%, ${tidy(l, 1)}%`;
	if (color.a >= 0.999) return `hsl(${body})`;
	return `hsla(${body}, ${tidy(clampUnit(color.a), 3)})`;
}

export function formatHsv(color: Rgba) {
	const { h, s, v } = rgbToHsv(color);
	const body = `${tidy(h, 1)}, ${tidy(s, 1)}%, ${tidy(v, 1)}%`;
	if (color.a >= 0.999) return `hsv(${body})`;
	return `hsva(${body}, ${tidy(clampUnit(color.a), 3)})`;
}

export function opaqueHex(color: Rgba) {
	return formatHex({ ...color, a: 1 });
}

export function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

export function normalizeBase64(value: string) {
	const stripped = value
		.trim()
		.replace(/^data:[^,]*;base64,/i, "")
		.replace(/\s+/g, "")
		.replace(/-/g, "+")
		.replace(/_/g, "/");
	if (!stripped) return "";
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) throw new Error("不是有效的 Base64");
	const pad = stripped.length % 4;
	if (pad === 1) throw new Error("不是有效的 Base64");
	return pad === 0 ? stripped : stripped + "=".repeat(4 - pad);
}

export function decodeBase64Bytes(value: string) {
	const normalized = normalizeBase64(value);
	if (!normalized) return new Uint8Array();
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function decodeUtf8(bytes: Uint8Array) {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeBase64(text: string) {
	return bytesToBase64(new TextEncoder().encode(text));
}

export function toBase64Url(value: string) {
	return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64(value: string) {
	try {
		return decodeUtf8(decodeBase64Bytes(value));
	} catch (error) {
		if (error instanceof Error && error.message === "不是有效的 Base64") throw error;
		throw new Error("这段 Base64 不是 UTF-8 文本");
	}
}

export function encodeUrl(value: string, preserveUrl = false) {
	return preserveUrl ? encodeURI(value) : encodeURIComponent(value);
}

export function decodeUrl(value: string, plusAsSpace = false) {
	const text = plusAsSpace ? value.replace(/\+/g, " ") : value;
	try {
		return decodeURIComponent(text);
	} catch {
		throw new Error("不是有效的 URL 编码");
	}
}

export function formatJson(value: string, space: number) {
	return JSON.stringify(JSON.parse(value), null, space > 0 ? space : undefined);
}

export function parseTimestamp(value: string) {
	const text = value.trim();
	if (!text) return null;
	if (/^-?\d+$/.test(text)) {
		const raw = Number(text);
		if (!Number.isSafeInteger(raw)) return null;
		const digits = text.replace("-", "");
		const ms = digits.length >= 13 ? raw : raw * 1000;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(date: Date) {
	return {
		seconds: String(Math.floor(date.getTime() / 1000)),
		milliseconds: String(date.getTime()),
		iso: date.toISOString(),
		local: new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeStyle: "medium" }).format(date),
		utc: date.toUTCString(),
	};
}

export function toDatetimeLocal(date: Date) {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type HashAlgorithm = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export async function digestHex(algorithm: HashAlgorithm, text: string) {
	const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createUuid() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const RADIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function convertRadix(value: string, from: number, to: number) {
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 2 || from > 36 || to < 2 || to > 36) {
		throw new Error("进制需要在 2 到 36 之间");
	}
	let body = value.trim().toLowerCase().replace(/_/g, "");
	if (!body) return "";
	let negative = false;
	if (body.startsWith("-")) {
		negative = true;
		body = body.slice(1);
	} else if (body.startsWith("+")) body = body.slice(1);
	if (from === 16 && body.startsWith("0x")) body = body.slice(2);
	if (from === 2 && body.startsWith("0b")) body = body.slice(2);
	if (from === 8 && body.startsWith("0o")) body = body.slice(2);
	if (!body) throw new Error("请输入数字");
	let result = 0n;
	const source = BigInt(from);
	for (const digit of body) {
		const index = RADIX_ALPHABET.indexOf(digit);
		if (index < 0 || index >= from) throw new Error(`“${digit}” 不属于 ${from} 进制`);
		result = result * source + BigInt(index);
	}
	if (result === 0n) return "0";
	const out: string[] = [];
	const target = BigInt(to);
	while (result > 0n) {
		out.push(RADIX_ALPHABET[Number(result % target)]);
		result /= target;
	}
	return (negative ? "-" : "") + out.reverse().join("");
}

export type JwtView = {
	header: string;
	payload: string;
	signaturePresent: boolean;
	claims: string;
};

export function decodeJwt(token: string): JwtView {
	const parts = token.trim().split(".");
	if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) throw new Error("JWT 需要用点分成两段或三段");
	const headerText = decodeBase64(parts[0]);
	const payloadText = decodeBase64(parts[1]);
	let claims = "";
	try {
		const payload = JSON.parse(payloadText) as Record<string, unknown>;
		claims = ["iat", "nbf", "exp"].flatMap((key) => {
			const value = payload[key];
			if (typeof value !== "number") return [];
			const date = new Date(value * 1000);
			if (Number.isNaN(date.getTime())) return [];
			return [`${key}: ${date.toISOString()}`];
		}).join("  ·  ");
	} catch {
		claims = "";
	}
	const pretty = (text: string) => {
		try { return JSON.stringify(JSON.parse(text), null, 2); }
		catch { return text; }
	};
	return {
		header: pretty(headerText),
		payload: pretty(payloadText),
		signaturePresent: parts.length === 3 && parts[2].length > 0,
		claims,
	};
}

export function textStats(value: string) {
	const chars = [...value].length;
	const charsNoSpace = [...value.replace(/\s/gu, "")].length;
	const lines = value === "" ? 0 : value.split(/\r\n|\r|\n/u).length;
	const words = value.trim() ? value.trim().split(/\s+/u).length : 0;
	const bytes = new TextEncoder().encode(value).length;
	return { chars, charsNoSpace, lines, words, bytes };
}

export type CaseMode = "upper" | "lower" | "title" | "camel" | "pascal" | "snake" | "kebab" | "constant";

function splitWords(value: string) {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9\u4e00-\u9fff]+/u)
		.filter(Boolean);
}

function capitalize(word: string) {
	return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : "";
}

export function convertCase(value: string, mode: CaseMode) {
	if (mode === "upper") return value.toUpperCase();
	if (mode === "lower") return value.toLowerCase();
	const words = splitWords(value);
	if (mode === "title") return words.map(capitalize).join(" ");
	if (mode === "camel") return words.map((word, index) => index === 0 ? word.toLowerCase() : capitalize(word)).join("");
	if (mode === "pascal") return words.map(capitalize).join("");
	if (mode === "snake") return words.map((word) => word.toLowerCase()).join("_");
	if (mode === "kebab") return words.map((word) => word.toLowerCase()).join("-");
	return words.map((word) => word.toUpperCase()).join("_");
}

const HTML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

export function escapeHtml(value: string) {
	return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

export function unescapeHtml(value: string) {
	return value
		.replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
		.replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
		.replace(/&quot;/g, "\"")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
