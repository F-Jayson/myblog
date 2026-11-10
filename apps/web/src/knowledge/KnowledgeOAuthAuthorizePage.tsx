import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
	AlertTriangle,
	ArrowLeft,
	Bot,
	Check,
	CheckCircle2,
	Clock,
	Folder,
	Globe,
	Lock,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import { useAuth } from "../auth";
import { kbApi } from "./api";
import "./knowledge.css";
import type { LibrarySummary } from "./types";

const SCOPES_CONFIG = [
	{ id: "kb:read", label: "读取文档 (只读)", desc: "浏览目录树、阅读文档内容与大纲、搜索", sensitive: false, default: true },
	{ id: "kb:write", label: "编辑文档 (写入)", desc: "创建文档、编辑 Markdown、版本恢复、目录整理", sensitive: false, default: false },
	{ id: "kb:comment", label: "工作评论", desc: "发表内部讨论或公开评论、标记已解决", sensitive: false, default: false },
	{ id: "kb:attachments", label: "上传附件", desc: "上传图片或相关附件绑定到文档", sensitive: false, default: false },
	{ id: "kb:publish", label: "公开发布快照 (敏感)", desc: "将文档版本发布到互联网公开只读通道或撤回", sensitive: true, default: false },
	{ id: "kb:share", label: "管理协作者与分享 (敏感)", desc: "添加/移除协作者、配置单篇受限名单与分享链接", sensitive: true, default: false },
	{ id: "kb:delete", label: "回收站删除 (敏感)", desc: "将文档移入回收站或从回收站恢复", sensitive: true, default: false },
	{ id: "kb:export", label: "批量导出", desc: "导出已授权文档的 Markdown 原文", sensitive: false, default: false },
];

