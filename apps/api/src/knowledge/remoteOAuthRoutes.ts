import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import type { KbScope } from "./types.js";
import { ALL_KB_SCOPES, DEFAULT_KB_SCOPES, SENSITIVE_KB_SCOPES, KbAgentError } from "./agentStore.js";
import {
	createAuthorizationCode,
	exchangeAuthorizationCode,
	getOAuthClient,
	registerOAuthClient,
	revokeOAuthToken,
	rotateRefreshToken,
	validateRedirectUri,
} from "./remoteOAuthStore.js";

export const remoteOAuthRoutes = Router();

// 工具函数：获取基础 Issuer URL
function getIssuer(req: Request): string {
	const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
	const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${config.port}`;
	return `${proto}://${host}`;
}

// =============================================================================
// 1. RFC 8414 授权服务器元数据发现
// =============================================================================
export const oauthMetadataHandler: RequestHandler = (req: Request, res: Response) => {
	const issuer = getIssuer(req);
	res.json({
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/oauth/token`,
		revocation_endpoint: `${issuer}/oauth/revoke`,
		registration_endpoint: `${issuer}/oauth/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
		scopes_supported: [...ALL_KB_SCOPES],
		service_documentation: `${issuer}/docs/remote-mcp.md`,
	});
};

// =============================================================================
// 2. 受保护资源元数据发现 (OAuth Protected Resource Metadata)
// =============================================================================
export const oauthResourceMetadataHandler: RequestHandler = (req: Request, res: Response) => {
	const issuer = getIssuer(req);
	res.json({
		resource: `${issuer}/mcp/knowledge`,
		authorization_servers: [issuer],
		scopes_supported: [...ALL_KB_SCOPES],
		bearer_methods_supported: ["header"],
	});
};

// =============================================================================
// 3. RFC 7591 客户端动态注册
// =============================================================================
remoteOAuthRoutes.post("/register", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const schema = z.object({
			client_name: z.string().trim().min(1).max(120),
			redirect_uris: z.array(z.string().trim().min(1)).min(1),
			token_endpoint_auth_method: z.enum(["none", "client_secret_post"]).optional(),
		});

		const body = schema.parse(req.body);
		const isConfidential = body.token_endpoint_auth_method === "client_secret_post";

		const registered = await registerOAuthClient({
			clientName: body.client_name,
			redirectUris: body.redirect_uris,
			isConfidential,
		});

		res.status(201).json({
			client_id: registered.clientId,
			client_name: registered.clientName,
			redirect_uris: registered.redirectUris,
			token_endpoint_auth_method: isConfidential ? "client_secret_post" : "none",
			...(registered.clientSecret ? { client_secret: registered.clientSecret } : {}),
		});
	} catch (error) {
		next(error);
	}
});

// =============================================================================
// 4. 授权端点 (GET /oauth/authorize)
// =============================================================================
remoteOAuthRoutes.get("/authorize", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const clientId = String(req.query.client_id ?? "").trim();
		const redirectUri = String(req.query.redirect_uri ?? "").trim();
		const responseType = String(req.query.response_type ?? "").trim();
		const scope = String(req.query.scope ?? "").trim();
		const state = String(req.query.state ?? "").trim();
		const codeChallenge = String(req.query.code_challenge ?? "").trim();
		const codeChallengeMethod = String(req.query.code_challenge_method ?? "").trim() || "S256";

		if (!clientId) {
			res.status(400).json({ error: "invalid_request", error_description: "缺少必需的 client_id" });
			return;
		}

		const client = await getOAuthClient(clientId);
		if (!client) {
			res.status(400).json({ error: "unauthorized_client", error_description: "未识别的 client_id" });
			return;
		}

		if (!validateRedirectUri(client, redirectUri)) {
			res.status(400).json({ error: "invalid_redirect_uri", error_description: "重定向 URI 未在客户端注册名单中" });
			return;
		}

		if (responseType !== "code") {
			res.status(400).json({ error: "unsupported_response_type", error_description: "仅支持 response_type=code" });
			return;
		}

		if (!codeChallenge) {
			res.status(400).json({ error: "invalid_request", error_description: "必须提供 code_challenge (PKCE 强制要求)" });
			return;
		}

		// 构建前端授权同意页面 URL
		const webBase = config.clientOrigin.replace(/\/+$/, "");
		const consentUrl = new URL(`${webBase}/knowledge/oauth-authorize`);
		consentUrl.searchParams.set("client_id", clientId);
		consentUrl.searchParams.set("client_name", client.clientName);
		consentUrl.searchParams.set("redirect_uri", redirectUri);
		consentUrl.searchParams.set("scope", scope || DEFAULT_KB_SCOPES.join(" "));
		consentUrl.searchParams.set("state", state);
		consentUrl.searchParams.set("code_challenge", codeChallenge);
		consentUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

		res.redirect(consentUrl.toString());
	} catch (error) {
		next(error);
	}
});

