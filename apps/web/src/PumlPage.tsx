import {
	Check,
	CircleAlert,
	Copy,
	Download,
	ImageDown,
	LoaderCircle,
	Maximize2,
	RefreshCw,
	Trash2,
	Workflow,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { getPumlStatus, renderPuml, type PumlEngineStatus, type PumlRenderResult } from "./api";
import { escapeHtml } from "./devTools";

/* ---------- 编辑器内容 ---------- */

const DEFAULT_SOURCE = `@startuml
' 把 PlantUML 代码粘贴到这里，右侧会自动出图
title 欢迎使用 PlantUML 绘图

actor 你
participant "渲染服务" as Server

你 -> Server: 粘贴或输入代码
Server --> 你: 返回 SVG 图片
note right of Server
  时序图、类图、活动图、状态图、
  组件图、思维导图都可以
end note
@enduml`;

type Sample = { id: string; label: string; source: string };

const SAMPLES: Sample[] = [
	{
		id: "sequence",
		label: "时序图",
		source: `@startuml
autonumber
actor 读者
participant "博客前台" as Web
participant "API 服务" as Api
database "MySQL" as Db

读者 -> Web: 打开文章页
Web -> Api: GET /api/posts/:id
Api -> Db: 查询文章与标签
Db --> Api: 结果集
Api --> Web: JSON
Web --> 读者: 渲染页面
@enduml`,
	},
	{
		id: "class",
		label: "类图",
		source: `@startuml
class User {
  +id: bigint
  +name: string
  +login()
}
class Post {
  +id: bigint
  +title: string
  +publishedAt: Date
}
class Comment {
  +content: string
}
User "1" -- "0..*" Post : 发表
Post "1" -- "0..*" Comment : 包含
@enduml`,
	},
	{
		id: "activity",
		label: "活动图",
		source: `@startuml
start
:粘贴 PlantUML 代码;
if (语法正确?) then (是)
  :调用渲染服务;
  :返回 SVG 图片;
  if (需要图片?) then (是)
    :导出 PNG;
  else (否)
    :复制 SVG 源码;
  endif
else (否)
  :显示错误行号;
endif
stop
@enduml`,
	},
	{
		id: "usecase",
		label: "用例图",
		source: `@startuml
left to right direction
actor 读者
actor 博主
rectangle 博客系统 {
  usecase "阅读文章" as UC1
  usecase "发布文章" as UC2
  usecase "管理评论" as UC3
}
读者 --> UC1
博主 --> UC2
博主 --> UC3
@enduml`,
	},
	{
		id: "state",
		label: "状态图",
		source: `@startuml
[*] --> 草稿
草稿 --> 审核中 : 提交
审核中 --> 已发布 : 通过
审核中 --> 草稿 : 打回
已发布 --> 归档 : 下架
归档 --> [*]
@enduml`,
	},
	{
		id: "component",
		label: "组件图",
		source: `@startuml
package "前端" {
  [React 应用] as Web
}
package "后端" {
  [Express API] as Api
  database "MySQL" as Db
  [对象存储] as Oss
}
Web --> Api : HTTPS
Api --> Db
Api --> Oss
@enduml`,
	},
	{
		id: "mindmap",
		label: "思维导图",
		source: `@startmindmap
* 博客系统
** 前台
*** 文章
*** 标签
*** 归档
** 后台
*** 编辑器
*** 评论管理
*** 站点设置
@endmindmap`,
	},
	{
		id: "er",
		label: "ER 图",
		source: `@startuml
entity "user" as user {
  *id : bigint <<PK>>
  --
  name : varchar
  email : varchar
}
entity "post" as post {
  *id : bigint <<PK>>
  --
  author_id : bigint <<FK>>
  title : varchar
}
user ||--o{ post
@enduml`,
	},
];

/* ---------- 主题与背景 ---------- */

type BackgroundMode = "auto" | "white" | "transparent" | "dark";

const THEMES: { id: string; label: string }[] = [
	{ id: "", label: "默认（PlantUML 原生）" },
	{ id: "cerulean", label: "Cerulean 蔚蓝" },
	{ id: "superhero", label: "Superhero 暗夜（深色）" },
	{ id: "sketchy", label: "Sketchy 手绘" },
	{ id: "spacelab", label: "Spacelab 太空" },
	{ id: "minty", label: "Minty 薄荷" },
	{ id: "mars", label: "Mars 火星" },
	{ id: "crt-amber", label: "CRT Amber 复古（深色）" },
	{ id: "blueprint", label: "Blueprint 蓝图（深色）" },
	{ id: "black-knight", label: "Black Knight 黑骑士（深色）" },
];

const DARK_THEMES = new Set(["superhero", "crt-amber", "blueprint", "black-knight"]);
const DARK_BACKGROUND = "#161f1b";

const BACKGROUNDS: { id: BackgroundMode; label: string }[] = [
	{ id: "auto", label: "自动（跟随主题）" },
	{ id: "white", label: "白色" },
	{ id: "transparent", label: "透明" },
	{ id: "dark", label: "深色" },
];

const DRAFT_KEY = "puml-tool-source";
const DRAFT_THEME_KEY = "puml-tool-theme";
const DRAFT_BACKGROUND_KEY = "puml-tool-background";

function readStorage(key: string) {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string) {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		/* 隐私模式下 localStorage 可能不可写，忽略即可 */
	}
}

