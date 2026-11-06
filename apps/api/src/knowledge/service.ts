import { createHash, randomBytes } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { evaluateAccess } from "./acl.js";
import { KB_DEFAULTS } from "./constants.js";
import {
	calculateActivityScore,
	computeEntitlementStatus,
	generateMissingConditions,
	getCutoffUtcDate,
	getTodayUtcDate,
	getWindowIndexForDayOffset,
	isActivityQualified,
	isRegistrationAgeQualified,
} from "./eligibility.js";
import {
	KbAccessDeniedError,
	KbNotEligibleError,
	KbNotFoundError,
	KbQuotaExceededError,
	KbVersionConflictError,
	UserDeletionBlockedError,
} from "./errors.js";
import { acquireKnowledgeLocks, assertOwnerQuotaAvailable, getOwnerKnowledgeUsage } from "./quota.js";
import {
	activateUserIfEligible,
	bindAttachmentsToRevision,
	checkDocumentConflictAndLock,
	countLibraryDocuments,
	countUserLibraries,
	createAttachment,
	createCommentRecord,
	createDocumentRecord,
	createLibrary,
	createRevisionRecord,
	createShareLinkRecord,
	deleteCommentRecord,
	findShareLinkByHash,
	getAttachment,
	getCommentRecord,
	getDailyActivitiesForPast30Days,
	getDocumentAncestors,
	getDocumentDetail,
	getDocumentExplicitRoles,
	getDocumentRecord,
	getDocumentRevisions,
	getKbEntitlement,
	getLibraryMemberRole,
	getLibraryRecord,
	getLibraryTreeNodes,
	getPublicDocumentSnapshot,
	getRevisionDetail,
	getShareLinkById,
	getUserRegistrationInfo,
	incrementDailyServiceScore,
	insertActivityEvent,
	listCommentsRecord,
	listDocumentAccessEntries,
	listDocumentAttachments,
	listDocumentShareLinks,
	listLibrariesForUser,
	listLibraryMembers,
	listTrashedDocuments,
	moveDocumentNode,
	pool,
	recordDailyLogin,
	removeDocumentExplicitAccess,
	removeLibraryMember,
	resolveCommentRecord,
	restoreDocumentTree,
	revokeShareLinkRecord,
	searchUserAccessibleDocuments,
	setDocumentAccessMode,
	setDocumentExplicitAccess,
	setDocumentPublishedRevision,
	softDeleteDocumentTree,
	softDeleteLibrary,
	updateDocumentCurrentRevision,
	updateLibrary,
	upsertKbEntitlement,
	upsertLibraryMember,
	userOwnsKnowledgeData,
} from "./repository.js";
import type {
	AccessEvaluationPrincipal,
	AccessEvaluationResult,
	ActivityType,
	AttachmentSummary,
	DocumentDetail,
	KbAccessMode,
	KbCommentItem,
	KbDocumentAccessItem,
	KbDocumentKind,
	KbEligibilityResponse,
	KbEntitlement,
	KbMemberItem,
	KbMemberRole,
	KbShareLinkItem,
	KbVisibility,
	LibrarySummary,
	PublicDocumentSnapshot,
	RevisionSummary,
	SearchResultItem,
	TreeNode,
} from "./types.js";

/**
 * 校验普通用户是否可被安全删除
 * 若名下仍有未过 30 天回收期的知识库，严格抛出 UserDeletionBlockedError (409)
 */
export async function assertUserCanBeDeleted(userId: number, connection?: PoolConnection): Promise<void> {
	const ownsKb = await userOwnsKnowledgeData(userId, connection);
	if (ownsKb) {
		throw new UserDeletionBlockedError();
	}
}

/**
 * 记录白名单业务行为事件
 */
export async function recordWhitelistActivity(params: {
	userId: number;
	activityType: ActivityType;
	idempotencyKey: string;
	fingerprint?: string;
}): Promise<boolean> {
	const today = getTodayUtcDate();
	const inserted = await insertActivityEvent({
		userId: params.userId,
		activityType: params.activityType,
		idempotencyKey: params.idempotencyKey,
		fingerprint: params.fingerprint || params.idempotencyKey,
	});

	if (inserted) {
		await incrementDailyServiceScore(params.userId, today, params.activityType);
	}
	return inserted;
}

/**
 * 记录普通用户每日登录
 */
export async function recordUserDailyLogin(userId: number): Promise<void> {
	const today = getTodayUtcDate();
	await recordDailyLogin(userId, today);
}

/**
 * 重新汇总并计算普通用户当前的知识库准入资格
 */
