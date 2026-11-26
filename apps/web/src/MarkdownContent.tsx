import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { clipboardLanguage, tokenizeCode, type TokenKind } from "./codeHighlight";
import { rewriteMarkdownImageSizes } from "./markdown";
import { resolveMediaUrl } from "./media";

type MarkdownContentProps = {
	content: string;
};

// 正文只在 h2–h4 上挂锚点；侧边栏目录（App.tsx 的 extractToc）必须用同一套规则，
// 否则文章里出现 h1/h5/h6 之后编号会整体错位，点目录会跳到别的标题
export function isTocDepth(depth: number) {
	return depth >= 2 && depth <= 4;
}

const LANGUAGE_ALIASES: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	py: "python",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	bash: "bash",
	ps: "bash",
	ps1: "bash",
	pwsh: "bash",
	powershell: "bash",
	console: "bash",
	terminal: "bash",
	yml: "yaml",
	md: "markdown",
	text: "plaintext",
	txt: "plaintext",
	plain: "plaintext",
	cs: "csharp",
	"c#": "csharp",
	"c++": "cpp",
	cc: "cpp",
	hpp: "cpp",
	htm: "html",
	rb: "ruby",
	kt: "kotlin",
	rs: "rust",
	golang: "go",
	jsonc: "json",
};

function escapeHtml(value: string) {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function tokenClass(kind: TokenKind, text: string, colorShellTest: boolean) {
	if (colorShellTest && kind === "plain" && text === "test") return "md-tok-builtin";
	return `md-tok-${kind}`;
}

function renderMacCodeBlock(text: string, lang: string | undefined) {
	const rawLabel = (lang ?? "").trim().split(/[\s,{]+/u)[0]?.toLowerCase() ?? "";
	const safeLabel = /^[a-z0-9#+.-]{1,32}$/u.test(rawLabel) ? rawLabel : "";
	const highlightKey = clipboardLanguage(LANGUAGE_ALIASES[safeLabel] ?? safeLabel).key;
	const source = text.replace(/\n$/u, "");
	const colorShellTest = safeLabel === "powershell" || safeLabel === "ps1" || safeLabel === "pwsh";
	const lines = tokenizeCode(source, highlightKey).map((tokens, index) => {
		const body = tokens.map((token) => `<span class="${tokenClass(token.kind, token.text, colorShellTest)}">${escapeHtml(token.text)}</span>`).join("");
		return `<span class="md-line"><span class="md-gutter" aria-hidden="true">${index + 1}</span><span class="md-line-code">${body}</span></span>`;
	}).join("");
	const label = safeLabel ? `<span class="md-codeblock-lang">${escapeHtml(safeLabel)}</span>` : "";
	return `<div class="md-codeblock"><div class="md-codeblock-bar"><span class="md-codeblock-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="md-codeblock-meta">${label}<button type="button" class="md-codeblock-copy"><span class="md-codeblock-copy-label">复制代码</span><span class="md-codeblock-copy-mark" aria-hidden="true">✓</span></button></span></div><pre><code>${lines}</code></pre></div>\n`;
}

function copyWithTextarea(text: string) {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.left = "-9999px";
	document.body.append(area);
	area.focus();
	area.select();
	const copied = document.execCommand("copy");
	area.remove();
	if (!copied) throw new Error("copy failed");
}

async function copyWithFallback(text: string) {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return;
		}
	} catch {
		// 页面未聚焦或权限被拒绝时，改用选区复制
	}
	copyWithTextarea(text);
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
	const copyTimers = useRef(new Map<HTMLButtonElement, number>());
	useEffect(() => () => {
		for (const timer of copyTimers.current.values()) window.clearTimeout(timer);
	}, []);
	const html = useMemo(() => {
		// [394] marked/DOMPurify 对畸形输入可能抛错：整个渲染包进 try/catch，降级而不是整页白屏
		try {
		let headingIndex = 0;
		const renderer = new Renderer();
		renderer.heading = function ({ tokens, depth }) {
			const inline = this.parser.parseInline(tokens);
			if (!isTocDepth(depth)) return `<h${depth}>${inline}</h${depth}>`;
			const id = `toc-${headingIndex++}`;
			return `<h${depth} id="${id}">${inline}</h${depth}>`;
		};
		renderer.code = function ({ text, lang }) {
			return renderMacCodeBlock(text, lang);
		};
		const rendered = marked.parse(rewriteMarkdownImageSizes(content), {
			async: false,
			renderer,
		});
		const sanitized = DOMPurify.sanitize(String(rendered));
		// [395] 安全不变量：resolveMediaUrl 只放行 http(s):// 与 "/" 开头的同源路径，
		// 永远不会返回 javascript:/data:/协议相对地址，因此“先净化后改写 src”不会重新引入 XSS；
		// 若日后放宽 resolveMediaUrl 的白名单，必须先把改写挪回 DOMPurify 钩子内。
		return sanitized.replace(/<img\b[^>]*\bsrc="([^"]*)"/giu, (match, src: string) => {
			const resolved = resolveMediaUrl(src);
			// [395] 解析失败（如 images/a.png 相对路径）时保留原值，避免静默改坏相对引用
			return resolved ? match.replace(src, resolved) : match;
		});
	} catch (error) {
		// [394] marked/DOMPurify 对畸形输入可能抛错：降级为转义后的纯文本而不是整页白屏
		console.error("Markdown 渲染失败", error);
		const fallback = String(content)
			.replace(/&/gu, "&amp;")
			.replace(/</gu, "&lt;")
			.replace(/>/gu, "&gt;");
		return `<p>${fallback.replace(/\n/gu, "<br />")}</p>`;
	}
	}, [content]);
	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".md-codeblock-copy");
		if (!button || !event.currentTarget.contains(button)) return;
		const block = button.closest(".md-codeblock");
		if (!block) return;
		const text = [...block.querySelectorAll<HTMLElement>(".md-line-code")].map((node) => node.textContent ?? "").join("\n");
		const label = button.querySelector(".md-codeblock-copy-label");
		const previous = copyTimers.current.get(button);
		if (previous) window.clearTimeout(previous);
		const reset = () => {
			if (label) label.textContent = "复制代码";
			button.classList.remove("is-copied");
			copyTimers.current.delete(button);
		};
		void copyWithFallback(text).then(() => {
			if (label) label.textContent = "已复制";
			button.classList.add("is-copied");
			copyTimers.current.set(button, window.setTimeout(reset, 1600));
		}).catch(() => {
			if (label) label.textContent = "复制失败";
			button.classList.remove("is-copied");
			copyTimers.current.set(button, window.setTimeout(reset, 1600));
		});
	};
	return <div className="markdown-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
