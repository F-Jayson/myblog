import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

/**
 * Online compiler execution is deliberately kept in a separate module. The
 * API process never evaluates submitted source code; every run is delegated to
 * a short-lived, network-isolated Docker container with resource limits.
 */

export type CompilerLanguage = {
	id: string;
	name: string;
	extension: string;
	mode: string;
	image: string;
	run: string[];
	debug?: "python-trace" | "node-inspector";
	formatOnly?: boolean;
};

type CompilerRunOptions = {
	language: string;
	code: string;
	stdin?: string;
	timeoutMs?: number;
	breakpoints?: number[];
	debug?: boolean;
};

export type CompilerDiagnostic = {
	line?: number;
	column?: number;
	message: string;
	severity: "error" | "warning" | "info";
};

export type CompilerRunResult = {
	language: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	diagnostics: CompilerDiagnostic[];
	breakpoints: number[];
	hitBreakpoints: number[];
	debug?: {
		breakpoints: number[];
		hitBreakpoints: number[];
		stoppedAt: number | null;
		message: string;
		variables?: Record<string, unknown>;
		stack?: string[];
	};
};

export class CompilerError extends Error {
	readonly statusCode: number;
	readonly code: string;

	constructor(message: string, statusCode = 400, code = "COMPILER_ERROR") {
		super(message);
		this.name = "CompilerError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

const languages: readonly CompilerLanguage[] = Object.freeze([
	{ id: "python", name: "Python 3", extension: "py", mode: "python", image: "python:3.12-alpine", run: ["python3", "main.py"], debug: "python-trace" },
	{ id: "javascript", name: "JavaScript (Node.js)", extension: "js", mode: "javascript", image: "node:22-alpine", run: ["node", "main.js"], debug: "node-inspector" },
	{ id: "typescript", name: "TypeScript", extension: "ts", mode: "typescript", image: "node:22-alpine", run: ["node", "--experimental-strip-types", "main.ts"], debug: "node-inspector" },
	{ id: "java", name: "Java", extension: "java", mode: "java", image: "eclipse-temurin:21-jdk-alpine", run: ["sh", "-c", "mkdir -p /tmp/firefly-java && javac -d /tmp/firefly-java Main.java && java -cp /tmp/firefly-java Main"] },
	{ id: "c", name: "C (GCC)", extension: "c", mode: "c", image: "gcc:14-bookworm", run: ["sh", "-c", "gcc main.c -O2 -o /tmp/firefly-main && /tmp/firefly-main"] },
	{ id: "cpp", name: "C++ (G++)", extension: "cpp", mode: "cpp", image: "gcc:14-bookworm", run: ["sh", "-c", "g++ main.cpp -O2 -std=c++20 -o /tmp/firefly-main && /tmp/firefly-main"] },
	{ id: "csharp", name: "C# (.NET)", extension: "cs", mode: "csharp", image: "mcr.microsoft.com/dotnet/sdk:8.0-alpine", run: ["sh", "-c", "dotnet new console -o /tmp/firefly-app --force >/dev/null && cp /workspace/main.cs /tmp/firefly-app/Program.cs && dotnet run --project /tmp/firefly-app --nologo --property:UseAppHost=false"] },
	{ id: "go", name: "Go", extension: "go", mode: "go", image: "golang:1.23-alpine", run: ["go", "run", "main.go"] },
	{ id: "rust", name: "Rust", extension: "rs", mode: "rust", image: "rust:1.82-alpine", run: ["sh", "-c", "rustc main.rs -O -o /tmp/firefly-main && /tmp/firefly-main"] },
	{ id: "php", name: "PHP", extension: "php", mode: "php", image: "php:8.3-cli-alpine", run: ["php", "main.php"] },
	{ id: "ruby", name: "Ruby", extension: "rb", mode: "ruby", image: "ruby:3.3-alpine", run: ["ruby", "main.rb"] },
	{ id: "kotlin", name: "Kotlin", extension: "kt", mode: "kotlin", image: "zenika/kotlin:1.4.10-jdk12", run: ["sh", "-c", "kotlinc Main.kt -d /tmp/firefly-main.jar && kotlin -classpath /tmp/firefly-main.jar MainKt"] },
	{ id: "swift", name: "Swift", extension: "swift", mode: "swift", image: "swift:5.10-jammy", run: ["sh", "-c", "swiftc main.swift -O -o /tmp/firefly-main && /tmp/firefly-main"] },
	{ id: "bash", name: "Bash", extension: "sh", mode: "shell", image: "bash:5.2", run: ["bash", "main.sh"] },
	{ id: "sql", name: "SQL (SQLite)", extension: "sql", mode: "sql", image: "python:3.12-alpine", run: ["python3", "__firefly_sql.py"] },
	{ id: "json", name: "JSON", extension: "json", mode: "json", image: "node:22-alpine", run: [], formatOnly: true },
	{ id: "html", name: "HTML", extension: "html", mode: "html", image: "node:22-alpine", run: [], formatOnly: true },
	{ id: "css", name: "CSS", extension: "css", mode: "css", image: "node:22-alpine", run: [], formatOnly: true },
]);

const languageMap = new Map(languages.map((language) => [language.id, language]));
const outputLimit = 2 * 1024 * 1024;
const markerPrefix = "@@FIREFLY_BREAKPOINT@@";
let activeJobs = 0;
const jobWaiters: Array<() => void> = [];

async function acquireJobSlot() {
	const maximum = Math.max(1, Math.floor(config.compiler.maxConcurrentJobs));
	if (activeJobs >= maximum) {
		if (jobWaiters.length >= Math.max(0, Math.floor(config.compiler.maxQueuedJobs))) {
			throw new CompilerError("在线编译任务繁忙，请稍后重试", 429, "COMPILER_BUSY");
		}
		await new Promise<void>((resolveWaiter) => jobWaiters.push(resolveWaiter));
	}
	activeJobs += 1;
}

function releaseJobSlot() {
	activeJobs = Math.max(0, activeJobs - 1);
	jobWaiters.shift()?.();
}

export function listCompilerLanguages() {
	return languages.map(({ id, name, extension, mode, formatOnly }) => ({ id, name, extension, mode, runnable: !formatOnly }));
}

export function getCompilerLanguage(id: string) {
	return languageMap.get(id.trim().toLowerCase());
}

function sourceFileName(language: CompilerLanguage) {
	return language.id === "java" || language.id === "kotlin" ? "Main." + language.extension : "main." + language.extension;
}

async function writeWorkspaceFile(path: string, content: string) {
	await writeFile(path, content, { encoding: "utf8", flag: "wx" });
	// systemd uses UMask=0027 for the API process. Docker intentionally runs
	// as a different unprivileged UID, so source files need an explicit public
	// read bit while the workspace directory remains writable only by the API.
	await chmod(path, 0o644);
}

function boundedOutput(value: string) {
	if (value.length <= outputLimit) return value;
	return value.slice(0, outputLimit) + "\n[output truncated]";
}

function parseDiagnostics(stderr: string): CompilerDiagnostic[] {
	const diagnostics: CompilerDiagnostic[] = [];
	for (const line of stderr.split(/\r?\n/u)) {
		const text = line.trim();
		if (!text) continue;
		const match = /^(?:[^:\n]+:)?(\d+)(?::(\d+))?(?:[:)]|\s+-\s+)?\s*(.*)$/u.exec(text);
		if (match) {
			const lineNumber = Number(match[1]);
			const columnNumber = match[2] ? Number(match[2]) : undefined;
			diagnostics.push({ line: lineNumber, column: columnNumber, message: match[3] || text, severity: /warning/i.test(text) ? "warning" : "error" });
		} else {
			diagnostics.push({ message: text, severity: "error" });
		}
	}
	return diagnostics.slice(0, 200);
}

function validateOptions(options: CompilerRunOptions, language: CompilerLanguage) {
	if (Buffer.byteLength(options.code, "utf8") > config.compiler.maxSourceBytes) {
		throw new CompilerError(`代码不能超过 ${Math.floor(config.compiler.maxSourceBytes / 1024)} KB`, 413, "SOURCE_TOO_LARGE");
	}
	if (options.stdin && Buffer.byteLength(options.stdin, "utf8") > config.compiler.maxStdinBytes) {
		throw new CompilerError(`标准输入不能超过 ${Math.floor(config.compiler.maxStdinBytes / 1024)} KB`, 413, "STDIN_TOO_LARGE");
	}
	const timeoutMs = options.timeoutMs ?? config.compiler.defaultTimeoutMs;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > config.compiler.maxTimeoutMs) {
		throw new CompilerError(`执行超时时间必须在 250-${config.compiler.maxTimeoutMs}ms 之间`, 400, "INVALID_TIMEOUT");
	}
	const lines = options.code.split(/\r?\n/u).length;
	const breakpoints = [...new Set((options.breakpoints ?? []).filter((line) => Number.isInteger(line)).map(Number))].sort((a, b) => a - b);
	if (breakpoints.some((line) => line < 1 || line > lines)) {
		throw new CompilerError("断点行号超出代码范围", 400, "INVALID_BREAKPOINT");
	}
	if (breakpoints.length > 200) throw new CompilerError("断点数量不能超过 200 个", 400, "TOO_MANY_BREAKPOINTS");
	return { timeoutMs, breakpoints, language };
}

