export type EntitlementStatus =
	| "locked"
	| "eligible"
	| "active"
	| "grace"
	| "read_only"
	| "suspended";

export type KbVisibility = "private" | "unlisted" | "public";
export type KbDocumentKind = "document" | "folder";
export type KbAccessMode = "inherit" | "members_only" | "restricted";

export interface LibrarySummary {
	id: number;
	ownerUserId: number;
	title: string;
	description: string;
	coverUrl: string;
	visibility: KbVisibility;
	discoveryEnabled: boolean;
	publicCommentsEnabled: boolean;
	documentCount: number;
	role?: "owner" | "manager" | "editor" | "commenter" | "viewer";
	createdAt: string;
	updatedAt: string;
}

export interface TreeNode {
	id: number;
	libraryId: number;
	parentId: number | null;
	kind: KbDocumentKind;
	sortOrder: number;
	accessMode: KbAccessMode;
	title: string;
	version: number;
	currentRevisionId: number | null;
	publishedRevisionId: number | null;
	deletedAt: string | null;
}

export interface DocumentDetail {
	id: number;
	libraryId: number;
	parentId: number | null;
	kind: KbDocumentKind;
	sortOrder: number;
	accessMode: KbAccessMode;
	version: number;
	currentRevisionId: number | null;
	publishedRevisionId: number | null;
	title: string;
	markdown: string;
	tags: string[];
	sourceUrl: string;
	contentHash: string;
	byteSize: number;
	actorUserId: number | null;
	deletedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface RevisionSummary {
	id: number;
	documentId: number;
	version: number;
	title: string;
	tags: string[];
	sourceUrl: string;
	byteSize: number;
	actorUserId: number | null;
	createdAt: string;
}

export interface AttachmentSummary {
	id: number;
	libraryId: number;
	documentId: number;
	filename: string;
	mimeType: string;
	byteSize: number;
	status: "staged" | "bound" | "marked_delete";
	url?: string;
	createdAt: string;
}

export interface SearchResultItem {
	documentId: number;
	libraryId: number;
	libraryTitle: string;
	title: string;
	excerpt: string;
	version: number;
	updatedAt: string;
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

export interface KbQuotaUsage {
	usedBytes: number;
	maxBytes: number;
	breakdown: {
		revisions: number;
		comments: number;
		attachments: number;
	};
}

export interface TrashedDocumentItem {
	id: number;
	libraryId: number;
	parentId: number | null;
	kind: KbDocumentKind;
	title: string;
	version: number;
	deletedAt: string;
}

