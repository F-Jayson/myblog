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

function escapeHtml(value: string) {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#039;");
}

function spanToken(kind: string, value: string) {
	return `<span class="compiler-token-${kind}">${escapeHtml(value)}</span>`;
}

function highlightLine(line: string, language: HighlightLanguage) {
	if (language.key === "plaintext" || language.key === "markdown") return escapeHtml(line) || " ";
	const sql = language.key === "sql";
	const keywords = new Set(language.keywords.map((word) => sql ? word.toLowerCase() : word));
	const builtins = new Set(language.builtins ?? []);
	const commentStarts = language.commentStarts ?? (language.key === "python" || language.key === "ruby" || language.key === "bash" || language.key === "yaml" ? ["#"] : language.key === "sql" ? ["--"] : ["//"]);
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

export function highlightedCode(code: string, languageKey?: string | null) {
	const language = clipboardLanguage(languageKey);
	return code.split("\n").map((line) => highlightLine(line, language)).join("\n");
}
