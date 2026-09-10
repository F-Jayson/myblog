import {
	Bug,
	Check,
	Code2,
	Copy,
	FileCode2,
	Play,
	RotateCcw,
	Sparkles,
	SquareTerminal,
	Trash2,
	UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "./api";
import { useAuth } from "./auth";
import type { CompilerRunResult } from "./types";

type LanguageDefinition = {
	key: string;
	label: string;
	extension: string;
	starter: string;
	keywords: string[];
	builtins?: string[];
	formatOnly?: boolean;
};

const LANGUAGES: LanguageDefinition[] = [
	{ key: "javascript", label: "JavaScript", extension: ".js", starter: "const greeting = 'Hello, Firefly!';\nconsole.log(greeting);", keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "new", "class", "import", "from", "export", "async", "await", "try", "catch", "throw"], builtins: ["console", "log", "Math", "JSON", "Promise"] },
	{ key: "typescript", label: "TypeScript", extension: ".ts", starter: "type Message = { text: string };\n\nconst message: Message = { text: 'Hello, Firefly!' };\nconsole.log(message.text);", keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "new", "class", "interface", "type", "import", "from", "export", "async", "await", "public", "private", "readonly"], builtins: ["string", "number", "boolean", "console", "log", "Array", "Record"] },
	{ key: "python", label: "Python", extension: ".py", starter: "def greet(name: str) -> str:\n    return f'Hello, {name}! '\n\nprint(greet('Firefly'))", keywords: ["def", "return", "if", "elif", "else", "for", "while", "in", "import", "from", "as", "class", "try", "except", "finally", "with", "lambda", "yield", "and", "or", "not", "is", "None", "True", "False"], builtins: ["print", "len", "range", "str", "int", "list", "dict"] },
	{ key: "java", label: "Java", extension: ".java", starter: "public class Main {\n    public static void main(String[] args) {\n        System.out.println(\"Hello, Firefly!\");\n    }\n}", keywords: ["public", "private", "protected", "class", "static", "void", "int", "long", "double", "boolean", "new", "return", "if", "else", "for", "while", "try", "catch", "import", "package", "extends", "final"], builtins: ["String", "System", "out", "println"] },
	{ key: "c", label: "C", extension: ".c", starter: "#include <stdio.h>\n\nint main(void) {\n    printf(\"Hello, Firefly!\\n\");\n    return 0;\n}", keywords: ["int", "char", "void", "long", "short", "float", "double", "struct", "typedef", "return", "if", "else", "for", "while", "include", "define", "sizeof"], builtins: ["printf", "scanf", "NULL"] },
	{ key: "cpp", label: "C++", extension: ".cpp", starter: "#include <iostream>\n\nint main() {\n    std::cout << \"Hello, Firefly!\" << std::endl;\n    return 0;\n}", keywords: ["int", "char", "void", "long", "short", "float", "double", "auto", "class", "struct", "namespace", "return", "if", "else", "for", "while", "include", "using", "public", "private", "const", "new", "delete"], builtins: ["std", "cout", "cin", "endl", "string", "vector"] },
	{ key: "csharp", label: "C#", extension: ".cs", starter: "using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine(\"Hello, Firefly!\");\n    }\n}", keywords: ["using", "namespace", "class", "public", "private", "protected", "static", "void", "int", "string", "bool", "new", "return", "if", "else", "for", "foreach", "while", "async", "await", "var", "null", "true", "false"], builtins: ["Console", "WriteLine", "Write", "Math", "Task"] },
	{ key: "go", label: "Go", extension: ".go", starter: "package main\n\nimport \"fmt\"\n\nfunc main() {\n    fmt.Println(\"Hello, Firefly!\")\n}", keywords: ["package", "import", "func", "return", "var", "const", "type", "struct", "interface", "if", "else", "for", "range", "go", "defer", "chan", "map", "switch", "case", "default"], builtins: ["fmt", "Println", "make", "len", "string", "int", "bool"] },
	{ key: "rust", label: "Rust", extension: ".rs", starter: "fn main() {\n    let message = \"Hello, Firefly!\";\n    println!(\"{}\", message);\n}", keywords: ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "move", "async", "await", "crate", "self"], builtins: ["println", "String", "Vec", "Option", "Result"] },
	{ key: "php", label: "PHP", extension: ".php", starter: "<?php\n$name = 'Firefly';\necho \"Hello, $name!\";", keywords: ["php", "echo", "function", "return", "if", "else", "foreach", "while", "class", "public", "private", "new", "use", "namespace", "true", "false", "null"], builtins: ["strlen", "count", "array_map", "json_encode"] },
	{ key: "ruby", label: "Ruby", extension: ".rb", starter: "name = 'Firefly'\nputs \"Hello, #{name}!\"", keywords: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "do", "require", "return", "true", "false", "nil"], builtins: ["puts", "print", "each", "map", "String", "Array"] },
	{ key: "kotlin", label: "Kotlin", extension: ".kt", starter: "fun main() {\n    val message = \"Hello, Firefly!\"\n    println(message)\n}", keywords: ["fun", "val", "var", "class", "object", "interface", "return", "if", "else", "when", "for", "while", "in", "import", "package", "data", "private", "public", "null", "true", "false"], builtins: ["println", "String", "List", "MutableList", "Int"] },
	{ key: "swift", label: "Swift", extension: ".swift", starter: "import Foundation\n\nlet message = \"Hello, Firefly!\"\nprint(message)", keywords: ["import", "let", "var", "func", "return", "if", "else", "for", "while", "in", "class", "struct", "enum", "protocol", "extension", "private", "public", "guard", "switch", "case", "nil", "true", "false"], builtins: ["print", "String", "Int", "Array", "Foundation"] },
	{ key: "bash", label: "Bash", extension: ".sh", starter: "#!/usr/bin/env bash\nname=Firefly\necho \"Hello, $name!\"", keywords: ["if", "then", "else", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "export", "local", "return"], builtins: ["echo", "printf", "cd", "pwd", "read", "source"] },
	{ key: "sql", label: "SQL", extension: ".sql", starter: "SELECT 'Hello, Firefly!' AS message;", keywords: ["select", "from", "where", "and", "or", "insert", "into", "values", "update", "set", "delete", "create", "table", "join", "left", "right", "inner", "on", "as", "order", "by", "group", "limit", "having", "null", "is", "not"], builtins: ["count", "sum", "avg", "min", "max", "distinct"] },
	{ key: "json", label: "JSON", extension: ".json", starter: "{\n  \"message\": \"Hello, Firefly!\",\n  \"ready\": true\n}", keywords: ["true", "false", "null"], builtins: [], formatOnly: true },
	{ key: "html", label: "HTML", extension: ".html", starter: "<!doctype html>\n<html>\n  <body>\n    <h1>Hello, Firefly!</h1>\n  </body>\n</html>", keywords: [], builtins: [], formatOnly: true },
	{ key: "css", label: "CSS", extension: ".css", starter: "body {\n  color: #22b988;\n  font-family: system-ui, sans-serif;\n}", keywords: [], builtins: [], formatOnly: true },
];

