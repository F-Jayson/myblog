import {
	ArrowLeftRight,
	Binary,
	Braces,
	CaseSensitive,
	Check,
	Clock3,
	Copy,
	FileCode2,
	Fingerprint,
	Code2,
	Gamepad2,
	Hash,
	Highlighter,
	Image,
	KeyRound,
	Link2,
	Palette,
	Pipette,
	Type,
	Upload,
	Wrench,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import CodeHighlightPage from "./CodeHighlightPage";
import { useAuth } from "./auth";
import {
	MAX_TOOL_FILE_BYTES,
	bytesToBase64,
	convertCase,
	convertRadix,
	createUuid,
	decodeBase64,
	decodeBase64Bytes,
	decodeJwt,
	decodeUrl,
	decodeUtf8,
	digestHex,
	encodeBase64,
	encodeUrl,
	escapeHtml,
	formatHex,
	formatHsl,
	formatHsv,
	formatJson,
	formatRgb,
	formatTimestamp,
	opaqueHex,
	parseColor,
	parseTimestamp,
	textStats,
	toBase64Url,
	toDatetimeLocal,
	unescapeHtml,
	type CaseMode,
	type HashAlgorithm,
	type Rgba,
} from "./devTools";

type ToolItem = { id: string; title: string; description: string; icon: LucideIcon };

export const DEV_TOOLS: ToolItem[] = [
	{ id: "picker", title: "屏幕取色", description: "从页面上吸取颜色，并立刻看到 HEX、RGB、HSL 和 HSV。", icon: Pipette },
	{ id: "color", title: "颜色转换", description: "在 HEX、RGB、HSL、HSV 之间互相转换，也支持常见颜色名。", icon: Palette },
	{ id: "base64", title: "Base64", description: "编码或解码 UTF-8 文本。文件在本地转换，不超过 2MB。", icon: Binary },
	{ id: "url", title: "URL 编码", description: "对查询参数做编码和解码，也可以保留网址里的分隔符。", icon: Link2 },
	{ id: "json", title: "JSON 格式化", description: "把 JSON 排版成易读的缩进，或压成一行。", icon: Braces },
	{ id: "timestamp", title: "时间戳", description: "Unix 秒、毫秒和本地日期互相转换。", icon: Clock3 },
	{ id: "hash", title: "哈希", description: "计算 SHA-1、SHA-256、SHA-384 和 SHA-512。", icon: Hash },
	{ id: "uuid", title: "UUID", description: "生成随机 UUID，可选去掉连字符或转成大写。", icon: Fingerprint },
	{ id: "radix", title: "进制转换", description: "在 2 到 36 进制之间转换整数。", icon: ArrowLeftRight },
	{ id: "jwt", title: "JWT 解码", description: "查看 JWT 的头部和载荷。只解码，不校验签名。", icon: KeyRound },
	{ id: "text", title: "文本统计", description: "统计字符、词数、行数和 UTF-8 字节数。", icon: Type },
	{ id: "case", title: "大小写转换", description: "转换成大写、小写、驼峰、蛇形或常量命名。", icon: CaseSensitive },
	{ id: "html", title: "HTML 转义", description: "转义或还原 HTML 文本。", icon: FileCode2 },
	{ id: "highlight", title: "代码高亮", description: "识别语言并高亮代码，复制到 Word 时使用浅色斑马纹。", icon: Highlighter },
];

const toolById = (id: string) => DEV_TOOLS.find((tool) => tool.id === id);

type EyeDropperWindow = Window & { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } };

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.left = "-9999px";
		document.body.append(area);
		area.select();
		const copied = document.execCommand("copy");
		area.remove();
		if (!copied) throw new Error("copy failed");
	}
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
	const [done, setDone] = useState(false);
	return <button className="user-tool-button" type="button" disabled={!text} onClick={() => {
		void copyText(text).then(() => {
			setDone(true);
			window.setTimeout(() => setDone(false), 1400);
		}).catch(() => setDone(false));
	}}>{done ? <Check size={15} /> : <Copy size={15} />}{done ? "已复制" : label}</button>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return <label className="dev-tool-field">{label}{children}</label>;
}

