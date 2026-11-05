import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck, Zap } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import "../admin/admin.css";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");

type ScopeChoice = { id: string; label: string; description: string };
type DeviceInfo = {
	userCodeDisplay: string;
	clientName: string;
	scopes: ScopeChoice[];
	status: string;
	expiresAt: string;
	siteName: string;
};

async function readJson<T>(response: Response): Promise<T> {
	const payload = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
	if (!response.ok) throw new Error(payload?.message || payload?.error || "请求失败");
	return payload as T;
}

export default function AgentAuthorizePage() {
	const [params] = useSearchParams();
	const code = params.get("code")?.trim() ?? "";
	const [info, setInfo] = useState<DeviceInfo | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [token, setToken] = useState("");
	const [signedInAs, setSignedInAs] = useState("");
	const [usingStoredSession, setUsingStoredSession] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<"approved" | "denied" | "">("");

	useEffect(() => {
		const previous = document.title;
		document.title = "授权智能体";
		return () => { document.title = previous; };
	}, []);

	useEffect(() => {
		if (!code) { setLoading(false); return; }
		let cancelled = false;
		void (async () => {
			try {
				const next = await readJson<DeviceInfo>(await fetch(`${API_ORIGIN}/api/agent/device/${encodeURIComponent(code)}`));
				if (cancelled) return;
				setInfo(next);
				setSelected(next.scopes.map((item) => item.id));
			} catch (reason) {
				if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取授权请求");
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => { cancelled = true; };
	}, [code]);

	useEffect(() => {
		const stored = sessionStorage.getItem("site-admin-token")?.trim() ?? "";
		if (!stored) return;
		let cancelled = false;
		void (async () => {
			const response = await fetch(`${API_ORIGIN}/api/admin/me`, { headers: { authorization: `Bearer ${stored}` } });
			if (!response.ok || cancelled) return;
			const payload = (await response.json().catch(() => null)) as { user?: { id?: number | null; username?: string } } | null;
			if (!payload?.user?.id || cancelled) return;
			setToken(stored);
			setSignedInAs(payload.user.username || sessionStorage.getItem("site-admin-username") || "管理员");
			setUsingStoredSession(true);
		})();
		return () => { cancelled = true; };
	}, []);

	const login = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			const response = await fetch(`${API_ORIGIN}/api/admin/login`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: username.trim(), password }),
			});
			const payload = await readJson<{ token?: string; user?: { id?: number | null; username?: string } }>(response);
			if (!payload.token || !payload.user?.id) throw new Error("请使用数据库中的管理员账号登录");
			setToken(payload.token);
			setSignedInAs(payload.user.username || username.trim());
			setUsingStoredSession(false);
			setPassword("");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "登录失败");
		} finally {
			setBusy(false);
		}
	};

	const decide = async (approved: boolean) => {
		setBusy(true);
		setError("");
		try {
			const response = await fetch(`${API_ORIGIN}/api/agent/device/${encodeURIComponent(code)}/${approved ? "approve" : "deny"}`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: approved ? JSON.stringify({ scopes: selected }) : "{}",
			});
			await readJson(response);
			setDone(approved ? "approved" : "denied");
			if (!usingStoredSession && token) {
				await fetch(`${API_ORIGIN}/api/admin/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
			}
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "授权失败");
		} finally {
			setBusy(false);
		}
	};

	const pending = info?.status === "pending" && !done;
	return (
		<main className="fa-login-page">
			<div className="fa-login-visual">
				<div className="fa-login-orbit" />
				<div className="fa-login-copy">
					<span className="fa-kicker">AGENT ACCESS</span>
					<h1>让智能体把文档写进博客。</h1>
					<p>管理员密码只提交给这个站点。智能体只会拿到你勾选的权限，可以随时在后台撤销。</p>
				</div>
			</div>
			<section className="fa-login-card agent-authorize-card">
				<div className="fa-login-mark"><ShieldCheck size={26} /></div>
				<span className="fa-kicker">{info?.siteName || "BLOG"}</span>
				<h2>授权智能体</h2>
				{!code ? <p>授权页需要从智能体发起。请在 Cursor 中调用博客连接工具。</p> : null}
				{loading ? <p>正在读取授权请求…</p> : null}
				{error ? <div className="fa-error" role="alert">{error}</div> : null}
				{info && !loading ? (
					<>
						<p>{info.clientName} 正在请求管理博客内容。请核对授权码。</p>
						<p className="agent-code">{info.userCodeDisplay}</p>
						{info.status === "expired" ? <p>这次授权已过期。请回到智能体重新发起。</p> : null}
						{info.status === "denied" || done === "denied" ? <p>已拒绝。可以关闭这个页面。</p> : null}
						{info.status === "approved" || done === "approved" ? <p>授权已完成。回到 Cursor 后，智能体就可以继续写入文章。</p> : null}
					</>
				) : null}
				{pending && !token ? (
					<form onSubmit={login}>
						<label>
							管理员账号
							<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
						</label>
						<label>
							密码
							<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
						</label>
						<button className="fa-button fa-button-primary" type="submit" disabled={busy}><Zap size={16} />{busy ? "正在登录" : "登录并继续"}</button>
					</form>
				) : null}
				{pending && token ? (
					<div className="agent-decision">
						<p>将以 {signedInAs} 的身份授权。</p>
						<ul className="agent-scope-list">
							{info?.scopes.map((scope) => (
								<li key={scope.id}>
									<label>
										<input type="checkbox" checked={selected.includes(scope.id)} onChange={() => setSelected((current) => current.includes(scope.id) ? current.filter((item) => item !== scope.id) : [...current, scope.id])} />
										<span>{scope.label}<small>{scope.description}</small></span>
									</label>
								</li>
							))}
						</ul>
						<div className="agent-actions">
							<button className="fa-button fa-button-primary" type="button" disabled={busy || selected.length === 0} onClick={() => void decide(true)}>允许</button>
							<button className="fa-button fa-button-danger" type="button" disabled={busy} onClick={() => void decide(false)}>拒绝</button>
						</div>
						<button className="fa-button fa-button-ghost" type="button" onClick={() => {
							if (!usingStoredSession && token) void fetch(`${API_ORIGIN}/api/admin/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
							setToken("");
							setSignedInAs("");
							setUsingStoredSession(false);
						}}>使用其他账号</button>
					</div>
				) : null}
			</section>
		</main>
	);
}
