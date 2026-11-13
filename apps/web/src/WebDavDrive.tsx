import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
	AlertCircle,
	ArrowUp,
	Check,
	CheckCircle2,
	ChevronRight,
	Cloud,
	Copy,
	Download,
	File as FileIcon,
	FileArchive,
	FileAudio,
	FileCode2,
	FileImage,
	FileText,
	FileVideo,
	Folder,
	FolderOpen,
	FolderPlus,
	HardDrive,
	Info,
	KeyRound,
	Laptop,
	Loader2,
	Monitor,
	Pencil,
	RefreshCw,
	Smartphone,
	Terminal,
	Trash2,
	Upload,
	UserRound,
	X,
} from "lucide-react";
import { useAuth } from "./auth";
import "./WebDavDrive.css";

/**
 * WebDAV 云盘网页文件管理器。
 *
 * 用户端走 /api/user/drive，管理员端走 /api/admin/webdav，两端响应结构一致，
 * 因此共用 DriveBrowser 与挂载教程，只是鉴权头、外层卡片和入口不同。
 */

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
const USER_TOKEN_KEY = "site-user-token";
const ADMIN_TOKEN_KEY = "site-admin-token";
const ADMIN_USERNAME_KEY = "site-admin-username";
const ADMIN_AUTH_MESSAGE_KEY = "site-admin-auth-message";
const ADMIN_AUTH_EXPIRED_EVENT = "site-admin-auth-expired";

export type DriveItem = {
	id: number;
	name: string;
	path: string;
	type: "file" | "folder";
	mimeType: string;
	byteSize: number;
	updatedAt: string;
	etag: string;
};

export type DriveBreadcrumb = { name: string; path: string };

export type DriveQuota = {
	limitBytes: number;
	usedBytes: number;
	remainingBytes: number;
	fileCount: number;
	folderCount: number;
	driveBytes: number;
};

export type DriveWebdavInfo = {
	enabled: boolean;
	url: string;
	mountUrl?: string;
	username?: string;
};

export type DriveListing = {
	path: string;
	name?: string;
	breadcrumbs?: DriveBreadcrumb[];
	items?: DriveItem[];
	quota?: DriveQuota;
	webdav?: DriveWebdavInfo;
	storageLocation?: string;
};

type DriveMode = "user" | "admin";

class DriveAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DriveAuthError";
	}
}

function driveBase(mode: DriveMode) {
	return mode === "admin" ? "/api/admin/webdav" : "/api/user/drive";
}

function authHeaders(mode: DriveMode) {
	const headers = new Headers();
	const token = mode === "admin" ? sessionStorage.getItem(ADMIN_TOKEN_KEY) : localStorage.getItem(USER_TOKEN_KEY);
	if (token) headers.set("authorization", `Bearer ${token}`);
	return headers;
}

function expireAdminSession() {
	sessionStorage.removeItem(ADMIN_TOKEN_KEY);
	sessionStorage.removeItem(ADMIN_USERNAME_KEY);
	sessionStorage.setItem(ADMIN_AUTH_MESSAGE_KEY, "登录状态已失效，请重新输入管理员账号和密码。");
	window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
}

async function readError(response: Response) {
	const text = await response.text().catch(() => "");
	if (!text) return `请求失败（${response.status}）`;
	try {
		const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
		const message = typeof payload?.error === "string" ? payload.error : typeof payload?.message === "string" ? payload.message : "";
		if (message) return message;
	} catch {
		// 非 JSON 错误响应，直接展示截断后的文本
	}
	return text.slice(0, 200);
}

async function driveFetch(mode: DriveMode, path: string, options: RequestInit = {}) {
	const headers = authHeaders(mode);
	new Headers(options.headers).forEach((value, key) => headers.set(key, value));
	const response = await fetch(API_ORIGIN + driveBase(mode) + path, { ...options, headers });
	if (response.status === 401) {
		if (mode === "admin") {
			expireAdminSession();
			throw new DriveAuthError("管理员登录状态已失效，请重新登录。");
		}
		throw new DriveAuthError("登录状态已失效，请重新登录后继续。");
	}
	return response;
}