export async function getUserEligibility(userId: number, now = new Date()): Promise<KbEligibilityResponse> {
	const regInfo = await getUserRegistrationInfo(userId);
	if (!regInfo) {
		throw new Error("用户不存在");
	}

	const cutoffDate = getCutoffUtcDate(now);
	const cutoffTimeMs = new Date(cutoffDate + "T23:59:59.999Z").getTime();
	const dailyRecords = await getDailyActivitiesForPast30Days(userId, cutoffDate);

	// 1. 统计 D: 过去 30 个自然日中有效登录天数
	const daysWithLogin = dailyRecords.filter((r) => r.loginCount > 0);
	const d = daysWithLogin.length;

	// 2. 统计 U: 服务使用积分之和 (每日全服务合计最高 8 分已在底层保证)
	const u = dailyRecords.reduce((sum, r) => sum + r.totalServiceScore, 0);

	// 3. 统计 S: 产生至少一项有效服务行为的不同日期数
	const daysWithService = dailyRecords.filter((r) => r.totalServiceScore > 0);
	const s = daysWithService.length;

	// 4. 统计 W: 四个时间段分布段数 (段0: 1-7天, 段1: 8-14天, 段2: 15-21天, 段3: 22-30天)
	const activeWindows = new Set<number>();
	for (const record of daysWithService) {
		const recordDateMs = new Date(record.activityDate + "T00:00:00.000Z").getTime();
		const diffDays = Math.floor((cutoffTimeMs - recordDateMs) / (86400 * 1000));
		const winIndex = getWindowIndexForDayOffset(diffDays);
		if (winIndex !== null) {
			activeWindows.add(winIndex);
		}
	}
	const w = activeWindows.size;

	// 5. 计算分数与综合达标
	const score = calculateActivityScore(d, u, w);
	const isActQualified = isActivityQualified(score, d, s, w);

	const createdMs = regInfo.createdAt.getTime();
	const ageMs = now.getTime() - createdMs;
	const isAgeQual = isRegistrationAgeQualified(regInfo.createdAt, now);

	// 6. 读取既有资格并推演状态机
	const existing = await getKbEntitlement(userId);
	const statusOutcome = computeEntitlementStatus({
		isSuspended: !regInfo.isActive,
		isAgeQualified: isAgeQual,
		isActivityQualified: isActQualified,
		activatedAt: existing?.activatedAt ?? null,
		graceStartedAt: existing?.graceStartedAt ?? null,
		now,
	});

	// 7. 持久化资格快照
	const entitlementSnapshot: KbEntitlement = {
		userId,
		status: statusOutcome.status,
		score,
		loginDaysD: d,
		serviceScoreU: u,
		serviceDaysS: s,
		timeWindowsW: w,
		statDateCutoff: cutoffDate,
		ruleVersion: KB_DEFAULTS.RULE_VERSION,
		activatedAt: existing?.activatedAt ?? null,
		graceStartedAt: statusOutcome.graceStartedAt ? (typeof statusOutcome.graceStartedAt === "object" ? statusOutcome.graceStartedAt.toISOString() : statusOutcome.graceStartedAt) : null,
		restrictionReason: !regInfo.isActive ? "账号已被禁用" : null,
	};
	await upsertKbEntitlement(entitlementSnapshot);

	// 8. 组装响应结构
	const missingConditions = generateMissingConditions({
		isAgeQualified: isAgeQual,
		ageMs,
		score,
		d,
		s,
		w,
	});

	let graceDaysRemaining: number | null = null;
	if (statusOutcome.status === "grace" && statusOutcome.graceStartedAt) {
		const graceStartMs = new Date(statusOutcome.graceStartedAt).getTime();
		const elapsed = now.getTime() - graceStartMs;
		const remainingMs = Math.max(0, KB_DEFAULTS.GRACE_PERIOD_MS - elapsed);
		graceDaysRemaining = Math.ceil(remainingMs / (86400 * 1000));
	}

	return {
		userId,
		status: statusOutcome.status,
		isQualified: isAgeQual && isActQualified && regInfo.isActive,
		isAgeQualified: isAgeQual,
		isActivityQualified: isActQualified,
		registrationAgeDays: Math.floor(ageMs / (86400 * 1000)),
		metrics: {
			score,
			loginDaysD: d,
			serviceScoreU: u,
			serviceDaysS: s,
			timeWindowsW: w,
		},
		thresholds: {
			minScore: KB_DEFAULTS.SCORE_PASS_THRESHOLD,
			minLoginDaysD: KB_DEFAULTS.MIN_LOGIN_DAYS_D,
			minServiceDaysS: KB_DEFAULTS.MIN_SERVICE_DAYS_S,
			minTimeWindowsW: KB_DEFAULTS.MIN_TIME_WINDOWS_W,
			minAgeDays: 30,
		},
		missingConditions,
		statDateCutoff: cutoffDate,
		graceDaysRemaining,
		ruleVersion: KB_DEFAULTS.RULE_VERSION,
	};
}

/**
 * 校验指定主体对某篇文档的实时权限
 */