// =============================================================================
// 5. 授权同意处理 (POST /oauth/consent - 需用户会话登录)
// =============================================================================
remoteOAuthRoutes.post("/consent", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const user = (req as Request & { commentUser?: { id: number } }).commentUser;
		if (!user?.id) {
			res.status(401).json({ error: "unauthorized", error_description: "请先登录普通用户账号" });
			return;
		}

		const schema = z.object({
			client_id: z.string().trim().min(1),
			redirect_uri: z.string().trim().min(1),
			code_challenge: z.string().trim().min(1),
			code_challenge_method: z.string().trim().default("S256"),
			state: z.string().trim().optional(),
			scopes: z.array(z.string()).default([...DEFAULT_KB_SCOPES]),
			allowed_library_ids: z.array(z.number()).default([]),
		});

		const body = schema.parse(req.body);
		const client = await getOAuthClient(body.client_id);

		if (!client) {
			res.status(400).json({ error: "unauthorized_client", error_description: "客户端不存在" });
			return;
		}

		if (!validateRedirectUri(client, body.redirect_uri)) {
			res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uri 不合法" });
			return;
		}

		// 过滤合法 scopes
		const validScopes = body.scopes.filter((s): s is KbScope => (ALL_KB_SCOPES as readonly string[]).includes(s));
		if (validScopes.length === 0) {
			validScopes.push("kb:read");
		}

		const code = await createAuthorizationCode({
			clientId: body.client_id,
			userId: user.id,
			redirectUri: body.redirect_uri,
			codeChallenge: body.code_challenge,
			codeChallengeMethod: body.code_challenge_method,
			scopes: validScopes,
			allowedLibraryIds: body.allowed_library_ids,
		});

		const redirectUrl = new URL(body.redirect_uri);
		redirectUrl.searchParams.set("code", code);
		if (body.state) {
			redirectUrl.searchParams.set("state", body.state);
		}

		res.json({
			redirect_url: redirectUrl.toString(),
			code,
			state: body.state,
		});
	} catch (error) {
		next(error);
	}
});

// =============================================================================
// 6. 令牌端点 (POST /oauth/token)
// =============================================================================
remoteOAuthRoutes.post("/token", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const grantType = String(req.body.grant_type ?? "").trim();
		const clientId = String(req.body.client_id ?? "").trim();

		if (!grantType) {
			res.status(400).json({ error: "invalid_request", error_description: "缺少必需的 grant_type" });
			return;
		}

		if (!clientId) {
			res.status(400).json({ error: "invalid_request", error_description: "缺少必需的 client_id" });
			return;
		}

		if (grantType === "authorization_code") {
			const code = String(req.body.code ?? "").trim();
			const redirectUri = String(req.body.redirect_uri ?? "").trim();
			const codeVerifier = String(req.body.code_verifier ?? "").trim();

			if (!code || !redirectUri || !codeVerifier) {
				res.status(400).json({
					error: "invalid_request",
					error_description: "缺少 code、redirect_uri 或 code_verifier (PKCE)",
				});
				return;
			}

			const tokens = await exchangeAuthorizationCode({
				code,
				clientId,
				redirectUri,
				codeVerifier,
			});

			res.json(tokens);
			return;
		}

		if (grantType === "refresh_token") {
			const refreshToken = String(req.body.refresh_token ?? "").trim();
			if (!refreshToken) {
				res.status(400).json({ error: "invalid_request", error_description: "缺少 refresh_token" });
				return;
			}

			const tokens = await rotateRefreshToken({
				refreshToken,
				clientId,
			});

			res.json(tokens);
			return;
		}

		res.status(400).json({ error: "unsupported_grant_type", error_description: `不支持的 grant_type: ${grantType}` });
	} catch (error) {
		if (error instanceof KbAgentError) {
			res.status(error.status).json({
				error: error.code,
				error_description: error.message,
			});
			return;
		}
		next(error);
	}
});

// =============================================================================
// 7. 令牌撤销端点 (POST /oauth/revoke - RFC 7009)
// =============================================================================
remoteOAuthRoutes.post("/revoke", async (req: Request, res: Response, next: NextFunction) => {
	try {
		const token = String(req.body.token ?? "").trim();
		if (!token) {
			res.status(400).json({ error: "invalid_request", error_description: "缺少 token 参数" });
			return;
		}

		await revokeOAuthToken(token);
		res.status(200).json({ ok: true, message: "Token 已成功吊销" });
	} catch (error) {
		next(error);
	}
});
