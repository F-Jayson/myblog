import { Code2, Copy, Eye, FileCode2, FileImage, FileText, Gamepad2, Highlighter, KeyRound, Link as LinkIcon, Pencil, Save, Trash2, Upload, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { AuthImage } from "./AuthImage";
import { useAuth, UserAvatar } from "./auth";
import { CLIPBOARD_LANGUAGES } from "./codeHighlight";
import { ClipboardRenderedBody } from "./ClipboardSharePage";
import type { ClipboardContentType, FeatureSettings, UserClipboard, UserSpaceStats, UserStorageItem } from "./types";

function RequireLogin({ children, feature, requires, featureLabel = "该功能" }: { children: ReactNode; feature?: keyof FeatureSettings; requires?: Array<keyof FeatureSettings>; featureLabel?: string }) {
 const { user, loading, openAuth, features } = useAuth();
 if (loading) return <section className="card content-card user-tool-page"><p>正在检查登录状态...</p></section>;
 const requiredFeatures = requires ?? (feature ? [feature] : []);
 if (requiredFeatures.some((key) => !features[key])) return <section className="card content-card user-tool-page auth-required"><UserRound size={30}/><h2>{featureLabel}暂未开放</h2><p>管理员暂时关闭了这项功能，请稍后再试。</p></section>;
 if (!user) return <section className="card content-card user-tool-page auth-required"><UserRound size={30}/><h2>登录后使用小工具</h2><p>图床、在线剪贴板和空间管理仅对已登录用户开放。</p><button className="user-tool-button primary" type="button" onClick={() => openAuth("login")}>登录 / 注册</button></section>;
 return <>{children}</>;
}

const formatBytes = (n = 0) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
const publicUrl = (token?: string | null) => token ? api.publicResourceUrl(token) : "";
const storagePreviewUrl = (item: UserStorageItem) => item.storageKey ? `/api/user/storage/${encodeURIComponent(String(item.id))}/file` : item.url || "";
const SPACE_CATEGORY_LABELS: Record<string, string> = {
	images: "全部图片",
	imageHost: "图床",
	commentImages: "评论图片",
	avatars: "头像",
	clipboards: "在线剪贴板",
	stickers: "表情包",
};
const SPACE_CATEGORY_ORDER = ["images", "imageHost", "commentImages", "avatars", "clipboards", "stickers"];
function spaceCategoryEntries(categories: Record<string, number> = {}) {
	const keys = [...SPACE_CATEGORY_ORDER.filter((key) => key in categories), ...Object.keys(categories).filter((key) => !SPACE_CATEGORY_ORDER.includes(key))];
	return keys.map((key) => [key, Number(categories[key] ?? 0)] as const);
}

function passwordProblem(value: string) {
	if (!value) return "";
	if (value.length < 4) return "访问密码至少 4 位";
	if (value.length > 64) return "访问密码不能超过 64 位";
	return "";
}

function hintProblem(hint: string, password: string) {
	const text = hint.trim();
	if (!text) return "";
	if (text.length > 40) return "密码提示不能超过 40 字";
	if (password && text.includes(password)) return "密码提示不能包含密码";
	return "";
}

function imageShareLink(item: UserStorageItem, canPublish: boolean) {
	if (!item.isPublic || !item.publicToken || !canPublish) return "";
	return item.hasAccessPassword ? api.clipboardShareUrl(item.publicToken) : publicUrl(item.publicToken);
}

export function ImageHostPage() {
	const { user, loading: authLoading, features } = useAuth();
	const [items, setItems] = useState<UserStorageItem[]>([]);
	const [space, setSpace] = useState<UserSpaceStats | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [uploadPassword, setUploadPassword] = useState("");
	const [uploadHint, setUploadHint] = useState("");
	const [passwordFor, setPasswordFor] = useState("");
	const [passwordDraft, setPasswordDraft] = useState("");
	const [hintDraft, setHintDraft] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const allowed = Boolean(user && !authLoading && features.userCenterEnabled && features.imageHostingEnabled);
	const canPublish = features.publicResourcesEnabled;
	const load = useCallback(async () => {
		try {
			const [list, stats] = await Promise.all([api.userStorage(), api.userSpace()]);
			setItems(list);
			setSpace(stats);
		} catch (e) {
			setError(e instanceof Error ? e.message : "加载失败");
		}
	}, []);
	useEffect(() => {
		if (!allowed) {
			setItems([]);
			setSpace(null);
			if (!authLoading) setError("");
			return;
		}
		setError("");
		void load();
	}, [allowed, authLoading, load]);
	const upload = async (file?: File) => {
		if (!file) return;
		if (!file.type.startsWith("image/")) { setError("请选择图片文件"); return; }
		const invalidPassword = passwordProblem(uploadPassword);
		if (invalidPassword) { setError(invalidPassword); return; }
		const invalidHint = hintProblem(uploadHint, uploadPassword);
		if (invalidHint) { setError(invalidHint); return; }
		if (uploadHint.trim() && !uploadPassword) { setError("请先设置访问密码"); return; }
		setBusy(true);
		setError("");
		try {
			await api.uploadUserStorage(file, file.name, true, uploadPassword || undefined, uploadHint.trim() || undefined);
			setUploadPassword("");
			setUploadHint("");
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "上传失败");
		} finally {
			setBusy(false);
		}
	};
	const togglePublic = async (item: UserStorageItem) => {
		const next = !item.isPublic;
		if (next && !canPublish) { setError("公开资源访问当前已关闭"); return; }
		try {
			await api.updateUserStorage(item.id, { isPublic: next });
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "公开状态更新失败");
		}
	};
	const remove = async (item: UserStorageItem) => {
		try {
			await api.deleteUserStorage(item.id);
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "删除失败");
		}
	};
	const saveImagePassword = async (item: UserStorageItem, clear: boolean) => {
		const hint = hintDraft.trim();
		const invalidPassword = clear ? "" : passwordProblem(passwordDraft);
		const invalidHint = clear ? "" : hintProblem(hint, passwordDraft);
		if (invalidPassword) { setError(invalidPassword); return; }
		if (invalidHint) { setError(invalidHint); return; }
		if (!clear && !passwordDraft && !item.hasAccessPassword) { setError(hint ? "请先设置访问密码" : "请输入访问密码"); return; }
		setError("");
		try {
			if (clear) await api.updateUserStorage(item.id, { clearAccessPassword: true });
			else if (passwordDraft) await api.updateUserStorage(item.id, { accessPassword: passwordDraft, accessPasswordHint: hint });
			else await api.updateUserStorage(item.id, { accessPasswordHint: hint });
			setPasswordDraft("");
			setHintDraft("");
			setPasswordFor("");
			await load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "访问密码更新失败");
		}
	};
	return <RequireLogin requires={["userCenterEnabled", "imageHostingEnabled"]} featureLabel="图床"><section className="card content-card user-tool-page"><header className="user-tool-heading"><div><span className="tool-eyebrow">USER TOOLS</span><h2><FileImage size={22}/> 图床</h2><p>图片与头像等数据共享 30MB 用户空间。新上传默认公开。设置访问密码后，别人必须输入正确密码才能看到图片。</p></div><Link to="/user/space" className="user-tool-link">空间管理</Link></header>{space ? <SpaceBar stats={space}/> : null}<div className="tool-upload"><input ref={fileRef} hidden type="file" accept="image/*" onChange={e => { void upload(e.target.files?.[0]); e.currentTarget.value=""; }}/><label className="tool-password-field">访问密码<input type="password" value={uploadPassword} maxLength={64} autoComplete="new-password" placeholder={uploadHint.trim() || "可选，至少 4 位"} title={uploadHint.trim() || undefined} onChange={(event) => setUploadPassword(event.target.value)} /></label><label className="tool-password-field">密码提示<input type="text" value={uploadHint} maxLength={40} autoComplete="off" placeholder="可选，显示在密码框中" onChange={(event) => setUploadHint(event.target.value)} /></label><button type="button" className="user-tool-button primary" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={16}/> {busy ? "上传中..." : "选择图片上传"}</button></div>{error ? <p className="user-tool-error">{error}</p> : null}<div className="tool-list">{items.length ? items.map(item => { const link = imageShareLink(item, canPublish); const preview = storagePreviewUrl(item); const editingPassword = passwordFor === String(item.id); return <article className="tool-item" key={item.id}><div className="tool-item-preview">{preview ? <AuthImage src={preview} alt={item.name || "图片"} fallback={<FileImage/>} /> : <FileImage/>}</div><div className="tool-item-main"><strong>{item.name || "未命名图片"}</strong><small>{formatBytes(item.sizeBytes)} · <Eye size={13}/> {item.accessCount ?? 0} 次查看 · {item.isPublic ? canPublish ? "公开" : "公开（暂时不可访问）" : "私有"}{item.hasAccessPassword ? <em className="tool-lock-mark">已设置访问密码</em> : null}</small>{link ? <div className="tool-public-link"><input readOnly value={link} /></div> : null}{editingPassword ? <div className="tool-password-row"><input type="password" value={passwordDraft} maxLength={64} autoComplete="new-password" placeholder={hintDraft.trim() || (item.hasAccessPassword ? "输入新的访问密码" : "设置访问密码")} title={hintDraft.trim() || undefined} onChange={(event) => setPasswordDraft(event.target.value)} /><input type="text" value={hintDraft} maxLength={40} autoComplete="off" placeholder="密码提示，可选" aria-label="密码提示" onChange={(event) => setHintDraft(event.target.value)} /><button type="button" className="user-tool-button" onClick={() => void saveImagePassword(item, false)}>保存</button>{item.hasAccessPassword ? <button type="button" className="user-tool-button" onClick={() => void saveImagePassword(item, true)}>清除</button> : null}</div> : null}</div><div className="tool-item-actions"><button type="button" title={link ? "复制公开链接" : "公开后可复制链接"} disabled={!link} onClick={() => { if (link) void navigator.clipboard?.writeText(link); }}><Copy size={15}/></button><button type="button" title="访问密码" onClick={() => { if (editingPassword) { setPasswordFor(""); setPasswordDraft(""); setHintDraft(""); } else { setPasswordFor(String(item.id)); setPasswordDraft(""); setHintDraft(item.accessPasswordHint ?? ""); } }}><KeyRound size={15}/></button><button type="button" title={!canPublish && !item.isPublic ? "公开访问已关闭" : item.isPublic ? "设为私有" : "公开访问"} disabled={!canPublish && !item.isPublic} onClick={() => void togglePublic(item)}><LinkIcon size={15}/></button><button type="button" title="删除" onClick={() => void remove(item)}><Trash2 size={15}/></button></div></article>; }) : <p className="tool-empty">还没有上传图片。</p>}</div></section></RequireLogin>;
}

