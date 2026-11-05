const DB_NAME = "jayson-blog";
const STORE = "wallpapers";
const DB_VERSION = 1;
const MAX_ITEMS = 8;
const MAX_BYTES = 8 * 1024 * 1024;

type WallpaperRecord = {
	id?: number;
	blob: Blob;
	filename: string;
	createdAt: number;
	fingerprint: string;
};

export type CachedWallpaper = {
	blob: Blob;
	filename: string;
};

let databasePromise: Promise<IDBDatabase> | null = null;
let primed: CachedWallpaper | null | undefined;
let priming: Promise<CachedWallpaper | null> | null = null;

function openDatabase() {
	if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB unavailable"));
	if (!databasePromise) {
		databasePromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => {
				databasePromise = null;
				reject(request.error ?? new Error("indexedDB open failed"));
			};
		});
	}
	return databasePromise;
}

async function fingerprintBlob(blob: Blob) {
	const slice = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
	let hash = blob.size >>> 0;
	for (let index = 0; index < slice.length; index += 97) hash = (Math.imul(hash, 33) + slice[index]) >>> 0;
	return `${blob.type}:${blob.size}:${hash.toString(16)}`;
}

async function readRandomWallpaper(): Promise<CachedWallpaper | null> {
	const db = await openDatabase();
	const rows = await new Promise<WallpaperRecord[]>((resolve, reject) => {
		const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
		request.onsuccess = () => resolve((request.result as WallpaperRecord[]) || []);
		request.onerror = () => reject(request.error ?? new Error("wallpaper cache read failed"));
	});
	const usable = rows.filter((row) => row.blob instanceof Blob && row.blob.size > 32);
	if (!usable.length) return null;
	const pick = usable[Math.floor(Math.random() * usable.length)];
	return { blob: pick.blob, filename: pick.filename || "wallpaper.jpg" };
}

export function peekPrimedWallpaper() {
	return primed ?? null;
}

export function primeWallpaperCache() {
	if (priming) return priming;
	priming = readRandomWallpaper().then((item) => {
		primed = item;
		return item;
	}).catch(() => {
		primed = null;
		return null;
	});
	return priming;
}

export async function rememberWallpaper(blob: Blob, filename: string) {
	if (blob.size < 32 || blob.size > MAX_BYTES) return;
	try {
		const fingerprint = await fingerprintBlob(blob);
		const db = await openDatabase();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			const existing = store.getAll();
			existing.onsuccess = () => {
				const rows = ((existing.result as WallpaperRecord[]) || []).filter((row) => row.id != null);
				if (rows.some((row) => row.fingerprint === fingerprint)) return;
				store.add({ blob, filename: filename || "wallpaper.jpg", createdAt: Date.now(), fingerprint } satisfies WallpaperRecord);
				const overflow = rows.length + 1 - MAX_ITEMS;
				if (overflow > 0) {
					const oldest = [...rows].sort((left, right) => left.createdAt - right.createdAt).slice(0, overflow);
					for (const row of oldest) store.delete(row.id as number);
				}
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("wallpaper cache write failed"));
			tx.onabort = () => reject(tx.error ?? new Error("wallpaper cache write aborted"));
		});
	} catch {
		/* 缓存失败时继续使用当次拉取的壁纸 */
	}
}

if (typeof window !== "undefined") void primeWallpaperCache();