const languageMap = new Map(LANGUAGES.map((language) => [language.key, language]));
const lineHeight = 1.55;

function escapeHtml(value: string) {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#039;");
}

function spanToken(kind: string, value: string) {
	return `<span class="compiler-token-${kind}">${escapeHtml(value)}</span>`;
}

function highlightLine(line: string, language: LanguageDefinition) {
	const keywords = new Set(language.keywords.map((word) => language.key === "sql" ? word.toLowerCase() : word));
	const builtins = new Set(language.builtins ?? []);
	const sql = language.key === "sql";
	const commentStarts = language.key === "python" || language.key === "ruby" || language.key === "bash" ? ["#"] : language.key === "sql" ? ["--"] : ["//"];
	let result = "";
	let index = 0;
	while (index < line.length) {
		const remaining = line.slice(index);
		if (commentStarts.some((marker) => remaining.startsWith(marker))) {
			result += spanToken("comment", remaining);
			break;
		}
		const char = line[index];
		if (char === "\"" || char === "'" || char === "`") {
			let end = index + 1;
			while (end < line.length) {
				if (line[end] === "\\") { end += 2; continue; }
				if (line[end] === char) { end += 1; break; }
				end += 1;
			}
			result += spanToken("string", line.slice(index, end));
			index = end;
			continue;
		}
		const numberMatch = remaining.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?)/iu);
		if (numberMatch) {
			result += spanToken("number", numberMatch[0]);
			index += numberMatch[0].length;
			continue;
		}
		const identifierMatch = remaining.match(/^[A-Za-z_$][\w$-]*/u);
		if (identifierMatch) {
			const value = identifierMatch[0];
			const keyword = keywords.has(sql ? value.toLowerCase() : value);
			result += spanToken(keyword ? "keyword" : builtins.has(value) ? "builtin" : "plain", value);
			index += value.length;
			continue;
		}
		if (/[{}()[\];,.<>:=+*/!?&|%-]/u.test(char)) result += spanToken("punctuation", char);
		else result += escapeHtml(char);
		index += 1;
	}
	return result || " ";
}

