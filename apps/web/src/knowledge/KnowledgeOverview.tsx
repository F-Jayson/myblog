import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
	BookOpen,
	Bot,
	Clock,
	FileText,
	FolderPlus,
	Globe,
	HelpCircle,
	Lock,
	MessageSquarePlus,
	Plus,
	RefreshCw,
	Settings,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import { useAuth } from "../auth";
import { kbApi } from "./api";
import "./knowledge.css";
import type { KbEligibilityResponse, KbOpenApplication, LibrarySummary } from "./types";
import KnowledgeActivityGuide from "./KnowledgeActivityGuide";

export default function KnowledgeOverview() {
	const { user, openAuth } = useAuth();
	const navigate = useNavigate();

	const [eligibility, setEligibility] = useState<KbEligibilityResponse | null>(null);
	const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// 活跃度说明弹窗
	const [showActivityGuide, setShowActivityGuide] = useState(false);

	// 直接开通申请
	const [openApplication, setOpenApplication] = useState<KbOpenApplication | null>(null);
	const [showApplyModal, setShowApplyModal] = useState(false);
	const [applyReason, setApplyReason] = useState("");
	const [applying, setApplying] = useState(false);
	const [applyError, setApplyError] = useState<string | null>(null);

	// 新建知识库弹窗
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [creating, setCreating] = useState(false);

	const loadData = async () => {
		if (!user) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [elig, libs, application] = await Promise.all([
				kbApi.getEligibility().catch(() => null),
				kbApi.listLibraries(),
				kbApi.getOpenApplication().catch(() => null),
			]);
			setEligibility(elig);
			setLibraries(libs);
			setOpenApplication(application);
		} catch (err) {
			setError(err instanceof Error ? err.message : "获取知识库信息失败");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadData();
	}, [user]);

	const handleCreateLibrary = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newTitle.trim()) return;
		setCreating(true);
		try {
			const res = await kbApi.createLibrary({
				title: newTitle.trim(),
				description: newDesc.trim(),
				visibility: "private",
			});
			setShowCreateModal(false);
			setNewTitle("");
			setNewDesc("");
			navigate(`/knowledge/${res.id}`);
		} catch (err) {
			alert(err instanceof Error ? err.message : "创建失败");
		} finally {
			setCreating(false);
		}
	};

	const handleSubmitApplication = async (e: React.FormEvent) => {
		e.preventDefault();
		if (applyReason.trim().length < 10) {
			setApplyError("申请原因至少需要 10 个字");
			return;
		}
		setApplying(true);
		setApplyError(null);
		try {
			const application = await kbApi.submitOpenApplication(applyReason.trim());
			setOpenApplication(application);
			setShowApplyModal(false);
			setApplyReason("");
		} catch (err) {
			setApplyError(err instanceof Error ? err.message : "提交失败，请稍后重试");
		} finally {
			setApplying(false);
		}
	};

	if (!user) {
		return (
			<div className="kb-container" style={{ maxWidth: "38rem", textAlign: "center", padding: "4rem 1rem" }}>
				<div className="kb-card">
					<BookOpen className="w-16 h-16 text-primary" style={{ margin: "0 auto 1rem auto", opacity: 0.8 }} />
					<h2 style={{ fontSize: "1.5rem", fontWeight: 800, margin: "0 0 0.5rem 0" }}>个人知识库</h2>
					<p style={{ color: "var(--muted-text)", lineHeight: 1.6, margin: "0 0 1.5rem 0" }}>
						知识库面向注册满 14 天且近期活跃达标的普通用户开放。登录后即可查看您的准入进度或管理您的个人笔记。
					</p>
					<button
						type="button"
						onClick={() => openAuth("login")}
						className="kb-btn kb-btn-primary"
						style={{ padding: "0.6rem 2rem" }}
					>
						立即登录
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="kb-container">
			{/* 顶部标题与操作栏 */}
			<div className="kb-page-header">
				<div>
					<h1 className="kb-page-title">
						<BookOpen className="w-8 h-8 text-primary" />
						个人知识库
					</h1>
					<p className="kb-page-subtitle">
						持续修订的学习笔记、项目方案与长效知识沉淀 (不可变版本与 100 MiB 专属独立存储)
					</p>
				</div>

				<div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
					<Link to="/knowledge/mcp-help" className="kb-btn kb-btn-ghost">
						<Bot className="w-4 h-4" />
						MCP 接入帮助
					</Link>
					{eligibility && ["eligible", "active"].includes(eligibility.status) && (
						<button
							type="button"
							onClick={() => setShowCreateModal(true)}
							className="kb-btn kb-btn-primary"
						>
							<Plus className="w-4 h-4" />
							新建知识库
						</button>
					)}
				</div>
			</div>

			{/* 资格准入状态卡片 */}
			{eligibility && (
				<div
					className={`kb-card kb-eligibility-card ${
						eligibility.status === "grace" ? "is-grace" : eligibility.status === "read_only" ? "is-readonly" : ""
					}`}
				>
					<div className="kb-eligibility-top">
						<div style={{ display: "flex", alignItems: "flex-start", gap: "1rem" }}>
							{eligibility.status === "active" || eligibility.status === "eligible" ? (
								<ShieldCheck className="w-8 h-8 text-primary" style={{ flexShrink: 0 }} />
							) : eligibility.status === "grace" ? (
								<ShieldAlert className="w-8 h-8 text-warning" style={{ flexShrink: 0, color: "#f59e0b" }} />
							) : (
								<Lock className="w-8 h-8" style={{ flexShrink: 0, opacity: 0.5 }} />
							)}
							<div>
								<div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
									<h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>
										{eligibility.adminGranted && (eligibility.status === "active" || eligibility.status === "eligible")
											? "管理员已直接开通知识库"
											: eligibility.status === "active"
												? "知识库已开通 (正常使用中)"
												: eligibility.status === "eligible"
													? "准入达标，可创建个人知识库"
													: eligibility.status === "grace"
														? "活跃度下降 (14 天宽限期中)"
														: eligibility.status === "read_only"
															? "宽限期到期 (只读保护模式)"
															: eligibility.status === "suspended"
																? "账号权限受限"
																: "尚未达到知识库开通门槛"}
									</h3>
									<span className="kb-status-badge">
										综合活跃分: {eligibility.metrics.score} 分
									</span>
									<button
										type="button"
										className="kb-btn kb-btn-ghost kb-btn-xs"
										onClick={() => setShowActivityGuide(true)}
										style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}
									>
										<HelpCircle className="w-3.5 h-3.5" />
										活跃度怎么算？
									</button>
								</div>
								<p style={{ margin: "0.35rem 0 0 0", fontSize: "0.85rem", color: "var(--muted-text)" }}>
									{eligibility.status === "grace" &&
										`当前处于宽限期，剩余 ${eligibility.graceDaysRemaining ?? 14} 天。既有库可继续编辑，请尽快使用博客功能恢复活跃达标。`}
									{eligibility.status === "read_only" &&
										"只读保护中：您的名下知识库与正文保存已暂停，保留读取与导出权。恢复达标后将自动解除。"}
									{eligibility.status === "locked" &&
										`要求账号注册满 ${eligibility.thresholds.minAgeDays} 天且近 30 个自然日活跃综合评分达标。`}
									{(eligibility.status === "active" || eligibility.status === "eligible") &&
										(eligibility.adminGranted
											? "管理员已跳过注册时长和活跃度门槛。收回开通后，将重新按活跃度计算资格。"
											: "您拥有独立的 100 MiB 知识库存储额度与版本追溯保护。")}
								</p>
							</div>
						</div>

						{/* 进度概览指标 */}
						<div className="kb-metrics-row">
							<div className="kb-metric-item">
								<span className="kb-metric-label">有效登录(D)</span>
								<span className="kb-metric-value">
									{eligibility.metrics.loginDaysD} / {eligibility.thresholds.minLoginDaysD} 天
								</span>
							</div>
							<div className="kb-metric-divider" />
							<div className="kb-metric-item">
								<span className="kb-metric-label">服务行为(S)</span>
								<span className="kb-metric-value">
									{eligibility.metrics.serviceDaysS} / {eligibility.thresholds.minServiceDaysS} 天
								</span>
							</div>
							<div className="kb-metric-divider" />
							<div className="kb-metric-item">
								<span className="kb-metric-label">时间跨度(W)</span>
								<span className="kb-metric-value">
									{eligibility.metrics.timeWindowsW} / {eligibility.thresholds.minTimeWindowsW} 段
								</span>
							</div>
						</div>
					</div>

					{/* 缺少项提示 */}
					{eligibility.missingConditions.length > 0 && eligibility.status === "locked" && (
						<div style={{ paddingTop: "0.75rem", borderTop: "1px solid var(--line)" }}>
							<span style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--muted-text)", display: "block", marginBottom: "0.35rem" }}>
								距离开通还需满足以下条件：
							</span>
							<ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem", color: "var(--muted-text)" }}>
								{eligibility.missingConditions.map((cond, idx) => (
									<li key={idx} style={{ marginBottom: "0.2rem" }}>{cond}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			)}

			{/* 直接开通申请 */}
			{eligibility && !eligibility.adminGranted && ["locked", "grace", "read_only"].includes(eligibility.status) && (
				<div className="kb-card" style={{ marginBottom: "1.5rem" }}>
					<div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
						<div style={{ minWidth: 0, flex: "1 1 20rem" }}>
							<h3 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.35rem 0", display: "flex", alignItems: "center", gap: "0.45rem" }}>
								<MessageSquarePlus className="w-4 h-4 text-primary" />
								申请直接开通
							</h3>
							<p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted-text)", lineHeight: 1.75 }}>
								{openApplication?.status === "pending"
									? `申请已提交，正在等待管理员审核（提交于 ${openApplication.createdAt.slice(0, 16)}）。`
									: openApplication?.status === "rejected"
										? `上次申请未通过${openApplication.adminNote ? `：${openApplication.adminNote}` : "。"}你可以修改原因后重新提交。`
										: "如果活跃度短期内无法达标，可以填写原因申请管理员直接开通。审核通过后永久有效，不受活跃度下降影响。"}
							</p>
							{openApplication?.status === "pending" && (
								<p style={{ margin: "0.5rem 0 0 0", fontSize: "0.78rem", color: "var(--faint-text)", lineHeight: 1.7 }}>
									申请原因：{openApplication.reason}
								</p>
							)}
						</div>
						{openApplication?.status !== "pending" && (
							<button
								type="button"
								className="kb-btn kb-btn-primary kb-btn-xs"
								onClick={() => { setApplyError(null); setShowApplyModal(true); }}
								style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
							>
								<MessageSquarePlus className="w-3.5 h-3.5" />
								{openApplication?.status === "rejected" ? "重新申请" : "申请直接开通"}
							</button>
						)}
					</div>
				</div>
			)}

			{/* 错误提示 */}
			{error && (
				<div className="kb-card" style={{ borderColor: "#ef4444", marginBottom: "1.5rem" }}>
					<span style={{ color: "#ef4444" }}>{error}</span>
				</div>
			)}

			{/* 知识库列表 */}
			{loading ? (
				<div style={{ textAlign: "center", padding: "4rem 0" }}>
					<RefreshCw className="w-8 h-8 animate-spin" style={{ margin: "0 auto 1rem auto", opacity: 0.6 }} />
					<p style={{ color: "var(--muted-text)" }}>正在加载知识库...</p>
				</div>
			) : libraries.length === 0 ? (
				<div className="kb-card" style={{ textAlign: "center", padding: "4rem 1rem" }}>
					<FolderPlus className="w-12 h-12 text-primary" style={{ margin: "0 auto 1rem auto", opacity: 0.4 }} />
					<h3 style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0 0 0.5rem 0" }}>还没有知识库</h3>
					<p style={{ color: "var(--muted-text)", fontSize: "0.875rem", margin: "0 0 1.5rem 0" }}>
						创建一个知识库，开始系统化整理您的专属知识架构。
					</p>
					{eligibility && ["eligible", "active"].includes(eligibility.status) ? (
						<button
							type="button"
							onClick={() => setShowCreateModal(true)}
							className="kb-btn kb-btn-primary"
						>
							<Plus className="w-4 h-4" />
							创建第一个知识库
						</button>
					) : (
						<p style={{ fontSize: "0.8rem", color: "var(--faint-text)" }}>达到准入门槛后即可解锁创建</p>
					)}
				</div>
			) : (
				<div className="kb-grid">
					{libraries.map((lib) => (
						<div
							key={lib.id}
							className="kb-card kb-card-hover"
							style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
						>
							<div>
								<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
									<div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
										<span className="kb-status-badge">
											{lib.visibility === "private" && "私有"}
											{lib.visibility === "unlisted" && "仅链接"}
											{lib.visibility === "public" && "公开"}
										</span>
										{lib.role === "owner" && (
											<span className="kb-status-badge" style={{ background: "color-mix(in srgb, var(--primary) 20%, transparent)" }}>
												所有者
											</span>
										)}
									</div>
									<Link
										to={`/knowledge/${lib.id}/settings`}
										className="kb-btn kb-btn-ghost kb-btn-icon"
										title="库设置"
									>
										<Settings className="w-4 h-4" />
									</Link>
								</div>

								<Link to={`/knowledge/${lib.id}`} style={{ display: "block", textDecoration: "none" }}>
									<h2 style={{ fontSize: "1.2rem", fontWeight: 700, margin: "0 0 0.4rem 0", color: "var(--deep-text)" }}>
										{lib.title}
									</h2>
									<p style={{ fontSize: "0.85rem", color: "var(--muted-text)", lineHeight: 1.5, margin: 0, minHeight: "2.6rem" }}>
										{lib.description || "暂无描述信息"}
									</p>
								</Link>
							</div>

							<div
								style={{
									marginTop: "1.25rem",
									paddingTop: "0.85rem",
									borderTop: "1px solid var(--line)",
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									fontSize: "0.78rem",
									color: "var(--muted-text)",
								}}
							>
								<span style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontFamily: "monospace" }}>
									<FileText className="w-3.5 h-3.5" />
									{lib.documentCount} 篇文档
								</span>
								<span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
									<Clock className="w-3.5 h-3.5" />
									{lib.updatedAt.slice(0, 10)}
								</span>
							</div>
						</div>
					))}
				</div>
			)}

			{/* 新建知识库弹窗 */}
			{showCreateModal && (
				<div className="kb-modal-backdrop">
					<div className="kb-modal-box">
						<h3 className="kb-modal-title">
							<Sparkles className="w-5 h-5 text-primary" />
							新建知识库
						</h3>
						<form onSubmit={handleCreateLibrary}>
							<div className="kb-form-group">
								<label className="kb-label">知识库名称 *</label>
								<input
									type="text"
									className="kb-input"
									placeholder="例如：后端核心技术指南"
									value={newTitle}
									onChange={(e) => setNewTitle(e.target.value)}
									maxLength={120}
									required
									autoFocus
								/>
							</div>
							<div className="kb-form-group">
								<label className="kb-label">描述 (可选)</label>
								<textarea
									className="kb-textarea"
									style={{ minHeight: "5rem" }}
									placeholder="简述知识库的核心内容与定位..."
									value={newDesc}
									onChange={(e) => setNewDesc(e.target.value)}
									maxLength={500}
								/>
							</div>
							<div className="kb-modal-actions">
								<button
									type="button"
									onClick={() => setShowCreateModal(false)}
									className="kb-btn kb-btn-ghost"
									disabled={creating}
								>
									取消
								</button>
								<button
									type="submit"
									className="kb-btn kb-btn-primary"
									disabled={creating || !newTitle.trim()}
								>
									{creating ? "创建中..." : "确定创建"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			<KnowledgeActivityGuide
				open={showActivityGuide}
				onClose={() => setShowActivityGuide(false)}
				thresholds={eligibility?.thresholds ?? { minScore: 60, minLoginDaysD: 10, minServiceDaysS: 6, minTimeWindowsW: 2, minAgeDays: 14 }}
			/>

			{showApplyModal && (
				<div className="kb-modal-overlay" role="presentation" onClick={() => { if (!applying) setShowApplyModal(false); }}>
					<div className="kb-modal-card" role="dialog" aria-modal="true" aria-labelledby="kb-apply-title" onClick={(event) => event.stopPropagation()}>
						<div className="kb-modal-header">
							<h3 className="kb-modal-title" id="kb-apply-title">
								<MessageSquarePlus className="w-5 h-5 text-primary" />
								申请直接开通知识库
							</h3>
						</div>
						<form onSubmit={handleSubmitApplication}>
							<p style={{ margin: "0 0 0.75rem 0", fontSize: "0.82rem", color: "var(--muted-text)", lineHeight: 1.75 }}>
								请说明为什么需要直接开通（例如：刚迁移过来、历史内容较多、活跃度统计来不及等）。管理员审核通过后会永久开通，不受活跃度下降影响。
							</p>
							<textarea
								className="kb-textarea"
								style={{ minHeight: "7rem" }}
								placeholder="至少填写 10 个字..."
								value={applyReason}
								onChange={(event) => setApplyReason(event.target.value)}
								maxLength={1000}
								autoFocus
							/>
							<div style={{ textAlign: "right", fontSize: "0.72rem", color: "var(--faint-text)", marginTop: "0.25rem" }}>
								{applyReason.trim().length} / 1000
							</div>
							{applyError && (
								<p style={{ margin: "0.5rem 0 0 0", fontSize: "0.8rem", color: "#ef4444" }}>{applyError}</p>
							)}
							<div className="kb-modal-actions">
								<button
									type="button"
									className="kb-btn kb-btn-ghost"
									onClick={() => setShowApplyModal(false)}
									disabled={applying}
								>
									取消
								</button>
								<button
									type="submit"
									className="kb-btn kb-btn-primary"
									disabled={applying || applyReason.trim().length < 10}
								>
									{applying ? "提交中..." : "提交申请"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