async function driveRequest<T>(mode: DriveMode, path: string, options: RequestInit = {}) {
	const response = await driveFetch(mode, path, options);
	if (!response.ok) throw new Error(await readError(response));
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

function describeError(error: unknown) {
	return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function formatBytes(value: number) {
	const bytes = Number(value);
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const amount = bytes / 1024 ** index;
	return `${index === 0 || amount >= 100 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

function pad2(value: number) {
	return String(value).padStart(2, "0");
}

function dateText(value: string) {
	if (!value) return "—";
	const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
	if (Number.isNaN(date.getTime())) return value;
	const now = new Date();
	const prefix = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}-`;
	return `${prefix}${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function storageLabel(location?: string) {
	if (location === "cloudflare") return "Cloudflare R2";
	if (location === "server") return "服务器本地存储";
	return "默认存储";
}

function nameProblem(value: string) {
	const name = value.trim();
	if (!name) return "名称不能为空";
	if (name === "." || name === "..") return "名称不能是 . 或 ..";
	if (/[\\/]/u.test(name)) return "名称不能包含斜杠";
	if (name.length > 255) return "名称不能超过 255 个字符";
	return "";
}

function nameOf(user: { nickname?: string; displayName?: string; username?: string; account?: string } | null) {
	if (!user) return "";
	return user.nickname?.trim() || user.displayName?.trim() || user.username || user.account || "用户";
}

async function copyText(value: string) {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(value);
			return;
		} catch {
			// 剪贴板权限被拒时回退到 execCommand
		}
	}
	const area = document.createElement("textarea");
	area.value = value;
	area.setAttribute("readonly", "true");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	const copied = document.execCommand("copy");
	area.remove();
	if (!copied) throw new Error("复制失败");
}

function itemIcon(item: DriveItem) {
	if (item.type === "folder") return <Folder size={19} />;
	const mime = (item.mimeType || "").toLowerCase();
	if (mime.startsWith("image/")) return <FileImage size={19} />;
	if (mime.startsWith("video/")) return <FileVideo size={19} />;
	if (mime.startsWith("audio/")) return <FileAudio size={19} />;
	if (mime.includes("zip") || mime.includes("tar") || mime.includes("rar") || mime.includes("7z") || mime.includes("gzip")) return <FileArchive size={19} />;
	if (mime.includes("json") || mime.includes("javascript") || mime.includes("xml") || mime.includes("html") || mime.includes("css") || item.name.match(/\.(?:js|ts|tsx|jsx|json|html|css|py|go|rs|java|c|cpp|sh|yml|yaml|toml)$/iu)) return <FileCode2 size={19} />;
	if (mime.startsWith("text/") || mime.includes("pdf") || mime.includes("word") || mime.includes("sheet") || mime.includes("presentation")) return <FileText size={19} />;
	return <FileIcon size={19} />;
}

type MountTab = { id: string; label: string; icon: typeof Monitor; steps: string[] };

const MOUNT_TABS: MountTab[] = [
	{
		id: "windows",
		label: "Windows",
		icon: Monitor,
		steps: [
			"打开「此电脑」或任意资源管理器窗口，右键选择「映射网络驱动器」。",
			"在「文件夹」中粘贴上方服务地址（以 https:// 开头、以 /dav 结尾）。",
			"勾选「使用其他凭据连接」，输入用户名和本站登录密码，完成后即可在资源管理器访问。",
		],
	},
	{
		id: "macos",
		label: "macOS",
		icon: Laptop,
		steps: [
			"在 Finder 菜单栏选择「前往」→「连接服务器」，或按 ⌘K。",
			"粘贴上方服务地址，点击「连接」。",
			"选择「注册用户」，输入用户名和本站登录密码，即可在 Finder 侧边栏访问。",
		],
	},
	{
		id: "mobile",
		label: "手机",
		icon: Smartphone,
		steps: [
			"安装支持 WebDAV 的文件管理器，例如 ES 文件浏览器、Documents 或 Solid Explorer。",
			"新建 WebDAV / 网络存储连接，填写服务地址、用户名和本站登录密码。",
			"若应用要求选择服务类型，请选择「其他 WebDAV 服务」或「Basic Auth」。",
		],
	},
	{
		id: "rclone",
		label: "rclone",
		icon: Terminal,
		steps: [
			"在电脑上运行 rclone config，新建 remote 并选择 WebDAV 类型。",
			"url 填上方服务地址，vendor 选择 other，填写用户名和本站登录密码。",
			"保存后运行 rclone lsd <remote>: 验证连接，即可用 rclone copy 同步文件。",
		],
	},
];

function QuotaSummary({ quota, storageLocation }: { quota?: DriveQuota; storageLocation?: string }) {
	if (!quota) return null;
	const limit = Math.max(0, Number(quota.limitBytes) || 0);
	const used = Math.max(0, Number(quota.usedBytes) || 0);
	const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
	const tone = percent >= 95 ? "danger" : percent >= 80 ? "warn" : "";
	return (
		<section className="drive-panel drive-summary" aria-label="存储配额">
			<div className="drive-panel-head drive-summary-head">
				<div>
					<div className="drive-panel-title">
						<HardDrive size={18} />
						<h3>存储配额</h3>
					</div>
					<p>云盘与图床、在线剪贴板共享账户配额，删除文件后空间会立即释放。</p>
				</div>
				<span className="drive-tag">{storageLabel(storageLocation)}</span>
			</div>
			<div className="drive-quota-line">
				<strong>{formatBytes(used)}</strong>
				<span>/ {limit > 0 ? formatBytes(limit) : "未限制"}</span>
				<em>{limit > 0 ? `${percent.toFixed(1)}%` : "不限容量"}</em>
			</div>
			<div
				className={`drive-quota-bar ${tone}`}
				role="progressbar"
				aria-label="已用配额"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(percent)}
			>
				<i style={{ width: `${percent}%` }} />
			</div>
			<div className="drive-summary-stats">
				<span>
					剩余空间
					<b>{formatBytes(quota.remainingBytes)}</b>
				</span>
				<span>
					文件
					<b>{Number(quota.fileCount) || 0}</b>
				</span>
				<span>
					文件夹
					<b>{Number(quota.folderCount) || 0}</b>
				</span>
				<span>
					云盘占用
					<b>{formatBytes(quota.driveBytes)}</b>
				</span>
			</div>
		</section>
	);
}

function MountPanel({ webdav, username, mode }: { webdav?: DriveWebdavInfo; username?: string; mode: DriveMode }) {
	const [tab, setTab] = useState(MOUNT_TABS[0].id);
	const [copied, setCopied] = useState("");
	const timerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);

	const copyValue = async (key: string, value: string) => {
		try {
			await copyText(value);
			setCopied(key);
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => setCopied(""), 1800);
		} catch {
			setCopied("");
		}
	};

	const address = (webdav?.mountUrl || webdav?.url || `${window.location.origin}/dav`).trim();
	const account = webdav?.username || username || "当前登录账号";
	const enabled = webdav?.enabled !== false;
	const activeTab = MOUNT_TABS.find((entry) => entry.id === tab) ?? MOUNT_TABS[0];

	return (
		<section className="drive-panel drive-mount" aria-labelledby="drive-mount-title">
			<div className="drive-panel-head">
				<div>
					<div className="drive-panel-title">
						<Cloud size={18} />
						<h3 id="drive-mount-title">挂载到你的设备</h3>
					</div>
					<p>使用 WebDAV 协议把这个云盘挂载成系统里的一个磁盘，像本地文件一样读写。</p>
				</div>
				<span className={`drive-tag ${enabled ? "is-on" : "is-off"}`}>{enabled ? "WebDAV 已启用" : "WebDAV 未启用"}</span>
			</div>
			{enabled ? null : (
				<div className="drive-mount-warning">
					<AlertCircle size={16} />
					<span>服务端当前未提供 WebDAV 挂载端点，以下信息仅供参考，请联系管理员在服务端开启。</span>
				</div>
			)}
			<div className="drive-credentials">
				<div className="drive-copy-field is-wide">
					<span>服务地址</span>
					<div className="drive-copy-value">
						<code title={address}>{address}</code>
						<button type="button" onClick={() => void copyValue("address", address)} aria-label="复制服务地址">
							{copied === "address" ? <Check size={14} /> : <Copy size={14} />}
							{copied === "address" ? "已复制" : "复制"}
						</button>
					</div>
				</div>
				<div className="drive-copy-field">
					<span>用户名</span>
					<div className="drive-copy-value">
						<code title={account}>{account}</code>
						<button type="button" onClick={() => void copyValue("account", account)} aria-label="复制用户名">
							{copied === "account" ? <Check size={14} /> : <Copy size={14} />}
							{copied === "account" ? "已复制" : "复制"}
						</button>
					</div>
				</div>
				<div className="drive-copy-field">
					<span>密码</span>
					<div className="drive-copy-value is-secret">
						<code>
							<KeyRound size={13} />
							{mode === "admin" ? "管理员登录密码" : "本站登录密码"}
						</code>
					</div>
				</div>
			</div>
			<div className="drive-mount-note">
				<Info size={15} />
				<span>
					使用 Basic Auth 认证，请始终通过 HTTPS 访问；密码与网页登录密码一致。
					{mode === "admin" ? "管理员账号在 WebDAV 中优先匹配，可管理管理员云盘空间。" : "忘记密码请在登录弹窗中使用找回功能。"}
				</span>
			</div>
			<div className="drive-tabs" role="tablist" aria-label="挂载教程">
				{MOUNT_TABS.map((entry) => {
					const Icon = entry.icon;
					return (
						<button
							key={entry.id}
							type="button"
							role="tab"
							aria-selected={entry.id === tab}
							className={entry.id === tab ? "is-active" : ""}
							onClick={() => setTab(entry.id)}
						>
							<Icon size={15} />
							{entry.label}
						</button>
					);
				})}
			</div>
			<div className="drive-tab-panel" role="tabpanel" aria-label={`${activeTab.label} 挂载步骤`}>
				<ol className="drive-steps">
					{activeTab.steps.map((step, index) => (
						<li key={step}>
							<span>{index + 1}</span>
							<p>{step}</p>
						</li>
					))}
				</ol>
			</div>
		</section>
	);
}

type DialogState = { kind: "folder" | "rename" | "delete"; item?: DriveItem };

function DriveDialog({
	state,
	draft,
	error,
	busy,
	onDraft,
	onClose,
	onSubmit,
}: {
	state: DialogState;
	draft: string;
	error: string;
	busy: boolean;
	onDraft: (value: string) => void;
	onClose: () => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (state.kind === "delete") return;
		const timer = window.setTimeout(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		}, 30);
		return () => window.clearTimeout(timer);
	}, [state.kind]);

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busy) onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [busy, onClose]);

	const title = state.kind === "folder" ? "新建文件夹" : state.kind === "rename" ? "重命名" : state.item?.type === "folder" ? "删除文件夹" : "删除文件";
	const confirmLabel = state.kind === "folder" ? "创建" : state.kind === "rename" ? "保存" : "删除";
	const description =
		state.kind === "delete"
			? `确定要删除「${state.item?.name ?? ""}」吗？`
			: state.kind === "rename"
				? `修改「${state.item?.name ?? ""}」的名称，文件内容不会改变。`
				: "在当前文件夹中创建一个新文件夹。";

	return (
		<div
			className="drive-modal-overlay"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
		>
			<form className={`drive-modal ${state.kind === "delete" ? "is-danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby="drive-modal-title" onSubmit={onSubmit}>
				<div className="drive-modal-head">
					<span className="drive-modal-icon">
						{state.kind === "folder" ? <FolderPlus size={20} /> : state.kind === "rename" ? <Pencil size={20} /> : <Trash2 size={20} />}
					</span>
					<div>
						<h3 id="drive-modal-title">{title}</h3>
						<p>{description}</p>
					</div>
					<button type="button" className="drive-icon-button" onClick={onClose} disabled={busy} aria-label="关闭">
						<X size={16} />
					</button>
				</div>
				{state.kind === "delete" ? (
					<p className="drive-modal-warning">
						<AlertCircle size={15} />
						{state.item?.type === "folder" ? "文件夹及其中的所有内容都会被删除，且无法恢复。" : "文件将被永久删除，且无法恢复。"}
					</p>
				) : (
					<label className="drive-modal-field">
						<span>{state.kind === "folder" ? "文件夹名称" : "新的名称"}</span>
						<input
							ref={inputRef}
							value={draft}
							onChange={(event) => onDraft(event.target.value)}
							placeholder={state.kind === "folder" ? "例如：项目资料" : "输入新的名称"}
							maxLength={255}
							disabled={busy}
						/>
					</label>
				)}
				{error ? (
					<p className="drive-modal-error" role="alert">
						{error}
					</p>
				) : null}
				<div className="drive-modal-actions">
					<button type="button" className="user-tool-button" onClick={onClose} disabled={busy}>
						取消
					</button>
					<button type="submit" className={`user-tool-button ${state.kind === "delete" ? "danger" : "primary"}`} disabled={busy || (state.kind !== "delete" && !draft.trim())}>
						{busy ? <Loader2 size={15} className="drive-spin" /> : null}
						{busy ? "处理中..." : confirmLabel}
					</button>
				</div>
			</form>
		</div>
	);
}

function DriveBrowser({ mode, username, onAuthExpired }: { mode: DriveMode; username?: string; onAuthExpired?: () => void }) {
	const [listing, setListing] = useState<DriveListing | null>(null);
	const [requestedPath, setRequestedPath] = useState("/");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [downloadingId, setDownloadingId] = useState<number | null>(null);
	const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [dialog, setDialog] = useState<DialogState | null>(null);
	const [draft, setDraft] = useState("");
	const [dialogError, setDialogError] = useState("");
	const [modalBusy, setModalBusy] = useState(false);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const loadSeq = useRef(0);
	const dragDepth = useRef(0);
	const authExpiredRef = useRef(onAuthExpired);

	useEffect(() => {
		authExpiredRef.current = onAuthExpired;
	}, [onAuthExpired]);

	const load = useCallback(
		async (targetPath: string) => {
			const seq = ++loadSeq.current;
			setRequestedPath(targetPath);
			setLoading(true);
			try {
				const data = await driveRequest<DriveListing>(mode, `?path=${encodeURIComponent(targetPath)}`);
				if (seq !== loadSeq.current) return;
				setListing(data);
				setError("");
			} catch (err) {
				if (seq !== loadSeq.current) return;
				setError(describeError(err));
				if (err instanceof DriveAuthError) authExpiredRef.current?.();
			} finally {
				if (seq === loadSeq.current) setLoading(false);
			}
		},
		[mode],
	);

	useEffect(() => {
		void load("/");
		return () => {
			loadSeq.current += 1;
		};
	}, [load]);

	useEffect(() => {
		if (!notice) return;
		const timer = window.setTimeout(() => setNotice(""), 5000);
		return () => window.clearTimeout(timer);
	}, [notice]);

	const currentPath = listing?.path || requestedPath;
	const items = useMemo(() => {
		const list = [...(listing?.items ?? [])];
		return list.sort((left, right) => {
			if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
			return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
		});
	}, [listing]);

	const breadcrumbs: DriveBreadcrumb[] = listing?.breadcrumbs?.length ? listing.breadcrumbs : [{ name: "根目录", path: "/" }];
	const parentPath = breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].path : "/";
	const atRoot = currentPath === "/" || breadcrumbs.length <= 1;

	const goTo = (target: string) => {
		if (busy) return;
		void load(target);
	};

	const openFolderDialog = () => {
		setDraft("新建文件夹");
		setDialogError("");
		setDialog({ kind: "folder" });
	};

	const openRenameDialog = (item: DriveItem) => {
		setDraft(item.name);
		setDialogError("");
		setDialog({ kind: "rename", item });
	};

	const openDeleteDialog = (item: DriveItem) => {
		setDialogError("");
		setDialog({ kind: "delete", item });
	};

	const closeDialog = () => {
		if (modalBusy) return;
		setDialog(null);
		setDialogError("");
	};

	const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!dialog) return;
		const name = draft.trim();
		if (dialog.kind !== "delete") {
			const problem = nameProblem(name);
			if (problem) {
				setDialogError(problem);
				return;
			}
		}
		setModalBusy(true);
		setDialogError("");
		try {
			if (dialog.kind === "folder") {
				await driveRequest<{ item: DriveItem }>(mode, "/folder", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: currentPath, name }),
				});
			} else if (dialog.kind === "rename" && dialog.item) {
				await driveRequest<{ item: DriveItem }>(mode, "", {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: dialog.item.path, name }),
				});
			} else if (dialog.kind === "delete" && dialog.item) {
				await driveRequest<void>(mode, `?path=${encodeURIComponent(dialog.item.path)}`, { method: "DELETE" });
			}
			setDialog(null);
			setNotice(dialog.kind === "folder" ? "文件夹已创建" : dialog.kind === "rename" ? "已重命名" : "已删除");
			await load(currentPath);
		} catch (err) {
			if (err instanceof DriveAuthError) authExpiredRef.current?.();
			setDialogError(describeError(err));
		} finally {
			setModalBusy(false);
		}
	};

	const uploadFiles = async (files: File[]) => {
		if (!files.length || busy) return;
		const targetPath = currentPath;
		setBusy(true);
		setError("");
		setNotice("");
		setProgress({ done: 0, total: files.length, current: files[0].name });
		let uploaded = 0;
		const failures: string[] = [];
		for (const file of files) {
			setProgress({ done: uploaded, total: files.length, current: file.name });
			try {
				const query = new URLSearchParams({ path: targetPath, name: file.name });
				const response = await driveFetch(mode, `/upload?${query.toString()}`, {
					method: "POST",
					headers: { "content-type": file.type || "application/octet-stream" },
					body: file,
				});
				if (!response.ok) throw new Error(await readError(response));
				uploaded += 1;
				setProgress({ done: uploaded, total: files.length, current: file.name });
			} catch (err) {
				if (err instanceof DriveAuthError) {
					failures.push(err.message);
					authExpiredRef.current?.();
					break;
				}
				failures.push(`${file.name}：${describeError(err)}`);
			}
		}
		setProgress(null);
		setBusy(false);
		if (uploaded > 0) {
			setNotice(uploaded === files.length ? `已上传 ${uploaded} 个文件` : `已上传 ${uploaded}/${files.length} 个文件`);
			await load(targetPath);
		}
		if (failures.length) {
			const suffix = failures.length > 3 ? `；另有 ${failures.length - 3} 个文件失败` : "";
			setError(`${failures.slice(0, 3).join("；")}${suffix}`);
		}
	};

	const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		event.target.value = "";
		if (files.length) void uploadFiles(files);
	};

	const downloadItem = async (item: DriveItem) => {
		setDownloadingId(item.id);
		setError("");
		try {
			const response = await driveFetch(mode, `/file?path=${encodeURIComponent(item.path)}`);
			if (!response.ok) throw new Error(await readError(response));
			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = item.name;
			document.body.appendChild(link);
			link.click();
			link.remove();
			window.setTimeout(() => window.URL.revokeObjectURL(url), 5000);
		} catch (err) {
			if (err instanceof DriveAuthError) authExpiredRef.current?.();
			setError(describeError(err));
		} finally {
			setDownloadingId(null);
		}
	};

	const canDrop = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types).includes("Files");

	const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
		if (!canDrop(event)) return;
		event.preventDefault();
		dragDepth.current += 1;
		setDragOver(true);
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!canDrop(event)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragOver(false);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragDepth.current = 0;
		setDragOver(false);
		if (busy) return;
		const files = Array.from(event.dataTransfer.files);
		if (files.length) void uploadFiles(files);
	};

	const progressPercent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

	return (
		<div className="drive-stack">
			<QuotaSummary quota={listing?.quota} storageLocation={listing?.storageLocation} />

			<section className="drive-panel drive-browser-panel" aria-label="云盘文件">
				<div className="drive-browser-head">
					<nav className="drive-breadcrumbs" aria-label="云盘路径">
						{breadcrumbs.map((crumb, index) => {
							const last = index === breadcrumbs.length - 1;
							const name = index === 0 && (!crumb.name || crumb.name === "/") ? "根目录" : crumb.name || "未命名";
							return (
								<Fragment key={`${crumb.path}-${index}`}>
									{index > 0 ? <ChevronRight size={14} className="drive-crumb-sep" aria-hidden="true" /> : null}
									<button
										type="button"
										className={last ? "is-current" : ""}
										aria-current={last ? "page" : undefined}
										onClick={() => goTo(crumb.path)}
										disabled={busy}
										title={crumb.path}
									>
										{index === 0 ? <HardDrive size={14} /> : null}
										{name}
									</button>
								</Fragment>
							);
						})}
					</nav>
					<div className="drive-browser-tools">
						<button type="button" className="drive-icon-button" onClick={() => goTo(parentPath)} disabled={atRoot || busy || loading} aria-label="返回上一级" title="返回上一级">
							<ArrowUp size={16} />
						</button>
						<button type="button" className="drive-icon-button" onClick={() => void load(currentPath)} disabled={busy || loading} aria-label="刷新列表" title="刷新列表">
							<RefreshCw size={16} className={loading ? "drive-spin" : ""} />
						</button>
					</div>
				</div>

				<div className="drive-toolbar">
					<div className="drive-toolbar-actions">
						<button type="button" className="user-tool-button primary" onClick={() => fileInputRef.current?.click()} disabled={busy || loading}>
							<Upload size={15} />
							上传文件
						</button>
						<button type="button" className="user-tool-button" onClick={openFolderDialog} disabled={busy || loading}>
							<FolderPlus size={15} />
							新建文件夹
						</button>
					</div>
					<span className="drive-count">
						{items.length} 项 · 当前目录：{currentPath === "/" ? "根目录" : currentPath}
					</span>
					<input ref={fileInputRef} className="drive-file-input" type="file" multiple onChange={handleFileInput} aria-hidden="true" tabIndex={-1} />
				</div>

				{progress ? (
					<div className="drive-progress" role="status">
						<Loader2 size={15} className="drive-spin" />
						<div>
							<span>
								正在上传 {Math.min(progress.done + (progress.done < progress.total ? 1 : 0), progress.total)}/{progress.total}：{progress.current}
							</span>
							<div className="drive-progress-track">
								<i style={{ width: `${progressPercent}%` }} />
							</div>
						</div>
					</div>
				) : null}

				{error ? (
					<div className="drive-alert is-error" role="alert">
						<AlertCircle size={16} />
						<span>{error}</span>
						<button type="button" onClick={() => void load(requestedPath)} disabled={loading}>
							重新加载
						</button>
					</div>
				) : null}

				{notice ? (
					<div className="drive-alert is-success" role="status">
						<CheckCircle2 size={16} />
						<span>{notice}</span>
						<button type="button" onClick={() => setNotice("")} aria-label="关闭提示">
							<X size={14} />
						</button>
					</div>
				) : null}

				<div
					className={`drive-list-wrap ${dragOver ? "is-dragover" : ""}`}
					onDragEnter={handleDragEnter}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onDrop={handleDrop}
				>
					{dragOver ? (
						<div className="drive-drop-hint">
							<Upload size={22} />
							<span>松开即可上传到当前文件夹</span>
						</div>
					) : null}
					{!listing ? (
						loading ? (
							<div className="drive-loading" role="status">
								<Loader2 size={22} className="drive-spin" />
								<p>正在加载云盘...</p>
							</div>
						) : null
					) : (
						<>
							<div className="drive-list-head" aria-hidden="true">
								<span>名称</span>
								<span>大小</span>
								<span>更新时间</span>
								<span className="drive-head-actions">操作</span>
							</div>
							<ul className={`drive-list ${loading ? "is-loading" : ""}`} aria-busy={loading}>
								{items.map((item) => (
									<li key={`${item.type}-${item.id}-${item.path}`} className="drive-row">
										<div className="drive-name-cell">
											<span className={`drive-file-icon ${item.type === "folder" ? "is-folder" : ""}`}>{itemIcon(item)}</span>
											<div className="drive-name-text">
												{item.type === "folder" ? (
													<button type="button" className="drive-name" onClick={() => goTo(item.path)} disabled={busy} title={`打开 ${item.name}`}>
														{item.name}
													</button>
												) : (
													<span className="drive-name" title={item.name}>
														{item.name}
													</span>
												)}
												<small className="drive-row-meta">
													{item.type === "folder" ? "文件夹" : formatBytes(item.byteSize)} · {dateText(item.updatedAt)}
												</small>
											</div>
										</div>
										<span className="drive-size">{item.type === "folder" ? "—" : formatBytes(item.byteSize)}</span>
										<time className="drive-time" dateTime={item.updatedAt}>
											{dateText(item.updatedAt)}
										</time>
										<span className="drive-actions">
											{item.type === "file" ? (
												<button
													type="button"
													className="drive-icon-button"
													onClick={() => void downloadItem(item)}
													disabled={busy || downloadingId === item.id}
													aria-label={`下载 ${item.name}`}
													title="下载"
												>
													{downloadingId === item.id ? <Loader2 size={16} className="drive-spin" /> : <Download size={16} />}
												</button>
											) : null}
											<button type="button" className="drive-icon-button" onClick={() => openRenameDialog(item)} disabled={busy} aria-label={`重命名 ${item.name}`} title="重命名">
												<Pencil size={16} />
											</button>
											<button
												type="button"
												className="drive-icon-button is-danger"
												onClick={() => openDeleteDialog(item)}
												disabled={busy}
												aria-label={`删除 ${item.name}`}
												title="删除"
											>
												<Trash2 size={16} />
											</button>
										</span>
									</li>
								))}
							</ul>
							{items.length === 0 && !loading ? (
								<div className="drive-empty">
									<FolderOpen size={38} />
									<h4>这个文件夹还是空的</h4>
									<p>上传文件或新建文件夹开始使用，也可以直接把文件拖到这里。</p>
									<button type="button" className="user-tool-button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
										<Upload size={15} />
										上传文件
									</button>
								</div>
							) : null}
						</>
					)}
				</div>
			</section>

			<MountPanel webdav={listing?.webdav} username={username} mode={mode} />

			{dialog ? (
				<DriveDialog
					state={dialog}
					draft={draft}
					error={dialogError}
					busy={modalBusy}
					onDraft={setDraft}
					onClose={closeDialog}
					onSubmit={(event) => void submitDialog(event)}
				/>
			) : null}
		</div>
	);
}