function highlightedCode(code: string, language: LanguageDefinition) {
	return code.split("\n").map((line) => highlightLine(line, language)).join("\n");
}

function formatCode(code: string, language: LanguageDefinition) {
	if (!code.trim()) return code;
	if (language.key === "json") {
		try { return JSON.stringify(JSON.parse(code), null, 2); } catch { return code; }
	}
	if (["javascript", "typescript", "java", "c", "cpp", "go", "rust", "kotlin", "php"].includes(language.key)) {
		let indent = 0;
		return code.split("\n").map((rawLine) => {
			const line = rawLine.trim();
			if (!line) return "";
			if (/^[}\])]/u.test(line)) indent = Math.max(0, indent - 1);
			const formatted = `${"  ".repeat(indent)}${line}`;
			const opens = (line.match(/[({[]/gu) ?? []).length;
			const closes = (line.match(/[)}\]]/gu) ?? []).length;
			indent = Math.max(0, indent + opens - closes);
			return formatted;
		}).join("\n");
	}
	return code.split("\n").map((line) => line.trimEnd()).join("\n");
}

function parseRunResult(value: CompilerRunResult): { output: string; error: string; debug: NonNullable<CompilerRunResult["debug"]> | null; diagnostics: NonNullable<CompilerRunResult["diagnostics"]> } {
	const record = value as CompilerRunResult & { result?: CompilerRunResult; data?: CompilerRunResult };
	const payload = record.result ?? record.data ?? record;
	const output = String(payload.output ?? payload.stdout ?? "");
	const error = String(payload.error ?? payload.stderr ?? "");
	const hitBreakpoints = payload.hitBreakpoints ?? [];
	const debug = payload.debug ?? (hitBreakpoints.length ? { breakpoints: payload.breakpoints, stoppedAt: hitBreakpoints[0], message: `命中 ${hitBreakpoints.length} 个断点` } : null);
	return { output, error, debug, diagnostics: payload.diagnostics ?? [] };
}

function AuthRequired({ children }: { children: ReactNode }) {
	const { user, loading, openAuth, features } = useAuth();
	if (loading) return <section className="card content-card user-tool-page auth-required"><p>正在检查登录状态...</p></section>;
	if (!features.compilerEnabled) return <section className="card content-card user-tool-page auth-required"><Code2 size={30} /><h2>在线编译器暂未开放</h2><p>管理员暂时关闭了这项功能，请稍后再试。</p></section>;
	if (!user) return <section className="card content-card user-tool-page auth-required"><UserRound size={30} /><h2>登录后使用在线编译器</h2><p>在线编译、格式化和断点调试仅对已登录用户开放。</p><button className="user-tool-button primary" type="button" onClick={() => openAuth("login")}>登录 / 注册</button></section>;
	return <>{children}</>;
}

