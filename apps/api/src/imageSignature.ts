import { open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export class ImageRejectedError extends Error {
	readonly statusCode = 400;

	constructor() {
		super("只接受 JPEG、PNG、GIF、WebP 或 AVIF 图片");
		this.name = "ImageRejectedError";
	}
}

/** 只认文件头，不认客户端声明的 Content-Type 或原始扩展名。 */
export function sniffImageMime(buffer: Buffer): string {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
	if (buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "GIF87a") return "image/gif";
	if (buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
		const brand = buffer.toString("ascii", 8, 12);
		if (brand === "avif" || brand === "avis") return "image/avif";
	}
	return "";
}

export function imageExtensionForMime(mime: string): string {
	switch (mime) {
		case "image/jpeg": return ".jpg";
		case "image/png": return ".png";
		case "image/gif": return ".gif";
		case "image/webp": return ".webp";
		case "image/avif": return ".avif";
		default: return "";
	}
}

/**
 * 读出文件头。不是图片就删掉；是图片就把扩展名改成和文件头一致，避免按 .html / .svg 被浏览器执行。
 */
export async function promoteStoredImage(filePath: string, filename: string): Promise<{ path: string; filename: string; mimeType: string }> {
	const handle = await open(filePath, "r");
	let mime = "";
	try {
		const header = Buffer.alloc(16);
		await handle.read(header, 0, header.length, 0);
		mime = sniffImageMime(header);
	} finally {
		await handle.close();
	}
	if (!mime) {
		await unlink(filePath).catch(() => undefined);
		throw new ImageRejectedError();
	}
	const extension = imageExtensionForMime(mime);
	const stem = filename.replace(/\.[^.]+$/u, "") || filename;
	const nextName = `${stem}${extension}`;
	if (nextName === filename) return { path: filePath, filename, mimeType: mime };
	const nextPath = resolve(dirname(filePath), nextName);
	await rename(filePath, nextPath);
	return { path: nextPath, filename: nextName, mimeType: mime };
}