function SpaceBar({ stats }: { stats: UserSpaceStats }) { const percent = Math.min(100, stats.limitBytes ? stats.usedBytes / stats.limitBytes * 100 : 0); return <div className="space-summary"><div><strong>{formatBytes(stats.usedBytes)}</strong><span> / {formatBytes(stats.limitBytes)} 已使用</span></div><div className="space-progress"><i style={{ width: `${percent}%` }}/></div><small>剩余 {formatBytes(stats.remainingBytes)}</small></div>; }

const CLIPBOARD_TYPES: Array<{ key: ClipboardContentType; label: string; icon: typeof FileText; hint: string }> = [
	{ key: "text", label: "纯文本", icon: FileText, hint: "按原样保存，适合备忘和短消息。" },
	{ key: "markdown", label: "Markdown", icon: FileCode2, hint: "分享页会渲染标题、列表、链接和图片。" },
	{ key: "code", label: "代码", icon: Code2, hint: "按语言高亮显示，适合片段和配置。" },
];

function clipboardTypeLabel(item: UserClipboard) {
	if (item.contentType === "markdown") return "Markdown";
	if (item.contentType === "code") return CLIPBOARD_LANGUAGES.find((language) => language.key === item.language)?.label || "代码";
	return "纯文本";
}

export function ClipboardPage() {
	const { user, loading: authLoading, features } = useAuth();
	const [items, setItems] = useState<UserClipboard[]>([]);
	const [editing, setEditing] = useState<UserClipboard | null>(null);
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [contentType, setContentType] = useState<ClipboardContentType>("text");
	const [language, setLanguage] = useState("javascript");
	const [preview, setPreview] = useState(false);
	const [accessPassword, setAccessPassword] = useState("");
	const [accessPasswordHint, setAccessPasswordHint] = useState("");
	const [clearAccessPassword, setClearAccessPassword] = useState(false);
	const [error, setError] = useState("");
	const allowed = Boolean(user && !authLoading && features.userCenterEnabled && features.clipboardEnabled);
	const canPublish = features.publicResourcesEnabled;
	const load = useCallback(async () => {
		try { setItems(await api.userClipboards()); }
		catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
	}, []);
	useEffect(() => {
		if (!allowed) {
			setItems([]);
			if (!authLoading) setError("");
			return;
		}
		setError("");
		void load();
	}, [allowed, authLoading, load]);
	const resetForm = () => {
		setEditing(null);
		setTitle("");
		setContent("");
		setContentType("text");
		setLanguage("javascript");
		setPreview(false);
		setAccessPassword("");
		setAccessPasswordHint("");
		setClearAccessPassword(false);
	};
	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!title.trim() || !content.trim()) return;
		const hint = accessPasswordHint.trim();
		const invalidPassword = passwordProblem(accessPassword);
		if (invalidPassword) { setError(invalidPassword); return; }
		const invalidHint = hintProblem(hint, accessPassword);
		if (invalidHint) { setError(invalidHint); return; }
		if (hint && !accessPassword && !(editing?.hasAccessPassword && !clearAccessPassword)) { setError("请先设置访问密码"); return; }
		try {
			const payload = { title, content, contentType, language: contentType === "code" ? language : "" };
			if (editing) {
				const update: { title: string; content: string; contentType: ClipboardContentType; language: string; accessPassword?: string; accessPasswordHint?: string; clearAccessPassword?: boolean } = payload;
				if (clearAccessPassword && !accessPassword) update.clearAccessPassword = true;
				else {
					if (accessPassword) update.accessPassword = accessPassword;
					update.accessPasswordHint = hint;
				}
				await api.updateClipboard(editing.id, update);
			} else await api.createClipboard({ ...payload, isPublic: true, ...(accessPassword ? { accessPassword, ...(hint ? { accessPasswordHint: hint } : {}) } : {}) });
			resetForm();
			await load();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "保存失败");
		}
	};
	const togglePublic = async (item: UserClipboard) => {
		const next = !item.isPublic;
		if (next && !canPublish) { setError("公开资源访问当前已关闭"); return; }
		try {
			await api.updateClipboard(item.id, { isPublic: next });
			await load();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "公开状态更新失败");
		}
	};
	const remove = async (item: UserClipboard) => {
		try {
			await api.deleteClipboard(item.id);
			await load();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "删除失败");
		}
	};
	const placeholder = contentType === "markdown" ? "输入 Markdown 内容，例如 ## 标题" : contentType === "code" ? "粘贴代码片段" : "输入纯文本内容";
	return <RequireLogin requires={["userCenterEnabled", "clipboardEnabled"]} featureLabel="在线剪贴板">
		<section className="card content-card user-tool-page">
			<header className="user-tool-heading">
				<div>
					<span className="tool-eyebrow">USER TOOLS</span>
					<h2>在线剪贴板</h2>
					<p>可选择纯文本、Markdown 或代码。新建默认公开。设置访问密码后，分享页必须输入正确密码才能看到内容。</p>
				</div>
				<Link to="/user/space" className="user-tool-link">空间管理</Link>
			</header>
			<form className="clipboard-editor" onSubmit={submit}>
				<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" maxLength={120} />
				<div className="clipboard-type-switch" role="group" aria-label="文本类型">
					{CLIPBOARD_TYPES.map((item) => {
						const Icon = item.icon;
						return <button type="button" key={item.key} className={contentType === item.key ? "selected" : ""} onClick={() => setContentType(item.key)}>
							<Icon size={15} />{item.label}
						</button>;
					})}
				</div>
				<p className="clipboard-type-hint">{CLIPBOARD_TYPES.find((item) => item.key === contentType)?.hint}</p>
				{contentType === "code" ? <label className="clipboard-language-field">代码语言
					<select value={language} onChange={(event) => setLanguage(event.target.value)}>
						{CLIPBOARD_LANGUAGES.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}
					</select>
				</label> : null}
				{contentType !== "text" ? <div className="clipboard-preview-toggle"><button type="button" className={!preview ? "selected" : ""} onClick={() => setPreview(false)}>编辑</button><button type="button" className={preview ? "selected" : ""} onClick={() => setPreview(true)}>预览</button></div> : null}
				{preview && contentType !== "text" ? <div className="clipboard-live-preview"><ClipboardRenderedBody content={content || "暂无内容"} contentType={contentType} language={language} /></div> : <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={placeholder} rows={10} />}
				<label className="tool-password-field">访问密码
					<input type="password" value={accessPassword} maxLength={64} autoComplete="new-password" placeholder={accessPasswordHint.trim() || (editing?.hasAccessPassword ? "留空表示保持当前密码" : "可选，至少 4 位")} title={accessPasswordHint.trim() || undefined} onChange={(event) => { setAccessPassword(event.target.value); if (event.target.value) setClearAccessPassword(false); }} />
				</label>
				<label className="tool-password-field">密码提示
					<input type="text" value={accessPasswordHint} maxLength={40} autoComplete="off" placeholder="可选，会显示在密码输入框里" disabled={clearAccessPassword} onChange={(event) => setAccessPasswordHint(event.target.value)} />
				</label>
				{editing?.hasAccessPassword ? <label className="tool-check"><input type="checkbox" checked={clearAccessPassword} onChange={(event) => { setClearAccessPassword(event.target.checked); if (event.target.checked) setAccessPassword(""); }} />清除访问密码</label> : null}
				<p className="clipboard-type-hint">{editing?.hasAccessPassword && !clearAccessPassword ? "当前已设置访问密码。留空表示保持不变。密码提示会显示在密码框里。" : "设置后，没有正确密码就看不到正文。密码提示会显示在密码框里。"}</p>
				<div className="tool-form-row">
					<button className="user-tool-button primary" type="submit"><Save size={16} /> {editing ? "更新剪贴板" : "保存剪贴板"}</button>
					{editing ? <button className="user-tool-button" type="button" onClick={resetForm}>取消</button> : null}
				</div>
			</form>
			{error ? <p className="user-tool-error">{error}</p> : null}
			<div className="tool-list">{items.length ? items.map((item) => {
				const snippet = item.content ?? "";
				const link = item.isPublic && item.publicToken && canPublish ? api.clipboardShareUrl(item.publicToken) : "";
				return <article className="tool-item clipboard-item" key={item.id}>
					<div className="tool-item-main">
						<strong>{item.title}</strong>
						<small><em>{clipboardTypeLabel(item)}</em> · {formatBytes(item.sizeBytes)} · <Eye size={13} /> {item.accessCount ?? 0} 次查看 · {item.isPublic ? canPublish ? "公开" : "公开（暂时不可访问）" : "私有"}{item.hasAccessPassword ? <em className="tool-lock-mark">已设置访问密码</em> : null}</small>
						<pre>{snippet.slice(0, 220)}{snippet.length > 220 ? "…" : ""}</pre>
						{link ? <div className="tool-public-link"><input readOnly value={link} /><Link to={`/share/${encodeURIComponent(item.publicToken ?? "")}`} className="user-tool-link" target="_blank" rel="noreferrer">预览</Link></div> : null}
					</div>
					<div className="tool-item-actions">
						<button type="button" title={link ? "复制公开链接" : "公开后可复制链接"} disabled={!link} onClick={() => { if (link) void navigator.clipboard?.writeText(link); }}><Copy size={15} /></button>
						<button type="button" title="编辑" onClick={() => { setEditing(item); setTitle(item.title); setContent(item.content ?? ""); setContentType(item.contentType === "markdown" || item.contentType === "code" ? item.contentType : "text"); setLanguage(item.language || "javascript"); setPreview(false); setAccessPassword(""); setAccessPasswordHint(item.accessPasswordHint ?? ""); setClearAccessPassword(false); }}><Pencil size={15} /></button>
						<button type="button" title={!canPublish && !item.isPublic ? "公开访问已关闭" : item.isPublic ? "设为私有" : "公开访问"} disabled={!canPublish && !item.isPublic} onClick={() => void togglePublic(item)}><LinkIcon size={15} /></button>
						<button type="button" title="删除" onClick={() => void remove(item)}><Trash2 size={15} /></button>
					</div>
				</article>;
			}) : <p className="tool-empty">还没有剪贴板记录。</p>}</div>
		</section>
	</RequireLogin>;
}