function CompilerEditor({ code, language, breakpoints, onChange, onToggleBreakpoint, onRun, disabled = false }: { code: string; language: LanguageDefinition; breakpoints: Set<number>; onChange: (value: string) => void; onToggleBreakpoint: (line: number) => void; onRun: () => void; disabled?: boolean }) {
	const codeScrollRef = useRef<HTMLDivElement>(null);
	const codeInputRef = useRef<HTMLTextAreaElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const lines = useMemo(() => code.split("\n"), [code]);
	const maxLineLength = useMemo(() => Math.max(42, ...lines.map((line) => line.length + 4)), [lines]);
	const html = useMemo(() => highlightedCode(code, language), [code, language]);
	const canvasStyle = { minWidth: `${maxLineLength}ch`, minHeight: `${Math.max(16, lines.length + 2) * lineHeight}rem` } as CSSProperties;
	const updateCode = (nextCode: string) => {
		onChange(nextCode);
		const maxLine = Math.max(1, nextCode.split("\n").length);
		for (const line of breakpoints) if (line > maxLine) onToggleBreakpoint(line);
	};
	const onScroll = () => {
		const target = codeScrollRef.current;
		if (!target) return;
		setScrollTop(target.scrollTop);
	};
	return <div className="compiler-editor-shell">
		<div className="compiler-gutter" aria-label="代码行号"><div className="compiler-gutter-inner" style={{ transform: `translateY(-${scrollTop}px)` }}>{lines.map((_, index) => { const line = index + 1; const active = breakpoints.has(line); return <button key={line} type="button" disabled={language.formatOnly || disabled} className={`compiler-line-number ${active ? "has-breakpoint" : ""}`} title={language.formatOnly ? "格式化模式不支持断点" : active ? `移除第 ${line} 行断点` : `双击第 ${line} 行设置断点`} onDoubleClick={() => { if (!language.formatOnly && !disabled) onToggleBreakpoint(line); }}><span className="compiler-breakpoint-dot" aria-hidden="true" />{line}</button>; })}</div></div>
		<div ref={codeScrollRef} className="compiler-code-scroll" onScroll={onScroll}>
			<div className="compiler-code-canvas" style={canvasStyle}>
				<pre className="compiler-highlight" aria-hidden="true"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
				<textarea ref={codeInputRef} className="compiler-code-input" value={code} disabled={disabled} onChange={(event) => updateCode(event.target.value)} onKeyDown={(event) => {
					if (event.key === "Tab") {
						event.preventDefault();
						const target = event.currentTarget;
						const start = target.selectionStart;
						const end = target.selectionEnd;
						const indentation = "    ";
						updateCode(code.slice(0, start) + indentation + code.slice(end));
						window.requestAnimationFrame(() => {
							const input = codeInputRef.current;
							if (!input) return;
							input.selectionStart = input.selectionEnd = start + indentation.length;
						});
						return;
					}
					if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onRun(); }
				}} spellCheck={false} aria-label={`${language.label}代码编辑器`} />
			</div>
		</div>
	</div>;
}