function resolvedBackground(mode: BackgroundMode, themeId: string) {
	if (mode === "white") return "#ffffff";
	if (mode === "dark") return DARK_BACKGROUND;
	if (mode === "transparent") return "";
	return DARK_THEMES.has(themeId) ? DARK_BACKGROUND : "#ffffff";
}

/* ---------- 语法高亮 ---------- */

const PUML_KEYWORDS = [
	"actor", "participant", "boundary", "control", "entity", "database", "collections", "queue",
	"class", "interface", "abstract", "enum", "annotation", "object", "rectangle", "package",
	"namespace", "node", "folder", "frame", "cloud", "storage", "usecase", "component", "artifact",
	"card", "agent", "file", "stack", "port", "portin", "portout", "together", "note", "legend",
	"title", "caption", "header", "footer", "skinparam", "hide", "show", "autonumber", "activate",
	"deactivate", "destroy", "create", "return", "alt", "else", "opt", "loop", "par", "group",
	"break", "critical", "while", "endwhile", "repeat", "backward", "fork", "again", "split",
	"endsplit", "start", "stop", "kill", "detach", "label", "goto", "scale", "allow_mixing",
	"allowmixing", "mainframe", "sprite", "salt", "style", "as", "of", "on", "is", "not", "and",
	"or", "left", "right", "top", "bottom", "up", "down",
];

const PUML_TOKEN_RE = new RegExp([
	"(?<str>\"[^\"]*\")",
	"(?<com>'[^\\n]*)",
	"(?<dir>@[A-Za-z]+|![A-Za-z]+)",
	"(?<ste><<[^>]*>>)",
	"(?<arrow>[<>|*o{}]?[-.=]{2,}[<>|*o{}]?)",
	"(?<color>#[0-9A-Fa-f]{3,8}\\b)",
	"(?<num>\\b\\d+(?:\\.\\d+)?\\b)",
	`(?<kw>\\b(?:${PUML_KEYWORDS.join("|")})\\b)`,
].join("|"), "gu");

function highlightPumlLine(line: string) {
	let html = "";
	let index = 0;
	let match: RegExpExecArray | null;
	PUML_TOKEN_RE.lastIndex = 0;
	while ((match = PUML_TOKEN_RE.exec(line)) !== null) {
		html += escapeHtml(line.slice(index, match.index));
		const groups = match.groups ?? {};
		const kind = groups.str ? "str" : groups.com ? "com" : groups.dir ? "dir" : groups.ste ? "ste" : groups.arrow ? "arr" : groups.color ? "col" : groups.num ? "num" : "kw";
		html += `<span class="tk-${kind}">${escapeHtml(match[0])}</span>`;
		index = match.index + match[0].length;
	}
	return html + escapeHtml(line.slice(index));
}