export function UserProfilePage() {
 const { user, settings, refresh } = useAuth(); const [form, setForm] = useState({ nickname: user?.nickname || user?.displayName || "", account: user?.account || user?.username || "", email: user?.email || "", avatar: user?.avatar || "", password: "", code: "", currentPassword: "" }); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const [codeBusy, setCodeBusy] = useState(false);
 useEffect(() => { setForm(f => ({ ...f, nickname: user?.nickname || user?.displayName || "", account: user?.account || user?.username || "", email: user?.email || "", avatar: user?.avatar || "" })); }, [user]);
 const save = async (e: FormEvent) => { e.preventDefault(); const currentAccount = user?.account || user?.username || ""; const currentEmail = user?.email || ""; const accountChanged = form.account.trim() !== currentAccount; const emailChanged = form.email.trim() !== currentEmail; const sensitive = accountChanged || emailChanged || Boolean(form.password); setBusy(true); setMessage(""); try { const payload: Record<string, unknown> = { nickname: form.nickname, avatar: form.avatar }; if (accountChanged) payload.account = form.account.trim(); if (emailChanged) payload.email = form.email.trim(); if (form.password) { payload.password = form.password; payload.currentPassword = form.currentPassword; } if (sensitive && settings.emailRegistrationEnabled) payload.emailCode = form.code.trim(); await api.updateUserProfile(payload); await refresh(); setForm((value) => ({ ...value, password: "", code: "", currentPassword: "" })); setMessage("资料已更新"); } catch (e) { setMessage(e instanceof Error ? e.message : "更新失败"); } finally { setBusy(false); } };
 return <RequireLogin feature="userCenterEnabled" featureLabel="用户中心"><section className="card content-card user-tool-page"><header className="user-tool-heading"><div><span className="tool-eyebrow">ACCOUNT</span><h2>用户中心</h2><p>管理头像、昵称、账号、邮箱与密码。</p></div><UserAvatar user={user!} size={48}/></header><form className="profile-form" onSubmit={save}><label>昵称<input value={form.nickname} onChange={e => setForm({ ...form, nickname: e.target.value })}/></label><label>账号<input value={form.account} onChange={e => setForm({ ...form, account: e.target.value })}/></label><label>邮箱<input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}/></label><label>头像地址<input value={form.avatar} onChange={e => setForm({ ...form, avatar: e.target.value })} placeholder="可填写公开图片地址"/></label><label>当前密码<input type="password" value={form.currentPassword} onChange={e => setForm({ ...form, currentPassword: e.target.value })} placeholder="修改密码时必填"/></label><label>新密码<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="留空表示不修改"/></label><label>邮箱验证码<div className="profile-code-row"><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="修改敏感资料时填写"/><button type="button" className="user-tool-button" disabled={codeBusy || !form.email.trim()} onClick={async () => { setCodeBusy(true); setMessage(""); try { const result = await api.userProfileEmailCode(form.email.trim()); setMessage(result.debugCode ? `验证码已发送：${result.debugCode}` : "验证码已发送，请查收邮箱"); } catch (e) { setMessage(e instanceof Error ? e.message : "验证码发送失败"); } finally { setCodeBusy(false); } }}>{codeBusy ? "发送中..." : "发送验证码"}</button></div></label>{message ? <p className="user-tool-message">{message}</p> : null}<button className="user-tool-button primary" disabled={busy} type="submit"><Save size={16}/>保存资料</button></form><p className="profile-code-hint"><KeyRound size={14}/>开启邮箱验证码后，修改账号、邮箱或密码需要验证当前邮箱。</p></section></RequireLogin>;
}

