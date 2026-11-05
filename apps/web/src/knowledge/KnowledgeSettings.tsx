import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	AlertTriangle,
	ArrowLeft,
	BookOpen,
	Check,
	Clock,
	Database,
	FileText,
	Globe,
	HardDrive,
	Lock,
	RefreshCw,
	RotateCcw,
	Save,
	Settings,
	ShieldAlert,
	Trash2,
} from "lucide-react";
import { useAuth } from "../auth";
import { kbApi, KbApiError } from "./api";
import "./knowledge.css";
import type {
	KbQuotaUsage,
	KbVisibility,
	LibrarySummary,
	TrashedDocumentItem,
} from "./types";

export default function KnowledgeSettings() {
	const { libraryId: paramId } = useParams<{ libraryId: string }>();
	const navigate = useNavigate();
	const { user } = useAuth();
	const libraryId = Number(paramId);

	const [library, setLibrary] = useState<LibrarySummary | null>(null);
	const [quota, setQuota] = useState<KbQuotaUsage | null>(null);
	const [trashedItems, setTrashedItems] = useState<TrashedDocumentItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// 表单状态
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [visibility, setVisibility] = useState<KbVisibility>("private");
	const [saving, setSaving] = useState(false);
	const [saveSuccess, setSaveSuccess] = useState(false);

	// 危险操作：删除知识库状态
	const [deleteModalOpen, setDeleteModalOpen] = useState(false);
	const [deleteConfirmTitle, setDeleteConfirmTitle] = useState("");
	const [deleting, setDeleting] = useState(false);

	// 单个文档恢复状态
	const [restoringId, setRestoringId] = useState<number | null>(null);

	const loadData = async () => {
		if (!libraryId || Number.isNaN(libraryId)) return;
		setLoading(true);
		setError(null);
		try {
			const [lib, quotaRes, trashRes] = await Promise.all([
				kbApi.getLibrary(libraryId),
				kbApi.getQuota().catch(() => null),
				kbApi.listTrash(libraryId).catch(() => []),
			]);
			setLibrary(lib);
			setTitle(lib.title);
			setDescription(lib.description || "");
			setVisibility(lib.visibility);
			setQuota(quotaRes);
			setTrashedItems(trashRes);
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载知识库信息失败");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadData();
	}, [libraryId]);

	// 保存基本信息
	const handleSaveInfo = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!title.trim()) return;
		setSaving(true);
		setSaveSuccess(false);
		try {
			await kbApi.updateLibrary(libraryId, {
				title: title.trim(),
				description: description.trim(),
				visibility,
			});
			setSaveSuccess(true);
			setTimeout(() => setSaveSuccess(false), 3000);
		} catch (err) {
			alert(err instanceof Error ? err.message : "保存设置失败");
		} finally {
			setSaving(false);
		}
	};

	// 恢复回收站文档
	const handleRestoreDoc = async (docId: number) => {
		setRestoringId(docId);
		try {
			await kbApi.restoreDocument(docId);
			setTrashedItems((prev) => prev.filter((item) => item.id !== docId));
		} catch (err) {
			alert(err instanceof Error ? err.message : "恢复文档失败");
		} finally {
			setRestoringId(null);
		}
	};

	// 软删除知识库
	const handleDeleteLibrary = async () => {
		if (deleteConfirmTitle.trim() !== library?.title) {
			alert("输入的知识库名称不一致，已取消删除");
			return;
		}
		setDeleting(true);
		try {
			await kbApi.deleteLibrary(libraryId);
			navigate("/knowledge");
		} catch (err) {
			alert(err instanceof Error ? err.message : "删除知识库失败");
			setDeleting(false);
		}
	};

	const formatSize = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
	};

	const quotaPercent = quota && quota.maxBytes > 0
		? Math.min(100, Math.round((quota.usedBytes / quota.maxBytes) * 100))
		: 0;

	if (loading) {
		return (
			<div className="kb-container" style={{ textAlign: "center", padding: "5rem 0" }}>
				<RefreshCw className="w-8 h-8 animate-spin" style={{ margin: "0 auto 1rem auto", opacity: 0.6 }} />
				<p style={{ color: "var(--muted-text)" }}>正在加载知识库设置...</p>
			</div>
		);
	}

	if (error || !library) {
		return (
			<div className="kb-container">
				<div className="kb-card" style={{ textAlign: "center", padding: "3rem" }}>
					<AlertTriangle className="w-12 h-12 text-warning" style={{ margin: "0 auto 1rem auto" }} />
					<h2>加载失败</h2>
					<p style={{ color: "var(--muted-text)", margin: "1rem 0" }}>{error || "知识库不存在或已被删除"}</p>
					<Link to="/knowledge" className="kb-btn kb-btn-primary">返回知识库列表</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="kb-container">
			{/* 顶部面包屑与标题 */}
			<div className="kb-page-header">
				<div>
					<Link
						to={`/knowledge/${library.id}`}
						className="kb-btn kb-btn-ghost kb-btn-sm"
						style={{ marginBottom: "0.5rem", display: "inline-flex" }}
					>
						<ArrowLeft className="w-4 h-4" />
						返回工作台
					</Link>
					<h1 className="kb-page-title">
						<Settings className="w-7 h-7 text-primary" />
						知识库设置 - {library.title}
					</h1>
					<p className="kb-page-subtitle">管理知识库基本信息、存储配额与回收站</p>
				</div>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
				{/* 1. 基本信息设置卡片 */}
				<div className="kb-card">
					<h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: "0 0 1.25rem 0", display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<BookOpen className="w-5 h-5 text-primary" />
						基本信息
					</h2>

					<form onSubmit={handleSaveInfo}>
						<div className="kb-form-group">
							<label className="kb-label">知识库名称 *</label>
							<input
								type="text"
								className="kb-input"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								maxLength={120}
								required
							/>
						</div>

						<div className="kb-form-group">
							<label className="kb-label">描述</label>
							<textarea
								className="kb-textarea"
								style={{ minHeight: "5rem" }}
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								maxLength={500}
								placeholder="简要介绍这个知识库的用途与主题..."
							/>
						</div>

						<div className="kb-form-group">
							<label className="kb-label">可见性</label>
							<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "0.75rem", marginTop: "0.25rem" }}>
								<label
									className={`kb-card ${visibility === "private" ? "kb-card-hover" : ""}`}
									style={{
										padding: "0.85rem",
										cursor: "pointer",
										border: visibility === "private" ? "2px solid var(--primary)" : "1px solid var(--line)",
									}}
								>
									<input
										type="radio"
										name="visibility"
										value="private"
										checked={visibility === "private"}
										onChange={() => setVisibility("private")}
										style={{ marginRight: "0.5rem" }}
									/>
									<strong style={{ fontSize: "0.9rem" }}>私有知识库</strong>
									<p style={{ fontSize: "0.75rem", color: "var(--muted-text)", margin: "0.25rem 0 0 0" }}>仅所有者与被邀请成员可读写</p>
								</label>

								<label
									className={`kb-card ${visibility === "unlisted" ? "kb-card-hover" : ""}`}
									style={{
										padding: "0.85rem",
										cursor: "pointer",
										border: visibility === "unlisted" ? "2px solid var(--primary)" : "1px solid var(--line)",
									}}
								>
									<input
										type="radio"
										name="visibility"
										value="unlisted"
										checked={visibility === "unlisted"}
										onChange={() => setVisibility("unlisted")}
										style={{ marginRight: "0.5rem" }}
									/>
									<strong style={{ fontSize: "0.9rem" }}>仅链接分享</strong>
									<p style={{ fontSize: "0.75rem", color: "var(--muted-text)", margin: "0.25rem 0 0 0" }}>获得快照链接的用户可免登录阅读</p>
								</label>

								<label
									className={`kb-card ${visibility === "public" ? "kb-card-hover" : ""}`}
									style={{
										padding: "0.85rem",
										cursor: "pointer",
										border: visibility === "public" ? "2px solid var(--primary)" : "1px solid var(--line)",
									}}
								>
									<input
										type="radio"
										name="visibility"
										value="public"
										checked={visibility === "public"}
										onChange={() => setVisibility("public")}
										style={{ marginRight: "0.5rem" }}
									/>
									<strong style={{ fontSize: "0.9rem" }}>公开知识库</strong>
									<p style={{ fontSize: "0.75rem", color: "var(--muted-text)", margin: "0.25rem 0 0 0" }}>已发布快照允许在博客前台展示</p>
								</label>
							</div>
						</div>

						<div style={{ display: "flex", alignItems: "center", gap: "1rem", marginTop: "1.5rem" }}>
							<button type="submit" className="kb-btn kb-btn-primary" disabled={saving || !title.trim()}>
								<Save className="w-4 h-4" />
								{saving ? "正在保存..." : "保存修改"}
							</button>
							{saveSuccess && (
								<span style={{ color: "var(--primary)", fontSize: "0.85rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
									<Check className="w-4 h-4" />
									设置已更新
								</span>
							)}
						</div>
					</form>
				</div>

				{/* 2. 存储配额与空间占用卡片 */}
				<div className="kb-card">
					<h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: "0 0 1.25rem 0", display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<HardDrive className="w-5 h-5 text-primary" />
						存储配额与占用 (100 MiB 专属独立空间)
					</h2>

					{quota ? (
						<div>
							<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
								<span style={{ fontSize: "0.85rem", fontWeight: 600 }}>当前已用空间</span>
								<span style={{ fontSize: "0.85rem", fontFamily: "monospace", color: "var(--muted-text)" }}>
									{formatSize(quota.usedBytes)} / {formatSize(quota.maxBytes)} ({quotaPercent}%)
								</span>
							</div>

							<div className="kb-progress-bar-wrap">
								<div
									className="kb-progress-bar-inner"
									style={{
										width: `${quotaPercent}%`,
										backgroundColor: quotaPercent > 90 ? "#ef4444" : quotaPercent > 70 ? "#f59e0b" : "var(--primary)",
									}}
								/>
							</div>

							<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "1rem", marginTop: "1rem" }}>
								<div className="kb-card" style={{ padding: "0.75rem 1rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)" }}>
									<span style={{ fontSize: "0.75rem", color: "var(--faint-text)" }}>正文与修订历史</span>
									<span style={{ display: "block", fontSize: "0.95rem", fontWeight: 700, fontFamily: "monospace" }}>
										{formatSize(quota.breakdown.revisions)}
									</span>
								</div>
								<div className="kb-card" style={{ padding: "0.75rem 1rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)" }}>
									<span style={{ fontSize: "0.75rem", color: "var(--faint-text)" }}>文档私有附件</span>
									<span style={{ display: "block", fontSize: "0.95rem", fontWeight: 700, fontFamily: "monospace" }}>
										{formatSize(quota.breakdown.attachments)}
									</span>
								</div>
								<div className="kb-card" style={{ padding: "0.75rem 1rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)" }}>
									<span style={{ fontSize: "0.75rem", color: "var(--faint-text)" }}>批注与评论</span>
									<span style={{ display: "block", fontSize: "0.95rem", fontWeight: 700, fontFamily: "monospace" }}>
										{formatSize(quota.breakdown.comments)}
									</span>
								</div>
							</div>
						</div>
					) : (
						<p style={{ color: "var(--muted-text)", fontSize: "0.85rem" }}>正在获取配额统计...</p>
					)}
				</div>

				{/* 3. 回收站列表 */}
				<div className="kb-card">
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
						<h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
							<Trash2 className="w-5 h-5 text-warning" />
							回收站 ({trashedItems.length})
						</h2>
						<span style={{ fontSize: "0.75rem", color: "var(--muted-text)" }}>软删除文档保留 30 天</span>
					</div>

					{trashedItems.length === 0 ? (
						<div style={{ textAlign: "center", padding: "2rem 0", color: "var(--muted-text)", fontSize: "0.875rem" }}>
							回收站空空如也，未发现已删除的文档
						</div>
					) : (
						<div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
							{trashedItems.map((item) => (
								<div
									key={item.id}
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										padding: "0.65rem 1rem",
										borderRadius: "0.65rem",
										border: "1px solid var(--line)",
										background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)",
									}}
								>
									<div style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}>
										<FileText className="w-4 h-4 text-warning" style={{ flexShrink: 0 }} />
										<span style={{ fontWeight: 600, fontSize: "0.875rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
											{item.title || "未命名文档"}
										</span>
										<span style={{ fontSize: "0.75rem", color: "var(--faint-text)", flexShrink: 0 }}>
											删除于 {item.deletedAt.slice(0, 16)}
										</span>
									</div>

									<button
										type="button"
										className="kb-btn kb-btn-ghost kb-btn-sm"
										style={{ color: "var(--primary)" }}
										onClick={() => handleRestoreDoc(item.id)}
										disabled={restoringId === item.id}
									>
										<RotateCcw className="w-3.5 h-3.5" />
										{restoringId === item.id ? "恢复中..." : "一键恢复"}
									</button>
								</div>
							))}
						</div>
					)}
				</div>

				{/* 4. 危险操作区 (软删除整个库) */}
				<div className="kb-card" style={{ borderColor: "color-mix(in srgb, #ef4444 30%, var(--line))", background: "color-mix(in srgb, #ef4444 4%, var(--card-bg))" }}>
					<h2 style={{ fontSize: "1.15rem", fontWeight: 700, margin: "0 0 0.5rem 0", color: "#ef4444", display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<ShieldAlert className="w-5 h-5 text-error" />
						危险操作区
					</h2>
					<p style={{ fontSize: "0.85rem", color: "var(--muted-text)", margin: "0 0 1.25rem 0" }}>
						软删除该知识库会将库内所有文档与附件标记为删除，在 30 天保护期内不可直接访问。
					</p>

					<button
						type="button"
						className="kb-btn kb-btn-danger"
						onClick={() => {
							setDeleteConfirmTitle("");
							setDeleteModalOpen(true);
						}}
					>
						<Trash2 className="w-4 h-4" />
						删除此知识库
					</button>
				</div>
			</div>

			{/* 删除确认弹窗 */}
			{deleteModalOpen && (
				<div className="kb-modal-backdrop">
					<div className="kb-modal-box">
						<h3 className="kb-modal-title" style={{ color: "#ef4444" }}>
							<AlertTriangle className="w-6 h-6" />
							确认删除知识库？
						</h3>
						<p style={{ fontSize: "0.875rem", color: "var(--muted-text)", lineHeight: 1.6 }}>
							此操作将软删除知识库 <strong>{library.title}</strong>。为防止误删，请输入当前知识库的完整名称以确认：
						</p>

						<input
							type="text"
							className="kb-input"
							style={{ margin: "1rem 0" }}
							placeholder={library.title}
							value={deleteConfirmTitle}
							onChange={(e) => setDeleteConfirmTitle(e.target.value)}
							autoFocus
						/>

						<div className="kb-modal-actions">
							<button
								type="button"
								className="kb-btn kb-btn-ghost"
								onClick={() => setDeleteModalOpen(false)}
								disabled={deleting}
							>
								取消
							</button>
							<button
								type="button"
								className="kb-btn kb-btn-danger"
								disabled={deleting || deleteConfirmTitle.trim() !== library.title}
								onClick={handleDeleteLibrary}
							>
								{deleting ? "正在删除..." : "确认永久删除"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
