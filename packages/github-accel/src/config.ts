/**
 * 加速节点配置全部来自环境变量：同一份镜像既能跑在 Docker（env_file）里，
 * 也能跑在裸机 systemd（EnvironmentFile）里，不需要再带一份配置文件。
 */

export interface AccelConfig {
	readonly port: number;
	readonly host: string;
	readonly secret: string;
	readonly allowPublic: boolean;
	readonly cacheDir: string;
	readonly cacheMaxBytes: number;
	readonly cacheTtlHours: number;
	readonly ratePerMinute: number;
	readonly concurrencyPerIp: number;
	readonly maxConcurrency: number;
	/** 游客档限速（字节/秒），0 表示不限速。 */
	readonly guestBytesPerSecond: number;
	/** 登录用户档限速（字节/秒），0 表示不限速。 */
	readonly memberBytesPerSecond: number;
	/** 游客每 IP 并发，默认 1：单连接限速 + 并发收窄，多开连接也刷不回带宽。 */
	readonly guestConcurrencyPerIp: number;
	readonly githubToken: string;
	readonly upstreamTimeoutMs: number;
}

const DEFAULTS = {
	port: 8787,
	host: "0.0.0.0",
	cacheMaxBytes: 21_474_836_480, // 20 GiB
	cacheTtlHours: 168, // 7 天
	ratePerMinute: 30,
	concurrencyPerIp: 3,
	maxConcurrency: 64,
	guestBytesPerSecond: 10_485_760, // 10 MiB/s
	memberBytesPerSecond: 104_857_600, // 100 MiB/s
	guestConcurrencyPerIp: 1,
	upstreamTimeoutMs: 30_000,
} as const;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Number("") === 0：如果直接把空字符串交给 Number，任何没配的数字变量都会变成 0
 * （端口 0、并发 0），所以空串和非法值都必须回退默认值。
 */
function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return fallback;
	return value;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	return Math.floor(readNumber(env, name, fallback));
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = env[name]?.trim().toLowerCase();
	if (raw === undefined || raw === "") return fallback;
	return TRUE_VALUES.has(raw);
}

function readString(env: NodeJS.ProcessEnv, name: string, fallback = ""): string {
	const raw = env[name];
	return raw === undefined ? fallback : raw.trim();
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AccelConfig {
	return {
		port: readInt(env, "ACCEL_PORT", DEFAULTS.port),
		host: readString(env, "ACCEL_HOST", DEFAULTS.host) || DEFAULTS.host,
		secret: readString(env, "ACCEL_SECRET"),
		allowPublic: readBoolean(env, "ACCEL_ALLOW_PUBLIC", true),
		cacheDir: readString(env, "ACCEL_CACHE_DIR"),
		cacheMaxBytes: readInt(env, "ACCEL_CACHE_MAX_BYTES", DEFAULTS.cacheMaxBytes),
		cacheTtlHours: readInt(env, "ACCEL_CACHE_TTL_HOURS", DEFAULTS.cacheTtlHours),
		ratePerMinute: readInt(env, "ACCEL_RATE_PER_MINUTE", DEFAULTS.ratePerMinute),
		concurrencyPerIp: readInt(env, "ACCEL_CONCURRENCY_PER_IP", DEFAULTS.concurrencyPerIp),
		maxConcurrency: readInt(env, "ACCEL_MAX_CONCURRENCY", DEFAULTS.maxConcurrency),
		// 0 是合法值（不限速），只有"未配置"才回退默认值，所以必须走 readInt 而不是 readString + ||。
		guestBytesPerSecond: readInt(env, "ACCEL_GUEST_BYTES_PER_SECOND", DEFAULTS.guestBytesPerSecond),
		memberBytesPerSecond: readInt(env, "ACCEL_MEMBER_BYTES_PER_SECOND", DEFAULTS.memberBytesPerSecond),
		guestConcurrencyPerIp: readInt(env, "ACCEL_GUEST_CONCURRENCY_PER_IP", DEFAULTS.guestConcurrencyPerIp),
		githubToken: readString(env, "ACCEL_GITHUB_TOKEN"),
		upstreamTimeoutMs: readInt(env, "ACCEL_UPSTREAM_TIMEOUT_MS", DEFAULTS.upstreamTimeoutMs),
	};
}

export const config: AccelConfig = readConfig();

/**
 * 安全相关的配置问题必须出现在启动日志里：签名校验静默放行是线上事故的经典来源。
 */
export function securityWarnings(cfg: AccelConfig): string[] {
	const warnings: string[] = [];
	if (cfg.secret === "" && !cfg.allowPublic) {
		warnings.push("ACCEL_SECRET 为空：签名校验已放行（仅限内网调试）。公网部署必须配置与主站一致的 ACCEL_SECRET。");
	}
	if (cfg.secret !== "" && cfg.secret.length < 32) {
		warnings.push("ACCEL_SECRET 少于 32 字符，建议与主站 GITHUB_ACCEL_SECRET 使用同一段至少 32 字符的随机串。");
	}
	return warnings;
}

// 模块加载即告警，避免某些入口忘了调用 securityWarnings 就上线
for (const warning of securityWarnings(config)) {
	console.warn("[github-accel] 配置告警：" + warning);
}
