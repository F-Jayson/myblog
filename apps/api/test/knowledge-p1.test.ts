import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import {
	KB_DEFAULTS,
	calculateActivityScore,
	computeEntitlementStatus,
	evaluateAccess,
	generateMissingConditions,
	getWindowIndexForDayOffset,
	isActivityQualified,
	isRegistrationAgeQualified,
	UserDeletionBlockedError,
} from "../src/knowledge/index.js";
import type {
	AccessEvaluationContext,
	AccessEvaluationPrincipal,
	EntitlementStatus,
	KbMemberRole,
} from "../src/knowledge/types.js";

describe("P1: 知识库核心契约与安全单元测试", () => {
	// =========================================================================
	// A01: 注册时间严格边界测试
	// =========================================================================
	describe("A01: 注册时间严格边界测试", () => {
		const fixedNow = new Date("2026-11-05T12:00:00.000Z");
		const exact30DaysMs = 30 * 24 * 60 * 60 * 1000;

		it("注册时间不足 30 天：返回 false", () => {
			// 29 天 23 小时 59 分
			const regDate = new Date(fixedNow.getTime() - exact30DaysMs + 60 * 1000);
			assert.equal(isRegistrationAgeQualified(regDate, fixedNow), false);
		});

		it("注册时间恰好等于 30 天 (0ms)：必须返回 false (严格大于 30*24h)", () => {
			const regDate = new Date(fixedNow.getTime() - exact30DaysMs);
			assert.equal(isRegistrationAgeQualified(regDate, fixedNow), false);
		});

		it("注册时间严格超过 30 天 (+1ms)：返回 true", () => {
			const regDate = new Date(fixedNow.getTime() - exact30DaysMs - 1);
			assert.equal(isRegistrationAgeQualified(regDate, fixedNow), true);
		});

		it("注册时间长达 60 天：返回 true", () => {
			const regDate = new Date(fixedNow.getTime() - 60 * 24 * 3600 * 1000);
			assert.equal(isRegistrationAgeQualified(regDate, fixedNow), true);
		});

		it("无效注册时间：返回 false", () => {
			assert.equal(isRegistrationAgeQualified("invalid-date", fixedNow), false);
		});
	});

	// =========================================================================
	// A02 & A03: 活跃度公式与状态机转换
	// =========================================================================
	describe("A02 & A03: 活跃度算法与状态机转换", () => {
		it("满分测试：D=15, U=60, W=4 得分为 100 分", () => {
			assert.equal(calculateActivityScore(15, 60, 4), 100);
			assert.equal(calculateActivityScore(30, 100, 4), 100); // 溢出有界
		});

		it("设计典型案例：D=12, U=40, W=3 得分为 75 分，符合达标条件", () => {
			const score = calculateActivityScore(12, 40, 3);
			assert.equal(score, 75);
			// 校验综合达标：score >= 70, D >= 12, S >= 8, W >= 3
			assert.equal(isActivityQualified(score, 12, 8, 3), true);
		});

		it("仅每天刷登录但无服务：D=30, U=0, W=0 最多 50 分，不达标", () => {
			const score = calculateActivityScore(30, 0, 0);
			assert.equal(score, 50);
			assert.equal(isActivityQualified(score, 30, 0, 0), false);
		});

		it("时间窗口段划分测试", () => {
			assert.equal(getWindowIndexForDayOffset(0), 0); // 第 1 天 -> 段 0
			assert.equal(getWindowIndexForDayOffset(6), 0); // 第 7 天 -> 段 0
			assert.equal(getWindowIndexForDayOffset(7), 1); // 第 8 天 -> 段 1
			assert.equal(getWindowIndexForDayOffset(14), 2); // 第 15 天 -> 段 2
			assert.equal(getWindowIndexForDayOffset(25), 3); // 第 26 天 -> 段 3
			assert.equal(getWindowIndexForDayOffset(31), null); // 超出 30 天 -> null
		});

		it("未激活用户达标状态转换：locked -> eligible", () => {
			const res = computeEntitlementStatus({
				isSuspended: false,
				isAgeQualified: true,
				isActivityQualified: true,
				activatedAt: null,
				graceStartedAt: null,
			});
			assert.equal(res.status, "eligible");
		});

		it("未激活用户不达标：状态保持 locked", () => {
			const res = computeEntitlementStatus({
				isSuspended: false,
				isAgeQualified: true,
				isActivityQualified: false,
				activatedAt: null,
				graceStartedAt: null,
			});
			assert.equal(res.status, "locked");
		});

		it("已激活用户活跃跌落：进入 grace (14天宽限期)", () => {
			const now = new Date("2026-11-05T00:00:00.000Z");
			const res = computeEntitlementStatus({
				isSuspended: false,
				isAgeQualified: true,
				isActivityQualified: false,
				activatedAt: "2026-09-01T00:00:00.000Z",
				graceStartedAt: null,
				now,
			});
			assert.equal(res.status, "grace");
			assert.ok(res.graceStartedAt);
		});

		it("已激活用户宽限期到期 (15天)：降为 read_only", () => {
			const now = new Date("2026-11-05T00:00:00.000Z");
			const graceStart = new Date(now.getTime() - 15 * 24 * 3600 * 1000).toISOString();
			const res = computeEntitlementStatus({
				isSuspended: false,
				isAgeQualified: true,
				isActivityQualified: false,
				activatedAt: "2026-09-01T00:00:00.000Z",
				graceStartedAt: graceStart,
				now,
			});
			assert.equal(res.status, "read_only");
		});

		it("read_only 用户恢复达标：自动恢复为 active", () => {
			const res = computeEntitlementStatus({
				isSuspended: false,
				isAgeQualified: true,
				isActivityQualified: true,
				activatedAt: "2026-09-01T00:00:00.000Z",
				graceStartedAt: "2026-10-01T00:00:00.000Z",
			});
			assert.equal(res.status, "active");
			assert.equal(res.graceStartedAt, null);
		});

		it("账号封禁：直接判定 suspended", () => {
			const res = computeEntitlementStatus({
				isSuspended: true,
				isAgeQualified: true,
				isActivityQualified: true,
				activatedAt: "2026-09-01T00:00:00.000Z",
				graceStartedAt: null,
			});
			assert.equal(res.status, "suspended");
		});

		it("解释文本输出：精准列出缺少项", () => {
			const missing = generateMissingConditions({
				isAgeQualified: false,
				ageMs: 10 * 24 * 3600 * 1000,
				score: 45,
				d: 8,
				s: 4,
				w: 2,
			});
			assert.equal(missing.length, 5);
			assert.match(missing[0], /注册时间未达严格 30 天门槛/);
			assert.match(missing[1], /活跃综合评分未达 70 分/);
			assert.match(missing[2], /有效登录天数不足 12 天/);
			assert.match(missing[3], /有效服务使用天数不足 8 天/);
			assert.match(missing[4], /活跃时间分布段不足 3 段/);
		});
	});

	// =========================================================================
	// A04 & A05: ACL 权限矩阵、受限祖先与 BOLA 防护
	// =========================================================================
	describe("A04 & A05: ACL 权限矩阵与受限祖先控制", () => {
		const baseLibrary = {
			id: 100,
			ownerUserId: 10,
			visibility: "private" as const,
			deletedAt: null,
		};

		const baseDoc = {
			id: 200,
			libraryId: 100,
			accessMode: "inherit" as const,
			publishedRevisionId: 501,
			deletedAt: null,
		};

		it("所有者 (Owner) 拥有完整读写管权限", () => {
			const principal: AccessEvaluationPrincipal = { userId: 10 };
			const context: AccessEvaluationContext = {
				library: baseLibrary,
				targetDocument: baseDoc,
				actorEntitlement: "active",
				ownerEntitlement: "active",
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, true);
			assert.equal(res.canManage, true);
			assert.equal(res.effectiveRole, "owner");
		});

		it("未授权普通用户访问私有库被阻断 (BOLA)", () => {
			const principal: AccessEvaluationPrincipal = { userId: 99 };
			const context: AccessEvaluationContext = {
				library: baseLibrary,
				targetDocument: baseDoc,
				libraryMemberRole: null,
				actorEntitlement: "active",
				ownerEntitlement: "active",
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, false);
			assert.equal(res.canEdit, false);
			assert.equal(res.effectiveRole, null);
		});

		it("协作者 Editor 角色可读写，但不可管理库", () => {
			const principal: AccessEvaluationPrincipal = { userId: 20 };
			const context: AccessEvaluationContext = {
				library: baseLibrary,
				targetDocument: baseDoc,
				libraryMemberRole: "editor",
				actorEntitlement: "active",
				ownerEntitlement: "active",
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, true);
			assert.equal(res.canManage, false);
			assert.equal(res.effectiveRole, "editor");
		});

		it("受限祖先 restricted 拦截未在名单内的普通成员", () => {
			const principal: AccessEvaluationPrincipal = { userId: 20 };
			const restrictedAncestor = {
				id: 150,
				accessMode: "restricted" as const,
				deletedAt: null,
			};
			const context: AccessEvaluationContext = {
				library: baseLibrary,
				targetDocument: baseDoc,
				ancestors: [restrictedAncestor],
				libraryMemberRole: "editor",
				documentExplicitRoles: new Map(), // 20 不在 150 的名单中
				actorEntitlement: "active",
				ownerEntitlement: "active",
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, false);
			assert.equal(res.denyReason, "RESTRICTED_ANCESTOR_ACCESS_DENIED");
		});

		it("受限祖先 restricted 名单角色作为权限上限收缩", () => {
			const principal: AccessEvaluationPrincipal = { userId: 20 };
			const restrictedAncestor = {
				id: 150,
				accessMode: "restricted" as const,
				deletedAt: null,
			};
			const explicitRoles = new Map<number, KbMemberRole>([
				[150, "viewer"], // 限制名单给的是 viewer 上限
			]);
			const context: AccessEvaluationContext = {
				library: baseLibrary,
				targetDocument: baseDoc,
				ancestors: [restrictedAncestor],
				libraryMemberRole: "editor", // 原库角色为 editor
				documentExplicitRoles: explicitRoles,
				actorEntitlement: "active",
				ownerEntitlement: "active",
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, true);
			// 角色被收缩至 viewer，禁止编辑
			assert.equal(res.canEdit, false);
			assert.equal(res.effectiveRole, "viewer");
		});

		it("库管理员 Manager 可穿透 restricted 祖先", () => {
			const principal: AccessEvaluationPrincipal = { userId: 30 };
			const restrictedAncestor = {
				id: 150,
				accessMode: "restricted" as const,
				deletedAt: null,
			};
			const context: AccessEvaluationContext = {
				library: baseLibrary,
				targetDocument: baseDoc,
				ancestors: [restrictedAncestor],
				libraryMemberRole: "manager",
				documentExplicitRoles: new Map(),
				actorEntitlement: "active",
				ownerEntitlement: "active",
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, true);
			assert.equal(res.canManage, true);
		});

		it("匿名读取公开草稿被阻断：未发布草稿绝不外泄", () => {
			const draftDoc = { ...baseDoc, publishedRevisionId: null };
			const publicLib = { ...baseLibrary, visibility: "public" as const };
			const principal: AccessEvaluationPrincipal = {}; // 匿名
			const context: AccessEvaluationContext = {
				library: publicLib,
				targetDocument: draftDoc,
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, false);
			assert.equal(res.denyReason, "UNPUBLISHED_DRAFT_CANNOT_BE_READ_BY_PUBLIC");
		});

		it("匿名读取已发布快照允许", () => {
			const publicLib = { ...baseLibrary, visibility: "public" as const };
			const principal: AccessEvaluationPrincipal = {};
			const context: AccessEvaluationContext = {
				library: publicLib,
				targetDocument: baseDoc,
			};
			const res = evaluateAccess(principal, context);
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, false);
			assert.equal(res.canComment, false);
		});
	});

	// =========================================================================
	// A14: 协作者与所有者状态协同矩阵测试
	// =========================================================================
	describe("A14: 协作者与所有者状态矩阵测试", () => {
		const baseLibrary = {
			id: 100,
			ownerUserId: 10,
			visibility: "private" as const,
			deletedAt: null,
		};
		const baseDoc = {
			id: 200,
			libraryId: 100,
			accessMode: "inherit" as const,
			publishedRevisionId: 501,
			deletedAt: null,
		};

		it("操作者 grace + 所有者 active：允许编辑既有文档", () => {
			const res = evaluateAccess({ userId: 20 }, {
				library: baseLibrary,
				targetDocument: baseDoc,
				libraryMemberRole: "editor",
				actorEntitlement: "grace",
				ownerEntitlement: "active",
			});
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, true);
		});

		it("操作者 read_only + 所有者 active：操作者禁止写入", () => {
			const res = evaluateAccess({ userId: 20 }, {
				library: baseLibrary,
				targetDocument: baseDoc,
				libraryMemberRole: "editor",
				actorEntitlement: "read_only",
				ownerEntitlement: "active",
			});
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, false);
		});

		it("操作者 active + 所有者 read_only：所有者库被暂停写入，协作者也不可写入", () => {
			const res = evaluateAccess({ userId: 20 }, {
				library: baseLibrary,
				targetDocument: baseDoc,
				libraryMemberRole: "editor",
				actorEntitlement: "active",
				ownerEntitlement: "read_only",
			});
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, false);
		});
	});

	// =========================================================================
	// AI Grant 与 Scope 过滤测试
	// =========================================================================
	describe("AI Grant Scope 权限过滤测试", () => {
		const baseLibrary = {
			id: 100,
			ownerUserId: 10,
			visibility: "private" as const,
			deletedAt: null,
		};
		const baseDoc = {
			id: 200,
			libraryId: 100,
			accessMode: "inherit" as const,
			publishedRevisionId: 501,
			deletedAt: null,
		};

		it("AI 仅拥有 kb:read scope 时，写操作被拦截", () => {
			const res = evaluateAccess({
				userId: 10,
				grant: {
					grantId: 1,
					userId: 10,
					scopes: ["kb:read"],
					allowedLibraryIds: [100],
				},
			}, {
				library: baseLibrary,
				targetDocument: baseDoc,
				actorEntitlement: "active",
				ownerEntitlement: "active",
			});
			assert.equal(res.canRead, true);
			assert.equal(res.canEdit, false);
		});

		it("AI 访问未授权的知识库被阻断", () => {
			const res = evaluateAccess({
				userId: 10,
				grant: {
					grantId: 1,
					userId: 10,
					scopes: ["kb:read", "kb:write"],
					allowedLibraryIds: [999], // 不包含 100
				},
			}, {
				library: baseLibrary,
				targetDocument: baseDoc,
				actorEntitlement: "active",
				ownerEntitlement: "active",
			});
			assert.equal(res.canRead, false);
			assert.equal(res.denyReason, "LIBRARY_NOT_IN_AGENT_GRANT");
		});
	});

	// =========================================================================
	// 账号删除与数据生命周期防护测试
	// =========================================================================
	describe("账号注销生命周期防护测试", () => {
		it("UserDeletionBlockedError 包含正确的 409 与错误码", () => {
			const err = new UserDeletionBlockedError();
			assert.equal(err.statusCode, 409);
			assert.equal(err.code, "USER_OWNS_KNOWLEDGE_DATA");
			assert.match(err.message, /USER_OWNS_KNOWLEDGE_DATA/);
		});
	});
});