function ResultBox({ label, value }: { label: string; value: string }) {
	return <div className="dev-tool-result-block">
		<div className="dev-tool-result-head"><span>{label}</span><CopyButton text={value} /></div>
		<textarea className="dev-tool-textarea" readOnly value={value} spellCheck={false} />
	</div>;
}

function ToolSwitcher({ current }: { current: string }) {
	return <nav className="card dev-tool-switch-bar" aria-label="切换小工具">
		<Link to="/tools">全部</Link>
		{DEV_TOOLS.map((tool) => <Link key={tool.id} to={`/tools/${tool.id}`} className={tool.id === current ? "selected" : ""} aria-current={tool.id === current ? "page" : undefined}>{tool.title}</Link>)}
	</nav>;
}

function ToolCard({ id, children }: { id: string; children: ReactNode }) {
	const tool = toolById(id) ?? DEV_TOOLS[0];
	const Icon = tool.icon;
	return <section className="card content-card user-tool-page dev-tools-page">
		<header className="user-tool-heading">
			<div>
				<span className="tool-eyebrow">DEV TOOLS</span>
				<h2><Icon size={22} /> {tool.title}</h2>
				<p>{tool.description}</p>
			</div>
			<Link className="user-tool-link" to="/tools">返回列表</Link>
		</header>
		{children}
	</section>;
}

function ColorWorkbench({ initial, emphasizePicker }: { initial?: string; emphasizePicker?: boolean }) {
	const starting = parseColor(initial || "") ?? parseColor("#3aa6a0")!;
	const [color, setColor] = useState<Rgba>(starting);
	const [hex, setHex] = useState(formatHex(starting));
	const [rgb, setRgb] = useState(formatRgb(starting));
	const [hsl, setHsl] = useState(formatHsl(starting));
	const [hsv, setHsv] = useState(formatHsv(starting));
	const [error, setError] = useState("");

	const commit = (next: Rgba, source: "hex" | "rgb" | "hsl" | "hsv" | "picker") => {
		setColor(next);
		setError("");
		if (source !== "hex") setHex(formatHex(next));
		if (source !== "rgb") setRgb(formatRgb(next));
		if (source !== "hsl") setHsl(formatHsl(next));
		if (source !== "hsv") setHsv(formatHsv(next));
	};

	const edit = (source: "hex" | "rgb" | "hsl" | "hsv", value: string, setValue: (next: string) => void) => {
		setValue(value);
		const next = parseColor(value);
		if (!next) {
			setError("无法识别。可以写 #RGB、#RRGGBB、rgb()、hsl()、hsv()，或 red 这样的颜色名。");
			return;
		}
		commit(next, source);
	};

	const pick = async () => {
		const EyeDropperCtor = (window as EyeDropperWindow).EyeDropper;
		if (!EyeDropperCtor) {
			setError("当前浏览器不支持屏幕取色。请使用 Chrome 或 Edge，也可以在下面手动输入。");
			return;
		}
		try {
			const result = await new EyeDropperCtor().open();
			const next = parseColor(result.sRGBHex);
			if (!next) {
				setError("没有识别到取到的颜色。");
				return;
			}
			commit(next, "picker");
		} catch (caught) {
			if (caught instanceof DOMException && caught.name === "AbortError") return;
			setError("没有取到颜色。可以改用手动输入。");
		}
	};

	const picker = <button className={`user-tool-button dev-tool-pick ${emphasizePicker ? "primary" : ""}`} type="button" onClick={() => void pick()}><Pipette size={16} />屏幕取色</button>;
	return <div className="dev-tool-stack">
		<div className="color-swatch" aria-hidden="true"><i style={{ background: formatRgb(color) }} /></div>
		<div className="dev-tool-actions">
			{emphasizePicker ? picker : null}
			<label className="dev-tool-color-label">色板
				<input className="dev-tool-color-input" type="color" value={opaqueHex(color)} aria-label="用色板选色" onChange={(event) => {
					const next = parseColor(event.target.value);
					if (next) commit({ ...next, a: color.a }, "picker");
				}} />
			</label>
			{emphasizePicker ? null : picker}
			<Link className="user-tool-link" to={`/tools/${emphasizePicker ? "color" : "picker"}?color=${encodeURIComponent(formatHex(color))}`}>{emphasizePicker ? "打开颜色转换" : "打开屏幕取色"}</Link>
		</div>
		<div className="dev-tool-output-list">
			<ColorRow label="HEX" value={hex} onChange={(value) => edit("hex", value, setHex)} />
			<ColorRow label="RGB" value={rgb} onChange={(value) => edit("rgb", value, setRgb)} />
			<ColorRow label="HSL" value={hsl} onChange={(value) => edit("hsl", value, setHsl)} />
			<ColorRow label="HSV" value={hsv} onChange={(value) => edit("hsv", value, setHsv)} />
		</div>
		{error ? <p className="user-tool-error" role="alert">{error}</p> : <p className="highlight-hint">饱和度和亮度可以写 50% 或 50。0 到 1 的小数会按比例计算。屏幕取色需要 Chrome 或 Edge。</p>}
	</div>;
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
	return <div className="dev-tool-output-row">
		<span>{label}</span>
		<input value={value} spellCheck={false} aria-label={label} onChange={(event) => onChange(event.target.value)} />
		<CopyButton text={value} />
	</div>;
}