type ChildResult = { stdout: string; stderr: string; exitCode: number | null };

async function runContainer(args: string[], containerName: string, input: string, timeoutMs: number): Promise<ChildResult> {
	return await new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(config.compiler.dockerBinary, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
		const finish = (result: Pick<ChildResult, "exitCode">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout: boundedOutput(stdout), stderr: boundedOutput(stderr), ...result });
		};
		const forceRemoveContainer = async () => {
			await new Promise<void>((done) => {
				const remover = spawn(config.compiler.dockerBinary, ["rm", "-f", containerName], { stdio: "ignore", shell: false });
				const removeTimer = setTimeout(() => { remover.kill("SIGKILL"); done(); }, 2_000);
				remover.once("close", () => { clearTimeout(removeTimer); done(); });
				remover.once("error", () => { clearTimeout(removeTimer); done(); });
			});
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			void forceRemoveContainer().finally(() => {
				child.kill("SIGKILL");
				resolve({ stdout: boundedOutput(stdout), stderr: boundedOutput(stderr + "\n程序执行超时"), exitCode: null });
			});
		}, timeoutMs);
		const appendOutput = (current: string, chunk: Buffer | string) => current.length >= outputLimit ? current : (current + chunk.toString()).slice(0, outputLimit);
		child.stdout.on("data", (chunk: Buffer | string) => { stdout = appendOutput(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer | string) => { stderr = appendOutput(stderr, chunk); });
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error.code === "ENOENT") reject(new CompilerError("服务器未安装 Docker，暂时无法使用在线编译", 503, "DOCKER_UNAVAILABLE"));
			else reject(new CompilerError(`无法启动 Docker：${error.message}`, 503, "DOCKER_UNAVAILABLE"));
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			if (exitCode === 125) {
				settled = true;
				clearTimeout(timer);
				const unavailable = /docker daemon|cannot connect|is the docker daemon running|permission denied/iu.test(stderr);
				reject(new CompilerError(unavailable ? "Docker 服务不可用，请联系管理员" : "编译器镜像不可用，请联系管理员执行部署脚本", 503, unavailable ? "DOCKER_UNAVAILABLE" : "COMPILER_IMAGE_UNAVAILABLE"));
				return;
			}
			finish({ exitCode });
		});
		child.stdin.on("error", () => undefined);
		if (input) child.stdin.write(input);
		child.stdin.end();
	});
}

