import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { isFeatureKbEnabled } from "./constants.js";
import { getUserEligibility } from "./service.js";

export const knowledgeRoutes = Router();

// 知识库全局功能开关守卫
export const requireKnowledgeBaseEnabled: RequestHandler = (_req, res, next) => {
	if (!isFeatureKbEnabled()) {
		res.status(503).json({
			error: "KB_FEATURE_DISABLED",
			message: "个人知识库功能维护中或尚未开启",
		});
		return;
	}
	next();
};

knowledgeRoutes.use(requireKnowledgeBaseEnabled);

/**
 * 获取当前登录用户的知识库准入资格与活跃进度
 * GET /api/knowledge/eligibility
 */
knowledgeRoutes.get("/eligibility", async (req: Request, res: Response, next: NextFunction) => {
	try {
		// 从请求会话中提取已认证的普通用户对象
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录普通账号" });
			return;
		}

		const eligibility = await getUserEligibility(user.id);
		res.json(eligibility);
	} catch (error) {
		next(error);
	}
});