function Base64Tool() {
	const [mode, setMode] = useState<"encode" | "decode">("encode");
	const [input, setInput] = useState("你好，Jayson");
	const [urlSafe, setUrlSafe] = useState(false);
	const [fileNote, setFileNote] = useState("");
	const decoded = useMemo(() => {
		if (mode !== "decode") return null;
		try { return { bytes: decodeBase64Bytes(input), error: "" }; }
		catch (error) { return { bytes: null, error: error instanceof Error ? error.message : "解码失败" }; }
	}, [mode, input]);
	const textResult = useMemo(() => {
		if (mode === "encode") {
			const encoded = encodeBase64(input);
			return { value: urlSafe ? toBase64Url(encoded) : encoded, error: "" };
		}
		if (!decoded || decoded.error || !decoded.bytes) return { value: "", error: decoded?.error || "" };
		try { return { value: decodeUtf8(decoded.bytes), error: "" }; }
		catch { return { value: "", error: "这段 Base64 不是 UTF-8 文本，可以下载二进制文件。" }; }
	}, [decoded, input, mode, urlSafe]);

	const readFile = async (file: File | undefined) => {
		if (!file) return;
		if (file.size > MAX_TOOL_FILE_BYTES) {
			setFileNote("文件超过 2MB，请换一个更小的文件。");
			return;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		setMode("decode");
		setInput(bytesToBase64(bytes));
		setFileNote(`已读入 ${file.name}（${file.size} 字节）。输入框是它的 Base64，下面会尝试还原成文本。`);
	};

	const download = () => {
		if (!decoded?.bytes) return;
		const blob = new Blob([decoded.bytes.slice()]);
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = textResult.error ? "decoded.bin" : "decoded.txt";
		document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	return <div className="dev-tool-stack">
		<div className="clipboard-type-switch" role="group" aria-label="Base64 方向">
			<button type="button" className={mode === "encode" ? "selected" : ""} onClick={() => setMode("encode")}>编码</button>
			<button type="button" className={mode === "decode" ? "selected" : ""} onClick={() => setMode("decode")}>解码</button>
		</div>
		<Field label={mode === "encode" ? "原文" : "Base64"}>
			<textarea className="dev-tool-textarea" value={input} spellCheck={false} onChange={(event) => { setInput(event.target.value); setFileNote(""); }} />
		</Field>
		<div className="dev-tool-actions">
			<label className="user-tool-button"><Upload size={15} />选择文件<input type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void readFile(file); }} /></label>
			{mode === "encode" ? <label className="tool-check"><input type="checkbox" checked={urlSafe} onChange={(event) => setUrlSafe(event.target.checked)} />URL 安全</label> : null}
			{mode === "decode" ? <button className="user-tool-button" type="button" disabled={!decoded?.bytes} onClick={download}>下载解码结果</button> : null}
		</div>
		{fileNote ? <p className="user-tool-message">{fileNote}</p> : null}
		{textResult.error ? <p className="user-tool-error" role="alert">{textResult.error}</p> : null}
		<ResultBox label={mode === "encode" ? "Base64" : "文本"} value={textResult.value} />
	</div>;
}

