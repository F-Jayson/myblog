import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	blogOrigin,
	clearCredential,
	currentProfileName,
	readCredential,
	writeCredential,
	type KnowledgeCredential,
} from "./credentials.js";

export class KnowledgeApiError extends Error {
	readonly code: string;
	readonly status: number;
	readonly interval?: number;
	constructor(status: number, body: { error?: string; message?: string; interval?: number }) {
		super(body.message || body.error || `请求失败 (${status})`);
		this.name = "KnowledgeApiError";
		this.code = body.error || "request_failed";
		this.status = status;
		this.interval = body.interval;
	}
}

async function request<T>(
	path: string,
	options: {
		method?: string;
		token?: string;
		body?: unknown;
		formData?: FormData;
	} = {},
): Promise<T> {
	const origin = blogOrigin();
	const headers = new Headers();

	if (options.token) {
		headers.set("authorization", `Bearer ${options.token}`);
	}

	let body: BodyInit | undefined;
	if (options.formData) {
		body = options.formData;
	} else if (options.body !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(options.body);
	}

	const response = await fetch(`${origin}${path}`, {
		method: options.method || "GET",
		headers,
		body,
		signal: AbortSignal.timeout(60_000),
	});

	if (response.status === 204) {
		return undefined as T;
	}

	const isJson = response.headers.get("content-type")?.includes("application/json");
	if (isJson) {
		const payload = await response.json();
		if (!response.ok) {
			throw new KnowledgeApiError(response.status, payload);
		}
		return payload as T;
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new KnowledgeApiError(response.status, { message: text || `HTTP ${response.status}` });
	}

	return (await response.text()) as T;
}

