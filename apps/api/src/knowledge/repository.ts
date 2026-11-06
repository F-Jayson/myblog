import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import { config } from "../config.js";
import { ACTIVITY_SERVICE_POINTS, KB_DEFAULTS } from "./constants.js";
import type {
	ActivityEventInput,
	ActivityType,
	AttachmentSummary,
	DocumentDetail,
	KbAccessMode,
	KbCommentItem,
	KbDocumentAccessItem,
	KbDocumentKind,
	KbEffectiveRole,
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
	UserActivityDailyRecord,
} from "./types.js";

// 沿用已有的连接池配置
const pool = mysql.createPool({ ...config.db, namedPlaceholders: true });

export { pool };

/**
 * 判断指定用户是否名下拥有任何知识库数据（包含回收站内 30 天未物理清理的库）
 */
export async function userOwnsKnowledgeData(
	userId: number,
	connection?: PoolConnection,
): Promise<boolean> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS count
		 FROM knowledge_bases
		 WHERE owner_user_id = ?
		   AND (deleted_at IS NULL OR deleted_at > DATE_SUB(NOW(), INTERVAL 30 DAY))`,
		[userId],
	);
	return Number(row?.count ?? 0) > 0;
}

/**
 * 获取普通用户的注册时间与激活状态
 */
export async function getUserRegistrationInfo(
	userId: number,
	connection?: PoolConnection,
): Promise<{ createdAt: Date; isActive: boolean } | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT created_at, is_active FROM comment_users WHERE id = ?",
		[userId],
	);
	if (!row) return null;
	return {
		createdAt: new Date(row.created_at),
		isActive: Boolean(Number(row.is_active)),
	};
}

/**
 * 记录单条业务行为事件（幂等写入）
 * 若该用户针对同类业务的幂等键已存在，直接返回 false，不重复计分
 */
export async function insertActivityEvent(
	event: ActivityEventInput,
	connection?: PoolConnection,
): Promise<boolean> {
	const conn = connection ?? pool;
	try {
		const [result] = await conn.execute<ResultSetHeader>(
			`INSERT IGNORE INTO user_activity_events (user_id, activity_type, idempotency_key, fingerprint)
			 VALUES (?, ?, ?, ?)`,
			[event.userId, event.activityType, event.idempotencyKey, event.fingerprint],
		);
		return result.affectedRows > 0;
	} catch (error) {
		console.warn("[kb-activity] insertActivityEvent error:", error);
		return false;
	}
}

/**
 * 累加用户指定自然日的行为得分
 * 严格执行：每类服务每天上限 4 分，全服务合计每天上限 8 分
 */
export async function incrementDailyServiceScore(
	userId: number,
	activityDate: string,
	type: ActivityType,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	const points = ACTIVITY_SERVICE_POINTS[type] ?? 1;

	// 字段映射
	const columnMap: Record<ActivityType, string> = {
		clipboard_save: "clipboard_score",
		image_upload: "image_score",
		compiler_run: "compiler_score",
		approved_comment: "comment_score",
		kb_manual_save: "kb_score",
	};
	const colName = columnMap[type];
	if (!colName) return;

	// 先确保当天记录存在
	await conn.execute(
		`INSERT INTO user_activity_daily (user_id, activity_date, rule_version)
		 VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
		[userId, activityDate, KB_DEFAULTS.RULE_VERSION],
	);

	// 读取当前得分并有界增加
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT ${colName} AS category_score, total_service_score
		 FROM user_activity_daily
		 WHERE user_id = ? AND activity_date = ? AND rule_version = ?
		 FOR UPDATE`,
		[userId, activityDate, KB_DEFAULTS.RULE_VERSION],
	);

	const currentCat = Number(row?.category_score ?? 0);
	const currentTotal = Number(row?.total_service_score ?? 0);

	const catRemaining = Math.max(0, KB_DEFAULTS.DAILY_SERVICE_CATEGORY_MAX_SCORE - currentCat);
	const totalRemaining = Math.max(0, KB_DEFAULTS.DAILY_SERVICE_MAX_SCORE - currentTotal);
	const actualAdd = Math.min(points, catRemaining, totalRemaining);

	if (actualAdd > 0) {
		await conn.execute(
			`UPDATE user_activity_daily
			 SET ${colName} = ${colName} + ?,
			     total_service_score = total_service_score + ?
			 WHERE user_id = ? AND activity_date = ? AND rule_version = ?`,
			[actualAdd, actualAdd, userId, activityDate, KB_DEFAULTS.RULE_VERSION],
		);
	}
}

/**
 * 记录用户当天的有效登录天数
 */
export async function recordDailyLogin(
	userId: number,
	activityDate: string,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		`INSERT INTO user_activity_daily (user_id, activity_date, rule_version, login_count)
		 VALUES (?, ?, ?, 1)
		 ON DUPLICATE KEY UPDATE login_count = login_count + 1`,
		[userId, activityDate, KB_DEFAULTS.RULE_VERSION],
	);
}

/**
 * 获取指定用户过去 30 个已结算 UTC 自然日的全部日聚合数据
 */
export async function getDailyActivitiesForPast30Days(
	userId: number,
	cutoffDate: string,
	connection?: PoolConnection,
): Promise<UserActivityDailyRecord[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT user_id,
		        DATE_FORMAT(activity_date, '%Y-%m-%d') AS activityDate,
		        rule_version,
		        login_count,
		        clipboard_score,
		        image_score,
		        compiler_score,
		        comment_score,
		        kb_score,
		        total_service_score
		 FROM user_activity_daily
		 WHERE user_id = ?
		   AND rule_version = ?
		   AND activity_date <= ?
		   AND activity_date >= DATE_SUB(?, INTERVAL 29 DAY)
		 ORDER BY activity_date ASC`,
		[userId, KB_DEFAULTS.RULE_VERSION, cutoffDate, cutoffDate],
	);

	return (rows as RowDataPacket[]).map((r) => ({
		userId: Number(r.user_id),
		activityDate: String(r.activityDate),
		ruleVersion: String(r.rule_version),
		loginCount: Number(r.login_count),
		clipboardScore: Number(r.clipboard_score),
		imageScore: Number(r.image_score),
		compilerScore: Number(r.compiler_score),
		commentScore: Number(r.comment_score),
		kbScore: Number(r.kb_score),
		totalServiceScore: Number(r.total_service_score),
	}));
}