export async function checkDocumentAccess(
	principal: AccessEvaluationPrincipal,
	documentId: number,
): Promise<AccessEvaluationResult> {
	const doc = await getDocumentRecord(documentId);
	if (!doc) {
		return {
			canRead: false,
			canComment: false,
			canEdit: false,
			canPublish: false,
			canManage: false,
			canDelete: false,
			effectiveRole: null,
			denyReason: "DOCUMENT_NOT_FOUND",
		};
	}

	const lib = await getLibraryRecord(doc.libraryId);
	if (!lib) {
		return {
			canRead: false,
			canComment: false,
			canEdit: false,
			canPublish: false,
			canManage: false,
			canDelete: false,
			effectiveRole: null,
			denyReason: "LIBRARY_NOT_FOUND",
		};
	}

	const ancestors = await getDocumentAncestors(documentId);
	const allNodeIds = [doc.id, ...ancestors.map((a) => a.id)];

	let libraryMemberRole = null;
	let documentExplicitRoles = new Map();
	let actorEntitlement = undefined;
	let ownerEntitlement = undefined;

	if (principal.userId) {
		libraryMemberRole = await getLibraryMemberRole(doc.libraryId, principal.userId);
		documentExplicitRoles = await getDocumentExplicitRoles(allNodeIds, principal.userId);
		const actorEnt = await getUserEligibility(principal.userId);
		actorEntitlement = actorEnt.status;
	}

	const ownerEnt = await getUserEligibility(lib.ownerUserId);
	ownerEntitlement = ownerEnt.status;

	return evaluateAccess(principal, {
		targetDocument: {
			id: doc.id,
			libraryId: doc.libraryId,
			accessMode: doc.accessMode,
			publishedRevisionId: doc.publishedRevisionId,
			deletedAt: doc.deletedAt,
		},
		ancestors,
		library: {
			id: lib.id,
			ownerUserId: lib.ownerUserId,
			visibility: lib.visibility,
			deletedAt: lib.deletedAt,
		},
		libraryMemberRole,
		documentExplicitRoles,
		actorEntitlement,
		ownerEntitlement,
	});
}

/**
 * 校验用户创建新库资格并创建
 */
export async function createUserLibrary(
	userId: number,
	data: {
		title: string;
		description?: string;
		coverUrl?: string;
		visibility?: KbVisibility;
	},
): Promise<number> {
	const eligibility = await getUserEligibility(userId);
	if (!["eligible", "active"].includes(eligibility.status)) {
		throw new KbNotEligibleError("当前账号状态不可创建新知识库，需处于达标状态");
	}

	const currentCount = await countUserLibraries(userId);
	if (currentCount >= KB_DEFAULTS.MAX_LIBRARIES_PER_USER) {
		throw new Error(`知识库数量已达上限 (最多 ${KB_DEFAULTS.MAX_LIBRARIES_PER_USER} 个)`);
	}

	const libId = await createLibrary(userId, data);
	await activateUserIfEligible(userId);

	// 创建初始示例欢迎文档
	await createKnowledgeDocument(userId, {
		libraryId: libId,
		kind: "document",
		title: "欢迎使用个人知识库",
		markdown: "# 欢迎使用个人知识库\n\n这是你的第一篇知识库笔记。在这里，你可以记录学习笔记、整理项目方案或沉淀代码片段。\n\n- 支持 Markdown 语法与代码高亮\n- 自动保存与历史版本追溯\n- 细粒度私有/公开权限控制\n",
		tags: ["入门"],
	});

	return libId;
}

/**
 * 获取用户相关的知识库列表
 */
export async function listUserLibraries(userId: number): Promise<LibrarySummary[]> {
	return listLibrariesForUser(userId);
}

/**
 * 获取知识库目录树 (按层级结构组装或平铺列表)
 */
export async function getUserLibraryTree(
	userId: number,
	libraryId: number,
): Promise<TreeNode[]> {
	const lib = await getLibraryRecord(libraryId);
	if (!lib || lib.deletedAt) {
		throw new KbNotFoundError("知识库不存在");
	}

	// 权限检查
	const memberRole = await getLibraryMemberRole(libraryId, userId);
	const isOwner = lib.ownerUserId === userId;
	if (!isOwner && !memberRole && lib.visibility === "private") {
		throw new KbAccessDeniedError("无权访问该私有知识库目录");
	}

	return getLibraryTreeNodes(libraryId);
}

/**
 * 创建新文档或文件夹
 */
