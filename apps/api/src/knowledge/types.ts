export type EntitlementStatus =
	| "locked" // 尚未激活且当前不达标，不能创建/编辑；仍可被邀请阅读/评论
	| "eligible" // 当前达标，可开通创建首个库
	| "active" // 已开通且当前达标
	| "grace" // 已开通后活跃下降，跌落起 14 天宽限，既有库可编辑，不可新建库或发布
	| "read_only" // 宽限到期仍不达标，本人名下库及本人全部写入暂停
	| "suspended"; // 账号禁用或知识库封禁

export type KbMemberRole = "manager" | "editor" | "commenter" | "viewer";
export type KbEffectiveRole = "owner" | "manager" | "editor" | "commenter" | "viewer";

export type KbAccessMode = "inherit" | "members_only" | "restricted";
export type KbVisibility = "private" | "unlisted" | "public";

export type KbScope =
	| "kb:read"
	| "kb:write"
	| "kb:comment"
	| "kb:attachments"
	| "kb:export"
	| "kb:publish"
	| "kb:share"
	| "kb:delete";

export type ActivityType =
	| "clipboard_save"
	| "image_upload"
	| "compiler_run"
	| "approved_comment"
	| "kb_manual_save";

export interface ActivityEventInput {
	userId: number;
	activityType: ActivityType;
	idempotencyKey: string;
	fingerprint: string;
}

export interface UserActivityDailyRecord {
	userId: number;
	activityDate: string; // YYYY-MM-DD
	ruleVersion: string;
	loginCount: number;
	clipboardScore: number;
	imageScore: number;
	compilerScore: number;
	commentScore: number;
	kbScore: number;
	totalServiceScore: number;
}

export interface KbEntitlement {
	userId: number;
	status: EntitlementStatus;
	score: number;
	loginDaysD: number;
	serviceScoreU: number;
	serviceDaysS: number;
	timeWindowsW: number;
	statDateCutoff: string; // YYYY-MM-DD
	ruleVersion: string;
	activatedAt: string | null;
	graceStartedAt: string | null;
	restrictionReason: string | null;
}

export interface KbEligibilityResponse {
	userId: number;
	status: EntitlementStatus;
	isQualified: boolean;
	isAgeQualified: boolean;
	isActivityQualified: boolean;
	registrationAgeDays: number;
	metrics: {
		score: number;
		loginDaysD: number;
		serviceScoreU: number;
		serviceDaysS: number;
		timeWindowsW: number;
	};
	thresholds: {
		minScore: number;
		minLoginDaysD: number;
		minServiceDaysS: number;
		minTimeWindowsW: number;
		minAgeDays: number;
	};
	missingConditions: string[];
	statDateCutoff: string;
	graceDaysRemaining: number | null;
	ruleVersion: string;
}

export interface KbGrantPayload {
	grantId: number;
	userId: number;
	scopes: KbScope[];
	allowedLibraryIds: number[];
}

export interface AccessEvaluationPrincipal {
	userId?: number;
	isSuspended?: boolean;
	grant?: KbGrantPayload;
	isShareLink?: boolean;
}

export interface AccessEvaluationContext {
	targetDocument?: {
		id: number;
		libraryId: number;
		accessMode: KbAccessMode;
		publishedRevisionId: number | null;
		deletedAt: string | null;
	};
	ancestors?: Array<{
		id: number;
		accessMode: KbAccessMode;
		deletedAt: string | null;
	}>;
	library: {
		id: number;
		ownerUserId: number;
		visibility: KbVisibility;
		deletedAt: string | null;
	};
	libraryMemberRole?: KbMemberRole | null;
	documentExplicitRoles?: Map<number, KbMemberRole>; // documentId -> explicit role
	actorEntitlement?: EntitlementStatus;
	ownerEntitlement?: EntitlementStatus;
}

export interface AccessEvaluationResult {
	canRead: boolean;
	canComment: boolean;
	canEdit: boolean;
	canPublish: boolean;
	canManage: boolean;
	canDelete: boolean;
	effectiveRole: KbEffectiveRole | null;
	denyReason?: string;
}
