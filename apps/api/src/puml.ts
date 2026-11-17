import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { config } from "./config.js";

/** The tool page posts at most this much source; anything larger is a mistake. */
export const PUML_MAX_SOURCE_BYTES = 64 * 1024;

// A single warm JVM can render many diagrams, so the limits are small on
// purpose: they only exist to keep one browser tab from monopolising the box.
const MAX_CONCURRENT_RENDERS = 2;
const MAX_QUEUED_RENDERS = 6;
const STARTUP_TIMEOUT_MS = 20_000;
// PlantUML keeps the JVM resident (about 150MB); stop it when nobody draws.
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const CACHE_ENTRIES = 120;

const JVM_MAX_HEAP = "-Xmx512m";

/**
 * PlantUML's own base64 variant: 6-bit chunks mapped onto
 * "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_" after the
 * source is deflate-compressed. Verified against the 1.2025.10 jar.
 */
const PUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

export type PumlEngine = "local" | "remote";

export type PumlRenderResult =
	| { ok: true; svg: string; engine: PumlEngine; ms: number; width: number | null; height: number | null; cached: boolean }
	| { ok: false; engine: PumlEngine | null; ms: number; error: { message: string; line: number | null; raw: string; hint?: string } };

export class PumlError extends Error {
	readonly statusCode: number;
	readonly code: string;
	readonly hint: string | undefined;

	constructor(message: string, statusCode = 500, code = "PUML_ERROR", hint?: string) {
		super(message);
		this.name = "PumlError";
		this.statusCode = statusCode;
		this.code = code;
		this.hint = hint;
	}
}

export function encodePumlSource(source: string) {
	const compressed = deflateRawSync(Buffer.from(source, "utf8"), { level: 9 });
	let output = "";
	for (let index = 0; index < compressed.length; index += 3) {
		const first = compressed[index] ?? 0;
		const second = compressed[index + 1] ?? 0;
		const third = compressed[index + 2] ?? 0;
		output += PUML_ALPHABET.charAt(first >> 2);
		output += PUML_ALPHABET.charAt(((first & 0x03) << 4) | (second >> 4));
		if (index + 1 < compressed.length) output += PUML_ALPHABET.charAt(((second & 0x0f) << 2) | (third >> 6));
		if (index + 2 < compressed.length) output += PUML_ALPHABET.charAt(third & 0x3f);
	}
	return output;
}

function decodeEntities(text: string) {
	return text
		.replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'")
		.replace(/&amp;/gu, "&");
}

/** PlantUML renders errors as a diagram, so the message lives in <text> nodes. */
function svgTextLines(svg: string) {
	const lines: string[] = [];
	for (const match of svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gu)) {
		const raw = (match[1] ?? "").replace(/<[^>]*>/gu, "");
		const text = decodeEntities(raw).replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
		if (text) lines.push(text);
	}
	return lines;
}

function parseErrorSvg(svg: string) {
	const lines = svgTextLines(svg);
	// PlantUML's error diagram starts with its welcome banner, and the
	// "[From string (line N) ]" marker only says where the diagram starts, not
	// where the mistake is, so both are dropped from what we show the user.
	const markerIndex = lines.findIndex((text) => /\[From string \(line \d+\) \]/iu.test(text));
	const detailLines = (markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines).filter(
		(text) => !/\[From string \(line \d+\) \]/iu.test(text),
	);
	const sourceLines = detailLines.filter((text) => !/syntax error/iu.test(text) && !/assumed diagram type/iu.test(text));
	const raw = (sourceLines.length ? sourceLines : detailLines).join("\n").slice(0, 1200);
	const joined = detailLines.join("\n");

	if (/syntax error/iu.test(joined)) {
		return {
			message: "语法错误，PlantUML 无法解析这段代码",
			line: null,
			raw,
			hint: "常见原因：括号或引号没有闭合、箭头写法有误，或 @startuml / @enduml 没有成对出现。",
		};
	}
	const failure =
		detailLines.find((text) => /cannot find graphviz|no dot executable/iu.test(text)) ??
		detailLines.find((text) => /^error\b/iu.test(text));
	if (failure) {
		return { message: failure, line: null, raw, hint: "这条错误由 PlantUML 引擎返回，可对照源码逐行排查。" };
	}

	// "hello world" and friends make PlantUML give up before drawing anything and
	// answer with its welcome page instead of a diagram.
	return {
		message: "没有识别到可以绘制的图表内容",
		line: null,
		raw,
		hint: "请以 @startuml 开头，并至少写一条元素定义，例如 Alice -> Bob: Hello。",
	};
}