export async function createKnowledgeDocument(
	userId: number,
	data: {
		libraryId: number;
		parentId?: number | null;
		kind: KbDocumentKind;
		title: string;
		markdown?: string;
		tags?: string[];
		sourceUrl?: string;
		accessMode?: "inherit" | "members_only" | "restricted";
	},
): Promise<DocumentDetail> {
	const lib = await getLibraryRecord(data.libraryId);
	if (!lib || lib.deletedAt) {
		throw new KbNotFoundError("目标知识库不存在");
	}

	// 权限判断：必须有写权限
	const isOwner = lib.ownerUserId === userId;
	const memberRole = await getLibraryMemberRole(data.libraryId, userId);
	const canEdit = isOwner || memberRole === "manager" || memberRole === "editor";
	if (!canEdit) {
		throw new KbAccessDeniedError("没有在该知识库创建文档的权限");
	}

	// 数量限制
	const totalDocs = await countLibraryDocuments(data.libraryId);
	if (totalDocs >= KB_DEFAULTS.MAX_DOCUMENTS_PER_LIBRARY) {
		throw new Error(`单库文档数已达上限 (${KB_DEFAULTS.MAX_DOCUMENTS_PER_LIBRARY} 篇)`);
	}

	// 父级层级检查
	let parentDepth = 0;
	if (data.parentId) {
		const parentDoc = await getDocumentRecord(data.parentId);
		if (!parentDoc || parentDoc.libraryId !== data.libraryId || parentDoc.deletedAt) {
			throw new KbNotFoundError("指定的父级文件夹不存在");
		}
		const ancestors = await getDocumentAncestors(data.parentId);
		parentDepth = ancestors.length + 1;
		if (parentDepth >= KB_DEFAULTS.MAX_TREE_DEPTH) {
			throw new Error(`目录树深度不能超过 ${KB_DEFAULTS.MAX_TREE_DEPTH} 层`);
		}
	}

	const markdownContent = data.markdown ?? "";
	const byteSize = Buffer.byteLength(markdownContent, "utf8");
	const contentHash = createHash("sha256").update(markdownContent).digest("hex");

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		// 配额检查与加锁
		await acquireKnowledgeLocks(conn, { ownerUserId: lib.ownerUserId, libraryId: lib.id });
		await assertOwnerQuotaAvailable(conn, lib.ownerUserId, byteSize);

		// 创建文档记录
		const documentId = await createDocumentRecord(
			{
				libraryId: data.libraryId,
				parentId: data.parentId ?? null,
				kind: data.kind,
				accessMode: data.accessMode ?? "inherit",
			},
			conn,
		);

		// 创建初始 revision (v1)
		const revisionId = await createRevisionRecord(
			{
				documentId,
				version: 1,
				title: data.title.trim(),
				markdown: markdownContent,
				tags: data.tags ?? [],
				sourceUrl: data.sourceUrl ?? "",
				contentHash,
				byteSize,
				actorUserId: userId,
			},
			conn,
		);

		// 更新当前 revision 指针
		await updateDocumentCurrentRevision(documentId, revisionId, 1, conn);

		await conn.commit();

		const detail = await getDocumentDetail(documentId);
		if (!detail) throw new Error("创建文档后读取失败");
		return detail;
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/**
 * 读取文档详情（附带权限校验）
 */
export async function getKnowledgeDocument(
	userId: number | undefined,
	documentId: number,
): Promise<DocumentDetail> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError(access.denyReason || "没有读取该文档的权限");
	}

	const detail = await getDocumentDetail(documentId);
	if (!detail || detail.deletedAt) {
		throw new KbNotFoundError("文档不存在或已被删除");
	}
	return detail;
}

/**
 * 带有乐观并发版本控制的 Markdown 保存
 */
