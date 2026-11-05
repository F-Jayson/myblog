import type { PoolConnection } from "mysql2/promise";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { ACTIVITY_SERVICE_POINTS, KB_DEFAULTS } from "./constants.js";
import type {
	ActivityEventInput,
	ActivityType,
	EntitlementStatus,
	KbEligibilityResponse,
	KbEntitlement,
	UserActivityDailyRecord,
} from "./types.js";

/**
 * 判断注册时间是否严格超过 30 × 24 小时
 * 严禁使用整数天数或 >= 30 天替代
 */
export function isRegistrationAgeQualified(createdAt: Date | string | number, now = new Date()): boolean {
	const createdMs = typeof createdAt === "object" ? createdAt.getTime() : new Date(createdAt).getTime();
	if (Number.isNaN(createdMs)) return false;
	const diffMs = now.getTime() - createdMs;
	return diffMs > KB_DEFAULTS.AGE_REQUIREMENT_MS;
}

/**
 * 100 分制透明活跃分算法
 * score = round(50 * min(D/15, 1) + 35 * min(U/60, 1) + 15 * (W/4))
 */
export function calculateActivityScore(d: number, u: number, w: number): number {
	const dPart = 50 * Math.min(Math.max(0, d) / 15, 1);
	const uPart = 35 * Math.min(Math.max(0, u) / 60, 1);
	const wPart = 15 * (Math.min(Math.max(0, w), 4) / 4);
	return Math.round(dPart + uPart + wPart);
}

/**
 * 活跃达标综合判断：score >= 70 且 D >= 12 且 S >= 8 且 W >= 3
 */
export function isActivityQualified(score: number, d: number, s: number, w: number): boolean {
	return score >= KB_DEFAULTS.SCORE_PASS_THRESHOLD &&
		d >= KB_DEFAULTS.MIN_LOGIN_DAYS_D &&
		s >= KB_DEFAULTS.MIN_SERVICE_DAYS_S &&
		w >= KB_DEFAULTS.MIN_TIME_WINDOWS_W;
}

/**
 * 计算给定日期相对于截至日期的窗口段位 (1-7天: 段0, 8-14天: 段1, 15-21天: 段2, 22-30天: 段3)
 */
export function getWindowIndexForDayOffset(dayOffsetFromCutoff: number): number | null {
	if (dayOffsetFromCutoff >= 0 && dayOffsetFromCutoff < 7) return 0;
	if (dayOffsetFromCutoff >= 7 && dayOffsetFromCutoff < 14) return 1;
	if (dayOffsetFromCutoff >= 14 && dayOffsetFromCutoff < 21) return 2;
	if (dayOffsetFromCutoff >= 21 && dayOffsetFromCutoff < 30) return 3;
	return null;
}

/**
 * 获取当前已完成的最新 UTC 昨天日期字符串 (YYYY-MM-DD)
 */
export function getCutoffUtcDate(now = new Date()): string {
	const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
	return yesterday.toISOString().slice(0, 10);
}

/**
 * 获取今天的 UTC 日期字符串 (YYYY-MM-DD)
 */
export function getTodayUtcDate(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

/**
 * 计算纯内存/单元测试中的状态转换机
 */
export function computeEntitlementStatus(params: {
	isSuspended: boolean;
	isAgeQualified: boolean;
	isActivityQualified: boolean;
	activatedAt: Date | string | null;
	graceStartedAt: Date | string | null;
	now?: Date;
}): { status: EntitlementStatus; graceStartedAt: Date | string | null } {
	const now = params.now ?? new Date();

	if (params.isSuspended) {
		return { status: "suspended", graceStartedAt: params.graceStartedAt };
	}

	const isOverallQualified = params.isAgeQualified && params.isActivityQualified;

	// 已激活用户的状态流转
	if (params.activatedAt) {
		if (isOverallQualified) {
			// 恢复达标，自动回到 active，重置宽限时间
			return { status: "active", graceStartedAt: null };
		}
		// 跌落活跃度，计算宽限期
		let graceStart = params.graceStartedAt;
		if (!graceStart) {
			graceStart = now.toISOString();
		}
		const graceStartMs = typeof graceStart === "object" ? graceStart.getTime() : new Date(graceStart).getTime();
		const graceElapsed = now.getTime() - graceStartMs;

		if (graceElapsed <= KB_DEFAULTS.GRACE_PERIOD_MS) {
			return { status: "grace", graceStartedAt: graceStart };
		}
		return { status: "read_only", graceStartedAt: graceStart };
	}

	// 尚未激活的用户（未创建过自己的知识库）
	if (isOverallQualified) {
		return { status: "eligible", graceStartedAt: null };
	}

	// 尚未激活且不达标，或者纯协作者跌落，直接 locked，不享受宽限
	return { status: "locked", graceStartedAt: null };
}

/**
 * 生成缺少条件解释文本列表
 */
export function generateMissingConditions(params: {
	isAgeQualified: boolean;
	ageMs: number;
	score: number;
	d: number;
	s: number;
	w: number;
}): string[] {
	const missing: string[] = [];
	if (!params.isAgeQualified) {
		const remainingHours = Math.max(1, Math.ceil((KB_DEFAULTS.AGE_REQUIREMENT_MS - params.ageMs) / (3600 * 1000)));
		const remainingDays = Math.ceil(remainingHours / 24);
		missing.push(`注册时间未达严格 30 天门槛（还差约 ${remainingDays} 天 / ${remainingHours} 小时）`);
	}
	if (params.score < KB_DEFAULTS.SCORE_PASS_THRESHOLD) {
		missing.push(`活跃综合评分未达 ${KB_DEFAULTS.SCORE_PASS_THRESHOLD} 分（当前 ${params.score} 分）`);
	}
	if (params.d < KB_DEFAULTS.MIN_LOGIN_DAYS_D) {
		missing.push(`近 30 个自然日有效登录天数不足 ${KB_DEFAULTS.MIN_LOGIN_DAYS_D} 天（当前 ${params.d} 天）`);
	}
	if (params.s < KB_DEFAULTS.MIN_SERVICE_DAYS_S) {
		missing.push(`近 30 个自然日有效服务使用天数不足 ${KB_DEFAULTS.MIN_SERVICE_DAYS_S} 天（当前 ${params.s} 天）`);
	}
	if (params.w < KB_DEFAULTS.MIN_TIME_WINDOWS_W) {
		missing.push(`近 30 天活跃时间分布段不足 ${KB_DEFAULTS.MIN_TIME_WINDOWS_W} 段（当前覆盖 ${params.w} 段）`);
	}
	return missing;
}
