export const KB_DEFAULTS = {
	RULE_VERSION: "v1",

	// 准入与活跃度门槛
	AGE_REQUIREMENT_MS: 30 * 24 * 60 * 60 * 1000, // 严格大于 30 天 (now - created_at > 30*24h)
	ACTIVITY_WINDOW_DAYS: 30, // 统计近 30 个已结算 UTC 自然日
	SCORE_PASS_THRESHOLD: 70, // 100 分制及格线
	MIN_LOGIN_DAYS_D: 12, // 最少有效登录天数 D >= 12
	MIN_SERVICE_DAYS_S: 8, // 产生至少一项有效服务的不同天数 S >= 8
	MIN_TIME_WINDOWS_W: 3, // 4 个时间段 (1-7, 8-14, 15-21, 22-30) 中至少 3 段活跃 W >= 3
	DAILY_SERVICE_MAX_SCORE: 8, // 每天所有服务合计最高 8 分
	DAILY_SERVICE_CATEGORY_MAX_SCORE: 4, // 每类服务每天最高 4 分
	GRACE_PERIOD_MS: 14 * 24 * 60 * 60 * 1000, // 跌落后宽限期 14 天

	// 配额与容量限制
	MAX_STORAGE_BYTES_PER_OWNER: 100 * 1024 * 1024, // 100 MiB 知识库独立配额
	MAX_LIBRARIES_PER_USER: 10, // 每用户最多 10 个知识库
	MAX_DOCUMENTS_PER_LIBRARY: 1000, // 每库最多 1000 篇文档
	MAX_MARKDOWN_BODY_BYTES: 1 * 1024 * 1024, // 单篇 Markdown 正文 1 MiB
	MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024, // 单附件 10 MiB
	MAX_TREE_DEPTH: 20, // 目录树最大深度 20 层

	// 生命周期与保留期
	MAX_REVISIONS_KEPT: 200, // 历史版本最多保留 200 个
	REVISION_RETENTION_DAYS: 30, // 历史版本保留 30 天 (当前与已发布版本永不删除)
	TRASH_RETENTION_DAYS: 30, // 回收站保留 30 天
	STAGED_ATTACHMENT_CLEANUP_HOURS: 24, // 未绑定附件暂存保留 24 小时
	DEFAULT_SHARE_LINK_EXPIRY_DAYS: 7, // 分享链接默认 7 天
	DEFAULT_GRANT_EXPIRY_DAYS: 7, // MCP Grant 默认 7 天 (用户可选 1-30 天)
	DEVICE_FLOW_TIMEOUT_MS: 10 * 60 * 1000, // 设备授权码有效期 10 分钟
	DELIVERY_TOKEN_TTL_MS: 120 * 1000, // 交付凭证窗口 2 分钟
} as const;

export const ACTIVITY_SERVICE_POINTS = {
	clipboard_save: 1, // 剪贴板创建/有变化保存: 1分, 同对象同日最多1次
	image_upload: 1, // 图床成功上传真实文件: 1分, 同内容指纹同日最多1次
	compiler_run: 2, // 编译器成功完成有效执行: 2分, 同代码与输入指纹同日最多1次
	approved_comment: 1, // 审核通过的评论: 1分, 按评论ID去重
	kb_manual_save: 1, // 已开通用户手动保存知识库: 1分, 同文档同日最多1次
} as const;

export function isFeatureKbEnabled(): boolean {
	return process.env.FEATURE_KB_ENABLED === "true";
}

export function isFeatureKbWriteEnabled(): boolean {
	if (!isFeatureKbEnabled()) return false;
	return process.env.FEATURE_KB_WRITE_ENABLED !== "false";
}

export function isFeatureKbPublicEnabled(): boolean {
	if (!isFeatureKbEnabled()) return false;
	return process.env.FEATURE_KB_PUBLIC_ENABLED !== "false";
}

export function isFeatureKbCommentsEnabled(): boolean {
	if (!isFeatureKbEnabled()) return false;
	return process.env.FEATURE_KB_COMMENTS_ENABLED !== "false";
}

export function isFeatureKbLocalMcpEnabled(): boolean {
	if (!isFeatureKbEnabled()) return false;
	return process.env.FEATURE_KB_LOCAL_MCP_ENABLED === "true";
}