export async function saveKnowledgeDocument(
	userId: number,
	documentId: number,
	data: {
		expectedVersion: number;
		title: string;
		markdown: string;
		tags?: string[];
		sourceUrl?: string;
		isManualSave?: boolean;
	},
): Promise<{ status: "saved" | "unchanged"; version: number; revisionId?: number }> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canEdit) {
		throw new KbAccessDeniedError(access.denyReason || "没有编辑该文档的权限");
	}

	const doc = await getDocumentRecord(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("文档不存在或已被删除");
	const lib = await getLibraryRecord(doc.libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");

	const newMarkdown = data.markdown;
	const newTitle = data.title.trim();
	const newTags = data.tags ?? [];
	const newSourceUrl = data.sourceUrl?.trim() ?? "";
	const byteSize = Buffer.byteLength(newMarkdown, "utf8");
	const contentHash = createHash("sha256").update(newMarkdown).digest("hex");

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		// 1. 统一锁顺序：所有者账号 -> 库 -> 文档
		await acquireKnowledgeLocks(conn, {
			ownerUserId: lib.ownerUserId,
			libraryId: lib.id,
			documentId,
		});

		// 2. 检查版本冲突
		const check = await checkDocumentConflictAndLock(documentId, data.expectedVersion, conn);
		if (check.isConflict) {
			throw new KbVersionConflictError(
				`版本冲突：当前服务端版本为 v${check.currentVersion}，您提交的版本为 v${data.expectedVersion}。请合并后重试`,
			);
		}

		// 3. 检查是否有实质内容变更
		if (check.currentRevisionId) {
			const currentRev = await getRevisionDetail(check.currentRevisionId, conn);
			if (
				currentRev &&
				currentRev.title === newTitle &&
				currentRev.markdown === newMarkdown &&
				JSON.stringify(currentRev.tags) === JSON.stringify(newTags) &&
				currentRev.sourceUrl === newSourceUrl
			) {
				await conn.commit();
				return { status: "unchanged", version: check.currentVersion };
			}
		}

		// 4. 校验配额
		await assertOwnerQuotaAvailable(conn, lib.ownerUserId, byteSize);

		// 5. 递增版本并创建不可变 revision
		const nextVersion = check.currentVersion + 1;
		const revisionId = await createRevisionRecord(
			{
				documentId,
				version: nextVersion,
				title: newTitle,
				markdown: newMarkdown,
				tags: newTags,
				sourceUrl: newSourceUrl,
				contentHash,
				byteSize,
				actorUserId: userId,
			},
			conn,
		);

		await updateDocumentCurrentRevision(documentId, revisionId, nextVersion, conn);

		await conn.commit();

		// 6. 若为手动保存，触发白名单积分记录
		if (data.isManualSave) {
			void recordWhitelistActivity({
				userId,
				activityType: "kb_manual_save",
				idempotencyKey: `kb_save_${documentId}_${nextVersion}`,
				fingerprint: contentHash,
			}).catch(() => undefined);
		}

		return { status: "saved", version: nextVersion, revisionId };
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/**
 * 移动目录节点（防循环回路与深度上限校验）
 */
export async function moveKnowledgeDocument(
	userId: number,
	documentId: number,
	targetParentId: number | null,
	sortOrder = 0,
): Promise<void> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canEdit) {
		throw new KbAccessDeniedError(access.denyReason || "没有移动该节点的权限");
	}

	const doc = await getDocumentRecord(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("文档不存在");

	if (targetParentId !== null) {
		if (targetParentId === documentId) {
			throw new Error("不能将节点移动到自己下方");
		}
		const parentDoc = await getDocumentRecord(targetParentId);
		if (!parentDoc || parentDoc.libraryId !== doc.libraryId || parentDoc.deletedAt) {
			throw new KbNotFoundError("目标父节点不存在或不属于同一知识库");
		}

		// 防循环回路：目标父节点的祖先链不能包含被移动的 documentId
		const parentAncestors = await getDocumentAncestors(targetParentId);
		if (parentAncestors.some((a) => a.id === documentId)) {
			throw new Error("CANNOT_MOVE_NODE_UNDER_DESCENDANT: 禁止将父目录移动到自己的子目录下方");
		}

		// 检查移动后的深度是否超过 20
		if (parentAncestors.length + 1 >= KB_DEFAULTS.MAX_TREE_DEPTH) {
			throw new Error(`目录树最大深度不能超过 ${KB_DEFAULTS.MAX_TREE_DEPTH} 层`);
		}
	}

	await moveDocumentNode(documentId, targetParentId, sortOrder);
}

/**
 * 软删除文档（放入回收站）
 */
export async function trashKnowledgeDocument(
	userId: number,
	documentId: number,
): Promise<void> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canDelete) {
		throw new KbAccessDeniedError(access.denyReason || "没有删除该文档的权限");
	}
	await softDeleteDocumentTree(documentId);
}

/**
 * 从回收站恢复文档
 */
export async function restoreKnowledgeDocument(
	userId: number,
	documentId: number,
): Promise<void> {
	const doc = await getDocumentRecord(documentId);
	if (!doc) throw new KbNotFoundError("文档不存在");
	const lib = await getLibraryRecord(doc.libraryId);
	if (!lib) throw new KbNotFoundError("知识库不存在");

	const isOwner = lib.ownerUserId === userId;
	const memberRole = await getLibraryMemberRole(doc.libraryId, userId);
	if (!isOwner && memberRole !== "manager" && memberRole !== "editor") {
		throw new KbAccessDeniedError("没有恢复该文档的权限");
	}

	await restoreDocumentTree(documentId);
}

/**
 * 获取知识库回收站中的文档列表
 */
export async function listTrashedDocumentsService(
	userId: number,
	libraryId: number,
) {
	const lib = await getLibraryRecord(libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");
	const isOwner = lib.ownerUserId === userId;
	const memberRole = await getLibraryMemberRole(libraryId, userId);
	if (!isOwner && memberRole !== "manager" && memberRole !== "editor") {
		throw new KbAccessDeniedError("无权查看该知识库的回收站");
	}
	return listTrashedDocuments(libraryId);
}

/**
 * 获取用户当前的知识库存储配额使用详情
 */
export async function getUserQuotaUsageService(userId: number) {
	const conn = await pool.getConnection();
	try {
		const usage = await getOwnerKnowledgeUsage(conn, userId);
		return {
			usedBytes: usage.totalBytes,
			maxBytes: KB_DEFAULTS.MAX_STORAGE_BYTES_PER_OWNER,
			breakdown: {
				revisions: usage.revisions,
				comments: usage.comments,
				attachments: usage.attachments,
			},
		};
	} finally {
		conn.release();
	}
}

/**
 * 获取文档历史版本列表
 */
export async function getKnowledgeDocumentRevisions(
	userId: number,
	documentId: number,
): Promise<RevisionSummary[]> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError(access.denyReason || "没有查看版本历史的权限");
	}
	return getDocumentRevisions(documentId);
}

