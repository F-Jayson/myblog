import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import {
	ALL_KB_SCOPES,
	approveKbDeviceRequest,
	denyKbDeviceRequest,
	getKbDeviceRequestByUserCode,
	getKbGrantByToken,
	KbAgentError,
	listKbUserGrants,
	pollKbDeviceToken,
	revokeAllKbUserGrants,
	revokeKbUserGrant,
	startKbDeviceRequest,
	type KbAgentGrant,
} from "./agentStore.js";
import type { KbScope } from "./types.js";

export const kbAgentRoutes = Router();

export type KbAgentRequest = Request & {
	kbGrant?: KbAgentGrant;
	commentUser?: {
		id: number;
		username: string;
		nickname: string;
		avatar: string;
		email?: string;
	};
};

/**
 * 统一鉴权中间件：支持从 Authorization: Bearer 中提取普通用户 MCP Grant
 */
export async function loadKbAgentContext(req: KbAgentRequest, res: Response, next: NextFunction) {
	const authHeader = req.header("authorization");
	const token = authHeader?.replace(/^Bearer\s+/iu, "").trim();

	if (!token) {
		next();
		return;
	}

	try {
		// 令牌存在时必须完成解析：会话与 Agent 令牌同时出现且归属不同用户时，
		// 绝不能静默沿用会话身份放行（否则 Agent 借会话身份绕过 scope / 库范围校验）
		const grant = await getKbGrantByToken(token);
		if (grant && grant.user) {
			if (req.commentUser && req.commentUser.id !== grant.user.id) {
				res.status(403).json({
					error: "KB_AGENT_IDENTITY_CONFLICT",
					message: "请求同时携带了不同身份的登录会话与 MCP 令牌",
				});
				return;
			}
			req.kbGrant = grant;
			req.commentUser = grant.user;
		}
		next();
	} catch (error) {
		next(error);
	}
}

/**
 * 校验特定 Scope 中间件 (仅当请求由 Agent 发起时生效)
 */
export function requireKbScope(requiredScope: KbScope): RequestHandler {
	return (req: Request, res: Response, next: NextFunction) => {
		const agentReq = req as KbAgentRequest;
		if (agentReq.kbGrant) {
			if (!agentReq.kbGrant.scopes.includes(requiredScope)) {
				res.status(403).json({
					error: "KB_SCOPE_DENIED",
					message: `缺少执行该操作所需的 scope: ${requiredScope}`,
				});
				return;
			}
		}
		next();
	};
}

/**
 * 校验知识库在授权范围内 (仅当请求由 Agent 发起时生效)
 */
export function checkKbAgentLibraryAllowed(req: Request, libraryId: number): boolean {
	const agentReq = req as KbAgentRequest;
	if (agentReq.kbGrant) {
		return agentReq.kbGrant.allowedLibraryIds.includes(libraryId);
	}
	return true;
}

/**
 * 连接管理（列出/撤销授权）只允许真实登录会话：
 * Agent 令牌注入的 commentUser 也有 user.id，若不拦住就能用它撤销其他连接甚至全部授权
 */
function requireSessionOnly(req: Request, res: Response): { id: number } | null {
	const agentReq = req as KbAgentRequest;
	if (agentReq.kbGrant) {
		res.status(403).json({
			error: "KB_AGENT_SESSION_REQUIRED",
			message: "连接管理需要在浏览器中登录后操作，AI 客户端令牌无权执行",
		});
		return null;
	}
	const user = agentReq.commentUser;
	if (!user?.id) {
		res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通博客账号" });
		return null;
	}
	return { id: user.id };
}

// =============================================================================
// 设备授权端点 (RFC 8628 Flow)
// =============================================================================

const startDeviceSchema = z.object({
	clientName: z.string().trim().min(1).max(120).optional(),
	requestedScopes: z.array(z.enum(ALL_KB_SCOPES)).optional(),
});

// /device/code 无鉴权，按 IP 做简单滑动窗口限流，防止刷库
const deviceCodeLimiter = new Map<string, number[]>();
const DEVICE_CODE_WINDOW_MS = 60_000;
const DEVICE_CODE_MAX_PER_WINDOW = 10;

/**
 * 1. 客户端发起设备授权请求
 * POST /api/knowledge/agent/device/code
 */
kbAgentRoutes.post("/device/code", async (req: Request, res: Response, next: NextFunction) => {
	try {
		// 简单 IP 限流：设备码端点无鉴权，避免被刷库
		const clientIp = req.ip || req.socket.remoteAddress || "unknown";
		const now = Date.now();
		const recent = deviceCodeLimiter.get(clientIp);
		if (recent) {
			const recentCount = recent.filter((ts) => now - ts < DEVICE_CODE_WINDOW_MS).length;
			if (recentCount >= DEVICE_CODE_MAX_PER_WINDOW) {
				res.status(429).json({ error: "slow_down", message: "发起连接过于频繁，请稍后再试" });
				return;
			}
		}
		const timestamps = (deviceCodeLimiter.get(clientIp) ?? []).filter((ts) => now - ts < DEVICE_CODE_WINDOW_MS);
		timestamps.push(now);
		deviceCodeLimiter.set(clientIp, timestamps);

		const parsed = startDeviceSchema.parse(req.body);
		const result = await startKbDeviceRequest(
			parsed.clientName || "Personal AI Agent",
			parsed.requestedScopes,
		);
		res.json(result);
	} catch (error) {
		if (error instanceof z.ZodError) {
			res.status(400).json({ error: "invalid_request", message: "请求参数错误" });
			return;
		}
		next(error);
	}
});

