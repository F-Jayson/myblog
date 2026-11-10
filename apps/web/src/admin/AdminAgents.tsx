import { useEffect, useState } from "react";
import { Bot, RefreshCw } from "lucide-react";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");

const SCOPE_LABELS: Record<string, string> = {
	"posts:read": "读取文章",
	"posts:write": "草稿",
	"posts:publish": "发布文章",
	"posts:delete": "删除文章",
	"media:write": "图片",
	"taxonomy:manage": "分类标签",
	"comments:read": "读取评论",
	"comments:moderate": "审核评论",
	"content:read": "读取内容",
	"content:write": "编辑内容",
	"content:publish": "发布内容",
	"content:delete": "删除内容",
	"site:read": "读取站点",
	"site:write": "修改站点",
	"users:read": "读取用户",
	"users:manage": "管理用户",
};

const ACTION_LABELS: Record<string, string> = {
	approve: "同意授权",
	deny: "拒绝授权",
	revoke: "撤销授权",
	disconnect: "智能体断开",
	upsert: "写入文章",
	publish: "发布文章",
	unpublish: "转为草稿",
	delete: "删除文章",
	upload: "上传图片",
	category: "创建分类",
	tag: "创建标签",
	"category-delete": "删除分类",
	"tag-delete": "删除标签",
	comment: "审核评论",
	"comment-delete": "删除评论",
	dynamic: "编辑动态",
	"dynamic-delete": "删除动态",
	page: "编辑页面",
	"page-delete": "删除页面",
	changelog: "编辑更新日志",
	"changelog-delete": "删除更新日志",
	announcement: "编辑公告",
	"announcement-publish": "发布公告",
	"announcement-delete": "删除公告",
	feedback: "处理反馈",
	"feedback-delete": "删除反馈",
	site: "修改站点",
	features: "修改功能开关",
	"comments-settings": "修改评论设置",
	user: "修改用户",
	"user-delete": "删除用户",
};

type Grant = {
	id: number;
	clientName: string;
	username: string;
	scopes: string[];
	expiresAt: string;
	lastUsedAt: string | null;
	createdAt: string;
	documentCount: number;
	status: "active" | "expired" | "revoked";
};

type AuditRow = {
	id: number;
	action: string;
	target: string;
	detail: string;
	createdAt: string;
	clientName: string;
	username: string;
};

function dateText(value: string | null) {
	if (!value) return "—";
	const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString("zh-CN", { hour12: false });
}

async function adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
	const token = sessionStorage.getItem("site-admin-token");
	const headers = new Headers(options.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);
	const response = await fetch(API_ORIGIN + path, { ...options, headers });
	if (response.status === 401) throw new Error("登录状态已失效");
	if (response.status === 204) return undefined as T;
	const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
	if (!response.ok) throw new Error(payload?.message || payload?.error || "请求失败");
	// [347] 空响应体（如 200 + 空 JSON）时 payload 为 null：直接 as T 会把 null 强转成数组，
	// 消费方 grants.length 直接白屏。这里兜底为空数组（列表端点没有"合法的空值"语义）。
	if (payload === null) return [] as unknown as T;
	return payload as T;
}

export default function AdminAgents() {
	const [grants, setGrants] = useState<Grant[]>([]);
	const [audit, setAudit] = useState<AuditRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [busyId, setBusyId] = useState<number | null>(null);

	const load = async () => {
		setLoading(true);
		setError("");
		try {
			const [nextGrants, nextAudit] = await Promise.all([
				adminRequest<Grant[]>("/api/admin/agent-grants"),
				adminRequest<AuditRow[]>("/api/admin/agent-audit?limit=30"),
			]);
			setGrants(nextGrants);
			setAudit(nextAudit);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "加载失败");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => { void load(); }, []);

	const revoke = async (grant: Grant) => {
		if (!window.confirm(`撤销「${grant.clientName}」后，它需要重新授权才能写入博客。`)) return;
		setBusyId(grant.id);
		setError("");
		try {
			await adminRequest(`/api/admin/agent-grants/${grant.id}`, { method: "DELETE" });
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "撤销失败");
		} finally {
			setBusyId(null);
		}
	};

	return (
		<div className="fa-page">
			<header className="fa-page-heading">
				<div>
					<span className="fa-kicker">AGENT ACCESS</span>
					<h1>智能体授权</h1>
					<p>这里列出连接过博客的智能体。撤销后，本机保存的令牌会在下次调用时失效。</p>
				</div>
				<button className="fa-button fa-button-ghost" type="button" onClick={() => void load()}><RefreshCw size={15} />刷新</button>
			</header>
			{error ? <div className="fa-error fa-page-error">{error}</div> : null}
			<section className="fa-panel">
				<div className="fa-panel-head">
					<div className="fa-panel-title"><Bot size={18} /><h2>已连接的智能体</h2></div>
				</div>
				<div className="fa-table-wrap">
					<table className="fa-table">
						<thead>
							<tr><th>客户端</th><th>管理员</th><th>权限</th><th>同步文章</th><th>最近使用</th><th>状态</th><th>操作</th></tr>
						</thead>
						<tbody>
							{loading ? <tr><td colSpan={7}><div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载</div></td></tr> : grants.length ? grants.map((grant) => (
								<tr key={grant.id}>
									<td><strong>{grant.clientName}</strong><div>{dateText(grant.createdAt)} 授权</div></td>
									<td>{grant.username}</td>
									<td>{grant.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("、")}</td>
									<td>{grant.documentCount}</td>
									<td>{dateText(grant.lastUsedAt)}</td>
									<td><span className={`fa-pill ${grant.status === "active" ? "published" : "draft"}`}>{grant.status === "active" ? "有效" : grant.status === "expired" ? "已过期" : "已撤销"}</span></td>
									<td>{grant.status === "active" ? <button className="fa-button fa-button-danger" type="button" disabled={busyId === grant.id} onClick={() => void revoke(grant)}>撤销</button> : "—"}</td>
								</tr>
							)) : <tr><td colSpan={7}>还没有智能体连接过这个博客。</td></tr>}
						</tbody>
					</table>
				</div>
			</section>
			<section className="fa-panel">
				<div className="fa-panel-head"><div className="fa-panel-title"><h2>最近操作</h2></div></div>
				<div className="fa-table-wrap">
					<table className="fa-table">
						<thead><tr><th>时间</th><th>操作</th><th>对象</th><th>说明</th><th>管理员</th></tr></thead>
						<tbody>
							{audit.length ? audit.map((row) => (
								<tr key={row.id}>
									<td>{dateText(row.createdAt)}</td>
									<td>{ACTION_LABELS[row.action] ?? row.action}</td>
									<td>{row.target || "—"}</td>
									<td>{row.detail || row.clientName || "—"}</td>
									<td>{row.username || "—"}</td>
								</tr>
							)) : <tr><td colSpan={5}>{loading ? "正在加载" : "还没有操作记录。"}</td></tr>}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}
