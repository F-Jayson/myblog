export type HighlightLanguage = {
	key: string;
	label: string;
	keywords: string[];
	builtins?: string[];
	commentStarts?: string[];
};

export const CLIPBOARD_LANGUAGES: HighlightLanguage[] = [
	{ key: "plaintext", label: "纯文本", keywords: [] },
	{ key: "javascript", label: "JavaScript", keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "new", "class", "import", "from", "export", "async", "await", "try", "catch", "throw", "switch", "case", "break", "default"], builtins: ["console", "log", "Math", "JSON", "Promise", "Array", "Object", "Map", "Set"] },
	{ key: "typescript", label: "TypeScript", keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "new", "class", "interface", "type", "import", "from", "export", "async", "await", "public", "private", "readonly", "implements", "extends"], builtins: ["string", "number", "boolean", "console", "log", "Array", "Record", "Promise"] },
	{ key: "python", label: "Python", keywords: ["def", "return", "if", "elif", "else", "for", "while", "in", "import", "from", "as", "class", "try", "except", "finally", "with", "lambda", "yield", "and", "or", "not", "is", "None", "True", "False"], builtins: ["print", "len", "range", "str", "int", "list", "dict"], commentStarts: ["#"] },
	{ key: "java", label: "Java", keywords: ["public", "private", "protected", "class", "static", "void", "int", "long", "double", "boolean", "new", "return", "if", "else", "for", "while", "try", "catch", "import", "package", "extends", "final"], builtins: ["String", "System", "out", "println"] },
	{ key: "c", label: "C", keywords: ["int", "char", "void", "long", "short", "float", "double", "struct", "typedef", "return", "if", "else", "for", "while", "include", "define", "sizeof"], builtins: ["printf", "scanf", "NULL"] },
	{ key: "cpp", label: "C++", keywords: ["int", "char", "void", "long", "short", "float", "double", "auto", "class", "struct", "namespace", "return", "if", "else", "for", "while", "include", "using", "public", "private", "const", "new", "delete"], builtins: ["std", "cout", "cin", "endl", "string", "vector"] },
	{ key: "csharp", label: "C#", keywords: ["using", "namespace", "class", "public", "private", "protected", "static", "void", "int", "string", "bool", "new", "return", "if", "else", "for", "foreach", "while", "async", "await", "var", "null", "true", "false"], builtins: ["Console", "WriteLine", "Write", "Math", "Task"] },
	{ key: "go", label: "Go", keywords: ["package", "import", "func", "return", "var", "const", "type", "struct", "interface", "if", "else", "for", "range", "go", "defer", "chan", "map", "switch", "case", "default"], builtins: ["fmt", "Println", "make", "len", "string", "int", "bool"] },
	{ key: "rust", label: "Rust", keywords: ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "match", "if", "else", "for", "while", "loop", "return", "move", "async", "await", "crate", "self"], builtins: ["println", "String", "Vec", "Option", "Result"] },
	{ key: "php", label: "PHP", keywords: ["php", "echo", "function", "return", "if", "else", "foreach", "while", "class", "public", "private", "new", "use", "namespace", "true", "false", "null"], builtins: ["strlen", "count", "array_map", "json_encode"] },
	{ key: "ruby", label: "Ruby", keywords: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "do", "require", "return", "true", "false", "nil"], builtins: ["puts", "print", "each", "map", "String", "Array"], commentStarts: ["#"] },
	{ key: "kotlin", label: "Kotlin", keywords: ["fun", "val", "var", "class", "object", "interface", "return", "if", "else", "when", "for", "while", "in", "import", "package", "data", "private", "public", "null", "true", "false"], builtins: ["println", "String", "List", "MutableList", "Int"] },
	{ key: "swift", label: "Swift", keywords: ["import", "let", "var", "func", "return", "if", "else", "for", "while", "in", "class", "struct", "enum", "protocol", "extension", "private", "public", "guard", "switch", "case", "nil", "true", "false"], builtins: ["print", "String", "Int", "Array", "Foundation"] },
	{ key: "bash", label: "Bash", keywords: ["if", "then", "else", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "export", "local", "return"], builtins: ["echo", "printf", "cd", "pwd", "read", "source"], commentStarts: ["#"] },
	{ key: "sql", label: "SQL", keywords: ["select", "from", "where", "and", "or", "insert", "into", "values", "update", "set", "delete", "create", "table", "join", "left", "right", "inner", "on", "as", "order", "by", "group", "limit", "having", "null", "is", "not"], builtins: ["count", "sum", "avg", "min", "max", "distinct"], commentStarts: ["--"] },
	{ key: "json", label: "JSON", keywords: ["true", "false", "null"] },
	{ key: "html", label: "HTML", keywords: ["html", "head", "body", "div", "span", "script", "style", "link", "meta", "title", "section", "article"] },
	{ key: "css", label: "CSS", keywords: ["important", "from", "to"] },
	{ key: "yaml", label: "YAML", keywords: ["true", "false", "null", "yes", "no"], commentStarts: ["#"] },
	{ key: "xml", label: "XML", keywords: ["xml", "version", "encoding"] },
	{ key: "markdown", label: "Markdown", keywords: [] },
];

