import { Camera, Check, ImagePlus, KeyRound, LogIn, LogOut, Mail, UserRound, X } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { resolveMediaUrl } from "./media";
import type { CommentSettings, FeatureSettings, PublicUser } from "./types";

type AuthMode = "login" | "register";

type AuthContextValue = {
	user: PublicUser | null;
	loading: boolean;
	settings: CommentSettings;
	features: FeatureSettings;
	openAuth: (mode?: AuthMode) => void;
	closeAuth: () => void;
	login: (username: string, password: string) => Promise<PublicUser>;
	register: (input: { username: string; nickname: string; password: string; email?: string; emailCode?: string; avatar?: string }) => Promise<PublicUser>;
	logout: () => Promise<void>;
	refresh: () => Promise<void>;
};

const defaultSettings: CommentSettings = {
	commentsEnabled: true,
	commentRegistrationEnabled: true,
	commentModerationEnabled: false,
	allowAnonymous: false,
	emailRegistrationEnabled: false,
	avatarPresets: [],
};

const defaultFeatures: FeatureSettings = {
	commentsEnabled: true,
	registrationEnabled: true,
	loginEnabled: true,
	imageHostingEnabled: true,
	clipboardEnabled: true,
	userCenterEnabled: true,
	publicResourcesEnabled: true,
	compilerEnabled: true,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
	const value = useContext(AuthContext);
	if (!value) throw new Error("useAuth must be used inside AuthProvider");
	return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<PublicUser | null>(null);
	const [loading, setLoading] = useState(true);
	const [settings, setSettings] = useState<CommentSettings>(defaultSettings);
	const [features, setFeatures] = useState<FeatureSettings>(defaultFeatures);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [mode, setMode] = useState<AuthMode>("login");
	const refresh = async () => {
		const [nextUser, nextSettings, nextFeatures] = await Promise.all([api.authMe(), api.commentSettings(), api.features()]);
		setUser(nextUser);
		setSettings(nextSettings);
		setFeatures(nextFeatures);
		setLoading(false);
	};
	useEffect(() => { void refresh(); }, []);
	const value = useMemo<AuthContextValue>(() => ({
		user,
		loading,
		settings,
		features,
		openAuth: (nextMode = "login") => { setMode(nextMode); setDialogOpen(true); },
		closeAuth: () => setDialogOpen(false),
		login: async (username, password) => { const result = await api.authLogin({ username, password }); setUser(result); setDialogOpen(false); return result; },
		register: async (input) => { const result = await api.authRegister(input); setUser(await api.authMe()); setDialogOpen(false); return result; },
		logout: async () => { await api.authLogout(); setUser(null); },
		refresh,
	}), [features, loading, settings, user]);
	return <AuthContext.Provider value={value}>{children}<AuthDialog open={dialogOpen} mode={mode} onModeChange={setMode} onClose={() => setDialogOpen(false)} /></AuthContext.Provider>;
}

function displayName(user: PublicUser) {
	return user.nickname?.trim() || user.displayName?.trim() || user.username || user.account || "用户";
}

export function UserAvatar({ user, size = 32 }: { user: PublicUser; size?: number }) {
	const source = resolveMediaUrl(user.avatar);
	return source ? <img className="user-avatar" src={source} alt={`${displayName(user)} 的头像`} width={size} height={size} loading="lazy" decoding="async" /> : <span className="user-avatar user-avatar-fallback" style={{ width: size, height: size }}>{displayName(user).slice(0, 1).toUpperCase()}</span>;
}

