import { useCallback, useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import {
	ArrowLeft,
	Bot,
	CheckCircle2,
	Folder,
	XCircle,
} from "lucide-react";
import { useAuth } from "../auth";
import { kbApi } from "./api";
import "./knowledge.css";
import type { LibrarySummary } from "./types";

const SCOPES_CONFIG = [
	{ id: "kb:read", label: "读取文档 (只读)", desc: "浏览目录树、阅读文档内容与大纲、搜索", sensitive: false },
	{ id: "kb:write", label: "编辑文档 (写入)", desc: "创建文档、编辑 Markdown、版本恢复、目录整理", sensitive: false },
	{ id: "kb:comment", label: "工作评论", desc: "发表内部讨论或公开评论、标记已解决", sensitive: false },
	{ id: "kb:attachments", label: "上传附件", desc: "上传图片或相关附件绑定到文档", sensitive: false },
	{ id: "kb:publish", label: "公开发布快照 (敏感)", desc: "将文档版本发布到互联网公开只读通道或撤回", sensitive: true },
	{ id: "kb:share", label: "管理协作者与分享 (敏感)", desc: "添加/移除协作者、配置单篇受限名单与分享链接", sensitive: true },
	{ id: "kb:delete", label: "回收站删除 (敏感)", desc: "将文档移入回收站或从回收站恢复", sensitive: true },
	{ id: "kb:export", label: "批量导出", desc: "导出已授权文档的 Markdown 原文", sensitive: false },
];

// 过期时间只做展示：接口未返回或格式异常时不能在渲染期抛错
function formatExpiry(value: string | undefined): string {
	if (typeof value !== "string" || value.length === 0) return "未知";
	return value.slice(0, 16);
}

export default function KnowledgeAuthorizePage() {
	const [searchParams] = useSearchParams();
	const initialUserCode = searchParams.get("userCode")?.trim() || "";

	const { user, openAuth } = useAuth();

	const [userCode, setUserCode] = useState(initialUserCode);
	const [deviceInfo, setDeviceInfo] = useState<{
		userCode: string;
		clientName: string;
		requestedScopes: string[];
		status: string;
		expiresAt: string;
	} | null>(null);
	const [deviceLoading, setDeviceLoading] = useState(false);
	const [deviceError, setDeviceError] = useState<string | null>(null);
	const [librariesError, setLibrariesError] = useState<string | null>(null);

	const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
	const [selectedLibIds, setSelectedLibIds] = useState<number[]>([]);
	const [selectedScopes, setSelectedScopes] = useState<string[]>(["kb:read"]);
	const [expiresInDays, setExpiresInDays] = useState(7);

	const [submitting, setSubmitting] = useState(false);
	const [resultState, setResultState] = useState<"approved" | "denied" | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	// 1. 查询设备请求（kbRequest 会校验 res.ok，4xx/5xx 会 throw 走 catch）
	const fetchDeviceRequest = useCallback(async (code: string) => {
		if (!code) return;
		setDeviceLoading(true);
		setDeviceError(null);
		try {
			const data = await kbApi.getAgentDeviceRequest(code);
			// 记录本次查询对应的配对码：提交时必须以它为准，
			// 避免用户查询 A 码后修改输入框未重新查询、却批准了 B 码（授权对象错配）
			setDeviceInfo({ ...data, userCode: code });
			// 默认勾选请求中请求的非敏感 scope：只能授予客户端申请过的权限
			const requested = Array.isArray(data.requestedScopes) ? data.requestedScopes : [];
			const defaultSelected = requested.filter(
				(s) => SCOPES_CONFIG.some((c) => c.id === s) && !SCOPES_CONFIG.find((c) => c.id === s)?.sensitive,
			);
			setSelectedScopes(defaultSelected.length > 0 ? defaultSelected : ["kb:read"]);
		} catch (err) {
			setDeviceError(err instanceof Error ? err.message : "请求失败");
			setDeviceInfo(null);
		} finally {
			setDeviceLoading(false);
		}
	}, []);

	useEffect(() => {
		if (initialUserCode && initialUserCode !== userCode) {
			// URL 中的配对码变化时同步回输入框，避免"显示旧码、请求新码"的错位
			setUserCode(initialUserCode);
		}
		if (initialUserCode) {
			fetchDeviceRequest(initialUserCode);
		}
	}, [initialUserCode, fetchDeviceRequest]);

	// 2. 加载用户的知识库列表
	useEffect(() => {
		if (!user) return;
		let active = true;
		setLibrariesError(null);
		setSelectedLibIds([]);
		kbApi.listLibraries()
			.then((libs) => {
				if (!active) return;
				setLibraries(libs);
				// 默认勾选第一个库
				if (libs.length > 0) {
					setSelectedLibIds([libs[0].id]);
				}
			})
			.catch((err) => {
				if (!active) return;
				// 加载失败要清空并给出可重试的错误，不能与"真的没有知识库"混为一谈
				setLibraries([]);
				setLibrariesError(err instanceof Error ? err.message : "知识库列表加载失败，请刷新重试");
			});
		return () => {
			active = false;
		};
	}, [user]);

	// 3. 提交批准（提交的配对码必须与当前展示的 deviceInfo 对应的码一致）
	const handleApprove = async () => {
		if (!user) {
			openAuth("login");
			return;
		}
		if (!deviceInfo) {
			setSubmitError("请先查询配对码对应的连接请求");
			return;
		}
		const approvedCode = deviceInfo.userCode;
		if (approvedCode !== userCode.trim()) {
			// 输入框被改过但尚未重新查询：禁止用展示的 A 客户端信息批准 B 码
			setSubmitError("配对码已修改，请先重新查询后再授权");
			return;
		}
		if (selectedLibIds.length === 0) {
			setSubmitError("请至少勾选一个知识库");
			return;
		}
		if (selectedScopes.length === 0) {
			setSubmitError("请至少勾选一项权限");
			return;
		}

		setSubmitting(true);
		setSubmitError(null);
		try {
			await kbApi.approveAgentDeviceRequest({
				userCode: approvedCode,
				allowedLibraryIds: selectedLibIds,
				grantedScopes: selectedScopes,
				expiresInDays,
			});
			setResultState("approved");
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : "授权失败");
		} finally {
			setSubmitting(false);
		}
	};

	// 4. 提交拒绝（同样以查询到的配对码为准）
	const handleDeny = async () => {
		if (!deviceInfo) {
			setSubmitError("请先查询配对码对应的连接请求");
			return;
		}
		setSubmitting(true);
		setSubmitError(null);
		try {
			await kbApi.denyAgentDeviceRequest(deviceInfo.userCode);
			setResultState("denied");
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : "拒绝失败");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="kb-container" style={{ maxWidth: "680px", margin: "2.5rem auto", padding: "0 1rem" }}>
			<div style={{ marginBottom: "1.5rem" }}>
				<Link to="/knowledge" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", color: "var(--muted-text)" }}>
					<ArrowLeft className="w-4 h-4" /> 返回个人知识库
				</Link>
			</div>

			<div className="kb-card">
				<div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.25rem", borderBottom: "1px solid var(--line)", paddingBottom: "1rem" }}>
					<div style={{ padding: "0.5rem", borderRadius: "0.5rem", background: "color-mix(in srgb, var(--primary) 15%, transparent)" }}>
						<Bot className="w-6 h-6 text-primary" />
					</div>
					<div>
						<h1 style={{ fontSize: "1.25rem", fontWeight: 700, margin: 0 }}>AI 客户端知识库授权</h1>
						<p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted-text)" }}>
							普通用户专用本地 MCP 独立授权通道 (与站长管理隔离)
						</p>
					</div>
				</div>

				{/* 结果状态卡片 */}
				{resultState === "approved" ? (
					<div style={{ textAlign: "center", padding: "2.5rem 1rem" }}>
						<CheckCircle2 className="w-16 h-16 text-success" style={{ margin: "0 auto 1rem auto" }} />
						<h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.5rem" }}>授权成功！</h2>
						<p style={{ color: "var(--muted-text)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
							已为 <strong>{deviceInfo?.clientName || "AI 客户端"}</strong> 颁发独立访问凭证。客户端已自动接收 Token，您可以安全关闭此网页窗口。
						</p>
						<Link to="/knowledge" className="kb-btn kb-btn-primary kb-btn-sm">
							进入我的知识库
						</Link>
					</div>
				) : resultState === "denied" ? (
					<div style={{ textAlign: "center", padding: "2.5rem 1rem" }}>
						<XCircle className="w-16 h-16 text-error" style={{ margin: "0 auto 1rem auto" }} />
						<h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.5rem" }}>已拒绝授权</h2>
						<p style={{ color: "var(--muted-text)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
							您已取消或拒绝该 AI 客户端的连接请求。该客户端无法访问您的任何知识库数据。
						</p>
						<Link to="/knowledge" className="kb-btn kb-btn-ghost kb-btn-sm">
							返回知识库
						</Link>
					</div>
				) : (
					<>
						{/* 登录检查 */}
						{!user && (
							<div
								style={{
									padding: "1rem",
									borderRadius: "0.75rem",
									background: "color-mix(in srgb, var(--warning) 12%, transparent)",
									border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
									marginBottom: "1.5rem",
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
								}}
							>
								<div style={{ fontSize: "0.85rem", color: "var(--deep-text)" }}>
									您尚未登录普通博客账号。授权前请先完成登录。
								</div>
								<button
									type="button"
									className="kb-btn kb-btn-primary kb-btn-sm"
									onClick={() => openAuth("login")}
								>
									立即登录
								</button>
							</div>
						)}

						{/* 配对码输入/展示 */}
						<div style={{ marginBottom: "1.5rem" }}>
							<label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
								授权配对码 (User Code)
							</label>
							<div style={{ display: "flex", gap: "0.5rem" }}>
								<input
									type="text"
									className="kb-input"
									style={{ fontFamily: "monospace", letterSpacing: "2px", textTransform: "uppercase" }}
									placeholder="如: WDJK72A9"
									value={userCode}
									onChange={(e) => setUserCode(e.target.value.toUpperCase())}
									disabled={deviceLoading || submitting}
								/>
								<button
									type="button"
									className="kb-btn kb-btn-ghost kb-btn-sm"
									disabled={deviceLoading || !userCode.trim()}
									onClick={() => fetchDeviceRequest(userCode.trim())}
								>
									{deviceLoading ? "查询中..." : "查询"}
								</button>
							</div>
							{deviceError && (
								<p style={{ color: "var(--error)", fontSize: "0.8rem", marginTop: "0.4rem" }}>
									{deviceError}
								</p>
							)}
						</div>

						{deviceInfo && (
							<div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
								{/* 客户端基本信息 */}
								<div style={{ padding: "0.875rem", borderRadius: "0.75rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)", border: "1px solid var(--line)" }}>
									<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
										<span style={{ fontSize: "0.85rem", fontWeight: 600 }}>请求客户端:</span>
										<span style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--primary)" }}>{deviceInfo.clientName}</span>
									</div>
									<div style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>
										请求状态: {deviceInfo.status} · 过期时间: {formatExpiry(deviceInfo.expiresAt)}
									</div>
								</div>

								{/* 知识库范围选择 */}
								<div>
									<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
										<label style={{ fontSize: "0.85rem", fontWeight: 600 }}>
											允许访问的知识库 (最少选择 1 个)
										</label>
										<button
											type="button"
											style={{ background: "none", border: "none", fontSize: "0.75rem", color: "var(--primary)", cursor: "pointer" }}
											onClick={() => {
												if (libraries.length > 0 && selectedLibIds.length === libraries.length) {
													setSelectedLibIds([]);
												} else {
													setSelectedLibIds(libraries.map((l) => l.id));
												}
											}}
										>
											{libraries.length > 0 && selectedLibIds.length === libraries.length ? "取消全选" : "全选"}
										</button>
									</div>

									{librariesError ? (
										<div style={{ fontSize: "0.8rem", color: "var(--error)", padding: "0.5rem 0" }}>
											{librariesError}
										</div>
									) : libraries.length === 0 ? (
										<div style={{ fontSize: "0.8rem", color: "var(--muted-text)", padding: "0.5rem 0" }}>
											您名下暂无可授权的知识库，请先在知识库首页创建。
										</div>
									) : (
										<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
											{libraries.map((lib) => {
												const checked = selectedLibIds.includes(lib.id);
												return (
													<label
														key={lib.id}
														style={{
															display: "flex",
															alignItems: "center",
															gap: "0.5rem",
															padding: "0.6rem 0.75rem",
															borderRadius: "0.5rem",
															border: checked ? "1px solid var(--primary)" : "1px solid var(--line)",
															background: checked ? "color-mix(in srgb, var(--primary) 8%, transparent)" : "transparent",
															cursor: "pointer",
															fontSize: "0.85rem",
														}}
													>
														<input
															type="checkbox"
															checked={checked}
															onChange={(e) => {
																if (e.target.checked) {
																	setSelectedLibIds([...selectedLibIds, lib.id]);
																} else {
																	setSelectedLibIds(selectedLibIds.filter((id) => id !== lib.id));
																}
															}}
														/>
														<Folder className="w-4 h-4 text-primary shrink-0" />
														<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
															{lib.title}
														</span>
													</label>
												);
											})}
										</div>
									)}
								</div>

								{/* Scope 权限勾选 */}
								<div>
									<label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem" }}>
										授予权限 (Scope 约束)
									</label>
									<div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
										{SCOPES_CONFIG.map((scope) => {
											// 只允许勾选客户端已申请的权限：未申请的置灰并注明
											const requested = deviceInfo.requestedScopes.includes(scope.id);
											const checked = selectedScopes.includes(scope.id);
											return (
												<label
													key={scope.id}
													style={{
														display: "flex",
														alignItems: "flex-start",
														gap: "0.6rem",
														padding: "0.6rem 0.75rem",
														borderRadius: "0.5rem",
														border: "1px solid var(--line)",
														background: checked ? "color-mix(in srgb, var(--primary) 5%, transparent)" : "transparent",
														cursor: requested ? "pointer" : "not-allowed",
														opacity: requested ? 1 : 0.55,
													}}
												>
													<input
														type="checkbox"
														style={{ marginTop: "0.2rem" }}
														checked={checked}
														disabled={!requested}
														onChange={(e) => {
															if (e.target.checked) {
																setSelectedScopes([...selectedScopes, scope.id]);
															} else {
																setSelectedScopes(selectedScopes.filter((s) => s !== scope.id));
															}
														}}
													/>
													<div style={{ flex: 1 }}>
														<div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
															<strong style={{ fontSize: "0.85rem" }}>{scope.label}</strong>
															<code style={{ fontSize: "0.7rem", opacity: 0.6 }}>{scope.id}</code>
															{scope.sensitive && (
																<span style={{ fontSize: "0.65rem", padding: "0.1rem 0.35rem", borderRadius: "0.25rem", background: "color-mix(in srgb, var(--warning) 20%, transparent)", color: "var(--warning)", fontWeight: 600 }}>
																	敏感权限
																</span>
															)}
															{!requested && (
																<span style={{ fontSize: "0.65rem", opacity: 0.7 }}>客户端未申请</span>
															)}
														</div>
														<p style={{ margin: "0.2rem 0 0 0", fontSize: "0.75rem", color: "var(--muted-text)" }}>
															{scope.desc}
														</p>
													</div>
												</label>
											);
										})}
									</div>
								</div>

								{/* 有效期选择 */}
								<div>
									<label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.4rem" }}>
										授权有效期
									</label>
									<select
										className="kb-input"
										style={{ width: "auto" }}
										value={expiresInDays}
										onChange={(e) => setExpiresInDays(Number(e.target.value))}
									>
										<option value={1}>1 天 (临时会话)</option>
										<option value={7}>7 天 (推荐默认)</option>
										<option value={30}>30 天 (长期连接)</option>
									</select>
									<span style={{ fontSize: "0.75rem", color: "var(--muted-text)", marginLeft: "0.75rem" }}>
										到期后 Token 自动失效，也可随时在用户中心一键撤销
									</span>
								</div>

								{submitError && (
									<div style={{ padding: "0.75rem", borderRadius: "0.5rem", background: "color-mix(in srgb, var(--error) 15%, transparent)", color: "var(--error)", fontSize: "0.85rem" }}>
										{submitError}
									</div>
								)}

								{/* 操作按钮 */}
								<div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", paddingTop: "1rem", borderTop: "1px solid var(--line)" }}>
									<button
										type="button"
										className="kb-btn kb-btn-ghost kb-btn-sm"
										disabled={submitting}
										onClick={handleDeny}
									>
										拒绝授权
									</button>
									<button
										type="button"
										className="kb-btn kb-btn-primary kb-btn-sm"
										disabled={submitting || !user}
										onClick={handleApprove}
									>
										{submitting ? "正在授权..." : "确认并批准授权"}
									</button>
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