function dockerArgs(workDirectory: string, containerName: string, language: CompilerLanguage, command: string[]) {
	return [
		"run", "--rm", "--init", "--interactive",
		"--pull=never",
		// Do not let a base image's ENTRYPOINT prepend or replace the validated
		// command (some database/toolchain images define one by default).
		"--entrypoint", "",
		"--name", containerName,
		"--network", config.compiler.network,
		"--cpus", config.compiler.cpuLimit,
		"--memory", config.compiler.memoryLimit,
		"--pids-limit", "128",
		"--read-only",
		// Several toolchains (notably Go and dotnet) execute their temporary
		// build artifact from /tmp, so keep the tmpfs bounded but executable.
		// Compilers (Swift/C/C++/Rust) need to execute artifacts from /tmp;
		// Docker tmpfs defaults to noexec when mounted with the hardening flags.
		"--tmpfs", "/tmp:rw,nosuid,exec,size=64m",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", "65532:65532",
		"--env", "HOME=/tmp",
		"--env", "GOCACHE=/tmp/go-cache",
		"--env", "GOPATH=/tmp/go-path",
		"--env", "CARGO_HOME=/tmp/cargo-home",
		"--env", "DOTNET_CLI_HOME=/tmp/dotnet-home",
		"--env", "NUGET_PACKAGES=/tmp/nuget-packages",
		"--ulimit", "fsize=16777216",
		// Keep submitted source read-only inside the container; compiler outputs
		// are written to the bounded /tmp tmpfs instead.
		"--mount", `type=bind,src=${workDirectory},dst=/workspace,readonly`,
		"--workdir", "/workspace",
		language.image,
		...command,
	];
}

