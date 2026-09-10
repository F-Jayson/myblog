import mysql from "mysql2/promise";
import { config } from "./config.js";
import { getLastDatabaseActivityAt, getLastDatabaseWriteAt, recordSql } from "./telemetry.js";

export const pool = mysql.createPool({
	...config.db,
	charset: "utf8mb4",
	dateStrings: true,
	multipleStatements: true,
	waitForConnections: true,
});

// mysql2's promise facade delegates to this callback pool. Instrument it once so
// repository queries and transaction-bound connection queries share SQL timings.
const rawPool = pool.pool as unknown as {
	query: (...args: unknown[]) => unknown;
	execute: (...args: unknown[]) => unknown;
	on: (event: string, listener: (connection: unknown) => void) => void;
	_allConnections?: { length: number };
	_freeConnections?: { length: number };
	config?: { connectionLimit?: number };
};

function instrumentQueryMethod(target: { [key: string]: unknown }, name: "query" | "execute") {
	const original = target[name];
	if (typeof original !== "function" || (original as { __fireflyInstrumented?: boolean }).__fireflyInstrumented) return;
	const wrapped = function (this: unknown, ...args: unknown[]) {
		const started = performance.now();
		const statement = typeof args[0] === "string" ? args[0] : String((args[0] as { sql?: unknown })?.sql ?? name);
		const callbackIndex = [...args].reverse().findIndex((argument) => typeof argument === "function");
		if (callbackIndex >= 0) {
			const index = args.length - 1 - callbackIndex;
			const callback = args[index] as (...callbackArgs: unknown[]) => unknown;
			args[index] = (...callbackArgs: unknown[]) => { recordSql(statement, performance.now() - started, Boolean(callbackArgs[0])); return callback(...callbackArgs); };
		}
		return (original as (...methodArgs: unknown[]) => unknown).apply(this, args);
	};
	(wrapped as { __fireflyInstrumented?: boolean }).__fireflyInstrumented = true;
	target[name] = wrapped;
}

instrumentQueryMethod(rawPool as unknown as { [key: string]: unknown }, "query");
rawPool.on("connection", (connection) => {
	const rawConnection = connection as { [key: string]: unknown };
	instrumentQueryMethod(rawConnection, "query");
	instrumentQueryMethod(rawConnection, "execute");
});

export async function pingDatabase() {
	await pool.query("SELECT 1");
}

export async function getDatabaseStatus() {
	const checkedAt = new Date().toISOString();
	const configuredConnectionLimit = rawPool.config?.connectionLimit ?? config.db.connectionLimit;
	const connectionSnapshot = () => {
		const totalConnections = rawPool._allConnections?.length ?? null;
		const idleConnections = rawPool._freeConnections?.length ?? null;
		const activeConnections = totalConnections === null || idleConnections === null ? null : Math.max(0, totalConnections - idleConnections);
		return { activeConnections, idleConnections, totalConnections };
	};
	try {
		const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version, DATABASE() AS name, @@hostname AS host");
		return { connected: true, checkedAt, lastActivityAt: getLastDatabaseActivityAt(), lastWriteAt: getLastDatabaseWriteAt(), database: { name: String(row?.name ?? config.db.database), host: String(row?.host ?? config.db.host), version: String(row?.version ?? "unknown"), configuredConnectionLimit, ...connectionSnapshot() } };
	} catch {
		return { connected: false, checkedAt, lastActivityAt: getLastDatabaseActivityAt(), lastWriteAt: getLastDatabaseWriteAt(), database: { name: config.db.database, host: config.db.host, version: null, configuredConnectionLimit, ...connectionSnapshot() } };
	}
}
