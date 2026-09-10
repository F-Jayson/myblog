import os from "node:os";
import { statfsSync } from "node:fs";

export type MonitorRange = "1h" | "6h" | "24h" | "7d";

type RequestMetric = { at: number; method: string; path: string; status: number; durationMs: number };
type SqlMetric = { at: number; statement: string; durationMs: number; failed: boolean };

const startedAt = Date.now();
const MAX_RECORDS = 5_000;
const rangeMs: Record<MonitorRange, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const requests: RequestMetric[] = [];
const sqlStatements: SqlMetric[] = [];
let lastDatabaseActivityAt: string | null = null;
let lastDatabaseWriteAt: string | null = null;
let droppedRequestRecords = 0;
let droppedSqlRecords = 0;
let lastProcessCpu = process.cpuUsage();
let lastProcessCpuAt = performance.now();
type CpuInfo = ReturnType<typeof os.cpus>[number];
let lastHostCpu: CpuInfo[] = os.cpus();

function retain<T>(records: T[], record: T) {
	records.push(record);
	if (records.length <= MAX_RECORDS) return 0;
	const removed = records.length - MAX_RECORDS;
	records.splice(0, removed);
	return removed;
}

function cleanSql(statement: string) {
	return statement
		.replace(/'(?:[^'\\]|\\.)*'/gu, "?")
		.replace(/\b\d+(?:\.\d+)?\b/gu, "?")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 240);
}

function isObservabilityProbe(statement: string) {
	const normalized = statement.replace(/\s+/gu, " ").trim().replace(/;+$/u, "").toUpperCase();
	return normalized === "SELECT 1"
		|| normalized === "SELECT VERSION() AS VERSION, DATABASE() AS NAME, @@HOSTNAME AS HOST";
}

function isWriteStatement(statement: string) {
	return /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE)\b/iu.test(statement.trim());
}

export function recordRequest(metric: Omit<RequestMetric, "at">) {
	droppedRequestRecords += retain(requests, { ...metric, at: Date.now() });
}

export function recordSql(statement: string, durationMs: number, failed = false) {
	if (isObservabilityProbe(statement)) return;
	const completedAt = new Date().toISOString();
	lastDatabaseActivityAt = completedAt;
	if (!failed && isWriteStatement(statement)) lastDatabaseWriteAt = completedAt;
	droppedSqlRecords += retain(sqlStatements, { at: Date.now(), statement: cleanSql(statement), durationMs: Math.max(0, Math.round(durationMs)), failed });
}

export function getLastDatabaseActivityAt() {
	return lastDatabaseActivityAt;
}

export function getLastDatabaseWriteAt() {
	return lastDatabaseWriteAt;
}

function average(values: number[]) {
	return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : 0;
}