function formatMysqlDatetime(val: Date | string | null | undefined): string | null {
	if (!val) return null;
	const d = typeof val === "object" ? val : new Date(val);
	if (Number.isNaN(d.getTime())) return null;
	return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * 管理员是否直接开通了该用户的知识库
 */
export async function hasKbAdminGrant(userId: number, connection?: PoolConnection): Promise<boolean> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT user_id FROM kb_admin_grants WHERE user_id = ?",
		[userId],
	);
	return Boolean(row);
}

/**
 * 打开或关闭管理员直通资格。关闭后恢复按活跃度计算。
 */
export async function setKbAdminGrant(userId: number, enabled: boolean, grantedBy: number | null, connection?: PoolConnection): Promise<void> {
	const conn = connection ?? pool;
	if (!enabled) {
		await conn.execute("DELETE FROM kb_admin_grants WHERE user_id = ?", [userId]);
		return;
	}
	await conn.execute(
		`INSERT INTO kb_admin_grants (user_id, granted_by) VALUES (?, ?)
		 ON DUPLICATE KEY UPDATE granted_by = VALUES(granted_by)`,
		[userId, grantedBy],
	);
}

/**
 * 获取知识库资格记录
 */
export async function getKbEntitlement(
	userId: number,
	connection?: PoolConnection,
): Promise<KbEntitlement | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT user_id, status, score, login_days_d, service_score_u, service_days_s, time_windows_w,
		        DATE_FORMAT(stat_date_cutoff, '%Y-%m-%d') AS stat_date_cutoff,
		        rule_version,
		        DATE_FORMAT(activated_at, '%Y-%m-%d %H:%i:%s') AS activated_at,
		        DATE_FORMAT(grace_started_at, '%Y-%m-%d %H:%i:%s') AS grace_started_at,
		        restriction_reason
		 FROM kb_entitlements
		 WHERE user_id = ?`,
		[userId],
	);
	if (!row) return null;
	return {
		userId: Number(row.user_id),
		status: row.status,
		score: Number(row.score),
		loginDaysD: Number(row.login_days_d),
		serviceScoreU: Number(row.service_score_u),
		serviceDaysS: Number(row.service_days_s),
		timeWindowsW: Number(row.time_windows_w),
		statDateCutoff: String(row.stat_date_cutoff),
		ruleVersion: String(row.rule_version),
		activatedAt: row.activated_at ? String(row.activated_at) : null,
		graceStartedAt: row.grace_started_at ? String(row.grace_started_at) : null,
		restrictionReason: row.restriction_reason ? String(row.restriction_reason) : null,
	};
}

/**
 * 更新或创建知识库资格快照
 */
export async function upsertKbEntitlement(
	entitlement: KbEntitlement,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		`INSERT INTO kb_entitlements (
			user_id, status, score, login_days_d, service_score_u, service_days_s, time_windows_w,
			stat_date_cutoff, rule_version, activated_at, grace_started_at, restriction_reason
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		 	status = VALUES(status),
		 	score = VALUES(score),
		 	login_days_d = VALUES(login_days_d),
		 	service_score_u = VALUES(service_score_u),
		 	service_days_s = VALUES(service_days_s),
		 	time_windows_w = VALUES(time_windows_w),
		 	stat_date_cutoff = VALUES(stat_date_cutoff),
		 	rule_version = VALUES(rule_version),
		 	activated_at = COALESCE(VALUES(activated_at), activated_at),
		 	grace_started_at = VALUES(grace_started_at),
		 	restriction_reason = VALUES(restriction_reason)`,
		[
			entitlement.userId,
			entitlement.status,
			entitlement.score,
			entitlement.loginDaysD,
			entitlement.serviceScoreU,
			entitlement.serviceDaysS,
			entitlement.timeWindowsW,
			entitlement.statDateCutoff,
			entitlement.ruleVersion,
			formatMysqlDatetime(entitlement.activatedAt),
			formatMysqlDatetime(entitlement.graceStartedAt),
			entitlement.restrictionReason,
		],
	);
}

/**
 * 获取知识库成员角色
 */
export async function getLibraryMemberRole(
	libraryId: number,
	userId: number,
	connection?: PoolConnection,
): Promise<KbMemberRole | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT role FROM kb_members WHERE library_id = ? AND user_id = ?",
		[libraryId, userId],
	);
	return (row?.role as KbMemberRole) || null;
}

/**
 * 批量获取文档显式 ACL 授权名单
 */
export async function getDocumentExplicitRoles(
	documentIds: number[],
	userId: number,
	connection?: PoolConnection,
): Promise<Map<number, KbMemberRole>> {
	const result = new Map<number, KbMemberRole>();
	if (!documentIds.length) return result;

	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT document_id, role
		 FROM kb_document_access
		 WHERE document_id IN (?) AND user_id = ?`,
		[documentIds, userId],
	);

	for (const row of rows as RowDataPacket[]) {
		result.set(Number(row.document_id), row.role as KbMemberRole);
	}
	return result;
}

/**
 * 获取库元信息
 */
