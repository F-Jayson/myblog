import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { KbError } from "./errors.js";
import { hasKbAdminGrant, pool, setKbAdminGrant } from "./repository.js";

export type KbOpenApplicationStatus = "pending" | "approved" | "rejected";

export interface KbOpenApplication {
	id: number;
	userId: number;
	account: string;
	nickname: string;
	reason: string;
	status: KbOpenApplicationStatus;
	adminId: number | null;
	adminNote: string | null;
	createdAt: string;
	reviewedAt: string | null;
}

interface ApplicationRow extends RowDataPacket {
	id: number;
	user_id: number;
	account: string;
	nickname: string;
	reason: string;
	status: KbOpenApplicationStatus;
	admin_id: number | null;
	admin_note: string | null;
	created_at: Date | string;
	reviewed_at: Date | string | null;
}

function toIsoString(value: Date | string | null): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

function mapApplication(row: ApplicationRow): KbOpenApplication {
	return {
		id: Number(row.id),
		userId: Number(row.user_id),
		account: String(row.account ?? ""),
		nickname: String(row.nickname ?? ""),
		reason: String(row.reason ?? ""),
		status: row.status,
		adminId: row.admin_id === null ? null : Number(row.admin_id),
		adminNote: row.admin_note === null ? null : String(row.admin_note),
		createdAt: toIsoString(row.created_at) ?? "",
		reviewedAt: toIsoString(row.reviewed_at),
	};
}

const APPLICATION_SELECT = `SELECT a.id, a.user_id, a.reason, a.status, a.admin_id, a.admin_note,
	a.created_at, a.reviewed_at, u.account, u.nickname
	FROM kb_open_applications a
	JOIN comment_users u ON u.id = a.user_id`;

/**
 * 查询用户最近一次开通申请（含已处理的历史申请）
 */
export async function getLatestOpenApplication(userId: number): Promise<KbOpenApplication | null> {
	const [rows] = await pool.query<ApplicationRow[]>(
		`${APPLICATION_SELECT} WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 1`,
		[userId],
	);
	return rows.length > 0 ? mapApplication(rows[0]) : null;
}

/**
 * 提交开通申请：同一用户同时只允许一条 pending 记录
 */
export async function createOpenApplication(userId: number, reason: string): Promise<KbOpenApplication> {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		const [userRows] = await conn.query<RowDataPacket[]>(
			"SELECT id, is_active FROM comment_users WHERE id = ? FOR UPDATE",
			[userId],
		);
		if (userRows.length === 0 || !Boolean(Number(userRows[0].is_active))) {
			throw new KbError(403, "KB_APPLICATION_USER_INVALID", "账号不存在或已被禁用，无法提交申请");
		}
		if (await hasKbAdminGrant(userId, conn)) {
			throw new KbError(409, "KB_ALREADY_OPEN", "该账号已开通个人知识库，无需重复申请");
		}

		const [pendingRows] = await conn.query<RowDataPacket[]>(
			"SELECT id FROM kb_open_applications WHERE user_id = ? AND status = 'pending' LIMIT 1 FOR UPDATE",
			[userId],
		);
		if (pendingRows.length > 0) {
			throw new KbError(409, "KB_APPLICATION_PENDING", "已有待审核的申请，请等待管理员处理");
		}

		const [result] = await conn.execute<ResultSetHeader>(
			"INSERT INTO kb_open_applications (user_id, reason) VALUES (?, ?)",
			[userId, reason],
		);
		await conn.commit();

		const created = await getApplicationById(Number(result.insertId));
		if (!created) throw new KbError(500, "KB_APPLICATION_CREATE_FAILED", "申请创建失败，请稍后重试");
		return created;
	} catch (error) {
		await conn.rollback().catch(() => undefined);
		throw error;
	} finally {
		conn.release();
	}
}

async function getApplicationById(id: number): Promise<KbOpenApplication | null> {
	const [rows] = await pool.query<ApplicationRow[]>(`${APPLICATION_SELECT} WHERE a.id = ? LIMIT 1`, [id]);
	return rows.length > 0 ? mapApplication(rows[0]) : null;
}

/**
 * 管理端分页查询开通申请
 */
export async function listOpenApplications(params: {
	status?: KbOpenApplicationStatus;
	page: number;
	limit: number;
}): Promise<{ items: KbOpenApplication[]; total: number; page: number; limit: number }> {
	const page = Math.max(1, Math.floor(params.page));
	const limit = Math.min(100, Math.max(1, Math.floor(params.limit)));
	const offset = (page - 1) * limit;

	const conditions: string[] = [];
	const values: unknown[] = [];
	if (params.status) {
		conditions.push("a.status = ?");
		values.push(params.status);
	}
	const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

	const [[countRow]] = await pool.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS total FROM kb_open_applications a${where}`,
		values,
	);
	const [rows] = await pool.query<ApplicationRow[]>(
		`${APPLICATION_SELECT}${where} ORDER BY FIELD(a.status, 'pending', 'approved', 'rejected'), a.id DESC LIMIT ? OFFSET ?`,
		[...values, limit, offset],
	);

	return {
		items: rows.map(mapApplication),
		total: Number(countRow?.total ?? 0),
		page,
		limit,
	};
}

/**
 * 管理员审核：通过后写入 kb_admin_grants，实现永久开通（封禁仍由账号状态拦截）
 */
export async function reviewOpenApplication(params: {
	id: number;
	adminId: number | null;
	status: "approved" | "rejected";
	adminNote: string | null;
}): Promise<KbOpenApplication> {
	const conn = await pool.getConnection();
	try {
		await conn.beginTransaction();

		const [rows] = await conn.query<RowDataPacket[]>(
			"SELECT id, user_id, status FROM kb_open_applications WHERE id = ? FOR UPDATE",
			[params.id],
		);
		if (rows.length === 0) {
			throw new KbError(404, "KB_APPLICATION_NOT_FOUND", "申请不存在");
		}
		if (rows[0].status !== "pending") {
			throw new KbError(409, "KB_APPLICATION_REVIEWED", "该申请已被处理，不能重复审核");
		}

		await conn.execute(
			"UPDATE kb_open_applications SET status = ?, admin_id = ?, admin_note = ?, reviewed_at = NOW() WHERE id = ?",
			[params.status, params.adminId, params.adminNote, params.id],
		);

		if (params.status === "approved") {
			await setKbAdminGrant(Number(rows[0].user_id), true, params.adminId, conn);
		}

		await conn.commit();
		const updated = await getApplicationById(params.id);
		if (!updated) throw new KbError(500, "KB_APPLICATION_UPDATE_FAILED", "申请更新失败，请稍后重试");
		return updated;
	} catch (error) {
		await conn.rollback().catch(() => undefined);
		throw error;
	} finally {
		conn.release();
	}
}