// [405] redirect_uri 完全来自 URL 查询参数，new URL() 可能在渲染期抛 TypeError 打挂整页
function safeParseUrl(value: string): URL | null {
	if (!value) return null;
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

export default function KnowledgeOAuthAuthorizePage() {
	const [searchParams] = useSearchParams();

	const clientId = searchParams.get("client_id")?.trim() || "";
	const clientName = searchParams.get("client_name")?.trim() || "远程 AI 客户端";
	const redirectUri = searchParams.get("redirect_uri")?.trim() || "";
	const requestedScopeStr = searchParams.get("scope")?.trim() || "kb:read";
	const state = searchParams.get("state")?.trim() || "";
	const codeChallenge = searchParams.get("code_challenge")?.trim() || "";
	const codeChallengeMethod = searchParams.get("code_challenge_method")?.trim() || "S256";

	const { user, openAuth } = useAuth();

	const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
	const [selectedLibIds, setSelectedLibIds] = useState<number[]>([]);
	const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	// 初始化请求的 Scope (过滤敏感 scope，默认不勾选敏感)
	useEffect(() => {
		const reqScopes = requestedScopeStr.split(/\s+/).filter(Boolean);
		const initial = reqScopes.filter((s) => !SCOPES_CONFIG.find((c) => c.id === s)?.sensitive);
		setSelectedScopes(initial.length > 0 ? initial : ["kb:read"]);
	}, [requestedScopeStr]);

	// 加载用户的知识库列表
	useEffect(() => {
		if (user) {
			kbApi
				.listLibraries()
				.then((libs) => {
					setLibraries(libs);
					// [407] 默认不勾选任何库：最小权限原则，未勾选的知识库不会被访问
				})
				.catch((err) => {
					console.error("加载知识库列表失败:", err);
				});
		}
	}, [user]);

	const toggleScope = (scopeId: string) => {
		setSelectedScopes((prev) =>
			prev.includes(scopeId) ? prev.filter((id) => id !== scopeId) : [...prev, scopeId]
		);
	};

	const toggleLibrary = (libId: number) => {
		setSelectedLibIds((prev) =>
			prev.includes(libId) ? prev.filter((id) => id !== libId) : [...prev, libId]
		);
	};

	const selectAllLibraries = () => {
		if (selectedLibIds.length === libraries.length) {
			setSelectedLibIds([]);
		} else {
			setSelectedLibIds(libraries.map((l) => l.id));
		}
	};

	// 提交批准同意
	const handleApprove = async (e: FormEvent) => {
		e.preventDefault();
		if (!user) {
			openAuth?.();
			return;
		}

		if (selectedScopes.length === 0) {
			setSubmitError("请至少选择一项操作权限");
			return;
		}

		// [407] 未勾选任何知识库时禁止提交：客户端将无法访问任何内容
		if (selectedLibIds.length === 0) {
			setSubmitError("请至少选择一个允许访问的知识库，否则客户端将无法访问任何内容");
			return;
		}

		// [411] 授权链接关键参数缺失时提前给出可理解的提示，而不是让服务端返回泛化错误
		if (!clientId || !redirectUri || !codeChallenge) {
			setSubmitError("授权链接无效或已过期，请返回客户端重新发起授权");
			return;
		}

		setSubmitting(true);
		setSubmitError(null);

		try {
			const data = await kbApi.createOAuthConsent({
				client_id: clientId,
				redirect_uri: redirectUri,
				code_challenge: codeChallenge,
				code_challenge_method: codeChallengeMethod,
				state,
				scopes: selectedScopes,
				allowed_library_ids: selectedLibIds,
			});

			// 重定向回远程客户端
			if (data.redirect_url) {
				window.location.href = data.redirect_url;
				return;
			}
			// [410] 服务端 200 但没有 redirect_url：不能把按钮永久卡在“正在授权中”
			setSubmitError("授权已完成，但未收到客户端回调地址，请返回客户端查看连接状态");
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : "批准授权失败");
		} finally {
			// [408] 统一在 finally 复位提交态：成功跳转前复位不会造成可感知的闪烁
			setSubmitting(false);
		}
	};

	// 拒绝授权
	const handleDeny = () => {
		if (redirectUri) {
			// [406] 拒绝回跳也必须校验协议：畸形地址或 javascript: 伪协议一律拒绝跳转
			const denyUrl = safeParseUrl(redirectUri);
			if (!denyUrl || (denyUrl.protocol !== "https:" && denyUrl.protocol !== "http:")) {
				setSubmitError("回调地址无效，已阻止跳转");
				return;
			}
			denyUrl.searchParams.set("error", "access_denied");
			denyUrl.searchParams.set("error_description", "用户拒绝了本次远程授权申请");
			if (state) denyUrl.searchParams.set("state", state);
			window.location.href = denyUrl.toString();
		} else {
			window.history.back();
		}
	};

	return (
		<div className="kb-container" style={{ maxWidth: 760, margin: "40px auto", padding: "0 20px" }}>
			<div style={{ marginBottom: 24 }}>
				<Link to="/knowledge" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-primary, #6366f1)", textDecoration: "none", fontSize: "0.9rem" }}>
					<ArrowLeft size={16} /> 返回知识库主页
				</Link>
			</div>

			<div className="kb-card" style={{ padding: 32, borderRadius: 16, background: "var(--card-bg, rgba(255,255,255,0.85))", boxShadow: "0 8px 30px rgba(0,0,0,0.06)", backdropFilter: "blur(12px)" }}>
				{/* 头部标题与客户端身份 */}
				<div style={{ textAlign: "center", marginBottom: 28 }}>
					<div style={{ width: 64, height: 64, borderRadius: "50%", background: "linear-gradient(135deg, #10b981 0%, #059669 100%)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", boxShadow: "0 6px 16px rgba(16,185,129,0.3)" }}>
						<Globe size={32} />
					</div>
					<h2 style={{ fontSize: "1.5rem", fontWeight: 700, margin: "0 0 8px" }}>远程 AI 客户端连接授权</h2>
					<p style={{ color: "var(--text-secondary, #64748b)", margin: 0, fontSize: "0.95rem" }}>
						客户端 <strong style={{ color: "var(--text-primary, #0f172a)" }}>{clientName}</strong> 正在请求通过 OAuth 2.1 协议访问您的个人知识库。
					</p>
					<div style={{ marginTop: 8, fontSize: "0.85rem", color: "#94a3b8" }}>
						重定向回调域名: <code>{safeParseUrl(redirectUri)?.origin ?? "未知"}</code>
					</div>
				</div>

				{!user ? (
					<div style={{ textAlign: "center", padding: "32px 0", borderTop: "1px dashed var(--border-color, #e2e8f0)" }}>
						<p style={{ color: "var(--text-secondary, #64748b)", marginBottom: 16 }}>请先登录普通博客账号以继续授权流程</p>
						<button onClick={() => openAuth?.()} className="kb-btn kb-btn-primary" style={{ padding: "10px 24px", fontSize: "1rem" }}>
							立即登录账号
						</button>
					</div>
				) : (
					<form onSubmit={handleApprove}>
						<div style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 12, padding: "14px 18px", marginBottom: 24, display: "flex", alignItems: "center", gap: 12 }}>
							<ShieldCheck size={22} style={{ color: "#6366f1", flexShrink: 0 }} />
							<div style={{ fontSize: "0.88rem", color: "var(--text-secondary, #475569)" }}>
								授权登录身份: <strong style={{ color: "var(--text-primary, #0f172a)" }}>{user.nickname || user.username}</strong> (ID: {user.id})。
								本次授权为受限访问，密码与账号 Cookie 绝不会向客户端透露。
							</div>
						</div>

						{/* 1. 授权库选择 */}
						<div style={{ marginBottom: 24 }}>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
								<label style={{ fontWeight: 600, fontSize: "1rem", color: "var(--text-primary, #1e293b)" }}>
									1. 允许访问的知识库
								</label>
								<button type="button" onClick={selectAllLibraries} className="kb-btn kb-btn-secondary" style={{ padding: "4px 10px", fontSize: "0.8rem" }}>
									{selectedLibIds.length === libraries.length ? "取消全选" : "全选全部库"}
								</button>
							</div>

							{libraries.length === 0 ? (
								<div style={{ padding: 16, background: "var(--bg-secondary, #f8fafc)", borderRadius: 8, fontSize: "0.88rem", color: "#64748b" }}>
									暂无可用知识库。授权后客户端将无法检索文档。
								</div>
							) : (
								<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
									{libraries.map((lib) => {
										const checked = selectedLibIds.includes(lib.id);
										return (
											<div
												key={lib.id}
												onClick={() => toggleLibrary(lib.id)}
												style={{
													border: `1.5px solid ${checked ? "#6366f1" : "var(--border-color, #e2e8f0)"}`,
													background: checked ? "rgba(99,102,241,0.04)" : "var(--bg-primary, #fff)",
													borderRadius: 10,
													padding: "10px 14px",
													cursor: "pointer",
													display: "flex",
													alignItems: "center",
													gap: 10,
													transition: "all 0.2s ease",
												}}
											>
												<div style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${checked ? "#6366f1" : "#cbd5e1"}`, background: checked ? "#6366f1" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
													{checked && <Check size={14} />}
												</div>
												<div style={{ overflow: "hidden" }}>
													<div style={{ fontWeight: 500, fontSize: "0.9rem", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
														{lib.title}
													</div>
													<div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{lib.documentCount ?? 0} 篇文档</div>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</div>

						{/* 2. 权限范围配置 */}
						<div style={{ marginBottom: 28 }}>
							<label style={{ display: "block", fontWeight: 600, fontSize: "1rem", color: "var(--text-primary, #1e293b)", marginBottom: 12 }}>
								2. 授予该 AI 客户端的操作权限 (Scope)
							</label>

							<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
								{SCOPES_CONFIG.map((sc) => {
									const checked = selectedScopes.includes(sc.id);
									return (
										<div
											key={sc.id}
											onClick={() => toggleScope(sc.id)}
											style={{
												border: `1.5px solid ${checked ? (sc.sensitive ? "#f59e0b" : "#6366f1") : "var(--border-color, #e2e8f0)"}`,
												background: checked ? (sc.sensitive ? "rgba(245,158,11,0.04)" : "rgba(99,102,241,0.04)") : "var(--bg-primary, #fff)",
												borderRadius: 10,
												padding: "12px 16px",
												cursor: "pointer",
												display: "flex",
												alignItems: "flex-start",
												gap: 12,
												transition: "all 0.2s ease",
											}}
										>
											<div style={{ width: 20, height: 20, borderRadius: 5, border: `1.5px solid ${checked ? (sc.sensitive ? "#f59e0b" : "#6366f1") : "#cbd5e1"}`, background: checked ? (sc.sensitive ? "#f59e0b" : "#6366f1") : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", marginTop: 2 }}>
												{checked && <Check size={14} />}
											</div>
											<div style={{ flex: 1 }}>
												<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
													<span style={{ fontWeight: 600, fontSize: "0.92rem" }}>{sc.label}</span>
													<code style={{ fontSize: "0.75rem", background: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: 4 }}>{sc.id}</code>
													{sc.sensitive && (
														<span style={{ fontSize: "0.7rem", color: "#d97706", background: "#fef3c7", padding: "1px 6px", borderRadius: 4, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 3 }}>
															<AlertTriangle size={11} /> 敏感操作
														</span>
													)}
												</div>
												<div style={{ fontSize: "0.82rem", color: "var(--text-secondary, #64748b)" }}>{sc.desc}</div>
											</div>
										</div>
									);
								})}
							</div>
						</div>

						{submitError && (
							<div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, color: "#b91c1c", fontSize: "0.9rem", marginBottom: 20 }}>
								{submitError}
							</div>
						)}

						{/* 底部按钮栏 */}
						<div style={{ display: "flex", gap: 14, borderTop: "1px solid var(--border-color, #e2e8f0)", paddingTop: 24 }}>
							<button
								type="button"
								onClick={handleDeny}
								disabled={submitting}
								className="kb-btn kb-btn-secondary"
								style={{ flex: 1, padding: "12px 0", fontSize: "0.98rem", justifyContent: "center" }}
							>
								拒绝连接
							</button>
							<button
								type="submit"
								disabled={submitting || selectedScopes.length === 0}
								className="kb-btn kb-btn-primary"
								style={{ flex: 2, padding: "12px 0", fontSize: "0.98rem", justifyContent: "center" }}
							>
								{submitting ? "正在授权中..." : "同意并授权"}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