export function UserDrivePage() {
	const { user, refresh } = useAuth();
	const username = nameOf(user);
	return (
		<section className="card content-card user-tool-page webdav-drive">
			<header className="user-tool-heading">
				<div>
					<span className="tool-eyebrow">WEBDAV DRIVE</span>
					<h2>
						<Cloud size={22} />
						WebDAV 云盘
					</h2>
					<p>在浏览器里浏览、上传和管理文件，也可以使用 WebDAV 把云盘挂载到你的设备。</p>
				</div>
				{username ? (
					<div className="user-tool-heading-actions">
						<span className="drive-account-pill">
							<UserRound size={14} />
							{username}
						</span>
					</div>
				) : null}
			</header>
			<DriveBrowser mode="user" username={username} onAuthExpired={() => void refresh()} />
		</section>
	);
}

export function AdminDrivePage() {
	const username = sessionStorage.getItem(ADMIN_USERNAME_KEY) || "管理员";
	return (
		<div className="fa-page webdav-drive webdav-drive-admin">
			<div className="fa-page-heading">
				<div>
					<span className="fa-kicker">WEBDAV DRIVE</span>
					<h1>WebDAV 云盘</h1>
					<p>浏览和管理云盘文件；使用管理员账号可以把同一空间挂载到 Windows、macOS、手机或 rclone。</p>
				</div>
				<div className="fa-heading-action">
					<span className="drive-account-pill">
						<UserRound size={14} />
						{username}
					</span>
				</div>
			</div>
			<DriveBrowser mode="admin" username={username} />
		</div>
	);
}