function svgSize(svg: string) {
	const widthMatch = svg.match(/<svg\b[^>]*?\bwidth="([\d.]+)(?:px)?"/u);
	const heightMatch = svg.match(/<svg\b[^>]*?\bheight="([\d.]+)(?:px)?"/u);
	if (widthMatch && heightMatch) {
		const width = Math.round(Number(widthMatch[1]));
		const height = Math.round(Number(heightMatch[1]));
		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
	}
	const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/u);
	if (viewBox) {
		const width = Math.round(Number(viewBox[1]));
		const height = Math.round(Number(viewBox[2]));
		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
	}
	return { width: null, height: null };
}

function findOnPath(executable: string) {
	const entries = (process.env.PATH ?? "").split(delimiter);
	for (const entry of entries) {
		if (!entry) continue;
		const candidate = join(entry, executable);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function resolveJavaPath() {
	const configured = config.puml.javaPath;
	if (configured) return existsSync(configured) ? configured : null;
	const executable = process.platform === "win32" ? "java.exe" : "java";
	const javaHome = process.env.JAVA_HOME?.trim();
	if (javaHome) {
		const candidate = join(javaHome, "bin", executable);
		if (existsSync(candidate)) return candidate;
	}
	return findOnPath(executable);
}

function jarInfo() {
	const path = config.puml.jarPath;
	if (!existsSync(path)) return { path, exists: false, size: null as number | null };
	try {
		return { path, exists: true, size: statSync(path).size };
	} catch {
		return { path, exists: false, size: null as number | null };
	}
}

function allocatePort() {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.once("listening", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("无法分配端口"))));
		});
		server.listen(0, "127.0.0.1");
	});
}

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps one PlantUML picoweb server alive so repeated previews only pay for the
 * render (about 15ms) instead of a JVM start (about 1.7s).
 *
 * PlantUML always binds 0.0.0.0 for picoweb, so we keep the exposure small: a random
 * free port, lazy start, and a five minute idle timeout that kills the JVM again.
 * Deployments on untrusted networks should firewall that port or point
 * PUML_SERVER_URL at an isolated PlantUML service instead.
 */
class LocalPumlEngine {
	private child: ChildProcess | null = null;
	private port = 0;
	private starting: Promise<void> | null = null;
	private stderrTail = "";
	private idleTimer: NodeJS.Timeout | null = null;
	private active = 0;
	private versionValue: string | null = null;
	private versionProbing = false;

	get running() {
		return this.child !== null;
	}

	get version() {
		return this.versionValue;
	}

