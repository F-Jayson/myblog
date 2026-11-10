import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function numberFromEnv(value: string | undefined, fallback: number) {
	const trimmed = value?.trim();
	// `Number("")` is 0 rather than NaN, so an empty variable must fall back
	// instead of silently configuring a zero port or a zero-sized pool.
	if (!trimmed) return fallback;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanFromEnv(value: string | undefined, fallback = false) {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return fallback;
	return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

const configuredLegacyAdminToken = (process.env.ADMIN_API_TOKEN ?? "").trim();

function databasePasswordFromEnv() {
	const encoded = process.env.MYSQL_PASSWORD_BASE64?.trim();
	if (!encoded) return process.env.MYSQL_PASSWORD ?? "";

	// The deployment manager encodes this value so systemd cannot reinterpret
	// special characters while reading the EnvironmentFile.
	const decoded = Buffer.from(encoded, "base64");
	const normalizedInput = encoded.replace(/=+$/, "");
	const normalizedOutput = decoded.toString("base64").replace(/=+$/, "");
	if (!decoded.length || normalizedInput !== normalizedOutput) {
		throw new Error("MYSQL_PASSWORD_BASE64 must be valid base64");
	}
	// Base64 validity alone does not prove the payload is UTF-8: invalid bytes
	// are silently rewritten to U+FFFD, which turns into an unexplainable
	// authentication failure later on.
	const text = decoded.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(decoded)) {
		throw new Error("MYSQL_PASSWORD_BASE64 must decode to valid UTF-8");
	}
	return text;
}

const storageDrivers = ["local", "r2", "worker"] as const;
type StorageDriver = (typeof storageDrivers)[number];

function storageDriverFromEnv(): StorageDriver {
	const raw = process.env.STORAGE_DRIVER?.trim().toLowerCase();
	if (!raw) return "local";
	const matched = storageDrivers.find((driver) => driver === raw);
	if (!matched) {
		// An unknown value used to fall through to the auto-detect branch in
		// storage.ts, silently activating a backend the operator never chose.
		throw new Error(`STORAGE_DRIVER must be one of ${storageDrivers.join(", ")}, received "${raw}"`);
	}
	return matched;
}

const compilerMaxTimeoutMs = numberFromEnv(process.env.COMPILER_MAX_TIMEOUT_MS, 30_000);

export const config = {
	host: process.env.API_HOST?.trim() || "127.0.0.1",
	port: numberFromEnv(process.env.API_PORT, 5180),
	clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5174",
	// 只有明确部署在反向代理后面才信任 X-Forwarded-For，否则按直连地址计限流
	trustProxy: booleanFromEnv(process.env.TRUST_PROXY),
	// `change-me` was the old example value and must never enable a real login.
	adminToken: configuredLegacyAdminToken === "change-me" ? "" : configuredLegacyAdminToken,
	// 知识库 Agent 设备交付令牌的加密密钥，缺省时退回复用 ADMIN_API_TOKEN
	kbAgentTokenSecret: (process.env.KB_AGENT_TOKEN_SECRET ?? "").trim(),
	adminName: process.env.ADMIN_DISPLAY_NAME?.trim() || "admin",
	// [128] 不再把业务域名硬编码为默认值：漏配时回退到请求来源，而不是生成指向他人域名的公开链接
	filesPublicOrigin: (process.env.FILES_PUBLIC_ORIGIN?.trim() ?? "").replace(/\/+$/u, ""),
	monitorSlowRequestMs: numberFromEnv(process.env.MONITOR_SLOW_REQUEST_MS, 1000),
	monitorSlowSqlMs: numberFromEnv(process.env.MONITOR_SLOW_SQL_MS, 200),
	agentGrantDays: Math.min(365, Math.max(1, numberFromEnv(process.env.AGENT_GRANT_DAYS, 90))),
	compiler: {
		dockerBinary: process.env.COMPILER_DOCKER_BIN?.trim() || "docker",
		network: process.env.COMPILER_DOCKER_NETWORK?.trim() || "none",
		// This directory must be visible to the Docker daemon. Deployments set it
		// below the application directory instead of using a PrivateTmp path.
		workDirectory: process.env.COMPILER_WORKDIR?.trim() || ".compiler-work",
		// Keep the default below the ceiling, otherwise validateOptions trims it
		// to an arbitrary value and the sandbox timeout becomes unpredictable.
		defaultTimeoutMs: Math.min(numberFromEnv(process.env.COMPILER_TIMEOUT_MS, 20_000), compilerMaxTimeoutMs),
		maxTimeoutMs: compilerMaxTimeoutMs,
		maxSourceBytes: numberFromEnv(process.env.COMPILER_MAX_SOURCE_BYTES, 256 * 1024),
		maxStdinBytes: numberFromEnv(process.env.COMPILER_MAX_STDIN_BYTES, 64 * 1024),
		maxConcurrentJobs: numberFromEnv(process.env.COMPILER_MAX_CONCURRENT, 2),
		maxQueuedJobs: numberFromEnv(process.env.COMPILER_MAX_QUEUED, 8),
		memoryLimit: process.env.COMPILER_MEMORY_LIMIT?.trim() || "256m",
		cpuLimit: process.env.COMPILER_CPU_LIMIT?.trim() || "1",
	},
	db: {
		host: process.env.MYSQL_HOST ?? "127.0.0.1",
		port: numberFromEnv(process.env.MYSQL_PORT, 3306),
		database: process.env.MYSQL_DATABASE ?? "jayson_blog",
		user: process.env.MYSQL_USER ?? "root",
		password: databasePasswordFromEnv(),
		connectionLimit: numberFromEnv(process.env.MYSQL_CONNECTION_LIMIT, 10),
	},
	storage: {
		driver: storageDriverFromEnv(),
		r2: {
			accountId: process.env.R2_ACCOUNT_ID?.trim() || "",
			accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim() || "",
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim() || "",
			bucketName: process.env.R2_BUCKET_NAME?.trim() || "",
			publicUrl: (process.env.R2_PUBLIC_URL?.trim() || "").replace(/\/+$/u, ""),
			endpoint: process.env.R2_ENDPOINT?.trim() || "",
			region: process.env.R2_REGION?.trim() || "auto",
			keepLocalCopy: booleanFromEnv(process.env.R2_KEEP_LOCAL_COPY),
		},
		worker: {
			url: (process.env.WORKER_STORAGE_URL?.trim() || "").replace(/\/+$/u, ""),
			token: process.env.WORKER_STORAGE_TOKEN?.trim() || "",
			keepLocalCopy: booleanFromEnv(process.env.WORKER_KEEP_LOCAL_COPY),
		},
	},
};

function warnIncompleteStorageConfig() {
	const { driver, r2, worker } = config.storage;
	if (driver === "r2") {
		const missing = [
			["R2_ACCOUNT_ID", r2.accountId],
			["R2_ACCESS_KEY_ID", r2.accessKeyId],
			["R2_SECRET_ACCESS_KEY", r2.secretAccessKey],
			["R2_BUCKET_NAME", r2.bucketName],
		].filter(([, value]) => !value).map(([name]) => name);
		if (missing.length) console.warn(`[config] STORAGE_DRIVER=r2 但缺少 ${missing.join(", ")}，存储功能将不可用`);
	}
	if (driver === "worker") {
		const missing = [["WORKER_STORAGE_URL", worker.url], ["WORKER_STORAGE_TOKEN", worker.token]]
			.filter(([, value]) => !value)
			.map(([name]) => name);
		if (missing.length) console.warn(`[config] STORAGE_DRIVER=worker 但缺少 ${missing.join(", ")}，存储功能将不可用`);
	}
}

warnIncompleteStorageConfig();

if (process.env.NODE_ENV === "production") {
	if (!config.adminToken) {
		console.warn("[config] ADMIN_API_TOKEN 未配置：传统管理员登录接口已关闭");
	} else if (config.adminToken.length < 16) {
		console.warn("[config] ADMIN_API_TOKEN 长度不足 16 位，存在被暴力枚举的风险");
	}
	// 交付令牌加密密钥缺失时设备授权流程会直接失败，这里提前提示而不是静默降级
	if (!config.kbAgentTokenSecret && !config.adminToken) {
		console.warn("[config] KB_AGENT_TOKEN_SECRET 与 ADMIN_API_TOKEN 都未配置：知识库 Agent 设备授权将不可用");
	}
}
