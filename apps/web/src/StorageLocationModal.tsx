import { AlertTriangle, ArrowRightLeft, CheckCircle2, Cloud, HardDrive, Loader2, RefreshCw, Server, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { StorageMigrationRecord, UserSpaceStats } from "./types";

const formatBytes = (n = 0) =>
	n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;

type StorageLocationModalProps = {
	open: boolean;
	mode: "initial" | "switch";
	currentLocation?: "server" | "cloudflare" | null;
	stats?: UserSpaceStats | null;
	onClose: () => void;
	onSuccess: () => void;
};

export function StorageLocationModal({
	open,
	mode,
	currentLocation = null,
	stats = null,
	onClose,
	onSuccess,
}: StorageLocationModalProps) {
	// 选中的存储类型
	const initialSelection =
		mode === "switch" && currentLocation
			? currentLocation === "server"
				? "cloudflare"
				: "server"
			: "server";

	const [selectedLocation, setSelectedLocation] = useState<"server" | "cloudflare">(initialSelection);
	const [confirmInvalidation, setConfirmInvalidation] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	// 迁移状态
	const [migrating, setMigrating] = useState(false);
	const [migrationProgress, setMigrationProgress] = useState<StorageMigrationRecord | null>(null);
	const [migrationCompleted, setMigrationCompleted] = useState(false);

	useEffect(() => {
		if (!open) return;
		setError("");
		setConfirmInvalidation(false);
		setBusy(false);
		setMigrating(false);
		setMigrationCompleted(false);

		const defaultTarget =
			mode === "switch" && currentLocation
				? currentLocation === "server"
					? "cloudflare"
					: "server"
				: "server";
		setSelectedLocation(defaultTarget);

		// 如果已有正在运行的迁移，直接恢复进度轮询
		if (stats?.activeMigration && stats.activeMigration.status === "processing") {
			setMigrating(true);
			setMigrationProgress(stats.activeMigration);
		}
	}, [open, mode, currentLocation, stats]);

	// 迁移中轮询进度
	useEffect(() => {
		if (!migrating) return;
		let timer: ReturnType<typeof setInterval> | null = null;

		const poll = async () => {
			try {
				const res = await api.getStorageMigrationProgress();
				if (res.migration) {
					setMigrationProgress(res.migration);
					if (res.migration.status === "completed") {
						setMigrating(false);
						setMigrationCompleted(true);
						if (timer) clearInterval(timer);
					} else if (res.migration.status === "failed") {
						setMigrating(false);
						setError(res.migration.errorMessage || "迁移过程中发生错误");
						if (timer) clearInterval(timer);
					}
				}
			} catch (e: any) {
				console.error("轮询迁移进度失败:", e);
			}
		};

		timer = setInterval(poll, 1200);
		void poll();

		return () => {
			if (timer) clearInterval(timer);
		};
	}, [migrating]);

	if (!open) return null;

	// 校验规则：
	// 1. 每月只能切换一次
	const isCooldownBlocked = mode === "switch" && stats?.canSwitchLocation === false;
	const cooldownMsg = stats?.switchBlockReason || (stats?.nextSwitchAvailableAt ? `下次可用切换时间：${new Date(stats.nextSwitchAvailableAt).toLocaleString()}` : "");

	// 2. CF 转服务器限制：已用空间 > 30MB
	const isOversizedBlocked =
		mode === "switch" &&
		currentLocation === "cloudflare" &&
		selectedLocation === "server" &&
		(stats?.usedBytes ?? 0) > 30 * 1024 * 1024;

	// 提交初次选择
	const handleInitialSubmit = async () => {
		setBusy(true);
		setError("");
		try {
			await api.setInitialStorageLocation(selectedLocation);
			onSuccess();
			onClose();
		} catch (e: any) {
			setError(e.message || "设置存储位置失败");
		} finally {
			setBusy(false);
		}
	};

	// 提交切换与迁移
	const handleSwitchSubmit = async () => {
		if (!confirmInvalidation) {
			setError("请勾选并确认原有链接失效风险");
			return;
		}
		setBusy(true);
		setError("");
		setMigrating(true);
		setMigrationCompleted(false);

		try {
			const res = await api.switchStorageLocation(selectedLocation, true);
			// 触发初始轮询
			const progressRes = await api.getStorageMigrationProgress().catch(() => null);
			if (progressRes?.migration) {
				setMigrationProgress(progressRes.migration);
			}
			if (res.success) {
				setMigrating(false);
				setMigrationCompleted(true);
			}
		} catch (e: any) {
			setMigrating(false);
			setError(e.message || "切换存储位置失败");
		} finally {
			setBusy(false);
		}
	};

	// 计算迁移百分比
	const progressPercent = migrationProgress?.totalFiles
		? Math.min(100, Math.round((migrationProgress.migratedFiles / migrationProgress.totalFiles) * 100))
		: 0;

	return (
		<div className="auth-overlay storage-modal-overlay">
			<div className="auth-dialog storage-location-modal">
				<header className="auth-dialog-heading">
					<div>
						<span className="auth-eyebrow">
							<HardDrive size={13} />
							{mode === "initial" ? "STORAGE PREFERENCE" : "STORAGE MIGRATION"}
						</span>
						<h2>{mode === "initial" ? "选择您的数据存储位置" : "更改数据存储服务"}</h2>
					</div>
					{/* 初次选择时若用户想稍后选择可关闭，若要求必须选择也可关闭（默认服务器） */}
					<button className="auth-close" type="button" onClick={onClose} title="关闭" disabled={migrating}>
						<X size={16} />
					</button>
				</header>

				{migrationCompleted ? (
					<div className="storage-complete-view">
						<div className="storage-complete-icon">
							<CheckCircle2 size={46} color="#10b981" />
						</div>
						<h3>存储位置切换与资源迁移完成！</h3>
						<p className="storage-complete-desc">
							您的资源已成功迁移至{" "}
							<strong>{selectedLocation === "cloudflare" ? "Cloudflare 对象存储" : "服务器本地存储"}</strong>
							。原有资源外链已按规则失效，系统已自动为所有资源生成新链接。
						</p>
						<button
							type="button"
							className="user-tool-button primary storage-btn-wide"
							onClick={() => {
								onSuccess();
								onClose();
							}}
						>
							完成并刷新空间
						</button>
					</div>
				) : migrating ? (
					<div className="storage-migration-view">
						<div className="storage-migrating-header">
							<Loader2 size={32} className="storage-spinner" />
							<div>
								<h3>正在迁移您的数据资源...</h3>
								<p>资源正在服务器与 Cloudflare 之间同步流转，请稍候不要关闭页面。</p>
							</div>
						</div>

						<div className="storage-progress-card">
							<div className="storage-progress-header">
								<span>迁移进度</span>
								<strong>{progressPercent}%</strong>
							</div>
							<div className="space-progress storage-progress-bar">
								<i style={{ width: `${progressPercent}%` }} />
							</div>
							<div className="storage-progress-meta">
								<span>
									文件数: {migrationProgress?.migratedFiles ?? 0} / {migrationProgress?.totalFiles ?? 0}
								</span>
								<span>
									数据量: {formatBytes(migrationProgress?.migratedBytes ?? 0)} / {formatBytes(migrationProgress?.totalBytes ?? 0)}
								</span>
							</div>
							{migrationProgress?.currentFile ? (
								<p className="storage-current-file">
									正在处理: <code>{migrationProgress.currentFile}</code>
								</p>
							) : null}
						</div>
					</div>
				) : (
					<div className="storage-select-view">
						<p className="auth-lead">
							{mode === "initial"
								? "欢迎加入博客！我们为每位用户提供专属的数据存储空间（包含图床、头像、评论图片及在线剪贴板）。请根据您的访问网络和空间需求选择："
								: `您当前使用的是【${currentLocation === "cloudflare" ? "Cloudflare 对象存储 (50MB)" : "服务器本地存储 (30MB)"}】。每个自然月可更改一次存储位置：`}
						</p>

						{isCooldownBlocked ? (
							<div className="storage-notice-banner warning">
								<ShieldAlert size={18} />
								<div>
									<strong>暂无法切换存储位置</strong>
									<p>{cooldownMsg || "每个用户每月仅允许更改一次存储位置。"}</p>
								</div>
							</div>
						) : null}

						{isOversizedBlocked ? (
							<div className="storage-notice-banner danger">
								<AlertTriangle size={18} />
								<div>
									<strong>已用空间超过 30MB 限制</strong>
									<p>
										您当前已用空间为 <strong>{formatBytes(stats?.usedBytes)}</strong>，超过了服务器存储的 30MB 配额上限。
										如需转回服务器存储，请先清理图床或剪贴板中的多余文件至 30MB 以下。
									</p>
								</div>
							</div>
						) : null}

						<div className="storage-options-grid">
							{/* 服务器本地存储 */}
							<div
								className={`storage-card-option ${selectedLocation === "server" ? "selected" : ""} ${
									mode === "switch" && currentLocation === "server" ? "is-current" : ""
								}`}
								onClick={() => {
									if (mode === "initial" || currentLocation !== "server") {
										setSelectedLocation("server");
									}
								}}
								role="button"
								tabIndex={0}
							>
								<div className="storage-card-header">
									<div className="storage-card-icon server">
										<Server size={22} />
									</div>
									<div className="storage-card-title">
										<h4>服务器本地存储</h4>
										<span className="storage-badge quota-30">30 MB 配额</span>
									</div>
								</div>
								<div className="storage-card-body">
									<ul className="storage-feature-list">
										<li>
											<span className="dot plus">✓</span> 国内网络访问极速、低延迟与高稳定性
										</li>
										<li>
											<span className="dot minus">!</span> 空间为 30MB，<strong>有助于帮助我们减轻服务器运营负担</strong>
										</li>
									</ul>
								</div>
								{currentLocation === "server" && mode === "switch" ? (
									<div className="storage-current-tag">当前使用中</div>
								) : null}
							</div>

							{/* Cloudflare 对象存储 */}
							<div
								className={`storage-card-option ${selectedLocation === "cloudflare" ? "selected" : ""} ${
									mode === "switch" && currentLocation === "cloudflare" ? "is-current" : ""
								}`}
								onClick={() => {
									if (mode === "initial" || currentLocation !== "cloudflare") {
										setSelectedLocation("cloudflare");
									}
								}}
								role="button"
								tabIndex={0}
							>
								<div className="storage-card-header">
									<div className="storage-card-icon cloudflare">
										<Cloud size={22} />
									</div>
									<div className="storage-card-title">
										<h4>Cloudflare 对象存储</h4>
										<span className="storage-badge quota-50">50 MB 空间 (推荐)</span>
									</div>
								</div>
								<div className="storage-card-body">
									<ul className="storage-feature-list">
										<li>
											<span className="dot plus">✓</span> <strong>可获得 50MB 空间</strong>，容量更充裕
										</li>
										<li>
											<span className="dot minus">!</span> 全球节点分发，<strong>但在大陆网络环境下访问体验不好</strong>
										</li>
									</ul>
								</div>
								{currentLocation === "cloudflare" && mode === "switch" ? (
									<div className="storage-current-tag">当前使用中</div>
								) : null}
							</div>
						</div>

						{/* 切换模式下的重要警告与确认框 */}
						{mode === "switch" ? (
							<div className="storage-migration-warning">
								<div className="warning-title">
									<AlertTriangle size={16} />
									<strong>资源迁移与原有链接失效重要提示</strong>
								</div>
								<ol className="warning-steps">
									<li>转换存储位置后，您的已有图片及剪贴板资源将自动迁移至目标存储。</li>
									<li>
										<strong>原有链接会立即失效</strong>：为保护安全与存储路由，原有的公开分享链接及下载直链将彻底作废，系统会自动生成全新链接。
									</li>
									<li>每个自然月仅可更改一次存储位置，请确认无误后操作。</li>
								</ol>
								<label className="storage-confirm-checkbox">
									<input
										type="checkbox"
										checked={confirmInvalidation}
										onChange={(e) => setConfirmInvalidation(e.target.checked)}
										disabled={isCooldownBlocked || isOversizedBlocked}
									/>
									<span>我已知晓转换存储位置后原有资源链接将全部失效，并确认执行迁移</span>
								</label>
							</div>
						) : null}

						{error ? <p className="auth-error">{error}</p> : null}

						<div className="storage-modal-actions">
							{mode === "initial" ? (
								<button
									type="button"
									className="auth-submit storage-submit-btn"
									disabled={busy}
									onClick={handleInitialSubmit}
								>
									{busy ? "正在保存..." : `确认选择（获得 ${selectedLocation === "cloudflare" ? "50MB" : "30MB"} 空间）`}
								</button>
							) : (
								<button
									type="button"
									className="auth-submit storage-submit-btn"
									disabled={
										busy ||
										!confirmInvalidation ||
										isCooldownBlocked ||
										isOversizedBlocked ||
										selectedLocation === currentLocation
									}
									onClick={handleSwitchSubmit}
								>
									<ArrowRightLeft size={16} />
									{busy
										? "正在发起迁移..."
										: selectedLocation === currentLocation
										? "已是当前存储位置"
										: `确认并迁移至 ${selectedLocation === "cloudflare" ? "Cloudflare (50MB)" : "服务器存储 (30MB)"}`}
								</button>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