export async function getLibraryRecord(
	libraryId: number,
	connection?: PoolConnection,
): Promise<{
	id: number;
	ownerUserId: number;
	title: string;
	visibility: KbVisibility;
	discoveryEnabled: boolean;
	publicCommentsEnabled: boolean;
	deletedAt: string | null;
} | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT id, owner_user_id, title, visibility, discovery_enabled, public_comments_enabled, deleted_at FROM knowledge_bases WHERE id = ?",
		[libraryId],
	);
	if (!row) return null;
	return {
		id: Number(row.id),
		ownerUserId: Number(row.owner_user_id),
		title: String(row.title),
		visibility: row.visibility as KbVisibility,
		discoveryEnabled: Boolean(Number(row.discovery_enabled)),
		publicCommentsEnabled: Boolean(Number(row.public_comments_enabled)),
		deletedAt: row.deleted_at ? String(row.deleted_at) : null,
	};
}

/**
 * 获取文档元信息
 */
export async function getDocumentRecord(
	documentId: number,
	connection?: PoolConnection,
): Promise<{
	id: number;
	libraryId: number;
	parentId: number | null;
	accessMode: KbAccessMode;
	publishedRevisionId: number | null;
	deletedAt: string | null;
} | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT id, library_id, parent_id, access_mode, published_revision_id, deleted_at FROM kb_documents WHERE id = ?",
		[documentId],
	);
	if (!row) return null;
	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		parentId: row.parent_id !== null ? Number(row.parent_id) : null,
		accessMode: row.access_mode as KbAccessMode,
		publishedRevisionId: row.published_revision_id !== null ? Number(row.published_revision_id) : null,
		deletedAt: row.deleted_at ? String(row.deleted_at) : null,
	};
}

interface DocAncestorRow extends RowDataPacket {
	id: number;
	parent_id: number | null;
	access_mode: string;
	deleted_at: string | null;
}

/**
 * 递归查询文档的全部祖先节点（从根到直接父节点）
 */
export async function getDocumentAncestors(
	documentId: number,
	connection?: PoolConnection,
): Promise<Array<{ id: number; accessMode: KbAccessMode; deletedAt: string | null }>> {
	const executor = connection ?? pool;
	const ancestors: Array<{ id: number; accessMode: KbAccessMode; deletedAt: string | null }> = [];
	let targetDocId: number | null = documentId;
	const visited = new Set<number>();

	while (targetDocId !== null) {
		visited.add(targetDocId);
		const [docRows] = (await executor.query<DocAncestorRow[]>(
			"SELECT id, parent_id, access_mode, deleted_at FROM kb_documents WHERE id = ?",
			[targetDocId],
		)) as unknown as [DocAncestorRow[], unknown];
		const doc = docRows[0];
		if (!doc || doc.parent_id === null || visited.has(doc.parent_id)) break;

		const [parentRows] = (await executor.query<DocAncestorRow[]>(
			"SELECT id, parent_id, access_mode, deleted_at FROM kb_documents WHERE id = ?",
			[doc.parent_id],
		)) as unknown as [DocAncestorRow[], unknown];
		const parent = parentRows[0];
		if (parent) {
			ancestors.unshift({
				id: Number(parent.id),
				accessMode: parent.access_mode as KbAccessMode,
				deletedAt: parent.deleted_at ? String(parent.deleted_at) : null,
			});
			targetDocId = parent.id;
		} else {
			break;
		}
	}

	return ancestors;
}

/**
 * 统计用户当前名下拥有的活跃知识库总数
 */
export async function countUserLibraries(
	userId: number,
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT COUNT(*) AS total FROM knowledge_bases WHERE owner_user_id = ? AND deleted_at IS NULL",
		[userId],
	);
	return Number(row?.total ?? 0);
}

/**
 * 创建新知识库
 */
export async function createLibrary(
	ownerUserId: number,
	data: {
		title: string;
		description?: string;
		coverUrl?: string;
		visibility?: KbVisibility;
	},
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [result] = await conn.execute<ResultSetHeader>(
		`INSERT INTO knowledge_bases (owner_user_id, title, description, cover_url, visibility)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			ownerUserId,
			data.title.trim(),
			data.description?.trim() ?? "",
			data.coverUrl?.trim() ?? "",
			data.visibility ?? "private",
		],
	);
	return Number(result.insertId);
}

/**
 * 首次建库如果用户是 eligible，激活为 active
 */
export async function activateUserIfEligible(
	userId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		`UPDATE kb_entitlements
		 SET status = 'active',
		     activated_at = COALESCE(activated_at, NOW())
		 WHERE user_id = ? AND status = 'eligible'`,
		[userId],
	);
}

/**
 * 列出用户可访问的全部知识库（本人拥有及受邀作为成员）
 */
export async function listLibrariesForUser(
	userId: number,
	connection?: PoolConnection,
): Promise<LibrarySummary[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT k.id,
		        k.owner_user_id,
		        k.title,
		        k.description,
		        k.cover_url,
		        k.visibility,
		        k.discovery_enabled,
		        k.public_comments_enabled,
		        k.created_at,
		        k.updated_at,
		        COALESCE(m.role, IF(k.owner_user_id = ?, 'owner', NULL)) AS user_role,
		        (SELECT COUNT(*) FROM kb_documents d WHERE d.library_id = k.id AND d.deleted_at IS NULL) AS document_count
		 FROM knowledge_bases k
		 LEFT JOIN kb_members m ON m.library_id = k.id AND m.user_id = ?
		 WHERE (k.owner_user_id = ? OR m.user_id = ?)
		   AND k.deleted_at IS NULL
		 ORDER BY k.updated_at DESC`,
		[userId, userId, userId, userId],
	);

	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		ownerUserId: Number(r.owner_user_id),
		title: String(r.title),
		description: String(r.description),
		coverUrl: String(r.cover_url),
		visibility: r.visibility as KbVisibility,
		discoveryEnabled: Boolean(Number(r.discovery_enabled)),
		publicCommentsEnabled: Boolean(Number(r.public_comments_enabled)),
		documentCount: Number(r.document_count ?? 0),
		role: r.user_role as KbEffectiveRole,
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	}));
}

/**
 * 更新知识库基本设置
 */
