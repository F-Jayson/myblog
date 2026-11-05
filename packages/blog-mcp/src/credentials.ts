import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PendingAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresAt: string;
	interval: number;
};

export type SiteCredential = {
	accessToken?: string;
	expiresAt?: string;
	scopes?: string[];
	clientName?: string;
	pending?: PendingAuthorization;
};

type Store = { version: 1; sites: Record<string, SiteCredential> };

const filePath = join(homedir(), ".jayson-blog", "credentials.json");

function emptyStore(): Store {
	return { version: 1, sites: {} };
}

async function readStore(): Promise<Store> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<Store>;
		if (!parsed || typeof parsed !== "object" || !parsed.sites || typeof parsed.sites !== "object") return emptyStore();
		return { version: 1, sites: parsed.sites };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyStore();
		throw new Error("本机授权文件无法读取，请检查 ~/.jayson-blog/credentials.json");
	}
}

async function writeStore(store: Store) {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function blogOrigin() {
	const value = process.env.BLOG_ORIGIN?.trim();
	if (!value) throw new Error("未配置 BLOG_ORIGIN。请在 MCP 配置的 env 里填写博客 API 地址，例如 http://127.0.0.1:5180");
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("BLOG_ORIGIN 不是有效地址"); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BLOG_ORIGIN 需要使用 http 或 https");
	if (url.username || url.password) throw new Error("BLOG_ORIGIN 不能包含账号或密码");
	if (url.pathname !== "/" || url.search || url.hash) throw new Error("BLOG_ORIGIN 只填写源，例如 https://blog.example.com，不要带路径");
	return url.origin;
}

export async function readCredential(origin = blogOrigin()) {
	const store = await readStore();
	return store.sites[origin] ?? {};
}

export async function writeCredential(patch: SiteCredential, origin = blogOrigin()) {
	const store = await readStore();
	store.sites[origin] = { ...store.sites[origin], ...patch };
	await writeStore(store);
	return store.sites[origin];
}

export async function clearCredential(origin = blogOrigin()) {
	const store = await readStore();
	delete store.sites[origin];
	await writeStore(store);
}
