import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";

const uploadsDirectory = fileURLToPath(new URL("../../../uploads/", import.meta.url));
const userStorageUploadRoot = fileURLToPath(new URL("../../../uploads/user-space/", import.meta.url));

export interface StoredPublicFile {
	url: string;
	key: string;
	filename: string;
	size: number;
	mimeType: string;
}

let s3ClientInstance: S3Client | null = null;

export function isR2Configured(): boolean {
	const { driver, r2 } = config.storage;
	if (driver === "local") return false;
	if (driver === "r2") return true;
	// Auto-detect when driver is not explicitly local
	return Boolean(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucketName);
}

function getS3Client(): S3Client {
	if (!s3ClientInstance) {
		const endpoint = config.storage.r2.endpoint || (config.storage.r2.accountId ? `https://${config.storage.r2.accountId}.r2.cloudflarestorage.com` : "");
		s3ClientInstance = new S3Client({
			region: config.storage.r2.region || "auto",
			endpoint,
			credentials: {
				accessKeyId: config.storage.r2.accessKeyId,
				secretAccessKey: config.storage.r2.secretAccessKey,
			},
		});
	}
	return s3ClientInstance;
}

export function getR2PublicObjectUrl(key: string): string {
	const base = config.storage.r2.publicUrl.replace(/\/+$/u, "");
	const cleanKey = key.replace(/^\/+/u, "");
	if (base) {
		return `${base}/${cleanKey}`;
	}
	const endpoint = (config.storage.r2.endpoint || `https://${config.storage.r2.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/u, "");
	return `${endpoint}/${config.storage.r2.bucketName}/${cleanKey}`;
}

export function extractObjectKeyFromUrl(urlOrKey: string): string | null {
	const trimmed = urlOrKey.trim();
	if (!trimmed) return null;
	if (!/^https?:\/\//iu.test(trimmed)) {
		return trimmed.replace(/^\/+/u, "");
	}
	try {
		const parsed = new URL(trimmed);
		return parsed.pathname.replace(/^\/+/u, "");
	} catch {
		return null;
	}
}

/**
 * Upload a public media file (blog image, avatar, comment image, sticker, etc.)
 */
export async function savePublicFile(options: {
	filename: string;
	buffer?: Buffer;
	localPath?: string;
	mimeType?: string;
	folder?: string;
}): Promise<StoredPublicFile> {
	const folder = options.folder ?? "uploads";
	const key = `${folder}/${options.filename}`;
	const mimeType = options.mimeType || "application/octet-stream";

	if (isR2Configured()) {
		const data = options.buffer ?? (options.localPath ? await readFile(options.localPath) : null);
		if (!data) throw new Error("File content is required for storage");

		await getS3Client().send(new PutObjectCommand({
			Bucket: config.storage.r2.bucketName,
			Key: key,
			Body: data,
			ContentType: mimeType,
			CacheControl: "public, max-age=31536000, immutable",
		}));

		if (options.localPath && !config.storage.r2.keepLocalCopy) {
			await unlink(options.localPath).catch(() => undefined);
		}

		const publicUrl = getR2PublicObjectUrl(key);
		return {
			url: publicUrl,
			key,
			filename: options.filename,
			size: data.length,
			mimeType,
		};
	}

	// Local storage fallback
	let size = options.buffer?.length ?? 0;
	if (options.buffer && !options.localPath) {
		await mkdir(uploadsDirectory, { recursive: true });
		const targetPath = resolve(uploadsDirectory, options.filename);
		await writeFile(targetPath, options.buffer, { flag: "wx" });
		size = options.buffer.length;
	} else if (options.localPath && !size) {
		const fileStat = await stat(options.localPath).catch(() => null);
		size = fileStat?.size ?? 0;
	}

	const localUrl = `/api/uploads/${encodeURIComponent(options.filename)}`;
	return {
		url: localUrl,
		key: options.filename,
		filename: options.filename,
		size,
		mimeType,
	};
}

/**
 * Delete a public media file from R2 and/or local disk
 */
export async function deletePublicFile(urlOrKey: string): Promise<boolean> {
	const key = extractObjectKeyFromUrl(urlOrKey);
	let deleted = false;

	if (key && isR2Configured()) {
		try {
			await getS3Client().send(new DeleteObjectCommand({
				Bucket: config.storage.r2.bucketName,
				Key: key,
			}));
			deleted = true;
		} catch (error) {
			console.warn("[storage] R2 deleteObject failed:", error instanceof Error ? error.message : error);
		}
	}

	// Also clean up local file if it exists
	const localFilename = key ? basename(key) : basename(urlOrKey);
	if (localFilename && !localFilename.includes("/") && !localFilename.includes("\\")) {
		const localPath = resolve(uploadsDirectory, localFilename);
		await unlink(localPath).catch(() => undefined);
	}

	return deleted;
}

/**
 * Upload a user space file to R2 or local disk
 */
export async function saveUserSpaceFile(options: {
	filename: string;
	buffer?: Buffer;
	localPath?: string;
	mimeType?: string;
}): Promise<{ key: string; size: number }> {
	const key = `user-space/${options.filename}`;
	const mimeType = options.mimeType || "application/octet-stream";

	if (isR2Configured()) {
		const data = options.buffer ?? (options.localPath ? await readFile(options.localPath) : null);
		if (!data) throw new Error("File content is required for storage");

		await getS3Client().send(new PutObjectCommand({
			Bucket: config.storage.r2.bucketName,
			Key: key,
			Body: data,
			ContentType: mimeType,
			CacheControl: "private, max-age=60",
		}));

		if (options.localPath && !config.storage.r2.keepLocalCopy) {
			await unlink(options.localPath).catch(() => undefined);
		}

		return { key, size: data.length };
	}

	let size = options.buffer?.length ?? 0;
	if (options.buffer && !options.localPath) {
		await mkdir(userStorageUploadRoot, { recursive: true });
		const targetPath = resolve(userStorageUploadRoot, options.filename);
		await writeFile(targetPath, options.buffer, { flag: "wx" });
		size = options.buffer.length;
	} else if (options.localPath && !size) {
		const fileStat = await stat(options.localPath).catch(() => null);
		size = fileStat?.size ?? 0;
	}

	return { key: options.filename, size };
}

/**
 * Delete a user space file from R2 and/or local disk
 */
export async function deleteUserSpaceFile(storageKey: string): Promise<boolean> {
	if (!storageKey) return false;
	const key = `user-space/${basename(storageKey)}`;

	if (isR2Configured()) {
		try {
			await getS3Client().send(new DeleteObjectCommand({
				Bucket: config.storage.r2.bucketName,
				Key: key,
			}));
		} catch (error) {
			console.warn("[storage] R2 deleteUserSpaceFile failed:", error instanceof Error ? error.message : error);
		}
	}

	const localPath = resolve(userStorageUploadRoot, basename(storageKey));
	await unlink(localPath).catch(() => undefined);
	return true;
}

/**
 * Get readable stream for an object in R2 (or null if not found or not in R2)
 */
export async function getR2ObjectStream(key: string): Promise<Readable | null> {
	if (!isR2Configured()) return null;
	try {
		const response = await getS3Client().send(new GetObjectCommand({
			Bucket: config.storage.r2.bucketName,
			Key: key,
		}));
		if (response.Body && typeof (response.Body as Readable).pipe === "function") {
			return response.Body as Readable;
		}
		return null;
	} catch (error) {
		return null;
	}
}
