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
export async function loadKbAgentContext(req: KbAgentRequest, _res: Response, next: NextFunction) {
	const authHeader = req.header("authorization");
	const token = authHeader?.replace(/^Bearer\s+/iu, "").trim();

	if (!token) {
		next();
		return;
	}

	try {
		// 如果已经有 commentUser（如来自 session），不覆盖
		if (!req.commentUser) {
			const grant = await getKbGrantByToken(token);
			if (grant && grant.user) {
				req.kbGrant = grant;
				req.commentUser = grant.user;
			}
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

// =============================================================================
// 设备授权端点 (RFC 8628 Flow)
// =============================================================================

const startDeviceSchema = z.object({
	clientName: z.string().trim().min(1).max(120).optional(),
	requestedScopes: z.array(z.enum(ALL_KB_SCOPES)).optional(),
});

/**
 * 1. 客户端发起设备授权请求
 * POST /api/knowledge/agent/device/code
 */
kbAgentRoutes.post("/device/code", async (req: Request, res: Response, next: NextFunction) => {
	try {
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
		await denyKbDeviceRequest(userCode, user?.id);
		res.json({ success: true });
	} catch (error) {
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
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通博客账号" });
			return;
		}

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
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通博客账号" });
			return;
		}

		const grantId = Number(req.params.id);
		if (!grantId) {
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
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通博客账号" });
			return;
		}

		const count = await revokeAllKbUserGrants(user.id);
		res.json({ success: true, revokedCount: count, message: `已成功撤销全部 ${count} 个 AI 客户端授权` });
	} catch (error) {
		next(error);
	}
});
