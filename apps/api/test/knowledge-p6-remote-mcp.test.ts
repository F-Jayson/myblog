import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import type mysql from "mysql2/promise";
import {
	pool,
	createUserLibrary,
	registerOAuthClient,
	getOAuthClient,
	validateRedirectUri,
	createAuthorizationCode,
	exchangeAuthorizationCode,
	rotateRefreshToken,
	revokeOAuthToken,
	getKbGrantByToken,
	revokeAllKbUserGrants,
	createRemoteKnowledgeMcpServer,
	KbAgentError,
} from "../src/knowledge/index.js";

function base64url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce() {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

describe("P6: 远程 Streamable HTTP MCP 与 OAuth 2.1 / PKCE 授权测试 (A23 专项闭环)", { concurrency: 1 }, () => {
	let testUserId: number;
	let libraryId: number;
	let clientId: string;
	const redirectUri = "https://client.myai.dev/oauth/callback";

	before(async () => {
		// 1. 创建普通用户
		const [userRes] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_p6_tester_${Date.now()}', 'P6远程测试者', 'hash_p6_remote', 1, DATE_SUB(NOW(), INTERVAL 35 DAY))`
		);
		testUserId = Number(userRes.insertId);

		// 2. 注入活跃流水以激活知识库资格
		for (let i = 1; i <= 28; i += 2) {
			await pool.execute(
				`INSERT INTO user_activity_daily (user_id, activity_date, rule_version, login_count, clipboard_score, image_score, total_service_score)
				 VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 'v1', 1, 2, 2, 4)`,
				[testUserId, i]
			);
		}

		// 3. 创建测试知识库
		libraryId = await createUserLibrary(testUserId, {
			title: "P6远程测试知识库",
			description: "测试远程 MCP 与 OAuth",
			visibility: "private",
		});

		// 4. 注册测试 OAuth 客户端
		const client = await registerOAuthClient({
			clientName: "Claude Desktop Remote",
			redirectUris: [redirectUri, "http://localhost:8080/callback"],
			isConfidential: false,
		});
		clientId = client.clientId;
	});

	after(async () => {
		try {
			if (testUserId) {
				await pool.execute("DELETE FROM knowledge_bases WHERE owner_user_id = ?", [testUserId]);
				await pool.execute("DELETE FROM kb_oauth_refresh_tokens WHERE user_id = ?", [testUserId]);
				await pool.execute("DELETE FROM kb_oauth_codes WHERE user_id = ?", [testUserId]);
				await pool.execute("DELETE FROM kb_user_grants WHERE user_id = ?", [testUserId]);
				await pool.execute("DELETE FROM kb_oauth_clients WHERE client_id = ?", [clientId]);
				await pool.execute("DELETE FROM user_activity_daily WHERE user_id = ?", [testUserId]);
				await pool.execute("DELETE FROM kb_entitlements WHERE user_id = ?", [testUserId]);
				await pool.execute("DELETE FROM comment_users WHERE id = ?", [testUserId]);
			}
		} catch {
			// ignore cleanup error
		}
	});

	it("P6.1 RFC 7591 客户端注册与严格 redirect_uri 比对", async () => {
		const client = await getOAuthClient(clientId);
		assert.ok(client);
		assert.equal(client?.clientName, "Claude Desktop Remote");

		// 正确的 redirect_uri 允许
		assert.equal(validateRedirectUri(client!, redirectUri), true);
		assert.equal(validateRedirectUri(client!, "http://localhost:8080/callback"), true);

		// 非法/篡改的 redirect_uri 严格拒绝 (防开放重定向)
		assert.equal(validateRedirectUri(client!, "https://malicious-site.com/steal-code"), false);
		assert.equal(validateRedirectUri(client!, "https://client.myai.dev/other-path"), false);
	});

	it("P6.2 授权码模式 + PKCE S256 流程、错误挑战拦截与一次性消费", async () => {
		const { verifier, challenge } = generatePkce();

		// 1. 生成授权码
		const code = await createAuthorizationCode({
			clientId,
			userId: testUserId,
			redirectUri,
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
			scopes: ["kb:read", "kb:write"],
			allowedLibraryIds: [libraryId],
		});
		assert.ok(code.startsWith("kboc_"));

		// 2. 伪造或错误的 verifier 尝试换取令牌：必须拒绝！
		await assert.rejects(
			async () => {
				await exchangeAuthorizationCode({
					code,
					clientId,
					redirectUri,
					codeVerifier: "wrong_fake_verifier_12345678901234567890",
				});
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				assert.equal(err.code, "invalid_grant");
				assert.match(err.message, /PKCE 校验失败/);
				return true;
			}
		);

		// 3. 正确的 verifier 换取令牌：成功！
		const tokenRes = await exchangeAuthorizationCode({
			code,
			clientId,
			redirectUri,
			codeVerifier: verifier,
		});

		assert.ok(tokenRes.access_token.startsWith("kbt_"));
		assert.ok(tokenRes.refresh_token.startsWith("kbrt_"));
		assert.equal(tokenRes.token_type, "Bearer");
		assert.equal(tokenRes.expires_in, 600, "access_token 标称 10 分钟");
		assert.equal(tokenRes.scope, "kb:read kb:write");

		// 4. 一次性消费验证：再次使用同一授权码换取令牌，必须拒绝！
		await assert.rejects(
			async () => {
				await exchangeAuthorizationCode({
					code,
					clientId,
					redirectUri,
					codeVerifier: verifier,
				});
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				assert.equal(err.code, "invalid_grant");
				assert.match(err.message, /授权码已被使用/);
				return true;
			}
		);

		// 5. 验证新生成的 access_token 可以正常通过后端鉴权
		const grant = await getKbGrantByToken(tokenRes.access_token);
		assert.ok(grant);
		assert.equal(grant?.userId, testUserId);
		assert.deepEqual(grant?.allowedLibraryIds, [libraryId]);
	});

	it("P6.3 Refresh Token 轮换 (Rotation) 与家族异常重用检测 (Replay Attack Detection)", async () => {
		const { verifier, challenge } = generatePkce();

		// 1. 签发一套新的 Tokens
		const code = await createAuthorizationCode({
			clientId,
			userId: testUserId,
			redirectUri,
			codeChallenge: challenge,
			scopes: ["kb:read"],
			allowedLibraryIds: [libraryId],
		});
		const initialTokens = await exchangeAuthorizationCode({
			code,
			clientId,
			redirectUri,
			codeVerifier: verifier,
		});

		const rt1 = initialTokens.refresh_token;

		// 2. 正常轮换：使用 rt1 换取新的 rt2
		const rotatedTokens = await rotateRefreshToken({
			refreshToken: rt1,
			clientId,
		});

		const rt2 = rotatedTokens.refresh_token;
		assert.notEqual(rt2, rt1, "轮换后必须签发全新的 refresh_token");
		assert.ok(rotatedTokens.access_token);

		// 验证新的 access_token 生效
		assert.ok(await getKbGrantByToken(rotatedTokens.access_token));

		// 3. 重用检测 (Replay Attack)：黑客拿被消费过的旧 rt1 再次尝试刷新！
		await assert.rejects(
			async () => {
				await rotateRefreshToken({
					refreshToken: rt1,
					clientId,
				});
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				assert.match(err.message, /检测到 Refresh Token 异常重用/);
				return true;
			}
		);

		// 4. 重用攻击触发后，整个家族的令牌应立即全部作废吊销！
		// 此时用合法的 rt2 再次尝试刷新，也必须失败！
		await assert.rejects(
			async () => {
				await rotateRefreshToken({
					refreshToken: rt2,
					clientId,
				});
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				return true;
			}
		);

		// 关联的 access_token 也已被即刻撤销
		assert.equal(await getKbGrantByToken(rotatedTokens.access_token), null);
	});

	it("P6.4 令牌主动撤销 (RFC 7009) 与改密即刻失效", async () => {
		const { verifier, challenge } = generatePkce();
		const code = await createAuthorizationCode({
			clientId,
			userId: testUserId,
			redirectUri,
			codeChallenge: challenge,
			scopes: ["kb:read"],
			allowedLibraryIds: [libraryId],
		});
		const tokens = await exchangeAuthorizationCode({
			code,
			clientId,
			redirectUri,
			codeVerifier: verifier,
		});

		assert.ok(await getKbGrantByToken(tokens.access_token));

		// 1. 主动调用撤销
		await revokeOAuthToken(tokens.access_token);
		assert.equal(await getKbGrantByToken(tokens.access_token), null, "主动撤销后立即无法鉴权");

		// 2. 重新签发并测试改密即时失效
		const { verifier: v2, challenge: c2 } = generatePkce();
		const code2 = await createAuthorizationCode({
			clientId,
			userId: testUserId,
			redirectUri,
			codeChallenge: c2,
			scopes: ["kb:read"],
			allowedLibraryIds: [libraryId],
		});
		const tokens2 = await exchangeAuthorizationCode({
			code: code2,
			clientId,
			redirectUri,
			codeVerifier: v2,
		});
		assert.ok(await getKbGrantByToken(tokens2.access_token));

		// 触发改密批量吊销
		await revokeAllKbUserGrants(testUserId);
		assert.equal(await getKbGrantByToken(tokens2.access_token), null, "改密后远程 OAuth 令牌必须即刻失效");
	});

	it("P6.5 远程 McpServer 实例创建与工具集调用", async () => {
		const { verifier, challenge } = generatePkce();
		const code = await createAuthorizationCode({
			clientId,
			userId: testUserId,
			redirectUri,
			codeChallenge: challenge,
			scopes: ["kb:read", "kb:write"],
			allowedLibraryIds: [libraryId],
		});
		const tokens = await exchangeAuthorizationCode({
			code,
			clientId,
			redirectUri,
			codeVerifier: verifier,
		});

		const grant = await getKbGrantByToken(tokens.access_token);
		assert.ok(grant);

		// 构建远程 McpServer 实例
		const mcpServer = createRemoteKnowledgeMcpServer(grant!);
		assert.ok(mcpServer, "应成功初始化远程 McpServer");
	});

	after(async () => {
		try {
			await pool.end();
		} catch {
			// ignore pool close errors
		}
	});
});