function openBrowser(url: string): boolean {
	try {
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取当前授权信息
 */
export async function currentKnowledgeProfile(): Promise<{
	credential: KnowledgeCredential;
	agentInfo?: {
		clientName: string;
		scopes: string[];
		allowedLibraryIds: number[];
		expiresAt: string;
		user: { id: number; username: string; nickname: string };
	};
} | null> {
	const cred = await readCredential();
	if (!cred.accessToken) return null;

	try {
		const info = await request<{
			clientName: string;
			scopes: string[];
			allowedLibraryIds: number[];
			expiresAt: string;
			user: { id: number; username: string; nickname: string };
		}>("/api/knowledge/agent/me", { token: cred.accessToken });

		return { credential: cred, agentInfo: info };
	} catch (error) {
		if (error instanceof KnowledgeApiError && (error.status === 401 || error.status === 403)) {
			// Token 已被撤销或失效，清空本地存储
			await clearCredential();
			return null;
		}
		throw error;
	}
}

/**
 * 发起普通用户知识库设备授权并轮询等待结果
 */
export async function connectKnowledge(options: {
	force?: boolean;
	scopes?: string[];
	clientName?: string;
} = {}): Promise<{ message: string; scopes: string[]; allowedLibraryIds: number[] }> {
	if (!options.force) {
		const existing = await currentKnowledgeProfile();
		if (existing && existing.agentInfo) {
			return {
				message: `知识库智能体已处于连接状态。\n普通账号: ${existing.agentInfo.user.nickname || existing.agentInfo.user.username}\n已授权库: ${existing.agentInfo.allowedLibraryIds.join(", ")}\n权限: ${existing.agentInfo.scopes.join(", ")}\n到期时间: ${existing.agentInfo.expiresAt}`,
				scopes: existing.agentInfo.scopes,
				allowedLibraryIds: existing.agentInfo.allowedLibraryIds,
			};
		}
	}

	const origin = blogOrigin();
	const profileName = currentProfileName();
	const clientName = options.clientName || `Personal AI Agent (${profileName})`;

	// 1. 发起请求
	const deviceReq = await request<{
		deviceCode: string;
		userCode: string;
		verificationUri: string;
		verificationUriComplete: string;
		expiresIn: number;
		interval: number;
	}>("/api/knowledge/agent/device/code", {
		method: "POST",
		body: {
			clientName,
			requestedScopes: options.scopes,
		},
	});

	const fullAuthUrl = `${origin}${deviceReq.verificationUriComplete}`;

	// 在 stderr 输出提示，绝不污染 stdout (stdio 协议通道)
	process.stderr.write(
		`\n[Knowledge MCP] 请在浏览器中确认授权：\n授权配对码: ${deviceReq.userCode}\n授权地址: ${fullAuthUrl}\n`,
	);

	openBrowser(fullAuthUrl);

	// 2. 轮询等待用户在浏览器中授权
	const deadline = Date.now() + deviceReq.expiresIn * 1000;
	let pollIntervalMs = (deviceReq.interval || 5) * 1000;

	while (Date.now() < deadline) {
		await sleep(pollIntervalMs);

		try {
			const tokenResult = await request<{
				accessToken: string;
				tokenType: string;
				expiresIn: number;
				scopes: string[];
				allowedLibraryIds: number[];
				clientName: string;
			}>("/api/knowledge/agent/device/token", {
				method: "POST",
				body: { deviceCode: deviceReq.deviceCode },
			});

			// 授权成功，保存凭据
			const expiresAt = new Date(Date.now() + tokenResult.expiresIn * 1000).toISOString();
			await writeCredential({
				accessToken: tokenResult.accessToken,
				expiresAt,
				scopes: tokenResult.scopes,
				allowedLibraryIds: tokenResult.allowedLibraryIds,
				clientName: tokenResult.clientName,
			});

			return {
				message: `知识库授权成功！\n客户端: ${tokenResult.clientName}\n已授权库 ID: ${tokenResult.allowedLibraryIds.join(", ")}\n已授予权限: ${tokenResult.scopes.join(", ")}\n有效期至: ${expiresAt}`,
				scopes: tokenResult.scopes,
				allowedLibraryIds: tokenResult.allowedLibraryIds,
			};
		} catch (error) {
			if (error instanceof KnowledgeApiError) {
				if (error.code === "authorization_pending") {
					continue;
				}
				if (error.code === "slow_down") {
					pollIntervalMs = Math.max(pollIntervalMs + 2000, (error.interval || 7) * 1000);
					continue;
				}
				if (error.code === "access_denied") {
					throw new Error("用户在网页中拒绝了本次授权请求。");
				}
				if (error.code === "expired_token") {
					throw new Error("授权请求已超时过期，请重新调用 kb_connect。");
				}
			}
			throw error;
		}
	}

	throw new Error("授权等待超时 (10 分钟已过)。");
}

/**
 * 撤销本地授权
 */
export async function disconnectKnowledge(): Promise<string> {
	const current = await readCredential();
	await clearCredential();
	return current.accessToken
		? "已清除本地知识库凭据并断开连接。"
		: "当前尚未连接任何知识库。";
}

/**
 * 带有 Token 校验的基础请求帮助函数
 */
async function callApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
	const cred = await readCredential();
	if (!cred.accessToken) {
		throw new Error("尚未连接博客个人知识库。请先调用 kb_connect 完成普通用户浏览器配对授权。");
	}
	return request<T>(path, { method, token: cred.accessToken, body });
}

// =============================================================================
// 业务工具 API 调用封装
// =============================================================================

export async function apiListLibraries(): Promise<any[]> {
	const res = await callApi<{ libraries: any[] }>("/api/knowledge/libraries");
	return res.libraries;
}

export async function apiGetTree(libraryId: number): Promise<any[]> {
	const res = await callApi<{ tree: any[] }>(`/api/knowledge/libraries/${libraryId}/tree`);
	return res.tree;
}

export async function apiSearch(query: string, libraryId?: number): Promise<any[]> {
	const params = new URLSearchParams({ q: query });
	if (libraryId) params.set("libraryId", String(libraryId));
	const res = await callApi<{ items: any[] }>(`/api/knowledge/search?${params.toString()}`);
	return res.items;
}

export async function apiGetDocument(documentId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}`);
}

export async function apiCreateDocument(data: {
	libraryId: number;
	parentId?: number | null;
	kind: "document" | "folder";
	title: string;
	markdown?: string;
	tags?: string[];
	idempotencyKey?: string;
}): Promise<any> {
	return callApi<any>("/api/knowledge/documents", "POST", data);
}

export async function apiUpdateDocument(
	documentId: number,
	data: {
		expectedVersion: number;
		title: string;
		markdown: string;
		tags?: string[];
		idempotencyKey?: string;
	},
): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}`, "PUT", data);
}