export default function CompilerPage() {
	const { user } = useAuth();
	const [languageKey, setLanguageKey] = useState("javascript");
	const [code, setCode] = useState(LANGUAGES[0].starter);
	const [stdin, setStdin] = useState("");
	const [breakpoints, setBreakpoints] = useState<Set<number>>(() => new Set());
	const [debugMode, setDebugMode] = useState(true);
	const [result, setResult] = useState<CompilerRunResult | null>(null);
	const [running, setRunning] = useState(false);
	const [formatting, setFormatting] = useState(false);
	const [message, setMessage] = useState("");
	const operationRef = useRef(0);
	const language = languageMap.get(languageKey) ?? LANGUAGES[0];
	const parsed = result ? parseRunResult(result) : null;
	const executionFailed = Boolean(parsed?.error) || (typeof result?.exitCode === "number" && result.exitCode !== 0);

	useEffect(() => {
		const saved = localStorage.getItem("firefly-compiler-language");
		if (saved && languageMap.has(saved)) {
			setLanguageKey(saved);
			setCode(languageMap.get(saved)?.starter ?? code);
		}
	}, []);
	useEffect(() => { localStorage.setItem("firefly-compiler-language", languageKey); }, [languageKey]);
	useEffect(() => {
		operationRef.current += 1;
		const maxLine = Math.max(1, code.split("\n").length);
		setBreakpoints((current) => {
			const next = new Set([...current].filter((line) => line >= 1 && line <= maxLine));
			return next.size === current.size ? current : next;
		});
		setResult(null);
	}, [code]);
	const applyCode = (nextCode: string) => {
		operationRef.current += 1;
		setCode(nextCode);
		const maxLine = Math.max(1, nextCode.split("\n").length);
		setBreakpoints((current) => {
			const next = new Set([...current].filter((line) => line >= 1 && line <= maxLine));
			return next.size === current.size ? current : next;
		});
		setResult(null);
	};
	const changeLanguage = (next: string) => {
		if (running || formatting) return;
		const nextLanguage = languageMap.get(next);
		if (!nextLanguage) return;
		operationRef.current += 1;
		setLanguageKey(next);
		setCode(nextLanguage.starter);
		setStdin("");
		setBreakpoints(new Set());
		setResult(null);
		setMessage("");
	};
	const toggleBreakpoint = (line: number) => setBreakpoints((current) => { const next = new Set(current); if (next.has(line)) next.delete(line); else next.add(line); return next; });
	const run = async () => {
		if (!code.trim() || running || formatting || !user || language.formatOnly) return;
		const operation = ++operationRef.current;
		const lineCount = Math.max(1, code.split("\n").length);
		const activeBreakpoints = Array.from(breakpoints).filter((line) => line >= 1 && line <= lineCount).sort((a, b) => a - b);
		if (activeBreakpoints.length !== breakpoints.size) setBreakpoints(new Set(activeBreakpoints));
		setRunning(true); setMessage(""); setResult(null);
		try {
			const payload = await api.compilerRun({ language: language.key, code, stdin, breakpoints: activeBreakpoints, debug: debugMode && activeBreakpoints.length > 0 });
			if (operation === operationRef.current) setResult(payload);
		} catch (error) {
			if (operation === operationRef.current) setMessage(error instanceof Error ? error.message : "编译请求失败，请稍后重试");
		} finally { if (operation === operationRef.current) setRunning(false); }
	};
	const format = async () => {
		if (formatting || running || !user) return;
		const operation = ++operationRef.current;
		setFormatting(true); setMessage("");
		try {
			const response = await api.compilerFormat({ language: language.key, code });
			if (operation === operationRef.current) applyCode(response.code);
		} catch (error) {
			if (operation === operationRef.current) setMessage(error instanceof Error ? error.message : "格式化失败，请稍后重试");
		} finally { setFormatting(false); }
	};
	const reset = () => { applyCode(language.starter); setStdin(""); setBreakpoints(new Set()); setMessage(""); };
	const copyCode = async () => { try { await navigator.clipboard.writeText(code); setMessage("代码已复制"); window.setTimeout(() => setMessage(""), 1800); } catch { setMessage("复制失败，请手动选择代码"); } };

	return <AuthRequired><section className="card content-card user-tool-page compiler-page">
		<header className="user-tool-heading compiler-heading"><div><span className="tool-eyebrow">DEVELOPER TOOLS</span><h2><Code2 size={22} /> 在线编译器</h2><p>容器隔离执行主流语言，双击行号设置断点并查看调试信息。</p></div><span className="compiler-secure-badge"><Check size={14} /> 已登录</span></header>
		<div className="compiler-toolbar">
			<label className="compiler-language"><span>语言</span><select value={languageKey} onChange={(event) => changeLanguage(event.target.value)} disabled={running || formatting} aria-label="选择编程语言">{LANGUAGES.map((item) => <option key={item.key} value={item.key}>{item.label} {item.extension}{item.formatOnly ? " · 仅格式化" : ""}</option>)}</select></label>
			<span className="compiler-toolbar-spacer" />
			<button className="user-tool-button" type="button" title="复制代码" onClick={() => void copyCode()}><Copy size={16} />复制</button>
			<button className="user-tool-button" type="button" title="格式化代码" onClick={() => void format()} disabled={formatting || running}><Sparkles size={16} />{formatting ? "格式化中" : "格式化"}</button>
			<button className="user-tool-button" type="button" title="恢复示例代码" onClick={reset} disabled={running || formatting}><RotateCcw size={16} />重置</button>
			{language.formatOnly ? <span className="compiler-format-only-label">格式化模式</span> : <><button className={`user-tool-button compiler-debug-toggle ${debugMode ? "is-selected" : ""}`} type="button" title="切换断点调试模式" onClick={() => setDebugMode((value) => !value)} disabled={running || formatting}><Bug size={16} />{debugMode ? "调试" : "运行"}</button><button className="user-tool-button primary compiler-run-button" type="button" onClick={() => void run()} disabled={running || formatting || !code.trim()}>{running ? <SquareTerminal className="compiler-spin" size={16} /> : <Play size={16} />}{running ? "运行中" : "运行代码"}</button></>}
		</div>
		<div className="compiler-workspace"><div className="compiler-editor-card"><div className="compiler-editor-header"><span><FileCode2 size={15} /> main{language.extension}</span><span className="compiler-breakpoint-count">{language.formatOnly ? "仅格式化" : <><Bug size={14} />{breakpoints.size ? `${breakpoints.size} 个断点` : "双击行号添加断点"}</>}</span></div><CompilerEditor code={code} language={language} breakpoints={breakpoints} onChange={applyCode} onToggleBreakpoint={toggleBreakpoint} onRun={() => void run()} disabled={running || formatting} /></div><aside className="compiler-side-panel"><label className="compiler-side-field"><span>标准输入 <small>stdin</small></span><textarea value={stdin} onChange={(event) => setStdin(event.target.value)} rows={5} disabled={language.formatOnly || running || formatting} placeholder={language.formatOnly ? "格式化模式不需要标准输入" : "程序需要输入时，在这里填写..."} /></label>{language.formatOnly ? <div className="compiler-side-note"><Sparkles size={15} /><div><strong>格式化模式</strong><p>此语言用于代码格式化和高亮，不会启动容器执行。</p></div></div> : <><div className="compiler-side-note"><Bug size={15} /><div><strong>断点调试</strong><p>双击左侧行号设置或移除断点。Python、JavaScript 和 TypeScript 支持真实行追踪，其它语言显示运行诊断。</p></div></div><div className="compiler-side-note"><SquareTerminal size={15} /><div><strong>容器执行</strong><p>每次运行都在隔离环境内执行，单次任务有时间和资源限制。</p></div></div></>}</aside></div>
		{message ? <p className="user-tool-error compiler-message" role="alert">{message}</p> : null}
		{parsed ? <section className="compiler-output" aria-live="polite"><header><div><span className="tool-eyebrow">OUTPUT</span><h3><SquareTerminal size={17} /> 执行结果</h3></div><span className={`compiler-status ${executionFailed ? "is-error" : "is-success"}`}>{executionFailed ? "执行失败" : result?.status === "running" ? "运行中" : "执行完成"}</span></header><div className="compiler-output-meta"><span>{result?.durationMs ? `${result.durationMs} ms` : "容器任务"}</span><span>退出码 {result?.exitCode === null || result?.exitCode === undefined ? "-" : result.exitCode}</span>{parsed.debug?.stoppedAt ? <span>停在第 {parsed.debug.stoppedAt} 行</span> : null}</div>{parsed.output ? <pre className="compiler-output-pre">{parsed.output}</pre> : null}{parsed.error ? <pre className="compiler-error-pre">{parsed.error}</pre> : !parsed.output ? <p className="compiler-empty-output">程序没有输出。</p> : null}{parsed.diagnostics.length ? <div className="compiler-diagnostics">{parsed.diagnostics.map((diagnostic, index) => <div className={`compiler-diagnostic is-${diagnostic.severity ?? "error"}`} key={`${diagnostic.line ?? "x"}-${index}`}><span>{diagnostic.line ? `第 ${diagnostic.line} 行` : "诊断"}</span><p>{diagnostic.message}</p></div>)}</div> : null}{parsed.debug ? <div className="compiler-debug-output"><div className="compiler-debug-heading"><Bug size={16} /><strong>调试信息</strong>{parsed.debug.message ? <span>{parsed.debug.message}</span> : null}</div>{parsed.debug.variables && Object.keys(parsed.debug.variables).length ? <pre>{JSON.stringify(parsed.debug.variables, null, 2)}</pre> : null}{parsed.debug.stack?.length ? <div className="compiler-stack">{parsed.debug.stack.map((frame, index) => <span key={`${frame}-${index}`}>{frame}</span>)}</div> : null}</div> : null}</section> : null}
		<footer className="compiler-footer"><span><Bug size={14} />{breakpoints.size ? `${breakpoints.size} 个断点已设置` : "支持断点调试"}</span><span>当前语言：{language.label}</span><span className="compiler-footer-spacer" /><button type="button" title="清空执行结果" onClick={() => { setResult(null); setMessage(""); }} disabled={!result && !message}><Trash2 size={14} />清空结果</button></footer>
	</section></AuthRequired>;
}
