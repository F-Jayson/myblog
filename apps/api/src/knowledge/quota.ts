import type { PoolConnection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { KB_DEFAULTS } from "./constants.js";
import { KbQuotaExceededError } from "./errors.js";

/**
 * 统一锁顺序上下文执行器
 * 严格按照：所有者账号行 (comment_users) -> 知识库行 (knowledge_bases) -> 文档行 (kb_documents) 进行 FOR UPDATE 加锁，防止死锁
 */
export async function acquireKnowledgeLocks(
	connection: PoolConnection,
	params: {
		ownerUserId: number;
		libraryId?: number;
		documentId?: number;
	},
): Promise<void> {
	// 1. 锁定所有者账号行
	await connection.query<RowDataPacket[]>(
		"SELECT id FROM comment_users WHERE id = ? FOR UPDATE",
		[params.ownerUserId],
	);

	// 2. 锁定知识库行
	if (params.libraryId) {
		await connection.query<RowDataPacket[]>(
			"SELECT id FROM knowledge_bases WHERE id = ? FOR UPDATE",
			[params.libraryId],
		);
	}

	// 3. 锁定文档行
	if (params.documentId) {
		await connection.query<RowDataPacket[]>(
			"SELECT id FROM kb_documents WHERE id = ? FOR UPDATE",
			[params.documentId],
		);
	}
}

/**
 * 获取当前所有者已使用的知识库总字节数
 * 计入：仍保留的 revision 字节、评论字节、附件字节（含暂存）
 */
export async function getOwnerKnowledgeUsage(
	connection: PoolConnection,
	ownerUserId: number,
): Promise<{
	revisions: number;
	comments: number;
	attachments: number;
	totalBytes: number;
}> {
	// 1. 统计当前所有者名下所有库内文档 revisions 的字节占用
	const [[revRow]] = await connection.query<RowDataPacket[]>(
		`SELECT COALESCE(SUM(r.byte_size), 0) AS total
		 FROM kb_revisions r
		 INNER JOIN kb_documents d ON d.id = r.document_id
		 INNER JOIN knowledge_bases k ON k.id = d.library_id
		 WHERE k.owner_user_id = ?`,
		[ownerUserId],
	);

	// 2. 统计评论字节占用
	const [[commentRow]] = await connection.query<RowDataPacket[]>(
		`SELECT COALESCE(SUM(c.byte_size), 0) AS total
		 FROM kb_comments c
		 INNER JOIN knowledge_bases k ON k.id = c.library_id
		 WHERE k.owner_user_id = ?`,
		[ownerUserId],
	);

	// 3. 统计附件实际占用 (包含暂存 staged 和绑定 bound，排除已物理标记删除)
	const [[attRow]] = await connection.query<RowDataPacket[]>(
		`SELECT COALESCE(SUM(byte_size), 0) AS total
		 FROM kb_attachments
		 WHERE owner_user_id = ? AND status != 'marked_delete'`,
		[ownerUserId],
	);

	const revisions = Number(revRow?.total ?? 0);
	const comments = Number(commentRow?.total ?? 0);
	const attachments = Number(attRow?.total ?? 0);
	const totalBytes = revisions + comments + attachments;

	return { revisions, comments, attachments, totalBytes };
}

/**
 * 校验并预扣配额，如果超限则抛出 KbQuotaExceededError
 */
export async function assertOwnerQuotaAvailable(
	connection: PoolConnection,
	ownerUserId: number,
	incomingBytes: number,
): Promise<{ usedBytes: number; remainingBytes: number }> {
	const usage = await getOwnerKnowledgeUsage(connection, ownerUserId);
	const maxBytes = KB_DEFAULTS.MAX_STORAGE_BYTES_PER_OWNER;

	if (usage.totalBytes + incomingBytes > maxBytes) {
		throw new KbQuotaExceededError(
			`知识库配额已满：当前已用 ${(usage.totalBytes / (1024 * 1024)).toFixed(2)} MiB，上限 ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB，写入 ${incomingBytes} 字节将被拒绝`,
		);
	}

	return {
		usedBytes: usage.totalBytes,
		remainingBytes: Math.max(0, maxBytes - usage.totalBytes - incomingBytes),
	};
}