	probeVersion() {
		if (this.versionValue || this.versionProbing) return;
		const java = resolveJavaPath();
		const jar = jarInfo();
		if (!java || !jar.exists) return;
		this.versionProbing = true;
		try {
			// Runs once per process: 1.2025.10 prints "PlantUML version 1.2025.10 (...)".
			const result = spawnSync(java, ["-jar", jar.path, "-version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
			const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
			const match = text.match(/PlantUML version\s+([\w.]+)/u);
			this.versionValue = match ? match[1] ?? null : null;
		} catch {
			this.versionValue = null;
		} finally {
			this.versionProbing = false;
		}
	}

	async ensureRunning() {
		if (this.child) return;
		this.starting ??= this.start().finally(() => {
			this.starting = null;
		});
		await this.starting;
	}

	private async start() {
		const java = resolveJavaPath();
		if (!java) {
			throw new PumlError(
				"服务端没有找到 Java 运行时，无法本地渲染 PlantUML",
				503,
				"PUML_NO_JAVA",
				"安装 JDK 17+ 并把 java 加入 PATH，或用 PUML_JAVA 指定可执行文件；也可以配置 PUML_SERVER_URL 走远程渲染。",
			);
		}
		const jar = jarInfo();
		if (!jar.exists) {
			throw new PumlError(
				"服务端缺少 plantuml.jar",
				503,
				"PUML_NO_JAR",
				"在仓库根目录执行 `pnpm puml:install` 下载 PlantUML，或用 PUML_JAR 指定已有 jar。",
			);
		}

		// A port race is possible (another process may grab the port in between),
		// so retry a couple of times before giving up.
		let lastError: unknown = null;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const port = await allocatePort();
			try {
				await this.spawnOn(port, java, jar.path);
				return;
			} catch (error) {
				lastError = error;
				this.killChild();
			}
		}
		throw lastError instanceof PumlError
			? lastError
			: new PumlError("PlantUML 渲染服务启动失败", 503, "PUML_START_FAILED", String(lastError ?? ""));
	}

	private async spawnOn(port: number, java: string, jarPath: string) {
		this.stderrTail = "";
		// PlantUML resolves !include against the working directory, so the JVM runs
		// from an empty scratch folder instead of the repository.
		const workDir = join(tmpdir(), "blog-plantuml-work");
		try {
			mkdirSync(workDir, { recursive: true });
		} catch {
			// A missing scratch folder only costs us the extra isolation.
		}
		const child = spawn(java, [JVM_MAX_HEAP, "-Djava.awt.headless=true", "-jar", jarPath, `-picoweb:${port}`, "-charset", "UTF-8"], {
			cwd: workDir,
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
		});
		child.once("exit", () => {
			if (this.child === child) {
				this.child = null;
				this.port = 0;
			}
		});
		// `error` fires when the executable itself cannot be started.
		const spawnError = await new Promise<Error | null>((resolve) => {
			child.once("error", (error) => resolve(error));
			setTimeout(() => resolve(null), 500);
		});
		if (spawnError) throw new PumlError(`无法启动 Java：${spawnError.message}`, 503, "PUML_JAVA_SPAWN");

		this.child = child;
		this.port = port;

		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				throw new PumlError("PlantUML 渲染服务意外退出", 503, "PUML_EXITED", this.stderrTail.slice(-600));
			}
			try {
				const response = await fetch(`http://127.0.0.1:${port}/plantuml/svg/`, { signal: AbortSignal.timeout(1500) });
				await response.text();
				return;
			} catch {
				await delay(250);
			}
		}
		throw new PumlError("PlantUML 渲染服务启动超时", 503, "PUML_START_TIMEOUT");
	}

	private killChild() {
		const child = this.child;
		this.child = null;
		this.port = 0;
		if (child && child.exitCode === null) child.kill();
	}

	touch() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (!this.child) return;
		this.idleTimer = setTimeout(() => {
			// Never stop mid-render; the next render just starts a fresh JVM.
			if (this.active === 0) this.stop();
			else this.touch();
		}, IDLE_SHUTDOWN_MS);
		this.idleTimer.unref?.();
	}

	async render(source: string, timeoutMs: number) {
		await this.ensureRunning();
		this.active += 1;
		try {
			const url = `http://127.0.0.1:${this.port}/plantuml/svg/${encodePumlSource(source)}`;
			const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
			const body = await response.text();
			if (response.status !== 200 || !body.includes("<svg")) throw new PumlRenderFailure(body, response.status);
			return body;
		} finally {
			this.active -= 1;
			this.touch();
		}
	}

	stop() {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.killChild();
	}
}

/** Internal signal that the engine answered, but with an error diagram. */
class PumlRenderFailure extends Error {
	readonly status: number;
	readonly body: string;

	constructor(body: string, status: number) {
		super("PlantUML render failed");
		this.name = "PumlRenderFailure";
		this.body = body;
		this.status = status;
	}
}

const localEngine = new LocalPumlEngine();

let activeRenders = 0;
const waitingRenders: Array<() => void> = [];