const languageMap = new Map(CLIPBOARD_LANGUAGES.map((language) => [language.key, language]));

export function clipboardLanguage(key: string | null | undefined) {
	return languageMap.get(String(key ?? "").trim().toLowerCase()) ?? languageMap.get("plaintext")!;
}

export type TokenKind = "comment" | "string" | "keyword" | "builtin" | "number" | "punctuation" | "plain";
export type CodeToken = { kind: TokenKind; text: string };

export type HighlightStrategyId = "classic" | "vscode" | "soft" | "zebra" | "screen";

export type HighlightPalette = {
	id: HighlightStrategyId;
	label: string;
	description: string;
	screenDark: boolean;
	keyword: string;
	string: string;
	comment: string;
	number: string;
	builtin: string;
	punctuation: string;
	plain: string;
	keywordWeight: "bold" | "normal";
	commentStyle: "italic" | "normal";
	zebra: readonly [string, string];
	gutter: string;
};

const CLASSIC_PALETTE: HighlightPalette = {
	id: "classic",
	label: "经典浅色",
	description: "接近 CodeInWord 的配色，浅灰与白色交替，适合直接贴进 Word。",
	screenDark: false,
	keyword: "#006699",
	string: "#0000ff",
	comment: "#008200",
	number: "#800080",
	builtin: "#006699",
	punctuation: "#000000",
	plain: "#000000",
	keywordWeight: "bold",
	commentStyle: "normal",
	zebra: ["#ffffff", "#f8f8f8"],
	gutter: "#8a8a8a",
};

export const HIGHLIGHT_STRATEGIES: HighlightPalette[] = [
	CLASSIC_PALETTE,
	{
		id: "vscode",
		label: "VS 浅色",
		description: "Visual Studio 浅色语法色，斑马纹仍保持白与浅灰。",
		screenDark: false,
		keyword: "#0000ff",
		string: "#a31515",
		comment: "#008000",
		number: "#098658",
		builtin: "#795e26",
		punctuation: "#000000",
		plain: "#000000",
		keywordWeight: "normal",
		commentStyle: "normal",
		zebra: ["#ffffff", "#f5f5f5"],
		gutter: "#8a8a8a",
	},
	{
		id: "soft",
		label: "柔和浅色",
		description: "偏站点绿色的浅色方案，底纹依然是一白一浅。",
		screenDark: false,
		keyword: "#0b6e56",
		string: "#9a5b00",
		comment: "#6d7f78",
		number: "#3d5a99",
		builtin: "#0e7490",
		punctuation: "#1c2b27",
		plain: "#1c2b27",
		keywordWeight: "bold",
		commentStyle: "italic",
		zebra: ["#ffffff", "#f3f7f5"],
		gutter: "#8aa097",
	},
	{
		id: "zebra",
		label: "仅斑马纹",
		description: "不做彩色语法，只保留黑字和浅色行间条纹，粘贴后最干净。",
		screenDark: false,
		keyword: "#000000",
		string: "#000000",
		comment: "#000000",
		number: "#000000",
		builtin: "#000000",
		punctuation: "#000000",
		plain: "#000000",
		keywordWeight: "normal",
		commentStyle: "normal",
		zebra: ["#ffffff", "#f8f8f8"],
		gutter: "#8a8a8a",
	},
	{
		id: "screen",
		label: "深色屏幕",
		description: "只方便在页面上阅读。复制到 Word 时会自动换成经典浅色，不带深色底。",
		screenDark: true,
		keyword: "#8ed8bd",
		string: "#e7c38c",
		comment: "#8eaea3",
		number: "#b7c9ff",
		builtin: "#89c9e4",
		punctuation: "#aec5bc",
		plain: "#d4e8df",
		keywordWeight: "bold",
		commentStyle: "italic",
		zebra: ["#12201d", "#182824"],
		gutter: "#6f8b82",
	},
];