/**
 * 恢复历史版本为新版本
 */
export async function restoreDocumentRevision(
	userId: number,
	documentId: number,
	revisionId: number,
	expectedVersion: number,
): Promise<{ status: "saved"; version: number }> {
	const rev = await getRevisionDetail(revisionId);
	if (!rev || rev.documentId !== documentId) {
		throw new KbNotFoundError("指定的历史版本不存在");
	}

	const saveResult = await saveKnowledgeDocument(userId, documentId, {
		expectedVersion,
		title: rev.title,
		markdown: rev.markdown,
		tags: rev.tags,
		sourceUrl: rev.sourceUrl,
		isManualSave: true,
	});

	if (saveResult.status === "unchanged") {
		return { status: "saved", version: saveResult.version };
	}
	return { status: "saved", version: saveResult.version };
}

/**
 * 全文检索接口
 */
export async function searchKnowledge(
	userId: number,
	query: string,
	libraryId?: number,
): Promise<SearchResultItem[]> {
	return searchUserAccessibleDocuments(userId, query, libraryId);
}

/**
 * 上传附件元数据记录
 */
export async function registerAttachment(
	userId: number,
	documentId: number,
	file: {
		storageKey: string;
		filename: string;
		mimeType: string;
		byteSize: number;
	},
): Promise<number> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canEdit) {
		throw new KbAccessDeniedError(access.denyReason || "没有上传附件的权限");
	}

	const doc = await getDocumentRecord(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("目标文档不存在");
	const lib = await getLibraryRecord(doc.libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");

	// 校验单文件大小上限 (10 MiB)
	if (file.byteSize > KB_DEFAULTS.MAX_ATTACHMENT_BYTES) {
		throw new Error(`单附件体积不能超过 ${(KB_DEFAULTS.MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0)} MiB`);
	}

	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();
		await acquireKnowledgeLocks(conn, { ownerUserId: lib.ownerUserId, libraryId: lib.id, documentId });
		await assertOwnerQuotaAvailable(conn, lib.ownerUserId, file.byteSize);

		const attId = await createAttachment(
			{
				libraryId: doc.libraryId,
				documentId,
				ownerUserId: lib.ownerUserId,
				uploaderUserId: userId,
				storageKey: file.storageKey,
				filename: file.filename,
				mimeType: file.mimeType,
				byteSize: file.byteSize,
				status: "bound",
			},
			conn,
		);

		await conn.commit();
		return attId;
	} catch (error) {
		await conn.rollback();
		throw error;
	} finally {
		conn.release();
	}
}

/**
 * 获取可下载的附件元数据（含鉴权）
 */
export async function getAuthorizedAttachment(
	userId: number | undefined,
	attachmentId: number,
): Promise<{
	id: number;
	libraryId: number;
	filename: string;
	mimeType: string;
	byteSize: number;
	storageKey: string;
}> {
	const att = await getAttachment(attachmentId);
	if (!att) throw new KbNotFoundError("附件不存在");

	const access = await checkDocumentAccess({ userId }, att.documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError("无权下载此私有附件");
	}

	return {
		id: att.id,
		libraryId: att.libraryId,
		filename: att.filename,
		mimeType: att.mimeType,
		byteSize: att.byteSize,
		storageKey: att.storageKey,
	};
}

/**
 * 列出文档的所有附件
 */
export async function listDocumentAttachmentsService(
	userId: number | undefined,
	documentId: number,
): Promise<AttachmentSummary[]> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError("无权查看此文档附件");
	}
	return listDocumentAttachments(documentId);
}

/**
 * =========================================================================
 * P3: 成员管理、单篇ACL、快照发布、分享链接与多通道评论服务
 * =========================================================================
 */

