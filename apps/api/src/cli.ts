import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ResultSetHeader } from "mysql2";
import mysql from "mysql2/promise";
import { config } from "./config.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function assertDatabaseIdentifier(database: string) {
	if (!/^[A-Za-z0-9_$]+$/.test(database)) {
		throw new Error("MYSQL_DATABASE must contain only ASCII letters, digits, underscore, or dollar signs");
	}
}

function removeHardcodedBootstrapStatements(fileName: string, sql: string) {
	// These anchored patterns only remove the legacy statements at the beginning
	// of the checked-in SQL files; SQL later in the file is left untouched.
	if (fileName === "schema.sql") {
		return sql.replace(
			/^\uFEFF?\s*CREATE DATABASE IF NOT EXISTS firefly_blog CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\s*USE firefly_blog;\s*/i,
			"",
		);
	}
	if (fileName === "seed.sql") {
		return sql.replace(/^\uFEFF?\s*USE firefly_blog;\s*/i, "");
	}
	return sql;
}

async function executeSql(fileName: string) {
	assertDatabaseIdentifier(config.db.database);
	const rawSql = await readFile(new URL(`../../../database/${fileName}`, import.meta.url), "utf8");
	const sql = removeHardcodedBootstrapStatements(fileName, rawSql);
	const connection = await mysql.createConnection({ ...config.db, multipleStatements: true });
	try {
		await connection.query(sql);
		console.log(`Applied ${fileName} from ${root}`);
	} finally {
		await connection.end();
	}
}

async function readHiddenLine(prompt: string) {
	let muted = false;
	const output = new Writable({
		write(chunk, encoding, callback) {
			if (!muted) process.stdout.write(chunk, encoding);
			callback();
		},
	});
	const readline = createInterface({ input: process.stdin, output, terminal: true });
	try {
		process.stdout.write(prompt);
		muted = true;
		const value = await readline.question("");
		muted = false;
		process.stdout.write("\n");
		return value;
	} finally {
		muted = false;
		readline.close();
	}
}

async function readAdministratorPassword() {
	if (process.stdin.isTTY && process.stdout.isTTY) {
		const password = await readHiddenLine("Administrator password (12-128 characters): " );
		const confirmation = await readHiddenLine("Confirm administrator password: " );
		if (password !== confirmation) throw new Error("Administrator passwords do not match");
		return password;
	}

	const input = readFileSync(0, "utf8");
	return input.endsWith("\r\n") ? input.slice(0, -2) : input.endsWith("\n") ? input.slice(0, -1) : input;
}

async function setInitialAdminPassword() {
	const password = await readAdministratorPassword();
	if (password.includes("\n") || password.includes("\r") || password.length < 12 || password.length > 128) {
		throw new Error("Administrator password must be 12-128 characters and contain no line breaks");
	}

	const salt = randomBytes(16).toString("hex");
	const derived = scryptSync(password, salt, 64).toString("hex");
	const passwordHash = ["scrypt", salt, derived].join("$");
	const connection = await mysql.createConnection(config.db);
	try {
		await connection.beginTransaction();
		await connection.execute<ResultSetHeader>(
			"INSERT INTO admin_users (username, display_name, password_hash, role, is_active) VALUES ('admin', '系统管理员', ?, 'superadmin', TRUE) ON DUPLICATE KEY UPDATE password_hash = ?, is_active = TRUE",
			[passwordHash, passwordHash],
		);
		await connection.execute(
			"DELETE s FROM admin_sessions AS s INNER JOIN admin_users AS u ON u.id = s.user_id WHERE u.username = 'admin'",
		);
		await connection.commit();
		console.log("Initial administrator password updated");
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		await connection.end();
	}
}

const command = process.argv[2];
if (command === "migrate") {
	await executeSql("schema.sql");
} else if (command === "seed") {
	await executeSql("seed.sql");
} else if (command === "set-admin-password") {
	await setInitialAdminPassword();
} else {
	console.error("Usage: pnpm db:migrate | pnpm db:seed | tsx src/cli.ts set-admin-password");
	process.exitCode = 1;
}