function AuthDialog({ open, mode, onModeChange, onClose }: { open: boolean; mode: AuthMode; onModeChange: (mode: AuthMode) => void; onClose: () => void }) {
	const { settings, features, login, register } = useAuth();
	const [username, setUsername] = useState("");
	const [nickname, setNickname] = useState("");
	const [password, setPassword] = useState("");
	const [email, setEmail] = useState("");
	const [emailCode, setEmailCode] = useState("");
	const [avatarUrl, setAvatarUrl] = useState("");
	const [avatarFile, setAvatarFile] = useState<File | null>(null);
	const [avatarChoice, setAvatarChoice] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [codeBusy, setCodeBusy] = useState(false);
	const [codeCooldown, setCodeCooldown] = useState(0);
	const [avatarUploading, setAvatarUploading] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!open) return;
		setError("");
		setPassword("");
		setAvatarFile(null);
		setAvatarChoice("");
	}, [open, mode]);
	useEffect(() => {
		if (!open) return undefined;
		const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [onClose, open]);
	useEffect(() => {
		if (codeCooldown <= 0) return undefined;
		const timer = window.setInterval(() => setCodeCooldown((value) => Math.max(0, value - 1)), 1000);
		return () => window.clearInterval(timer);
	}, [codeCooldown]);
	if (!open) return null;
	if (mode === "login" && !features.loginEnabled) return <div className="auth-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="auth-dialog" role="dialog" aria-modal="true"><header className="auth-dialog-heading"><div><span className="auth-eyebrow"><UserRound size={14} /> Firefly 社区</span><h2>登录已关闭</h2></div><button type="button" className="auth-close" title="关闭" aria-label="关闭" onClick={onClose}><X size={19} /></button></header><p className="auth-lead">管理员暂未开放用户登录。</p></section></div>;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setError("");
		if (username.trim().length < 3) { setError("账号至少需要 3 个字符"); return; }
		if (password.length < 8) { setError("密码至少需要 8 个字符"); return; }
		if (mode === "register" && !features.registrationEnabled) { setError("管理员暂未开放用户注册"); return; }
		if (mode === "register" && nickname.trim().length < 1) { setError("请输入昵称"); return; }
		if (mode === "register" && settings.emailRegistrationEnabled && !/^\S+@\S+\.\S+$/u.test(email.trim())) { setError("请输入有效的邮箱地址"); return; }
		setBusy(true);
		try {
			let avatar = avatarChoice || avatarUrl.trim();
			if (avatarFile) {
				if (!features.userCenterEnabled || !features.imageHostingEnabled) throw new Error("头像上传功能当前已关闭");
				setAvatarUploading(true);
				avatar = await api.uploadAvatar(avatarFile);
			}
			if (mode === "login") await login(username.trim(), password);
			else await register({ username: username.trim(), nickname: nickname.trim(), password, email: email.trim() || undefined, emailCode: emailCode.trim() || undefined, avatar: avatar || undefined });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "操作失败，请稍后重试");
		} finally { setAvatarUploading(false); setBusy(false); }
	};
	const chooseFile = (file: File | undefined) => {
		if (!file) return;
		if (!file.type.startsWith("image/")) { setError("头像必须是图片文件"); return; }
		if (file.size > 3 * 1024 * 1024) { setError("头像不能超过 3MB"); return; }
		setError("");
		setAvatarFile(file);
		setAvatarChoice("");
		setAvatarUrl("");
	};
	const sendCode = async () => {
		if (!/^\S+@\S+\.\S+$/u.test(email.trim())) { setError("请先输入有效的邮箱地址"); return; }
		setCodeBusy(true); setError("");
		try {
			const result = await api.authEmailCode(email.trim());
			setCodeCooldown(60);
			if (result.debugCode) setEmailCode(result.debugCode);
			if (!result.sent && !result.debugCode) setError("验证码发送失败，请检查邮箱服务配置");
		} catch (reason) { setError(reason instanceof Error ? reason.message : "验证码发送失败"); }
		finally { setCodeBusy(false); }
	};
	return <div className="auth-overlay" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
		<section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title">
			<header className="auth-dialog-heading"><div><span className="auth-eyebrow"><UserRound size={14} /> Firefly 社区</span><h2 id="auth-dialog-title">{mode === "login" ? "登录账号" : "创建账号"}</h2></div><button type="button" className="auth-close" title="关闭" aria-label="关闭" onClick={onClose}><X size={19} /></button></header>
			{mode === "login" ? <p className="auth-lead">登录后参与评论、回复和表情互动。</p> : <p className="auth-lead">注册一个账号，留下你的头像和昵称。</p>}
			<form className="auth-form" onSubmit={submit}>
				<label><span>账号</span><input autoFocus value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="请输入账号" /></label>
				{mode === "register" ? <label><span>昵称</span><input value={nickname} onChange={(event) => setNickname(event.target.value)} autoComplete="nickname" placeholder="评论区展示的昵称" /></label> : null}
				<label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="至少 8 个字符" /></label>
				{mode === "register" ? <>
					<label><span>邮箱 {settings.emailRegistrationEnabled ? <em>必填</em> : <small>可选</small>}</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="接收验证码和通知" /></label>
					{settings.emailRegistrationEnabled ? <label><span>邮箱验证码</span><div className="auth-input-with-action"><input value={emailCode} onChange={(event) => setEmailCode(event.target.value)} inputMode="numeric" placeholder="请输入验证码" /><button type="button" disabled={codeBusy || codeCooldown > 0} onClick={() => void sendCode()}>{codeBusy ? "发送中" : codeCooldown ? `${codeCooldown}s` : "发送验证码"}</button></div></label> : null}
					<div className="auth-avatar-field"><div className="auth-field-label"><span>头像</span><small>可选，不超过 3MB</small></div><div className="auth-avatar-options">
						{settings.avatarPresets.slice(0, 18).map((preset) => <button type="button" key={preset} className={avatarChoice === preset ? "selected" : ""} title="选择预设头像" onClick={() => { setAvatarChoice(preset); setAvatarFile(null); setAvatarUrl(""); }}><img src={resolveMediaUrl(preset)} alt="" /></button>)}
						{features.userCenterEnabled && features.imageHostingEnabled ? <><button type="button" className="auth-avatar-upload" title="上传头像" onClick={() => fileInput.current?.click()}><ImagePlus size={17} /><span>{avatarUploading ? "上传中" : avatarFile ? avatarFile.name : "上传"}</span></button><input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => chooseFile(event.target.files?.[0])} /></> : <small>头像文件上传已关闭</small>}
					</div><div className="auth-input-with-icon"><Camera size={15} /><input value={avatarUrl} onChange={(event) => { setAvatarUrl(event.target.value); setAvatarChoice(""); setAvatarFile(null); }} placeholder="或输入图床链接" /></div></div>
				</> : null}
				{error ? <p className="auth-error" role="alert">{error}</p> : null}
				<button className="auth-submit" type="submit" disabled={busy}>{mode === "login" ? <LogIn size={17} /> : <Check size={17} />}{busy ? "处理中..." : mode === "login" ? "登录" : "注册"}</button>
			</form>
			<footer className="auth-dialog-footer">{mode === "login" ? settings.commentRegistrationEnabled && features.registrationEnabled ? <><span>还没有账号？</span><button type="button" onClick={() => onModeChange("register")}>立即注册</button></> : <span>管理员暂未开放用户注册</span> : features.loginEnabled ? <><span>已有账号？</span><button type="button" onClick={() => onModeChange("login")}>返回登录</button></> : null}</footer>
		</section>
	</div>;
}

export function AccountMenu() {
	const { user, openAuth, logout } = useAuth();
	const [open, setOpen] = useState(false);
	if (!user) return <button type="button" className="account-entry" title="登录 / 注册" onClick={() => openAuth("login")}><LogIn size={18} /><span>登录</span></button>;
	return <div className="account-menu-wrap"><button type="button" className={`account-entry account-entry-user ${open ? "is-active" : ""}`} title="打开账号菜单" onClick={() => setOpen((value) => !value)}><UserAvatar user={user} size={28} /><span>{displayName(user)}</span></button>{open ? <div className="account-menu"><div className="account-menu-user"><UserAvatar user={user} size={38} /><div><strong>{displayName(user)}</strong><small>@{user.username || user.account}</small></div></div><button type="button" onClick={() => { setOpen(false); void logout(); }}><LogOut size={15} />退出登录</button></div> : null}</div>;
}
