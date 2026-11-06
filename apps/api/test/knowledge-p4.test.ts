import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import type mysql from "mysql2/promise";
import {
	pool,
	createUserLibrary,
	startKbDeviceRequest,
	getKbDeviceRequestByUserCode,
	approveKbDeviceRequest,
	denyKbDeviceRequest,
	pollKbDeviceToken,
	getKbGrantByToken,
	listKbUserGrants,
	revokeKbUserGrant,
	revokeAllKbUserGrants,
	cleanupExpiredKbDeviceRequests,
	cleanupExpiredKbGrants,
	resetPollLimiterForTest,
	withIdempotency,
	checkKbAgentLibraryAllowed,
	requireKbScope,
	type KbAgentRequest,
	KbAgentError,
	KbAccessDeniedError,
} from "../src/knowledge/index.js";
import { getAgentGrantByToken } from "../src/agentStore.js";

describe("P4: 普通用户本地MCP适配器、RFC 8628设备流、细粒度Scope与即时失效测试", () => {
	let testUserId: number;
	let allowedLibId: number;
	let disallowedLibId: number;
	let activeGrantToken: string;
	let activeGrantId: number;

	before(async () => {
		// 1. 创建测试普通用户 (满足 30 天资格)
		const [userRes] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_p4_tester_${Date.now()}', 'P4测试者', 'hash123_original', 1, DATE_SUB(NOW(), INTERVAL 35 DAY))`
		);
		testUserId = Number(userRes.insertId);

		// 2. 为该用户注入 14 天活跃流水以满足资格
		for (let i = 1; i <= 28; i += 2) {
			await pool.execute(
				`INSERT INTO user_activity_daily (user_id, activity_date, rule_version, login_count, clipboard_score, image_score, total_service_score)
				 VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 'v1', 1, 2, 2, 4)`,
				[testUserId, i]
			);
		}

		// 3. 创建两个知识库，一个用于授权，一个用于隔离测试
		allowedLibId = await createUserLibrary(testUserId, {
			title: "P4授权库",
			description: "授权访问的库",
			visibility: "private",
		});

		disallowedLibId = await createUserLibrary(testUserId, {
			title: "P4未授权隔离库",
			description: "未授权不可访问的库",
			visibility: "private",
		});
	});

	after(async () => {
		try {
			await pool.execute("DELETE FROM kb_documents WHERE library_id IN (?, ?)", [allowedLibId, disallowedLibId]);
			await pool.execute("DELETE FROM kb_user_grants WHERE user_id = ?", [testUserId]);
			await pool.execute("DELETE FROM kb_device_requests WHERE user_id = ?", [testUserId]);
			await pool.execute("DELETE FROM kb_libraries WHERE id IN (?, ?)", [allowedLibId, disallowedLibId]);
			await pool.execute("DELETE FROM user_activity_daily WHERE user_id = ?", [testUserId]);
			await pool.execute("DELETE FROM comment_users WHERE id = ?", [testUserId]);
		} catch {
			// ignore cleanup error
		}
	});

	it("P4.1 RFC 8628 设备授权流：创建请求、等待轮询、5秒限流与用户拒绝流程", async () => {
		resetPollLimiterForTest();

		// 1. 客户端发起设备请求
		const deviceReq = await startKbDeviceRequest("Cursor-IDE", ["kb:read", "kb:write"]);
		assert.ok(deviceReq.deviceCode, "应生成 deviceCode");
		assert.ok(deviceReq.userCode, "应生成 userCode");
		assert.equal(deviceReq.interval, 5, "标称轮询间隔为 5 秒");

		// 2. 授权前轮询应返回 authorization_pending 错误
		await assert.rejects(
			async () => {
				await pollKbDeviceToken(deviceReq.deviceCode);
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				assert.equal(err.code, "authorization_pending");
				assert.equal(err.status, 400);
				return true;
			}
		);

		// 3. 5 秒内立刻再次轮询，应触发 slow_down 限流保护
		await assert.rejects(
			async () => {
				await pollKbDeviceToken(deviceReq.deviceCode);
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				assert.equal(err.code, "slow_down");
				assert.equal(err.status, 400);
				assert.equal(err.interval, 5);
				return true;
			}
		);

		// 4. 用户查询待授权请求
		const info = await getKbDeviceRequestByUserCode(deviceReq.userCode);
		assert.ok(info, "用户应能查到待授权设备信息");
		assert.equal(info?.clientName, "Cursor-IDE");
		assert.equal(info?.status, "pending");

		// 5. 用户在网页端选择拒绝
		await denyKbDeviceRequest(deviceReq.userCode, testUserId);

		// 重置单测限流计时器验证拒绝状态
		resetPollLimiterForTest();
		await assert.rejects(
			async () => {
				await pollKbDeviceToken(deviceReq.deviceCode);
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				assert.equal(err.code, "access_denied");
				return true;
			}
		);
	});

	it("P4.2 RFC 8628 设备授权流：用户批准、一次性交付与 Token 获取", async () => {
		resetPollLimiterForTest();

		// 1. 客户端再次发起设备请求
		const req2 = await startKbDeviceRequest("VSCode-Knowledge-MCP", ["kb:read", "kb:write"]);

		// 2. 用户在网页端批准：只授权 allowedLibId，指定权限 ["kb:read", "kb:write"]
		const approveResult = await approveKbDeviceRequest(
			req2.userCode,
			testUserId,
			[allowedLibId],
			["kb:read", "kb:write"],
			7
		);

		assert.ok(approveResult.grantId, "批准应生成 grantId");
		activeGrantId = approveResult.grantId;

		// 3. 客户端轮询获取 Token
		const tokenRes = await pollKbDeviceToken(req2.deviceCode);
		assert.ok(tokenRes.accessToken, "应成功返回 accessToken");
		assert.equal(tokenRes.tokenType, "Bearer");
		assert.deepEqual(tokenRes.scopes, ["kb:read", "kb:write"]);
		assert.deepEqual(tokenRes.allowedLibraryIds, [allowedLibId]);

		activeGrantToken = tokenRes.accessToken;

		// 4. 一次性交付验证：再次用同一 deviceCode 轮询，应立即被拒绝（交付Token置空）
		resetPollLimiterForTest();
		await assert.rejects(
			async () => {
				await pollKbDeviceToken(req2.deviceCode);
			},
			(err: any) => {
				assert.equal(err.name, "KbAgentError");
				// 设备码已被消费，delivered_token 置空
				return true;
			}
		);
	});

	it("A16 细粒度 Scope 检查与知识库范围过滤", async () => {
		// 1. 使用 activeGrantToken 验证通过
		const grant = await getKbGrantByToken(activeGrantToken);
		assert.ok(grant, "应正确识别有效 Grant");
		assert.equal(grant?.userId, testUserId);
		assert.equal(grant?.user?.id, testUserId);

		// 构造虚拟请求对象模拟 Express 中间件调用
		const mockReq = {
			kbGrant: grant,
			commentUser: grant.user,
		} as unknown as KbAgentRequest;

		// 2. 知识库范围过滤：allowedLibId 应通过 (true)，disallowedLibId 应返回 false
		assert.equal(checkKbAgentLibraryAllowed(mockReq as any, allowedLibId), true);
		assert.equal(checkKbAgentLibraryAllowed(mockReq as any, disallowedLibId), false);

		// 3. Scope 权限验证：kb:read 和 kb:write 应通过 (调用 next)，未授权的 kb:publish / kb:delete 应返回 403
		let readCalled = false;
		requireKbScope("kb:read")(mockReq as any, {} as any, () => {
			readCalled = true;
		});
		assert.equal(readCalled, true);

		let writeCalled = false;
		requireKbScope("kb:write")(mockReq as any, {} as any, () => {
			writeCalled = true;
		});
		assert.equal(writeCalled, true);

		let deniedStatus = 0;
		let deniedJson: any = null;
		const mockRes = {
			status(code: number) {
				deniedStatus = code;
				return this;
			},
			json(payload: any) {
				deniedJson = payload;
				return this;
			},
		} as any;

		requireKbScope("kb:publish")(mockReq as any, mockRes, () => {});
		assert.equal(deniedStatus, 403);
		assert.equal(deniedJson?.error, "KB_SCOPE_DENIED");
	});

	it("A15 管理员与普通用户物理隔离：跨表互不认账", async () => {
		// 1. 普通用户知识库 Token 传入管理员鉴权体系，必定返回 null
		const adminGrant = await getAgentGrantByToken(activeGrantToken);
		assert.equal(adminGrant, null, "普通用户知识库 Token 严禁识别为管理员 Grant");

		// 2. 管理员 Token 传入普通用户知识库鉴权体系，必定返回 null
		const fakeAdminToken = "ag_test_token_secret_fake_000";
		const kbGrant = await getKbGrantByToken(fakeAdminToken);
		assert.equal(kbGrant, null, "非知识库 Token 绝不可能通过知识库 Grant 鉴权");
	});

	it("A18 即时失效测试：主动撤销、密码修改与账号停用", async () => {
		// 1. 用户主动撤销连接
		const listBefore = await listKbUserGrants(testUserId);
		assert.ok(listBefore.some((g) => g.id === activeGrantId));

		await revokeKbUserGrant(testUserId, activeGrantId);

		// 撤销后 Token 立即失效
		const grantAfterRevoke = await getKbGrantByToken(activeGrantToken);
		assert.equal(grantAfterRevoke, null, "主动撤销后 Token 必须立即失效");

		// 2. 为用户重新签发一个新的 Grant
		resetPollLimiterForTest();
		const newReq = await startKbDeviceRequest("Test-Password-Change", ["kb:read"]);
		await approveKbDeviceRequest(
			newReq.userCode,
			testUserId,
			[allowedLibId],
			["kb:read"],
			1
		);
		const newPoll = await pollKbDeviceToken(newReq.deviceCode);
		const newToken = newPoll.accessToken;

		// 验证新 Token 有效
		const validGrant = await getKbGrantByToken(newToken);
		assert.ok(validGrant, "新 Token 此时应有效");

		// 3. 模拟用户密码变更：通过在 repository 中触发 revokeAllKbUserGrants
		await revokeAllKbUserGrants(testUserId);
		const grantAfterPasswordChange = await getKbGrantByToken(newToken);
		assert.equal(grantAfterPasswordChange, null, "密码重置/变更后所有活跃 Grant 必须全部即刻失效");

		// 4. 账号停用测试：即使 Grant 记录有效，当 comment_users.is_active = 0 时亦绝不准入
		resetPollLimiterForTest();
		const newReq2 = await startKbDeviceRequest("Test-Account-Disabled", ["kb:read"]);
		await approveKbDeviceRequest(
			newReq2.userCode,
			testUserId,
			[allowedLibId],
			["kb:read"],
			1
		);
		const poll2 = await pollKbDeviceToken(newReq2.deviceCode);
		const token3 = poll2.accessToken;

		assert.ok(await getKbGrantByToken(token3), "账号激活状态下 Token 应有效");

		// 停用用户账号
		await pool.execute("UPDATE comment_users SET is_active = 0 WHERE id = ?", [testUserId]);
		const disabledGrant = await getKbGrantByToken(token3);
		assert.equal(disabledGrant, null, "用户账号停用后 Token 必须即刻拒绝认证");

		// 恢复账号状态以便后续清理
		await pool.execute("UPDATE comment_users SET is_active = 1 WHERE id = ?", [testUserId]);
	});

	it("P4.3 幂等性包装器与过期清理任务", async () => {
		// 1. 测试 withIdempotency 24小时幂等执行
		let executeTimes = 0;
		const idempotencyKey = `p4-idempotency-key-${Date.now()}`;
		const payload = { action: "create_doc", title: "幂等测试" };

		const result1 = await withIdempotency(testUserId, null, "doc_create", idempotencyKey, payload, async () => {
			executeTimes++;
			return { ok: true, data: 42 };
		});
		assert.equal(result1.ok, true);
		assert.equal(executeTimes, 1);

		// 重复请求同一 idempotencyKey
		const result2 = await withIdempotency(testUserId, null, "doc_create", idempotencyKey, payload, async () => {
			executeTimes++;
			return { ok: true, data: 99 };
		});
		// 应直接返回缓存的执行结果，且执行函数不再次调用
		assert.equal(result2.ok, true);
		assert.equal(result2.data, 42);
		assert.equal(executeTimes, 1, "幂等包装器应阻止重复执行");

		// 2. 清理过期请求与 Grants 不抛出异常
		const cleanedRequests = await cleanupExpiredKbDeviceRequests();
		const cleanedGrants = await cleanupExpiredKbGrants();
		assert.ok(typeof cleanedRequests === "number");
		assert.ok(typeof cleanedGrants === "number");
	});
});