/* ---------- SVG 处理 ---------- */

type Diagram = { svg: string; width: number; height: number };

function svgSize(svg: string, width: number | null, height: number | null) {
	if (width && height) return { width, height };
	const viewBox = svg.match(/viewBox="([-\d.\s]+)"/u);
	if (viewBox) {
		const parts = viewBox[1].trim().split(/\s+/u).map(Number);
		if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { width: parts[2], height: parts[3] };
	}
	const w = Number(svg.match(/\bwidth="([\d.]+)(?:px)?"/u)?.[1] ?? 0);
	const h = Number(svg.match(/\bheight="([\d.]+)(?:px)?"/u)?.[1] ?? 0);
	return { width: w || 320, height: h || 240 };
}

// PlantUML 会给默认主题加一层白色背景（style 里的 background:#FFFFFF），选“透明”时把它去掉
function stripSvgBackground(svg: string) {
	if (!/background\s*:/iu.test(svg)) return svg;
	return svg.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/iu, (matched, head: string, style: string) => {
		const cleaned = style.replace(/background\s*:[^;"]*;?/giu, "").trim();
		return cleaned ? `${head} style="${cleaned}"` : head.replace(/\s+$/u, "");
	});
}

function loadImage(url: string) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("图片解码失败"));
		image.src = url;
	});
}