export async function apiMoveDocument(
	documentId: number,
	targetParentId: number | null,
	sortOrder = 0,
): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/move`, "POST", {
		targetParentId,
		sortOrder,
	});
}

export async function apiTrashDocument(documentId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/trash`, "POST");
}

export async function apiRestoreDocument(documentId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/restore`, "POST");
}

export async function apiListRevisions(documentId: number): Promise<any[]> {
	const res = await callApi<{ revisions: any[] }>(`/api/knowledge/documents/${documentId}/revisions`);
	return res.revisions;
}

export async function apiRestoreRevision(
	documentId: number,
	revisionId: number,
	expectedVersion: number,
): Promise<any> {
	return callApi<any>(
		`/api/knowledge/documents/${documentId}/revisions/${revisionId}/restore`,
		"POST",
		{ expectedVersion },
	);
}

export async function apiListComments(
	documentId: number,
	channel: "internal" | "public" = "internal",
): Promise<any[]> {
	const res = await callApi<{ comments: any[] }>(
		`/api/knowledge/documents/${documentId}/comments?channel=${channel}`,
	);
	return res.comments;
}

export async function apiAddComment(
	documentId: number,
	body: string,
	channel: "internal" | "public" = "internal",
	parentId?: number | null,
): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/comments`, "POST", {
		body,
		channel,
		parentId,
	});
}

export async function apiUploadAttachment(documentId: number, localFilePath: string): Promise<any> {
	const cred = await readCredential();
	if (!cred.accessToken) {
		throw new Error("尚未连接博客个人知识库。请先调用 kb_connect。");
	}

	const fileBuffer = await readFile(localFilePath);
	const fileName = basename(localFilePath);
	const formData = new FormData();
	formData.append("file", new Blob([fileBuffer]), fileName);

	return request<any>(`/api/knowledge/documents/${documentId}/attachments`, {
		method: "POST",
		token: cred.accessToken,
		formData,
	});
}

export async function apiPreviewPublication(documentId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/public/documents/${documentId}`);
}

export async function apiPublishDocument(documentId: number, revisionId?: number): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/publish`, "POST", {
		revisionId,
	});
}

export async function apiUnpublishDocument(documentId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/unpublish`, "POST");
}

export async function apiGetAccess(documentId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/access`);
}

export async function apiSetMember(
	libraryId: number,
	userId: number,
	role: "manager" | "editor" | "commenter" | "viewer",
): Promise<any> {
	return callApi<any>(`/api/knowledge/libraries/${libraryId}/members`, "POST", {
		userId,
		role,
	});
}

export async function apiSetDocumentAccess(
	documentId: number,
	data: {
		accessMode: "inherit" | "members_only" | "restricted";
		explicitRoles?: Array<{ userId: number; role: "editor" | "commenter" | "viewer" }>;
	},
): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/access`, "PUT", data);
}

export async function apiCreateShareLink(
	documentId: number,
	options: { expiresInDays?: number; includeDescendants?: boolean } = {},
): Promise<any> {
	return callApi<any>(`/api/knowledge/documents/${documentId}/share`, "POST", options);
}

export async function apiRevokeShareLink(linkId: number): Promise<any> {
	return callApi<any>(`/api/knowledge/share-links/${linkId}`, "DELETE");
}

export async function apiExportMarkdown(documentId: number): Promise<string> {
	return callApi<string>(`/api/knowledge/documents/${documentId}/export`);
}
