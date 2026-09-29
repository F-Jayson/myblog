import { Check, Copy, Highlighter, WrapText } from "lucide-react";
import { useMemo, useState, type ClipboardEvent } from "react";
import {
	CLIPBOARD_LANGUAGES,
	FORMAT_METHODS,
	HIGHLIGHT_STRATEGIES,
	clipboardLanguage,
	detectLanguage,
	formatSource,
	highlightStrategy,
	tokenizeCode,
	wordCopyHtml,
	wordSafePalette,
	type FormatMethodId,
	type HighlightStrategyId,
} from "./codeHighlight";

const SAMPLE = `function greet(name) {
  const message = "Hello, " + name;
  if (!name) {
    return "请填写名字";
  }
  console.log(message);
  return message;
}

greet("Firefly");
`;

function tokenStyle(strategyId: string, kind: string) {
	const palette = highlightStrategy(strategyId);
	const color = palette[kind as "keyword"];
	return {
		color,
		fontWeight: kind === "keyword" && palette.keywordWeight === "bold" ? 700 : 400,
		fontStyle: kind === "comment" && palette.commentStyle === "italic" ? "italic" as const : "normal" as const,
		backgroundColor: "transparent",
	};
}

async function writeClipboard(html: string, plain: string) {
	if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
		await navigator.clipboard.write([
			new ClipboardItem({
				"text/html": new Blob([html], { type: "text/html" }),
				"text/plain": new Blob([plain], { type: "text/plain" }),
			}),
		]);
		return;
	}
	const host = document.createElement("div");
	host.setAttribute("contenteditable", "true");
	host.style.position = "fixed";
	host.style.left = "-9999px";
	host.style.background = "#ffffff";
	host.innerHTML = html;
	document.body.append(host);
	const range = document.createRange();
	range.selectNodeContents(host);
	const selection = document.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	const copied = document.execCommand("copy");
	selection?.removeAllRanges();
	host.remove();
	if (!copied) throw new Error("copy failed");
}

