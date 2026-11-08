import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import type mysql from "mysql2/promise";
import { pool } from "../src/db.js";
import {
	getCommentUserById,
	getUserSpace,
	setUserInitialStorageLocation,
	executeUserStorageMigration,
	getActiveStorageMigration,
	createUserStorageItem,
	adminSetUserStorageLocation,
	USER_SPACE_SERVER_LIMIT_BYTES,
	USER_SPACE_CF_LIMIT_BYTES,
} from "../src/repository.js";

describe("用户自主选择存储位置与资源迁移功能测试", { concurrency: 1 }, () => {
	let testUserAId: number;
	let testUserBId: number;

	before(async () => {
		// 创建测试用户 A
		const [resA] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('storage_test_user_a_${Date.now()}', '存储测试A', 'hash_test', 1, NOW())`
		);
		testUserAId = Number(resA.insertId);

		// 创建测试用户 B
		const [resB] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('storage_test_user_b_${Date.now()}', '存储测试B', 'hash_test', 1, NOW())`
		);
		testUserBId = Number(resB.insertId);
	});

	after(async () => {
		try {
			await pool.execute("DELETE FROM storage_migrations WHERE user_id IN (?, ?)", [testUserAId, testUserBId]);
			await pool.execute("DELETE FROM user_storage_items WHERE user_id IN (?, ?)", [testUserAId, testUserBId]);
			await pool.execute("DELETE FROM comment_users WHERE id IN (?, ?)", [testUserAId, testUserBId]);
			await pool.end();
		} catch {}
	});

	it("1. 新注册用户初始无存储位置，默认配额 30MB", async () => {
		const user = await getCommentUserById(testUserAId);
		assert.ok(user);
		assert.equal(user.storageLocation, null);
		assert.equal(user.storageLocationSelected, false);

		const space = await getUserSpace(testUserAId);
		assert.equal(space.storageLocation, null);
		assert.equal(space.storageLocationSelected, false);
		assert.equal(space.limitBytes, USER_SPACE_SERVER_LIMIT_BYTES);
	});

	it("2. 用户首次选择 Cloudflare 存储，配额提升至 50MB", async () => {
		const updated = await setUserInitialStorageLocation(testUserAId, "cloudflare");
		assert.equal(updated.storageLocation, "cloudflare");
		assert.equal(updated.storageLocationSelected, true);
		assert.equal(updated.limitBytes, USER_SPACE_CF_LIMIT_BYTES);

		// 再次调用 initial 设置应被拒绝
		await assert.rejects(
			async () => {
				await setUserInitialStorageLocation(testUserAId, "server");
			},
			/您已设置过存储位置/
		);
	});

	it("3. 用户首次选择服务器存储，配额为 30MB", async () => {
		const updated = await setUserInitialStorageLocation(testUserBId, "server");
		assert.equal(updated.storageLocation, "server");
		assert.equal(updated.storageLocationSelected, true);
		assert.equal(updated.limitBytes, USER_SPACE_SERVER_LIMIT_BYTES);
	});

	it("4. 每月只能更改一次存储位置限制生效", async () => {
		// 用户 A 刚设置过（或刚切换过），在 30 天冷却期内尝试切换应被拒绝
		await assert.rejects(
			async () => {
				await executeUserStorageMigration(testUserAId, "server");
			},
			/每个用户每个月只能更改一次存储位置/
		);
	});

	it("5. 从 CF 转服务器限制：若空间超过 30MB 则禁止转回", async () => {
		// 人工模拟时间流逝（清除冷却期），并在用户 A 名下插入超过 30MB 的数据
		await pool.execute(
			"UPDATE comment_users SET storage_location_switched_at = DATE_SUB(NOW(), INTERVAL 35 DAY) WHERE id = ?",
			[testUserAId]
		);

		// 插入一个 35MB 的虚拟存储项
		const oversizedBytes = 35 * 1024 * 1024;
		await pool.execute(
			`INSERT INTO user_storage_items (user_id, kind, name, storage_url, storage_key, mime_type, byte_size, is_public, public_token)
			 VALUES (?, 'image_host', 'big_image.png', '', 'test_oversized_key.png', 'image/png', ?, 1, 'token_oversized')`,
			[testUserAId, oversizedBytes]
		);

		// 尝试切换到 server 必须被拦截
		await assert.rejects(
			async () => {
				await executeUserStorageMigration(testUserAId, "server");
			},
			/超过服务器存储的 30MB 空间上限，无法转回服务器存储/
		);

		// 清理超额测试项
		await pool.execute("DELETE FROM user_storage_items WHERE user_id = ? AND storage_key = 'test_oversized_key.png'", [testUserAId]);
	});

	it("6. 正常资源迁移、进度记录与原有链接失效（Token 轮换）", async () => {
		// 在用户 A 名下插入正常测试图片 (100KB)
		const item = await createUserStorageItem({
			userId: testUserAId,
			kind: "image_host",
			name: "测试图片.png",
			url: "https://myblog-storage.jixian0721-r2.workers.dev/user-space/test_migrate_file.png",
			storageKey: "test_migrate_file.png",
			mimeType: "image/png",
			byteSize: 100 * 1024,
			isPublic: true,
		});
		assert.ok(item);
		const oldToken = item.publicToken;
		assert.ok(oldToken);

		// 执行迁移：CF -> Server
		const result = await executeUserStorageMigration(testUserAId, "server");
		assert.equal(result.success, true);
		assert.equal(result.targetLocation, "server");

		// 检查迁移进度记录
		const migration = await getActiveStorageMigration(testUserAId);
		assert.ok(migration);
		assert.equal(migration.status, "completed");
		assert.equal(migration.toLocation, "server");
		assert.ok(migration.migratedFiles >= 1);

		// 检查用户存储偏好已变更为 server
		const updatedUser = await getCommentUserById(testUserAId);
		assert.equal(updatedUser?.storageLocation, "server");

		// 检查原有的 public_token 是否已轮换失效！
		const [rows] = await pool.query<any[]>(
			"SELECT public_token FROM user_storage_items WHERE id = ?",
			[item.id]
		);
		assert.ok(rows[0]);
		const newToken = rows[0].public_token;
		assert.ok(newToken);
		assert.notEqual(newToken, oldToken, "原有资源链接必须失效，生成全新 token");
	});

	it("7. 管理员控制用户存储位置与数据迁移（可绕过冷却期与直接配置）", async () => {
		// 用户 A 当前已切换到 server，冷却期未到（普通用户会被拦截）
		await assert.rejects(
			async () => executeUserStorageMigration(testUserAId, "cloudflare"),
			/每个用户每个月只能更改一次存储位置/
		);

		// 管理员通过 adminSetUserStorageLocation 绕过冷却期执行迁移 -> cloudflare
		const adminResult = await adminSetUserStorageLocation(testUserAId, "cloudflare", {
			migrateData: true,
			ignoreCooldown: true,
		});
		assert.equal(adminResult.success, true);
		assert.equal(adminResult.targetLocation, "cloudflare");

		const userAfterAdmin = await getCommentUserById(testUserAId);
		assert.equal(userAfterAdmin?.storageLocation, "cloudflare");

		// 管理员仅修改配置，不执行物理迁移
		const configOnlyResult = await adminSetUserStorageLocation(testUserAId, "server", {
			migrateData: false,
		});
		assert.equal(configOnlyResult.success, true);
		assert.equal(configOnlyResult.migrated, false);

		const userFinal = await getCommentUserById(testUserAId);
		assert.equal(userFinal?.storageLocation, "server");
	});
});