export async function updateLibrary(
	libraryId: number,
	data: {
		title?: string;
		description?: string;
		coverUrl?: string;
		visibility?: KbVisibility;
		discoveryEnabled?: boolean;
		publicCommentsEnabled?: boolean;
	},
	connection?: PoolConnection,
): Promise<boolean> {
	const conn = connection ?? pool;
	const updates: string[] = [];
	const values: any[] = [];

	if (data.title !== undefined) { updates.push("title = ?"); values.push(data.title.trim()); }
	if (data.description !== undefined) { updates.push("description = ?"); values.push(data.description.trim()); }
	if (data.coverUrl !== undefined) { updates.push("cover_url = ?"); values.push(data.coverUrl.trim()); }
	if (data.visibility !== undefined) { updates.push("visibility = ?"); values.push(data.visibility); }
	if (data.discoveryEnabled !== undefined) { updates.push("discovery_enabled = ?"); values.push(data.discoveryEnabled); }
	if (data.publicCommentsEnabled !== undefined) { updates.push("public_comments_enabled = ?"); values.push(data.publicCommentsEnabled); }

	if (!updates.length) return false;
	values.push(libraryId);

	const [res] = await conn.execute<ResultSetHeader>(
		`UPDATE knowledge_bases SET ${updates.join(", ")}, version = version + 1 WHERE id = ?`,
		values,
	);
	return res.affectedRows > 0;
}

/**
 * 软删除整个知识库
 */
export async function softDeleteLibrary(
	libraryId: number,
	connection?: PoolConnection,
): Promise<boolean> {
	const conn = connection ?? pool;
	const [res] = await conn.execute<ResultSetHeader>(
		"UPDATE knowledge_bases SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
		[libraryId],
	);
	return res.affectedRows > 0;
}

/**
 * 统计库内有效文档/文件夹总数
 */
export async function countLibraryDocuments(
	libraryId: number,
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT COUNT(*) AS total FROM kb_documents WHERE library_id = ? AND deleted_at IS NULL",
		[libraryId],
	);
	return Number(row?.total ?? 0);
}

/**
 * 获取知识库的目录节点列表
 */
export async function getLibraryTreeNodes(
	libraryId: number,
	includeDeleted = false,
	connection?: PoolConnection,
): Promise<TreeNode[]> {
	const conn = connection ?? pool;
	const deletedCondition = includeDeleted ? "" : "AND d.deleted_at IS NULL";

	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT d.id,
		        d.library_id,
		        d.parent_id,
		        d.kind,
		        d.sort_order,
		        d.access_mode,
		        d.version,
		        d.current_revision_id,
		        d.published_revision_id,
		        d.deleted_at,
		        COALESCE(r.title, '') AS title
		 FROM kb_documents d
		 LEFT JOIN kb_revisions r ON r.id = d.current_revision_id
		 WHERE d.library_id = ? ${deletedCondition}
		 ORDER BY d.sort_order ASC, d.id ASC`,
		[libraryId],
	);

	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		libraryId: Number(r.library_id),
		parentId: r.parent_id !== null ? Number(r.parent_id) : null,
		kind: r.kind as KbDocumentKind,
		sortOrder: Number(r.sort_order),
		accessMode: r.access_mode as KbAccessMode,
		title: String(r.title),
		version: Number(r.version),
		currentRevisionId: r.current_revision_id !== null ? Number(r.current_revision_id) : null,
		publishedRevisionId: r.published_revision_id !== null ? Number(r.published_revision_id) : null,
		deletedAt: r.deleted_at ? String(r.deleted_at) : null,
	}));
}

/**
 * 创建文档节点 (记录在 kb_documents 表中)
 */
export async function createDocumentRecord(
	data: {
		libraryId: number;
		parentId?: number | null;
		kind: KbDocumentKind;
		sortOrder?: number;
		accessMode?: KbAccessMode;
		externalKey?: string;
	},
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [result] = await conn.execute<ResultSetHeader>(
		`INSERT INTO kb_documents (library_id, parent_id, kind, sort_order, access_mode, external_key)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			data.libraryId,
			data.parentId ?? null,
			data.kind,
			data.sortOrder ?? 0,
			data.accessMode ?? "inherit",
			data.externalKey ?? null,
		],
	);
	return Number(result.insertId);
}

/**
 * 创建不可变 Revision 记录
 */