export async function listLibraryMembersService(
	userId: number,
	libraryId: number,
): Promise<KbMemberItem[]> {
	const lib = await getLibraryRecord(libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");
	const role = await getLibraryMemberRole(libraryId, userId);
	if (lib.ownerUserId !== userId && !role) {
		throw new KbAccessDeniedError("无权查看该知识库的成员列表");
	}
	return listLibraryMembers(libraryId);
}

export async function upsertLibraryMemberService(
	userId: number,
	libraryId: number,
	targetUserId: number,
	role: KbMemberRole,
): Promise<void> {
	const lib = await getLibraryRecord(libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");
	const isOwner = lib.ownerUserId === userId;
	const myRole = await getLibraryMemberRole(libraryId, userId);

	if (!isOwner && myRole !== "manager") {
		throw new KbAccessDeniedError("仅所有者或管理员可添加/修改协作者");
	}

	if (targetUserId === lib.ownerUserId) {
		throw new Error("知识库所有者角色不可更改");
	}

	if (!isOwner && role === "manager") {
		throw new KbAccessDeniedError("仅知识库所有者可委任 manager 管理员");
	}

	await upsertLibraryMember(libraryId, targetUserId, role, userId);
}

export async function removeLibraryMemberService(
	userId: number,
	libraryId: number,
	targetUserId: number,
): Promise<void> {
	const lib = await getLibraryRecord(libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");
	const isOwner = lib.ownerUserId === userId;
	const myRole = await getLibraryMemberRole(libraryId, userId);

	if (targetUserId === lib.ownerUserId) {
		throw new Error("不可移除知识库所有者");
	}

	const isSelfLeaving = userId === targetUserId;
	if (!isSelfLeaving && !isOwner && myRole !== "manager") {
		throw new KbAccessDeniedError("没有移除协作者的权限");
	}

	await removeLibraryMember(libraryId, targetUserId);
}

export async function getDocumentAccessService(
	userId: number,
	documentId: number,
): Promise<{
	accessMode: KbAccessMode;
	entries: KbDocumentAccessItem[];
}> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError(access.denyReason || "没有查看权限设置的权限");
	}
	const doc = await getDocumentRecord(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("文档不存在");

	const entries = await listDocumentAccessEntries(documentId);
	return {
		accessMode: doc.accessMode,
		entries,
	};
}

export async function updateDocumentAccessService(
	userId: number,
	documentId: number,
	data: {
		accessMode: KbAccessMode;
		explicitRoles?: Array<{ userId: number; role: "editor" | "commenter" | "viewer" }>;
	},
): Promise<void> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canManage) {
		throw new KbAccessDeniedError(access.denyReason || "仅库所有者或管理员可配置单篇受限名单");
	}

	await setDocumentAccessMode(documentId, data.accessMode);

	if (data.explicitRoles !== undefined) {
		const currentEntries = await listDocumentAccessEntries(documentId);
		for (const current of currentEntries) {
			await removeDocumentExplicitAccess(documentId, current.userId);
		}
		for (const entry of data.explicitRoles) {
			await setDocumentExplicitAccess(documentId, entry.userId, entry.role);
		}
	}
}

export async function publishKnowledgeDocumentService(
	userId: number,
	documentId: number,
	revisionId?: number,
): Promise<{ publishedRevisionId: number }> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canPublish && !access.canManage) {
		throw new KbAccessDeniedError(access.denyReason || "没有发布快照的权限");
	}

	const doc = await getDocumentDetail(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("文档不存在");

	let targetRevisionId = revisionId;
	if (!targetRevisionId) {
		if (!doc.currentRevisionId) {
			throw new Error("文档没有可发布的版本");
		}
		targetRevisionId = doc.currentRevisionId;
	} else {
		const rev = await getRevisionDetail(targetRevisionId);
		if (!rev || rev.documentId !== documentId) {
			throw new Error("指定的版本不属于该文档");
		}
	}

	await setDocumentPublishedRevision(documentId, targetRevisionId);
	return { publishedRevisionId: targetRevisionId };
}

export async function unpublishKnowledgeDocumentService(
	userId: number,
	documentId: number,
): Promise<void> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canPublish && !access.canManage) {
		throw new KbAccessDeniedError(access.denyReason || "没有撤回发布的权限");
	}

	await setDocumentPublishedRevision(documentId, null);
}

export async function getPublicDocumentSnapshotService(
	documentId: number,
): Promise<PublicDocumentSnapshot> {
	const snapshot = await getPublicDocumentSnapshot(documentId);
	if (!snapshot) {
		throw new KbNotFoundError("公开快照不存在或已被撤回");
	}
	return snapshot;
}

export async function createShareLinkService(
	userId: number,
	documentId: number,
	options: {
		expiresInDays?: number;
		includeDescendants?: boolean;
	} = {},
): Promise<{ id: number; token: string; url: string; expiresAt: string | null }> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError(access.denyReason || "没有访问该文档的权限");
	}

	const doc = await getDocumentRecord(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("文档不存在");

	const token = randomBytes(32).toString("hex");
	const tokenHash = createHash("sha256").update(token).digest("hex");

	const days = options.expiresInDays && options.expiresInDays > 0 ? options.expiresInDays : KB_DEFAULTS.DEFAULT_SHARE_LINK_EXPIRY_DAYS;
	const expiresDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	const expiresAt = expiresDate.toISOString().slice(0, 19).replace("T", " ");

	const linkId = await createShareLinkRecord({
		libraryId: doc.libraryId,
		targetDocumentId: documentId,
		tokenHash,
		expiresAt,
		includeDescendants: Boolean(options.includeDescendants),
	});

	return {
		id: linkId,
		token,
		url: `/ks/${token}`,
		expiresAt,
	};
}

export async function listDocumentShareLinksService(
	userId: number,
	documentId: number,
): Promise<KbShareLinkItem[]> {
	const access = await checkDocumentAccess({ userId }, documentId);
	if (!access.canRead) {
		throw new KbAccessDeniedError("无权查看该文档的分享链接");
	}
	return listDocumentShareLinks(documentId);
}