function pythonDebugWrapper(breakpoints: number[], debugMarker: string) {
	const encoded = JSON.stringify(breakpoints);
	return [
		"import json, runpy, sys",
		`breakpoints = set(${encoded})`,
		"def trace(frame, event, arg):",
		"    if event == 'line' and frame.f_code.co_filename.endswith('/main.py') and frame.f_lineno in breakpoints:",
		`        print(${JSON.stringify(debugMarker)} + json.dumps({'line': frame.f_lineno}), flush=True)`,
		"        raise SystemExit(0)",
		"    return trace",
		"sys.settrace(trace)",
		"try:",
		"    runpy.run_path('/workspace/main.py', run_name='__main__')",
		"finally:",
		"    sys.settrace(None)",
	].join("\n") + "\n";
}

function nodeDebugWrapper(sourceFile: string, breakpoints: number[], debugMarker: string) {
	const encodedBreakpoints = JSON.stringify(breakpoints);
	const encodedSourceFile = JSON.stringify(`/workspace/${sourceFile}`);
	const encodedMarker = JSON.stringify(debugMarker);
	return [
		'"use strict";',
		'const fs = require("node:fs");',
		'const inspector = require("node:inspector");',
		'const Module = require("node:module");',
		'const { pathToFileURL } = require("node:url");',
		`const requestedLines = new Set(${encodedBreakpoints});`,
		`const sourceFile = ${encodedSourceFile};`,
		"const sourceUrl = pathToFileURL(sourceFile).href;",
		"const session = new inspector.Session();",
		"const breakpointLines = new Map();",
		"let stopping = false;",
		"function post(method, params = {}) {",
		"  return new Promise((resolve, reject) => {",
		"    session.post(method, params, (error, value) => error ? reject(error) : resolve(value));",
		"  });",
		"}",
		'session.on("Debugger.paused", (event) => {',
		"  if (stopping) return;",
		"  const requestedLine = event.params.hitBreakpoints.map((id) => breakpointLines.get(id)).find((line) => line !== undefined);",
		"  const frame = event.params.callFrames[0];",
		"  if (!frame || requestedLine === undefined) { void post(\"Debugger.resume\").catch(() => undefined); return; }",
		"  stopping = true;",
		`  fs.writeSync(1, ${encodedMarker} + JSON.stringify({ line: requestedLine, stoppedAt: requestedLine }) + "\\n");`,
		"  process.exit(0);",
		"});",
		"(async () => {",
		"  session.connect();",
		'  await post("Debugger.enable");',
		"  for (const line of requestedLines) {",
		'    const result = await post("Debugger.setBreakpointByUrl", { lineNumber: line - 1, columnNumber: 0, urlRegex: sourceFile.endsWith(".ts") ? "main\\\\.ts$" : "main\\\\.js$" });',
		"    breakpointLines.set(result.breakpointId, line);",
		"  }",
		"  process.argv[1] = sourceFile;",
		`  ${sourceFile.endsWith(".ts") ? "await import(sourceUrl);" : "Module._load(sourceFile, null, true);"}`,
		"})().catch((error) => {",
		"  console.error(error instanceof Error ? error.stack || error.message : String(error));",
		"  process.exitCode = 1;",
		"});",
	].join("\n") + "\n";
}