export async function createRevisionRecord(
	data: {
		documentId: number;
		version: number;
		title: string;
		markdown: string;
		tags?: string[];
		sourceUrl?: string;
		contentHash: string;
		byteSize: number;
		actorUserId?: number | null;
		actorGrantId?: number | null;
	},
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [result] = await conn.execute<ResultSetHeader>(
		`INSERT INTO kb_revisions (
			document_id, version, title, markdown, tags, source_url, content_hash, byte_size, actor_user_id, actor_grant_id
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			data.documentId,
			data.version,
			data.title.trim(),
			data.markdown,
			JSON.stringify(data.tags ?? []),
			data.sourceUrl?.trim() ?? "",
			data.contentHash,
			data.byteSize,
			data.actorUserId ?? null,
			data.actorGrantId ?? null,
		],
	);
	return Number(result.insertId);
}

/**
 * 更新文档当前的 revision 指针与 version 号
 */
export async function updateDocumentCurrentRevision(
	documentId: number,
	revisionId: number,
	version: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		`UPDATE kb_documents
		 SET current_revision_id = ?,
		     version = ?
		 WHERE id = ?`,
		[revisionId, version, documentId],
	);
}

/**
 * 获取文档完整详情（携带当前 revision 正文与元数据）
 */
export async function getDocumentDetail(
	documentId: number,
	connection?: PoolConnection,
): Promise<DocumentDetail | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT d.id,
		        d.library_id,
		        d.parent_id,
		        d.kind,
		        d.sort_order,
		        d.access_mode,
		        d.version,
		        d.current_revision_id,
		        d.published_revision_id,
		        d.deleted_at,
		        d.created_at,
		        d.updated_at,
		        COALESCE(r.title, '') AS title,
		        COALESCE(r.markdown, '') AS markdown,
		        COALESCE(r.tags, '[]') AS tags,
		        COALESCE(r.source_url, '') AS source_url,
		        COALESCE(r.content_hash, '') AS content_hash,
		        COALESCE(r.byte_size, 0) AS byte_size,
		        r.actor_user_id
		 FROM kb_documents d
		 LEFT JOIN kb_revisions r ON r.id = d.current_revision_id
		 WHERE d.id = ?`,
		[documentId],
	);
	if (!row) return null;

	let parsedTags: string[] = [];
	try {
		parsedTags = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags;
	} catch {
		parsedTags = [];
	}

	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		parentId: row.parent_id !== null ? Number(row.parent_id) : null,
		kind: row.kind as KbDocumentKind,
		sortOrder: Number(row.sort_order),
		accessMode: row.access_mode as KbAccessMode,
		version: Number(row.version),
		currentRevisionId: row.current_revision_id !== null ? Number(row.current_revision_id) : null,
		publishedRevisionId: row.published_revision_id !== null ? Number(row.published_revision_id) : null,
		title: String(row.title),
		markdown: String(row.markdown),
		tags: parsedTags,
		sourceUrl: String(row.source_url),
		contentHash: String(row.content_hash),
		byteSize: Number(row.byte_size),
		actorUserId: row.actor_user_id !== null ? Number(row.actor_user_id) : null,
		deletedAt: row.deleted_at ? String(row.deleted_at) : null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

/**
 * 乐观并发检查与文档行加锁
 */
export async function checkDocumentConflictAndLock(
	documentId: number,
	expectedVersion: number,
	connection: PoolConnection,
): Promise<{
	currentVersion: number;
	isConflict: boolean;
	currentRevisionId: number | null;
	libraryId: number;
}> {
	const [[row]] = await connection.query<RowDataPacket[]>(
		"SELECT version, current_revision_id, library_id FROM kb_documents WHERE id = ? FOR UPDATE",
		[documentId],
	);
	if (!row) {
		throw new Error("文档不存在");
	}
	const currentVersion = Number(row.version);
	return {
		currentVersion,
		isConflict: currentVersion !== expectedVersion,
		currentRevisionId: row.current_revision_id !== null ? Number(row.current_revision_id) : null,
		libraryId: Number(row.library_id),
	};
}

/**
 * 获取文档历史 revisions 列表
 */
export async function getDocumentRevisions(
	documentId: number,
	connection?: PoolConnection,
): Promise<RevisionSummary[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT id, document_id, version, title, tags, source_url, byte_size, actor_user_id, created_at
		 FROM kb_revisions
		 WHERE document_id = ?
		 ORDER BY version DESC
		 LIMIT 200`,
		[documentId],
	);

	return (rows as RowDataPacket[]).map((r) => {
		let tags: string[] = [];
		try { tags = typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags; } catch { tags = []; }
		return {
			id: Number(r.id),
			documentId: Number(r.document_id),
			version: Number(r.version),
			title: String(r.title),
			tags,
			sourceUrl: String(r.source_url),
			byteSize: Number(r.byte_size),
			actorUserId: r.actor_user_id !== null ? Number(r.actor_user_id) : null,
			createdAt: String(r.created_at),
		};
	});
}

/**
 * 获取特定 revision 的详情
 */
export async function getRevisionDetail(
	revisionId: number,
	connection?: PoolConnection,
): Promise<{
	id: number;
	documentId: number;
	version: number;
	title: string;
	markdown: string;
	tags: string[];
	sourceUrl: string;
} | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		"SELECT id, document_id, version, title, markdown, tags, source_url FROM kb_revisions WHERE id = ?",
		[revisionId],
	);
	if (!row) return null;
	let tags: string[] = [];
	try { tags = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags; } catch { tags = []; }
	return {
		id: Number(row.id),
		documentId: Number(row.document_id),
		version: Number(row.version),
		title: String(row.title),
		markdown: String(row.markdown),
		tags,
		sourceUrl: String(row.source_url),
	};
}

/**
 * 递归软删除文档树（将该节点及其所有后代节点 deleted_at 设为 NOW()）
 */
export async function softDeleteDocumentTree(
	documentId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	// 查找所有后代 ID
	const descendants: number[] = [documentId];
	const queue: number[] = [documentId];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const [childRows] = await conn.query<RowDataPacket[]>(
			"SELECT id FROM kb_documents WHERE parent_id = ? AND deleted_at IS NULL",
			[current],
		);
		for (const row of childRows as RowDataPacket[]) {
			const cid = Number(row.id);
			descendants.push(cid);
			queue.push(cid);
		}
	}

	await conn.query(
		"UPDATE kb_documents SET deleted_at = NOW() WHERE id IN (?)",
		[descendants],
	);
}

/**
 * 恢复软删除的文档及其后代
 */
export async function restoreDocumentTree(
	documentId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	const descendants: number[] = [documentId];
	const queue: number[] = [documentId];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const [childRows] = await conn.query<RowDataPacket[]>(
			"SELECT id FROM kb_documents WHERE parent_id = ? AND deleted_at IS NOT NULL",
			[current],
		);
		for (const row of childRows as RowDataPacket[]) {
			const cid = Number(row.id);
			descendants.push(cid);
			queue.push(cid);
		}
	}

	await conn.query(
		"UPDATE kb_documents SET deleted_at = NULL WHERE id IN (?)",
		[descendants],
	);
}

/**
 * 获取知识库下所有已软删除的文档列表（回收站）
 */
export async function listTrashedDocuments(
	libraryId: number,
	connection?: PoolConnection,
): Promise<Array<{
	id: number;
	libraryId: number;
	parentId: number | null;
	kind: KbDocumentKind;
	title: string;
	version: number;
	deletedAt: string;
}>> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT d.id, d.library_id, d.parent_id, d.kind, d.version,
		        DATE_FORMAT(d.deleted_at, '%Y-%m-%d %H:%i:%s') AS deleted_at,
		        COALESCE(r.title, '') AS title
		 FROM kb_documents d
		 LEFT JOIN kb_revisions r ON r.id = d.current_revision_id
		 WHERE d.library_id = ? AND d.deleted_at IS NOT NULL
		 ORDER BY d.deleted_at DESC`,
		[libraryId],
	);
	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		libraryId: Number(r.library_id),
		parentId: r.parent_id !== null ? Number(r.parent_id) : null,
		kind: r.kind as KbDocumentKind,
		title: String(r.title),
		version: Number(r.version),
		deletedAt: String(r.deleted_at),
	}));
}

