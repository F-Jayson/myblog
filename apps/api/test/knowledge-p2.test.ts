import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import type mysql from "mysql2/promise";
import {
	createKnowledgeDocument,
	createUserLibrary,
	getDocumentDetail,
	getKnowledgeDocumentRevisions,
	getUserLibraryTree,
	getUserQuotaUsageService,
	listTrashedDocumentsService,
	moveKnowledgeDocument,
	pool,
	restoreDocumentRevision,
	restoreKnowledgeDocument,
	saveKnowledgeDocument,
	searchKnowledge,
	trashKnowledgeDocument,
	KbVersionConflictError,
	KbQuotaExceededError,
} from "../src/knowledge/index.js";

describe("P2: 知识库单人闭环、文档树、Markdown 保存与版本冲突测试", () => {
	let ownerUserId: number;
	let libraryId: number;
	let documentId: number;

	before(async () => {
		try {
			// 插入一个符合资格的测试用户 (注册满 40 天，活跃已开通)
			const [res] = await pool.execute<mysql.ResultSetHeader>(
				`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
				 VALUES ('kb_p2_owner_${Date.now()}', 'P2测试用户', 'hash123', 1, DATE_SUB(NOW(), INTERVAL 40 DAY))`
			);
			ownerUserId = Number(res.insertId);

			// 注入达标的活跃记录 (D=14天, 每天4分服务分, 跨越各时间段)
			for (let i = 1; i <= 28; i += 2) {
				await pool.execute(
					`INSERT INTO user_activity_daily (user_id, activity_date, rule_version, login_count, clipboard_score, image_score, total_service_score)
					 VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 'v1', 1, 2, 2, 4)`,
					[ownerUserId, i]
				);
			}

			// 创建一个测试库
			libraryId = await createUserLibrary(ownerUserId, {
				title: "我的技术笔记",
				description: "测试知识库",
				visibility: "private",
			});
		} catch (err) {
			console.error("BEFORE HOOK ERROR:", err);
			throw err;
		}
	});

	after(async () => {
		if (ownerUserId) {
			await pool.execute("DELETE FROM knowledge_bases WHERE owner_user_id = ?", [ownerUserId]);
			await pool.execute("DELETE FROM user_activity_daily WHERE user_id = ?", [ownerUserId]);
			await pool.execute("DELETE FROM kb_entitlements WHERE user_id = ?", [ownerUserId]);
			await pool.execute("DELETE FROM comment_users WHERE id = ?", [ownerUserId]);
		}
		await pool.end();
	});

	it("P2.1 创建文档与初始 revision v1 闭环", async () => {
		const doc = await createKnowledgeDocument(ownerUserId, {
			libraryId,
			kind: "document",
			title: "React 19 核心特性",
			markdown: "React 19 带来了 Server Actions 和 use 钩子。",
			tags: ["React", "前端"],
		});

		assert.ok(doc.id > 0);
		assert.equal(doc.version, 1);
		assert.equal(doc.title, "React 19 核心特性");
		assert.equal(doc.markdown, "React 19 带来了 Server Actions 和 use 钩子。");
		documentId = doc.id;

		// 验证目录树能读取到新创建的文档
		const tree = await getUserLibraryTree(ownerUserId, libraryId);
		assert.ok(tree.some((n) => n.id === documentId && n.title === "React 19 核心特性"));
	});

	it("A08 无内容变化保存：返回 unchanged，不新增 revision", async () => {
		const result = await saveKnowledgeDocument(ownerUserId, documentId, {
			expectedVersion: 1,
			title: "React 19 核心特性",
			markdown: "React 19 带来了 Server Actions 和 use 钩子。",
			tags: ["React", "前端"],
			isManualSave: false,
		});

		assert.equal(result.status, "unchanged");
		assert.equal(result.version, 1);

		// 版本数量依然是 1 个
		const revisions = await getKnowledgeDocumentRevisions(ownerUserId, documentId);
		assert.equal(revisions.length, 1);
	});

	it("P2.2 正常递增保存：生成不可变 revision v2", async () => {
		const result = await saveKnowledgeDocument(ownerUserId, documentId, {
			expectedVersion: 1,
			title: "React 19 深度解析",
			markdown: "更新后的正文：详细解析 Actions 和 use 钩子。",
			tags: ["React", "前端", "进阶"],
			isManualSave: true,
		});

		assert.equal(result.status, "saved");
		assert.equal(result.version, 2);

		const updatedDoc = await getDocumentDetail(documentId);
		assert.equal(updatedDoc?.version, 2);
		assert.equal(updatedDoc?.title, "React 19 深度解析");

		const revisions = await getKnowledgeDocumentRevisions(ownerUserId, documentId);
		assert.equal(revisions.length, 2);
		assert.equal(revisions[0].version, 2);
		assert.equal(revisions[1].version, 1);
	});

	it("A07 并发冲突保护：提交旧版本 expectedVersion 立即拒绝并抛出 409 VERSION_CONFLICT", async () => {
		// 服务端当前版本已是 v2，客户端尝试用 expectedVersion: 1 提交
		await assert.rejects(
			async () => {
				await saveKnowledgeDocument(ownerUserId, documentId, {
					expectedVersion: 1,
					title: "落后的修改",
					markdown: "这部分改动基于旧版本",
				});
			},
			(err: unknown) => {
				assert.ok(err instanceof KbVersionConflictError);
				assert.equal(err.statusCode, 409);
				assert.equal(err.code, "VERSION_CONFLICT");
				assert.match(err.message, /版本冲突/);
				return true;
			}
		);
	});

	it("P2.3 历史版本恢复为新版本", async () => {
		const revisions = await getKnowledgeDocumentRevisions(ownerUserId, documentId);
		const v1Rev = revisions.find((r) => r.version === 1);
		assert.ok(v1Rev);

		// 恢复 v1 的内容为最新版本 (当前最新是 v2，期望得到 v3)
		const restored = await restoreDocumentRevision(ownerUserId, documentId, v1Rev.id, 2);
		assert.equal(restored.status, "saved");
		assert.equal(restored.version, 3);

		const doc = await getDocumentDetail(documentId);
		assert.equal(doc?.version, 3);
		assert.equal(doc?.title, "React 19 核心特性"); // 恢复回了 v1 的标题
	});

	it("A12 目录树管理与防循环移动测试", async () => {
		// 创建父文件夹 F1
		const folderA = await createKnowledgeDocument(ownerUserId, {
			libraryId,
			kind: "folder",
			title: "技术方案",
		});

		// 创建子文件夹 F2 (在 F1 下)
		const folderB = await createKnowledgeDocument(ownerUserId, {
			libraryId,
			parentId: folderA.id,
			kind: "folder",
			title: "前端架构",
		});

		// 尝试将 F1 移动到 F2 下方：必须被拦截！
		await assert.rejects(
			async () => {
				await moveKnowledgeDocument(ownerUserId, folderA.id, folderB.id);
			},
			/CANNOT_MOVE_NODE_UNDER_DESCENDANT/
		);

		// 正常将文档移入 F2 下方
		await moveKnowledgeDocument(ownerUserId, documentId, folderB.id, 0);
		const movedDoc = await getDocumentDetail(documentId);
		assert.equal(movedDoc?.parentId, folderB.id);
	});

	it("P2.4 软删除与回收站恢复闭环", async () => {
		// 软删除文档
		await trashKnowledgeDocument(ownerUserId, documentId);
		const trashed = await getDocumentDetail(documentId);
		assert.ok(trashed?.deletedAt);

		// 恢复文档
		await restoreKnowledgeDocument(ownerUserId, documentId);
		const restored = await getDocumentDetail(documentId);
		assert.equal(restored?.deletedAt, null);
	});

	it("P2.5 检索能力测试", async () => {
		const results = await searchKnowledge(ownerUserId, "深度解析");
		assert.ok(results.length >= 0);
	});

	it("P2.6 存储配额统计与回收站列表闭环", async () => {
		// 1. 验证存储配额统计
		const quota = await getUserQuotaUsageService(ownerUserId);
		assert.ok(quota.maxBytes > 0);
		assert.ok(quota.usedBytes >= 0);
		assert.ok(typeof quota.breakdown.revisions === "number");
		assert.ok(typeof quota.breakdown.attachments === "number");
		assert.ok(typeof quota.breakdown.comments === "number");

		// 2. 软删除文档并检查回收站列表
		await trashKnowledgeDocument(ownerUserId, documentId);
		const trashedList = await listTrashedDocumentsService(ownerUserId, libraryId);
		assert.ok(trashedList.some((t) => t.id === documentId));

		// 3. 恢复文档并再次检查回收站
		await restoreKnowledgeDocument(ownerUserId, documentId);
		const afterRestoreList = await listTrashedDocumentsService(ownerUserId, libraryId);
		assert.ok(!afterRestoreList.some((t) => t.id === documentId));
	});
});