function UrlTool() {
	const [mode, setMode] = useState<"encode" | "decode">("encode");
	const [input, setInput] = useState("https://blog.fjayson.com/search?q=你好");
	const [preserveUrl, setPreserveUrl] = useState(false);
	const [plusAsSpace, setPlusAsSpace] = useState(false);
	const result = useMemo(() => {
		try {
			return { value: mode === "encode" ? encodeUrl(input, preserveUrl) : decodeUrl(input, plusAsSpace), error: "" };
		} catch (error) {
			return { value: "", error: error instanceof Error ? error.message : "转换失败" };
		}
	}, [input, mode, plusAsSpace, preserveUrl]);
	return <div className="dev-tool-stack">
		<div className="clipboard-type-switch" role="group" aria-label="URL 方向">
			<button type="button" className={mode === "encode" ? "selected" : ""} onClick={() => setMode("encode")}>编码</button>
			<button type="button" className={mode === "decode" ? "selected" : ""} onClick={() => setMode("decode")}>解码</button>
		</div>
		<Field label="内容"><textarea className="dev-tool-textarea" value={input} spellCheck={false} onChange={(event) => setInput(event.target.value)} /></Field>
		<label className="tool-check">{mode === "encode"
			? <><input type="checkbox" checked={preserveUrl} onChange={(event) => setPreserveUrl(event.target.checked)} />保留 : / ? & =</>
			: <><input type="checkbox" checked={plusAsSpace} onChange={(event) => setPlusAsSpace(event.target.checked)} />把 + 当成空格</>}</label>
		{result.error ? <p className="user-tool-error" role="alert">{result.error}</p> : null}
		<ResultBox label="结果" value={result.value} />
	</div>;
}

function JsonTool() {
	const [input, setInput] = useState("{\"name\":\"Jayson\",\"tools\":[\"color\",\"base64\"]}");
	const [space, setSpace] = useState(2);
	const result = useMemo(() => {
		try { return { value: formatJson(input, space), error: "" }; }
		catch (error) { return { value: "", error: error instanceof SyntaxError ? `不是有效的 JSON：${error.message}` : "格式化失败" }; }
	}, [input, space]);
	return <div className="dev-tool-stack">
		<Field label="缩进">
			<select value={space} onChange={(event) => setSpace(Number(event.target.value))}>
				<option value={2}>2 个空格</option>
				<option value={4}>4 个空格</option>
				<option value={0}>压缩成一行</option>
			</select>
		</Field>
		<Field label="JSON"><textarea className="dev-tool-textarea tall" value={input} spellCheck={false} onChange={(event) => setInput(event.target.value)} /></Field>
		{result.error ? <p className="user-tool-error" role="alert">{result.error}</p> : null}
		<ResultBox label="结果" value={result.value} />
	</div>;
}

function TimestampTool() {
	const [raw, setRaw] = useState(() => String(Date.now()));
	const date = parseTimestamp(raw);
	const parts = date ? formatTimestamp(date) : null;
	return <div className="dev-tool-stack">
		<Field label="时间戳或日期">
			<input value={raw} spellCheck={false} onChange={(event) => setRaw(event.target.value)} placeholder="1710000000 或 2026-10-18 12:00" />
		</Field>
		<div className="dev-tool-actions">
			<button className="user-tool-button" type="button" onClick={() => setRaw(String(Date.now()))}>当前时间</button>
			<label className="dev-tool-field">本地时间
				<input type="datetime-local" value={date ? toDatetimeLocal(date) : ""} onChange={(event) => {
					const next = new Date(event.target.value);
					if (!Number.isNaN(next.getTime())) setRaw(String(next.getTime()));
				}} />
			</label>
		</div>
		{parts ? <div className="dev-tool-output-list">
			<OutputLine label="秒" value={parts.seconds} />
			<OutputLine label="毫秒" value={parts.milliseconds} />
			<OutputLine label="本地" value={parts.local} />
			<OutputLine label="UTC" value={parts.utc} />
			<OutputLine label="ISO" value={parts.iso} />
		</div> : <p className="user-tool-error" role="alert">无法解析这个时间。10 位及更短的整数按秒，13 位按毫秒。</p>}
	</div>;
}