/**
 * 移动文档树节点
 */
export async function moveDocumentNode(
	documentId: number,
	targetParentId: number | null,
	sortOrder: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"UPDATE kb_documents SET parent_id = ?, sort_order = ? WHERE id = ?",
		[targetParentId, sortOrder, documentId],
	);
}

/**
 * 知识库全文检索 (MySQL ngram 全文索引 + LIKE 降级兼容)
 */
export async function searchUserAccessibleDocuments(
	userId: number,
	searchQuery: string,
	libraryId?: number,
	connection?: PoolConnection,
): Promise<SearchResultItem[]> {
	const conn = connection ?? pool;
	const cleanQ = searchQuery.trim();
	if (!cleanQ) return [];

	let libFilter = "";
	const queryParams: unknown[] = [userId, userId, userId, userId];

	if (libraryId) {
		libFilter = "AND k.id = ?";
		queryParams.push(libraryId);
	}

	// 匹配参数
	queryParams.push(`%${cleanQ}%`, `%${cleanQ}%`);

	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT d.id AS document_id,
		        k.id AS library_id,
		        k.title AS library_title,
		        r.title,
		        SUBSTRING(r.markdown, 1, 160) AS excerpt,
		        d.version,
		        d.updated_at
		 FROM kb_documents d
		 INNER JOIN knowledge_bases k ON k.id = d.library_id
		 INNER JOIN kb_revisions r ON r.id = d.current_revision_id
		 LEFT JOIN kb_members m ON m.library_id = k.id AND m.user_id = ?
		 WHERE (k.owner_user_id = ? OR m.user_id = ?)
		   AND d.deleted_at IS NULL
		   AND k.deleted_at IS NULL
		   ${libFilter}
		   AND (r.title LIKE ? OR r.markdown LIKE ?)
		 ORDER BY d.updated_at DESC
		 LIMIT 50`,
		queryParams,
	);

	return (rows as RowDataPacket[]).map((r) => ({
		documentId: Number(r.document_id),
		libraryId: Number(r.library_id),
		libraryTitle: String(r.library_title),
		title: String(r.title),
		excerpt: String(r.excerpt ?? "").replace(/[#*`~>]/g, "").trim(),
		version: Number(r.version),
		updatedAt: String(r.updated_at),
	}));
}

/**
 * 记录上传的附件元数据
 */
export async function createAttachment(
	data: {
		libraryId: number;
		documentId: number;
		ownerUserId: number;
		uploaderUserId: number;
		storageKey: string;
		filename: string;
		mimeType: string;
		byteSize: number;
		status?: "staged" | "bound";
	},
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [result] = await conn.execute<ResultSetHeader>(
		`INSERT INTO kb_attachments (
			library_id, document_id, owner_user_id, uploader_user_id, storage_key, filename, mime_type, byte_size, status
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			data.libraryId,
			data.documentId,
			data.ownerUserId,
			data.uploaderUserId,
			data.storageKey,
			data.filename,
			data.mimeType,
			data.byteSize,
			data.status ?? "staged",
		],
	);
	return Number(result.insertId);
}

/**
 * 获取附件元数据
 */
export async function getAttachment(
	attachmentId: number,
	connection?: PoolConnection,
): Promise<AttachmentSummary & { storageKey: string; ownerUserId: number } | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT id, library_id, document_id, owner_user_id, filename, mime_type, byte_size, status, storage_key, created_at
		 FROM kb_attachments
		 WHERE id = ? AND status != 'marked_delete'`,
		[attachmentId],
	);
	if (!row) return null;
	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		documentId: Number(row.document_id),
		ownerUserId: Number(row.owner_user_id),
		filename: String(row.filename),
		mimeType: String(row.mime_type),
		byteSize: Number(row.byte_size),
		status: row.status,
		storageKey: String(row.storage_key),
		createdAt: String(row.created_at),
	};
}

/**
 * 列出文档的所有有效附件
 */
