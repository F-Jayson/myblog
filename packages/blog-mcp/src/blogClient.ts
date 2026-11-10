import { spawn } from "node:child_process";
import { blogOrigin, clearCredential, readCredential, writeCredential, type PendingAuthorization } from "./credentials.js";

const SCOPE_LABELS: Record<string, string> = {
	"posts:read": "读取文章",
	"posts:write": "写入草稿",
	"posts:publish": "发布文章",
	"posts:delete": "删除文章",
	"media:write": "上传图片",
	"taxonomy:manage": "管理分类标签",
	"comments:read": "读取评论",
	"comments:moderate": "审核评论",
	"content:read": "读取站点内容",
	"content:write": "编辑未公开内容",
	"content:publish": "发布站点内容",
	"content:delete": "删除站点内容",
	"site:read": "读取站点设置",
	"site:write": "修改站点设置",
	"users:read": "读取用户",
	"users:manage": "管理用户",
};

export const DEFAULT_SCOPES = ["posts:read", "posts:write", "media:write", "content:read", "site:read"];
export const AGENT_SCOPE_IDS = Object.keys(SCOPE_LABELS);

type ErrorBody = { error?: string; message?: string; interval?: number };

export class BlogRequestError extends Error {
	readonly code: string;
	readonly status: number;
	readonly interval: number;
	constructor(status: number, body: ErrorBody) {
		super(body.message || body.error || `请求失败（${status}）`);
		this.code = body.error || "request_failed";
		this.status = status;
		this.interval = body.interval ?? 5;
	}
}

async function request<T>(path: string, options: { method?: string; token?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
	const headers = new Headers();
	if (options.token) headers.set("authorization", `Bearer ${options.token}`);
	let body: BodyInit | undefined;
	if (options.form) body = options.form;
	else if (options.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}
	const response = await fetch(`${blogOrigin()}${path}`, { method: options.method ?? "GET", headers, body, signal: AbortSignal.timeout(60_000) });
	if (response.status === 204) return undefined as T;
	const payload = (await response.json().catch(() => null)) as (T & ErrorBody) | null;
	if (!response.ok) throw new BlogRequestError(response.status, payload ?? {});
	return payload as T;
}

export type AgentProfile = { clientName: string; scopes: string[]; expiresAt: string; admin: { username: string } };

export function scopeText(scopes: string[]) {
	return scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("、");
}

export async function currentProfile() {
	const saved = await readCredential();
	if (!saved.accessToken) return null;
	try {
		const profile = await request<AgentProfile>("/api/agent/me", { token: saved.accessToken });
		// [260] 令牌只留在凭据文件里：返回值会进模型上下文与日志，绝不能带 accessToken
		return profile;
	} catch (error) {
		if (error instanceof BlogRequestError && (error.status === 401 || error.status === 403)) {
			await writeCredential({ accessToken: undefined, expiresAt: undefined, scopes: undefined, clientName: undefined });
			return null;
		}
		throw error;
	}
}

function openBrowser(url: string) {
	try {
		// [259] spawn 失败是异步 error 事件：不监听会变成未捕获异常直接打挂 MCP 进程
		const child = process.platform === "win32"
			? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
			: process.platform === "darwin"
				? spawn("open", [url], { detached: true, stdio: "ignore" })
				: spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(deviceCode: string) {
	try {
		return await request<{ accessToken: string; expiresAt: string; scopes: string[]; clientName: string; interval?: number }>("/api/agent/device/token", { method: "POST", body: { deviceCode } });
	} catch (error) {
		if (error instanceof BlogRequestError && ["authorization_pending", "slow_down", "access_denied", "expired_token"].includes(error.code)) return error;
		throw error;
	}
}

export async function connectBlog(input: { scopes?: string[]; force?: boolean } = {}) {
	if (!input.force) {
		const existing = await currentProfile();
		if (existing) return { connected: true, already: true, profile: existing, message: `已经连接博客。\n管理员：${existing.admin.username}\n权限：${scopeText(existing.scopes)}\n有效期至：${existing.expiresAt}\n如需更换权限，请把 force 设为 true 后重新连接。` };
	} else {
		const saved = await readCredential();
		if (saved.accessToken) await request("/api/agent/revoke", { method: "POST", token: saved.accessToken }).catch(() => undefined);
		await writeCredential({ accessToken: undefined, pending: undefined });
	}
	let pending = input.force ? undefined : (await readCredential()).pending;
	let opened = false;
	if (!pending) {
		const started = await request<{ deviceCode: string; userCode: string; verificationUriComplete: string; expiresIn: number; interval: number }>("/api/agent/device/start", {
			method: "POST",
			body: { clientName: "Cursor 智能体", scopes: input.scopes?.length ? input.scopes : DEFAULT_SCOPES },
		});
		pending = { deviceCode: started.deviceCode, userCode: started.userCode, verificationUriComplete: started.verificationUriComplete, expiresAt: new Date(Date.now() + started.expiresIn * 1000).toISOString(), interval: started.interval };
		await writeCredential({ pending });
		opened = openBrowser(started.verificationUriComplete);
	} else {
		opened = openBrowser(pending.verificationUriComplete);
	}
	const deadline = Date.now() + 8 * 60 * 1000;
	while (Date.now() < deadline) {
		const result = await poll(pending.deviceCode);
		if (result instanceof BlogRequestError) {
			if (result.code === "access_denied") {
				await writeCredential({ pending: undefined });
				throw new Error("管理员拒绝了这次授权");
			}
			if (result.code === "expired_token") {
				await writeCredential({ pending: undefined });
				throw new Error("授权请求已过期。请再次调用 blog_connect。");
			}
			await sleep(Math.max(1, result.interval) * 1000);
			continue;
		}
		await writeCredential({ accessToken: result.accessToken, expiresAt: result.expiresAt, scopes: result.scopes, clientName: result.clientName, pending: undefined });
		// [260] 只回传展示需要的信息：device/token 的响应里有长期 accessToken，不能被序列化进模型上下文
		const profile = { clientName: result.clientName, scopes: result.scopes, expiresAt: result.expiresAt };
		return { connected: true, already: false, profile, message: `授权完成，可以管理博客文章。\n权限：${scopeText(result.scopes)}\n有效期至：${result.expiresAt}` };
	}
	const display = pending.userCode.length === 8 ? `${pending.userCode.slice(0, 4)}-${pending.userCode.slice(4)}` : pending.userCode;
	return {
		connected: false,
		already: false,
		message: `${opened ? "授权页已打开" : "没能自动打开浏览器"}，请完成登录并核对授权码 ${display}。\n页面：${pending.verificationUriComplete}\n完成后再次调用 blog_connect，会继续等待同一次授权。`,
	};
}

export async function disconnectBlog() {
	const saved = await readCredential();
	if (saved.accessToken) await request("/api/agent/revoke", { method: "POST", token: saved.accessToken }).catch(() => undefined);
	await clearCredential();
	return "已断开博客授权。下次写入前需要重新登录确认。";
}

async function token() {
	const saved = await readCredential();
	if (!saved.accessToken) throw new Error("还没有授权。请先调用 blog_connect，在打开的浏览器里用管理员账号登录并允许。");
	return saved.accessToken;
}

export async function blogJson<T>(path: string, options: { method?: string; body?: unknown; form?: FormData } = {}) {
	return request<T>(path, { ...options, token: await token() });
}