const strategyMap = new Map(HIGHLIGHT_STRATEGIES.map((strategy) => [strategy.id, strategy]));

export function highlightStrategy(id: string | null | undefined) {
	return strategyMap.get(id as HighlightStrategyId) ?? CLASSIC_PALETTE;
}

export type FormatMethodId = "original" | "trim" | "tab2" | "tab4" | "squeeze" | "json" | "braces" | "sql";

export const FORMAT_METHODS: Array<{ id: FormatMethodId; label: string; description: string }> = [
	{ id: "original", label: "保持原样", description: "不改动空格、缩进和换行。" },
	{ id: "trim", label: "整理空白", description: "统一为换行符，并去掉每一行末尾的空格。" },
	{ id: "tab2", label: "Tab 转 2 空格", description: "把制表符展开成两个空格，并去掉行尾空格。" },
	{ id: "tab4", label: "Tab 转 4 空格", description: "把制表符展开成四个空格，并去掉行尾空格。" },
	{ id: "squeeze", label: "合并空行", description: "连续空行收成一行，并去掉行尾空格。" },
	{ id: "json", label: "JSON 美化", description: "按两个空格缩进重新排版 JSON。" },
	{ id: "braces", label: "括号缩进", description: "按括号层级用两个空格重新缩进，适合 C 系、Java 和脚本。" },
	{ id: "sql", label: "SQL 关键字大写", description: "把 SQL 关键字转成大写，字符串和注释保持原样。" },
];

const BRACE_LANGUAGES = new Set(["javascript", "typescript", "java", "c", "cpp", "csharp", "go", "rust", "kotlin", "php", "swift", "css"]);

function escapeHtml(value: string) {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#039;");
}

function lineCommentMarkers(language: HighlightLanguage) {
	if (language.commentStarts?.length) return language.commentStarts;
	if (language.key === "python" || language.key === "ruby" || language.key === "bash" || language.key === "yaml") return ["#"];
	if (language.key === "sql") return ["--"];
	if (language.key === "html" || language.key === "xml" || language.key === "json" || language.key === "markdown" || language.key === "plaintext") return [];
	return ["//"];
}

function blockComment(language: HighlightLanguage) {
	if (["plaintext", "markdown", "json", "yaml", "python", "ruby", "bash"].includes(language.key)) return null;
	if (language.key === "html" || language.key === "xml") return { start: "<!--", end: "-->" };
	return { start: "/*", end: "*/" };
}

type ScanState = { closer: string | null };

function pushToken(tokens: CodeToken[], kind: TokenKind, text: string) {
	if (!text) return;
	const last = tokens[tokens.length - 1];
	if (last && last.kind === kind) last.text += text;
	else tokens.push({ kind, text });
}