export async function listDocumentAttachments(
	documentId: number,
	connection?: PoolConnection,
): Promise<AttachmentSummary[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT id, library_id, document_id, filename, mime_type, byte_size, status, created_at
		 FROM kb_attachments
		 WHERE document_id = ? AND status != 'marked_delete'
		 ORDER BY created_at DESC`,
		[documentId],
	);

	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		libraryId: Number(r.library_id),
		documentId: Number(r.document_id),
		filename: String(r.filename),
		mimeType: String(r.mime_type),
		byteSize: Number(r.byte_size),
		status: r.status,
		createdAt: String(r.created_at),
	}));
}

/**
 * 将附件与 revision 绑定
 */
export async function bindAttachmentsToRevision(
	revisionId: number,
	attachmentIds: number[],
	connection?: PoolConnection,
): Promise<void> {
	if (!attachmentIds.length) return;
	const conn = connection ?? pool;
	const values = attachmentIds.map((id) => [revisionId, id]);
	await conn.query(
		"INSERT IGNORE INTO kb_revision_attachments (revision_id, attachment_id) VALUES ?",
		[values],
	);
	await conn.query(
		"UPDATE kb_attachments SET status = 'bound' WHERE id IN (?)",
		[attachmentIds],
	);
}

/**
 * =========================================================================
 * P3: 成员管理、单篇ACL、快照发布、分享链接与评论仓储
 * =========================================================================
 */

export async function listLibraryMembers(
	libraryId: number,
	connection?: PoolConnection,
): Promise<KbMemberItem[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT m.id, m.library_id, m.user_id, m.role,
		        DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
		        u.account, u.nickname, u.avatar_url AS avatar
		 FROM kb_members m
		 INNER JOIN comment_users u ON u.id = m.user_id
		 WHERE m.library_id = ?
		 ORDER BY m.created_at ASC`,
		[libraryId],
	);
	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		libraryId: Number(r.library_id),
		userId: Number(r.user_id),
		username: String(r.account),
		nickname: String(r.nickname || r.account),
		avatar: String(r.avatar || ""),
		role: r.role as KbMemberRole,
		createdAt: String(r.created_at),
	}));
}

export async function upsertLibraryMember(
	libraryId: number,
	userId: number,
	role: KbMemberRole,
	createdBy: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		`INSERT INTO kb_members (library_id, user_id, role, created_by)
		 VALUES (?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = NOW()`,
		[libraryId, userId, role, createdBy],
	);
}

export async function removeLibraryMember(
	libraryId: number,
	userId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"DELETE FROM kb_members WHERE library_id = ? AND user_id = ?",
		[libraryId, userId],
	);
}

export async function listDocumentAccessEntries(
	documentId: number,
	connection?: PoolConnection,
): Promise<KbDocumentAccessItem[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT a.id, a.document_id, a.user_id, a.role,
		        DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
		        u.account, u.nickname, u.avatar_url AS avatar
		 FROM kb_document_access a
		 INNER JOIN comment_users u ON u.id = a.user_id
		 WHERE a.document_id = ?
		 ORDER BY a.created_at ASC`,
		[documentId],
	);
	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		documentId: Number(r.document_id),
		userId: Number(r.user_id),
		username: String(r.account),
		nickname: String(r.nickname || r.account),
		avatar: String(r.avatar || ""),
		role: r.role as "editor" | "commenter" | "viewer",
		createdAt: String(r.created_at),
	}));
}

export async function setDocumentAccessMode(
	documentId: number,
	accessMode: KbAccessMode,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"UPDATE kb_documents SET access_mode = ? WHERE id = ?",
		[accessMode, documentId],
	);
}

export async function setDocumentExplicitAccess(
	documentId: number,
	userId: number,
	role: "editor" | "commenter" | "viewer",
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		`INSERT INTO kb_document_access (document_id, user_id, role)
		 VALUES (?, ?, ?)
		 ON DUPLICATE KEY UPDATE role = VALUES(role)`,
		[documentId, userId, role],
	);
}

export async function removeDocumentExplicitAccess(
	documentId: number,
	userId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"DELETE FROM kb_document_access WHERE document_id = ? AND user_id = ?",
		[documentId, userId],
	);
}

export async function setDocumentPublishedRevision(
	documentId: number,
	revisionId: number | null,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"UPDATE kb_documents SET published_revision_id = ? WHERE id = ?",
		[revisionId, documentId],
	);
}

export async function getPublicDocumentSnapshot(
	documentId: number,
	connection?: PoolConnection,
): Promise<PublicDocumentSnapshot | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT d.id, d.library_id, d.version, d.published_revision_id, d.deleted_at,
		        k.title AS library_title, k.visibility, k.deleted_at AS lib_deleted_at,
		        r.title, r.markdown, r.tags,
		        DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS revision_time,
		        u.account, u.nickname, u.avatar_url AS avatar
		 FROM kb_documents d
		 INNER JOIN knowledge_bases k ON k.id = d.library_id
		 INNER JOIN kb_revisions r ON r.id = d.published_revision_id
		 INNER JOIN comment_users u ON u.id = k.owner_user_id
		 WHERE d.id = ? AND d.deleted_at IS NULL AND k.deleted_at IS NULL`,
		[documentId],
	);
	if (!row || !row.published_revision_id) return null;

	let tags: string[] = [];
	try {
		tags = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags;
	} catch {
		tags = [];
	}

	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		libraryTitle: String(row.library_title),
		title: String(row.title),
		markdown: String(row.markdown),
		tags,
		publishedRevisionId: Number(row.published_revision_id),
		version: Number(row.version),
		authorName: String(row.nickname || row.account),
		authorAvatar: String(row.avatar || ""),
		updatedAt: String(row.revision_time),
		createdAt: String(row.revision_time),
	};
}

export async function createShareLinkRecord(
	data: {
		libraryId: number;
		targetDocumentId: number | null;
		tokenHash: string;
		expiresAt: string | null;
		includeDescendants?: boolean;
	},
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [result] = await conn.execute<ResultSetHeader>(
		`INSERT INTO kb_share_links (library_id, target_document_id, token_hash, expires_at, include_descendants)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			data.libraryId,
			data.targetDocumentId,
			data.tokenHash,
			data.expiresAt,
			data.includeDescendants ? 1 : 0,
		],
	);
	return Number(result.insertId);
}

export async function findShareLinkByHash(
	tokenHash: string,
	connection?: PoolConnection,
): Promise<{
	id: number;
	libraryId: number;
	targetDocumentId: number | null;
	expiresAt: string | null;
	revokedAt: string | null;
	includeDescendants: boolean;
} | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT id, library_id, target_document_id,
		        DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS expires_at,
		        DATE_FORMAT(revoked_at, '%Y-%m-%d %H:%i:%s') AS revoked_at,
		        include_descendants
		 FROM kb_share_links
		 WHERE token_hash = ?`,
		[tokenHash],
	);
	if (!row) return null;
	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		targetDocumentId: row.target_document_id !== null ? Number(row.target_document_id) : null,
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
		includeDescendants: Boolean(row.include_descendants),
	};
}