async function svgToPng(svg: string, size: { width: number; height: number }, scale: number, background: string) {
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
	try {
		const image = await loadImage(url);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(size.width * scale));
		canvas.height = Math.max(1, Math.round(size.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("浏览器不支持 Canvas");
		if (background) {
			context.fillStyle = background;
			context.fillRect(0, 0, canvas.width, canvas.height);
		}
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
		if (!blob) throw new Error("PNG 生成失败");
		return blob;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function timestampName() {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

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

// 把用户选择的主题插到 @startuml 之后；源码里自己写了 !theme 且下拉框选“默认”时保持原样
function withTheme(source: string, themeId: string) {
	if (!themeId) return source;
	const directive = `!theme ${themeId}`;
	const existing = source.match(/^[ \t]*!theme[ \t]+\S+[ \t]*$/gmu);
	let body = source;
	if (existing && existing.length) {
		let replaced = false;
		body = source.replace(/^[ \t]*!theme[ \t]+\S+[ \t]*$/gmu, () => {
			if (replaced) return "";
			replaced = true;
			return directive;
		});
		body = body.replace(/\n{3,}/gu, "\n\n");
		return body;
	}
	const startLine = body.match(/^[ \t]*@start\w+[^\n]*$/mu);
	if (startLine && typeof startLine.index === "number") {
		const insertAt = startLine.index + startLine[0].length;
		return `${body.slice(0, insertAt)}\n${directive}${body.slice(insertAt)}`;
	}
	return `${directive}\n${body}`;
}

/* ---------- 页面 ---------- */

export default function PumlPage() {
	const [source, setSource] = useState(() => readStorage(DRAFT_KEY) ?? DEFAULT_SOURCE);
	const [themeId, setThemeId] = useState(() => readStorage(DRAFT_THEME_KEY) ?? "");
	const [background, setBackground] = useState<BackgroundMode>(() => {
		const saved = readStorage(DRAFT_BACKGROUND_KEY);
		return saved === "white" || saved === "transparent" || saved === "dark" ? saved : "auto";
	});
	const [scale, setScale] = useState(2);
	const [autoRender, setAutoRender] = useState(true);
	const [result, setResult] = useState<PumlRenderResult | null>(null);
	const [diagram, setDiagram] = useState<Diagram | null>(null);
	const [rendering, setRendering] = useState(false);
	const [zoom, setZoom] = useState<number | "fit">("fit");
	const [lightbox, setLightbox] = useState(false);
	const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
	const [engine, setEngine] = useState<PumlEngineStatus | null>(null);
	const [svgUrl, setSvgUrl] = useState("");
	const [renderedPayload, setRenderedPayload] = useState("");

	const abortRef = useRef<AbortController | null>(null);
	const noticeTimerRef = useRef<number | null>(null);
	const highlightRef = useRef<HTMLPreElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const notify = useCallback((text: string, tone: "ok" | "error" = "ok") => {
		setNotice({ text, tone });
		if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
		noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2600);
	}, []);

	useEffect(() => () => {
		if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
		abortRef.current?.abort();
	}, []);

	// 渲染：后端返回 SVG（本地 picoweb 或远程服务），前端只做展示与栅格化
	const runRender = useCallback(async (text: string, theme: string) => {
		const payload = withTheme(text, theme).trim();
		abortRef.current?.abort();
		if (!payload) {
			setResult({ ok: false, error: { message: "先粘贴一段 PlantUML 代码" } });
			setDiagram(null);
			setRendering(false);
			return;
		}
		const controller = new AbortController();
		abortRef.current = controller;
		setRendering(true);
		try {
			const response = await renderPuml(payload, controller.signal);
			if (controller.signal.aborted) return;
			setResult(response);
			if (response.ok) {
				setDiagram({ svg: response.svg, ...svgSize(response.svg, response.width, response.height) });
				setRenderedPayload(payload);
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				setResult({ ok: false, error: { message: error instanceof Error ? error.message : "渲染失败，请稍后重试" } });
				setDiagram(null);
			}
		} finally {
			if (!controller.signal.aborted) setRendering(false);
		}
	}, []);

	useEffect(() => {
		if (!autoRender) return;
		const timer = window.setTimeout(() => void runRender(source, themeId), 620);
		return () => window.clearTimeout(timer);
	}, [source, themeId, autoRender, runRender]);

	useEffect(() => {
		const timer = window.setTimeout(() => writeStorage(DRAFT_KEY, source), 500);
		return () => window.clearTimeout(timer);
	}, [source]);

	useEffect(() => {
		writeStorage(DRAFT_THEME_KEY, themeId);
		writeStorage(DRAFT_BACKGROUND_KEY, background);
	}, [themeId, background]);

	useEffect(() => {
		let alive = true;
		void getPumlStatus().then((status) => {
			if (alive) setEngine(status);
		});
		return () => {
			alive = false;
		};
	}, []);

	const backgroundColor = resolvedBackground(background, themeId);

	const displaySvg = useMemo(() => {
		if (!diagram) return "";
		return background === "transparent" ? stripSvgBackground(diagram.svg) : diagram.svg;
	}, [diagram, background]);

	useEffect(() => {
		if (!displaySvg) {
			setSvgUrl("");
			return;
		}
		const url = URL.createObjectURL(new Blob([displaySvg], { type: "image/svg+xml;charset=utf-8" }));
		setSvgUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [displaySvg]);

	useEffect(() => {
		if (!lightbox) return;
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setLightbox(false);
		};
		window.addEventListener("keydown", onKeyDown);
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previous;
		};
	}, [lightbox]);

	const highlighted = useMemo(() => `${source.split("\n").map(highlightPumlLine).join("\n")}\n`, [source]);
	const lines = useMemo(() => source.split("\n").length, [source]);
	const failed = result !== null && result.ok === false;
	// With auto-render off the shown picture can lag behind the code; say so instead
	// of letting the preview look up to date.
	const pending = Boolean(diagram) && renderedPayload !== withTheme(source, themeId).trim();
	const errorMessage = failed ? result.error.message : "";
	const errorLine = failed && typeof result.error.line === "number" ? result.error.line : null;
	const errorSnippet = useMemo(() => {
		// PlantUML does not report the failing line, only where the diagram starts,
		// so the backend hands us the excerpt it parsed and we show that instead of
		// pretending to know the exact line.
		if (!failed) return "";
		if (errorLine) {
			const rows = source.split("\n");
			const from = Math.max(1, errorLine - 1);
			const to = Math.min(rows.length, errorLine + 1);
			const slice: string[] = [];
			for (let index = from; index <= to; index += 1) slice.push(`${String(index).padStart(3, " ")} | ${rows[index - 1] ?? ""}`);
			return slice.join("\n");
		}
		const raw = result && result.ok === false ? result.error.raw ?? "" : "";
		return raw.split("\n").map((row) => row.trim()).filter(Boolean).slice(0, 8).join("\n");
	}, [errorLine, failed, result, source]);

	const syncScroll = () => {
		const textarea = textareaRef.current;
		const pre = highlightRef.current;
		if (!textarea || !pre) return;
		pre.scrollTop = textarea.scrollTop;
		pre.scrollLeft = textarea.scrollLeft;
	};

	const insertIndent = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Tab") {
			event.preventDefault();
			const target = event.currentTarget;
			const { selectionStart, selectionEnd, value } = target;
			const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
			setSource(next);
			window.requestAnimationFrame(() => {
				target.selectionStart = selectionStart + 2;
				target.selectionEnd = selectionStart + 2;
			});
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
			event.preventDefault();
			void runRender(source, themeId);
		}
	};

	const ensureDiagram = () => {
		if (!diagram) {
			notify("还没有可导出的图片，先渲染一次", "error");
			return null;
		}
		return diagram;
	};

	const handleCopyImage = async () => {
		const current = ensureDiagram();
		if (!current) return;
		try {
			const blob = await svgToPng(displaySvg, current, scale, backgroundColor);
			if (typeof ClipboardItem === "undefined" || !navigator.clipboard || !navigator.clipboard.write) throw new Error("unsupported");
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			notify(`已复制图片到剪贴板（${Math.round(current.width * scale)}×${Math.round(current.height * scale)}）`);
		} catch {
			try {
				const blob = await svgToPng(displaySvg, current, scale, backgroundColor);
				downloadBlob(blob, `plantuml-${timestampName()}.png`);
				notify("当前浏览器不允许写入图片剪贴板，已改为下载 PNG", "error");
			} catch {
				notify("复制图片失败，请改用下载 PNG", "error");
			}
		}
	};

	const handleDownloadPng = async () => {
		const current = ensureDiagram();
		if (!current) return;
		try {
			const blob = await svgToPng(displaySvg, current, scale, backgroundColor);
			downloadBlob(blob, `plantuml-${timestampName()}.png`);
			notify(`已下载 PNG（${scale}x）`);
		} catch {
			notify("导出 PNG 失败，请重试", "error");
		}
	};

	const handleDownloadSvg = () => {
		const current = ensureDiagram();
		if (!current) return;
		downloadBlob(new Blob([displaySvg], { type: "image/svg+xml;charset=utf-8" }), `plantuml-${timestampName()}.svg`);
		notify("已下载 SVG");
	};

	const handleCopySvg = async () => {
		if (!displaySvg) {
			notify("还没有可复制的 SVG", "error");
			return;
		}
		try {
			await copyText(displaySvg);
			notify("已复制 SVG 源码");
		} catch {
			notify("复制失败", "error");
		}
	};

	const handleCopySource = async () => {
		try {
			await copyText(source);
			notify("已复制 PUML 源码");
		} catch {
			notify("复制失败", "error");
		}
	};

	const zoomLabel = zoom === "fit" ? "适应" : `${Math.round(zoom * 100)}%`;
	// The full-screen view should use the room it has: the picture is a vector SVG,
	// so scaling it up stays sharp, but tiny diagrams should not blow up by 10x.
	const lightboxScale = useMemo(() => {
		if (!diagram) return 1;
		const target = Math.min(window.innerWidth * 0.86, window.innerHeight * 0.8);
		const scale = Math.min(target / Math.max(diagram.width, diagram.height), 3);
		return Math.max(1, Math.round(scale * 10) / 10);
	}, [diagram, lightbox]);
	const stepZoom = (delta: number) => {
		setZoom((current) => {
			const base = current === "fit" ? 1 : current;
			return Math.min(6, Math.max(0.2, Math.round((base + delta) * 100) / 100));
		});
	};

	return <section className="card content-card user-tool-page puml-page">
		<header className="user-tool-heading">
			<div>
				<span className="tool-eyebrow">DEV TOOLS</span>
				<h2><Workflow size={22} /> PlantUML 绘图</h2>
				<p>粘贴 PlantUML 代码即时出图，支持复制图片到剪贴板、导出 PNG / SVG。图形由站点后端渲染，源码不会公开。</p>
			</div>
			<Link className="user-tool-link" to="/tools">返回列表</Link>
		</header>

		<div className="puml-toolbar">
			<label>示例模板
				<select value="" onChange={(event) => {
					const sample = SAMPLES.find((item) => item.id === event.target.value);
					if (sample) setSource(sample.source);
				}}>
					<option value="">选择并载入…</option>
					{SAMPLES.map((sample) => <option value={sample.id} key={sample.id}>{sample.label}</option>)}
				</select>
			</label>
			<label>配色主题
				<select value={themeId} onChange={(event) => setThemeId(event.target.value)}>
					{THEMES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
				</select>
			</label>
			<label>背景
				<select value={background} onChange={(event) => setBackground(event.target.value as BackgroundMode)}>
					{BACKGROUNDS.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
				</select>
			</label>
			<label>导出倍数
				<select value={String(scale)} onChange={(event) => setScale(Number(event.target.value))}>
					<option value="1">1x</option>
					<option value="2">2x</option>
					<option value="3">3x</option>
				</select>
			</label>
			<label className="tool-check puml-auto-check">
				<input type="checkbox" checked={autoRender} onChange={(event) => setAutoRender(event.target.checked)} />
				自动渲染
			</label>
			<div className="puml-toolbar-actions">
				<button className="user-tool-button" type="button" onClick={() => void runRender(source, themeId)} disabled={rendering}>
					{rendering ? <LoaderCircle size={15} className="puml-spin" /> : <RefreshCw size={15} />}立即渲染
				</button>
				<button className="user-tool-button" type="button" onClick={() => {
					setSource("");
					setResult(null);
					setDiagram(null);
					textareaRef.current?.focus();
				}}><Trash2 size={15} />清空</button>
			</div>
		</div>

		{engine && !engine.available ? <p className="puml-banner" role="status">
			<CircleAlert size={15} />
			后端暂未启用本地渲染引擎{engine.jar.found ? "" : "（缺少 PlantUML jar）"}，可用 <code>pnpm --filter @jayson-blog/api puml:install</code> 安装，或配置 PUML_SERVER_URL 走远程渲染。
		</p> : null}

		<div className="puml-layout">
			<div className="puml-pane">
				<div className="puml-pane-head">
					<span>PUML 源码</span>
					<span className="puml-pane-meta">{lines} 行 · {source.length} 字符</span>
				</div>
				<div className="puml-editor">
					<pre className="puml-highlight" ref={highlightRef} aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlighted }} />
					<textarea
						ref={textareaRef}
						className="puml-textarea"
						value={source}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						placeholder={"@startuml\nAlice -> Bob: 你好\n@enduml"}
						onChange={(event) => setSource(event.target.value)}
						onScroll={syncScroll}
						onKeyDown={insertIndent}
					/>
				</div>
			</div>

			<div className="puml-pane">
				<div className="puml-pane-head">
					<span>预览{rendering ? <em className="puml-rendering"> · 渲染中</em> : null}</span>
					<div className="puml-zoom">
						<button type="button" aria-label="缩小" onClick={() => stepZoom(-0.2)}><ZoomOut size={14} /></button>
						<span>{zoomLabel}</span>
						<button type="button" aria-label="放大" onClick={() => stepZoom(0.2)}><ZoomIn size={14} /></button>
						{zoom === "fit" ? null : <button type="button" onClick={() => setZoom("fit")}>适应</button>}
						<button type="button" onClick={() => setZoom(1)}>100%</button>
					</div>
				</div>
				<div
					className={`puml-stage${background === "transparent" ? " is-transparent" : ""}${zoom === "fit" ? "" : " is-zoomed"}`}
					style={background === "transparent" ? undefined : { background: backgroundColor }}
				>
					{failed ? <div className="puml-error" role="alert">
						<strong><CircleAlert size={16} />渲染失败</strong>
						<p>{errorMessage}</p>
						{errorSnippet ? <pre>{errorSnippet}</pre> : null}
						{failed && result.error.hint ? <p className="puml-error-hint">{result.error.hint}</p> : null}
					</div> : null}
					{svgUrl ? <img
						className={`puml-diagram${failed || pending ? " is-stale" : ""}`}
						src={svgUrl}
						alt="PlantUML 渲染结果"
						style={zoom === "fit" || !diagram ? undefined : { width: `${Math.round(diagram.width * zoom)}px`, height: `${Math.round(diagram.height * zoom)}px` }}
						onClick={() => !failed && setLightbox(true)}
					/> : null}
					{!svgUrl && !failed ? <p className="puml-empty">{rendering ? "正在渲染…" : "粘贴代码后自动出图"}</p> : null}
				</div>
				<div className="puml-statusbar">
					<span>{diagram ? `${Math.round(diagram.width)} × ${Math.round(diagram.height)} px` : "—"}</span>
					<span>{pending ? "代码已修改，待渲染" : result && result.ok ? `${result.ms} ms${result.cached ? " · 缓存" : ""}` : "—"}</span>
					<span>{result && result.ok ? (result.engine === "local" ? "本地引擎" : "远程服务") : engine?.available ? "本地引擎就绪" : "等待渲染"}</span>
				</div>
				<div className="puml-pane-actions">
					<button className="user-tool-button primary" type="button" onClick={() => void handleCopyImage()} disabled={!diagram}>
						<Copy size={15} />复制图片
					</button>
					<button className="user-tool-button" type="button" onClick={() => void handleDownloadPng()} disabled={!diagram}>
						<ImageDown size={15} />下载 PNG
					</button>
					<button className="user-tool-button" type="button" onClick={handleDownloadSvg} disabled={!diagram}>
						<Download size={15} />下载 SVG
					</button>
					<button className="user-tool-button" type="button" onClick={() => void handleCopySvg()} disabled={!diagram}>
						<Copy size={15} />复制 SVG
					</button>
					<button className="user-tool-button" type="button" onClick={() => void handleCopySource()} disabled={!source}>
						<Copy size={15} />复制源码
					</button>
					<button className="user-tool-button" type="button" onClick={() => setLightbox(true)} disabled={!diagram}>
						<Maximize2 size={15} />全屏
					</button>
				</div>
			</div>
		</div>

		{notice ? <p className={`puml-notice is-${notice.tone}`} role="status">
			{notice.tone === "ok" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}
		</p> : null}

		<p className="puml-hint">
			键盘：Ctrl/⌘ + Enter 立即渲染；编辑器内 Tab 缩进两格。导出 PNG 默认 2 倍分辨率，适合贴到文档或公众号。
		</p>

		{lightbox && svgUrl ? <div className="puml-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setLightbox(false)}>
			<button className="puml-lightbox-close" type="button" aria-label="关闭" onClick={() => setLightbox(false)}><X size={18} /></button>
			<img src={svgUrl} alt="PlantUML 图片预览" style={{ ...(backgroundColor ? { background: backgroundColor } : {}), transform: `scale(${lightboxScale})` }} onClick={(event) => event.stopPropagation()} />
		</div> : null}
	</section>;
}
