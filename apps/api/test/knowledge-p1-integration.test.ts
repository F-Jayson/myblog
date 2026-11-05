import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import {
	assertOwnerQuotaAvailable,
	assertUserCanBeDeleted,
	getOwnerKnowledgeUsage,
	getUserEligibility,
	incrementDailyServiceScore,
	insertActivityEvent,
	recordDailyLogin,
	recordUserDailyLogin,
	recordWhitelistActivity,
	UserDeletionBlockedError,
	userOwnsKnowledgeData,
} from "../src/knowledge/index.js";

describe("P1: 真实 MySQL 数据库集成测试 (firefly_blog_test)", () => {
	let connection: mysql.Connection;
	const testDb = "firefly_blog_test";
	let testUserAId: number;
	let testUserBId: number;

	before(async () => {
		connection = await mysql.createConnection({
			...config.db,
			database: testDb,
		});

		// 插入两个专用测试用户
		const [resA] = await connection.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_test_user_a', '测试用户A', 'hash123', 1, DATE_SUB(NOW(), INTERVAL 40 DAY))`
		);
		testUserAId = Number(resA.insertId);

		const [resB] = await connection.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_test_user_b', '测试用户B', 'hash456', 1, NOW())`
		);
		testUserBId = Number(resB.insertId);
	});

	after(async () => {
		try {
			if (testUserAId) {
				await connection.execute("DELETE FROM knowledge_bases WHERE owner_user_id = ?", [testUserAId]);
				await connection.execute("DELETE FROM user_activity_events WHERE user_id = ?", [testUserAId]);
				await connection.execute("DELETE FROM user_activity_daily WHERE user_id = ?", [testUserAId]);
				await connection.execute("DELETE FROM kb_entitlements WHERE user_id = ?", [testUserAId]);
				await connection.execute("DELETE FROM comment_users WHERE id = ?", [testUserAId]);
			}
			if (testUserBId) {
				await connection.execute("DELETE FROM comment_users WHERE id = ?", [testUserBId]);
			}
		} finally {
			await connection.end();
		}
	});

	it("A02 行为幂等性：同 key 行为无法重复插入", async () => {
		const event1 = await insertActivityEvent(
			{
				userId: testUserAId,
				activityType: "clipboard_save",
				idempotencyKey: "test_key_001",
				fingerprint: "fp_001",
			},
			connection as unknown as mysql.PoolConnection
		);
		assert.equal(event1, true);

		// 重复提交相同 idempotency_key，返回 false
		const event2 = await insertActivityEvent(
			{
				userId: testUserAId,
				activityType: "clipboard_save",
				idempotencyKey: "test_key_001",
				fingerprint: "fp_001",
			},
			connection as unknown as mysql.PoolConnection
		);
		assert.equal(event2, false);
	});

	it("每日计分上限：单类服务上限 4 分，全服务上限 8 分", async () => {
		const today = "2026-11-05";
		const poolConn = connection as unknown as mysql.PoolConnection;

		// 连续增加剪贴板得分 (每次1分)
		for (let i = 0; i < 6; i++) {
			await incrementDailyServiceScore(testUserAId, today, "clipboard_save", poolConn);
		}

		// 检查单类上限已被截断在 4 分
		const [[row]] = await connection.query<mysql.RowDataPacket[]>(
			"SELECT clipboard_score, total_service_score FROM user_activity_daily WHERE user_id = ? AND activity_date = ?",
			[testUserAId, today]
		);
		assert.equal(Number(row?.clipboard_score), 4);
		assert.equal(Number(row?.total_service_score), 4);
	});

	it("账号注销生命周期保护：拥有知识库的用户删除必须抛出 409", async () => {
		const poolConn = connection as unknown as mysql.PoolConnection;

		// 创建前：名下无库，允许删除检查通过
		const ownsBefore = await userOwnsKnowledgeData(testUserAId, poolConn);
		assert.equal(ownsBefore, false);
		await assertUserCanBeDeleted(testUserAId, poolConn); // 不报错

		// 创建知识库
		await connection.execute(
			`INSERT INTO knowledge_bases (owner_user_id, title, visibility)
			 VALUES (?, '我的测试库', 'private')`,
			[testUserAId]
		);

		// 创建后：名下有库，必须被拦截
		const ownsAfter = await userOwnsKnowledgeData(testUserAId, poolConn);
		assert.equal(ownsAfter, true);

		await assert.rejects(
			async () => {
				await assertUserCanBeDeleted(testUserAId, poolConn);
			},
			(err: unknown) => {
				assert.ok(err instanceof UserDeletionBlockedError);
				assert.equal(err.statusCode, 409);
				assert.equal(err.code, "USER_OWNS_KNOWLEDGE_DATA");
				return true;
			}
		);
	});

	it("配额计算与锁保护：统计与预扣校验可用", async () => {
		const poolConn = connection as unknown as mysql.PoolConnection;
		const usage = await getOwnerKnowledgeUsage(poolConn, testUserAId);
		assert.equal(typeof usage.totalBytes, "number");

		// 请求写入 1 MiB 应该通过
		const avail = await assertOwnerQuotaAvailable(poolConn, testUserAId, 1024 * 1024);
		assert.ok(avail.remainingBytes > 0);

		// 请求写入 200 MiB 应该抛出超额错误
		await assert.rejects(
			async () => {
				await assertOwnerQuotaAvailable(poolConn, testUserAId, 200 * 1024 * 1024);
			},
			/知识库配额已满/
		);
	});
});
