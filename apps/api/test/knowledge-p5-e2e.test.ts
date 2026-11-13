import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import type mysql from "mysql2/promise";
import {
	pool,
	createUserLibrary,
	createKnowledgeDocument,
	saveKnowledgeDocument,
	getKnowledgeDocument,
	getKnowledgeDocumentRevisions,
	restoreDocumentRevision,
	trashKnowledgeDocument,
	restoreKnowledgeDocument,
	upsertLibraryMemberService,
	updateDocumentAccessService,
	checkDocumentAccess,
	publishKnowledgeDocumentService,
	unpublishKnowledgeDocumentService,
	getPublicDocumentSnapshotService,
	createShareLinkService,
	getSharedDocumentSnapshotService,
	revokeShareLinkService,
	addCommentService,
	listCommentsService,
	resolveCommentService,
	startKbDeviceRequest,
	approveKbDeviceRequest,
	pollKbDeviceToken,
	getKbGrantByToken,
	resetPollLimiterForTest,
	revokeAllKbUserGrants,
	getUserEligibility,
	getUserQuotaUsageService,
	searchKnowledge,
	KbVersionConflictError,
	KbNotFoundError,
	KbAccessDeniedError,
} from "../src/knowledge/index.js";

describe("P5: V1 综合端到端全链路验收测试 (覆盖 A01–A22 闭环)", { concurrency: 1 }, () => {
	let ownerUserId: number;
	let collaboratorUserId: number;
	let outsiderUserId: number;

	let libraryId: number;
	let folderId: number;
	let docId: number;
	const draftSecret = `SECRET_DRAFT_STAGE5_${Date.now()}`;
	const publishedSecret = `PUBLIC_RELEASE_NOTE_STAGE5_${Date.now()}`;

	before(async () => {
		// 1. 创建 3 个测试普通用户 (满足 35 天注册时长)
		const [res1] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_p5_owner_${Date.now()}', 'P5所有者', 'hash_owner', 1, DATE_SUB(NOW(), INTERVAL 35 DAY))`
		);
		ownerUserId = Number(res1.insertId);

		const [res2] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_p5_collab_${Date.now()}', 'P5协作者', 'hash_collab', 1, DATE_SUB(NOW(), INTERVAL 35 DAY))`
		);
		collaboratorUserId = Number(res2.insertId);

		const [res3] = await pool.execute<mysql.ResultSetHeader>(
			`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
			 VALUES ('kb_p5_outsider_${Date.now()}', 'P5路人', 'hash_outsider', 1, DATE_SUB(NOW(), INTERVAL 35 DAY))`
		);
		outsiderUserId = Number(res3.insertId);

		// 2. 为所有者与协作者注入活跃流水，满足准入资格
		for (const uid of [ownerUserId, collaboratorUserId]) {
			for (let i = 1; i <= 28; i += 2) {
				await pool.execute(
					`INSERT INTO user_activity_daily (user_id, activity_date, rule_version, login_count, clipboard_score, image_score, total_service_score)
					 VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 'v1', 1, 2, 2, 4)`,
					[uid, i]
				);
			}
		}

		// 3. 创建主测试库
		libraryId = await createUserLibrary(ownerUserId, {
			title: "P5综合验收知识库",
			description: "用于全链路场景验收",
			visibility: "public",
		});

		// 4. 创建分类目录
		const folder = await createKnowledgeDocument(ownerUserId, {
			libraryId,
			kind: "folder",
			title: "核心技术规范",
		});
		folderId = folder.id;

		// 5. 在目录下创建文档
		const doc = await createKnowledgeDocument(ownerUserId, {
			libraryId,
			parentId: folderId,
			kind: "document",
			title: "V1架构蓝图",
			markdown: `# V1 蓝图\n\n初始草稿：${draftSecret}`,
		});
		docId = doc.id;
	});

	after(async () => {
		try {
			if (ownerUserId) {
				await pool.execute("DELETE FROM knowledge_bases WHERE owner_user_id = ?", [ownerUserId]);
				for (const uid of [ownerUserId, collaboratorUserId, outsiderUserId]) {
					await pool.execute("DELETE FROM kb_user_grants WHERE user_id = ?", [uid]);
					await pool.execute("DELETE FROM kb_device_requests WHERE user_id = ?", [uid]);
					await pool.execute("DELETE FROM user_activity_daily WHERE user_id = ?", [uid]);
					await pool.execute("DELETE FROM kb_entitlements WHERE user_id = ?", [uid]);
					await pool.execute("DELETE FROM comment_users WHERE id = ?", [uid]);
				}
			}
		} catch {
			// ignore cleanup error
		}
	});

	it("E2E-1 资格确认与知识库配额状态 (A01-A03)", async () => {
		const eligibility = await getUserEligibility(ownerUserId);
		assert.ok(["eligible", "active"].includes(eligibility.status));
		assert.ok(eligibility.metrics.score >= 70, "活跃度得分应达标");

		// 配额状态
		const usage = await getUserQuotaUsageService(ownerUserId);
		assert.ok(usage.maxBytes > 0);
		assert.ok(typeof usage.usedBytes === "number");
		assert.ok(usage.breakdown);
	});

	it("E2E-2 树形组织与乐观锁版本冲突保护 (A07, A08)", async () => {
		// 1. 获取当前文档详情
		const doc = await getKnowledgeDocument(ownerUserId, docId);
		const currentVer = doc.version;

		// 2. 正常更新文档
		const updated = await saveKnowledgeDocument(ownerUserId, docId, {
			title: "V1架构蓝图 (修订)",
			markdown: `# V1 蓝图\n\n更新草稿：${draftSecret}`,
			expectedVersion: currentVer,
		});
		assert.equal(updated.version, currentVer + 1);

		// 3. 并发版本冲突：试图用过期的旧版本更新文档应触发 409 KbVersionConflictError
		await assert.rejects(
			async () => {
				await saveKnowledgeDocument(ownerUserId, docId, {
					title: "并发冲突覆盖",
					markdown: "应该被拦截的内容",
					expectedVersion: currentVer,
				});
			},
			(err: any) => {
				assert.equal(err.name, "KbVersionConflictError");
				assert.equal(err.code, "VERSION_CONFLICT");
				return true;
			}
		);

		// 4. 检查历史版本
		const revisions = await getKnowledgeDocumentRevisions(ownerUserId, docId);
		assert.ok(revisions.length >= 2, "应保留历史修订版本");
	});

	it("E2E-3 协作ACL、受限子树与权限穿透判定 (A04-A06, A14)", async () => {
		// 1. 将 collaborator 添加为知识库 editor
		await upsertLibraryMemberService(ownerUserId, libraryId, collaboratorUserId, "editor");

		// 2. 协作者此时具备编辑权限
		const accessBefore = await checkDocumentAccess({ userId: collaboratorUserId }, docId);
		assert.equal(accessBefore.canRead, true);
		assert.equal(accessBefore.canEdit, true);

		// 3. 路人无权限
		const accessOutsider = await checkDocumentAccess({ userId: outsiderUserId }, docId);
		assert.equal(accessOutsider.canEdit, false);

		// 4. 将目录设置为 restricted 受限模式，且名单为空
		await updateDocumentAccessService(ownerUserId, folderId, {
			accessMode: "restricted",
			explicitRoles: [],
		});

		// 5. 受限祖先拦截：由于父级目录 restricted 且协作者不在名单中，子文档只读/编辑权被穿透阻断
		const accessRestricted = await checkDocumentAccess({ userId: collaboratorUserId }, docId);
		assert.equal(accessRestricted.canRead, false, "受限祖先拦截生效，协作者丧失只读权");
		assert.equal(accessRestricted.canEdit, false, "受限祖先拦截生效，协作者丧失编辑权");

		// 6. 为协作者在父目录 folderId 上增加受限白名单授权
		await updateDocumentAccessService(ownerUserId, folderId, {
			accessMode: "restricted",
			explicitRoles: [{ userId: collaboratorUserId, role: "editor" }],
		});
		const accessGranted = await checkDocumentAccess({ userId: collaboratorUserId }, docId);
		assert.equal(accessGranted.canRead, true, "白名单中显式授权后恢复只读权");
		assert.equal(accessGranted.canEdit, true, "白名单中显式授权后恢复编辑权");

		// 7. 恢复目录为 inherit
		await updateDocumentAccessService(ownerUserId, folderId, {
			accessMode: "inherit",
			explicitRoles: [],
		});
	});

	it("E2E-4 草稿与公开快照彻底隔离 (A09, A10)", async () => {
		// 1. 文档此时未发布，公开接口查询必须 404
		await assert.rejects(async () => {
			await getPublicDocumentSnapshotService(docId);
		}, KbNotFoundError);

		// 2. 获取当前版本并保存公开版内容，发布快照
		const docBefore = await getKnowledgeDocument(ownerUserId, docId);
		await saveKnowledgeDocument(ownerUserId, docId, {
			title: "V1架构蓝图 (公开版)",
			markdown: `# 公开版蓝图\n\n这是公开可见内容：${publishedSecret}`,
			expectedVersion: docBefore.version,
		});
		await publishKnowledgeDocumentService(ownerUserId, docId);

		// 3. 此时公开接口应能读取到快照
		const pubSnapshot = await getPublicDocumentSnapshotService(docId);
		assert.ok(pubSnapshot);
		assert.match(pubSnapshot.markdown, new RegExp(publishedSecret));

		// 4. 所有者继续在草稿中编辑保密内容
		const docPublished = await getKnowledgeDocument(ownerUserId, docId);
		await saveKnowledgeDocument(ownerUserId, docId, {
			title: "V1架构蓝图 (草稿又修改了)",
			markdown: `# 公开版蓝图\n\n新草稿秘密：TOP_SECRET_DRAFT_9999`,
			expectedVersion: docPublished.version,
		});

		// 5. 彻底隔离验证：公开接口依然只能看到已发布的快照，绝不可见草稿秘密
		const pubSnapshotAfterDraftEdit = await getPublicDocumentSnapshotService(docId);
		assert.doesNotMatch(pubSnapshotAfterDraftEdit.markdown, /TOP_SECRET_DRAFT_9999/);
		assert.match(pubSnapshotAfterDraftEdit.markdown, new RegExp(publishedSecret));

		// 6. 搜索测试：未发布草稿关键词在搜索中隔离
		const searchDraft = await searchKnowledge(outsiderUserId, "TOP_SECRET_DRAFT_9999");
		assert.equal(searchDraft.length, 0, "路人绝不应检索到未公开草稿内容");

		// 7. 撤销发布：公开接口立即失效返回 404
		await unpublishKnowledgeDocumentService(ownerUserId, docId);
		await assert.rejects(async () => {
			await getPublicDocumentSnapshotService(docId);
		}, KbNotFoundError);
	});

	it("E2E-5 分享链接高熵与即时撤销闭环 (A10)", async () => {
		// 上一用例已撤回发布。分享链接只交付已发布快照，所以先重新发布。
		await publishKnowledgeDocumentService(ownerUserId, docId);
		// 1. 创建只读分享链接
		const link = await createShareLinkService(ownerUserId, docId, { expiresInDays: 3 });
		assert.ok(link.token);
		assert.ok(link.token.length >= 32);

		// 2. 匿名免登录通过 Token 查看文档
		const shared = await getSharedDocumentSnapshotService(link.token);
		assert.ok(shared);
		assert.equal(shared.document.id, docId);

		// 3. 撤销分享链接
		await revokeShareLinkService(ownerUserId, link.id);

		// 4. 再次访问立即 404
		await assert.rejects(async () => {
			await getSharedDocumentSnapshotService(link.token);
		}, KbNotFoundError);
	});

	it("E2E-6 多通道评论与标记解决闭环", async () => {
		// 1. 协作者发表内部评论
		const commentId = await addCommentService(collaboratorUserId, docId, {
			body: "请补充第3小节的架构图说明",
			channel: "internal",
		});
		assert.ok(typeof commentId === "number" && commentId > 0);

		// 2. 所有者列出内部评论
		const list = await listCommentsService(ownerUserId, docId, "internal");
		assert.ok(list.some((c) => c.id === commentId));

		// 3. 所有者标记评论解决
		await resolveCommentService(ownerUserId, commentId);
		const listAfter = await listCommentsService(ownerUserId, docId, "internal");
		const resolvedItem = listAfter.find((c) => c.id === commentId);
		assert.ok(resolvedItem?.resolvedAt !== null);
	});

	it("E2E-7 本地 MCP 适配器端到端授权与改密即刻失效 (A15-A18, A22)", async () => {
		resetPollLimiterForTest();

		// 1. 客户端发起设备请求
		const devReq = await startKbDeviceRequest("E2E-Test-Agent", ["kb:read", "kb:write"]);

		// 2. 所有者在浏览器授权页面批准，并限定范围为此 libraryId
		await approveKbDeviceRequest(
			devReq.userCode,
			ownerUserId,
			[libraryId],
			["kb:read", "kb:write"],
			7
		);

		// 3. 客户端获取 Token
		const tokenRes = await pollKbDeviceToken(devReq.deviceCode);
		assert.ok(tokenRes.accessToken);
		assert.deepEqual(tokenRes.scopes, ["kb:read", "kb:write"]);

		// 4. 用该 Token 查验 Grant
		const grant = await getKbGrantByToken(tokenRes.accessToken);
		assert.ok(grant);
		assert.equal(grant?.userId, ownerUserId);

		// 5. 用户改密后即时失效
		await revokeAllKbUserGrants(ownerUserId);
		const grantAfterPasswordChange = await getKbGrantByToken(tokenRes.accessToken);
		assert.equal(grantAfterPasswordChange, null, "改密后 MCP 令牌必须立刻失效");
	});

	it("E2E-8 软删除与回收站恢复闭环 (A12)", async () => {
		// 1. 软删除文档
		await trashKnowledgeDocument(ownerUserId, docId);

		// 2. 正常查询应拒绝 (已在回收站)
		await assert.rejects(
			async () => {
				await getKnowledgeDocument(ownerUserId, docId);
			},
			(err: any) => {
				assert.ok(err.name === "KbAccessDeniedError" || err.name === "KbNotFoundError");
				return true;
			}
		);

		// 3. 从回收站恢复文档
		await restoreKnowledgeDocument(ownerUserId, docId);

		// 4. 恢复后正常可查
		const restored = await getKnowledgeDocument(ownerUserId, docId);
		assert.equal(restored.id, docId);
	});

	after(async () => {
		try {
			await pool.end();
		} catch {
			// ignore pool close errors
		}
	});
});
