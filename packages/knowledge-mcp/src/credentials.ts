import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface KnowledgeCredential {
	accessToken?: string;
	expiresAt?: string;
	scopes?: string[];
	allowedLibraryIds?: number[];
	clientName?: string;
	user?: {
		id: number;
		username: string;
		nickname: string;
	};
}

interface KnowledgeStore {
	version: 1;
	profiles: Record<string, {
		sites: Record<string, KnowledgeCredential>;
	}>;
}

const STORE_PATH = join(homedir(), ".jayson-blog-knowledge", "credentials.json");

function emptyStore(): KnowledgeStore {
	return {
		version: 1,
		profiles: {
			default: { sites: {} },
		},
	};
}

async function readStore(): Promise<KnowledgeStore> {
	try {
		const raw = await readFile(STORE_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<KnowledgeStore>;
		if (!parsed || parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") {
			return emptyStore();
		}
		return {
			version: 1,
			profiles: parsed.profiles,
		};
	} catch (error: any) {
		if (error && error.code === "ENOENT") {
			return emptyStore();
		}
		throw new Error("本机普通用户知识库凭据文件无法读取，请检查 ~/.jayson-blog-knowledge/credentials.json");
	}
}

async function writeStore(store: KnowledgeStore): Promise<void> {
	await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
	await writeFile(STORE_PATH, JSON.stringify(store, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
}

export function currentProfileName(): string {
	return process.env.KB_PROFILE?.trim() || "default";
}

export function blogOrigin(): string {
	const raw = process.env.BLOG_ORIGIN?.trim() || "http://127.0.0.1:5180";
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`BLOG_ORIGIN [${raw}] 不是有效 URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("BLOG_ORIGIN 需要使用 http 或 https 协议");
	}
	if (url.username || url.password) {
		throw new Error("BLOG_ORIGIN 不能包含账号密码");
	}
	return url.origin;
}

export async function readCredential(
	profile = currentProfileName(),
	origin = blogOrigin(),
): Promise<KnowledgeCredential> {
	const store = await readStore();
	return store.profiles[profile]?.sites[origin] ?? {};
}

export async function writeCredential(
	patch: KnowledgeCredential,
	profile = currentProfileName(),
	origin = blogOrigin(),
): Promise<KnowledgeCredential> {
	const store = await readStore();
	if (!store.profiles[profile]) {
		store.profiles[profile] = { sites: {} };
	}
	const current = store.profiles[profile].sites[origin] ?? {};
	const updated = { ...current, ...patch };
	store.profiles[profile].sites[origin] = updated;
	await writeStore(store);
	return updated;
}

export async function clearCredential(
	profile = currentProfileName(),
	origin = blogOrigin(),
): Promise<void> {
	const store = await readStore();
	if (store.profiles[profile]?.sites[origin]) {
		delete store.profiles[profile].sites[origin];
		await writeStore(store);
	}
}
