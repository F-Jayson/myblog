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
import { UserDeletionBlockedError } from "./errors.js";
import {
	getDailyActivitiesForPast30Days,
	getDocumentAncestors,
	getDocumentExplicitRoles,
	getDocumentRecord,
	getKbEntitlement,
	getLibraryMemberRole,
	getLibraryRecord,
	getUserRegistrationInfo,
	incrementDailyServiceScore,
	insertActivityEvent,
	recordDailyLogin,
	upsertKbEntitlement,
	userOwnsKnowledgeData,
} from "./repository.js";
import type {
	AccessEvaluationPrincipal,
	AccessEvaluationResult,
	ActivityType,
	KbEligibilityResponse,
	KbEntitlement,
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
		const actorEnt = await getKbEntitlement(principal.userId);
		actorEntitlement = actorEnt?.status;
	}

	const ownerEnt = await getKbEntitlement(lib.ownerUserId);
	ownerEntitlement = ownerEnt?.status;

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