export default function CodeHighlightPage() {
	const [source, setSource] = useState(SAMPLE);
	const [languageMode, setLanguageMode] = useState<"auto" | string>("auto");
	const [strategyId, setStrategyId] = useState<HighlightStrategyId>("classic");
	const [formatId, setFormatId] = useState<FormatMethodId>("trim");
	const [includeLineNumbers, setIncludeLineNumbers] = useState(false);
	const [message, setMessage] = useState("粘贴代码后会自动识别语言。复制到 Word 时使用浅色斑马纹，不会带上深色背景。");
	const [copied, setCopied] = useState<"plain" | "word" | "">("");
	const detected = useMemo(() => detectLanguage(source), [source]);
	const languageKey = languageMode === "auto" ? detected.key : languageMode;
	const language = clipboardLanguage(languageKey);
	const strategy = highlightStrategy(strategyId);
	const copyPalette = wordSafePalette(strategy);
	const rows = useMemo(() => tokenizeCode(source, languageKey), [source, languageKey]);
	const format = FORMAT_METHODS.find((item) => item.id === formatId) ?? FORMAT_METHODS[0];

	const notify = (text: string, kind: "plain" | "word" | "" = "") => {
		setMessage(text);
		setCopied(kind);
		if (kind) window.setTimeout(() => setCopied(""), 1800);
	};

	const applyFormat = () => {
		const result = formatSource(source, formatId, languageKey);
		setSource(result.code);
		notify(result.message);
	};

	const copyPlain = async () => {
		try {
			await navigator.clipboard.writeText(source);
			notify("已复制纯文本，粘贴后只有代码本身。", "plain");
		} catch {
			notify("复制失败，请手动选择代码。");
		}
	};

	const copyWord = async (text = source) => {
		try {
			await writeClipboard(wordCopyHtml(text, languageKey, strategyId, includeLineNumbers && text === source), text);
			const swapped = strategy.screenDark || copyPalette.id !== strategy.id;
			notify(swapped ? "已复制浅色斑马纹。深色预览不会把深色背景带进 Word。" : "已复制浅色斑马纹，可以直接粘贴到 Word。", "word");
		} catch {
			notify("复制失败，请手动选择右侧高亮结果。");
		}
	};

	const onPreviewCopy = (event: ClipboardEvent<HTMLDivElement>) => {
		const text = document.getSelection()?.toString().replace(/\u00a0/gu, " ");
		if (!text) return;
		event.preventDefault();
		event.clipboardData?.setData("text/plain", text);
		event.clipboardData?.setData("text/html", wordCopyHtml(text, languageKey, strategyId, false));
		notify(strategy.screenDark ? "选区已按浅色斑马纹复制，深色背景不会进入 Word。" : "选区已按浅色斑马纹复制。");
	};

	return <section className="card content-card user-tool-page highlight-page">
		<header className="user-tool-heading">
			<div>
				<span className="tool-eyebrow">PUBLIC TOOLS</span>
				<h2><Highlighter size={22} /> 代码高亮</h2>
				<p>自动识别语言，挑选高亮配色和排版方式。无需登录。复制结果使用白与浅灰交替的行背景，避免深色底纹贴进 Word。</p>
			</div>
		</header>
		<div className="highlight-controls">
			<label>语言
				<select value={languageMode} onChange={(event) => setLanguageMode(event.target.value)}>
					<option value="auto">自动识别（{language.label}）</option>
					{CLIPBOARD_LANGUAGES.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
				</select>
			</label>
			<label>高亮策略
				<select value={strategyId} onChange={(event) => setStrategyId(event.target.value as HighlightStrategyId)}>
					{HIGHLIGHT_STRATEGIES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
				</select>
			</label>
			<label>格式化
				<select value={formatId} onChange={(event) => setFormatId(event.target.value as FormatMethodId)}>
					{FORMAT_METHODS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
				</select>
			</label>
		</div>
		<p className="highlight-hint">{strategy.description} {format?.description}</p>
		<div className="highlight-actions">
			<button className="user-tool-button" type="button" onClick={applyFormat}><WrapText size={16} />应用格式化</button>
			<button className="user-tool-button" type="button" onClick={() => void copyPlain()}>{copied === "plain" ? <Check size={16} /> : <Copy size={16} />}{copied === "plain" ? "已复制纯文本" : "复制纯文本"}</button>
			<button className="user-tool-button primary" type="button" onClick={() => void copyWord()}>{copied === "word" ? <Check size={16} /> : <Copy size={16} />}{copied === "word" ? "已复制到 Word" : "复制到 Word"}</button>
			<label className="tool-check"><input type="checkbox" checked={includeLineNumbers} onChange={(event) => setIncludeLineNumbers(event.target.checked)} />复制时带行号</label>
		</div>
		{message ? <p className="user-tool-message highlight-message">{message}</p> : null}
		<div className="highlight-work">
			<label className="highlight-editor-wrap">源代码
				<textarea value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} placeholder="在这里粘贴代码" />
			</label>
			<div className="highlight-preview-wrap">
				<div className="highlight-preview-label"><span>预览 · {language.label}</span>{strategy.screenDark ? <em>屏幕深色，复制为浅色</em> : <em>一白一浅</em>}</div>
				<div className={`highlight-preview is-${strategy.id}`} onCopy={onPreviewCopy}>
					{rows.map((tokens, index) => <div className="highlight-line" key={`${index}-${tokens.length}`} style={{ background: strategy.zebra[index % 2] }}>
						<span className="highlight-gutter" style={{ color: strategy.gutter }}>{index + 1}</span>
						<code className="highlight-code">{tokens.length ? tokens.map((token, tokenIndex) => <span key={tokenIndex} style={tokenStyle(strategyId, token.kind)}>{token.text}</span>) : "\u00a0"}</code>
					</div>)}
				</div>
			</div>
		</div>
	</section>;
}