export function getRequestMetrics(range: MonitorRange, slowRequestMs: number, slowSqlMs: number) {
	const now = Date.now();
	const cutoff = now - rangeMs[range];
	const rangeRequests = requests.filter((record) => record.at >= cutoff);
	const rangeSql = sqlStatements.filter((record) => record.at >= cutoff);
	const bucketCount = 12;
	const bucketMs = Math.ceil(rangeMs[range] / bucketCount);
	const trends = Array.from({ length: bucketCount }, (_, index) => ({
		at: new Date(now - rangeMs[range] + index * bucketMs).toISOString(),
		requests: 0,
		errors: 0,
		slowRequests: 0,
		averageResponseMs: 0,
		averageSqlMs: 0,
		responseValues: [] as number[],
		sqlValues: [] as number[],
	}));
	for (const record of rangeRequests) {
		const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((record.at - cutoff) / bucketMs)));
		const bucket = trends[index];
		bucket.requests += 1;
		bucket.responseValues.push(record.durationMs);
		if (record.status >= 400) bucket.errors += 1;
		if (record.durationMs >= slowRequestMs) bucket.slowRequests += 1;
	}
	for (const record of rangeSql) {
		const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((record.at - cutoff) / bucketMs)));
		trends[index].sqlValues.push(record.durationMs);
	}
	const paths = new Map<string, { method: string; path: string; requests: number; errors: number; durations: number[] }>();
	for (const record of rangeRequests) {
		const key = `${record.method} ${record.path}`;
		const metric = paths.get(key) ?? { method: record.method, path: record.path, requests: 0, errors: 0, durations: [] };
		metric.requests += 1;
		metric.errors += record.status >= 400 ? 1 : 0;
		metric.durations.push(record.durationMs);
		paths.set(key, metric);
	}
	const recentExceptions = [
		...rangeRequests.filter((record) => record.status >= 400 || record.durationMs >= slowRequestMs).map((record) => ({
			type: record.status >= 400 ? "error" : "slow-request", at: new Date(record.at).toISOString(), method: record.method, path: record.path, status: record.status, durationMs: record.durationMs,
		})),
		...rangeSql.filter((record) => record.failed || record.durationMs >= slowSqlMs).map((record) => ({
			type: record.failed ? "sql-error" : "slow-sql", at: new Date(record.at).toISOString(), method: "SQL", path: record.statement, status: record.failed ? 500 : 200, durationMs: record.durationMs,
		})),
	].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 25);
	const requestDurations = rangeRequests.map((record) => record.durationMs);
	const sqlDurations = rangeSql.map((record) => record.durationMs);
	const firstRequestAt = requests[0]?.at ?? null;
	const firstSqlAt = sqlStatements[0]?.at ?? null;
	const requestRangeTruncated = droppedRequestRecords > 0 && firstRequestAt !== null && firstRequestAt > cutoff;
	const sqlRangeTruncated = droppedSqlRecords > 0 && firstSqlAt !== null && firstSqlAt > cutoff;
	return {
		range,
		collectedSince: new Date(startedAt).toISOString(),
		retention: {
			maxRecordsPerStream: MAX_RECORDS,
			truncated: requestRangeTruncated || sqlRangeTruncated,
			requests: { dropped: droppedRequestRecords, retainedSince: firstRequestAt === null ? null : new Date(firstRequestAt).toISOString(), rangeTruncated: requestRangeTruncated },
			sql: { dropped: droppedSqlRecords, retainedSince: firstSqlAt === null ? null : new Date(firstSqlAt).toISOString(), rangeTruncated: sqlRangeTruncated },
		},
		requests: { total: rangeRequests.length, errors: rangeRequests.filter((record) => record.status >= 400).length, slow: rangeRequests.filter((record) => record.durationMs >= slowRequestMs).length, averageResponseMs: average(requestDurations), peakResponseMs: requestDurations.length ? Math.max(...requestDurations) : 0 },
		sql: { total: rangeSql.length, errors: rangeSql.filter((record) => record.failed).length, slow: rangeSql.filter((record) => record.durationMs >= slowSqlMs).length, averageMs: average(sqlDurations), peakMs: sqlDurations.length ? Math.max(...sqlDurations) : 0, slowThresholdMs: slowSqlMs },
		trends: trends.map(({ responseValues, sqlValues, ...bucket }) => ({ ...bucket, averageResponseMs: average(responseValues), averageSqlMs: average(sqlValues) })),
		frequentPaths: [...paths.values()].map(({ durations, ...path }) => ({ ...path, averageResponseMs: average(durations), peakResponseMs: durations.length ? Math.max(...durations) : 0, errorRate: path.requests ? Number((path.errors / path.requests * 100).toFixed(1)) : 0 })).sort((left, right) => right.requests - left.requests || right.averageResponseMs - left.averageResponseMs).slice(0, 10),
		recentExceptions,
	};
}

export function getProcessSnapshot() {
	const cpus = os.cpus();
	const load = os.loadavg();
	const memory = process.memoryUsage();
	const now = performance.now();
	const processDelta = process.cpuUsage(lastProcessCpu);
	const processElapsedMicros = Math.max(1, (now - lastProcessCpuAt) * 1000);
	const processCpuPercent = Math.min(100, Math.max(0, Number(((processDelta.user + processDelta.system) / processElapsedMicros / Math.max(1, cpus.length) * 100).toFixed(1))));
	lastProcessCpu = process.cpuUsage();
	lastProcessCpuAt = now;
	const previousHostCpu = lastHostCpu;
	lastHostCpu = cpus;
	let hostCpuPercent: number | null = null;
	if (previousHostCpu.length === cpus.length && previousHostCpu.length > 0) {
		const totals = cpus.map((cpu, index) => {
			const previous = previousHostCpu[index];
			const previousTotal = previous.times.user + previous.times.nice + previous.times.sys + previous.times.idle + previous.times.irq;
			const currentTotal = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
			const idleDelta = cpu.times.idle - previous.times.idle;
			return currentTotal > previousTotal ? (1 - idleDelta / (currentTotal - previousTotal)) * 100 : 0;
		});
		hostCpuPercent = Number((totals.reduce((sum, value) => sum + value, 0) / totals.length).toFixed(1));
	}
	let disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number } | null = null;
	try {
		const stats = statfsSync(process.cwd());
		const totalBytes = Number(stats.blocks) * Number(stats.bsize);
		const freeBytes = Number(stats.bavail) * Number(stats.bsize);
		disk = { path: process.cwd(), totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
	} catch {
		// Disk statistics are unavailable on a few restricted hosts.
	}
	const processInfo = { pid: process.pid, name: "firefly-api", cpuPercent: processCpuPercent, node: process.version, uptimeSeconds: Math.floor(process.uptime()), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external };
	return { hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: { cores: cpus.length, model: cpus[0]?.model ?? "Unknown", load1: load[0], load5: load[1], load15: load[2], usagePercent: hostCpuPercent }, memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedBytes: os.totalmem() - os.freemem() }, disk, process: processInfo, processes: [processInfo] };
}