export async function revokeShareLinkService(
	userId: number,
	linkId: number,
): Promise<void> {
	const link = await getShareLinkById(linkId);
	if (!link) throw new KbNotFoundError("分享链接不存在");
	const lib = await getLibraryRecord(link.libraryId);
	if (!lib) throw new KbNotFoundError("知识库不存在");

	const isOwner = lib.ownerUserId === userId;
	const memberRole = await getLibraryMemberRole(link.libraryId, userId);
	if (!isOwner && memberRole !== "manager") {
		throw new KbAccessDeniedError("仅所有者或管理员可撤回分享链接");
	}

	await revokeShareLinkRecord(linkId);
}

export async function getSharedDocumentSnapshotService(
	token: string,
): Promise<{
	document: DocumentDetail;
	library: LibrarySummary;
	includeDescendants: boolean;
}> {
	const tokenHash = createHash("sha256").update(token).digest("hex");
	const link = await findShareLinkByHash(tokenHash);
	if (!link || link.revokedAt) {
		throw new KbNotFoundError("分享链接无效或已被撤回");
	}

	if (link.expiresAt) {
		const expTime = new Date(link.expiresAt).getTime();
		if (Date.now() > expTime) {
			throw new KbNotFoundError("分享链接已过期");
		}
	}

	if (!link.targetDocumentId) {
		throw new KbNotFoundError("分享链接未指向有效文档");
	}

	const doc = await getDocumentDetail(link.targetDocumentId);
	if (!doc || doc.deletedAt) {
		throw new KbNotFoundError("文档不存在或已被删除");
	}

	const lib = await getLibraryRecord(link.libraryId);
	if (!lib || lib.deletedAt) {
		throw new KbNotFoundError("知识库不存在");
	}

	return {
		document: doc,
		library: {
			id: lib.id,
			ownerUserId: lib.ownerUserId,
			title: lib.title,
			description: "",
			coverUrl: "",
			visibility: lib.visibility,
			discoveryEnabled: lib.discoveryEnabled,
			publicCommentsEnabled: lib.publicCommentsEnabled,
			documentCount: 0,
			createdAt: "",
			updatedAt: "",
		},
		includeDescendants: link.includeDescendants,
	};
}

export async function addCommentService(
	userId: number,
	documentId: number,
	data: {
		body: string;
		channel: "internal" | "public";
		parentId?: number | null;
	},
): Promise<number> {
	const cleanBody = data.body.trim();
	if (!cleanBody) throw new Error("评论内容不能为空");
	if (cleanBody.length > 5000) throw new Error("评论内容不能超过 5000 字");

	const doc = await getDocumentDetail(documentId);
	if (!doc || doc.deletedAt) throw new KbNotFoundError("文档不存在");
	const lib = await getLibraryRecord(doc.libraryId);
	if (!lib || lib.deletedAt) throw new KbNotFoundError("知识库不存在");

	const byteSize = Buffer.byteLength(cleanBody, "utf8");

	if (data.channel === "internal") {
		const access = await checkDocumentAccess({ userId }, documentId);
		if (!access.canComment) {
			throw new KbAccessDeniedError(access.denyReason || "没有在该文档添加内部评论的权限");
		}
	} else {
		if (!doc.publishedRevisionId) {
			throw new Error("未发布的文档不可添加公开评论");
		}
	}

	const conn = await pool.getConnection();
	try {
		await acquireKnowledgeLocks(conn, { ownerUserId: lib.ownerUserId, libraryId: lib.id, documentId });
		await assertOwnerQuotaAvailable(conn, lib.ownerUserId, byteSize);
	} finally {
		conn.release();
	}

	const currentRevId = data.channel === "internal" ? (doc.currentRevisionId ?? 0) : doc.publishedRevisionId!;

	return createCommentRecord({
		libraryId: doc.libraryId,
		documentId,
		revisionId: currentRevId,
		parentId: data.parentId,
		authorUserId: userId,
		body: cleanBody,
		byteSize,
		channel: data.channel,
		moderationStatus: "approved",
	});
}

export async function listCommentsService(
	userId: number | null,
	documentId: number,
	channel: "internal" | "public",
): Promise<KbCommentItem[]> {
	if (channel === "internal") {
		if (!userId) throw new KbAccessDeniedError("请先登录查看内部评论");
		const access = await checkDocumentAccess({ userId }, documentId);
		if (!access.canRead) throw new KbAccessDeniedError("无权查看内部评论");
		return listCommentsRecord(documentId, { channel: "internal" });
	}

	return listCommentsRecord(documentId, { channel: "public" });
}

export async function resolveCommentService(
	userId: number,
	commentId: number,
): Promise<void> {
	const comment = await getCommentRecord(commentId);
	if (!comment) throw new KbNotFoundError("评论不存在");

	const access = await checkDocumentAccess({ userId }, comment.documentId);
	const isAuthor = comment.authorUserId === userId;

	if (!access.canManage && !access.canEdit && !isAuthor) {
		throw new KbAccessDeniedError("没有标记该评论为已解决的权限");
	}

	await resolveCommentRecord(commentId);
}