export function UserSpacePage() {
	const { user, loading: authLoading, features } = useAuth();
	const [stats, setStats] = useState<UserSpaceStats | null>(null);
	const allowed = Boolean(user && !authLoading && features.userCenterEnabled);
	const load = useCallback(async () => {
		try { setStats(await api.userSpace()); }
		catch { setStats(null); }
	}, []);
	useEffect(() => {
		if (!allowed) { setStats(null); return; }
		void load();
	}, [allowed, load]);
	return <RequireLogin feature="userCenterEnabled" featureLabel="空间管理"><section className="card content-card user-tool-page"><header className="user-tool-heading"><div><span className="tool-eyebrow">STORAGE</span><h2>空间管理</h2><p>图片、头像、评论图片、表情包与剪贴板共享 30MB。</p></div></header>{stats ? <><SpaceBar stats={stats}/><div className="space-categories">{spaceCategoryEntries(stats.categories).map(([name, bytes]) => <div key={name}><span>{SPACE_CATEGORY_LABELS[name] ?? name}</span><strong>{formatBytes(bytes)}</strong></div>)}</div></> : <p>正在加载空间信息...</p>}<nav className="space-shortcuts"><Link to="/tools/highlight"><Highlighter size={17}/>代码高亮</Link>{features.gamesEnabled ? <Link to="/tools/games"><Gamepad2 size={17}/>小游戏</Link> : null}{features.compilerEnabled ? <Link to="/tools/compiler"><Code2 size={17}/>在线编译器</Link> : null}{features.imageHostingEnabled ? <Link to="/tools/image-host"><FileImage size={17}/>管理图床</Link> : null}{features.clipboardEnabled ? <Link to="/tools/clipboard"><Copy size={17}/>管理剪贴板</Link> : null}<Link to="/user/center"><UserRound size={17}/>用户资料</Link></nav></section></RequireLogin>;
}