function pullMarkers(stdout: string, debugMarker: string) {
	const hit = new Set<number>();
	let stoppedAt: number | null = null;
	const clean: string[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (line.startsWith(debugMarker)) {
			try {
				const value = JSON.parse(line.slice(debugMarker.length)) as { line?: unknown; stoppedAt?: unknown };
				if (Number.isInteger(value.line)) hit.add(Number(value.line));
				if (Number.isInteger(value.stoppedAt)) stoppedAt = Number(value.stoppedAt);
			} catch {
				// Ignore malformed internal markers; user output remains unaffected.
			}
			continue;
		}
		clean.push(line);
	}
	return { stdout: clean.join("\n"), hitBreakpoints: [...hit].sort((a, b) => a - b), stoppedAt };
}

function sqlRunnerScript() {
	return [
		"import pathlib, sqlite3",
		"connection = sqlite3.connect(':memory:')",
		"source = pathlib.Path('/workspace/main.sql').read_text(encoding='utf-8')",
		"cursor = connection.cursor()",
		"def execute(statement):",
		"    statement = statement.strip()",
		"    if not statement: return",
		"    cursor.execute(statement)",
		"    if cursor.description:",
		"        print('\\t'.join(column[0] for column in cursor.description))",
		"        for row in cursor.fetchall():",
		"            print('\\t'.join(str(value) if value is not None else '' for value in row))",
		"buffer = ''",
		"for line in source.splitlines(keepends=True):",
		"    buffer += line",
		"    while True:",
		"        end = -1",
		"        for index, character in enumerate(buffer):",
		"            if character == ';' and sqlite3.complete_statement(buffer[:index + 1]):",
		"                end = index + 1",
		"                break",
		"        if end < 0: break",
		"        execute(buffer[:end])",
		"        buffer = buffer[end:]",
		"if buffer.strip(): execute(buffer)",
		"connection.commit()",
	].join("\n") + "\n";
}

