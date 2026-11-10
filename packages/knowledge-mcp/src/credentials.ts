import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

const FORBIDDEN_PROFILE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeProfileName(profile: string): string {
	// [297] profile 名会成为对象键：`__proto__` 之类的键会污染原型而不是写入记录
	if (!profile || FORBIDDEN_PROFILE_KEYS.has(profile)) {
		throw new Error(`KB_PROFILE [${profile}] 不是合法的配置名`);
	}
	return profile;
}

async function readStore(): Promise<KnowledgeStore> {
	try {
		const raw = await readFile(STORE_PATH, "utf8");
		let parsed: Partial<KnowledgeStore>;
		try {
			parsed = JSON.parse(raw) as Partial<KnowledgeStore>;
		} catch {
			// [292] 文件被写坏时不能笼统报"无法读取"：明确告知路径与修复方式
			throw new Error(`凭据文件已损坏（JSON 解析失败），请删除 ${STORE_PATH} 后重新授权`);
		}
		if (!parsed || parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") {
			// [294] 结构非法时静默按空 store 处理，会让紧随其后的写入清空已有凭据
			throw new Error(`凭据文件结构无法识别（version/profiles 缺失），请备份后删除 ${STORE_PATH} 再重新授权`);
		}
		return {
			version: 1,
			profiles: parsed.profiles,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyStore();
		}
		if (error instanceof Error && error.message.startsWith("凭据文件")) {
			throw error;
		}
		throw new Error("本机普通用户知识库凭据文件无法读取，请检查 ~/.jayson-blog-knowledge/credentials.json");
	}
}

async function writeStore(store: KnowledgeStore): Promise<void> {
	await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
	// [293] mkdir 的 mode 只对新建目录生效，已存在且权限宽松的目录要显式收紧
	await chmod(dirname(STORE_PATH), 0o700).catch(() => undefined);
	// [291] 原子写：直接覆盖写会在进程崩溃/断电时留下被截断的 JSON，
	// 下次读取直接失败且原凭据丢失；先写同目录临时文件再 rename 才是原子的
	const tempPath = `${STORE_PATH}.${process.pid}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
		await chmod(tempPath, 0o600);
		await rename(tempPath, STORE_PATH);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
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
	assertSafeProfileName(profile);
	const store = await readStore();
	return store.profiles[profile]?.sites[origin] ?? {};
}

export async function writeCredential(
	patch: KnowledgeCredential,
	profile = currentProfileName(),
	origin = blogOrigin(),
): Promise<KnowledgeCredential> {
	assertSafeProfileName(profile);
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
	assertSafeProfileName(profile);
	const store = await readStore();
	if (store.profiles[profile]?.sites[origin]) {
		delete store.profiles[profile].sites[origin];
		await writeStore(store);
	}
}