/**
 * 2. 网页授权页查询设备授权详情
 * GET /api/knowledge/agent/device/request
 */
kbAgentRoutes.get("/device/request", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userCode = typeof req.query.userCode === "string" ? req.query.userCode : "";
		if (!userCode.trim()) {
			res.status(400).json({ error: "invalid_request", message: "缺少 userCode 参数" });
			return;
		}

		const info = await getKbDeviceRequestByUserCode(userCode);
		res.json(info);
	} catch (error) {
		if (error instanceof KbAgentError) {
			res.status(error.status).json({ error: error.code, message: error.message });
			return;
		}
		next(error);
	}
});

const approveDeviceSchema = z.object({
	userCode: z.string().trim().min(6).max(12),
	allowedLibraryIds: z.array(z.number().int().positive()).min(1),
	grantedScopes: z.array(z.enum(ALL_KB_SCOPES)).min(1),
	expiresInDays: z.number().int().min(1).max(30).optional(),
});

/**
 * 3. 普通用户在网页批准授权
 * POST /api/knowledge/agent/device/approve
 */
kbAgentRoutes.post("/device/approve", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通博客账号" });
			return;
		}

		const parsed = approveDeviceSchema.parse(req.body);
		const result = await approveKbDeviceRequest(
			parsed.userCode,
			user.id,
			parsed.allowedLibraryIds,
			parsed.grantedScopes,
			parsed.expiresInDays ?? 7,
		);
		res.json({ success: true, grantId: result.grantId });
	} catch (error) {
		if (error instanceof KbAgentError) {
			res.status(error.status).json({ error: error.code, message: error.message });
			return;
		}
		if (error instanceof z.ZodError) {
			res.status(400).json({ error: "invalid_request", message: "参数不合法，必须选择至少一个知识库和一项权限" });
			return;
		}
		next(error);
	}
});

/**
 * 4. 普通用户在网页拒绝授权
 * POST /api/knowledge/agent/device/deny
 */
kbAgentRoutes.post("/device/deny", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const userCode = typeof req.body.userCode === "string" ? req.body.userCode : "";
		if (!userCode.trim()) {
			res.status(400).json({ error: "invalid_request", message: "缺少 userCode 参数" });
			return;
		}
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通博客账号" });
			return;
		}
		await denyKbDeviceRequest(userCode, user.id);
		res.json({ success: true });
	} catch (error) {
		if (error instanceof KbAgentError) {
			res.status(error.status).json({ error: error.code, message: error.message });
			return;
		}
		next(error);
	}
});

/**
 * 5. MCP 客户端轮询获取 Token
 * POST /api/knowledge/agent/device/token
 */
kbAgentRoutes.post("/device/token", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const deviceCode = typeof req.body.deviceCode === "string" ? req.body.deviceCode : "";
		if (!deviceCode.trim()) {
			res.status(400).json({ error: "invalid_request", message: "缺少 deviceCode 参数" });
			return;
		}

		const result = await pollKbDeviceToken(deviceCode);
		res.json(result);
	} catch (error) {
		if (error instanceof KbAgentError) {
			const body: { error: string; message: string; interval?: number } = {
				error: error.code,
				message: error.message,
			};
			if (error.interval) body.interval = error.interval;
			res.status(error.status).json(body);
			return;
		}
		next(error);
	}
});

// =============================================================================
// 当前连接信息与普通用户连接管理
// =============================================================================

/**
 * 6. 查询当前 Agent 连接自身状态
 * GET /api/knowledge/agent/me
 */
kbAgentRoutes.get("/me", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const agentReq = req as KbAgentRequest;
		if (!agentReq.kbGrant) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "未提供有效的普通用户 MCP 令牌" });
			return;
		}

		res.json({
			clientName: agentReq.kbGrant.clientName,
			scopes: agentReq.kbGrant.scopes,
			allowedLibraryIds: agentReq.kbGrant.allowedLibraryIds,
			expiresAt: agentReq.kbGrant.expiresAt,
			user: agentReq.commentUser,
		});
	} catch (error) {
		next(error);
	}
});

/**
 * 7. 列出普通用户的所有有效 MCP 连接
 * GET /api/knowledge/agent/connections
 */
kbAgentRoutes.get("/connections", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const user = requireSessionOnly(req, res);
		if (!user) return;

		const grants = await listKbUserGrants(user.id);
		res.json({ connections: grants });
	} catch (error) {
		next(error);
	}
});

/**
 * 8. 撤销指定 MCP 授权
 * DELETE /api/knowledge/agent/connections/:id
 */
kbAgentRoutes.delete("/connections/:id", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const user = requireSessionOnly(req, res);
		if (!user) return;

		const grantId = Number(req.params.id);
		if (!Number.isInteger(grantId) || grantId <= 0) {
			res.status(400).json({ error: "invalid_request", message: "无效的连接 ID" });
			return;
		}

		const success = await revokeKbUserGrant(user.id, grantId);
		if (!success) {
			res.status(404).json({ error: "not_found", message: "未找到该连接或已被撤销" });
			return;
		}

		res.json({ success: true, message: "已成功撤销该 AI 客户端授权" });
	} catch (error) {
		next(error);
	}
});

/**
 * 9. 撤销全部 MCP 授权
 * DELETE /api/knowledge/agent/connections
 */
kbAgentRoutes.delete("/connections", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const user = requireSessionOnly(req, res);
		if (!user) return;

		const count = await revokeAllKbUserGrants(user.id);
		res.json({ success: true, revokedCount: count, message: `已成功撤销全部 ${count} 个 AI 客户端授权` });
	} catch (error) {
		next(error);
	}
});
