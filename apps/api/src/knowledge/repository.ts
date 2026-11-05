import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import mysql from "mysql2/promise";
import { config } from "../config.js";
import { ACTIVITY_SERVICE_POINTS, KB_DEFAULTS } from "./constants.js";
import type {
	ActivityEventInput,
	ActivityType,
	KbAccessMode,
	KbEntitlement,
	KbMemberRole,
	KbVisibility,
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
		        rule_version, activated_at, grace_started_at, restriction_reason
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
			entitlement.activatedAt,
			entitlement.graceStartedAt,
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