function tokenizeLine(line: string, language: HighlightLanguage, state: ScanState) {
	const tokens: CodeToken[] = [];
	if (language.key === "plaintext" || language.key === "markdown") {
		pushToken(tokens, "plain", line);
		return { tokens, state };
	}
	const sql = language.key === "sql";
	const keywords = new Set(language.keywords.map((word) => sql ? word.toLowerCase() : word));
	const builtins = new Set(language.builtins ?? []);
	const comments = lineCommentMarkers(language);
	const block = blockComment(language);
	let index = 0;
	let closer = state.closer;
	while (index < line.length) {
		if (closer) {
			const end = line.indexOf(closer, index);
			if (end < 0) {
				pushToken(tokens, "comment", line.slice(index));
				return { tokens, state: { closer } };
			}
			pushToken(tokens, "comment", line.slice(index, end + closer.length));
			index = end + closer.length;
			closer = null;
			continue;
		}
		const remaining = line.slice(index);
		if (comments.some((marker) => remaining.startsWith(marker))) {
			pushToken(tokens, "comment", remaining);
			break;
		}
		if (block && remaining.startsWith(block.start)) {
			closer = block.end;
			continue;
		}
		const char = line[index] ?? "";
		if (char === "\"" || char === "'" || char === "`") {
			let end = index + 1;
			while (end < line.length) {
				if (line[end] === "\\") { end += 2; continue; }
				if (line[end] === char) { end += 1; break; }
				end += 1;
			}
			pushToken(tokens, "string", line.slice(index, end));
			index = end;
			continue;
		}
		const numberMatch = remaining.match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?)/iu);
		if (numberMatch && (index === 0 || !/[A-Za-z_$\u0080-\uFFFF]/u.test(line[index - 1] ?? ""))) {
			pushToken(tokens, "number", numberMatch[0]);
			index += numberMatch[0].length;
			continue;
		}
		const identifierMatch = remaining.match(/^[A-Za-z_$][\w$-]*/u);
		if (identifierMatch) {
			const value = identifierMatch[0];
			const keyword = keywords.has(sql ? value.toLowerCase() : value);
			pushToken(tokens, keyword ? "keyword" : builtins.has(value) ? "builtin" : "plain", value);
			index += value.length;
			continue;
		}
		if (/[{}()[\];,.<>:=+*/!?&|%-]/u.test(char)) pushToken(tokens, "punctuation", char);
		else pushToken(tokens, "plain", char);
		index += 1;
	}
	return { tokens, state: { closer } };
}

export function tokenizeCode(code: string, languageKey?: string | null) {
	const language = clipboardLanguage(languageKey);
	let state: ScanState = { closer: null };
	return code.split("\n").map((line) => {
		const result = tokenizeLine(line, language, state);
		state = result.state;
		return result.tokens;
	});
}

function spanToken(kind: string, value: string) {
	return `<span class="compiler-token-${kind}">${escapeHtml(value)}</span>`;
}

export function highlightedCode(code: string, languageKey?: string | null) {
	return tokenizeCode(code, languageKey).map((tokens) => tokens.length ? tokens.map((token) => spanToken(token.kind, token.text)).join("") : " ").join("\n");
}

