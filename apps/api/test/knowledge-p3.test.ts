import assert from "node:assert/strict";
import test, { after, before, describe, it } from "node:test";
import type mysql from "mysql2/promise";
import {
	addCommentService,
	checkDocumentAccess,
	createKnowledgeDocument,
	createShareLinkService,
	createUserLibrary,
	getDocumentDetail,
	getPublicDocumentSnapshotService,
	getSharedDocumentSnapshotService,
	listCommentsService,
	listDocumentAccessEntries,
	listDocumentShareLinksService,
	listLibraryMembersService,
	moveKnowledgeDocument,
	pool,
	publishKnowledgeDocumentService,
	resolveCommentService,
	revokeShareLinkService,
	saveKnowledgeDocument,
	unpublishKnowledgeDocumentService,
	updateDocumentAccessService,
	upsertLibraryMemberService,
	KbAccessDeniedError,
	KbNotFoundError,
} from "../src/knowledge/index.js";

describe("P3: 协作、受限ACL、草稿公开彻底隔离、分享链接与评论测试", () => {
	let ownerUserId: number;
	let editorUserId: number;
	let viewerUserId: number;
	let outsiderUserId: number;

	let libraryId: number;
	let docAId: number; // 根文档
	let folderRestrictedId: number; // 受限目录
	let docChildId: number; // 受限目录下的子文档

	before(async () => {
		try {
			// 1. 创建 4 个测试用户
			// 所有者
			const [resOwner] = await pool.execute<mysql.ResultSetHeader>(
				`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
				 VALUES ('kb_p3_owner_${Date.now()}', 'P3所有者', 'hash123', 1, DATE_SUB(NOW(), INTERVAL 40 DAY))`
			);
			ownerUserId = Number(resOwner.insertId);

			// 协作者 Editor
			const [resEditor] = await pool.execute<mysql.ResultSetHeader>(
				`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
				 VALUES ('kb_p3_editor_${Date.now()}', 'P3编辑员', 'hash123', 1, DATE_SUB(NOW(), INTERVAL 40 DAY))`
			);
			editorUserId = Number(resEditor.insertId);

			// 协作者 Viewer
			const [resViewer] = await pool.execute<mysql.ResultSetHeader>(
				`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
				 VALUES ('kb_p3_viewer_${Date.now()}', 'P3只读者', 'hash123', 1, DATE_SUB(NOW(), INTERVAL 40 DAY))`
			);
			viewerUserId = Number(resViewer.insertId);

			// 外部无关用户
			const [resOutsider] = await pool.execute<mysql.ResultSetHeader>(
				`INSERT INTO comment_users (account, nickname, password_hash, is_active, created_at)
				 VALUES ('kb_p3_outsider_${Date.now()}', 'P3路人', 'hash123', 1, DATE_SUB(NOW(), INTERVAL 40 DAY))`
			);
			outsiderUserId = Number(resOutsider.insertId);

			// 2. 为所有者与编辑员注入达标活跃流水
			for (const uid of [ownerUserId, editorUserId]) {
				for (let i = 1; i <= 28; i += 2) {
					await pool.execute(
						`INSERT INTO user_activity_daily (user_id, activity_date, rule_version, login_count, clipboard_score, image_score, total_service_score)
						 VALUES (?, DATE_SUB(CURDATE(), INTERVAL ? DAY), 'v1', 1, 2, 2, 4)`,
						[uid, i]
					);
				}
			}

			// 3. 创建测试库
			libraryId = await createUserLibrary(ownerUserId, {
				title: "P3协作测试知识库",
				description: "测试多用户协作与发布",
				visibility: "private",
			});

			// 4. 将 editor 添加为 editor 角色，viewer 添加为 viewer 角色
			await upsertLibraryMemberService(ownerUserId, libraryId, editorUserId, "editor");
			await upsertLibraryMemberService(ownerUserId, libraryId, viewerUserId, "viewer");

			// 5. 创建基础文档 docA
			const docA = await createKnowledgeDocument(ownerUserId, {
				libraryId,
				kind: "document",
				title: "公开方案白皮书",
				markdown: "这是第一版正文草稿，包含保密内容：SECRET_DRAFT_12345",
			});
			docAId = docA.id;

			// 6. 创建受限目录与子文档
			const folder = await createKnowledgeDocument(ownerUserId, {
				libraryId,
				kind: "folder",
				title: "内部核心机密目录",
			});
			folderRestrictedId = folder.id;

			const child = await createKnowledgeDocument(ownerUserId, {
				libraryId,
				parentId: folderRestrictedId,
				kind: "document",
				title: "机密子文档",
				markdown: "这是受限目录下的机密正文",
			});
			docChildId = child.id;
		} catch (err) {
			console.error("P3 BEFORE HOOK ERROR:", err);
			throw err;
		}
	});

	after(async () => {
		if (ownerUserId) {
			await pool.execute("DELETE FROM knowledge_bases WHERE owner_user_id = ?", [ownerUserId]);
			for (const uid of [ownerUserId, editorUserId, viewerUserId, outsiderUserId]) {
				await pool.execute("DELETE FROM user_activity_daily WHERE user_id = ?", [uid]);
				await pool.execute("DELETE FROM kb_entitlements WHERE user_id = ?", [uid]);
				await pool.execute("DELETE FROM comment_users WHERE id = ?", [uid]);
			}
		}
		await pool.end();
	});

	it("P3.1 库成员管理：成员列表、角色设定与鉴权", async () => {
		const members = await listLibraryMembersService(ownerUserId, libraryId);
		assert.equal(members.length, 2);
		assert.ok(members.some((m) => m.userId === editorUserId && m.role === "editor"));
		assert.ok(members.some((m) => m.userId === viewerUserId && m.role === "viewer"));

		// 验证非库成员（outsider）访问成员列表被拒绝
		await assert.rejects(
			async () => {
				await listLibraryMembersService(outsiderUserId, libraryId);
			},
			(err: unknown) => {
				assert.ok(err instanceof KbAccessDeniedError);
				return true;
			}
		);
	});

	it("P3.2 协作者权限判定：editor 可编辑文档，viewer 仅可读不可编辑", async () => {
		// 1. editor 保存文档
		const editResult = await saveKnowledgeDocument(editorUserId, docAId, {
			expectedVersion: 1,
			title: "公开方案白皮书 - Editor修改版",
			markdown: "Editor 补充了架构设计部分。",
		});
		assert.equal(editResult.status, "saved");
		assert.equal(editResult.version, 2);

		// 2. viewer 尝试保存文档：必须被拒绝！
		await assert.rejects(
			async () => {
				await saveKnowledgeDocument(viewerUserId, docAId, {
					expectedVersion: 2,
					title: "Viewer 越权修改",
					markdown: "试图非法修改",
				});
			},
			(err: unknown) => {
				assert.ok(err instanceof KbAccessDeniedError);
				return true;
			}
		);
	});

	it("A05 受限祖先名单与子级权限穿透判定", async () => {
		// 1. 将父文件夹设为 restricted，并且显式名单为空
		await updateDocumentAccessService(ownerUserId, folderRestrictedId, {
			accessMode: "restricted",
			explicitRoles: [],
		});

		// 2. editor 尝试访问子文档 docChildId：父节点受限且不在名单内，直接阻断！
		const accessBefore = await checkDocumentAccess({ userId: editorUserId }, docChildId);
		assert.equal(accessBefore.canRead, false);
		assert.equal(accessBefore.canEdit, false);

		// 3. 将 editor 添加到受限名单作为 editor
		await updateDocumentAccessService(ownerUserId, folderRestrictedId, {
			accessMode: "restricted",
			explicitRoles: [{ userId: editorUserId, role: "editor" }],
		});

		// 4. editor 再次访问子文档：被允许访问！
		const accessAfter = await checkDocumentAccess({ userId: editorUserId }, docChildId);
		assert.equal(accessAfter.canRead, true);
		assert.equal(accessAfter.canEdit, true);

		// 5. viewer 不在受限名单中：依旧阻断
		const viewerAccess = await checkDocumentAccess({ userId: viewerUserId }, docChildId);
		assert.equal(viewerAccess.canRead, false);
	});

	it("A09 草稿与公开彻底隔离：未发布前公开接口绝不外泄秘密，发布后生效，撤回后立即404", async () => {
		// 1. 文档 docA 当前包含草稿，但从未发布 (publishedRevisionId 为 null)
		await assert.rejects(
			async () => {
				await getPublicDocumentSnapshotService(docAId);
			},
			(err: unknown) => {
				assert.ok(err instanceof KbNotFoundError);
				return true;
			}
		);

		// 2. 发布快照 v2
		const pubResult = await publishKnowledgeDocumentService(ownerUserId, docAId);
		assert.ok(pubResult.publishedRevisionId > 0);

		// 3. 公开接口即可读取到已发布快照
		const snapshot = await getPublicDocumentSnapshotService(docAId);
		assert.equal(snapshot.id, docAId);
		assert.equal(snapshot.title, "公开方案白皮书 - Editor修改版");
		assert.ok(snapshot.markdown.includes("Editor 补充了架构设计部分"));

		// 4. 在草稿中写入机密内容升级到 v3，但不发布
		await saveKnowledgeDocument(ownerUserId, docAId, {
			expectedVersion: 2,
			title: "公开方案白皮书 - 包含测试机密v3",
			markdown: "机密草稿内容：TOP_SECRET_CODE_9999",
		});

		// 5. 校验公开接口读取的内容：依然是 v2 的快照，绝无 TOP_SECRET_CODE_9999！
		const snapshotAfterDraft = await getPublicDocumentSnapshotService(docAId);
		assert.ok(!snapshotAfterDraft.markdown.includes("TOP_SECRET_CODE_9999"));
		assert.ok(snapshotAfterDraft.markdown.includes("Editor 补充了架构设计部分"));

		// 6. 撤回公开发布快照
		await unpublishKnowledgeDocumentService(ownerUserId, docAId);

		// 7. 撤回后公开接口立即 404
		await assert.rejects(
			async () => {
				await getPublicDocumentSnapshotService(docAId);
			},
			(err: unknown) => {
				assert.ok(err instanceof KbNotFoundError);
				return true;
			}
		);
	});

	it("A10 安全分享链接：高熵哈希、免登录只读访问与即时撤销", async () => {
		// 1. 创建分享链接（7 天有效期）
		const shareLink = await createShareLinkService(ownerUserId, docAId, {
			expiresInDays: 7,
		});

		assert.ok(shareLink.id > 0);
		assert.ok(shareLink.token.length >= 32);
		assert.ok(shareLink.url.startsWith("/ks/"));

		// 2. 通过分享 Token 免登录读取文档快照
		const sharedData = await getSharedDocumentSnapshotService(shareLink.token);
		assert.equal(sharedData.document.id, docAId);
		assert.equal(sharedData.library.id, libraryId);

		// 3. 撤销分享链接
		await revokeShareLinkService(ownerUserId, shareLink.id);

		// 4. 撤销后再次访问立即返回 404
		await assert.rejects(
			async () => {
				await getSharedDocumentSnapshotService(shareLink.token);
			},
			(err: unknown) => {
				assert.ok(err instanceof KbNotFoundError);
				assert.match(err.message, /无效或已被撤回/);
				return true;
			}
		);

		// 5. 猜 Token 测试：随机输入一个未生成的 token 必须 404
		await assert.rejects(
			async () => {
				await getSharedDocumentSnapshotService("unreal_random_token_1234567890abcdef");
			},
			(err: unknown) => {
				assert.ok(err instanceof KbNotFoundError);
				return true;
			}
		);
	});

	it("P3.3 内部评论与状态流转闭环", async () => {
		// 1. Editor 发表内部评论
		const commentId = await addCommentService(editorUserId, docAId, {
			body: "这篇方案需要补充性能指标测试数据。",
			channel: "internal",
		});
		assert.ok(commentId > 0);

		// 2. 查看内部评论列表
		const comments = await listCommentsService(ownerUserId, docAId, "internal");
		assert.ok(comments.some((c) => c.id === commentId && c.body.includes("补充性能指标")));

		// 3. 标记评论为已解决
		await resolveCommentService(ownerUserId, commentId);

		const updatedComments = await listCommentsService(ownerUserId, docAId, "internal");
		const targetComment = updatedComments.find((c) => c.id === commentId);
		assert.ok(targetComment?.resolvedAt !== null);
	});
});