export async function executeCompiler(options: CompilerRunOptions): Promise<CompilerRunResult> {
	const language = getCompilerLanguage(options.language);
	if (!language) throw new CompilerError("暂不支持该编程语言", 400, "UNSUPPORTED_LANGUAGE");
	const validated = validateOptions(options, language);
	if (language.formatOnly) throw new CompilerError("该语言仅支持格式化，不支持容器执行", 400, "FORMAT_ONLY_LANGUAGE");
	await acquireJobSlot();
	let workDirectory = "";
	try {
		const workspaceRoot = resolve(config.compiler.workDirectory);
		await mkdir(workspaceRoot, { recursive: true });
		workDirectory = await mkdtemp(join(workspaceRoot, "firefly-compiler-"));
		// Docker runs as an unprivileged numeric user. The temporary directory is
		// private to this request and removed in finally below.
		// The container only needs directory traversal: the bind mount is
		// read-only, and all compiler artifacts go to its bounded /tmp tmpfs.
		await chmod(workDirectory, 0o711);
		await writeWorkspaceFile(join(workDirectory, sourceFileName(language)), options.code);
		let command = language.run;
		if (language.id === "sql") {
			await writeWorkspaceFile(join(workDirectory, "__firefly_sql.py"), sqlRunnerScript());
			command = ["python3", "__firefly_sql.py"];
		}
		const debugMarker = `${markerPrefix}${randomUUID()}@@`;
		if (options.debug && language.debug === "python-trace") {
			await writeWorkspaceFile(join(workDirectory, "__firefly_debug.py"), pythonDebugWrapper(validated.breakpoints, debugMarker));
			command = ["python3", "__firefly_debug.py"];
		}
		if (options.debug && language.debug === "node-inspector") {
			const sourceFile = sourceFileName(language);
			await writeWorkspaceFile(join(workDirectory, "__firefly_debug.cjs"), nodeDebugWrapper(sourceFile, validated.breakpoints, debugMarker));
			command = language.id === "typescript"
				? ["node", "--experimental-strip-types", "__firefly_debug.cjs"]
				: ["node", "__firefly_debug.cjs"];
		}
		const started = performance.now();
		const containerName = `firefly-compiler-${randomUUID()}`;
		const result = await runContainer(dockerArgs(workDirectory, containerName, language, command), containerName, options.stdin ?? "", validated.timeoutMs);
		const markerResult = options.debug && language.debug ? pullMarkers(result.stdout, debugMarker) : { stdout: result.stdout, hitBreakpoints: [], stoppedAt: null };
		const debug = options.debug ? {
			breakpoints: validated.breakpoints,
			hitBreakpoints: markerResult.hitBreakpoints,
			stoppedAt: markerResult.stoppedAt ?? markerResult.hitBreakpoints[0] ?? null,
			message: language.debug
				? markerResult.hitBreakpoints.length ? `已命中 ${markerResult.hitBreakpoints.length} 个断点` : "未命中已设置的断点"
				: "当前语言返回运行结果；断点命中追踪暂由 Python、JavaScript 和 TypeScript 支持",
		} : undefined;
		return {
			language: language.id,
			stdout: markerResult.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			durationMs: Math.round(performance.now() - started),
			diagnostics: parseDiagnostics(result.stderr),
			breakpoints: validated.breakpoints,
			hitBreakpoints: markerResult.hitBreakpoints,
			debug,
		};
	} finally {
		if (workDirectory) await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
		releaseJobSlot();
	}
}

function genericFormat(source: string) {
	const normalized = source.replace(/\r\n?/gu, "\n").trim();
	if (!normalized) return "";
	let output = "";
	let indent = 0;
	let quote = "";
	let escaped = false;
	let lineStart = true;
	for (const character of normalized) {
		if (quote) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") { quote = character; output += character; lineStart = false; continue; }
		if (character === "{") {
			output = output.trimEnd() + " {\n" + "  ".repeat(++indent);
			lineStart = true;
			continue;
		}
		if (character === "}") {
			indent = Math.max(0, indent - 1);
			output = output.trimEnd() + "\n" + "  ".repeat(indent) + "}";
			lineStart = false;
			continue;
		}
		if (character === ";") { output = output.trimEnd() + ";\n" + "  ".repeat(indent); lineStart = true; continue; }
		if (character === "\n") { output = output.trimEnd() + "\n" + "  ".repeat(indent); lineStart = true; continue; }
		if (lineStart && /\s/u.test(character)) continue;
		output += character;
		lineStart = false;
	}
	return output.trim() + "\n";
}

export function formatCompilerCode(languageId: string, source: string) {
	const language = getCompilerLanguage(languageId);
	if (!language) throw new CompilerError("暂不支持该编程语言", 400, "UNSUPPORTED_LANGUAGE");
	if (Buffer.byteLength(source, "utf8") > config.compiler.maxSourceBytes) throw new CompilerError("代码内容过大", 413, "SOURCE_TOO_LARGE");
	if (language.id === "json") {
		try { return JSON.stringify(JSON.parse(source), null, 2) + "\n"; } catch { throw new CompilerError("JSON 格式无效，无法格式化", 400, "INVALID_FORMAT"); }
	}
	if (["python", "ruby", "php", "bash"].includes(language.id)) return source.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim() + (source.trim() ? "\n" : "");
	return genericFormat(source);
}