function OutputLine({ label, value }: { label: string; value: string }) {
	return <div className="dev-tool-output-row">
		<span>{label}</span>
		<code>{value}</code>
		<CopyButton text={value} />
	</div>;
}

function HashTool() {
	const [text, setText] = useState("Jayson's Blog");
	const [algorithm, setAlgorithm] = useState<HashAlgorithm>("SHA-256");
	const [hex, setHex] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		if (text.length > 200_000) {
			setError("文本超过 20 万字符，请缩短后再计算。");
			setHex("");
			return;
		}
		setError("");
		void digestHex(algorithm, text).then((value) => { if (active) setHex(value); }).catch(() => { if (active) setError("当前环境无法计算哈希。请使用 HTTPS 或本机页面。"); });
		return () => { active = false; };
	}, [algorithm, text]);
	return <div className="dev-tool-stack">
		<Field label="算法">
			<select value={algorithm} onChange={(event) => setAlgorithm(event.target.value as HashAlgorithm)}>
				<option>SHA-1</option>
				<option>SHA-256</option>
				<option>SHA-384</option>
				<option>SHA-512</option>
			</select>
		</Field>
		<Field label="文本"><textarea className="dev-tool-textarea" value={text} spellCheck={false} onChange={(event) => setText(event.target.value)} /></Field>
		{error ? <p className="user-tool-error" role="alert">{error}</p> : null}
		<ResultBox label={algorithm} value={hex} />
	</div>;
}

function UuidTool() {
	const [count, setCount] = useState(1);
	const [hyphens, setHyphens] = useState(true);
	const [upper, setUpper] = useState(false);
	const [raws, setRaws] = useState(() => [createUuid()]);
	const value = raws.map((raw) => {
		const next = hyphens ? raw : raw.replace(/-/g, "");
		return upper ? next.toUpperCase() : next;
	}).join("\n");
	const generate = () => setRaws(Array.from({ length: count }, () => createUuid()));
	return <div className="dev-tool-stack">
		<div className="dev-tool-actions">
			<Field label="数量">
				<select value={count} onChange={(event) => setCount(Number(event.target.value))}>
					<option value={1}>1 个</option>
					<option value={5}>5 个</option>
					<option value={10}>10 个</option>
				</select>
			</Field>
			<label className="tool-check"><input type="checkbox" checked={hyphens} onChange={(event) => setHyphens(event.target.checked)} />保留连字符</label>
			<label className="tool-check"><input type="checkbox" checked={upper} onChange={(event) => setUpper(event.target.checked)} />大写</label>
			<button className="user-tool-button primary" type="button" onClick={generate}>生成</button>
		</div>
		<ResultBox label="UUID" value={value} />
	</div>;
}

function RadixTool() {
	const [value, setValue] = useState("255");
	const [from, setFrom] = useState(10);
	const [to, setTo] = useState(16);
	const result = useMemo(() => {
		try { return { value: convertRadix(value, from, to), error: "" }; }
		catch (error) { return { value: "", error: error instanceof Error ? error.message : "转换失败" }; }
	}, [from, to, value]);
	const setBase = (value: string, apply: (base: number) => void) => {
		const base = Number(value);
		if (Number.isInteger(base)) apply(Math.min(36, Math.max(2, base)));
	};
	return <div className="dev-tool-stack">
		<div className="dev-tool-inline">
			<Field label="从">
				<input type="number" min={2} max={36} value={from} onChange={(event) => setBase(event.target.value, setFrom)} />
			</Field>
			<button className="user-tool-button" type="button" onClick={() => { setFrom(to); setTo(from); }}><ArrowLeftRight size={15} />对调</button>
			<Field label="到">
				<input type="number" min={2} max={36} value={to} onChange={(event) => setBase(event.target.value, setTo)} />
			</Field>
		</div>
		<Field label="数字"><input value={value} spellCheck={false} onChange={(event) => setValue(event.target.value)} placeholder="例如 ff、0x10 或 -42" /></Field>
		{result.error ? <p className="user-tool-error" role="alert">{result.error}</p> : null}
		<ResultBox label="结果" value={result.value} />
	</div>;
}

