import { Check, Copy, Eye, FileCode2, FileText, Link as LinkIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "./api";
import { clipboardLanguage, highlightedCode } from "./codeHighlight";
import type { ClipboardContentType } from "./types";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

type PublicClipboard = {
	title: string;
	content: string;
	contentType: ClipboardContentType;
	language: string;
	byteSize: number;
	viewCount: number;
	updatedAt: string;
};

const formatBytes = (n = 0) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

function typeLabel(type: ClipboardContentType, language?: string) {
	if (type === "markdown") return "Markdown";
	if (type === "code") return clipboardLanguage(language).label;
	return "纯文本";
}

export function ClipboardRenderedBody({ content, contentType, language }: { content: string; contentType: ClipboardContentType; language?: string }) {
	if (contentType === "markdown") {
		return <Suspense fallback={<div className="markdown-body" aria-busy="true" />}><MarkdownContent content={content} /></Suspense>;
	}
	if (contentType === "code") {
		const html = highlightedCode(content, language);
		const lines = Math.max(1, content.split("\n").length);
		return <div className="clipboard-code-frame">
			<div className="clipboard-code-gutter" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
			<pre className="clipboard-code"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
		</div>;
	}
	return <pre className="clipboard-plain">{content}</pre>;
}

export default function ClipboardSharePage() {
	const { token = "" } = useParams();
	const [item, setItem] = useState<PublicClipboard | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [copied, setCopied] = useState<"content" | "link" | "">("");
	const shareUrl = useMemo(() => token ? api.clipboardShareUrl(token) : "", [token]);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		setItem(null);
		if (!token) { setLoading(false); setError("分享链接无效"); return () => { active = false; }; }
		api.publicClipboard(token).then((payload) => {
			if (!active) return;
			if (payload?.type && payload.type !== "clipboard") { setError("这个链接不是公开剪贴板"); return; }
			setItem({
				title: String(payload.title || "未命名剪贴板"),
				content: String(payload.content ?? ""),
				contentType: payload.contentType === "markdown" || payload.contentType === "code" ? payload.contentType : "text",
				language: String(payload.language ?? ""),
				byteSize: Number(payload.byteSize ?? 0),
				viewCount: Number(payload.viewCount ?? 0),
				updatedAt: String(payload.updatedAt ?? ""),
			});
		}).catch((caught) => {
			if (active) setError(caught instanceof Error ? caught.message : "公开剪贴板不存在或已关闭");
		}).finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [token]);

	const copy = async (kind: "content" | "link") => {
		const value = kind === "link" ? shareUrl : item?.content ?? "";
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			setCopied(kind);
			window.setTimeout(() => setCopied(""), 1800);
		} catch {
			setCopied("");
		}
	};

	if (loading) return <section className="card content-card clipboard-share"><p className="page-lead">正在打开公开剪贴板...</p></section>;
	if (error || !item) return <section className="card empty-state clipboard-share"><FileText size={29} /><h2>无法打开这份剪贴板</h2><p>{error || "公开剪贴板不存在或已关闭。"}</p><Link to="/">返回首页</Link></section>;

	const updated = item.updatedAt.replace("T", " ").slice(0, 16);

	return <article className="card content-card clipboard-share">
		<header className="clipboard-share-header">
			<div>
				<span className="tool-eyebrow">PUBLIC CLIPBOARD</span>
				<h2>{item.title}</h2>
				<div className="clipboard-share-meta">
					<em>{typeLabel(item.contentType, item.language)}</em>
					<span>{formatBytes(item.byteSize)}</span>
					<span><Eye size={14} /> {item.viewCount} 次查看</span>
					{updated ? <time>{updated}</time> : null}
				</div>
			</div>
			<div className="clipboard-share-actions">
				<button type="button" className="user-tool-button" onClick={() => void copy("content")}>{copied === "content" ? <Check size={15} /> : <Copy size={15} />}{copied === "content" ? "已复制正文" : "复制正文"}</button>
				<button type="button" className="user-tool-button primary" onClick={() => void copy("link")}>{copied === "link" ? <Check size={15} /> : <LinkIcon size={15} />}{copied === "link" ? "链接已复制" : "复制链接"}</button>
			</div>
		</header>
		<div className={`clipboard-share-body is-${item.contentType}`}>
			{item.contentType === "code" ? <div className="clipboard-code-label"><FileCode2 size={15} />{clipboardLanguage(item.language).label}</div> : null}
			<ClipboardRenderedBody content={item.content} contentType={item.contentType} language={item.language} />
		</div>
		<footer className="clipboard-share-footer">由站内在线剪贴板分享 · 内容由作者提供</footer>
	</article>;
}
