import { AlertTriangle, Check, Copy, Eye, FileCode2, FileText, Info, KeyRound, Link as LinkIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PublicResourcePayload } from "./api";
import { clipboardLanguage, highlightedCode } from "./codeHighlight";
import type { ClipboardContentType } from "./types";

const MarkdownContent = lazy(() => import("./MarkdownContent"));

const DEFAULT_COOLDOWN_SECONDS = 24 * 60 * 60; // [329] 服务端未返回冷却时长时的兜底值

/* [324] remainingViews 为 null 时用 maxViews - viewCount 兜底，与横幅口径保持一致 */
function remainingViewsText(info: { remainingViews: number | null; maxViews: number; viewCount: number }) {
	const remaining = info.remainingViews ?? Math.max(0, info.maxViews - info.viewCount);
	return remaining;
}

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

function formatCooldownSeconds(seconds: number): string {
	if (seconds <= 0) return "0秒";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}小时${m.toString().padStart(2, "0")}分${s.toString().padStart(2, "0")}秒`;
	if (m > 0) return `${m}分${s.toString().padStart(2, "0")}秒`;
	return `${s}秒`;
}

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
		// [328] 高亮结果按内容缓存：重渲染（如复制提示变化）时不重复做全量分词
		const html = useMemo(() => highlightedCode(content, language), [content, language]);
		const lines = Math.max(1, content.split("\n").length);
		return <div className="clipboard-code-frame" onCopy={(event) => {
			const text = document.getSelection()?.toString();
			if (!text) return;
			event.preventDefault();
			event.clipboardData?.setData("text/plain", text);
		}}>
			<div className="clipboard-code-gutter" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
			<pre className="clipboard-code"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
		</div>;
	}
	return <pre className="clipboard-plain">{content}</pre>;
}

function clipboardFromPayload(payload: PublicResourcePayload): PublicClipboard {
	return {
		title: String(payload.title || "未命名剪贴板"),
		content: String(payload.content ?? ""),
		contentType: payload.contentType === "markdown" || payload.contentType === "code" ? payload.contentType : "text",
		language: String(payload.language ?? ""),
		byteSize: Number(payload.byteSize ?? 0),
		viewCount: Number(payload.viewCount ?? 0),
		updatedAt: String(payload.updatedAt ?? ""),
	};
}

export default function ClipboardSharePage() {
	const { token = "" } = useParams();
	const [item, setItem] = useState<PublicClipboard | null>(null);
	const [imageUrl, setImageUrl] = useState("");
	const [imageName, setImageName] = useState("图片");
	const [locked, setLocked] = useState(false);
	const [password, setPassword] = useState("");
	const [passwordHint, setPasswordHint] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [unlocking, setUnlocking] = useState(false);
	const [copied, setCopied] = useState<"content" | "link" | "">("");
	const [passwordProtected, setPasswordProtected] = useState(false);
	const [inCooldown, setInCooldown] = useState(false);
	const [cooldownSeconds, setCooldownSeconds] = useState(0);
	const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);
	const [limitInfo, setLimitInfo] = useState<{
		limitViews: boolean;
		maxViews: number;
		viewCount: number;
		remainingViews: number | null;
		expired: boolean;
	} | null>(null);
	const objectUrl = useRef("");

	// [321] 只让 updater 做纯计算：副作用放在单独的收尾 effect 里，避免每秒重建 interval
	const cooling = cooldownSeconds > 0;
	useEffect(() => {
		if (!cooling) return;
		const timer = window.setInterval(() => {
			setCooldownSeconds((prev) => (prev > 0 ? prev - 1 : 0));
		}, 1000);
		return () => clearInterval(timer);
	}, [cooling]);

	useEffect(() => {
		if (cooldownSeconds > 0) return;
		setInCooldown(false);
		if (inCooldown) setError("");
	}, [cooldownSeconds, inCooldown]);
	const shareUrl = useMemo(() => token ? api.clipboardShareUrl(token) : "", [token]);

	const releaseImage = () => {
		if (!objectUrl.current) return;
		URL.revokeObjectURL(objectUrl.current);
		objectUrl.current = "";
	};

	const showImage = (blob: Blob, name?: string, protectedImage = false) => {
		releaseImage();
		const url = URL.createObjectURL(blob);
		objectUrl.current = url;
		setImageUrl(url);
		setImageName(name || "图片");
		setItem(null);
		setLocked(false);
		setPasswordProtected(protectedImage);
	};

	useEffect(() => () => releaseImage(), []);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError("");
		setItem(null);
		setLocked(false);
		setPassword("");
		setPasswordHint("");
		setImageUrl("");
		setPasswordProtected(false);
		setLimitInfo(null);
		releaseImage();
		// [320] 链接（token）变化时必须重置门禁状态：上一个链接的冷却与剩余次数不能泄漏到新链接
		setInCooldown(false);
		setCooldownSeconds(0);
		setRemainingAttempts(null);
		setCopied("");
		if (!token) { setLoading(false); setError("分享链接无效"); return () => { active = false; }; }
		api.inspectPublicResource(token).then(async (result) => {
			if (!active) return;
			if (result.payload?.limitViews && typeof result.payload.maxViews === "number") {
				setLimitInfo({
					limitViews: true,
					maxViews: result.payload.maxViews,
					viewCount: result.payload.viewCount ?? 1,
					remainingViews: result.payload.remainingViews ?? null,
					expired: Boolean(result.payload.expired),
				});
			}
			if (result.payload?.locked) {
				setLocked(true);
				setPasswordHint(typeof result.payload.passwordHint === "string" ? result.payload.passwordHint : "");
				if (result.payload.inCooldown) {
					setInCooldown(true);
					setCooldownSeconds(result.payload.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS);
					setError(result.payload.error || "密码错误次数过多，已被限制访问 24 小时");
				} else if (result.payload.remainingAttempts !== undefined && result.payload.remainingAttempts < 3) {
					setRemainingAttempts(result.payload.remainingAttempts);
				}
				return;
			}
			if (result.blob) { showImage(result.blob, result.payload?.name); return; }
			if (!result.payload || result.status < 200 || result.status >= 300) {
				setError(result.payload?.error || "公开内容不存在或已关闭");
				return;
			}
			if (result.payload.type === "image") {
				const file = await api.publicResourceFile(token, result.payload.accessGrant || "");
				if (active) showImage(file, result.payload.name, Boolean(result.payload.hasAccessPassword));
				return;
			}
			if (result.payload.type && result.payload.type !== "clipboard") { setError("这个链接不是公开内容"); return; }
			setItem(clipboardFromPayload(result.payload));
		}).catch((caught) => {
			if (active) setError(caught instanceof Error ? caught.message : "公开内容不存在或已关闭");
		}).finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [token]);

	const unlock = async (event: FormEvent) => {
		event.preventDefault();
		if (!token) return;
		setUnlocking(true);
		setError("");
		try {
			const payload = await api.unlockPublicResource(token, password);
			/* [322] 图片类型允许 content 为空（后面用 accessGrant 拉文件），其余类型必须有正文；
			   用括号写清 && 与 || 的结合顺序，避免后续维护改错 */
			if (payload.locked || (payload.content === undefined && payload.type !== "image")) {
				setLocked(true);
				setItem(null);
				setError(payload.error || "需要访问密码");
				return;
			}
			if (payload.limitViews && typeof payload.maxViews === "number") {
				setLimitInfo({
					limitViews: true,
					maxViews: payload.maxViews,
					viewCount: payload.viewCount ?? 1,
					remainingViews: payload.remainingViews ?? null,
					expired: Boolean(payload.expired),
				});
			}
			if (payload.type === "image") {
				/* [323] accessGrant 缺失或文件拉取失败不是“密码错误”：抛出带标记的错误，
				   catch 里据此走独立的失败提示，而不是把密码门重新弹回来误导用户 */
				if (!payload.accessGrant) {
					const failure = new Error("图片授权数据缺失，请刷新页面后重试") as Error & { isResourceError?: boolean };
					failure.isResourceError = true;
					throw failure;
				}
				const file = await api.publicResourceFile(token, payload.accessGrant);
				showImage(file, payload.name, true);
				return;
			}
			setItem(clipboardFromPayload(payload));
			setLocked(false);
			setPasswordProtected(Boolean(payload.hasAccessPassword));
		} catch (caught: unknown) {
			// [323] 资源加载失败（非密码问题）单独提示，不重置密码门状态
			if ((caught as { isResourceError?: boolean })?.isResourceError) {
				setImageUrl("");
				releaseImage();
				setError(caught instanceof Error ? caught.message : "资源加载失败");
				return;
			}
			setLocked(true);
			setItem(null);
			setImageUrl("");
			releaseImage();
			const payload = (caught as { payload?: PublicResourcePayload })?.payload;
			const status = (caught as { status?: number })?.status;
			if (payload?.inCooldown || status === 429) {
				setInCooldown(true);
				setCooldownSeconds(payload?.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS);
				setError(payload?.error || (caught instanceof Error ? caught.message : "密码错误已达 3 次上限，进入 24 小时冷却期"));
			} else if (payload?.remainingAttempts !== undefined) {
				setRemainingAttempts(payload.remainingAttempts);
				setError(payload.error || `密码不正确，还剩 ${payload.remainingAttempts} 次尝试机会`);
			} else {
				setError(caught instanceof Error ? caught.message : "访问密码不正确");
			}
		} finally {
			setUnlocking(false);
		}
	};

	/* [326] 错误提示的附加内容：冷却中显示倒计时，未冷却且快到 3 次时显示提醒；
	   [327] 内联 style 移到组件内样式对象，颜色/间距集中管理 */
	const attemptHintStyle = { color: "var(--muted-text)", marginTop: "0.2rem" } as const;
	let errorHint: ReactNode = null;
	if (inCooldown) {
		errorHint = (
			<strong className="cooldown-countdown">
				冷却倒计时：{formatCooldownSeconds(cooldownSeconds)}
			</strong>
		);
	} else if (remainingAttempts !== null && remainingAttempts < 3) {
		errorHint = (
			<small style={attemptHintStyle}>
				注意：连续失败 3 次将自动锁定设备与网络 24 小时。
			</small>
		);
	}
	/* [325] 图片分支与文本分支的限额横幅完全相同，抽成一个渲染函数避免两处文案漂移 */
	const renderLimitBanner = () => {
		if (!limitInfo) return null;
		return (
			<div className={`share-view-limit-banner ${limitInfo.expired ? "expired" : ""}`}>
				{limitInfo.expired ? <AlertTriangle size={16} /> : <Eye size={16} />}
				<span>
					{limitInfo.expired
						? `本次为最后一次有效查看（第 ${limitInfo.viewCount} 次，上限 ${limitInfo.maxViews} 次），该分享链接现已自动失效并转为私密状态。`
						: `此分享限制查看次数：共限制 ${limitInfo.maxViews} 次，本次为第 ${limitInfo.viewCount} 次，剩余还可查看 ${remainingViewsText(limitInfo)} 次。`}
				</span>
			</div>
		);
	};
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

	if (loading) return <section className="card content-card clipboard-share"><p className="page-lead">正在打开分享内容...</p></section>;
	if (locked && !item && !imageUrl) return <section className="card content-card clipboard-share">
		<form className="access-gate" onSubmit={(event) => void unlock(event)}>
			<KeyRound size={28} />
			<h2>需要访问密码</h2>
			<p>只有输入正确的密码才能看到内容。若连续输错 3 次，将进入 24 小时严格冷却期。</p>
			{passwordHint ? (
				<div className="access-gate-hint">
					<Info size={15} />
					<span>密码提示：{passwordHint}</span>
				</div>
			) : null}
			<input
				type="password"
				value={password}
				maxLength={64}
				autoComplete="off"
				disabled={inCooldown || unlocking}
				placeholder={passwordHint ? `提示：${passwordHint}` : "访问密码"}
				title={passwordHint || undefined}
				onChange={(event) => setPassword(event.target.value)}
			/>
			<button
				className="user-tool-button primary"
				type="submit"
				disabled={unlocking || inCooldown || !password}
			>
				{unlocking ? "正在验证..." : "查看内容"}
			</button>
			{error ? (
				<div className={`user-tool-error ${inCooldown ? "access-gate-cooldown" : ""}`}>
					<span>{error}</span>
					{/* [326] 嵌套三元拆成顺序 if：先判冷却，再判剩余次数提示 */}
					{errorHint}
				</div>
			) : null}
		</form>
	</section>;
	if (imageUrl) return <article className="card content-card clipboard-share">
		<header className="clipboard-share-header">
			<div>
				<span className="tool-eyebrow">SHARED IMAGE</span>
				<h2>{imageName}</h2>
			</div>
			<div className="clipboard-share-actions">
				<button type="button" className="user-tool-button primary" onClick={() => void copy("link")}>
					{copied === "link" ? <Check size={15} /> : <LinkIcon size={15} />}
					{copied === "link" ? "链接已复制" : "复制链接"}
				</button>
			</div>
		</header>
		{renderLimitBanner()}

		<img className="clipboard-share-image" src={imageUrl} alt={imageName} />
		<footer className="clipboard-share-footer">{passwordProtected ? "由站内图床分享 · 刷新后需要重新输入访问密码" : "由站内图床分享"}</footer>
	</article>;
	if (error || !item) return <section className="card empty-state clipboard-share">
		<FileText size={29} />
		<h2>无法打开分享内容</h2>
		<p>{error || "公开内容不存在或已关闭。"}</p>
		<p className="share-expire-hint">
			若该内容此前设置了查看次数限制，可能已达到设定的最大查看次数并自动转为私密。请联系发布者重新生成分享链接。
		</p>
		<Link to="/">返回首页</Link>
	</section>;

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
					{limitInfo ? (
						<span className={`post-badge ${limitInfo.expired ? "post-badge-lock" : "post-badge-limit"}`}>
							{limitInfo.expired ? "已达上限失效" : `限${limitInfo.maxViews}次 (剩${remainingViewsText(limitInfo)}次)`}
						</span>
					) : null}
					{updated ? <time>{updated}</time> : null}
				</div>
			</div>
			<div className="clipboard-share-actions">
				<button type="button" className="user-tool-button" onClick={() => void copy("content")}>{copied === "content" ? <Check size={15} /> : <Copy size={15} />}{copied === "content" ? "已复制正文" : "复制正文"}</button>
				<button type="button" className="user-tool-button primary" onClick={() => void copy("link")}>{copied === "link" ? <Check size={15} /> : <LinkIcon size={15} />}{copied === "link" ? "链接已复制" : "复制链接"}</button>
			</div>
		</header>
		{renderLimitBanner()}

		<div className={`clipboard-share-body is-${item.contentType}`}>
			{item.contentType === "code" ? <div className="clipboard-code-label"><FileCode2 size={15} />{clipboardLanguage(item.language).label}</div> : null}
			<ClipboardRenderedBody content={item.content} contentType={item.contentType} language={item.language} />
		</div>
		<footer className="clipboard-share-footer">由站内在线剪贴板分享 · 内容由作者提供</footer>
	</article>;
}
