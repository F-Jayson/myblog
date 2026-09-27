import { resolve, sep } from "node:path";

export const ADMIN_DRIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const STORAGE_NAME_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isDriveToken(token: string) {
	return TOKEN_PATTERN.test(token);
}

export function adminDriveFilePath(root: string, storageName: string) {
	if (!STORAGE_NAME_PATTERN.test(storageName)) return null;
	const directory = resolve(root);
	const full = resolve(directory, storageName);
	if (full !== directory + sep + storageName) return null;
	return full;
}

export function normalizeDriveFileName(raw: string) {
	const withoutNulls = raw.replace(/\0/g, "").trim();
	const slashesNormalized = withoutNulls.replace(/\\/g, "/");
	const base = slashesNormalized.split("/").filter(Boolean).pop()?.trim() ?? "";
	let decoded = base;
	if (base && !/[^\u0000-\u00ff]/u.test(base)) {
		const asUtf8 = Buffer.from(base, "latin1").toString("utf8");
		if (asUtf8 && !asUtf8.includes("\uFFFD")) decoded = asUtf8;
	}
	const cleaned = decoded.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
	return cleaned || "file";
}

export function safeDriveMimeType(value: string) {
	const mime = value.trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : "application/octet-stream";
}

export function contentDispositionAttachment(filename: string) {
	const safe = normalizeDriveFileName(filename);
	const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "download";
	const encoded = encodeURIComponent(safe).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function driveDownloadUrl(origin: string, token: string, filename: string) {
	const base = origin.replace(/\/+$/u, "");
	return `${base}/${token}/${encodeURIComponent(normalizeDriveFileName(filename))}`;
}

export type ByteRange = { start: number; end: number };

export function parseSingleByteRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
	if (!Number.isSafeInteger(size) || size < 0) return "unsatisfiable";
	const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
	if (!match) return null;
	const startText = match[1] ?? "";
	const endText = match[2] ?? "";
	if (!startText && !endText) return "unsatisfiable";
	if (size === 0) return "unsatisfiable";
	if (!startText) {
		const suffix = Number(endText);
		if (!Number.isInteger(suffix) || suffix <= 0) return "unsatisfiable";
		const length = Math.min(suffix, size);
		return { start: size - length, end: size - 1 };
	}
	const start = Number(startText);
	if (!Number.isInteger(start) || start < 0 || start >= size) return "unsatisfiable";
	const requestedEnd = endText ? Number(endText) : size - 1;
	if (!Number.isInteger(requestedEnd) || requestedEnd < start) return "unsatisfiable";
	return { start, end: Math.min(requestedEnd, size - 1) };
}

export function countsAsDriveDownload(method: string, rangeHeader: string | undefined, size: number) {
	if (method !== "GET") return false;
	if (!rangeHeader?.trim()) return true;
	const parsed = parseSingleByteRange(rangeHeader, size);
	if (parsed === null || parsed === "unsatisfiable") return false;
	return parsed.start === 0;
}
