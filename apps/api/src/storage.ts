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

export function isWorkerAvailable(): boolean {
	const { worker } = config.storage;
	return Boolean(worker.url && worker.token);
}

export function isR2Available(): boolean {
	const { r2 } = config.storage;
	return Boolean(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucketName);
}

export function isCloudflareAvailable(): boolean {
	return isWorkerAvailable() || isR2Available();
}

export function isWorkerConfigured(): boolean {
	const { driver, worker } = config.storage;
	if (driver === "worker") return Boolean(worker.url && worker.token);
	return driver !== "local" && driver !== "r2" && Boolean(worker.url && worker.token);
}

export function isR2Configured(): boolean {
	const { driver, r2 } = config.storage;
	if (driver === "local" || driver === "worker") return false;
	if (driver === "r2") return true;
	// Auto-detect when driver is not explicitly local or worker
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
	if (isWorkerConfigured()) {
		return `${config.storage.worker.url}/${key.replace(/^\/+/u, "")}`;
	}
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

	// 1. Worker Storage Driver
	if (isWorkerConfigured()) {
		const data = options.buffer ?? (options.localPath ? await readFile(options.localPath) : null);
		if (!data) throw new Error("File content is required for storage");

		const targetUrl = `${config.storage.worker.url}/${key}`;
		const response = await fetch(targetUrl, {
			method: "PUT",
			headers: {
				"Authorization": `Bearer ${config.storage.worker.token}`,
				"Content-Type": mimeType,
			},
			body: new Uint8Array(data),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Worker storage upload failed (${response.status}): ${errText || response.statusText}`);
		}

		if (options.localPath && !config.storage.worker.keepLocalCopy) {
			await unlink(options.localPath).catch(() => undefined);
		}

		return {
			url: targetUrl,
			key,
			filename: options.filename,
			size: data.length,
			mimeType,
		};
	}

	// 2. Direct R2 (S3 API) Driver
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

	// 3. Local storage fallback
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
 * Delete a public media file from Worker, R2 and/or local disk
 */
export async function deletePublicFile(urlOrKey: string): Promise<boolean> {
	const key = extractObjectKeyFromUrl(urlOrKey);
	let deleted = false;

	if (key && isWorkerConfigured()) {
		try {
			await fetch(`${config.storage.worker.url}/${key}`, {
				method: "DELETE",
				headers: {
					"Authorization": `Bearer ${config.storage.worker.token}`,
				},
			});
			deleted = true;
		} catch (error) {
			console.warn("[storage] Worker deleteObject failed:", error instanceof Error ? error.message : error);
		}
	} else if (key && isR2Configured()) {
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
 * Resolve the local disk path for a user-space object. Storage keys are flat,
 * unique file names; keys containing a separator or traversal are rejected.
 */
export function userSpaceLocalPath(storageKey: string): string | null {
	const name = basename(storageKey);
	if (!name || name !== storageKey || name.includes("\\") || name === "." || name === "..") return null;
	return resolve(userStorageUploadRoot, name);
}

/**
 * Upload a user space file to Worker, R2 or local disk
 */
export async function saveUserSpaceFile(options: {
	filename: string;
	buffer?: Buffer;
	localPath?: string;
	mimeType?: string;
	targetStorage?: "server" | "cloudflare";
}): Promise<{ key: string; size: number; url?: string }> {
	const key = `user-space/${options.filename}`;
	const mimeType = options.mimeType || "application/octet-stream";
	const useCloudflare = options.targetStorage === "cloudflare"
		|| (options.targetStorage === undefined && (isWorkerConfigured() || isR2Configured()));

	if (useCloudflare && isWorkerAvailable()) {
		const data = options.buffer ?? (options.localPath ? await readFile(options.localPath) : null);
		if (!data) throw new Error("File content is required for storage");

		const targetUrl = `${config.storage.worker.url}/${key}`;
		const response = await fetch(targetUrl, {
			method: "PUT",
			headers: {
				"Authorization": `Bearer ${config.storage.worker.token}`,
				"Content-Type": mimeType,
			},
			body: new Uint8Array(data),
		});

		if (!response.ok) {
			throw new Error(`Worker user space upload failed with status ${response.status}`);
		}

		if (options.localPath) {
			await unlink(options.localPath).catch(() => undefined);
		}

		return { key: options.filename, size: data.length, url: targetUrl };
	}

	if (useCloudflare && isR2Available()) {
		const data = options.buffer ?? (options.localPath ? await readFile(options.localPath) : null);
		if (!data) throw new Error("File content is required for storage");

		await getS3Client().send(new PutObjectCommand({
			Bucket: config.storage.r2.bucketName,
			Key: key,
			Body: data,
			ContentType: mimeType,
			CacheControl: "private, max-age=60",
		}));

		if (options.localPath) {
			await unlink(options.localPath).catch(() => undefined);
		}

		const publicUrl = getR2PublicObjectUrl(key);
		return { key: options.filename, size: data.length, url: publicUrl };
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

	return { key: options.filename, size, url: `/api/user/storage/file/${encodeURIComponent(options.filename)}` };
}

/**
 * Delete a user space file from Worker, R2 and/or local disk
 */
export async function deleteUserSpaceFile(storageKey: string, targetStorage?: "server" | "cloudflare"): Promise<boolean> {
	if (!storageKey) return false;
	const key = `user-space/${basename(storageKey)}`;
	let deleted = false;

	if ((targetStorage === "cloudflare" || targetStorage === undefined) && isWorkerAvailable()) {
		try {
			await fetch(`${config.storage.worker.url}/${key}`, {
				method: "DELETE",
				headers: {
					"Authorization": `Bearer ${config.storage.worker.token}`,
				},
			});
			deleted = true;
		} catch (error) {
			console.warn("[storage] Worker deleteUserSpaceFile failed:", error instanceof Error ? error.message : error);
		}
	} else if ((targetStorage === "cloudflare" || targetStorage === undefined) && isR2Available()) {
		try {
			await getS3Client().send(new DeleteObjectCommand({
				Bucket: config.storage.r2.bucketName,
				Key: key,
			}));
			deleted = true;
		} catch (error) {
			console.warn("[storage] R2 deleteUserSpaceFile failed:", error instanceof Error ? error.message : error);
		}
	}

	if (targetStorage === "server" || targetStorage === undefined || !deleted) {
		const localPath = resolve(userStorageUploadRoot, basename(storageKey));
		await unlink(localPath).catch(() => undefined);
		deleted = true;
	}

	return deleted;
}

/**
 * Migrate a user space file between Server local storage and Cloudflare object storage
 */
export async function migrateUserFile(
	storageKey: string,
	from: "server" | "cloudflare",
	to: "server" | "cloudflare"
): Promise<{ success: boolean; byteSize: number }> {
	if (from === to) return { success: true, byteSize: 0 };
	const key = `user-space/${basename(storageKey)}`;
	const localPath = resolve(userStorageUploadRoot, basename(storageKey));

	if (from === "server" && to === "cloudflare") {
		// Read local file
		let data: Buffer;
		try {
			data = await readFile(localPath);
		} catch (err: any) {
			if (err?.code === "ENOENT") {
				console.warn(`[Storage Migration] Local file not found: ${localPath}`);
				return { success: true, byteSize: 0 };
			}
			throw err;
		}

		if (isWorkerAvailable()) {
			const targetUrl = `${config.storage.worker.url}/${key}`;
			const response = await fetch(targetUrl, {
				method: "PUT",
				headers: {
					"Authorization": `Bearer ${config.storage.worker.token}`,
					"Content-Type": "application/octet-stream",
				},
				body: new Uint8Array(data),
			});
			if (!response.ok) {
				throw new Error(`Worker upload failed: ${response.status} ${response.statusText}`);
			}
		} else if (isR2Available()) {
			await getS3Client().send(new PutObjectCommand({
				Bucket: config.storage.r2.bucketName,
				Key: key,
				Body: data,
				ContentType: "application/octet-stream",
			}));
		} else {
			throw new Error("Cloudflare 存储未配置，无法迁移到云端");
		}
		// Unlink local copy after upload succeeded
		await unlink(localPath).catch(() => undefined);
		return { success: true, byteSize: data.length };
	}

	if (from === "cloudflare" && to === "server") {
		let data: Buffer | null = null;
		if (isWorkerAvailable()) {
			const targetUrl = `${config.storage.worker.url}/${key}`;
			const response = await fetch(targetUrl, {
				headers: {
					"Authorization": `Bearer ${config.storage.worker.token}`,
				},
			});
			if (response.status === 404) {
				console.warn(`[Storage Migration] File not found on Worker: ${key}`);
				return { success: true, byteSize: 0 };
			}
			if (!response.ok) {
				throw new Error(`Worker download failed: ${response.status} ${response.statusText}`);
			}
			const arr = await response.arrayBuffer();
			data = Buffer.from(arr);
		} else if (isR2Available()) {
			try {
				const response = await getS3Client().send(new GetObjectCommand({
					Bucket: config.storage.r2.bucketName,
					Key: key,
				}));
				if (response.Body) {
					const chunks: Buffer[] = [];
					for await (const chunk of response.Body as any) {
						chunks.push(Buffer.from(chunk));
					}
					data = Buffer.concat(chunks);
				}
			} catch (err: any) {
				if (err?.name === "NoSuchKey") {
					console.warn(`[Storage Migration] File not found on R2: ${key}`);
					return { success: true, byteSize: 0 };
				}
				throw err;
			}
		}
		if (!data) {
			console.warn(`[Storage Migration] Could not retrieve file data for ${key}`);
			return { success: true, byteSize: 0 };
		}

		// Write to local disk
		await mkdir(userStorageUploadRoot, { recursive: true });
		await writeFile(localPath, data);

		// Delete from Cloudflare
		if (isWorkerAvailable()) {
			await fetch(`${config.storage.worker.url}/${key}`, {
				method: "DELETE",
				headers: {
					"Authorization": `Bearer ${config.storage.worker.token}`,
				},
			}).catch(() => undefined);
		} else if (isR2Available()) {
			await getS3Client().send(new DeleteObjectCommand({
				Bucket: config.storage.r2.bucketName,
				Key: key,
			})).catch(() => undefined);
		}

		return { success: true, byteSize: data.length };
	}

	return { success: false, byteSize: 0 };
}

/**
 * Get readable stream for an object in Worker or R2 (or null if not found or local)
 */
export async function getR2ObjectStream(key: string): Promise<Readable | null> {
	if (isWorkerAvailable()) {
		try {
			const targetUrl = `${config.storage.worker.url}/${key.replace(/^\/+/u, "")}`;
			const response = await fetch(targetUrl, {
				headers: {
					"Authorization": `Bearer ${config.storage.worker.token}`,
				},
			});
			if (!response.ok || !response.body) return null;
			return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
		} catch {
			return null;
		}
	}

	if (!isR2Available()) return null;
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