const DETECT_RULES: Array<{ key: string; score: number; test: RegExp }> = [
	{ key: "php", score: 14, test: /<\?php\b/iu },
	{ key: "python", score: 12, test: /^#!.*\bpython\b/imu },
	{ key: "python", score: 12, test: /^\s*def\s+\w+\s*\([^)]*\)\s*:/mu },
	{ key: "python", score: 7, test: /^\s*(?:elif |except |finally:|print\s*\()/mu },
	{ key: "bash", score: 12, test: /^#!.*\b(?:bash|sh|zsh)\b/imu },
	{ key: "bash", score: 5, test: /^\s*(?:echo|printf|source)\b.+$/mu },
	{ key: "go", score: 9, test: /^\s*package\s+[a-z][\w]*\s*$/imu },
	{ key: "go", score: 8, test: /^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\(/mu },
	{ key: "rust", score: 8, test: /\b(?:let\s+mut|impl|fn\s+main)\b/u },
	{ key: "rust", score: 5, test: /\bfn\s+[A-Za-z_]\w*\s*\(/u },
	{ key: "csharp", score: 10, test: /\busing\s+System\b|Console\.Write/u },
	{ key: "java", score: 8, test: /\bpublic\s+(?:static\s+)?(?:class|void)\b|System\.out\.print/u },
	{ key: "kotlin", score: 8, test: /\bfun\s+[A-Za-z_]\w*\s*\(/u },
	{ key: "swift", score: 8, test: /\bfunc\s+[A-Za-z_]\w*\s*\(|^\s*import\s+(?:Foundation|UIKit|Swift)\b/mu },
	{ key: "cpp", score: 9, test: /#include\s*<iostream>|std::|\bcout\s*<</u },
	{ key: "c", score: 6, test: /#include\s*[<"][\w./]+[>"]/u },
	{ key: "typescript", score: 8, test: /\b(?:interface|type)\s+[A-Za-z_]\w*|:\s*(?:string|number|boolean|any|unknown)\b/u },
	{ key: "javascript", score: 5, test: /\b(?:const|let|function|console\.log)\b/u },
	{ key: "html", score: 8, test: /<\/?(?:html|head|body|div|span|section|article)\b/iu },
	{ key: "xml", score: 7, test: /<\?xml\b/iu },
	{ key: "css", score: 7, test: /[.#][\w-]+\s*\{[^}]*:[^;}]+;/u },
	{ key: "sql", score: 9, test: /\b(?:select|insert|update|delete)\b[\s\S]{0,120}\b(?:from|into|set|where)\b/iu },
	{ key: "yaml", score: 5, test: /^---\s*$/mu },
	{ key: "ruby", score: 8, test: /^\s*def\s+\w+[^\n:]*\n[\s\S]*?\n\s*end\b/mu },
	{ key: "markdown", score: 4, test: /^#{1,6}\s+\S/mu },
];

export function detectLanguage(code: string) {
	const sample = code.slice(0, 12000);
	if (!sample.trim()) return { key: "plaintext", score: 0 };
	const scores = new Map<string, number>();
	const add = (key: string, amount: number) => scores.set(key, (scores.get(key) ?? 0) + amount);
	for (const rule of DETECT_RULES) {
		if (rule.test.test(sample)) add(rule.key, rule.score);
	}
	try {
		JSON.parse(sample);
		add("json", 24);
	} catch { /* 不是完整 JSON 时继续用其它规则 */ }
	if ((scores.get("cpp") ?? 0) > 0) scores.delete("c");
	if ((scores.get("typescript") ?? 0) >= 8) scores.set("javascript", Math.max(0, (scores.get("javascript") ?? 0) - 4));
	if ((scores.get("html") ?? 0) >= 8) scores.set("xml", Math.max(0, (scores.get("xml") ?? 0) - 4));
	if (/^\s*def\s+\w+\s*\([^)]*\)\s*:/mu.test(sample)) scores.set("ruby", Math.max(0, (scores.get("ruby") ?? 0) - 8));
	if (!/^#!/mu.test(sample) && ((scores.get("javascript") ?? 0) > 0 || (scores.get("typescript") ?? 0) > 0 || (scores.get("php") ?? 0) > 0)) scores.set("bash", 0);
	for (const language of CLIPBOARD_LANGUAGES) {
		if (language.keywords.length < 4 || language.key === "markdown") continue;
		let hits = 0;
		for (const word of language.keywords.slice(0, 18)) {
			const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			const pattern = new RegExp(`\\b${escaped}\\b`, language.key === "sql" ? "iu" : "u");
			if (pattern.test(sample)) hits += 1;
		}
		if (hits >= 3) add(language.key, Math.min(7, hits - 1));
	}
	let best = "plaintext";
	let bestScore = 3;
	for (const [key, score] of scores) {
		if (score > bestScore) {
			best = key;
			bestScore = score;
		}
	}
	return { key: best, score: best === "plaintext" ? 0 : bestScore };
}

function normalizeNewlines(code: string) {
	return code.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

function trimLines(code: string) {
	return normalizeNewlines(code).split("\n").map((line) => line.replace(/[ \t]+$/gu, "")).join("\n");
}

function expandTabs(code: string, size: number) {
	return trimLines(code).split("\n").map((line) => line.replace(/\t/gu, " ".repeat(size))).join("\n");
}

function squeezeBlankLines(code: string) {
	return trimLines(code).replace(/\n{3,}/gu, "\n\n");
}

function structuralText(tokens: CodeToken[]) {
	return tokens.filter((token) => token.kind !== "string" && token.kind !== "comment").map((token) => token.text).join("");
}

function braceFormat(code: string, languageKey: string) {
	const rows = tokenizeCode(normalizeNewlines(code), languageKey);
	let indent = 0;
	return rows.map((tokens) => {
		const text = tokens.map((token) => token.text).join("").trim();
		if (!text) return "";
		const structural = structuralText(tokens).trim();
		const leadingClosers = structural.match(/^[}\])]+/u)?.[0].length ?? 0;
		const display = Math.max(0, indent - leadingClosers);
		const opens = (structural.match(/[({[]/gu) ?? []).length;
		const closes = (structural.match(/[)}\]]/gu) ?? []).length;
		indent = Math.max(0, indent + opens - closes);
		return `${"  ".repeat(display)}${text}`;
	}).join("\n");
}

function uppercaseSql(code: string) {
	return tokenizeCode(normalizeNewlines(code), "sql").map((tokens) => tokens.map((token) => token.kind === "keyword" || token.kind === "builtin" ? token.text.toUpperCase() : token.text).join("")).join("\n");
}

export function formatSource(code: string, method: FormatMethodId, languageKey?: string | null) {
	const language = clipboardLanguage(languageKey);
	if (method === "original") return { code, message: "已保持原始排版。" };
	if (method === "trim") return { code: trimLines(code), message: "已统一换行并去掉行尾空格。" };
	if (method === "tab2") return { code: expandTabs(code, 2), message: "已把制表符展开为 2 个空格。" };
	if (method === "tab4") return { code: expandTabs(code, 4), message: "已把制表符展开为 4 个空格。" };
	if (method === "squeeze") return { code: squeezeBlankLines(code), message: "已合并连续空行。" };
	if (method === "json") {
		try {
			return { code: JSON.stringify(JSON.parse(code), null, 2), message: "JSON 已按两个空格重新排版。" };
		} catch {
			return { code, message: "这段内容不是合法 JSON，已保持原样。" };
		}
	}
	if (method === "sql") return { code: uppercaseSql(code), message: "SQL 关键字已转为大写，字符串和注释未改动。" };
	if (!BRACE_LANGUAGES.has(language.key) && !/[{}()[\]]/u.test(code)) {
		return { code: trimLines(code), message: `${language.label} 不适合括号重排，已改为整理空白。` };
	}
	return { code: braceFormat(code, language.key), message: "已按括号层级用两个空格重新缩进。" };
}

function channel(hex: string, offset: number) {
	return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function luminance(hex: string) {
	const value = hex.trim().toLowerCase();
	if (!/^#[0-9a-f]{6}$/u.test(value)) return 0;
	return (0.2126 * channel(value, 1) + 0.7152 * channel(value, 3) + 0.0722 * channel(value, 5)) / 255;
}

/** Word 会保留复制来的背景色。深色策略和任何偏暗底纹都改回经典浅色。 */
export function wordSafePalette(palette: HighlightPalette) {
	if (palette.screenDark || palette.zebra.some((color) => luminance(color) < 0.82)) return CLASSIC_PALETTE;
	return palette;
}

function wordColor(hex: string) {
	const value = hex.trim().toLowerCase();
	if (!/^#[0-9a-f]{6}$/u.test(value) || luminance(value) > 0.72) return "#000000";
	return value;
}

function wordText(value: string) {
	return escapeHtml(value).replace(/ /gu, "&nbsp;").replace(/\t/gu, "&nbsp;&nbsp;&nbsp;&nbsp;");
}

export function wordCopyHtml(code: string, languageKey: string | null | undefined, strategyId: string, includeLineNumbers = false) {
	const palette = wordSafePalette(highlightStrategy(strategyId));
	const rows = tokenizeCode(code, languageKey);
	const body = rows.map((tokens, index) => {
		const background = palette.zebra[index % 2] ?? "#ffffff";
		const content = tokens.length
			? tokens.map((token) => {
				const color = wordColor(palette[token.kind]);
				const weight = token.kind === "keyword" && palette.keywordWeight === "bold" ? "bold" : "normal";
				const style = token.kind === "comment" && palette.commentStyle === "italic" ? "italic" : "normal";
				return `<span style="color:${color};font-weight:${weight};font-style:${style};background-color:transparent;">${wordText(token.text) || "&nbsp;"}</span>`;
			}).join("")
			: "<span style=\"color:#000000;background-color:transparent;\">&nbsp;</span>";
		const numberCell = includeLineNumbers
			? `<td bgcolor="${background}" style="background-color:${background};color:#888888;font-family:Consolas,'Courier New',monospace;font-size:10.5pt;padding:0 8px 0 0;text-align:right;white-space:pre;">${index + 1}</td>`
			: "";
		return `<tr>${numberCell}<td bgcolor="${background}" style="background-color:${background};color:#000000;font-family:Consolas,'Courier New',monospace;font-size:10.5pt;padding:0 6px;white-space:pre;mso-line-height-rule:exactly;">${content}</td></tr>`;
	}).join("");
	return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><!--StartFragment--><table bgcolor="#ffffff" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background-color:#ffffff;color:#000000;font-family:Consolas,'Courier New',monospace;font-size:10.5pt;">${body}</table><!--EndFragment--></body></html>`;
}
