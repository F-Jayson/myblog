#!/usr/bin/env node
// 下载 PlantUML 的 jar，供 /tools/puml 页面在服务端渲染图片。
// 用法：pnpm --filter @jayson-blog/api puml:install [--force]
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = "1.2025.10";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TARGET = resolve(REPOSITORY_ROOT, process.env.PUML_JAR?.trim() || "data/plantuml/plantuml.jar");
const SOURCES = [
	`https://maven.aliyun.com/repository/public/net/sourceforge/plantuml/plantuml/${VERSION}/plantuml-${VERSION}.jar`,
	`https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/${VERSION}/plantuml-${VERSION}.jar`,
];
// 1.2025.10 的 jar 约 25MB；低于这个数量级基本说明下到的是错误页。
const MIN_BYTES = 20 * 1024 * 1024;
const force = process.argv.includes("--force");

async function jarLooksValid(path) {
	try {
		const info = await stat(path);
		if (info.size < MIN_BYTES) return false;
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(2);
			await handle.read(buffer, 0, 2, 0);
			// jar 就是 zip：以 "PK" 开头
			return buffer[0] === 0x50 && buffer[1] === 0x4b;
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

async function download(url, destination) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length") ?? 0);
	await mkdir(dirname(destination), { recursive: true });
	let received = 0;
	let lastPrint = 0;
	const source = Readable.fromWeb(response.body);
	source.on("data", (chunk) => {
		received += chunk.length;
		const now = Date.now();
		if (now - lastPrint < 400) return;
		lastPrint = now;
		const percent = total ? ` ${((received / total) * 100).toFixed(1)}%` : "";
		process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)}MB${percent}`);
	});
	await pipeline(source, createWriteStream(destination));
	process.stdout.write("\n");
	return received;
}

async function main() {
	if (!force && (await jarLooksValid(TARGET))) {
		const info = await stat(TARGET);
		console.log(`✓ 已存在可用的 PlantUML jar：${TARGET}（${(info.size / 1024 / 1024).toFixed(1)}MB）`);
		return;
	}

	const temporary = `${TARGET}.download`;
	let lastError = null;
	for (const url of SOURCES) {
		console.log(`↓ 正在下载 PlantUML ${VERSION}\n  ${url}`);
		try {
			await rm(temporary, { force: true });
			const bytes = await download(url, temporary);
			if (bytes < MIN_BYTES || !(await jarLooksValid(temporary))) throw new Error(`文件不完整（${bytes} 字节）`);
			await rename(temporary, TARGET);
			console.log(`✓ 已安装到 ${TARGET}（${(bytes / 1024 / 1024).toFixed(1)}MB）`);
			return;
		} catch (error) {
			lastError = error;
			await rm(temporary, { force: true });
			console.warn(`  下载失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	console.error("\n✗ 所有下载源都失败了。可以手动下载 jar 后放到：" + TARGET);
	console.error(`  下载地址：https://maven.aliyun.com/repository/public/net/sourceforge/plantuml/plantuml/${VERSION}/plantuml-${VERSION}.jar`);
	if (lastError) console.error(`  最后一次错误：${lastError instanceof Error ? lastError.message : String(lastError)}`);
	process.exitCode = 1;
}

await main();