export async function listDocumentShareLinks(
	documentId: number,
	connection?: PoolConnection,
): Promise<KbShareLinkItem[]> {
	const conn = connection ?? pool;
	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT id, library_id, target_document_id,
		        DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS expires_at,
		        DATE_FORMAT(revoked_at, '%Y-%m-%d %H:%i:%s') AS revoked_at,
		        include_descendants,
		        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
		 FROM kb_share_links
		 WHERE target_document_id = ?
		 ORDER BY created_at DESC`,
		[documentId],
	);
	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		libraryId: Number(r.library_id),
		targetDocumentId: Number(r.target_document_id),
		expiresAt: r.expires_at ? String(r.expires_at) : null,
		revokedAt: r.revoked_at ? String(r.revoked_at) : null,
		includeDescendants: Boolean(r.include_descendants),
		createdAt: String(r.created_at),
	}));
}

export async function revokeShareLinkRecord(
	linkId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"UPDATE kb_share_links SET revoked_at = NOW() WHERE id = ?",
		[linkId],
	);
}

export async function getShareLinkById(
	linkId: number,
	connection?: PoolConnection,
): Promise<{
	id: number;
	libraryId: number;
	targetDocumentId: number | null;
	expiresAt: string | null;
	revokedAt: string | null;
} | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT id, library_id, target_document_id,
		        DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS expires_at,
		        DATE_FORMAT(revoked_at, '%Y-%m-%d %H:%i:%s') AS revoked_at
		 FROM kb_share_links WHERE id = ?`,
		[linkId],
	);
	if (!row) return null;
	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		targetDocumentId: row.target_document_id !== null ? Number(row.target_document_id) : null,
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
	};
}

export async function createCommentRecord(
	data: {
		libraryId: number;
		documentId: number;
		revisionId: number;
		parentId?: number | null;
		authorUserId: number;
		body: string;
		byteSize: number;
		channel: "internal" | "public";
		moderationStatus: "pending" | "approved" | "spam";
	},
	connection?: PoolConnection,
): Promise<number> {
	const conn = connection ?? pool;
	const [res] = await conn.execute<ResultSetHeader>(
		`INSERT INTO kb_comments (library_id, document_id, revision_id, parent_id, author_user_id, body, byte_size, channel, moderation_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			data.libraryId,
			data.documentId,
			data.revisionId,
			data.parentId ?? null,
			data.authorUserId,
			data.body.trim(),
			data.byteSize,
			data.channel,
			data.moderationStatus,
		],
	);
	return Number(res.insertId);
}

export async function listCommentsRecord(
	documentId: number,
	options: {
		channel?: "internal" | "public";
		includeUnapproved?: boolean;
	} = {},
	connection?: PoolConnection,
): Promise<KbCommentItem[]> {
	const conn = connection ?? pool;
	const params: unknown[] = [documentId];
	let channelFilter = "";
	if (options.channel) {
		channelFilter = "AND c.channel = ?";
		params.push(options.channel);
	}
	let modFilter = "";
	if (!options.includeUnapproved) {
		modFilter = "AND c.moderation_status = 'approved'";
	}

	const [rows] = await conn.query<RowDataPacket[]>(
		`SELECT c.id, c.library_id, c.document_id, c.revision_id, c.parent_id,
		        c.author_user_id, c.body, c.byte_size, c.channel, c.moderation_status,
		        DATE_FORMAT(c.resolved_at, '%Y-%m-%d %H:%i:%s') AS resolved_at,
		        c.version,
		        DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
		        DATE_FORMAT(c.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
		        u.account, u.nickname, u.avatar_url AS avatar
		 FROM kb_comments c
		 INNER JOIN comment_users u ON u.id = c.author_user_id
		 WHERE c.document_id = ? ${channelFilter} ${modFilter}
		 ORDER BY c.created_at ASC`,
		params,
	);

	return (rows as RowDataPacket[]).map((r) => ({
		id: Number(r.id),
		libraryId: Number(r.library_id),
		documentId: Number(r.document_id),
		revisionId: Number(r.revision_id),
		parentId: r.parent_id !== null ? Number(r.parent_id) : null,
		authorUserId: Number(r.author_user_id),
		authorName: String(r.nickname || r.account),
		authorAvatar: String(r.avatar || ""),
		body: String(r.body),
		byteSize: Number(r.byte_size),
		channel: r.channel as "internal" | "public",
		moderationStatus: r.moderation_status as "pending" | "approved" | "spam",
		resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
		version: Number(r.version),
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
	}));
}

export async function resolveCommentRecord(
	commentId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute(
		"UPDATE kb_comments SET resolved_at = NOW() WHERE id = ?",
		[commentId],
	);
}

export async function deleteCommentRecord(
	commentId: number,
	connection?: PoolConnection,
): Promise<void> {
	const conn = connection ?? pool;
	await conn.execute("DELETE FROM kb_comments WHERE id = ?", [commentId]);
}

export async function getCommentRecord(
	commentId: number,
	connection?: PoolConnection,
): Promise<{
	id: number;
	libraryId: number;
	documentId: number;
	authorUserId: number;
	channel: "internal" | "public";
	resolvedAt: string | null;
} | null> {
	const conn = connection ?? pool;
	const [[row]] = await conn.query<RowDataPacket[]>(
		`SELECT id, library_id, document_id, author_user_id, channel, resolved_at
		 FROM kb_comments WHERE id = ?`,
		[commentId],
	);
	if (!row) return null;
	return {
		id: Number(row.id),
		libraryId: Number(row.library_id),
		documentId: Number(row.document_id),
		authorUserId: Number(row.author_user_id),
		channel: row.channel as "internal" | "public",
		resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
	};
}