function JwtTool() {
	const sample = useMemo(() => `${toBase64Url(encodeBase64(JSON.stringify({ alg: "none", typ: "JWT" })))}.${toBase64Url(encodeBase64(JSON.stringify({ sub: "jayson", name: "Jayson", iat: 1710000000 })))}.`, []);
	const [token, setToken] = useState(sample);
	const result = useMemo(() => {
		if (!token.trim()) return { view: null, error: "" };
		try { return { view: decodeJwt(token), error: "" }; }
		catch (error) { return { view: null, error: error instanceof Error ? error.message : "解码失败" }; }
	}, [token]);
	return <div className="dev-tool-stack">
		<Field label="JWT"><textarea className="dev-tool-textarea" value={token} spellCheck={false} onChange={(event) => setToken(event.target.value)} /></Field>
		<p className="highlight-hint">只解码内容，不校验签名，也不能用来判断令牌是否可信。</p>
		{result.error ? <p className="user-tool-error" role="alert">{result.error}</p> : null}
		{result.view ? <>
			{result.view.claims ? <p className="user-tool-message">{result.view.claims}</p> : null}
			<p className="user-tool-message">{result.view.signaturePresent ? "包含签名段，页面没有验证它。" : "没有签名段。"}</p>
			<ResultBox label="头部" value={result.view.header} />
			<ResultBox label="载荷" value={result.view.payload} />
		</> : null}
	</div>;
}

