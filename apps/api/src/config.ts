import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function numberFromEnv(value: string | undefined, fallback: number) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
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
	return decoded.toString("utf8");
}

export const config = {
	host: process.env.API_HOST?.trim() || "127.0.0.1",
	port: numberFromEnv(process.env.API_PORT, 5180),
	clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5174",
	// `change-me` was the old example value and must never enable a real login.
	adminToken: configuredLegacyAdminToken === "change-me" ? "" : configuredLegacyAdminToken,
	adminName: process.env.ADMIN_DISPLAY_NAME?.trim() || "admin",
	monitorSlowRequestMs: numberFromEnv(process.env.MONITOR_SLOW_REQUEST_MS, 1000),
	monitorSlowSqlMs: numberFromEnv(process.env.MONITOR_SLOW_SQL_MS, 200),
	compiler: {
		dockerBinary: process.env.COMPILER_DOCKER_BIN?.trim() || "docker",
		network: process.env.COMPILER_DOCKER_NETWORK?.trim() || "none",
		// This directory must be visible to the Docker daemon. Deployments set it
		// below the application directory instead of using a PrivateTmp path.
		workDirectory: process.env.COMPILER_WORKDIR?.trim() || ".compiler-work",
		defaultTimeoutMs: numberFromEnv(process.env.COMPILER_TIMEOUT_MS, 20_000),
		maxTimeoutMs: numberFromEnv(process.env.COMPILER_MAX_TIMEOUT_MS, 30_000),
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
		database: process.env.MYSQL_DATABASE ?? "firefly_blog",
		user: process.env.MYSQL_USER ?? "root",
		password: databasePasswordFromEnv(),
		connectionLimit: numberFromEnv(process.env.MYSQL_CONNECTION_LIMIT, 10),
	},
};