async function acquireSlot() {
	if (activeRenders < MAX_CONCURRENT_RENDERS) {
		activeRenders += 1;
		return;
	}
	if (waitingRenders.length >= MAX_QUEUED_RENDERS) {
		throw new PumlError("渲染任务过多，请稍后再试", 503, "PUML_BUSY");
	}
	await new Promise<void>((resolve) => waitingRenders.push(resolve));
}

function releaseSlot() {
	const next = waitingRenders.shift();
	if (next) next();
	else activeRenders -= 1;
}

type CacheEntry = { svg: string; engine: PumlEngine; width: number | null; height: number | null };

const cache = new Map<string, CacheEntry>();

function cacheKey(source: string) {
	return createHash("sha1").update(source).digest("hex");
}

function readCache(key: string) {
	const entry = cache.get(key);
	if (!entry) return null;
	// Refresh insertion order so the Map behaves like an LRU list.
	cache.delete(key);
	cache.set(key, entry);
	return entry;
}

function writeCache(key: string, entry: CacheEntry) {
	cache.set(key, entry);
	while (cache.size > CACHE_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

/** Very small per-IP window; the tool renders on every keystroke pause. */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

function checkRate(ip: string) {
	const now = Date.now();
	const bucket = rateBuckets.get(ip);
	if (!bucket || bucket.resetAt <= now) {
		rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		if (rateBuckets.size > 2048) {
			for (const [key, value] of rateBuckets) {
				if (value.resetAt <= now) rateBuckets.delete(key);
			}
		}
		return;
	}
	bucket.count += 1;
	if (bucket.count > RATE_LIMIT) throw new PumlError("渲染请求过于频繁，请稍后再试", 429, "PUML_RATE_LIMITED");
}

// PlantUML's preprocessor can read files and environment variables from the
// machine that renders. That is fine for a local desktop run, but this endpoint is
// open to any visitor, so file-reading directives are refused before rendering.
// `<...>` includes stay allowed: those files ship inside the jar.
const UNSAFE_DIRECTIVE = /^\s*!(?:include|import)/iu;
const UNSAFE_FUNCTION = /%[a-z_]*(?:load|getenv|file|dirpath|filename|import)[a-z_]*\s*\(/iu;

function assertSafeSource(text: string) {
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!UNSAFE_DIRECTIVE.test(line)) continue;
		const argument = line.replace(/^!\w+\s*/u, "").trim();
		if (argument.startsWith("<") && !argument.includes("..")) continue;
		throw new PumlError(
			"这段代码里的 !include / !import 会被拒绝",
			400,
			"PUML_UNSAFE_SOURCE",
			"线上渲染不读取服务器上的文件；请把被包含的内容直接粘贴进来。`!include <标准库文件>` 仍然可用。",
		);
	}
	if (UNSAFE_FUNCTION.test(text)) {
		throw new PumlError(
			"这段代码调用了读取服务器信息的预处理函数",
			400,
			"PUML_UNSAFE_SOURCE",
			"请去掉 %getenv、%load_json、%file_exists 之类的函数后再渲染。",
		);
	}
}

/**
 * Graphviz is optional: when it is missing PlantUML refuses class/ER/component
 * diagrams instead of drawing them, so retry such failures with the bundled
 * Smetana layout engine. Sequence and activity diagrams never hit this path.
 */
const GRAPHVIZ_MISSING = /cannot find graphviz|dot executable does not exist|failed to execute dot/iu;

function withSmetanaLayout(source: string) {
	if (/!pragma\s+layout\s+smetana/iu.test(source)) return source;
	const lines = source.split("\n");
	const startLine = lines.findIndex((line) => /^\s*@startuml\b/iu.test(line));
	if (startLine >= 0) lines.splice(startLine + 1, 0, "!pragma layout smetana");
	else lines.unshift("!pragma layout smetana");
	return lines.join("\n");
}

async function renderRemote(source: string, timeoutMs: number) {
	const base = config.puml.serverUrl;
	if (!base) throw new PumlError("未配置远程 PlantUML 服务", 503, "PUML_NO_REMOTE");
	const response = await fetch(`${base}/svg/${encodePumlSource(source)}`, { signal: AbortSignal.timeout(timeoutMs) });
	const body = await response.text();
	if (response.status !== 200 || !body.includes("<svg")) throw new PumlRenderFailure(body, response.status);
	return body;
}

export async function renderPuml(source: string, options: { ip?: string } = {}): Promise<PumlRenderResult> {
	if (!config.puml.enabled) throw new PumlError("PlantUML 渲染功能已关闭", 503, "PUML_DISABLED");
	checkRate(options.ip ?? "unknown");

	const text = source.replace(/\r\n/gu, "\n").trim();
	if (!text) throw new PumlError("请输入 PlantUML 代码", 400, "PUML_EMPTY");
	assertSafeSource(text);

	const key = cacheKey(text);
	const cached = readCache(key);
	if (cached) {
		return { ok: true, svg: cached.svg, engine: cached.engine, ms: 0, width: cached.width, height: cached.height, cached: true };
	}

	const hasLocal = Boolean(resolveJavaPath() && jarInfo().exists);
	const engine: PumlEngine = hasLocal ? "local" : config.puml.serverUrl ? "remote" : "local";

	await acquireSlot();
	const startedAt = Date.now();
	try {
		let svg: string;
		let used: PumlEngine = engine;
		if (engine === "remote") {
			svg = await renderRemote(text, config.puml.timeoutMs);
		} else {
			try {
				svg = await localEngine.render(text, config.puml.timeoutMs);
			} catch (error) {
				if (error instanceof PumlRenderFailure && GRAPHVIZ_MISSING.test(error.body)) {
					svg = await localEngine.render(withSmetanaLayout(text), config.puml.timeoutMs);
				} else if (!config.puml.serverUrl || error instanceof PumlRenderFailure) {
					// A broken JDK or a corrupt jar should not take the tool down when a
					// remote renderer is configured: only real diagram errors skip this.
					throw error;
				} else {
					svg = await renderRemote(text, config.puml.timeoutMs);
					used = "remote";
				}
			}
		}
		if (/Welcome to PlantUML!/iu.test(svg)) {
			// "@startuml\n@enduml" and whitespace-only diagrams come back as HTTP 200
			// with PlantUML's help page, which is not something to show as a result.
			return {
				ok: false,
				engine: used,
				ms: Date.now() - startedAt,
				error: {
					message: "没有识别到可以绘制的图表内容",
					line: null,
					raw: "",
					hint: "请以 @startuml 开头，并至少写一条元素定义，例如 Alice -> Bob: Hello。",
				},
			};
		}
		const size = svgSize(svg);
		writeCache(key, { svg, engine: used, width: size.width, height: size.height });
		return { ok: true, svg, engine: used, ms: Date.now() - startedAt, width: size.width, height: size.height, cached: false };
	} catch (error) {
		const ms = Date.now() - startedAt;
		if (error instanceof PumlRenderFailure) {
			return { ok: false, engine, ms, error: parseErrorSvg(error.body) };
		}
		if (error instanceof PumlError) throw error;
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new PumlError("渲染超时，请稍后重试", 504, "PUML_TIMEOUT");
		}
		throw new PumlError(`渲染失败：${error instanceof Error ? error.message : String(error)}`, 500, "PUML_RENDER_FAILED");
	} finally {
		releaseSlot();
	}
}

export function getPumlStatus() {
	const java = resolveJavaPath();
	const jar = jarInfo();
	const localReady = Boolean(java && jar.exists);
	if (localReady) localEngine.probeVersion();
	return {
		available: config.puml.enabled && (localReady || Boolean(config.puml.serverUrl)),
		engine: !config.puml.enabled ? null : localReady ? "local" : config.puml.serverUrl ? "remote" : null,
		java: { found: Boolean(java), path: java },
		jar: { found: jar.exists, path: jar.path, size: jar.size },
		running: localEngine.running,
		version: localEngine.version,
		remoteFallback: Boolean(config.puml.serverUrl),
		enabled: config.puml.enabled,
		maxSourceBytes: PUML_MAX_SOURCE_BYTES,
	};
}

/** Called from the process shutdown hooks so no orphaned JVM survives a restart. */
export function shutdownPuml() {
	localEngine.stop();
}