function TextTool() {
	const [value, setValue] = useState("你好，Jayson");
	const stats = textStats(value);
	const items = [
		["字符", stats.chars],
		["不含空白", stats.charsNoSpace],
		["词数", stats.words],
		["行数", stats.lines],
		["UTF-8 字节", stats.bytes],
	] as const;
	return <div className="dev-tool-stack">
		<Field label="文本"><textarea className="dev-tool-textarea tall" value={value} onChange={(event) => setValue(event.target.value)} /></Field>
		<dl className="dev-tool-stats">{items.map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
	</div>;
}

const CASE_MODES: Array<{ id: CaseMode; label: string }> = [
	{ id: "upper", label: "大写" },
	{ id: "lower", label: "小写" },
	{ id: "title", label: "标题" },
	{ id: "camel", label: "小驼峰" },
	{ id: "pascal", label: "大驼峰" },
	{ id: "snake", label: "蛇形" },
	{ id: "kebab", label: "短横线" },
	{ id: "constant", label: "常量" },
];

function CaseTool() {
	const [input, setInput] = useState("hello dev tools");
	const [mode, setMode] = useState<CaseMode>("camel");
	const output = convertCase(input, mode);
	return <div className="dev-tool-stack">
		<div className="clipboard-type-switch" role="group" aria-label="命名风格">
			{CASE_MODES.map((item) => <button type="button" key={item.id} className={mode === item.id ? "selected" : ""} onClick={() => setMode(item.id)}>{item.label}</button>)}
		</div>
		<Field label="原文"><textarea className="dev-tool-textarea" value={input} spellCheck={false} onChange={(event) => setInput(event.target.value)} /></Field>
		<div className="dev-tool-actions"><button className="user-tool-button" type="button" onClick={() => setInput(output)}>用结果替换原文</button></div>
		<ResultBox label="结果" value={output} />
	</div>;
}

function HtmlTool() {
	const [mode, setMode] = useState<"escape" | "unescape">("escape");
	const [input, setInput] = useState("<a href=\"https://blog.fjayson.com\">Jayson's Blog</a>");
	const output = mode === "escape" ? escapeHtml(input) : unescapeHtml(input);
	return <div className="dev-tool-stack">
		<div className="clipboard-type-switch" role="group" aria-label="HTML 方向">
			<button type="button" className={mode === "escape" ? "selected" : ""} onClick={() => setMode("escape")}>转义</button>
			<button type="button" className={mode === "unescape" ? "selected" : ""} onClick={() => setMode("unescape")}>还原</button>
		</div>
		<Field label="文本"><textarea className="dev-tool-textarea" value={input} spellCheck={false} onChange={(event) => setInput(event.target.value)} /></Field>
		<ResultBox label="结果" value={output} />
	</div>;
}

function SiteToolLinks() {
	const { features } = useAuth();
	const links = [
		features.gamesEnabled ? { to: "/tools/games", label: "小游戏", icon: Gamepad2 } : null,
		features.compilerEnabled ? { to: "/tools/compiler", label: "在线编译器", icon: Code2 } : null,
		features.imageHostingEnabled ? { to: "/tools/image-host", label: "图床", icon: Image } : null,
		features.clipboardEnabled ? { to: "/tools/clipboard", label: "在线剪贴板", icon: Copy } : null,
	].filter((item): item is { to: string; label: string; icon: LucideIcon } => Boolean(item));
	if (!links.length) return null;
	return <div className="dev-tool-more">
		<h3>站点功能</h3>
		<div className="home-tools-grid">{links.map((item) => {
			const Icon = item.icon;
			return <Link key={item.to} to={item.to}><Icon size={16} />{item.label}</Link>;
		})}</div>
	</div>;
}

function Catalog({ notice }: { notice?: string }) {
	return <section className="card content-card user-tool-page dev-tools-page">
		<header className="user-tool-heading">
			<div>
				<span className="tool-eyebrow">DEV TOOLS</span>
				<h2><Wrench size={22} /> 开发小工具</h2>
				<p>取色、编码、JSON、时间戳和代码高亮都在这台浏览器里运行，内容不会上传。</p>
			</div>
		</header>
		{notice ? <p className="user-tool-error" role="alert">{notice}</p> : null}
		<div className="dev-tool-grid">
			{DEV_TOOLS.map((tool) => {
				const Icon = tool.icon;
				return <Link className="dev-tool-card" key={tool.id} to={`/tools/${tool.id}`}><strong><Icon size={18} />{tool.title}</strong><span>{tool.description}</span></Link>;
			})}
		</div>
		<SiteToolLinks />
	</section>;
}

function renderTool(id: string) {
	switch (id) {
		case "base64": return <Base64Tool />;
		case "url": return <UrlTool />;
		case "json": return <JsonTool />;
		case "timestamp": return <TimestampTool />;
		case "hash": return <HashTool />;
		case "uuid": return <UuidTool />;
		case "radix": return <RadixTool />;
		case "jwt": return <JwtTool />;
		case "text": return <TextTool />;
		case "case": return <CaseTool />;
		case "html": return <HtmlTool />;
		default: return null;
	}
}

export default function ToolsPage() {
	const { toolId = "" } = useParams();
	const [search] = useSearchParams();
	if (!toolId) return <Catalog />;
	if (!toolById(toolId)) return <Catalog notice="没有这个小工具，请从下面重新选择。" />;
	if (toolId === "highlight") return <><ToolSwitcher current={toolId} /><CodeHighlightPage /></>;
	const initialColor = toolId === "picker" || toolId === "color" ? search.get("color") ?? undefined : undefined;
	return <>
		<ToolSwitcher current={toolId} />
		<ToolCard id={toolId}>
			{toolId === "picker" || toolId === "color" ? <ColorWorkbench key={`${toolId}:${initialColor ?? ""}`} initial={initialColor} emphasizePicker={toolId === "picker"} /> : <div key={toolId}>{renderTool(toolId)}</div>}
		</ToolCard>
	</>;
}
