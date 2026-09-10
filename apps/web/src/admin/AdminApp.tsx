import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  Archive,
  Ban,
  Bell,
  BookOpen,
  Boxes,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cpu,
  Database,
  Eye,
  ExternalLink,
  FileText,
  FileAudio,
  Gauge,
  Globe2,
  Home,
  HardDrive,
  Image as ImageIcon,
  Info,
  LayoutDashboard,
  Link2,
  List,
  LogOut,
  Mail,
  Menu,
  MemoryStick,
  MessageCircle,
  Music2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Smile,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Type,
  Upload,
  UserCheck,
  UserCog,
  UserRound,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import MdEditorBridge from "./MdEditorBridge";
import type { Post, SiteData } from "../types";
import "./admin.css";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "")
  .trim()
  .replace(/\/+$/u, "");

function resolveAdminMediaUrl(value: string | null | undefined) {
  const source = typeof value === "string" ? value.trim() : "";
  if (/^\/api\/(?:uploads|public\/resources|user\/storage|admin\/user-space)(?:\/|$)/u.test(source)) return `${API_ORIGIN}${source}`;
  return source;
}
const ADMIN_REQUEST_ERROR_EVENT = "firefly-admin-request-error";
const ADMIN_AUTH_EXPIRED_EVENT = "firefly-admin-auth-expired";
const ADMIN_AUTH_MESSAGE_KEY = "firefly-admin-auth-message";

type AdminPost = Post & { status: "draft" | "published" };
type AdminComment = {
  id: number;
  postId: number | null;
  authorName: string;
  authorEmail: string | null;
  authorAvatar?: string | null;
  userId?: number | string | null;
  parentId?: number | null;
  body: string;
  status: "pending" | "approved" | "spam" | "rejected";
  createdAt: string;
  postTitle: string | null;
  ip?: string | null;
  ipLocation?: string | null;
  device?: string | null;
  browser?: string | null;
  userAgent?: string | null;
  isAdmin?: boolean;
  isAnonymous?: boolean;
  floor?: number | null;
};
type AdminFeedbackStatus = "open" | "processing" | "resolved";
type AdminFeedbackItem = {
  id: number;
  category: string;
  subject: string;
  content: string;
  contact: string;
  pageUrl: string;
  status: AdminFeedbackStatus;
  clientIp: string;
  clientUa: string;
  createdAt: string;
  updatedAt: string;
};
type AnnouncementHistoryItem = {
  id?: string | number;
  content: string;
  publishedAt: string;
  updatedAt: string;
  isVisible: boolean;
  isPinned: boolean;
  sortOrder: number;
  isCurrent?: boolean;
  readOnly?: boolean;
};
type AnnouncementState = {
  content: string;
  updatedAt: string;
  storage?: string;
  items?: AnnouncementHistoryItem[];
};
type DashboardStatus = {
  administrator?: { name?: string };
  startedAt?: string;
  checkedAt?: string;
  lastSyncAt?: string | null;
  lastDatabaseActivityAt?: string | null;
  database?: {
    connected?: boolean;
    checkedAt?: string;
    lastActivityAt?: string | null;
    lastWriteAt?: string | null;
    database?: {
      name?: string;
      host?: string;
      version?: string | null;
      configuredConnectionLimit?: number;
      activeConnections?: number | null;
      idleConnections?: number | null;
      totalConnections?: number | null;
    };
  };
};
type MonitoringData = {
  available?: boolean; hours: number; generatedAt: string; thresholds: { slowRequestMs: number; slowSqlMs: number };
  resources: { server: { hostname: string; platform: string; arch: string; cpu: { cores: number; model: string; load1: number; load5: number; load15: number; usagePercent?: number | null }; memory: { totalBytes: number; freeBytes: number; usedBytes: number }; disk: { path: string; totalBytes: number; freeBytes: number; usedBytes: number } | null; process: { pid: number; name?: string; cpuPercent?: number; node: string; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number }; processes?: Array<{ pid: number; name?: string; cpuPercent?: number; node?: string; uptimeSeconds?: number; rssBytes?: number }> }; project: { name: string; startedAt: string; database: DashboardStatus["database"] } };
  summary: { total: number; errors: number; slow: number; averageResponseMs: number; peakResponseMs: number; slowSql: number; sql: { total: number; errors: number; slow: number; averageMs: number; peakMs: number } };
  trend: Array<{ at: string; requests: number; errors: number; slowRequests: number; averageResponseMs: number; averageSqlMs: number }> ;
  paths: Array<{ method: string; path: string; requests: number; errors: number; averageResponseMs: number; peakResponseMs: number; errorRate: number }> ;
  recent: Array<{ type: string; at: string; method: string; path: string; status: number; durationMs: number }> ;
  dataScope?: string;
};

type MediaKind = "image" | "font" | "audio";
type UploadedMedia = {
  url?: string;
  path?: string;
  kind?: MediaKind;
  name?: string;
  size?: number;
  mimeType?: string;
};
type SiteLink = { label: string; url: string; icon?: string };
type SiteSettingsForm = {
  title: string;
  subtitle: string;
  description: string;
  hue: number;
  videoUploadMaxSizeMb: number;
  videoAutoTranscodeEnabled: boolean;
  siteFavicon: string;
  cover: {
    mode: "upload" | "url" | "api";
    value: string;
    apiUrl: string;
    position: string;
  };
  titleConfig: {
    title: string;
    subtitle: string;
    subtitleMode: "text" | "hitokoto";
    hitokotoApi: string;
    titleFontUrl: string;
    subtitleFontUrl: string;
    postTitleFontUrl: string;
    bodyFontUrl: string;
    postContentFontUrl: string;
    tagFontUrl: string;
  };
  music: {
    enabled: boolean;
    src: string;
    title: string;
    artist: string;
    cover: string;
    autoplay: boolean;
    loop: boolean;
  };
  author: {
    name: string;
    bio: string;
    avatar: string;
    email: string;
    githubUrl: string;
    qqUrl: string;
    rssUrl: string;
    links: SiteLink[];
  };
};

const DEFAULT_SITE_SETTINGS: SiteSettingsForm = {
  title: "Firefly",
  subtitle: "飞萤之火，自无梦的长夜亮起。",
  description: "",
  hue: 165,
  videoUploadMaxSizeMb: 1024,
  videoAutoTranscodeEnabled: false,
  siteFavicon: "",
  cover: {
    mode: "upload",
    value: "",
    apiUrl: "https://api.dujin.org/bing/1920.php",
    position: "50% 50%",
  },
  titleConfig: {
    title: "Firefly",
    subtitle: "飞萤之火，自无梦的长夜亮起。",
    subtitleMode: "text",
    hitokotoApi: "https://v1.hitokoto.cn/?encode=json",
    titleFontUrl: "",
    subtitleFontUrl: "",
    postTitleFontUrl: "",
    bodyFontUrl: "",
    postContentFontUrl: "",
    tagFontUrl: "",
  },
  music: {
    enabled: true,
    src: "",
    title: "",
    artist: "",
    cover: "",
    autoplay: false,
    loop: true,
  },
  author: {
    name: "Firefly",
    bio: "记录生活与技术，也收藏沿途的光。",
    avatar: "",
    email: "",
    githubUrl: "",
    qqUrl: "",
    rssUrl: "/rss.xml",
    links: [],
  },
};

class AdminHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminHttpError";
    this.status = status;
  }
}

const OPEN_SOURCE_COMPONENTS = [
  { name: "React / React DOM", license: "MIT License" },
  { name: "React Router", license: "MIT License" },
  { name: "Vue", license: "MIT License" },
  { name: "md-editor-v3", license: "MIT License" },
  { name: "Lucide", license: "ISC License" },
  { name: "Marked", license: "MIT License" },
  { name: "DOMPurify", license: "MPL-2.0 OR Apache-2.0" },
  { name: "Express / CORS", license: "MIT License" },
  { name: "mysql2", license: "MIT License" },
  { name: "Zod", license: "MIT License" },
  { name: "dotenv", license: "BSD-2-Clause" },
  { name: "Vite / React plugin", license: "MIT License" },
  { name: "TypeScript", license: "Apache-2.0" },
] as const;

async function adminRequest<T>(
  path: string,
  options: RequestInit = {},
  reportError = true,
): Promise<T> {
  const token = sessionStorage.getItem("firefly-admin-token");
  const headers = new Headers(options.headers);
  if (
    options.body &&
    !(options.body instanceof FormData) &&
    !headers.has("content-type")
  )
    headers.set("content-type", "application/json");
  if (token) headers.set("authorization", "Bearer " + token);
  let response: Response;
  try {
    response = await fetch(API_ORIGIN + path, { ...options, headers });
  } catch (requestError) {
    const message =
      requestError instanceof Error
        ? requestError.message
        : "无法连接到内容服务";
    if (reportError)
      window.dispatchEvent(
        new CustomEvent<string>(ADMIN_REQUEST_ERROR_EVENT, { detail: message }),
      );
    throw requestError;
  }
  if (response.status === 401) {
    sessionStorage.removeItem("firefly-admin-token");
    sessionStorage.removeItem("firefly-admin-username");
    sessionStorage.setItem(
      ADMIN_AUTH_MESSAGE_KEY,
      "登录状态已失效，请重新输入管理员账号和密码。",
    );
    window.dispatchEvent(new Event(ADMIN_AUTH_EXPIRED_EVENT));
    throw new Error("登录状态已失效");
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    const message = payload?.error ?? response.statusText ?? "请求失败";
    if (reportError)
      window.dispatchEvent(
        new CustomEvent<string>(ADMIN_REQUEST_ERROR_EVENT, { detail: message }),
      );
    throw new AdminHttpError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function adminRequestCompatible<T>(
  paths: readonly string[],
  options: RequestInit = {},
): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < paths.length; index += 1) {
    try {
      return await adminRequest<T>(
        paths[index],
        options,
        index === paths.length - 1,
      );
    } catch (error) {
      lastError = error;
      if (error instanceof AdminHttpError && error.status === 401) throw error;
      if (index < paths.length - 1) continue;
    }
  }
  throw lastError ?? new Error("请求失败");
}

const MEDIA_UPLOAD_ENDPOINTS = [
  "/api/admin/uploads",
  "/api/admin/media/upload",
] as const;

async function uploadAdminMedia(file: File, kind: MediaKind) {
  const limits: Record<MediaKind, number> = {
    image: 10 * 1024 * 1024,
    font: 12 * 1024 * 1024,
    audio: 50 * 1024 * 1024,
  };
  if (!file.size) throw new Error("不能上传空文件。");
  if (file.size > limits[kind])
    throw new Error(
      `${kind === "image" ? "图片" : kind === "font" ? "字体" : "音乐"}文件过大。`,
    );
  const formData = new FormData();
  formData.append("file", file);
  formData.append("kind", kind);
  formData.append("fileName", file.name);
  const result = await adminRequestCompatible<UploadedMedia>(
    MEDIA_UPLOAD_ENDPOINTS,
    { method: "POST", body: formData },
  );
  const url = (result.url ?? result.path ?? "").trim();
  if (!url) throw new Error("上传成功，但服务端没有返回文件地址。");
  return url;
}

function AdminMediaUpload({
  kind,
  accept,
  label,
  onUploaded,
  onError,
  disabled = false,
  onUploadingChange,
}: {
  kind: MediaKind;
  accept: string;
  label: string;
  onUploaded: (url: string, file: File) => void;
  onError: (error: unknown) => void;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const mountedRef = useRef(true);
  const onUploadingChangeRef = useRef(onUploadingChange);

  useEffect(() => {
    onUploadingChangeRef.current = onUploadingChange;
  }, [onUploadingChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setUploadState = (next: boolean) => {
    if (uploadingRef.current === next) return;
    uploadingRef.current = next;
    onUploadingChangeRef.current?.(next);
    if (mountedRef.current) setUploading(next);
  };

  return (
    <label className="fa-upload-button">
      <input
        type="file"
        accept={accept}
        disabled={disabled || uploading}
        onChange={(event) => {
          if (disabled || uploadingRef.current) return;
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setUploadState(true);
          void uploadAdminMedia(file, kind)
            .then((url) => {
              if (mountedRef.current) onUploaded(url, file);
            })
            .catch((error) => {
              if (mountedRef.current) onError(error);
            })
            .finally(() => setUploadState(false));
        }}
      />
      {uploading ? (
        <RefreshCw size={15} className="fa-spin" />
      ) : (
        <Upload size={15} />
      )}
      {uploading ? "上传中" : label}
    </label>
  );
}

function errorText(value: unknown, fallback = "操作失败，请稍后重试。") {
  return value instanceof Error && value.message ? value.message : fallback;
}

function dateText(value: string | null | undefined) {
  if (!value) return "尚未发布";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
function bytesText(value: number | null | undefined) {
  if (!value || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return (value / 1024 ** index).toFixed(index > 1 ? 1 : 0) + " " + units[index];
}
function percent(value: number, total: number) { return total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0; }

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const normalized = value.trim().replace(" ", "T");
  const localLike = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u);
  if (localLike && !/[zZ]|[+-]\d{2}:?\d{2}$/u.test(normalized))
    return localLike[1] + "T" + localLike[2];
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return localLike ? localLike[1] + "T" + localLike[2] : "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s/-]/gu, "")
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function postSlug(slug: string, title: string) {
  return slugify(slug) || slugify(title) || "post-" + Date.now();
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="fa-page-heading">
      <div>
        <span className="fa-kicker">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="fa-heading-action">{action}</div> : null}
    </div>
  );
}

function PrimaryButton({
  children,
  type = "button",
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="fa-button fa-button-primary"
      type={type}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  type = "button",
  onClick,
  disabled = false,
}: {
  children: ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="fa-button fa-button-ghost"
      type={type}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function EmptyState({ children = "暂无内容" }: { children?: ReactNode }) {
  return (
    <div className="fa-empty">
      <MoreHorizontal size={22} />
      <span>{children}</span>
    </div>
  );
}

function AdminLogin() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(
    () => sessionStorage.getItem(ADMIN_AUTH_MESSAGE_KEY) ?? "",
  );
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    sessionStorage.removeItem(ADMIN_AUTH_MESSAGE_KEY);
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(API_ORIGIN + "/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
        token?: string;
        username?: string;
        user?: { username?: string };
      } | null;
      if (!response.ok)
        throw new Error(payload?.error ?? payload?.message ?? "账号或密码错误");
      const sessionToken = payload?.token?.trim() ?? "";
      const returnedUsername =
        payload?.user?.username?.trim() || payload?.username?.trim() || username.trim();
      if (!sessionToken || !returnedUsername)
        throw new Error("登录响应无效，请联系系统管理员。");
      sessionStorage.setItem("firefly-admin-token", sessionToken);
      sessionStorage.setItem("firefly-admin-username", returnedUsername);
      navigate("/admin");
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "登录失败",
      );
    } finally {
      setLoading(false);
    }
  };
  return (
    <main className="fa-login-page">
      <div className="fa-login-visual">
        <div className="fa-login-orbit" />
        <div className="fa-login-copy">
          <span className="fa-kicker">FIREFLY CONTENT STUDIO</span>
          <h1>让每一次记录，都有清晰的落点。</h1>
          <p>文章、公告、评论与站点设置，在一个安静而高效的工作区完成。</p>
        </div>
      </div>
      <form className="fa-login-card" onSubmit={submit}>
        <div className="fa-login-mark">
          <ShieldCheck size={26} />
        </div>
        <span className="fa-kicker">ADMIN ACCESS</span>
        <h2>进入管理后台</h2>
        <p>请输入管理员账号和密码以继续。</p>
        <label>
          管理员账号
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoFocus
            autoComplete="username"
            placeholder="输入管理员账号"
            required
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="输入密码"
            required
          />
        </label>
        {error ? <div className="fa-error">{error}</div> : null}
        <PrimaryButton type="submit" disabled={loading}>
          {loading ? (
            <>
              <RefreshCw size={16} className="fa-spin" />
              验证凭据中
            </>
          ) : (
            <>
              <Zap size={16} />
              进入工作区
            </>
          )}
        </PrimaryButton>
        <Link className="fa-login-back" to="/">
          <Home size={15} />
          返回前台
        </Link>
      </form>
    </main>
  );
}

type NavItem = { href: string; label: string; hint: string; icon: typeof Home };
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "工作区",
    items: [
      {
        href: "/admin",
        label: "仪表盘",
        hint: "系统状态与快捷操作",
        icon: LayoutDashboard,
      },
      {
        href: "/admin/monitoring",
        label: "运行监控",
        hint: "服务状态与访问概览",
        icon: Activity,
      },
      {
        href: "/admin/audit",
        label: "审计日志",
        hint: "管理操作记录",
        icon: ChartNoAxesCombined,
      },
    ],
  },
  {
    label: "创作中心",
    items: [
      {
        href: "/admin/posts",
        label: "文章管理",
        hint: "新建、修改与发布文章",
        icon: FileText,
      },
      {
        href: "/admin/announcement",
        label: "公告管理",
        hint: "当前公告与历史归档",
        icon: Bell,
      },
      {
        href: "/admin/dynamics",
        label: "动态管理",
        hint: "发布短内容与更新",
        icon: Quote,
      },
    ],
  },
  {
    label: "站点维护",
    items: [
      {
        href: "/admin/comments",
        label: "评论审核",
        hint: "处理访客互动",
        icon: MessageCircle,
      },
      {
        href: "/admin/feedback",
        label: "反馈管理",
        hint: "查看并处理问题反馈",
        icon: Mail,
      },
      {
        href: "/admin/comment-settings",
        label: "评论设置",
        hint: "评论、邮箱与表情包",
        icon: SlidersHorizontal,
      },
      {
        href: "/admin/users",
        label: "用户管理",
        hint: "注册用户与评论身份",
        icon: UserCog,
      },
      {
        href: "/admin/pages",
        label: "页面管理",
        hint: "关于、友链与静态页",
        icon: Archive,
      },
      {
        href: "/admin/changelog",
        label: "更新日志",
        hint: "版本记录与 Markdown 内容",
        icon: Clock3,
      },
      {
        href: "/admin/site",
        label: "站点设置",
        hint: "标题、描述与主题",
        icon: Settings,
      },
    ],
  },
  {
    label: "账号与资源",
    items: [
      {
        href: "/admin/storage",
        label: "媒体与空间",
        hint: "用户空间与资源管理",
        icon: Boxes,
      },
      {
        href: "/admin/accounts",
        label: "管理员账号",
        hint: "新增与维护其他账号",
        icon: Users,
      },
    ],
  },
];

function navIsActive(path: string, href: string) {
  return href === "/admin"
    ? path === href
    : path === href || path.startsWith(href + "/");
}

function pageMeta(path: string) {
  if (path === "/admin/posts/new")
    return { label: "新建文章", hint: "编写正文、完善发布信息并预览最终文章。" };
  if (/^\/admin\/posts\/\d+\/edit$/u.test(path))
    return { label: "编辑文章", hint: "修改正文、分类标签与文章发布状态。" };
  if (path === "/admin/changelog/new")
    return { label: "新建更新日志", hint: "记录版本号、发布时间与 Markdown 更新内容。" };
  if (/^\/admin\/changelog\/\d+\/(edit|detail)$/u.test(path))
    return { label: path.endsWith("/detail") ? "更新日志详情" : "编辑更新日志", hint: "查看或维护版本发布记录与 Markdown 内容。" };
  if (path === "/admin/author-profile")
    return { label: "博主主页", hint: "作者资料、技能与学习进度" };
  const item = NAV_GROUPS.flatMap((group) => group.items).find((entry) =>
    navIsActive(path, entry.href),
  );
  return item ?? { label: "仪表盘", hint: "系统状态与快捷操作" };
}

function AdminShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const administratorName =
    sessionStorage.getItem("firefly-admin-username")?.trim() || "admin";
  const [mobileMenu, setMobileMenu] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [requestError, setRequestError] = useState("");
  useEffect(() => {
    const showError = (event: Event) => {
      setRequestError(
        (event as CustomEvent<string>).detail || "请求失败，请稍后重试。",
      );
    };
    const redirectToLogin = () => navigate("/admin/login", { replace: true });
    window.addEventListener(ADMIN_REQUEST_ERROR_EVENT, showError);
    window.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, redirectToLogin);
    return () => {
      window.removeEventListener(ADMIN_REQUEST_ERROR_EVENT, showError);
      window.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, redirectToLogin);
    };
  }, [navigate]);
  const meta = pageMeta(location.pathname);
  const logout = () => {
    const token = sessionStorage.getItem("firefly-admin-token");
    if (token) {
      void fetch(API_ORIGIN + "/api/admin/logout", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        keepalive: true,
      }).catch(() => undefined);
    }
    sessionStorage.removeItem("firefly-admin-token");
    sessionStorage.removeItem("firefly-admin-username");
    navigate("/admin/login");
  };
  let page: ReactNode = <AdminDashboard />;
  if (location.pathname === "/admin/posts") page = <AdminPosts />;
  else if (location.pathname === "/admin/monitoring") page = <AdminMonitoring />;
  else if (location.pathname === "/admin/audit") page = <AdminAudit />;
  else if (location.pathname === "/admin/posts/new") page = <AdminPostEditor />;
  else if (/^\/admin\/posts\/\d+\/edit$/u.test(location.pathname))
    page = <AdminPostEditor editId={Number(location.pathname.split("/")[3])} />;
  else if (location.pathname === "/admin/announcement")
    page = <AdminAnnouncement />;
  else if (location.pathname === "/admin/dynamics") page = <AdminDynamics />;
  else if (location.pathname === "/admin/pages") page = <AdminPages />;
  else if (location.pathname === "/admin/author-profile")
    page = <AdminAuthorProfile />;
  else if (location.pathname === "/admin/changelog") page = <AdminChangelog />;
  else if (location.pathname === "/admin/changelog/new") page = <AdminChangelogEditor />;
  else if (/^\/admin\/changelog\/\d+\/(edit|detail)$/u.test(location.pathname)) page = <AdminChangelogEditor editId={Number(location.pathname.split("/")[3])} />;
  else if (location.pathname === "/admin/comments") page = <AdminComments />;
  else if (location.pathname === "/admin/feedback") page = <AdminFeedback />;
  else if (location.pathname === "/admin/comment-settings") page = <AdminCommentSettings />;
  else if (location.pathname === "/admin/users") page = <AdminUsers />;
  else if (location.pathname === "/admin/storage") page = <AdminUserSpace />;
  else if (location.pathname === "/admin/site") page = <AdminSiteSettings />;
  else if (location.pathname === "/admin/accounts") page = <AdminAccounts />;
  else if (location.pathname !== "/admin")
    page = <AdminPlaceholder title={meta.label} description={meta.hint} />;
  return (
    <div className="firefly-admin">
      {requestError ? (
        <div className="fa-request-error" role="alert">
          <span>{requestError}</span>
          <button
            type="button"
            title="关闭提示"
            onClick={() => setRequestError("")}
          >
            <X size={16} />
          </button>
        </div>
      ) : null}
      <aside className="fa-sidebar">
        <Link to="/admin" className="fa-brand">
          <span className="fa-brand-mark">
            <img src="/images/logo/firefly-light.png" alt="" />
          </span>
          <span>
            <strong>Firefly</strong>
            <small>CONTENT STUDIO</small>
          </span>
        </Link>
        <div className="fa-sidebar-scroll">
          {NAV_GROUPS.map((group) => (
            <div className="fa-nav-group" key={group.label}>
              <span className="fa-nav-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    to={item.href}
                    className={
                      navIsActive(location.pathname, item.href)
                        ? "is-active"
                        : ""
                    }
                    onClick={() => setMobileMenu(false)}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
        <div className="fa-sidebar-footer">
          <span className="fa-status-dot" />
          内容工作区
          <button type="button" className="fa-logout" onClick={logout}>
            <LogOut size={16} />
            退出登录
          </button>
        </div>
      </aside>
      <main className="fa-main">
        <header className="fa-topbar">
          <button
            type="button"
            className="fa-mobile-trigger"
            title="打开导航"
            onClick={() => setMobileMenu(true)}
          >
            <Menu size={20} />
          </button>
          <div className="fa-topbar-title">
            <strong>{meta.label}</strong>
            <p>{meta.hint}</p>
          </div>
          <div className="fa-topbar-actions">
            <span className="fa-admin-name" title={`当前管理员：${administratorName}`}>
              <UserRound size={16} />
              <span>{administratorName}</span>
            </span>
            <button type="button" className="fa-top-link-btn" onClick={() => setLicensesOpen(true)} title="开源组件">
              <Link2 size={16} />
              开源组件
            </button>
            <Link className="fa-top-link-btn" to="/">
              <Eye size={16} />
              访问前台
            </Link>
            <button type="button" className="fa-top-logout" onClick={logout} title="退出登录">
              <LogOut size={16} />
              <span>退出登录</span>
            </button>
          </div>
        </header>
        <div className="fa-mobile-nav">
          {NAV_GROUPS[1].items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={
                  navIsActive(location.pathname, item.href) ? "is-active" : ""
                }
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </div>
        <div className="fa-content">{page}</div>
      </main>
      {mobileMenu ? (
        <div
          className="fa-mobile-overlay"
          role="presentation"
          onClick={() => setMobileMenu(false)}
        >
          <div
            className="fa-mobile-drawer"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="fa-drawer-head">
              <span>导航</span>
              <button
                type="button"
                onClick={() => setMobileMenu(false)}
                title="关闭"
              >
                <X size={19} />
              </button>
            </div>
            {NAV_GROUPS.map((group) => (
              <div className="fa-nav-group" key={group.label}>
                <span className="fa-nav-label">{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={
                        navIsActive(location.pathname, item.href)
                          ? "is-active"
                          : ""
                      }
                      onClick={() => setMobileMenu(false)}
                    >
                      <Icon size={18} />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {licensesOpen ? <div className="fa-dialog-overlay" role="presentation" onClick={() => setLicensesOpen(false)}><section className="fa-dialog fa-license-dialog" role="dialog" aria-modal="true" aria-label="开源组件声明" onClick={(event) => event.stopPropagation()}><div className="fa-dialog-head"><div><span className="fa-kicker">OPEN SOURCE NOTICES</span><h2>开源组件声明</h2></div><button type="button" title="关闭" autoFocus onClick={() => setLicensesOpen(false)}><X size={18} /></button></div><p>本项目使用下列开源组件，完整许可信息同时记录在根目录 NOTICE.md。</p><ul className="fa-license-list">{OPEN_SOURCE_COMPONENTS.map((component) => <li key={component.name}><strong>{component.name}</strong><span>{component.license}</span></li>)}</ul></section></div> : null}
    </div>
  );
}

function AdminDashboard() {
  const [site, setSite] = useState<SiteData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardStatus | null>(null);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const [postTotal, setPostTotal] = useState<number | null>(null);
  const [pendingComments, setPendingComments] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [serviceError, setServiceError] = useState("");
  const requestSequence = useRef(0);
  const load = () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setServiceError("");
    void Promise.allSettled([
      adminRequest<SiteData>("/api/site"),
      adminRequest<{ total: number }>("/api/admin/posts?pageSize=1"),
      adminRequest<AdminComment[]>("/api/admin/comments?status=pending"),
      adminRequest<DashboardStatus>("/api/admin/dashboard"),
    ])
      .then(([siteResult, postsResult, commentsResult, dashboardResult]) => {
        if (requestId !== requestSequence.current) return;
        const unavailable: string[] = [];
        if (siteResult.status === "fulfilled") setSite(siteResult.value);
        else unavailable.push("站点数据");
        if (postsResult.status === "fulfilled") setPostTotal(postsResult.value.total);
        else unavailable.push("文章统计");
        if (commentsResult.status === "fulfilled") setPendingComments(commentsResult.value.length);
        else unavailable.push("评论统计");
        if (dashboardResult.status === "fulfilled") setDashboard(dashboardResult.value);
        else unavailable.push("运行状态");
        setServiceError(unavailable.length ? unavailable.join("、") + "暂不可用。" : "");
      })
      .finally(() => {
        if (requestId === requestSequence.current) setLoading(false);
      });
  };
  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, []);
  const administratorName =
    dashboard?.administrator?.name ??
    sessionStorage.getItem("firefly-admin-username")?.trim() ??
    "管理员";
  const database = dashboard?.database;
  const databaseDetails = database?.database;
  const databaseUnavailable = database?.connected === false;
  const systemHasIssue = Boolean(serviceError) || databaseUnavailable;
  const databaseStatus = database?.connected
    ? "连接正常"
    : databaseUnavailable
      ? "连接不可用"
      : "状态待确认";
  const systemDetails = [
    "数据库 " + databaseStatus,
    databaseDetails?.name ?? "未返回库名",
    databaseDetails?.version ? "MySQL " + databaseDetails.version : "版本未知",
    "主机 " + (databaseDetails?.host ?? "未知"),
    "活动连接 " + (databaseDetails?.activeConnections ?? "-"),
    "空闲连接 " + (databaseDetails?.idleConnections ?? "-"),
    "总连接 " + (databaseDetails?.totalConnections ?? "-"),
    "配置上限 " + (databaseDetails?.configuredConnectionLimit ?? "-"),
    "最近内容同步 " + dateText(database?.lastWriteAt ?? dashboard?.lastSyncAt),
    "最近数据库活动 " + dateText(database?.lastActivityAt ?? dashboard?.lastDatabaseActivityAt),
    "最后检查 " + dateText(database?.checkedAt ?? dashboard?.checkedAt),
  ].join(" · ");
  const cards = [
    {
      label: "文章总数",
      value: postTotal ?? "-",
      note: "包含草稿与已发布内容",
      icon: FileText,
      tone: "blue",
    },
    {
      label: "累计访问",
      value: site?.stats.views ?? "-",
      note: "公开文章累计浏览",
      icon: Gauge,
      tone: "green",
    },
    {
      label: "待处理评论",
      value: pendingComments ?? "-",
      note: "需要审核的访客互动",
      icon: MessageCircle,
      tone: "cyan",
    },
    {
      label: "服务状态",
      value: loading ? "..." : systemHasIssue ? "异常" : "在线",
      note: serviceError || (databaseUnavailable ? "数据库连接不可用" : "API 与内容服务"),
      icon: systemHasIssue ? CircleHelp : Check,
      tone: systemHasIssue ? "red" : "mint",
    },
  ];
  return (
    <div className="fa-page">
      <PageHeading
        eyebrow="OVERVIEW"
        title="仪表盘"
        description={`欢迎回来，${administratorName}。今天也让内容保持清晰。`}
        action={
          <PrimaryButton
            onClick={() => {
              window.location.href = "/admin/posts/new";
            }}
          >
            <Plus size={16} />
            写新文章
          </PrimaryButton>
        }
      />
      <section className="fa-stat-grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article className="fa-stat-card" key={card.label}>
              <span className={"fa-stat-icon " + card.tone}>
                <Icon size={21} />
              </span>
              <span className="fa-stat-label">{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.note}</small>
            </article>
          );
        })}
      </section>
      <section className="fa-panel fa-quick-panel">
        <div className="fa-panel-head">
          <div>
            <span className="fa-panel-mark">
              <Zap size={17} />
            </span>
            <div>
              <h2>快速创作与配置</h2>
              <p>常用入口集中在这里，减少来回切换。</p>
            </div>
          </div>
        </div>
        <div className="fa-action-grid">
          <Link to="/admin/posts/new">
            <Pencil size={22} />
            <strong>写文章</strong>
            <span>Markdown 编辑器</span>
          </Link>
          <Link to="/admin/announcement">
            <Bell size={22} />
            <strong>发公告</strong>
            <span>更新首页公告栏</span>
          </Link>
          <Link to="/admin/comments">
            <MessageCircle size={22} />
            <strong>管评论</strong>
            <span>审核访客互动</span>
          </Link>
          <Link to="/admin/site">
            <Settings size={22} />
            <strong>改设置</strong>
            <span>站点基础信息</span>
          </Link>
          <Link to="/admin/pages">
            <Archive size={22} />
            <strong>调页面</strong>
            <span>功能占位入口</span>
          </Link>
          <Link to="/admin/monitoring">
            <Monitor size={22} />
            <strong>看状态</strong>
            <span>服务资源与请求性能</span>
          </Link>
        </div>
      </section>
      <section className="fa-panel fa-system-panel">
        <div>
          <div className="fa-system-title">
            <span
              className={
                "fa-online-badge " + (systemHasIssue ? "is-offline" : "")
              }
            >
              <span />
              {systemHasIssue ? "DEGRADED" : "ONLINE"}
            </span>
            <strong>系统运行状态</strong>
          </div>
          <p>
            {(serviceError ? serviceError + " " : "") + systemDetails}
          </p>
        </div>
        <GhostButton onClick={load}>
          <RefreshCw size={15} />
          刷新状态
        </GhostButton>
      </section>
      {licensesOpen ? <div className="fa-dialog-overlay" role="presentation" onClick={() => setLicensesOpen(false)}><section className="fa-dialog fa-license-dialog" role="dialog" aria-modal="true" aria-label="开源组件声明" onClick={(event) => event.stopPropagation()}><div className="fa-dialog-head"><div><span className="fa-kicker">OPEN SOURCE NOTICES</span><h2>开源组件声明</h2></div><button type="button" title="关闭" autoFocus onClick={() => setLicensesOpen(false)}><X size={18} /></button></div><p>本项目使用下列开源组件，完整许可信息同时记录在根目录 NOTICE.md。</p><ul className="fa-license-list">{OPEN_SOURCE_COMPONENTS.map((component) => <li key={component.name}><strong>{component.name}</strong><span>{component.license}</span></li>)}</ul></section></div> : null}
    </div>
  );
}

function TrendChart({ trend, metric }: { trend: MonitoringData["trend"]; metric: "requests" | "averageResponseMs"; color?: string }) {
  return <DetailedTrendChart trend={trend} variant={metric === "requests" ? "requests" : "latency"} />;
}

type TrendChartVariant = "requests" | "latency";
type TrendChartSeries = { key: "requests" | "errors" | "slowRequests" | "averageResponseMs" | "averageSqlMs"; label: string; color: string; unit: "count" | "ms" };

function chartMax(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const step = value / 5;
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const normalized = step / magnitude;
  const rounded = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return rounded * magnitude * 5;
}

function chartLabel(value: number) {
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + "M";
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k";
  return Math.round(value).toLocaleString("zh-CN");
}

function chartTime(value: string, withDate: boolean) {
  const date = new Date(value);
  return withDate ? date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function detailedTrendChartTooltipTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function DetailedTrendChart({ trend, variant }: { trend: MonitoringData["trend"]; variant: TrendChartVariant }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const series: TrendChartSeries[] = variant === "requests"
    ? [{ key: "requests", label: "请求", color: "#0796b5", unit: "count" }, { key: "errors", label: "错误", color: "#df4965", unit: "count" }, { key: "slowRequests", label: "慢请求", color: "#e09a1a", unit: "count" }]
    : [{ key: "averageResponseMs", label: "平均响应", color: "#10aF83", unit: "ms" }, { key: "averageSqlMs", label: "平均 SQL", color: "#0d7897", unit: "ms" }];
  const width = 760;
  const height = 292;
  const left = 58;
  const right = 742;
  const top = 20;
  const bottom = 232;
  const plotHeight = bottom - top;
  const count = Math.max(1, trend.length);
  const step = count > 1 ? (right - left) / (count - 1) : 0;
  const values = series.flatMap((item) => trend.map((entry) => Number(entry[item.key]) || 0));
  const max = chartMax(Math.max(variant === "requests" ? 5 : 10, ...values));
  const xFor = (index: number) => count === 1 ? (left + right) / 2 : left + index * step;
  const yFor = (value: number) => bottom - Math.min(max, Math.max(0, value)) / max * plotHeight;
  const pointsFor = (item: TrendChartSeries) => trend.map((entry, index) => ({ x: xFor(index), y: yFor(Number(entry[item.key]) || 0), value: Number(entry[item.key]) || 0 }));
  const primaryPoints = pointsFor(series[0]);
  const span = trend.length > 1 ? new Date(trend[trend.length - 1].at).getTime() - new Date(trend[0].at).getTime() : 0;
  const withDate = span > 48 * 60 * 60 * 1000;
  const labelStride = Math.max(1, Math.ceil(Math.max(1, trend.length - 1) / 4));
  const labelIndexes = trend.map((_, index) => index).filter((index) => index % labelStride === 0 || index === trend.length - 1);
  const hovered = hoverIndex === null || !trend[hoverIndex] ? null : trend[hoverIndex];
  const hoveredPoint = hoverIndex === null ? null : primaryPoints[hoverIndex] ?? null;
  const tooltipLeft = hoveredPoint ? Math.min(86, Math.max(14, hoveredPoint.x / width * 100)) + "%" : "50%";
  const areaPoints = (points: Array<{ x: number; y: number }>) => points.length ? points.map((point) => point.x + "," + point.y).join(" ") + " " + points[points.length - 1].x + "," + bottom + " " + points[0].x + "," + bottom : "";
  const valueText = (value: number, unit: TrendChartSeries["unit"]) => unit === "ms" ? Math.round(value).toLocaleString("zh-CN") + " ms" : Math.round(value).toLocaleString("zh-CN") + " 次";
  return <div className="fa-trend-chart fa-detailed-trend-chart" onMouseLeave={() => setHoverIndex(null)}>
    <div className="fa-chart-legend" aria-label="图表图例">{series.map((item) => <span key={item.key}><i style={{ backgroundColor: item.color }} />{item.label}</span>)}</div>
    <svg viewBox={"0 0 " + width + " " + height} preserveAspectRatio="xMidYMid meet" role="img" aria-label={variant === "requests" ? "请求、错误与慢请求趋势图" : "平均响应与平均 SQL 耗时趋势图"}>
      <g className="fa-chart-grid-lines">{Array.from({ length: 6 }, (_, index) => { const y = top + plotHeight * index / 5; const value = max - max * index / 5; return <g key={index}><line x1={left} y1={y} x2={right} y2={y} /><text x={left - 10} y={y + 4} textAnchor="end">{variant === "latency" ? chartLabel(value) + " ms" : chartLabel(value)}</text></g>; })}</g>
      <line className="fa-chart-axis" x1={left} y1={bottom} x2={right} y2={bottom} />
      {series.map((item, seriesIndex) => { const points = pointsFor(item); return <g key={item.key}><polygon className="fa-chart-area" points={areaPoints(points)} style={{ fill: item.color, fillOpacity: seriesIndex === 0 ? 0.1 : 0.035 }} /><polyline className="fa-chart-line" points={points.map((point) => point.x + "," + point.y).join(" ")} style={{ stroke: item.color }} />{points.map((point, index) => <circle className="fa-chart-point" key={item.key + "-" + index} cx={point.x} cy={point.y} r={hoverIndex === index ? 4.8 : 3.4} style={{ fill: item.color }}><title>{item.label + " " + valueText(point.value, item.unit)}</title></circle>)}</g>; })}
      {labelIndexes.map((index) => <text className="fa-chart-x-label" key={"label-" + index} x={xFor(index)} y={height - 13} textAnchor={index === 0 ? "start" : index === trend.length - 1 ? "end" : "middle"}>{chartTime(trend[index].at, withDate)}</text>)}
      {trend.map((_, index) => <rect className="fa-chart-hover-zone" key={"hover-" + index} x={Math.max(left, xFor(index) - (step || 24) / 2)} y={top} width={step || 48} height={plotHeight} onMouseEnter={() => setHoverIndex(index)} />)}
      {hoveredPoint ? <line className="fa-chart-crosshair" x1={hoveredPoint.x} y1={top} x2={hoveredPoint.x} y2={bottom} /> : null}
    </svg>
    {hovered ? <div className="fa-trend-tooltip" style={{ left: tooltipLeft }}><strong>{detailedTrendChartTooltipTime(hovered.at)}</strong>{series.map((item) => <span key={item.key}><i style={{ backgroundColor: item.color }} />{item.label}<b>{valueText(Number(hovered[item.key]) || 0, item.unit)}</b></span>)}</div> : null}
    {!trend.length ? <div className="fa-chart-no-data">当前时间范围内暂无趋势数据</div> : null}
  </div>;
}

function ResourceBar({ label, value, total, note, icon: Icon }: { label: string; value: number; total: number; note: string; icon: LucideIcon }) {
  const usage = percent(value, total);
  return <div className="fa-resource-row"><div><span><Icon size={16} />{label}</span><strong>{usage.toFixed(1)}%</strong></div><div className="fa-meter"><span style={{ width: usage + "%" }} /></div><small>{note}</small></div>;
}

function AdminMonitoring() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const load = () => {
    const requestId = ++requestSequence.current;
    setLoading(true); setError("");
    void adminRequest<MonitoringData>("/api/admin/monitoring?hours=" + hours)
      .then((result) => {
        if (requestId !== requestSequence.current) return;
        if (!result.available) throw new Error("运行监控暂不可用。");
        setData(result);
      })
      .catch((cause) => {
        if (requestId === requestSequence.current) setError(errorText(cause, "运行监控服务暂不可用。"));
      })
      .finally(() => {
        if (requestId === requestSequence.current) setLoading(false);
      });
  };
  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [hours]);
  const server = data?.resources.server;
  const summary = data?.summary;
  const monitorCards: Array<{ label: string; value: ReactNode; icon: LucideIcon; tone: string }> = summary
    ? [
        { label: "请求量", value: summary.total, icon: FileText, tone: "blue" },
        { label: "平均响应", value: `${summary.averageResponseMs} ms`, icon: Gauge, tone: "cyan" },
        { label: "慢请求", value: summary.slow, icon: Clock3, tone: "green" },
        { label: "慢 SQL", value: summary.slowSql, icon: Database, tone: "mint" },
        { label: "错误率", value: `${percent(summary.errors, summary.total).toFixed(1)}%`, icon: CircleHelp, tone: "red" },
        { label: "平均 SQL", value: `${summary.sql.averageMs} ms`, icon: Database, tone: "blue" },
      ]
    : [];
  const processes = server?.processes?.length ? server.processes : server ? [server.process] : [];
  return <div className="fa-page fa-monitoring"><PageHeading eyebrow="RUN MONITORING" title="运行监控" description="服务器、服务进程与请求性能的实时快照。" action={<GhostButton onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? "fa-spin" : ""} />立即刷新</GhostButton>} /><section className="fa-panel fa-monitor-toolbar"><div className="fa-range-tabs">{[[1, "1 小时"], [6, "6 小时"], [24, "24 小时"], [168, "7 天"]].map(([value, label]) => <button key={String(value)} type="button" className={hours === value ? "is-active" : ""} onClick={() => setHours(Number(value))}>{label}</button>)}</div><span>{data ? `数据生成于 ${dateText(data.generatedAt)}` : "正在获取监控数据"}</span></section>{error ? <section className="fa-panel fa-monitor-empty"><CircleHelp size={22} /><strong>运行监控不可用</strong><p>{error}</p><GhostButton onClick={load}><RefreshCw size={15} />重试</GhostButton></section> : loading && !data ? <section className="fa-panel fa-monitor-empty"><RefreshCw size={22} className="fa-spin" />正在加载运行指标...</section> : data && server && summary ? <><section className="fa-resource-grid"><article className="fa-panel fa-resource-card"><div className="fa-panel-title"><Monitor size={18} /><h2>{server.hostname}</h2><span className="fa-pill published">运行中</span></div><p>{server.platform} · {server.arch}</p><ResourceBar label="CPU 使用率" icon={Cpu} value={server.cpu.usagePercent ?? 0} total={100} note={server.cpu.usagePercent == null ? `暂不可用 · ${server.cpu.cores} 核` : `${server.cpu.cores} 核 · ${server.cpu.model}`} /><ResourceBar label="内存" icon={MemoryStick} value={server.memory.usedBytes} total={server.memory.totalBytes} note={`${bytesText(server.memory.usedBytes)} / ${bytesText(server.memory.totalBytes)}`} /><ResourceBar label="磁盘" icon={HardDrive} value={server.disk?.usedBytes ?? 0} total={server.disk?.totalBytes ?? 0} note={server.disk ? `${bytesText(server.disk.usedBytes)} / ${bytesText(server.disk.totalBytes)} · ${server.disk.path}` : "主机未提供磁盘统计"} /></article><article className="fa-panel fa-resource-card"><div className="fa-panel-title"><Cpu size={18} /><h2>{data.resources.project.name}</h2><span className="fa-pill published">Node 服务</span></div><p>{server.process.node} · PID {server.process.pid} · 已运行 {Math.floor(server.process.uptimeSeconds / 3600)} 小时</p><ResourceBar label="项目内存 RSS" icon={MemoryStick} value={server.process.rssBytes} total={server.memory.totalBytes} note={`${bytesText(server.process.rssBytes)} · 堆 ${bytesText(server.process.heapUsedBytes)}/${bytesText(server.process.heapTotalBytes)}`} />{server.process.cpuPercent != null ? <ResourceBar label="项目 CPU" icon={Cpu} value={server.process.cpuPercent} total={100} note="当前 Node 进程 CPU 使用率" /> : <div className="fa-resource-row"><div><span><Cpu size={16} />项目 CPU</span><strong>暂不可用</strong></div><small>当前 Node 进程未提供 CPU 采样</small></div>}<div className="fa-resource-row"><div><span><Activity size={16} />系统负载</span><strong>{server.cpu.load1.toFixed(2)}</strong></div><small>{server.cpu.cores} 核 · 1/5/15 分钟 {server.cpu.load1.toFixed(2)} / {server.cpu.load5.toFixed(2)} / {server.cpu.load15.toFixed(2)}</small></div></article></section><section className="fa-panel fa-resource-card" style={{ marginBottom: "0.9rem" }}><div className="fa-panel-title"><Activity size={18} /><h2>服务进程</h2><span className="fa-pill published">{processes.length} 个</span></div><p>当前主机上由监控端点采集到的服务进程。</p>{processes.length ? <div className="fa-path-list">{processes.map((process) => <div key={process.pid}><div><span className="fa-method get">PID {process.pid}</span><code>{process.name ?? "Node 进程"}</code><strong>{process.cpuPercent == null ? "CPU —" : `CPU ${process.cpuPercent.toFixed(1)}%`}</strong></div><small>{process.node ? `${process.node} · ` : ""}{process.uptimeSeconds != null ? `运行 ${Math.floor(process.uptimeSeconds / 3600)} 小时 · ` : ""}{process.rssBytes != null ? `RSS ${bytesText(process.rssBytes)}` : "资源未提供"}</small></div>)}</div> : <EmptyState>当前未采集到服务进程</EmptyState>}</section><section className="fa-stat-grid fa-monitor-stats">{monitorCards.map(({ label, value, icon: Icon, tone }) => <article className="fa-stat-card" key={label}><span className={`fa-stat-icon ${tone}`}><Icon size={21} /></span><span className="fa-stat-label">{label}</span><strong>{value}</strong><small>{label === "慢请求" ? `阈值 ${data.thresholds.slowRequestMs} ms` : label === "慢 SQL" ? `阈值 ${data.thresholds.slowSqlMs} ms` : "当前统计范围"}</small></article>)}</section><section className="fa-monitor-chart-grid"><article className="fa-panel"><div className="fa-panel-head"><div><h2>请求趋势</h2><p>每个时间桶内的请求数量。</p></div></div><TrendChart trend={data.trend} metric="requests" color="#0596b7" /></article><article className="fa-panel"><div className="fa-panel-head"><div><h2>响应耗时趋势</h2><p>平均请求响应时间。</p></div></div><TrendChart trend={data.trend} metric="averageResponseMs" color="#118a70" /></article></section><section className="fa-monitor-detail-grid"><article className="fa-panel"><div className="fa-panel-head"><div><h2>高频路径</h2><p>按请求量排序的 API 访问。</p></div></div>{data.paths.length ? <div className="fa-path-list">{data.paths.map((path) => <div key={path.method + path.path}><div><span className={`fa-method ${path.method.toLowerCase()}`}>{path.method}</span><code>{path.path}</code><strong>{path.requests} 次</strong></div><div className="fa-meter"><span style={{ width: percent(path.requests, data.paths[0]?.requests ?? 1) + "%" }} /></div><small>平均 {path.averageResponseMs} ms · 错误 {path.errors} · 峰值 {path.peakResponseMs} ms</small></div>)}</div> : <EmptyState>当前时间范围内暂无访问记录</EmptyState>}</article><article className="fa-panel"><div className="fa-panel-head"><div><h2>最近异常请求</h2><p>包含慢请求、错误请求与慢 SQL。</p></div></div>{data.recent.length ? <div className="fa-exception-list">{data.recent.map((item, index) => <div key={item.at + index}><time>{dateText(item.at)}</time><span className={`fa-method ${item.method.toLowerCase()}`}>{item.method}</span><code>{item.path}</code><strong className={item.status >= 400 ? "is-error" : ""}>{item.status} · {item.durationMs} ms</strong></div>)}</div> : <EmptyState>当前时间范围内没有异常请求</EmptyState>}</article></section><p className="fa-monitor-scope">{data.dataScope}</p></> : null}</div>;
}

type AuditLocation = {
  ip: string;
  type: "public" | "private" | "loopback" | "unknown" | "invalid";
  label: string;
  country?: string;
  city?: string;
  isPrivate?: boolean;
};
type AuditTimelineItem = {
  id: string;
  createdAt: string;
  ip: string;
  ipLocation: AuditLocation;
  method: string;
  path: string;
  action: string;
  statusCode: number | null;
  status?: string;
  durationMs: number | null;
  duration?: number | null;
  actorRole: string;
  actorId: string;
  actorAccount: string;
  clientName: string;
  clientUa: string;
};
type AuditGroupItem = {
  ip: string;
  ipLocation: AuditLocation;
  hitCount: number | null;
  errorCount: number | null;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
  latestAt: string;
  latestMethod: string;
  latestPath: string;
  latestAction: string;
  latestStatusCode: number | null;
  latestActorRole: string;
  latestActorAccount: string;
  latestClientName: string;
  recent: AuditTimelineItem[];
};
type AuditResponse = {
  page?: number;
  limit?: number;
  groupLogPreviewLimit?: number;
  total?: number;
  viewMode?: "timeline" | "ip";
  summary?: { totalLogs?: number; uniqueIpCount?: number };
  items?: Array<AuditTimelineItem | AuditGroupItem>;
};

function auditNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function auditLocation(value: unknown, ip = ""): AuditLocation {
  const source = value && typeof value === "object" ? (value as Partial<AuditLocation>) : {};
  const sourceType = source.type;
  const type: AuditLocation["type"] =
    sourceType === "public" || sourceType === "private" || sourceType === "loopback" || sourceType === "invalid"
      ? sourceType
      : ip === "127.0.0.1" || ip === "::1"
        ? "loopback"
        : /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(ip)
          ? "private"
          : "unknown";
  return {
    ip: String(source.ip ?? ip).trim(),
    type,
    label: String(source.label ?? (type === "loopback" ? "本机" : type === "private" ? "内网" : "位置未知")).trim() || "位置未知",
    country: String(source.country ?? "").trim(),
    city: String(source.city ?? "").trim(),
    isPrivate: Boolean(source.isPrivate),
  };
}

function normalizeAuditTimeline(value: unknown, index = 0): AuditTimelineItem {
  const source = value && typeof value === "object" ? (value as Partial<AuditTimelineItem>) : {};
  const ip = String(source.ip ?? "").trim();
  return {
    id: String(source.id ?? `${source.createdAt ?? "row"}-${index}`),
    createdAt: String(source.createdAt ?? ""),
    ip,
    ipLocation: auditLocation(source.ipLocation, ip),
    method: String(source.method ?? "").trim().toUpperCase(),
    path: String(source.path ?? "").trim(),
    action: String(source.action ?? "").trim(),
    statusCode: auditNumber(source.statusCode),
    status: String(source.status ?? "").trim(),
    durationMs: auditNumber(source.durationMs ?? source.duration),
    duration: auditNumber(source.duration),
    actorRole: String(source.actorRole ?? "").trim(),
    actorId: String(source.actorId ?? "").trim(),
    actorAccount: String(source.actorAccount ?? "").trim(),
    clientName: String(source.clientName ?? "").trim(),
    clientUa: String(source.clientUa ?? "").trim(),
  };
}

function normalizeAuditGroup(value: unknown, index = 0): AuditGroupItem {
  const source = value && typeof value === "object" ? (value as Partial<AuditGroupItem>) : {};
  const ip = String(source.ip ?? "").trim();
  const recent = Array.isArray(source.recent)
    ? source.recent.map((item, itemIndex) => normalizeAuditTimeline(item, itemIndex))
    : [];
  return {
    ip,
    ipLocation: auditLocation(source.ipLocation, ip),
    hitCount: auditNumber(source.hitCount),
    errorCount: auditNumber(source.errorCount),
    avgDurationMs: auditNumber(source.avgDurationMs),
    maxDurationMs: auditNumber(source.maxDurationMs),
    latestAt: String(source.latestAt ?? ""),
    latestMethod: String(source.latestMethod ?? "").trim().toUpperCase(),
    latestPath: String(source.latestPath ?? "").trim(),
    latestAction: String(source.latestAction ?? "").trim(),
    latestStatusCode: auditNumber(source.latestStatusCode),
    latestActorRole: String(source.latestActorRole ?? "").trim(),
    latestActorAccount: String(source.latestActorAccount ?? "").trim(),
    latestClientName: String(source.latestClientName ?? "").trim(),
    recent: recent.map((item, itemIndex) => ({ ...item, id: item.id || `${ip}-${index}-${itemIndex}` })),
  };
}

function auditDateText(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function auditDuration(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "-" : `${Math.max(0, Math.round(value))} ms`;
}

function auditActor(role: string, account: string) {
  if (role && account) return `${role} @${account}`;
  if (account) return `@${account}`;
  return role || "-";
}

function auditClient(name: string, userAgent: string) {
  return name || userAgent || "未知客户端";
}

function auditStatusClass(status: number | null) {
  if (status == null) return "is-default";
  if (status >= 200 && status < 300) return "is-success";
  if (status >= 300 && status < 400) return "is-redirect";
  if (status === 404) return "is-not-found";
  if (status >= 400 && status < 500) return "is-client-error";
  if (status >= 500) return "is-server-error";
  return "is-default";
}

function auditMethodClass(method: string) {
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method.toLowerCase() : "other";
}

function AuditMethod({ method }: { method: string }) {
  return <span className={`fa-audit-method is-${auditMethodClass(method)}`}>{method || "-"}</span>;
}

function AuditStatus({ status }: { status: number | null }) {
  return <span className={`fa-audit-status ${auditStatusClass(status)}`}>{status ?? "-"}</span>;
}

function AdminAudit() {
  const [viewMode, setViewMode] = useState<"timeline" | "ip">("timeline");
  const [keyword, setKeyword] = useState("");
  const [method, setMethod] = useState("");
  const [actorRole, setActorRole] = useState("");
  const [isAdmin, setIsAdmin] = useState("");
  const [path, setPath] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [groupPreviewLimit, setGroupPreviewLimit] = useState(100);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ totalLogs: 0, uniqueIpCount: 0 });
  const [timelineRows, setTimelineRows] = useState<AuditTimelineItem[]>([]);
  const [groupRows, setGroupRows] = useState<AuditGroupItem[]>([]);
  const [expandedIps, setExpandedIps] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  const load = () => {
    const requestId = ++requestSequence.current;
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      viewMode,
    });
    if (keyword.trim()) params.set("keyword", keyword.trim());
    if (method) params.set("method", method);
    if (actorRole) params.set("actorRole", actorRole);
    if (isAdmin) params.set("isAdmin", isAdmin);
    if (path.trim()) params.set("path", path.trim());
    if (viewMode === "ip") params.set("groupLogPreviewLimit", String(groupPreviewLimit));
    setLoading(true);
    setError("");
    void adminRequestCompatible<AuditResponse>([
      "/api/admin/audit-logs?" + params.toString(),
      "/api/admin/audit?" + params.toString(),
    ])
      .then((result) => {
        if (requestSequence.current !== requestId) return;
        const responseView = result.viewMode === "ip" ? "ip" : "timeline";
        const nextSummary = {
          totalLogs: Math.max(0, Math.round(result.summary?.totalLogs ?? 0)),
          uniqueIpCount: Math.max(0, Math.round(result.summary?.uniqueIpCount ?? 0)),
        };
        setTotal(Math.max(0, Math.round(result.total ?? 0)));
        setSummary(nextSummary);
        if (responseView === "ip") {
          const rows = Array.isArray(result.items) ? result.items.map((item, index) => normalizeAuditGroup(item, index)) : [];
          setGroupRows(rows);
          setTimelineRows([]);
          setExpandedIps(rows[0]?.ip ? new Set([rows[0].ip]) : new Set());
          if (result.groupLogPreviewLimit != null) setGroupPreviewLimit(Math.max(1, Math.round(result.groupLogPreviewLimit)));
        } else {
          setTimelineRows(Array.isArray(result.items) ? result.items.map((item, index) => normalizeAuditTimeline(item, index)) : []);
          setGroupRows([]);
          setExpandedIps(new Set());
        }
      })
      .catch((cause) => {
        if (requestSequence.current !== requestId) return;
        setTimelineRows([]);
        setGroupRows([]);
        setTotal(0);
        setSummary({ totalLogs: 0, uniqueIpCount: 0 });
        setError(errorText(cause, "审计日志加载失败，请稍后重试。"));
      })
      .finally(() => {
        if (requestSequence.current === requestId) setLoading(false);
      });
  };

  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [viewMode, page, limit, groupPreviewLimit]);

  const search = () => {
    if (page !== 1) setPage(1);
    else load();
  };
  const toggleGroup = (ip: string) => {
    setExpandedIps((current) => {
      const next = new Set(current);
      if (next.has(ip)) next.delete(ip);
      else next.add(ip);
      return next;
    });
  };
  const clearLogs = async () => {
    if (clearing) return;
    if (!window.confirm("确认清空全部审计日志吗？该操作不可恢复。")) return;
    setClearing(true);
    setError("");
    try {
      await adminRequestCompatible(["/api/admin/audit-logs/clear", "/api/admin/audit/clear"], { method: "POST" });
      setPage(1);
      setTimelineRows([]);
      setGroupRows([]);
      setTotal(0);
      setSummary({ totalLogs: 0, uniqueIpCount: 0 });
      load();
    } catch (cause) {
      setError(errorText(cause, "清空审计日志失败，请稍后重试。"));
    } finally {
      setClearing(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="fa-page fa-audit-page">
      <PageHeading
        eyebrow="AUDIT SYSTEM / ACCESS TRACE"
        title="操作审计日志"
        description="记录每一次请求的来源、结果与耗时，帮助你快速识别异常访问。"
        action={<span className="fa-audit-live"><span />实时数据</span>}
      />
      <section className="fa-panel fa-audit-surface">
        <div className="fa-audit-notice"><Info size={18} /><span>{viewMode === "ip" ? `按最近访问时间倒序分组显示，每个 IP 展示最近 ${groupPreviewLimit} 条记录` : "按最近访问时间倒序展示全部审计记录，便于快速定位请求异常"}</span></div>
        <div className="fa-audit-stats">
          <article><span className="fa-audit-stat-icon logs"><Activity size={19} /></span><strong>{summary.totalLogs.toLocaleString("zh-CN")}</strong><small>筛选命中 · 条日志</small></article>
          <article><span className="fa-audit-stat-icon ips"><Globe2 size={19} /></span><strong>{summary.uniqueIpCount.toLocaleString("zh-CN")}</strong><small>来源 IP · 个</small></article>
          <article><span className="fa-audit-stat-icon view"><Database size={19} /></span><strong>{total.toLocaleString("zh-CN")}</strong><small>{viewMode === "ip" ? "分组结果 · 个 IP" : "时间线结果 · 条日志"}</small></article>
        </div>
        {error ? <div className="fa-audit-error"><Info size={16} />{error}</div> : null}
        <div className="fa-audit-controls">
          <div className="fa-audit-control-head"><div><span><SlidersHorizontal size={14} />筛选与视图</span><strong>访问记录</strong></div><div className="fa-audit-mode" role="tablist" aria-label="日志查看方式"><button type="button" className={viewMode === "timeline" ? "is-active" : ""} disabled={clearing} onClick={() => { setPage(1); setViewMode("timeline"); }}><List size={15} />列表模式</button><button type="button" className={viewMode === "ip" ? "is-active" : ""} disabled={clearing} onClick={() => { setPage(1); setViewMode("ip"); }}><Users size={15} />按 IP 分组</button></div></div>
          <div className={`fa-audit-filters ${viewMode === "ip" ? "is-group" : ""}`}>
            <label className="fa-audit-search"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder="搜索 IP、路径、账号或客户端" /></label>
            <select value={method} onChange={(event) => setMethod(event.target.value)}><option value="">全部方法</option><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option></select>
            <select value={actorRole} onChange={(event) => setActorRole(event.target.value)}><option value="">全部角色</option><option value="admin">admin</option><option value="superadmin">superadmin</option><option value="legacy">legacy</option><option value="user">user</option><option value="anonymous">anonymous</option></select>
            <select value={isAdmin} onChange={(event) => setIsAdmin(event.target.value)}><option value="">全部请求</option><option value="true">管理端请求</option><option value="false">前台请求</option></select>
            <input className="fa-audit-path-input" value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") search(); }} placeholder="路径包含..." />
            {viewMode === "ip" ? <label className="fa-audit-preview"><input type="number" min={1} max={2000} step={10} value={groupPreviewLimit} onChange={(event) => setGroupPreviewLimit(Math.min(2000, Math.max(1, Number(event.target.value) || 1)))} /><span>展开条数</span></label> : null}
            <div className="fa-audit-actions"><PrimaryButton onClick={search} disabled={loading || clearing}><Search size={15} />查询</PrimaryButton><GhostButton onClick={load} disabled={loading || clearing}><RefreshCw size={15} className={loading ? "fa-spin" : ""} />刷新</GhostButton><button type="button" className="fa-audit-clear" onClick={() => void clearLogs()} disabled={loading || clearing}><Trash2 size={15} />清空</button></div>
          </div>
        </div>
        <div className="fa-audit-result"><span>当前筛选共 <b>{summary.totalLogs.toLocaleString("zh-CN")}</b> 条日志</span><i /><span><b>{summary.uniqueIpCount.toLocaleString("zh-CN")}</b> 个 IP</span>{viewMode === "ip" ? <small>每个 IP 当前展示最近 {groupPreviewLimit} 条记录</small> : null}</div>
        {viewMode === "timeline" ? (
          <div className="fa-audit-table-wrap"><table className="fa-audit-table"><thead><tr><th className="time">时间</th><th className="ip">IP / 属地</th><th className="method">方法</th><th className="path">路径 / 操作</th><th className="client">客户端</th><th className="actor">操作者</th><th className="status">状态码</th><th className="duration">耗时</th></tr></thead><tbody>{loading && !timelineRows.length ? <tr><td colSpan={8}><div className="fa-table-loading"><RefreshCw size={17} className="fa-spin" />加载中</div></td></tr> : timelineRows.length ? timelineRows.map((row) => <tr key={row.id}><td className="time" title={row.createdAt}>{auditDateText(row.createdAt)}</td><td className="ip"><div className="fa-audit-ip"><code>{row.ip || "-"}</code><span className={`fa-audit-location ${row.ipLocation.type}`}>{row.ipLocation.label}</span></div></td><td className="method"><AuditMethod method={row.method} /></td><td className="path"><div className="fa-audit-path"><code title={row.path || "-"}>{row.path || "-"}</code><small>{row.action || "未命名操作"}</small></div></td><td className="client"><span className="fa-audit-client" title={auditClient(row.clientName, row.clientUa)}><Server size={14} />{auditClient(row.clientName, row.clientUa)}</span></td><td className="actor"><span className="fa-audit-actor">{auditActor(row.actorRole, row.actorAccount)}</span></td><td className="status"><AuditStatus status={row.statusCode} /></td><td className="duration"><span className="fa-audit-duration"><Clock3 size={14} />{auditDuration(row.durationMs)}</span></td></tr>) : <tr><td colSpan={8}><EmptyState>暂无符合条件的审计记录</EmptyState></td></tr>}</tbody></table></div>
        ) : (
          <div className="fa-audit-groups">{groupRows.map((row) => <article className={`fa-audit-group ${expandedIps.has(row.ip) ? "is-expanded" : ""}`} key={row.ip}><button type="button" className="fa-audit-group-head" onClick={() => toggleGroup(row.ip)}><span className={`fa-audit-chevron ${expandedIps.has(row.ip) ? "is-rotated" : ""}`}><ChevronRight size={17} /></span><span className="fa-audit-group-ip"><code>{row.ip || "-"}</code><b>{row.hitCount ?? 0} 条记录</b></span><span className="fa-audit-group-device"><Server size={14} />{row.latestClientName || "未知客户端"}</span><span className={`fa-audit-location ${row.ipLocation.type}`}>{row.ipLocation.label}</span><span className="fa-audit-latest">最近：{auditDateText(row.latestAt)}</span></button>{expandedIps.has(row.ip) ? <div className="fa-audit-group-body"><div className="fa-audit-group-meta"><div><strong>最近访问记录</strong><small>按时间倒序排列</small></div><span><b>{row.errorCount ?? 0}</b> 异常</span><span><b>{auditDuration(row.avgDurationMs)}</b> 平均耗时</span><span><b>{auditDuration(row.maxDurationMs)}</b> 峰值</span></div>{row.recent.length ? <div className="fa-audit-table-wrap nested"><table className="fa-audit-table"><thead><tr><th className="time">时间</th><th className="method">方法</th><th className="path">路径</th><th className="client">客户端</th><th className="actor">操作者</th><th className="status">状态码</th><th className="duration">耗时</th></tr></thead><tbody>{row.recent.map((item) => <tr key={item.id}><td className="time">{auditDateText(item.createdAt)}</td><td className="method"><AuditMethod method={item.method} /></td><td className="path"><code className="fa-audit-path-code" title={item.path}>{item.path || "-"}</code></td><td className="client"><span className="fa-audit-client">{auditClient(item.clientName, item.clientUa)}</span></td><td className="actor"><span className="fa-audit-actor">{auditActor(item.actorRole, item.actorAccount)}</span></td><td className="status"><AuditStatus status={item.statusCode} /></td><td className="duration"><span className="fa-audit-duration"><Clock3 size={14} />{auditDuration(item.durationMs)}</span></td></tr>)}</tbody></table></div> : <EmptyState>暂无最近访问记录</EmptyState>}{row.hitCount != null && row.recent.length < row.hitCount ? <p className="fa-audit-preview-note"><Info size={14} />仅展示最近 {row.recent.length} / {row.hitCount} 条记录，可调整“展开条数”查看更多。</p> : null}</div> : null}</article>)}{!groupRows.length && !loading ? <div className="fa-audit-empty"><Database size={28} />暂无符合条件的 IP 分组</div> : null}{loading && !groupRows.length ? <div className="fa-audit-empty"><RefreshCw size={22} className="fa-spin" />加载中</div> : null}</div>
        )}
        <div className="fa-audit-pagination"><span>共 {total.toLocaleString("zh-CN")} {viewMode === "ip" ? "个 IP 分组" : "条日志"}</span><div><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>上一页</button><b>第 {page} / {totalPages} 页</b><button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}>下一页</button><select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option><option value={200}>200 / 页</option></select></div></div>
      </section>
    </div>
  );
}

type PostForm = {
  slug: string;
  filename: string;
  title: string;
  excerpt: string;
  content: string;
  cover: string;
  topImage: string;
  categorySlug: string;
  tagSlugs: string[];
  status: "draft" | "published";
  pinned: boolean;
  publishedAt: string;
};
const EMPTY_POST: PostForm = {
  slug: "",
  filename: "",
  title: "",
  excerpt: "",
  content: "",
  cover: "",
  topImage: "",
  categorySlug: "",
  tagSlugs: [],
  status: "published",
  pinned: false,
  publishedAt: "",
};

function excerptFromMarkdown(content: string, title: string) {
  const plain = content
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[.*?\]\(.*?\)/gu, " ")
    .replace(/[#>*_~`\[\]()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (plain || title.trim() || "暂无摘要").slice(0, 5000);
}

function AdminPosts() {
  const navigate = useNavigate();
  const latestRequest = useRef(0);
  const [items, setItems] = useState<AdminPost[]>([]);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("");
  const load = () => {
    const requestKey = Date.now();
    latestRequest.current = requestKey;
    setLoading(true);
    setMessage("");
    void adminRequest<{ items: AdminPost[]; total: number }>(
      "/api/admin/posts?page=" +
        page +
        "&pageSize=12&status=" +
        encodeURIComponent(status) +
        "&q=" +
        encodeURIComponent(query),
    )
      .then((data) => {
        if (latestRequest.current !== requestKey) return;
        setItems(data.items);
        setTotal(data.total);
      })
      .catch((error) => {
        if (latestRequest.current !== requestKey) return;
        setItems([]);
        setTotal(0);
        setMessage(errorText(error, "文章列表加载失败，请稍后重试。"));
      })
      .finally(() => { if (latestRequest.current === requestKey) setLoading(false); });
  };
  useEffect(() => {
    load();
  }, [status, page]);
  const remove = async (id: number) => {
    if (!window.confirm("确定删除这篇文章吗？删除后不可恢复。")) return;
    try {
      await adminRequest("/api/admin/posts/" + id, { method: "DELETE" });
      if (items.length === 1 && page > 1) setPage((value) => value - 1);
      else load();
    } catch (error) {
      setMessage(errorText(error, "文章删除失败，请稍后重试。"));
    }
  };
  return (
    <div className="fa-page">
      <PageHeading
        eyebrow="CONTENT CENTER"
        title="文章管理"
        description={"共 " + total + " 篇文章，支持草稿、发布与置顶。"}
        action={
          <PrimaryButton onClick={() => navigate("/admin/posts/new")}>
            <Plus size={16} />
            新建文章
          </PrimaryButton>
        }
      />
      <section className="fa-panel">
        {message ? <div className="fa-error fa-page-error">{message}</div> : null}
        <div className="fa-toolbar">
          <div className="fa-search">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setPage(1);
                  load();
                }
              }}
              placeholder="按标题、别名或摘要搜索"
            />
          </div>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="published">已发布</option>
            <option value="draft">草稿</option>
          </select>
          <GhostButton onClick={load}>
            <RefreshCw size={15} />
            刷新
          </GhostButton>
        </div>
        <div className="fa-table-wrap">
          <table className="fa-table">
            <thead>
              <tr>
                <th>文章</th>
                <th>状态</th>
                <th>分类</th>
                <th>浏览</th>
                <th>更新时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6}>
                    <div className="fa-table-loading">
                      <RefreshCw size={17} className="fa-spin" />
                      加载中
                    </div>
                  </td>
                </tr>
              ) : items.length ? (
                items.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <div className="fa-post-cell">
                        <strong>
                          {post.pinned ? "置顶 · " : ""}
                          {post.title}
                        </strong>
                        <small>/{post.slug}</small>
                      </div>
                    </td>
                    <td>
                      <span className={"fa-pill " + post.status}>
                        {post.status === "published" ? "已发布" : "草稿"}
                      </span>
                    </td>
                    <td>{post.category?.name ?? "未分类"}</td>
                    <td>{post.views}</td>
                    <td>{dateText(post.updatedAt)}</td>
                    <td>
                      <div className="fa-row-actions">
                        <button
                          type="button"
                          title="编辑"
                          onClick={() =>
                            navigate("/admin/posts/" + post.id + "/edit")
                          }
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          title="删除"
                          onClick={() => void remove(post.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6}>
                    <EmptyState>暂无文章，先写下第一篇内容吧。</EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {total > 12 ? (
          <div className="fa-pagination">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              上一页
            </button>
            <span>
              第 {page} 页 · 共 {Math.ceil(total / 12)} 页
            </span>
            <button
              type="button"
              disabled={page >= Math.ceil(total / 12)}
              onClick={() => setPage((value) => value + 1)}
            >
              下一页
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AdminPostEditor({ editId }: { editId?: number }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<PostForm>(EMPTY_POST);
  const [categoryInput, setCategoryInput] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [topUploading, setTopUploading] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (editId)
      void adminRequest<AdminPost>("/api/admin/posts/" + editId)
        .then((post) => {
          setForm({
            slug: post.slug,
            filename: post.filename ?? `${post.slug}.md`,
            title: post.title,
            excerpt: post.excerpt,
            content: post.content,
            cover: post.cover ?? "",
            topImage: post.topImage ?? "",
            categorySlug: post.category?.slug ?? "",
            tagSlugs: post.tags.map((tag) => tag.slug),
            status: post.status,
            pinned: post.pinned,
            publishedAt: toDateTimeLocal(post.publishedAt),
          });
          setCategoryInput((post.categories?.length ? post.categories : post.category ? [post.category] : []).map((item) => item.name).join(", "));
          setTagsInput(post.tags.map((tag) => tag.name).join(", "));
        })
        .catch(() => setMessage("文章加载失败，请刷新后重试。"));
  }, [editId]);
  const update = <K extends keyof PostForm>(key: K, value: PostForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    setSaving(true);
    try {
      const content = form.content.trim();
      const filename = form.filename.trim() || `${postSlug(form.slug, form.title)}.md`;
      const filenameSlug = filename.replace(/\.(?:md|markdown|mdx)$/iu, "");
      const slug = postSlug(form.slug || filenameSlug, form.title);
      const categoryNames = [...new Set(categoryInput.split(/[,，]/u).map((value) => value.trim()).filter(Boolean))].slice(0, 24);
      const tagNames = [...new Set(tagsInput.split(/[,，]/u).map((value) => value.trim()).filter(Boolean))].slice(0, 12);
      const payload = {
        ...form,
        slug,
        filename,
        content,
        excerpt: form.excerpt.trim() || excerptFromMarkdown(content, form.title),
        cover: form.cover || null,
        topImage: form.topImage || null,
        categoryNames,
        categoryName: null,
        categorySlug: null,
        tagNames,
        tagSlugs: [],
        // New articles are always public. Existing drafts retain their state
        // unless the editor explicitly changes the switch below.
        status: editId ? form.status : "published",
        publishedAt: form.publishedAt
          ? new Date(form.publishedAt).toISOString()
          : editId && form.status === "draft"
            ? null
            : new Date().toISOString(),
      };
      await adminRequest(
        editId ? "/api/admin/posts/" + editId : "/api/admin/posts",
        { method: editId ? "PUT" : "POST", body: JSON.stringify(payload) },
      );
      navigate("/admin/posts");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const clearForm = () => {
    setForm((current) => ({ ...current, excerpt: "", content: "" }));
    setMessage("");
  };
  const uploadPostImage = (field: "cover" | "topImage", file: File) => {
    const setUploading = field === "cover" ? setCoverUploading : setTopUploading;
    setUploading(true);
    void uploadAdminMedia(file, "image")
      .then((url) => update(field, url))
      .catch((error) => setMessage(errorText(error, "文章图片上传失败。")))
      .finally(() => setUploading(false));
  };
  return (
    <div className="fa-page fa-post-editor-page">
      <form className="fa-editor-layout fa-panel" onSubmit={save}>
        <section className="fa-editor-main">
          <label className="fa-post-field-wide">标题<input className="fa-title-input" value={form.title} onChange={(event) => update("title", event.target.value)} placeholder="例如：后台更新日志" required /></label>
          <div className="fa-post-meta-grid">
            <label>标签（逗号分隔）<input value={tagsInput} onChange={(event) => setTagsInput(event.target.value)} placeholder="hexo, 后台, 发布" /><small>多个标签请使用英文或中文逗号分隔。</small></label>
            <label>分类（逗号分隔）<input value={categoryInput} onChange={(event) => setCategoryInput(event.target.value)} placeholder="开发日志, 产品" /><small>多个分类请使用英文或中文逗号分隔。</small></label>
          </div>
          <div className="fa-post-meta-grid">
            <div className="fa-post-field">
              <span>封面图路径</span>
              <input value={form.cover} onChange={(event) => update("cover", event.target.value)} placeholder="/img/cover.jpg" />
              <div className="fa-post-upload-row"><label className="fa-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={coverUploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) uploadPostImage("cover", file); }} />{coverUploading ? <RefreshCw size={15} className="fa-spin" /> : <Upload size={15} />}{coverUploading ? "上传中" : "上传封面图"}</label>{form.cover ? <span title={form.cover}>{form.cover}</span> : null}</div>
            </div>
            <div className="fa-post-field">
              <span>顶部图路径</span>
              <input value={form.topImage} onChange={(event) => update("topImage", event.target.value)} placeholder="/img/top.jpg" />
              <div className="fa-post-upload-row"><label className="fa-upload-button"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" disabled={topUploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) uploadPostImage("topImage", file); }} />{topUploading ? <RefreshCw size={15} className="fa-spin" /> : <Upload size={15} />}{topUploading ? "上传中" : "上传顶部图"}</label>{form.topImage ? <span title={form.topImage}>{form.topImage}</span> : null}</div>
            </div>
          </div>
          <div className="fa-post-control-grid">
            <label>发布日期（可选）<input type="datetime-local" value={form.publishedAt} onChange={(event) => update("publishedAt", event.target.value)} /></label>
            <div className="fa-post-toggle-field"><span>草稿</span><div className="fa-post-switch-value"><button type="button" className={`fa-switch ${form.status === "draft" ? "is-on" : ""}`} disabled={!editId} aria-label={editId ? "切换草稿状态" : "新文章固定立即发布"} aria-pressed={form.status === "draft"} onClick={() => { if (editId) update("status", form.status === "draft" ? "published" : "draft"); }}><span /></button><small>{form.status === "draft" ? "是" : "否"}</small></div></div>
            <div className="fa-post-toggle-field"><span>文章置顶</span><div className="fa-post-switch-value"><button type="button" className={`fa-switch ${form.pinned ? "is-on" : ""}`} aria-label="切换文章置顶" aria-pressed={form.pinned} onClick={() => update("pinned", !form.pinned)}><span /></button><small>{form.pinned ? "开" : "关"}</small></div></div>
          </div>
          <label className="fa-post-field-wide">文件名<input value={form.filename} onChange={(event) => update("filename", event.target.value)} placeholder="new-release-note.md" /><small>用于生成文章地址，留空将根据标题自动生成。</small></label>
          <div className="fa-post-content"><span className="fa-post-content-label">Markdown 内容</span><div className="fa-md-editor-wrap"><MdEditorBridge value={form.content} onChange={(value) => update("content", value)} onUploadImage={(file) => uploadAdminMedia(file, "image")} onUploadError={(error) => setMessage(errorText(error, "文章图片上传失败。"))} /></div></div>
          <div className="fa-post-actions">
            {message ? <div className="fa-error">{message}</div> : <span className="fa-draft-note"><Clock3 size={14} />提交后文章立即发布</span>}
            <PrimaryButton type="submit" disabled={saving}>{saving ? <><RefreshCw size={15} className="fa-spin" />发布中</> : <><Save size={15} />{editId ? "保存修改" : "创建文章"}</>}</PrimaryButton>
            <GhostButton type="button" onClick={clearForm}><RefreshCw size={15} />清空内容</GhostButton>
            <GhostButton type="button" onClick={() => navigate("/admin/posts")}><ChevronRight size={15} />返回文章管理</GhostButton>
          </div>
        </section>
      </form>
    </div>
  );
}

type AdminDynamic = {
  id: number;
  body: string;
  publishedAt: string;
  images?: string[];
};

function AdminDynamics() {
  const [items, setItems] = useState<AdminDynamic[]>([]);
  const [body, setBody] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const load = () => {
    void adminRequest<AdminDynamic[]>("/api/admin/dynamics")
      .then((value) => {
        setItems(value);
        setMessage("");
      })
      .catch((error) => {
        setItems([]);
        setMessage(errorText(error, "动态加载失败，请稍后重试。"));
      });
  };
  useEffect(load, []);
  const resetComposer = () => {
    setBody("");
    setImages([]);
    setImageUrl("");
    setEditingId(null);
  };
  const addImageUrl = () => {
    const url = imageUrl.trim();
    if (!url || images.includes(url) || images.length >= 9) return;
    setImages((current) => [...current, url]);
    setImageUrl("");
  };
  const saveDynamic = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    setMessage("");
    try {
      await adminRequest(
        editingId
          ? `/api/admin/dynamics/${editingId}`
          : "/api/admin/dynamics",
        {
          method: editingId ? "PUT" : "POST",
          body: JSON.stringify({ body: body.trim(), images }),
        },
      );
      resetComposer();
      load();
    } catch (error) {
      setMessage(
        errorText(
          error,
          editingId ? "动态更新失败，请稍后重试。" : "动态发布失败，请稍后重试。",
        ),
      );
    } finally {
      setSaving(false);
    }
  };
  const uploadImages = (files: FileList | null) => {
    if (!files?.length) return;
    const remaining = Math.max(0, 9 - images.length);
    const selected = Array.from(files).slice(0, remaining);
    if (!selected.length) return;
    setUploading(true);
    setMessage("");
    void Promise.all(selected.map((file) => uploadAdminMedia(file, "image")))
      .then((urls) =>
        setImages((current) => [...new Set([...current, ...urls])].slice(0, 9)),
      )
      .catch((error) => setMessage(errorText(error, "动态图片上传失败。")))
      .finally(() => setUploading(false));
  };
  const startEditing = (item: AdminDynamic) => {
    setEditingId(item.id);
    setBody(item.body);
    setImages(item.images ?? []);
    setImageUrl("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const remove = async (id: number) => {
    try {
      await adminRequest("/api/admin/dynamics/" + id, { method: "DELETE" });
      if (editingId === id) resetComposer();
      load();
    } catch (error) {
      setMessage(errorText(error, "动态删除失败，请稍后重试。"));
    }
  };
  return (
    <div className="fa-page">
      <PageHeading
        eyebrow="CONTENT CENTER"
        title="动态管理"
        description="像 QQ 空间一样发布文字与图片，也可以随时回来修改。"
      />
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      <form className="fa-panel fa-compose fa-dynamic-compose" onSubmit={saveDynamic}>
        <div className="fa-compose-heading">
          <div>
            <span className="fa-kicker">{editingId ? "EDIT MOMENT" : "NEW MOMENT"}</span>
            <strong>{editingId ? "编辑动态" : "分享新动态"}</strong>
          </div>
          {editingId ? (
            <GhostButton onClick={resetComposer}>
              <RotateCcw size={14} />
              取消编辑
            </GhostButton>
          ) : null}
        </div>
        <div className="fa-post-content fa-dynamic-markdown"><span className="fa-post-content-label">Markdown 内容</span><div className="fa-md-editor-wrap"><MdEditorBridge value={body} onChange={setBody} onUploadImage={(file) => uploadAdminMedia(file, "image")} onUploadError={(error) => setMessage(errorText(error, "动态图片上传失败。"))} /></div></div>
        {images.length ? (
          <div className="fa-image-grid fa-image-grid-editor">
            {images.map((url) => (
              <figure key={url}>
                <img src={resolveAdminMediaUrl(url)} alt="动态图片预览" />
                <button
                  type="button"
                  title="移除图片"
                  onClick={() =>
                    setImages((current) => current.filter((item) => item !== url))
                  }
                >
                  <X size={14} />
                </button>
              </figure>
            ))}
          </div>
        ) : null}
        <div className="fa-dynamic-media-row">
          <label className="fa-upload-button">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              multiple
              disabled={uploading || images.length >= 9}
              onChange={(event) => {
                uploadImages(event.target.files);
                event.target.value = "";
              }}
            />
            {uploading ? (
              <RefreshCw size={15} className="fa-spin" />
            ) : (
              <ImageIcon size={15} />
            )}
            {uploading ? "上传中" : "上传图片"}
          </label>
          <div className="fa-url-adder">
            <Link2 size={15} />
            <input
              value={imageUrl}
              onChange={(event) => setImageUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addImageUrl();
                }
              }}
              placeholder="粘贴图床链接"
              disabled={images.length >= 9}
            />
            <button type="button" onClick={addImageUrl} disabled={images.length >= 9}>
              添加
            </button>
          </div>
          <span>{images.length}/9 张</span>
        </div>
        <div className="fa-compose-footer">
          <span>{body.length}/10000</span>
          <PrimaryButton type="submit" disabled={saving || uploading}>
            {saving ? <RefreshCw size={15} className="fa-spin" /> : editingId ? <Save size={15} /> : <Plus size={15} />}
            {saving ? "保存中" : editingId ? "保存修改" : "发布动态"}
          </PrimaryButton>
        </div>
      </form>
      <section className="fa-feed">
        {items.length ? (
          items.map((item) => (
            <article className="fa-feed-item fa-dynamic-feed-item" key={item.id}>
              <div className="fa-feed-content">
                <time>{dateText(item.publishedAt)}</time>
                <p className="fa-markdown-source-preview">{item.body.slice(0, 280)}{item.body.length > 280 ? "…" : ""}</p>
                {item.images?.length ? (
                  <div className="fa-image-grid">
                    {item.images.map((url) => (
                      <a href={url} target="_blank" rel="noreferrer" key={url}>
                        <img src={resolveAdminMediaUrl(url)} alt="动态配图" loading="lazy" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="fa-feed-actions">
                <button type="button" title="编辑" onClick={() => startEditing(item)}>
                  <Pencil size={15} />
                </button>
                <button type="button" title="删除" onClick={() => void remove(item.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="fa-panel">
            <EmptyState>还没有动态记录</EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}

type ManagedPage = { page: string; title: string; content: string; friendLinksIntro: string; friendLinks: Array<{ name: string; url: string; logo: string; description: string }> };
const EMPTY_MANAGED_PAGE = (page: string): ManagedPage => ({ page, title: page === "about" ? "关于" : page === "transfer" ? "传送" : "问题总结", content: "", friendLinksIntro: "", friendLinks: [] });

function AdminPages() {
  const [page, setPage] = useState("about");
  const [form, setForm] = useState<ManagedPage>(() => EMPTY_MANAGED_PAGE("about"));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const load = () => {
    setLoading(true);
    void adminRequest<unknown>(`/api/admin/pages/content?page=${page}`).then((value) => {
      const source = valueRecord(value); const defaults = EMPTY_MANAGED_PAGE(page); const links = Array.isArray(source.friendLinks) ? source.friendLinks : [];
      setForm({ page, title: firstString(defaults.title, source.title), content: firstString("", source.content, source.body), friendLinksIntro: firstString("", source.friendLinksIntro), friendLinks: links.flatMap((item) => { const row = valueRecord(item); return [{ name: firstString("", row.name), url: firstString("", row.url), logo: firstString("", row.logo, row.image), description: firstString("", row.description, row.text) }]; }) });
      setMessage("");
    }).catch((error) => setMessage(errorText(error, "页面内容加载失败。"))).finally(() => setLoading(false));
  };
  useEffect(load, [page]);
  const update = (patch: Partial<ManagedPage>) => setForm((current) => ({ ...current, ...patch }));
  const save = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setMessage(""); try { await adminRequest(`/api/admin/pages/content?page=${page}`, { method: "POST", body: JSON.stringify({ page, title: form.title.trim(), content: form.content, friendLinksIntro: form.friendLinksIntro, friendLinks: form.friendLinks }) }); setMessage("页面内容已保存。"); } catch (error) { setMessage(errorText(error, "页面内容保存失败。")); } finally { setSaving(false); } };
  const patchLink = (index: number, patch: Partial<ManagedPage["friendLinks"][number]>) => update({ friendLinks: form.friendLinks.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  return <div className="fa-page fa-managed-pages"><PageHeading eyebrow="CONTENT CENTER" title="页面管理" description="编辑关于、传送和问题总结页面，正文支持 Markdown。" /><div className="fa-settings-nav fa-managed-page-tabs">{[["about", "关于页面"], ["transfer", "传送页面"], ["issues", "问题总结"]].map(([value, label]) => <button type="button" className={page === value ? "is-active" : ""} key={value} onClick={() => setPage(value)}>{label}</button>)}</div>{message ? <div className={message.includes("失败") ? "fa-error fa-page-error" : "fa-success fa-page-error"}>{message}</div> : null}<form className="fa-panel fa-managed-page-form" onSubmit={save}><label>页面标题<input value={form.title} onChange={(event) => update({ title: event.target.value })} required /></label><div className="fa-post-content"><span className="fa-post-content-label">Markdown 正文</span><div className="fa-md-editor-wrap">{loading ? <div className="fa-settings-loading">正在加载页面内容...</div> : <MdEditorBridge value={form.content} onChange={(value) => update({ content: value })} onUploadImage={(file) => uploadAdminMedia(file, "image")} onUploadError={(error) => setMessage(errorText(error, "图片上传失败。"))} />}</div></div>{page === "transfer" ? <><label>友链介绍<textarea value={form.friendLinksIntro} onChange={(event) => update({ friendLinksIntro: event.target.value })} rows={3} /></label><div className="fa-managed-links"><div className="fa-panel-head"><div><h2>友链跳转</h2><p>自定义名称、地址、图片标志和描述。</p></div><GhostButton onClick={() => update({ friendLinks: [...form.friendLinks, { name: "", url: "", logo: "", description: "" }] })}><Plus size={14} />新增友链</GhostButton></div>{form.friendLinks.map((link, index) => <div className="fa-managed-link-row" key={`${index}-${link.url}`}><input placeholder="名称" value={link.name} onChange={(event) => patchLink(index, { name: event.target.value })} /><input placeholder="跳转链接" value={link.url} onChange={(event) => patchLink(index, { url: event.target.value })} /><input placeholder="图片地址" value={link.logo} onChange={(event) => patchLink(index, { logo: event.target.value })} /><AdminMediaUpload kind="image" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" label="上传标志" onError={(error) => setMessage(errorText(error, "友链图片上传失败。"))} onUploaded={(url) => patchLink(index, { logo: url })} /><input className="fa-managed-link-description" placeholder="描述" value={link.description} onChange={(event) => patchLink(index, { description: event.target.value })} /><button type="button" title="删除友链" onClick={() => update({ friendLinks: form.friendLinks.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={15} /></button></div>)}</div></> : null}<div className="fa-compose-footer"><span>{form.content.length} 字符</span><PrimaryButton type="submit" disabled={saving || loading}>{saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}{saving ? "保存中" : "保存页面"}</PrimaryButton></div></form></div>;
}

type AdminAuthorSkill = {
  name: string;
  level: number;
  description: string;
  icon: string;
};

type AdminAuthorLearning = {
  name: string;
  progress: number;
  description: string;
  status: string;
};

type AdminAuthorProfileForm = {
  name: string;
  bio: string;
  avatar: string;
  email: string;
  githubUrl: string;
  qqUrl: string;
  rssUrl: string;
  links: SiteLink[];
  profile: {
    headline: string;
    introduction: string;
    location: string;
    website: string;
    skills: AdminAuthorSkill[];
    learningProgress: AdminAuthorLearning[];
  };
};

type AdminAuthorHeatmap = {
  from: string;
  to: string;
  totalPosts: number;
  activeDays: number;
};

const EMPTY_AUTHOR_PROFILE: AdminAuthorProfileForm = {
  name: "Firefly",
  bio: "记录生活与技术，也收藏沿途的光。",
  avatar: "",
  email: "",
  githubUrl: "",
  qqUrl: "",
  rssUrl: "/rss.xml",
  links: [],
  profile: {
    headline: "内容创作者 / 开发者",
    introduction: "",
    location: "",
    website: "",
    skills: [],
    learningProgress: [],
  },
};

function boundedPercent(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 0;
}

function normalizeAdminAuthorProfile(value: unknown) {
  const response = valueRecord(value);
  const author = valueRecord(response.author ?? response);
  const profile = valueRecord(author.profile);
  const rawSkills = Array.isArray(profile.skills) ? profile.skills : [];
  const rawLearning = Array.isArray(profile.learningProgress)
    ? profile.learningProgress
    : [];
  const rawLinks = Array.isArray(author.links) ? author.links : [];
  const heatmapSource = valueRecord(response.heatmap);
  const days = Array.isArray(heatmapSource.days) ? heatmapSource.days : [];
  const form: AdminAuthorProfileForm = {
    name: firstString(EMPTY_AUTHOR_PROFILE.name, author.name),
    bio: firstString(EMPTY_AUTHOR_PROFILE.bio, author.bio),
    avatar: firstString("", author.avatar),
    email: firstString("", author.email),
    githubUrl: firstString("", author.githubUrl),
    qqUrl: firstString("", author.qqUrl),
    rssUrl: firstString(EMPTY_AUTHOR_PROFILE.rssUrl, author.rssUrl),
    links: rawLinks.flatMap((item) => {
      const link = valueRecord(item);
      const label = firstString("", link.label);
      const url = firstString("", link.url);
      return label || url
        ? [{ label, url, icon: firstString("link", link.icon) }]
        : [];
    }),
    profile: {
      headline: firstString(EMPTY_AUTHOR_PROFILE.profile.headline, profile.headline),
      introduction: firstString("", profile.introduction),
      location: firstString("", profile.location),
      website: firstString("", profile.website),
      skills: rawSkills.flatMap((item) => {
        const skill = valueRecord(item);
        const name = firstString("", skill.name);
        return name
          ? [{
              name,
              level: boundedPercent(skill.level),
              description: firstString("", skill.description),
              icon: firstString("code", skill.icon),
            }]
          : [];
      }),
      learningProgress: rawLearning.flatMap((item) => {
        const learning = valueRecord(item);
        const name = firstString("", learning.name);
        return name
          ? [{
              name,
              progress: boundedPercent(learning.progress),
              description: firstString("", learning.description),
              status: firstString("学习中", learning.status),
            }]
          : [];
      }),
    },
  };
  const heatmap: AdminAuthorHeatmap = {
    from: firstString("", heatmapSource.from),
    to: firstString("", heatmapSource.to),
    totalPosts: Math.max(0, Number(heatmapSource.totalPosts) || 0),
    activeDays: days.filter((item) => Number(valueRecord(item).count) > 0).length,
  };
  return { form, heatmap };
}

function AdminAuthorProfile() {
  const [form, setForm] = useState<AdminAuthorProfileForm>(EMPTY_AUTHOR_PROFILE);
  const [heatmap, setHeatmap] = useState<AdminAuthorHeatmap>({
    from: "",
    to: "",
    totalPosts: 0,
    activeDays: 0,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);

  const load = () => {
    setLoading(true);
    setMessage("");
    void adminRequest<unknown>("/api/admin/author-profile")
      .then((value) => {
        const normalized = normalizeAdminAuthorProfile(value);
        setForm(normalized.form);
        setHeatmap(normalized.heatmap);
      })
      .catch((error) =>
        setMessage(errorText(error, "博主主页资料加载失败。")),
      )
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const update = (patch: Partial<AdminAuthorProfileForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const updateProfile = (patch: Partial<AdminAuthorProfileForm["profile"]>) =>
    setForm((current) => ({
      ...current,
      profile: { ...current.profile, ...patch },
    }));
  const patchSkill = (index: number, patch: Partial<AdminAuthorSkill>) =>
    updateProfile({
      skills: form.profile.skills.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    });
  const patchLearning = (index: number, patch: Partial<AdminAuthorLearning>) =>
    updateProfile({
      learningProgress: form.profile.learningProgress.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setMessage("请填写作者名称。");
      return;
    }
    const skills = form.profile.skills
      .filter((item) => item.name.trim())
      .map((item) => ({
        ...item,
        name: item.name.trim(),
        description: item.description.trim(),
        icon: item.icon.trim() || null,
        level: boundedPercent(item.level),
      }));
    const learningProgress = form.profile.learningProgress
      .filter((item) => item.name.trim())
      .map((item) => ({
        ...item,
        name: item.name.trim(),
        description: item.description.trim(),
        status: item.status.trim() || null,
        progress: boundedPercent(item.progress),
      }));
    const links = form.links
      .filter((item) => item.label.trim() && item.url.trim())
      .map((item) => ({
        label: item.label.trim(),
        url: item.url.trim(),
        icon: item.icon?.trim() || null,
      }));
    setSaving(true);
    setMessage("");
    setSaved(false);
    try {
      const value = await adminRequest<unknown>("/api/admin/author-profile", {
        method: "PUT",
        body: JSON.stringify({
          name: form.name.trim(),
          bio: form.bio.trim(),
          avatar: form.avatar.trim(),
          email: form.email.trim(),
          githubUrl: form.githubUrl.trim() || null,
          qqUrl: form.qqUrl.trim() || null,
          rssUrl: form.rssUrl.trim() || null,
          links,
          profile: {
            ...form.profile,
            headline: form.profile.headline.trim(),
            introduction: form.profile.introduction,
            location: form.profile.location.trim(),
            website: form.profile.website.trim() || null,
            skills,
            learningProgress,
          },
        }),
      });
      const normalized = normalizeAdminAuthorProfile(value);
      setForm(normalized.form);
      setHeatmap(normalized.heatmap);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2200);
    } catch (error) {
      setMessage(errorText(error, "博主主页资料保存失败。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fa-page fa-author-profile-admin">
      <PageHeading
        eyebrow="SITE PROFILE"
        title="博主主页"
        description="维护公开作者资料、技能专长和知识学习进度；文章发布热力图会根据已发布文章自动生成。"
        action={
          <Link className="fa-button fa-button-ghost" to="/author" target="_blank">
            <Eye size={15} />
            查看前台
          </Link>
        }
      />
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      {saved ? <div className="fa-success fa-page-error">博主主页资料已保存。</div> : null}
      {loading ? (
        <section className="fa-panel fa-settings-loading">
          <RefreshCw size={18} className="fa-spin" />
          正在加载博主主页资料
        </section>
      ) : (
        <form className="fa-author-profile-form" onSubmit={save}>
          <section className="fa-panel fa-settings-section">
            <div className="fa-settings-section-head">
              <span className="fa-settings-section-icon"><UserRound size={20} /></span>
              <div><strong>作者信息</strong><p>头像、名称和简短介绍同时用于前台侧边栏与博主主页。</p></div>
            </div>
            <div className="fa-author-editor">
              <div className="fa-avatar-editor">
                <div>
                  {form.avatar ? (
                    <img src={resolveAdminMediaUrl(form.avatar)} alt="作者头像预览" />
                  ) : (
                    <UserRound size={32} />
                  )}
                </div>
                <AdminMediaUpload
                  kind="image"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                  label="上传头像"
                  onError={(error) => setMessage(errorText(error, "头像上传失败。"))}
                  onUploaded={(url) => update({ avatar: url })}
                />
              </div>
              <div className="fa-author-fields">
                <div className="fa-settings-grid">
                  <label>作者名称<input value={form.name} maxLength={120} required onChange={(event) => update({ name: event.target.value })} /></label>
                  <label>主页身份标题<input value={form.profile.headline} maxLength={160} placeholder="例如：全栈开发者 / 内容创作者" onChange={(event) => updateProfile({ headline: event.target.value })} /></label>
                </div>
                <label>头像地址<input value={form.avatar} maxLength={2000} placeholder="站内路径或 https:// 图片地址" onChange={(event) => update({ avatar: event.target.value })} /></label>
                <label>侧边栏简介<textarea rows={3} maxLength={255} value={form.bio} onChange={(event) => update({ bio: event.target.value })} /></label>
              </div>
            </div>
            <div className="fa-settings-grid">
              <label>所在地<input value={form.profile.location} maxLength={120} placeholder="例如：中国 · 上海" onChange={(event) => updateProfile({ location: event.target.value })} /></label>
              <label>个人网站<input value={form.profile.website} maxLength={2000} placeholder="https://example.com" onChange={(event) => updateProfile({ website: event.target.value })} /></label>
            </div>
            <div className="fa-post-content">
              <span className="fa-post-content-label">主页详细介绍（Markdown）</span>
              <div className="fa-md-editor-wrap fa-author-introduction-editor">
                <MdEditorBridge
                  value={form.profile.introduction}
                  onChange={(value) => updateProfile({ introduction: value })}
                  onUploadImage={(file) => uploadAdminMedia(file, "image")}
                  onUploadError={(error) => setMessage(errorText(error, "介绍图片上传失败。"))}
                />
              </div>
            </div>
          </section>

          <section className="fa-panel fa-settings-section">
            <div className="fa-settings-section-head fa-author-list-heading">
              <span className="fa-settings-section-icon"><Gauge size={20} /></span>
              <div><strong>技能专长</strong><p>熟练度会以进度条展示，图标标识可填写简短英文关键词。</p></div>
              <GhostButton onClick={() => updateProfile({ skills: [...form.profile.skills, { name: "", level: 60, description: "", icon: "code" }] })} disabled={form.profile.skills.length >= 24}><Plus size={14} />新增技能</GhostButton>
            </div>
            <div className="fa-author-item-list">
              {form.profile.skills.length ? form.profile.skills.map((skill, index) => (
                <div className="fa-author-item-row" key={`skill-${index}`}>
                  <div className="fa-author-item-fields">
                    <label>技能名称<input value={skill.name} maxLength={80} placeholder="React" onChange={(event) => patchSkill(index, { name: event.target.value })} /></label>
                    <label>图标标识<input value={skill.icon} maxLength={80} placeholder="code" onChange={(event) => patchSkill(index, { icon: event.target.value })} /></label>
                    <label className="fa-author-progress-field"><span>熟练度 <output>{skill.level}%</output></span><input type="range" min="0" max="100" value={skill.level} onChange={(event) => patchSkill(index, { level: Number(event.target.value) })} /></label>
                    <label className="fa-author-description-field">说明<input value={skill.description} maxLength={240} placeholder="擅长方向、经验或应用场景" onChange={(event) => patchSkill(index, { description: event.target.value })} /></label>
                  </div>
                  <button type="button" className="fa-author-remove" title="删除技能" aria-label={`删除技能 ${index + 1}`} onClick={() => updateProfile({ skills: form.profile.skills.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={15} /></button>
                </div>
              )) : <div className="fa-author-empty"><EmptyState>还没有添加技能专长</EmptyState><GhostButton onClick={() => updateProfile({ skills: [{ name: "", level: 60, description: "", icon: "code" }] })}><Plus size={14} />新增第一项技能</GhostButton></div>}
            </div>
          </section>

          <section className="fa-panel fa-settings-section">
            <div className="fa-settings-section-head fa-author-list-heading">
              <span className="fa-settings-section-icon"><BookOpen size={20} /></span>
              <div><strong>知识学习进度</strong><p>展示当前正在学习或计划深入的知识方向和完成进度。</p></div>
              <GhostButton onClick={() => updateProfile({ learningProgress: [...form.profile.learningProgress, { name: "", progress: 30, description: "", status: "学习中" }] })} disabled={form.profile.learningProgress.length >= 24}><Plus size={14} />新增项目</GhostButton>
            </div>
            <div className="fa-author-item-list">
              {form.profile.learningProgress.length ? form.profile.learningProgress.map((learning, index) => (
                <div className="fa-author-item-row" key={`learning-${index}`}>
                  <div className="fa-author-item-fields">
                    <label>知识方向<input value={learning.name} maxLength={120} placeholder="例如：Web 性能优化" onChange={(event) => patchLearning(index, { name: event.target.value })} /></label>
                    <label>当前状态<input value={learning.status} maxLength={80} placeholder="学习中" onChange={(event) => patchLearning(index, { status: event.target.value })} /></label>
                    <label className="fa-author-progress-field"><span>学习进度 <output>{learning.progress}%</output></span><input type="range" min="0" max="100" value={learning.progress} onChange={(event) => patchLearning(index, { progress: Number(event.target.value) })} /></label>
                    <label className="fa-author-description-field">说明<input value={learning.description} maxLength={240} placeholder="当前目标、学习内容或备注" onChange={(event) => patchLearning(index, { description: event.target.value })} /></label>
                  </div>
                  <button type="button" className="fa-author-remove" title="删除学习项目" aria-label={`删除学习项目 ${index + 1}`} onClick={() => updateProfile({ learningProgress: form.profile.learningProgress.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={15} /></button>
                </div>
              )) : <div className="fa-author-empty"><EmptyState>还没有添加学习进度</EmptyState><GhostButton onClick={() => updateProfile({ learningProgress: [{ name: "", progress: 30, description: "", status: "学习中" }] })}><Plus size={14} />新增第一项学习项目</GhostButton></div>}
            </div>
          </section>

          <section className="fa-panel fa-settings-section">
            <div className="fa-settings-section-head">
              <span className="fa-settings-section-icon"><Link2 size={20} /></span>
              <div><strong>联系方式与外部链接</strong><p>这些入口会显示在作者主页，空地址不会对外展示。</p></div>
            </div>
            <div className="fa-settings-grid">
              <label>Email<input type="email" value={form.email} maxLength={190} placeholder="you@example.com" onChange={(event) => update({ email: event.target.value })} /></label>
              <label>GitHub<input value={form.githubUrl} maxLength={2000} placeholder="https://github.com/yourname" onChange={(event) => update({ githubUrl: event.target.value })} /></label>
              <label>QQ 跳转链接<input value={form.qqUrl} maxLength={2000} placeholder="https://wpa.qq.com/..." onChange={(event) => update({ qqUrl: event.target.value })} /></label>
              <label>RSS 地址<input value={form.rssUrl} maxLength={2000} placeholder="/rss.xml" onChange={(event) => update({ rssUrl: event.target.value })} /></label>
            </div>
            <div className="fa-custom-links-head">
              <div><strong>自定义链接</strong><span>添加其他主页、社交账号或作品入口。</span></div>
              <GhostButton onClick={() => update({ links: [...form.links, { label: "", url: "", icon: "link" }] })} disabled={form.links.length >= 24}><Plus size={14} />添加链接</GhostButton>
            </div>
            <div className="fa-custom-links">
              {form.links.length ? form.links.map((link, index) => (
                <div key={`author-link-${index}`}>
                  <input value={link.label} maxLength={80} aria-label={`链接 ${index + 1} 名称`} placeholder="名称" onChange={(event) => update({ links: form.links.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} />
                  <input value={link.url} maxLength={2000} aria-label={`链接 ${index + 1} 地址`} placeholder="https://example.com" onChange={(event) => update({ links: form.links.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item) })} />
                  <input value={link.icon ?? ""} maxLength={80} aria-label={`链接 ${index + 1} 图标`} placeholder="图标标识" onChange={(event) => update({ links: form.links.map((item, itemIndex) => itemIndex === index ? { ...item, icon: event.target.value } : item) })} />
                  <button type="button" title="删除链接" aria-label={`删除自定义链接 ${index + 1}`} onClick={() => update({ links: form.links.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={15} /></button>
                </div>
              )) : <div className="fa-author-empty"><EmptyState>还没有自定义链接</EmptyState><GhostButton onClick={() => update({ links: [{ label: "", url: "", icon: "link" }] })}><Plus size={14} />新增第一条链接</GhostButton></div>}
            </div>
          </section>

          <footer className="fa-panel fa-author-profile-savebar">
            <div>
              <strong>文章发布热力图</strong>
              <span>{heatmap.from && heatmap.to ? `${heatmap.from} 至 ${heatmap.to} · ${heatmap.totalPosts} 篇文章 · ${heatmap.activeDays} 个活跃日` : "保存后，热力图会根据最近 365 天已发布文章自动更新。"}</span>
            </div>
            <GhostButton onClick={load} disabled={loading || saving}><RefreshCw size={15} />重新加载</GhostButton>
            <PrimaryButton type="submit" disabled={saving}>
              {saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}
              {saving ? "保存中" : saved ? "已保存" : "保存主页"}
            </PrimaryButton>
          </footer>
        </form>
      )}
    </div>
  );
}

type AdminChangelogItem = { id: number; title: string; version: string; publishedAt: string | null; status: "draft" | "published"; content: string };
function AdminChangelog() {
  const navigate = useNavigate();
  const [items, setItems] = useState<AdminChangelogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const load = () => {
    setLoading(true);
    void adminRequest<unknown>("/api/admin/changelog").then((value) => {
      const payload = valueRecord(value);
      const rows = Array.isArray(value) ? value : Array.isArray(payload.items) ? payload.items : [];
      setItems(rows.flatMap((item) => {
        const row = valueRecord(item); const id = Number(row.id);
        if (!Number.isFinite(id)) return [];
        return [{ id, title: firstString("未命名更新", row.title), version: firstString("", row.version, row.versionNumber), publishedAt: typeof row.publishedAt === "string" ? row.publishedAt : null, status: String(row.status ?? "draft") === "published" ? "published" : "draft", content: firstString("", row.content, row.body) }];
      }));
    }).catch((error) => setMessage(errorText(error, "更新日志加载失败。"))).finally(() => setLoading(false));
  };
  useEffect(load, []);
  const remove = async (id: number) => { if (!window.confirm("确认删除这条更新日志？")) return; try { await adminRequest(`/api/admin/changelog/${id}`, { method: "DELETE" }); load(); } catch (error) { setMessage(errorText(error, "删除失败。")); } };
  return <div className="fa-page fa-changelog"><PageHeading eyebrow="CONTENT CENTER" title="更新日志" description="记录每次版本更新，正文支持 Markdown。" action={<PrimaryButton onClick={() => navigate("/admin/changelog/new")}><Plus size={15} />新建日志</PrimaryButton>} />{message ? <div className="fa-error fa-page-error">{message}</div> : null}<section className="fa-panel"><div className="fa-table-wrap"><table className="fa-table"><thead><tr><th>标题</th><th>版本号</th><th>发布日期</th><th>状态</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan={5}><div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载</div></td></tr> : items.length ? items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong></td><td>{item.version || "-"}</td><td>{dateText(item.publishedAt)}</td><td><span className={`fa-pill ${item.status}`}>{item.status === "published" ? "已发布" : "草稿"}</span></td><td><div className="fa-inline-actions"><button type="button" title="编辑" onClick={() => navigate(`/admin/changelog/${item.id}/edit`)}><Pencil size={14} /></button><button type="button" title="删除" onClick={() => void remove(item.id)}><Trash2 size={14} /></button></div></td></tr>) : <tr><td colSpan={5}><EmptyState>暂无更新日志</EmptyState></td></tr>}</tbody></table></div></section></div>;
}
function AdminChangelogEditor({ editId }: { editId?: number }) {
  const navigate = useNavigate();
  const [form, setForm] = useState<AdminChangelogItem>({ id: 0, title: "", version: "", publishedAt: "", status: "draft", content: "" });
  const [saving, setSaving] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { if (!editId) return; void adminRequest<unknown>(`/api/admin/changelog/${editId}`).then((value) => { const row = valueRecord(value); setForm({ id: editId, title: firstString("", row.title), version: firstString("", row.version, row.versionNumber), publishedAt: typeof row.publishedAt === "string" ? toDateTimeLocal(row.publishedAt) : "", status: String(row.status ?? "draft") === "published" ? "published" : "draft", content: firstString("", row.content, row.body) }); }).catch((error) => setMessage(errorText(error, "更新日志加载失败。"))); }, [editId]);
  const update = (patch: Partial<AdminChangelogItem>) => setForm((current) => ({ ...current, ...patch }));
  const save = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setMessage(""); try { await adminRequest(editId ? `/api/admin/changelog/${editId}` : "/api/admin/changelog", { method: editId ? "PUT" : "POST", body: JSON.stringify({ title: form.title.trim(), version: form.version.trim(), publishedAt: form.publishedAt ? new Date(form.publishedAt).toISOString() : null, status: form.status, content: form.content }) }); navigate("/admin/changelog"); } catch (error) { setMessage(errorText(error, "更新日志保存失败。")); } finally { setSaving(false); } };
  return <div className="fa-page"><PageHeading eyebrow="CONTENT CENTER" title={editId ? "编辑更新日志" : "新建更新日志"} description="标题、版本号和发布日期可随时修改，正文使用 Markdown。" /><form className="fa-panel fa-changelog-editor" onSubmit={save}><div className="fa-post-meta-grid"><label>标题<input value={form.title} onChange={(event) => update({ title: event.target.value })} required /></label><label>版本号<input value={form.version} onChange={(event) => update({ version: event.target.value })} placeholder="v1.2.0" /></label></div><div className="fa-post-meta-grid"><label>发布日期<input type="datetime-local" value={form.publishedAt ?? ""} onChange={(event) => update({ publishedAt: event.target.value })} /></label><label>发布状态<select value={form.status} onChange={(event) => update({ status: event.target.value as AdminChangelogItem["status"] })}><option value="draft">草稿</option><option value="published">已发布</option></select></label></div><div className="fa-post-content"><span className="fa-post-content-label">Markdown 内容</span><div className="fa-md-editor-wrap"><MdEditorBridge value={form.content} onChange={(value) => update({ content: value })} onUploadImage={(file) => uploadAdminMedia(file, "image")} onUploadError={(error) => setMessage(errorText(error, "图片上传失败。"))} /></div></div>{message ? <div className="fa-error">{message}</div> : null}<div className="fa-compose-footer"><GhostButton onClick={() => navigate("/admin/changelog")}><ChevronRight size={15} />返回列表</GhostButton><PrimaryButton type="submit" disabled={saving}>{saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}{saving ? "保存中" : "保存日志"}</PrimaryButton></div></form></div>;
}

function normalizeAdminComments(value: unknown): AdminComment[] {
  let records: unknown[] = [];
  if (Array.isArray(value)) records = value;
  else if (value && typeof value === "object") {
    const payload = value as Record<string, unknown>;
    for (const key of ["items", "comments", "data", "rows"]) {
      if (Array.isArray(payload[key])) {
        records = payload[key] as unknown[];
        break;
      }
    }
  }
  return records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const item = record as Record<string, unknown>;
    const id = Number(item.id ?? item.commentId);
    if (!Number.isSafeInteger(id) || id < 1) return [];
    const rawStatus = String(item.status ?? item.reviewStatus ?? "pending").toLowerCase();
    const status: AdminComment["status"] = rawStatus === "approved" || rawStatus === "spam" || rawStatus === "rejected" ? rawStatus : "pending";
    const rawUserId = item.userId ?? item.user_id;
    const userId = typeof rawUserId === "string" || typeof rawUserId === "number" ? rawUserId : null;
    return [{
      id,
      postId: item.postId === null || item.post_id === null ? null : Number(item.postId ?? item.post_id) || null,
      authorName: String(item.authorName ?? item.author_name ?? item.nickname ?? item.username ?? "匿名用户"),
      authorEmail: item.authorEmail || item.author_email ? String(item.authorEmail ?? item.author_email) : null,
      authorAvatar: item.authorAvatar || item.author_avatar || item.avatar ? String(item.authorAvatar ?? item.author_avatar ?? item.avatar) : null,
      userId,
      parentId: item.parentId === null || item.parent_id === null ? null : Number(item.parentId ?? item.parent_id) || null,
      body: String(item.body ?? item.content ?? ""),
      status,
      createdAt: String(item.createdAt ?? item.created_at ?? new Date().toISOString()),
      postTitle: item.postTitle || item.post_title ? String(item.postTitle ?? item.post_title) : null,
      ip: item.ip || item.ipAddress || item.ip_address ? String(item.ip ?? item.ipAddress ?? item.ip_address) : null,
      ipLocation: item.ipLocation || item.ip_location || item.location ? String(item.ipLocation ?? item.ip_location ?? item.location) : null,
      device: item.device || item.deviceName ? String(item.device ?? item.deviceName) : null,
      browser: item.browser || item.browserName ? String(item.browser ?? item.browserName) : null,
      userAgent: item.userAgent || item.user_agent ? String(item.userAgent ?? item.user_agent) : null,
      isAdmin: Boolean(item.isAdmin ?? item.is_admin ?? item.admin),
      isAnonymous: Boolean(item.isAnonymous ?? item.is_anonymous),
      floor: item.floor === null || item.floor === undefined ? null : Number(item.floor) || null,
    } satisfies AdminComment];
  });
}

const FEEDBACK_CATEGORY_LABELS: Record<string, string> = {
  bug: "页面问题",
  content: "内容问题",
  suggestion: "功能建议",
  other: "其他",
};

const FEEDBACK_STATUS_LABELS: Record<AdminFeedbackStatus, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
};

function normalizeAdminFeedback(value: unknown): {
  items: AdminFeedbackItem[];
  total: number;
  totalPages: number;
} {
  const payload = valueRecord(value);
  const records = Array.isArray(value)
    ? value
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  const items = records.flatMap((record) => {
    const item = valueRecord(record);
    const id = Number(item.id);
    if (!Number.isSafeInteger(id) || id < 1) return [];
    const rawStatus = String(item.status ?? "open").toLowerCase();
    const status: AdminFeedbackStatus =
      rawStatus === "processing" || rawStatus === "resolved"
        ? rawStatus
        : "open";
    return [{
      id,
      category: firstString("other", item.category, item.type),
      subject: firstString("未命名反馈", item.subject, item.title),
      content: firstString("", item.content, item.body, item.description),
      contact: firstString("", item.contact, item.email),
      pageUrl: firstString("", item.pageUrl, item.page_url, item.url),
      status,
      clientIp: firstString("", item.clientIp, item.client_ip, item.ip),
      clientUa: firstString("", item.clientUa, item.client_ua, item.userAgent),
      createdAt: firstString("", item.createdAt, item.created_at),
      updatedAt: firstString("", item.updatedAt, item.updated_at),
    } satisfies AdminFeedbackItem];
  });
  const total = Number(payload.total);
  const totalPages = Number(payload.totalPages);
  return {
    items,
    total: Number.isFinite(total) ? total : items.length,
    totalPages:
      Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1,
  };
}

function feedbackStatusClass(status: AdminFeedbackStatus) {
  if (status === "resolved") return "approved";
  if (status === "processing") return "processing";
  return "pending";
}

function safeFeedbackPageUrl(value: string) {
  const source = value.trim();
  if (!source) return "";
  if (source.startsWith("/") && !source.startsWith("//")) return source;
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:" ? source : "";
  } catch {
    return "";
  }
}

function AdminFeedback() {
  const [items, setItems] = useState<AdminFeedbackItem[]>([]);
  const [status, setStatus] = useState<"" | AdminFeedbackStatus>("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [selected, setSelected] = useState<AdminFeedbackItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const load = () => {
    const query = new URLSearchParams({ page: String(page), limit: "20" });
    if (status) query.set("status", status);
    if (keyword.trim()) query.set("keyword", keyword.trim());
    setLoading(true);
    setMessage("");
    void adminRequest<unknown>("/api/admin/feedback?" + query.toString())
      .then((value) => {
        const normalized = normalizeAdminFeedback(value);
        setItems(normalized.items);
        setTotal(normalized.total);
        setTotalPages(normalized.totalPages);
        setSelected((current) =>
          current
            ? normalized.items.find((item) => item.id === current.id) ?? current
            : null,
        );
      })
      .catch((error) => {
        setItems([]);
        setTotal(0);
        setTotalPages(1);
        setMessage(errorText(error, "反馈列表加载失败。"));
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, [page, status]);

  const search = () => {
    if (page !== 1) setPage(1);
    else load();
  };

  const updateStatus = async (
    item: AdminFeedbackItem,
    next: AdminFeedbackStatus,
  ) => {
    if (item.status === next) return;
    setUpdatingId(item.id);
    setMessage("");
    try {
      const value = await adminRequest<unknown>(
        "/api/admin/feedback/" + item.id,
        { method: "PATCH", body: JSON.stringify({ status: next }) },
      );
      const normalized =
        normalizeAdminFeedback({ items: [value] }).items[0] ??
        { ...item, status: next };
      setItems((current) =>
        current.map((entry) => entry.id === item.id ? normalized : entry),
      );
      setSelected((current) => current?.id === item.id ? normalized : current);
    } catch (error) {
      setMessage(errorText(error, "反馈状态更新失败。"));
    } finally {
      setUpdatingId(null);
    }
  };

  const remove = async (item: AdminFeedbackItem) => {
    if (!window.confirm("确认删除反馈“" + item.subject + "”吗？")) return;
    setUpdatingId(item.id);
    setMessage("");
    try {
      await adminRequest("/api/admin/feedback/" + item.id, {
        method: "DELETE",
      });
      setSelected((current) => current?.id === item.id ? null : current);
      if (items.length === 1 && page > 1)
        setPage((current) => current - 1);
      else load();
    } catch (error) {
      setMessage(errorText(error, "反馈删除失败。"));
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="fa-page fa-feedback-page">
      <PageHeading
        eyebrow="SITE MAINTENANCE"
        title="反馈管理"
        description="查看访客提交的问题与建议，并跟踪处理状态。"
        action={
          <GhostButton onClick={load} disabled={loading}>
            <RefreshCw size={15} className={loading ? "fa-spin" : ""} />
            刷新列表
          </GhostButton>
        }
      />
      <div className="fa-toolbar fa-feedback-toolbar">
        <label className="fa-search">
          <Search size={15} />
          <input
            value={keyword}
            placeholder="搜索主题、内容、联系方式或页面"
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") search(); }}
          />
        </label>
        <select
          value={status}
          aria-label="反馈状态"
          onChange={(event) => {
            setPage(1);
            setStatus(event.target.value as "" | AdminFeedbackStatus);
          }}
        >
          <option value="">全部状态</option>
          <option value="open">待处理</option>
          <option value="processing">处理中</option>
          <option value="resolved">已解决</option>
        </select>
        <PrimaryButton onClick={search} disabled={loading}>
          <Search size={15} />查询
        </PrimaryButton>
      </div>
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      <section className="fa-panel fa-feedback-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <Mail size={18} /><h2>访客反馈</h2><span>{total} 条</span>
            </div>
            <p>点击查看完整内容，状态修改会即时保存。</p>
          </div>
        </div>
        <div className="fa-table-wrap">
          <table className="fa-table fa-feedback-table">
            <thead>
              <tr><th>反馈内容</th><th>类型</th><th>联系方式</th><th>提交时间</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载反馈</div></td></tr>
              ) : items.length ? items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button type="button" className="fa-feedback-subject" onClick={() => setSelected(item)}>
                      <strong>{item.subject}</strong>
                      <small>{item.content || "未填写详细内容"}</small>
                    </button>
                  </td>
                  <td>{FEEDBACK_CATEGORY_LABELS[item.category] ?? item.category}</td>
                  <td><span className="fa-feedback-contact">{item.contact || "未填写"}</span></td>
                  <td><span className="fa-date-cell">{dateText(item.createdAt)}</span></td>
                  <td>
                    <select
                      className="fa-feedback-status-select"
                      value={item.status}
                      aria-label={"修改“" + item.subject + "”的处理状态"}
                      disabled={updatingId === item.id}
                      onChange={(event) => void updateStatus(item, event.target.value as AdminFeedbackStatus)}
                    >
                      <option value="open">待处理</option>
                      <option value="processing">处理中</option>
                      <option value="resolved">已解决</option>
                    </select>
                  </td>
                  <td>
                    <div className="fa-inline-actions">
                      <button type="button" title="查看反馈" onClick={() => setSelected(item)}><Eye size={14} /></button>
                      <button type="button" title="删除反馈" disabled={updatingId === item.id} onClick={() => void remove(item)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              )) : (
                <tr><td colSpan={6}><EmptyState>暂无符合条件的反馈</EmptyState></td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="fa-pagination">
          <span>第 {page} / {totalPages} 页</span>
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>上一页</button>
          <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage((current) => current + 1)}>下一页</button>
        </div>
      </section>
      {selected ? (
        <div className="fa-dialog-overlay" role="presentation" onClick={() => setSelected(null)}>
          <section className="fa-dialog fa-feedback-dialog" role="dialog" aria-modal="true" aria-label="反馈详情" onClick={(event) => event.stopPropagation()}>
            <div className="fa-dialog-head">
              <div><span className="fa-kicker">FEEDBACK DETAIL</span><h2>{selected.subject}</h2></div>
              <button type="button" title="关闭" onClick={() => setSelected(null)}><X size={18} /></button>
            </div>
            <div className="fa-feedback-detail-meta">
              <span className={"fa-pill " + feedbackStatusClass(selected.status)}>{FEEDBACK_STATUS_LABELS[selected.status]}</span>
              <span>{FEEDBACK_CATEGORY_LABELS[selected.category] ?? selected.category}</span>
              <time>{dateText(selected.createdAt)}</time>
            </div>
            <div className="fa-feedback-detail-content">{selected.content || "未填写详细内容"}</div>
            <dl className="fa-feedback-detail-list">
              <div><dt>联系方式</dt><dd>{selected.contact || "未填写"}</dd></div>
              <div><dt>来源页面</dt><dd>{safeFeedbackPageUrl(selected.pageUrl) ? <a href={safeFeedbackPageUrl(selected.pageUrl)} target="_blank" rel="noreferrer">{selected.pageUrl}<ExternalLink size={13} /></a> : selected.pageUrl || "未记录"}</dd></div>
              <div><dt>访客 IP</dt><dd>{selected.clientIp || "未记录"}</dd></div>
              <div><dt>客户端</dt><dd>{selected.clientUa || "未记录"}</dd></div>
            </dl>
            <div className="fa-dialog-footer fa-feedback-dialog-footer">
              <select value={selected.status} disabled={updatingId === selected.id} aria-label="处理状态" onChange={(event) => void updateStatus(selected, event.target.value as AdminFeedbackStatus)}>
                <option value="open">待处理</option>
                <option value="processing">处理中</option>
                <option value="resolved">已解决</option>
              </select>
              <button type="button" className="fa-feedback-delete" disabled={updatingId === selected.id} onClick={() => void remove(selected)}><Trash2 size={14} />删除反馈</button>
              <GhostButton onClick={() => setSelected(null)}>关闭</GhostButton>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function AdminComments() {
  const [items, setItems] = useState<AdminComment[]>([]);
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const load = () => {
    setLoading(true);
    const query = new URLSearchParams();
    if (status) query.set("status", status);
    if (keyword.trim()) query.set("keyword", keyword.trim());
    void adminRequestCompatible<unknown>([
      "/api/admin/comments" + (query.size ? "?" + query.toString() : ""),
      "/api/admin/comment-moderation" + (query.size ? "?" + query.toString() : ""),
    ])
      .then((value) => { setItems(normalizeAdminComments(value)); setMessage(""); })
      .catch((error) => { setItems([]); setMessage(errorText(error, "评论加载失败，请稍后重试。")); })
      .finally(() => setLoading(false));
  };
  useEffect(load, [status]);
  const setCommentStatus = async (id: number, next: AdminComment["status"]) => {
    try {
      await adminRequestCompatible([
        "/api/admin/comments/" + id,
        "/api/admin/comment-moderation/" + id,
      ], { method: "PATCH", body: JSON.stringify({ status: next }) });
      load();
    } catch (error) { setMessage(errorText(error, "评论状态更新失败。")); }
  };
  const remove = async (id: number) => {
    if (!window.confirm("确认删除这条评论吗？")) return;
    try {
      await adminRequestCompatible([
        "/api/admin/comments/" + id,
        "/api/admin/comment-moderation/" + id,
      ], { method: "DELETE" });
      load();
    } catch (error) { setMessage(errorText(error, "评论删除失败。")); }
  };
  const pending = items.filter((item) => item.status === "pending").length;
  return (
    <div className="fa-page fa-comments-page">
      <PageHeading
        eyebrow="SITE MAINTENANCE"
        title="评论审核"
        description="处理访客互动，查看楼中楼、访客位置和设备信息，并在发布前进行审核。"
        action={<GhostButton onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? "fa-spin" : ""} />刷新队列</GhostButton>}
      />
      <div className="fa-toolbar fa-comment-toolbar">
        <label className="fa-search"><Search size={15} /><input value={keyword} placeholder="搜索评论、昵称或文章" onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") load(); }} /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="评论状态">
          <option value="">全部状态</option><option value="pending">待审核</option><option value="approved">已通过</option><option value="spam">垃圾评论</option><option value="rejected">已拒绝</option>
        </select>
      </div>
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      <section className="fa-comment-stats">
        <div><MessageCircle size={17} /><span>当前队列</span><strong>{items.length}</strong></div>
        <div><Clock3 size={17} /><span>待审核</span><strong>{pending}</strong></div>
        <div><UserCheck size={17} /><span>已通过</span><strong>{items.filter((item) => item.status === "approved").length}</strong></div>
      </section>
      <section className="fa-panel fa-comment-list">
        {loading ? <div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载评论</div> : items.length ? (
          items.map((item) => (
            <article key={item.id}>
              <header>
                <div className="fa-comment-author">
                  {item.authorAvatar ? <img src={resolveAdminMediaUrl(item.authorAvatar)} alt="" /> : <span><UserRound size={15} /></span>}
                  <div><strong>{item.authorName}</strong>{item.isAdmin ? <em className="fa-admin-badge">管理员</em> : null}{item.isAnonymous ? <small>匿名</small> : null}<span>{item.postTitle ?? "未关联文章"}{item.floor ? ` · ${item.floor} 楼` : ""}</span></div>
                </div>
                <span className={"fa-pill " + item.status}>{item.status === "approved" ? "已通过" : item.status === "spam" ? "垃圾" : item.status === "rejected" ? "已拒绝" : "待审核"}</span>
              </header>
              <p className="fa-comment-body">{item.body}</p>
              <div className="fa-comment-meta">
                {item.ip ? <span><Globe2 size={13} />{item.ip}{item.ipLocation ? ` · ${item.ipLocation}` : ""}</span> : null}
                {item.device ? <span><Monitor size={13} />{item.device}</span> : null}
                {item.browser ? <span><Globe2 size={13} />{item.browser}</span> : null}
                <span><Clock3 size={13} />{dateText(item.createdAt)}</span>
              </div>
              <footer>
                <button type="button" onClick={() => void setCommentStatus(item.id, "approved")}><Check size={14} />通过</button>
                {item.status !== "pending" ? <button type="button" onClick={() => void setCommentStatus(item.id, "pending")}><RotateCcw size={14} />退回待审</button> : null}
                <button type="button" onClick={() => void setCommentStatus(item.id, "spam")}><Ban size={14} />标记垃圾</button>
                <button type="button" className="danger" onClick={() => void remove(item.id)}><Trash2 size={14} />删除</button>
              </footer>
            </article>
          ))
        ) : <EmptyState>暂无评论</EmptyState>}
      </section>
    </div>
  );
}

type CommentSettings = {
  allowAnonymous: boolean;
  requireModeration: boolean;
  emailRegistrationEnabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpPassword: string;
  senderEmail: string;
  senderName: string;
  notificationEmails: string;
  notifyNewUser: boolean;
  notifyNewComment: boolean;
  notifyPendingComment: boolean;
};
const DEFAULT_COMMENT_SETTINGS: CommentSettings = {
  allowAnonymous: false,
  requireModeration: false,
  emailRegistrationEnabled: false,
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: "",
  smtpPassword: "",
  senderEmail: "",
  senderName: "Firefly",
  notificationEmails: "",
  notifyNewUser: true,
  notifyNewComment: true,
  notifyPendingComment: true,
};
const COMMENT_SETTINGS_ENDPOINTS = ["/api/admin/comment-settings", "/api/admin/settings/comments"] as const;
const COMMENT_EMOJI_ENDPOINTS = ["/api/admin/emojis", "/api/admin/comment-emojis"] as const;

function normalizeCommentSettings(value: unknown): CommentSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = source.settings && typeof source.settings === "object" ? source.settings as Record<string, unknown> : source;
  const smtp = nested.smtp && typeof nested.smtp === "object" ? nested.smtp as Record<string, unknown> : nested;
  const notifications = nested.notifications && typeof nested.notifications === "object" ? nested.notifications as Record<string, unknown> : nested;
  const text = (key: string, fallback: string) => typeof nested[key] === "string" ? String(nested[key]) : fallback;
  const bool = (key: string, fallback: boolean) => typeof nested[key] === "boolean" ? Boolean(nested[key]) : fallback;
  return {
    allowAnonymous: bool("allowAnonymous", bool("allow_anonymous", DEFAULT_COMMENT_SETTINGS.allowAnonymous)),
    requireModeration: bool("requireModeration", bool("moderationEnabled", DEFAULT_COMMENT_SETTINGS.requireModeration)),
    emailRegistrationEnabled: bool("emailRegistrationEnabled", bool("emailRegistration", DEFAULT_COMMENT_SETTINGS.emailRegistrationEnabled)),
    smtpHost: text("smtpHost", text("host", "")), smtpPort: Number(smtp.smtpPort ?? smtp.port ?? DEFAULT_COMMENT_SETTINGS.smtpPort) || DEFAULT_COMMENT_SETTINGS.smtpPort,
    smtpSecure: typeof smtp.smtpSecure === "boolean" ? smtp.smtpSecure : typeof smtp.secure === "boolean" ? smtp.secure : DEFAULT_COMMENT_SETTINGS.smtpSecure,
    smtpUsername: String(smtp.smtpUsername ?? smtp.username ?? ""), smtpPassword: String(smtp.smtpPassword ?? smtp.password ?? ""),
    senderEmail: text("senderEmail", text("from", "")), senderName: text("senderName", "Firefly"),
    notificationEmails: String(nested.notificationEmails ?? notifications.emails ?? ""),
    notifyNewUser: typeof notifications.notifyNewUser === "boolean" ? notifications.notifyNewUser : DEFAULT_COMMENT_SETTINGS.notifyNewUser,
    notifyNewComment: typeof notifications.notifyNewComment === "boolean" ? notifications.notifyNewComment : DEFAULT_COMMENT_SETTINGS.notifyNewComment,
    notifyPendingComment: typeof notifications.notifyPendingComment === "boolean" ? notifications.notifyPendingComment : DEFAULT_COMMENT_SETTINGS.notifyPendingComment,
  };
}

type AdminEmoji = { id: string | number; name: string; url: string; size?: number; createdAt?: string | null };
function normalizeAdminEmojis(value: unknown): AdminEmoji[] {
  const records = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as { items: unknown[] }).items : [];
  return records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const item = record as Record<string, unknown>; const url = String(item.url ?? item.path ?? item.src ?? "").trim();
    if (!url) return [];
    return [{ id: (typeof item.id === "string" || typeof item.id === "number") ? item.id : url, name: String(item.name ?? item.title ?? "表情"), url, size: Number(item.size) || undefined, createdAt: item.createdAt || item.created_at ? String(item.createdAt ?? item.created_at) : null }];
  });
}

function AdminCommentSettings() {
  const [settings, setSettings] = useState<CommentSettings>(DEFAULT_COMMENT_SETTINGS);
  const [emojis, setEmojis] = useState<AdminEmoji[]>([]);
  const [emojiName, setEmojiName] = useState(""); const [emojiUrl, setEmojiUrl] = useState("");
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [message, setMessage] = useState("");
  const load = () => {
    setLoading(true);
    void Promise.allSettled([adminRequestCompatible<unknown>(COMMENT_SETTINGS_ENDPOINTS), adminRequestCompatible<unknown>(COMMENT_EMOJI_ENDPOINTS)])
      .then(([settingsResult, emojiResult]) => {
        if (settingsResult.status === "fulfilled") setSettings(normalizeCommentSettings(settingsResult.value));
        if (emojiResult.status === "fulfilled") setEmojis(normalizeAdminEmojis(emojiResult.value));
        if (settingsResult.status === "rejected") setMessage(errorText(settingsResult.reason, "评论设置加载失败。"));
      }).finally(() => setLoading(false));
  };
  useEffect(load, []);
  const update = <K extends keyof CommentSettings>(key: K, value: CommentSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setMessage("");
    try { await adminRequestCompatible(COMMENT_SETTINGS_ENDPOINTS, { method: "PUT", body: JSON.stringify({ ...settings, notificationEmails: settings.notificationEmails.split(/[;,\n]/u).map((value) => value.trim()).filter(Boolean) }) }); setMessage("评论设置已保存。"); }
    catch (error) { setMessage(errorText(error, "评论设置保存失败。")); } finally { setSaving(false); }
  };
  const addEmoji = async (url = emojiUrl) => {
    const value = url.trim(); if (!value) { setMessage("请先上传或填写表情图片地址。"); return; }
    try { await adminRequestCompatible(COMMENT_EMOJI_ENDPOINTS, { method: "POST", body: JSON.stringify({ name: emojiName.trim() || "表情", url: value }) }); setEmojiName(""); setEmojiUrl(""); setMessage("表情包已添加。"); load(); }
    catch (error) { setMessage(errorText(error, "表情包添加失败。")); }
  };
  const removeEmoji = async (item: AdminEmoji) => {
    if (!window.confirm(`确认删除“${item.name}”吗？`)) return;
    try { await adminRequestCompatible(COMMENT_EMOJI_ENDPOINTS.map((path) => path + "/" + encodeURIComponent(String(item.id))), { method: "DELETE" }); load(); }
    catch (error) { setMessage(errorText(error, "表情包删除失败。")); }
  };
  return <div className="fa-page fa-comment-settings-page">
    <PageHeading eyebrow="SITE MAINTENANCE" title="评论设置" description="控制评论身份、审核策略、邮箱服务与共享表情包。" action={<GhostButton onClick={load} disabled={loading || saving}><RefreshCw size={15} className={loading ? "fa-spin" : ""} />重新加载</GhostButton>} />
    {message ? <div className="fa-error fa-page-error">{message}</div> : null}
    {loading ? <section className="fa-panel fa-settings-loading"><RefreshCw size={20} className="fa-spin" />正在加载设置</section> : <form className="fa-settings-workspace" onSubmit={save}>
      <section className="fa-panel fa-settings-section"><div className="fa-settings-section-head"><span className="fa-settings-section-icon"><MessageCircle size={20} /></span><div><strong>评论策略</strong><p>这些开关会即时影响前台评论表单和审核队列。</p></div></div>
        <label className="fa-switch-row"><span><strong>允许匿名评论</strong><small>关闭后，访客必须注册并登录才能评论。</small></span><button type="button" className={`fa-switch ${settings.allowAnonymous ? "is-on" : ""}`} onClick={() => update("allowAnonymous", !settings.allowAnonymous)}><span /></button></label>
        <label className="fa-switch-row"><span><strong>评论审核后发布</strong><small>开启后新评论状态为待审核，审核通过后才展示。</small></span><button type="button" className={`fa-switch ${settings.requireModeration ? "is-on" : ""}`} onClick={() => update("requireModeration", !settings.requireModeration)}><span /></button></label>
        <label className="fa-switch-row"><span><strong>开启邮箱注册验证</strong><small>关闭时用户填写资料后即可注册。</small></span><button type="button" className={`fa-switch ${settings.emailRegistrationEnabled ? "is-on" : ""}`} onClick={() => update("emailRegistrationEnabled", !settings.emailRegistrationEnabled)}><span /></button></label>
      </section>
      <section className="fa-panel fa-settings-section"><div className="fa-settings-section-head"><span className="fa-settings-section-icon"><Mail size={20} /></span><div><strong>SMTP 发件服务</strong><p>用于注册验证码、评论审核与新用户提醒。密码只写入服务端，不会回显。</p></div></div>
        <div className="fa-settings-grid"><label>SMTP 主机<input value={settings.smtpHost} placeholder="smtp.example.com" onChange={(event) => update("smtpHost", event.target.value)} /></label><label>端口<input type="number" min={1} max={65535} value={settings.smtpPort} onChange={(event) => update("smtpPort", Number(event.target.value) || 465)} /></label><label>SMTP 用户名<input value={settings.smtpUsername} onChange={(event) => update("smtpUsername", event.target.value)} /></label><label>SMTP 密码<input type="password" value={settings.smtpPassword} autoComplete="new-password" placeholder="留空则保持原密码" onChange={(event) => update("smtpPassword", event.target.value)} /></label><label>发件邮箱<input type="email" value={settings.senderEmail} placeholder="no-reply@example.com" onChange={(event) => update("senderEmail", event.target.value)} /></label><label>发件人名称<input value={settings.senderName} onChange={(event) => update("senderName", event.target.value)} /></label></div>
        <label className="fa-inline-check"><input type="checkbox" checked={settings.smtpSecure} onChange={(event) => update("smtpSecure", event.target.checked)} />使用 SSL / TLS 安全连接</label>
      </section>
      <section className="fa-panel fa-settings-section"><div className="fa-settings-section-head"><span className="fa-settings-section-icon"><Bell size={20} /></span><div><strong>邮件提醒</strong><p>多个邮箱可用逗号、分号或换行分隔。</p></div></div><label>管理员提醒邮箱<textarea rows={3} value={settings.notificationEmails} placeholder="admin@example.com" onChange={(event) => update("notificationEmails", event.target.value)} /></label><div className="fa-toggle-row"><label><input type="checkbox" checked={settings.notifyNewUser} onChange={(event) => update("notifyNewUser", event.target.checked)} />新用户注册</label><label><input type="checkbox" checked={settings.notifyNewComment} onChange={(event) => update("notifyNewComment", event.target.checked)} />新评论</label><label><input type="checkbox" checked={settings.notifyPendingComment} onChange={(event) => update("notifyPendingComment", event.target.checked)} />待审核提醒</label></div></section>
      <section className="fa-panel fa-settings-section"><div className="fa-settings-section-head"><span className="fa-settings-section-icon"><Smile size={20} /></span><div><strong>共享表情包</strong><p>管理员预设的表情所有用户可用；用户自定义表情空间由前台自行管理。</p></div></div><div className="fa-emoji-add"><input value={emojiName} placeholder="表情名称" onChange={(event) => setEmojiName(event.target.value)} /><input value={emojiUrl} placeholder="图床链接" onChange={(event) => setEmojiUrl(event.target.value)} /><AdminMediaUpload kind="image" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" label="上传表情" onError={(error) => setMessage(errorText(error, "表情上传失败。"))} onUploaded={(url) => { setEmojiUrl(url); void addEmoji(url); }} /><PrimaryButton onClick={() => void addEmoji()}><Plus size={15} />添加</PrimaryButton></div><div className="fa-emoji-grid">{emojis.length ? emojis.map((item) => <article key={String(item.id)}><img src={resolveAdminMediaUrl(item.url)} alt={item.name} /><div><strong>{item.name}</strong><small>{item.size ? bytesText(item.size) : "共享表情"}</small></div><button type="button" title="删除表情" onClick={() => void removeEmoji(item)}><Trash2 size={14} /></button></article>) : <EmptyState>还没有共享表情</EmptyState>}</div></section>
      <footer className="fa-settings-savebar"><div><strong>评论设置</strong><span>修改后保存即可同步到前台。</span></div><PrimaryButton type="submit" disabled={saving}>{saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}{saving ? "保存中" : "保存设置"}</PrimaryButton></footer>
    </form>}
  </div>;
}

type SiteUser = { id: string | number; username: string; nickname: string; email: string; avatar: string; role: string; isActive: boolean; status: string; createdAt: string | null; lastLoginAt: string | null; commentsCount: number; ip: string };
type SiteUserDraft = { username: string; nickname: string; email: string; avatar: string; password: string; isActive: boolean; role: string };
const EMPTY_SITE_USER_DRAFT: SiteUserDraft = { username: "", nickname: "", email: "", avatar: "", password: "", isActive: true, role: "user" };
function normalizeSiteUsers(value: unknown): SiteUser[] {
  const records = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as { items: unknown[] }).items : [];
  return records.flatMap((record) => { if (!record || typeof record !== "object") return []; const item = record as Record<string, unknown>; const rawId = item.id ?? item.userId; if (rawId === undefined || rawId === null) return []; return [{ id: typeof rawId === "string" || typeof rawId === "number" ? rawId : String(rawId), username: String(item.username ?? item.account ?? ""), nickname: String(item.nickname ?? item.displayName ?? item.name ?? item.username ?? ""), email: String(item.email ?? ""), avatar: String(item.avatar ?? item.avatarUrl ?? ""), role: String(item.role ?? (item.isAdmin ? "admin" : "user")), isActive: item.isActive === undefined ? item.status !== "disabled" : Boolean(item.isActive), status: String(item.status ?? "active"), createdAt: item.createdAt || item.created_at ? String(item.createdAt ?? item.created_at) : null, lastLoginAt: item.lastLoginAt || item.last_login_at ? String(item.lastLoginAt ?? item.last_login_at) : null, commentsCount: Number(item.commentsCount ?? item.comments_count ?? 0) || 0, ip: String(item.ip ?? item.lastIp ?? "") } satisfies SiteUser]; });
}

const SITE_USERS_ENDPOINTS = ["/api/admin/users", "/api/admin/comment-users"] as const;
function AdminUsers() {
  const [items, setItems] = useState<SiteUser[]>([]); const [keyword, setKeyword] = useState(""); const [status, setStatus] = useState(""); const [loading, setLoading] = useState(true); const [message, setMessage] = useState(""); const [dialog, setDialog] = useState<"create" | "edit" | "reset" | null>(null); const [selected, setSelected] = useState<SiteUser | null>(null); const [draft, setDraft] = useState<SiteUserDraft>(EMPTY_SITE_USER_DRAFT); const [saving, setSaving] = useState(false);
  const load = () => { setLoading(true); void adminRequestCompatible<unknown>(SITE_USERS_ENDPOINTS).then((value) => { setItems(normalizeSiteUsers(value)); setMessage(""); }).catch((error) => { setItems([]); setMessage(errorText(error, "用户列表加载失败。")); }).finally(() => setLoading(false)); }; useEffect(load, []);
  const openCreate = () => { setSelected(null); setDraft({ ...EMPTY_SITE_USER_DRAFT }); setDialog("create"); }; const openEdit = (item: SiteUser) => { setSelected(item); setDraft({ username: item.username, nickname: item.nickname, email: item.email, avatar: item.avatar, password: "", isActive: item.isActive, role: item.role || "user" }); setDialog("edit"); }; const openReset = (item: SiteUser) => { setSelected(item); setDraft({ ...EMPTY_SITE_USER_DRAFT, username: item.username }); setDialog("reset"); };
  const save = async (event: FormEvent) => { event.preventDefault(); if (!dialog) return; if (dialog === "reset" && draft.password.length < 8) { setMessage("新密码至少需要 8 位。"); return; } if (dialog !== "reset" && !draft.username.trim()) { setMessage("请输入用户账号。"); return; } setSaving(true); setMessage(""); try { const id = encodeURIComponent(String(selected?.id ?? "")); if (dialog === "reset") await adminRequestCompatible(SITE_USERS_ENDPOINTS.map((path) => `${path}/${id}/reset-password`), { method: "POST", body: JSON.stringify({ password: draft.password }) }); else await adminRequestCompatible(dialog === "create" ? SITE_USERS_ENDPOINTS : SITE_USERS_ENDPOINTS.map((path) => `${path}/${id}`), { method: dialog === "create" ? "POST" : "PATCH", body: JSON.stringify({ username: draft.username.trim(), nickname: draft.nickname.trim(), email: draft.email.trim() || null, avatar: draft.avatar.trim() || null, password: draft.password || undefined, isActive: draft.isActive, role: draft.role }) }); setDialog(null); setMessage(dialog === "create" ? "用户已创建。" : dialog === "reset" ? "密码已重置。" : "用户已更新。"); load(); } catch (error) { setMessage(errorText(error, "用户保存失败。")); } finally { setSaving(false); } };
  const remove = async (item: SiteUser) => { if (!window.confirm(`确认删除用户“${item.nickname || item.username}”吗？`)) return; try { await adminRequestCompatible(SITE_USERS_ENDPOINTS.map((path) => `${path}/${encodeURIComponent(String(item.id))}`), { method: "DELETE" }); setMessage("用户已删除。"); load(); } catch (error) { setMessage(errorText(error, "用户删除失败。")); } };
  const filtered = items.filter((item) => (!status || (status === "active" ? item.isActive : !item.isActive)) && (!keyword.trim() || `${item.username} ${item.nickname} ${item.email}`.toLowerCase().includes(keyword.trim().toLowerCase())));
  return <div className="fa-page fa-users-page"><PageHeading eyebrow="SITE MAINTENANCE" title="用户管理" description="维护注册用户、登录状态和评论身份。管理员用户请在管理员账号页面管理。" action={<PrimaryButton onClick={openCreate}><Plus size={15} />新增用户</PrimaryButton>} />{message ? <div className="fa-error fa-page-error">{message}</div> : null}<div className="fa-toolbar"><label className="fa-search"><Search size={15} /><input value={keyword} placeholder="搜索账号、昵称或邮箱" onChange={(event) => setKeyword(event.target.value)} /></label><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="用户状态"><option value="">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option></select><GhostButton onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? "fa-spin" : ""} />刷新</GhostButton></div><section className="fa-panel fa-users-panel"><div className="fa-panel-head"><div><div className="fa-panel-title"><Users size={18} /><h2>注册用户</h2><span>{filtered.length}</span></div><p>用户头像、邮箱等隐私信息只在管理员后台显示。</p></div></div><div className="fa-table-wrap"><table className="fa-table fa-users-table"><thead><tr><th>用户</th><th>邮箱</th><th>评论</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan={6}><div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载用户</div></td></tr> : filtered.length ? filtered.map((item) => <tr key={String(item.id)}><td><div className="fa-account-cell">{item.avatar ? <img className="fa-user-avatar" src={resolveAdminMediaUrl(item.avatar)} alt="" /> : <span className="fa-account-avatar"><UserRound size={15} /></span>}<span><strong>{item.nickname || item.username}</strong><small>{item.username}{item.ip ? ` · ${item.ip}` : ""}</small></span>{item.role !== "user" ? <em>{item.role}</em> : null}</div></td><td>{item.email || "未填写"}</td><td>{item.commentsCount}</td><td><span className={`fa-pill ${item.isActive ? "approved" : "disabled"}`}>{item.isActive ? "正常" : "已停用"}</span></td><td><span className="fa-date-cell">{dateText(item.createdAt)}</span></td><td><div className="fa-inline-actions"><button type="button" title="编辑用户" onClick={() => openEdit(item)}><Pencil size={14} /></button><button type="button" title="重置密码" onClick={() => openReset(item)}><RotateCcw size={14} /></button><button type="button" title="删除用户" onClick={() => void remove(item)}><Trash2 size={14} /></button></div></td></tr>) : <tr><td colSpan={6}><EmptyState>暂无注册用户</EmptyState></td></tr>}</tbody></table></div></section>{dialog ? <div className="fa-dialog-overlay" role="presentation" onClick={() => !saving && setDialog(null)}><form className="fa-dialog fa-user-dialog" onSubmit={save} onClick={(event) => event.stopPropagation()}><div className="fa-dialog-head"><div><span className="fa-kicker">{dialog === "create" ? "NEW USER" : dialog === "reset" ? "PASSWORD RESET" : "EDIT USER"}</span><h2>{dialog === "create" ? "新增用户" : dialog === "reset" ? "重置用户密码" : "编辑用户"}</h2></div><button type="button" title="关闭" onClick={() => setDialog(null)}><X size={18} /></button></div>{dialog === "reset" ? <label>新密码<input type="password" value={draft.password} minLength={8} autoComplete="new-password" onChange={(event) => setDraft({ ...draft, password: event.target.value })} required /></label> : <><div className="fa-user-form-grid"><label>账号<input value={draft.username} minLength={3} maxLength={80} autoFocus={dialog === "create"} onChange={(event) => setDraft({ ...draft, username: event.target.value })} required /></label><label>昵称<input value={draft.nickname} maxLength={120} onChange={(event) => setDraft({ ...draft, nickname: event.target.value })} required /></label><label>邮箱<input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label><label>角色<select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}><option value="user">普通用户</option><option value="moderator">评论管理员</option><option value="admin">管理员徽标</option></select></label><label className="fa-user-avatar-field">头像地址<input value={draft.avatar} placeholder="可选图床链接" onChange={(event) => setDraft({ ...draft, avatar: event.target.value })} /><AdminMediaUpload kind="image" accept="image/jpeg,image/png,image/webp,image/gif" label="上传头像" onError={(error) => setMessage(errorText(error, "头像上传失败。"))} onUploaded={(url) => setDraft((current) => ({ ...current, avatar: url }))} /></label><label>密码{dialog === "create" ? "（至少 8 位）" : "（留空不修改）"}<input type="password" minLength={dialog === "create" ? 8 : undefined} value={draft.password} autoComplete="new-password" onChange={(event) => setDraft({ ...draft, password: event.target.value })} required={dialog === "create"} /></label></div><label className="fa-inline-check"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />允许登录</label></>}{message ? <div className="fa-error">{message}</div> : null}<div className="fa-dialog-footer"><GhostButton onClick={() => setDialog(null)} disabled={saving}>取消</GhostButton><PrimaryButton type="submit" disabled={saving}>{saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}{saving ? "保存中" : "保存用户"}</PrimaryButton></div></form></div> : null}</div>;
}

type UserSpaceCategory = Record<string, number>;
type AdminUserSpace = {
  limitBytes: number;
  usedBytes: number;
  remainingBytes: number;
  categories: UserSpaceCategory;
};
type AdminSpaceUser = {
  id: number;
  account: string;
  nickname: string;
  email: string | null;
  avatar: string;
  isActive: boolean;
  createdAt: string;
  space: AdminUserSpace;
};
type AdminSpaceItem = {
  id: number;
  kind: string;
  name: string;
  url: string;
  mimeType: string;
  byteSize: number;
  isPublic: boolean;
  publicUrl: string | null;
  viewCount: number;
  createdAt: string;
};
type AdminSpaceClipboard = {
  id: number;
  title: string;
  content?: string;
  byteSize: number;
  isPublic: boolean;
  publicUrl: string | null;
  viewCount: number;
  createdAt: string;
  updatedAt: string;
};
type AdminSpaceSticker = {
  id: number;
  name: string;
  url: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
};
type AdminUserSpaceDetail = { space: AdminUserSpace; items: AdminSpaceItem[]; clipboards: AdminSpaceClipboard[]; stickers: AdminSpaceSticker[] };

function numberValue(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}
function normalizeAdminSpace(value: unknown): AdminUserSpace {
  const source = valueRecord(value);
  const categoriesSource = valueRecord(source.categories);
  const categories = Object.fromEntries(Object.entries(categoriesSource).map(([key, item]) => [key, numberValue(item)]));
  const usedBytes = numberValue(source.usedBytes ?? source.used ?? source.total) || Object.values(categories).reduce((total, item) => total + item, 0);
  const limitBytes = numberValue(source.limitBytes ?? source.limit) || 30 * 1024 * 1024;
  return { limitBytes, usedBytes, remainingBytes: Math.max(0, numberValue(source.remainingBytes ?? source.remaining) || limitBytes - usedBytes), categories };
}
function normalizeAdminSpaceUsers(value: unknown): AdminSpaceUser[] {
  const source = Array.isArray(value) ? value : Array.isArray(valueRecord(value).items) ? valueRecord(value).items as unknown[] : [];
  return source.flatMap((entry) => {
    const row = valueRecord(entry); const id = Number(row.id ?? row.userId);
    if (!Number.isSafeInteger(id) || id < 1) return [];
    return [{ id, account: String(row.account ?? row.username ?? ""), nickname: String(row.nickname ?? row.account ?? row.username ?? ""), email: typeof row.email === "string" ? row.email : null, avatar: String(row.avatar ?? row.avatarUrl ?? ""), isActive: row.isActive === undefined ? Boolean(row.is_active ?? true) : Boolean(row.isActive), createdAt: String(row.createdAt ?? row.created_at ?? ""), space: normalizeAdminSpace(row.space) }];
  });
}
function normalizeAdminSpaceDetail(value: unknown): AdminUserSpaceDetail {
  const source = valueRecord(value);
  const items = Array.isArray(source.items) ? source.items.flatMap((entry) => { const row = valueRecord(entry); const id = Number(row.id); return Number.isSafeInteger(id) ? [{ id, kind: String(row.kind ?? "图片"), name: String(row.name ?? "未命名图片"), url: String(row.url ?? row.storageUrl ?? ""), mimeType: String(row.mimeType ?? ""), byteSize: numberValue(row.byteSize ?? row.size), isPublic: Boolean(row.isPublic ?? row.is_public), publicUrl: typeof row.publicUrl === "string" ? row.publicUrl : null, viewCount: numberValue(row.viewCount ?? row.view_count), createdAt: String(row.createdAt ?? row.created_at ?? "") }] : []; }) : [];
  const clipboards = Array.isArray(source.clipboards) ? source.clipboards.flatMap((entry) => { const row = valueRecord(entry); const id = Number(row.id); return Number.isSafeInteger(id) ? [{ id, title: String(row.title ?? "未命名剪贴板"), content: typeof row.content === "string" ? row.content : undefined, byteSize: numberValue(row.byteSize ?? row.size), isPublic: Boolean(row.isPublic ?? row.is_public), publicUrl: typeof row.publicUrl === "string" ? row.publicUrl : null, viewCount: numberValue(row.viewCount ?? row.view_count), createdAt: String(row.createdAt ?? row.created_at ?? ""), updatedAt: String(row.updatedAt ?? row.updated_at ?? "") }] : []; }) : [];
  const stickers = Array.isArray(source.stickers) ? source.stickers.flatMap((entry) => { const row = valueRecord(entry); const id = Number(row.id); return Number.isSafeInteger(id) ? [{ id, name: String(row.name ?? "未命名表情"), url: String(row.url ?? row.imageUrl ?? ""), mimeType: String(row.mimeType ?? row.mime_type ?? "image/png"), byteSize: numberValue(row.byteSize ?? row.byte_size ?? row.size), createdAt: String(row.createdAt ?? row.created_at ?? "") }] : []; }) : [];
  return { space: normalizeAdminSpace(source.space), items, clipboards, stickers };
}
function spaceCategoryLabel(key: string) {
  return ({ images: "图床与图片", clipboards: "在线剪贴板", stickers: "个人表情", avatars: "头像", commentImages: "评论图片" } as Record<string, string>)[key] ?? key;
}

function AdminUserSpace() {
  const [users, setUsers] = useState<AdminSpaceUser[]>([]);
  const [selected, setSelected] = useState<AdminSpaceUser | null>(null);
  const [detail, setDetail] = useState<AdminUserSpaceDetail | null>(null);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const loadUsers = () => {
    setLoading(true);
    void adminRequest<unknown>("/api/admin/user-space").then((value) => { setUsers(normalizeAdminSpaceUsers(value)); setMessage(""); }).catch((error) => { setUsers([]); setMessage(errorText(error, "用户空间列表加载失败。")); }).finally(() => setLoading(false));
  };
  const loadDetail = (user: AdminSpaceUser) => {
    setSelected(user); setDetail(null); setDetailLoading(true);
    void adminRequest<unknown>(`/api/admin/user-space/${encodeURIComponent(String(user.id))}`).then((value) => setDetail(normalizeAdminSpaceDetail(value))).catch((error) => setMessage(errorText(error, "用户空间详情加载失败。"))).finally(() => setDetailLoading(false));
  };
  useEffect(loadUsers, []);
  const refreshSelected = () => { if (selected) loadDetail(selected); loadUsers(); };
  const changeUserActive = async (user: AdminSpaceUser) => {
    const action = user.isActive ? "封禁" : "恢复";
    if (!window.confirm(`确认${action}用户“${user.nickname || user.account}”吗？`)) return;
    setMutating(`user-${user.id}`);
    try {
      await adminRequest(`/api/admin/users/${encodeURIComponent(String(user.id))}`, { method: "PATCH", body: JSON.stringify({ isActive: !user.isActive }) });
      setMessage(user.isActive ? "用户已封禁，现有登录会话已失效。" : "用户已恢复登录。");
      setUsers((current) => current.map((entry) => entry.id === user.id ? { ...entry, isActive: !user.isActive } : entry));
      setSelected((current) => current?.id === user.id ? { ...current, isActive: !user.isActive } : current);
    } catch (error) { setMessage(errorText(error, "用户状态更新失败。")); } finally { setMutating(null); }
  };
  const removeItem = async (id: number) => {
    if (!selected || !window.confirm("确认删除此图片资源吗？此操作会释放用户空间。")) return;
    setMutating(`item-${id}`);
    try { await adminRequest(`/api/admin/user-space/${selected.id}/items/${id}`, { method: "DELETE" }); setMessage("图片资源已删除。"); refreshSelected(); } catch (error) { setMessage(errorText(error, "图片资源删除失败。")); } finally { setMutating(null); }
  };
  const removeClipboard = async (id: number) => {
    if (!selected || !window.confirm("确认删除此在线剪贴板吗？此操作会释放用户空间。")) return;
    setMutating(`clipboard-${id}`);
    try { await adminRequest(`/api/admin/user-space/${selected.id}/clipboards/${id}`, { method: "DELETE" }); setMessage("在线剪贴板已删除。"); refreshSelected(); } catch (error) { setMessage(errorText(error, "在线剪贴板删除失败。")); } finally { setMutating(null); }
  };
  const removeSticker = async (id: number) => {
    if (!selected || !window.confirm("确认删除此个人表情吗？此操作会释放用户空间。")) return;
    setMutating(`sticker-${id}`);
    try { await adminRequest(`/api/admin/user-space/${selected.id}/stickers/${id}`, { method: "DELETE" }); setMessage("个人表情已删除。"); refreshSelected(); } catch (error) { setMessage(errorText(error, "个人表情删除失败。")); } finally { setMutating(null); }
  };
  const filtered = users.filter((user) => `${user.account} ${user.nickname} ${user.email ?? ""}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  const categories = detail ? Object.entries(detail.space.categories).filter(([, size]) => size > 0) : [];
  const selectedUsage = detail?.space ?? selected?.space;
  return <div className="fa-page fa-user-space-page">
    <PageHeading eyebrow="ACCOUNT & STORAGE" title="媒体与空间" description="按用户查看共享 30MB 空间、公开资源和在线剪贴板，支持直接封禁与清理内容。" action={<GhostButton onClick={refreshSelected} disabled={loading || detailLoading}><RefreshCw size={15} className={loading || detailLoading ? "fa-spin" : ""} />刷新数据</GhostButton>} />
    {message ? <div className="fa-error fa-page-error">{message}</div> : null}
    <div className="fa-toolbar fa-user-space-toolbar"><label className="fa-search"><Search size={15} /><input value={keyword} placeholder="搜索账号、昵称或邮箱" onChange={(event) => setKeyword(event.target.value)} /></label><span>{filtered.length} 名用户</span></div>
    <section className="fa-panel fa-user-space-list"><div className="fa-table-wrap"><table className="fa-table fa-user-space-table"><thead><tr><th>用户</th><th>已用空间</th><th>分类占用</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan={6}><div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载用户空间</div></td></tr> : filtered.length ? filtered.map((user) => { const ratio = percent(user.space.usedBytes, user.space.limitBytes); return <tr key={user.id} className={selected?.id === user.id ? "is-selected" : ""}><td><button type="button" className="fa-space-user" onClick={() => loadDetail(user)}>{user.avatar ? <img src={resolveAdminMediaUrl(user.avatar)} alt="" /> : <span><UserRound size={15} /></span>}<span><strong>{user.nickname || user.account}</strong><small>{user.account}{user.email ? ` · ${user.email}` : ""}</small></span></button></td><td><div className="fa-space-usage"><strong>{bytesText(user.space.usedBytes)}</strong><span>{bytesText(user.space.limitBytes)}</span><i><b style={{ width: `${ratio}%` }} /></i></div></td><td><div className="fa-space-category-list">{Object.entries(user.space.categories).filter(([, size]) => size > 0).map(([key, size]) => <span key={key}>{spaceCategoryLabel(key)} {bytesText(size)}</span>)}{Object.values(user.space.categories).every((size) => !size) ? <span>暂无内容</span> : null}</div></td><td><span className={`fa-pill ${user.isActive ? "approved" : "disabled"}`}>{user.isActive ? "正常" : "已封禁"}</span></td><td><span className="fa-date-cell">{dateText(user.createdAt)}</span></td><td><div className="fa-inline-actions"><button type="button" title="查看空间内容" onClick={() => loadDetail(user)}><Eye size={14} /></button><button type="button" title={user.isActive ? "封禁用户" : "恢复用户"} disabled={mutating === `user-${user.id}`} onClick={() => void changeUserActive(user)}>{user.isActive ? <Ban size={14} /> : <UserCheck size={14} />}</button></div></td></tr>; }) : <tr><td colSpan={6}><EmptyState>没有匹配的用户</EmptyState></td></tr>}</tbody></table></div></section>
    {selected ? <section className="fa-user-space-detail"><div className="fa-user-space-detail-head"><div><span className="fa-kicker">USER SPACE</span><h2>{selected.nickname || selected.account} 的空间内容</h2><p>{selected.email || "未填写邮箱"} · {selected.isActive ? "账号正常" : "账号已封禁"}</p></div><div><GhostButton onClick={() => void changeUserActive(selected)} disabled={mutating === `user-${selected.id}`}>{selected.isActive ? <Ban size={15} /> : <UserCheck size={15} />}{selected.isActive ? "封禁用户" : "恢复用户"}</GhostButton><GhostButton onClick={() => { setSelected(null); setDetail(null); }}>关闭</GhostButton></div></div>{detailLoading ? <div className="fa-space-detail-loading"><RefreshCw size={18} className="fa-spin" />正在读取空间内容</div> : detail && selectedUsage ? <><div className="fa-space-summary"><article><HardDrive size={19} /><span>已用空间</span><strong>{bytesText(selectedUsage.usedBytes)}</strong><small>剩余 {bytesText(selectedUsage.remainingBytes)} / 共 {bytesText(selectedUsage.limitBytes)}</small><i><b style={{ width: `${percent(selectedUsage.usedBytes, selectedUsage.limitBytes)}%` }} /></i></article>{categories.map(([key, size]) => <article key={key}><Database size={18} /><span>{spaceCategoryLabel(key)}</span><strong>{bytesText(size)}</strong><small>占已用空间 {percent(size, selectedUsage.usedBytes).toFixed(1)}%</small></article>)}</div><div className="fa-user-space-content-grid"><section className="fa-panel"><div className="fa-panel-head"><div><div className="fa-panel-title"><ImageIcon size={18} /><h2>图片与资源</h2><span>{detail.items.length}</span></div><p>图床、用户上传的图片及其公开访问状态。</p></div></div><div className="fa-space-content-list">{detail.items.length ? detail.items.map((item) => <article key={item.id}><a className="fa-space-preview" href={resolveAdminMediaUrl(item.url)} target="_blank" rel="noreferrer">{item.mimeType.startsWith("image/") || /image|avatar|sticker/u.test(item.kind) ? <img src={resolveAdminMediaUrl(item.url)} alt="" /> : <ImageIcon size={19} />}</a><div><strong>{item.name || "未命名资源"}</strong><small>{item.kind} · {bytesText(item.byteSize)} · {dateText(item.createdAt)}</small><p><span className={`fa-pill ${item.isPublic ? "approved" : "disabled"}`}>{item.isPublic ? "公开" : "私有"}</span><span><Eye size={12} /> {item.viewCount}</span></p></div><button type="button" title="删除资源" disabled={mutating === `item-${item.id}`} onClick={() => void removeItem(item.id)}><Trash2 size={14} /></button></article>) : <EmptyState>该用户还没有图床资源</EmptyState>}</div></section><section className="fa-panel"><div className="fa-panel-head"><div><div className="fa-panel-title"><FileText size={18} /><h2>在线剪贴板</h2><span>{detail.clipboards.length}</span></div><p>Markdown 或文本内容同样计入共享空间。</p></div></div><div className="fa-space-content-list">{detail.clipboards.length ? detail.clipboards.map((item) => <article key={item.id}><span className="fa-space-clipboard-icon"><FileText size={18} /></span><div><strong>{item.title || "未命名剪贴板"}</strong><small>{bytesText(item.byteSize)} · 更新于 {dateText(item.updatedAt || item.createdAt)}</small>{item.content ? <p className="fa-space-clipboard-preview">{item.content.slice(0, 120)}</p> : null}<p><span className={`fa-pill ${item.isPublic ? "approved" : "disabled"}`}>{item.isPublic ? "公开" : "私有"}</span><span><Eye size={12} /> {item.viewCount}</span></p></div><button type="button" title="删除剪贴板" disabled={mutating === `clipboard-${item.id}`} onClick={() => void removeClipboard(item.id)}><Trash2 size={14} /></button></article>) : <EmptyState>该用户还没有在线剪贴板</EmptyState>}</div></section><section className="fa-panel"><div className="fa-panel-head"><div><div className="fa-panel-title"><Smile size={18} /><h2>个人表情</h2><span>{detail.stickers.length}</span></div><p>用户自定义表情同样计入共享 30MB 空间。</p></div></div><div className="fa-space-content-list fa-space-sticker-list">{detail.stickers.length ? detail.stickers.map((sticker) => <article key={sticker.id}><a className="fa-space-preview" href={resolveAdminMediaUrl(sticker.url)} target="_blank" rel="noreferrer"><img src={resolveAdminMediaUrl(sticker.url)} alt={sticker.name} /></a><div><strong>{sticker.name || "未命名表情"}</strong><small>{bytesText(sticker.byteSize)} · {dateText(sticker.createdAt)}</small></div><button type="button" title="删除个人表情" disabled={mutating === `sticker-${sticker.id}`} onClick={() => void removeSticker(sticker.id)}><Trash2 size={14} /></button></article>) : <EmptyState>该用户还没有个人表情</EmptyState>}</div></section></div></> : null}</section> : null}
  </div>;
}

type SiteSettingsSection =
  | "center"
  | "features"
  | "basic"
  | "media"
  | "content"
  | "music"
  | "author";

const SITE_SETTINGS_ENDPOINTS = [
  "/api/admin/site-settings",
  "/api/admin/site",
] as const;

type FeatureSettings = {
  commentsEnabled: boolean;
  registrationEnabled: boolean;
  loginEnabled: boolean;
  imageHostingEnabled: boolean;
  clipboardEnabled: boolean;
  userCenterEnabled: boolean;
  publicResourcesEnabled: boolean;
  compilerEnabled: boolean;
};

const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  commentsEnabled: true,
  registrationEnabled: true,
  loginEnabled: true,
  imageHostingEnabled: true,
  clipboardEnabled: true,
  userCenterEnabled: true,
  publicResourcesEnabled: true,
  compilerEnabled: true,
};

const FEATURE_SETTINGS_ENDPOINT = "/api/admin/features";

const FEATURE_SETTINGS_FIELDS: Array<{
  key: keyof FeatureSettings;
  label: string;
  description: string;
}> = [
  { key: "commentsEnabled", label: "评论区", description: "允许访客查看、发表评论和上传评论图片。" },
  { key: "registrationEnabled", label: "用户注册", description: "开放新用户注册入口；关闭后不再接受新的注册请求。" },
  { key: "loginEnabled", label: "用户登录", description: "允许已注册用户登录前台并使用个人功能。" },
  { key: "imageHostingEnabled", label: "图床", description: "开放用户图床上传、公开链接和图片管理。" },
  { key: "clipboardEnabled", label: "在线剪贴板", description: "开放在线剪贴板创建、编辑和公开访问。" },
  { key: "userCenterEnabled", label: "用户中心", description: "开放头像、昵称、账号、邮箱和密码等个人资料管理。" },
  { key: "publicResourcesEnabled", label: "公开资源访问", description: "允许通过公开链接访问图床图片和剪贴板内容。" },
  { key: "compilerEnabled", label: "在线编译器", description: "允许已登录用户在容器沙箱中运行、格式化和调试代码。" },
];

function normalizeFeatureSettings(value: unknown): FeatureSettings {
  const root = valueRecord(value);
  const source = {
    ...root,
    ...valueRecord(root.features),
    ...valueRecord(root.settings),
  };
  return FEATURE_SETTINGS_FIELDS.reduce((result, field) => {
    result[field.key] = firstBoolean(DEFAULT_FEATURE_SETTINGS[field.key], source[field.key]);
    return result;
  }, { ...DEFAULT_FEATURE_SETTINGS });
}

const SITE_SETTINGS_SECTIONS: Array<{
  id: Exclude<SiteSettingsSection, "center">;
  label: string;
  title: string;
  description: string;
  hint: string;
  icon: LucideIcon;
}> = [
  {
    id: "features",
    label: "功能开关",
    title: "功能开关",
    description: "统一管理评论、账户、图床、剪贴板、在线编译器和公开资源等前台功能。",
    hint: "控制前台功能开放范围",
    icon: SlidersHorizontal,
  },
  {
    id: "basic",
    label: "基础信息",
    title: "基础信息",
    description: "维护站点名称、副标题、描述与主题色。",
    hint: "适合更新博客身份与简介",
    icon: SlidersHorizontal,
  },
  {
    id: "media",
    label: "媒体资源",
    title: "媒体资源",
    description: "管理首页头图，支持本地上传、图床链接和图片 API。",
    hint: "图像资源集中维护",
    icon: ImageIcon,
  },
  {
    id: "content",
    label: "首页文案与字体",
    title: "首页文案与字体",
    description: "配置主副标题、一言以及首页和文章字体。",
    hint: "控制视觉风格与文案",
    icon: Type,
  },
  {
    id: "music",
    label: "音乐管理",
    title: "前台音乐",
    description: "上传音乐并管理播放器曲目信息和播放行为。",
    hint: "统一维护背景音乐",
    icon: Music2,
  },
  {
    id: "author",
    label: "作者与链接",
    title: "作者资料与跳转链接",
    description: "维护头像、昵称、介绍和侧边栏中的所有外部入口。",
    hint: "高度自定义作者展示",
    icon: UserRound,
  },
];

type SiteSettingsNavItem = {
  label: string;
  section?: SiteSettingsSection;
  href?: string;
};

const SITE_SETTINGS_NAV: SiteSettingsNavItem[] = [
  { label: "设置中心", section: "center" },
  { label: "基础信息", section: "basic" },
  { label: "功能开关", section: "features" },
  { label: "媒体资源", section: "media" },
  { label: "首页文案与字体", section: "content" },
  { label: "联系按钮", section: "author" },
  { label: "博主主页", href: "/admin/author-profile" },
];

type SiteSettingsCard = {
  title: string;
  description: string;
  hint: string;
  section?: SiteSettingsSection;
  href?: string;
};

const SITE_SETTINGS_CARDS: SiteSettingsCard[] = [
  {
    title: "基础信息",
    description: "维护站点标题、作者名、副标题和描述。",
    hint: "适合更新博客身份与简介",
    section: "basic",
  },
  {
    title: "功能开关",
    description: "控制评论区、账户、图床、在线剪贴板和公开资源是否对外开放。",
    hint: "统一管理公开功能入口",
    section: "features",
  },
  {
    title: "媒体资源",
    description: "管理首页头图、头像、Favicon，并支持页面顶图截取范围调节。",
    hint: "图像资源集中维护",
    section: "media",
  },
  {
    title: "首页文案与字体",
    description: "配置首页一言、副标题兜底文案、标题字号、文章标题字体、标签字体和侧边栏倒计时。",
    hint: "控制视觉风格与文案",
    section: "content",
  },
  {
    title: "联系按钮",
    description: "设置作者卡片中的 GitHub 与 Email 跳转链接。",
    hint: "维护对外联系入口",
    section: "author",
  },
  {
    title: "博主主页",
    description: "编排技能专长、经历时间线以及自定义公开内容。",
    hint: "高度自定义作者展示",
    href: "/admin/author-profile",
  },
  {
    title: "页面内容",
    description: "管理“关于”“传送”和“问题总结”页面的标题与正文内容。",
    hint: "独立页文案管理",
    href: "/admin/pages",
  },
];

type FontConfigKey =
  | "titleFontUrl"
  | "subtitleFontUrl"
  | "postTitleFontUrl"
  | "bodyFontUrl"
  | "postContentFontUrl"
  | "tagFontUrl";

const FONT_FIELDS: Array<{
  key: FontConfigKey;
  label: string;
  description: string;
}> = [
  { key: "titleFontUrl", label: "首页主标题字体", description: "用于封面中的主标题。" },
  { key: "subtitleFontUrl", label: "首页副标题字体", description: "用于默认文案和一言。" },
  { key: "postTitleFontUrl", label: "文章标题字体", description: "用于文章卡片与正文标题。" },
  { key: "bodyFontUrl", label: "站点正文基础字体", description: "用于页面基础文本与侧栏内容。" },
  { key: "postContentFontUrl", label: "文章内容字体", description: "用于文章正文和 Markdown 内容。" },
  { key: "tagFontUrl", label: "标签字体", description: "用于标签、分类和文章元信息。" },
];

function valueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(fallback: string, ...values: unknown[]) {
  const value = values.find((item) => typeof item === "string");
  return typeof value === "string" ? value : fallback;
}

function firstBoolean(fallback: boolean, ...values: unknown[]) {
  const value = values.find((item) => typeof item === "boolean");
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(maximum, Math.max(minimum, numeric))
    : fallback;
}

function normalizeSiteSettings(value: unknown): SiteSettingsForm {
  const root = valueRecord(value);
  const source = {
    ...root,
    ...valueRecord(root.settings),
    ...valueRecord(root.site),
  };
  const cover = valueRecord(source.cover);
  const titleConfig = valueRecord(source.titleConfig);
  const music = valueRecord(source.music);
  const author = valueRecord(source.author);
  const coverMode = firstString(
    DEFAULT_SITE_SETTINGS.cover.mode,
    cover.mode,
  );
  const rawLinks = Array.isArray(author.links) ? author.links : [];
  const topImageCropX = Number(source.topImageCropX);
  const topImageCropY = Number(source.topImageCropY);
  return {
    title: firstString(DEFAULT_SITE_SETTINGS.title, source.title, source.siteTitle),
    subtitle: firstString(
      DEFAULT_SITE_SETTINGS.subtitle,
      source.subtitle,
      source.siteSubtitle,
    ),
    description: firstString(
      DEFAULT_SITE_SETTINGS.description,
      source.description,
      source.siteDescription,
    ),
    hue: Number.isFinite(Number(source.hue)) ? Number(source.hue) : DEFAULT_SITE_SETTINGS.hue,
    videoUploadMaxSizeMb: Math.round(
      boundedNumber(
        source.videoUploadMaxSizeMb,
        DEFAULT_SITE_SETTINGS.videoUploadMaxSizeMb,
        1,
        2048,
      ),
    ),
    videoAutoTranscodeEnabled: firstBoolean(
      DEFAULT_SITE_SETTINGS.videoAutoTranscodeEnabled,
      source.videoAutoTranscodeEnabled,
    ),
    siteFavicon: firstString("", source.siteFavicon, source.favicon),
    cover: {
      mode: coverMode === "url" || coverMode === "api" ? coverMode : "upload",
      value: firstString("", cover.value, source.indexImage),
      apiUrl: firstString(DEFAULT_SITE_SETTINGS.cover.apiUrl, cover.apiUrl),
      position: firstString(
        Number.isFinite(topImageCropX) && Number.isFinite(topImageCropY)
          ? `${topImageCropX}% ${topImageCropY}%`
          : DEFAULT_SITE_SETTINGS.cover.position,
        cover.position,
      ),
    },
    titleConfig: {
      title: firstString(
        firstString(DEFAULT_SITE_SETTINGS.titleConfig.title, source.title, source.siteTitle),
        titleConfig.title,
      ),
      subtitle: firstString(
        firstString(DEFAULT_SITE_SETTINGS.titleConfig.subtitle, source.subtitle, source.siteSubtitle),
        titleConfig.subtitle,
        source.heroSubtitleLines && Array.isArray(source.heroSubtitleLines)
          ? source.heroSubtitleLines.join("\n")
          : undefined,
      ),
      subtitleMode:
        firstString("", titleConfig.subtitleMode) === "hitokoto" ||
        source.hitokotoEnabled === true
          ? "hitokoto"
          : "text",
      hitokotoApi: firstString(
        DEFAULT_SITE_SETTINGS.titleConfig.hitokotoApi,
        titleConfig.hitokotoApi,
      ),
      titleFontUrl: firstString("", titleConfig.titleFontUrl, source.heroTitleFontPath),
      subtitleFontUrl: firstString("", titleConfig.subtitleFontUrl),
      postTitleFontUrl: firstString("", titleConfig.postTitleFontUrl, source.postTitleFontPath),
      bodyFontUrl: firstString("", titleConfig.bodyFontUrl, source.bodyFontPath),
      postContentFontUrl: firstString("", titleConfig.postContentFontUrl, source.postContentFontPath),
      tagFontUrl: firstString("", titleConfig.tagFontUrl, source.tagFontPath),
    },
    music: {
      enabled: firstBoolean(DEFAULT_SITE_SETTINGS.music.enabled, music.enabled),
      src: firstString("", music.src),
      title: firstString("", music.title),
      artist: firstString("", music.artist),
      cover: firstString("", music.cover),
      autoplay: firstBoolean(false, music.autoplay),
      loop: firstBoolean(true, music.loop),
    },
    author: {
      name: firstString(DEFAULT_SITE_SETTINGS.author.name, author.name, source.authorName),
      bio: firstString(DEFAULT_SITE_SETTINGS.author.bio, author.bio),
      avatar: firstString("", author.avatar, source.avatarImage),
      email: firstString("", author.email, source.authorEmailLink).replace(/^mailto:/iu, ""),
      githubUrl: firstString("", author.githubUrl, source.authorGithubLink),
      qqUrl: firstString("", author.qqUrl),
      rssUrl: firstString(DEFAULT_SITE_SETTINGS.author.rssUrl, author.rssUrl),
      links: rawLinks
        .map((item) => valueRecord(item))
        .map((item) => ({
          label: firstString("", item.label),
          url: firstString("", item.url),
          icon: firstString("", item.icon),
        }))
        .filter((item) => item.label || item.url),
    },
  };
}

function coverPosition(value: string) {
  const tokens = value.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const horizontalKeywords: Record<string, number> = { left: 0, center: 50, right: 100 };
  const verticalKeywords: Record<string, number> = { top: 0, center: 50, bottom: 100 };
  const percentage = (token: string | undefined) => {
    const match = token?.match(/^(-?\d+(?:\.\d+)?)%?$/u);
    return match ? Number(match[1]) : undefined;
  };
  const horizontal = (token: string | undefined) =>
    token === undefined ? undefined : horizontalKeywords[token] ?? percentage(token);
  const vertical = (token: string | undefined) =>
    token === undefined ? undefined : verticalKeywords[token] ?? percentage(token);

  let x = 50;
  let y = 50;
  const [first, second] = tokens;
  if (first === "top" || first === "bottom") {
    y = vertical(first) ?? y;
    x = horizontal(second) ?? x;
  } else if (second === "left" || second === "right") {
    y = vertical(first) ?? y;
    x = horizontal(second) ?? x;
  } else {
    x = horizontal(first) ?? x;
    y = vertical(second) ?? y;
  }

  return {
    x: Math.min(100, Math.max(0, x)),
    y: Math.min(100, Math.max(0, y)),
  };
}

function mediaHeaderPreviewRatio() {
  if (typeof window === "undefined") return 2.4;
  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(window.innerHeight, 1);
  const rootFontSize = Number.parseFloat(
    window.getComputedStyle(document.documentElement).fontSize,
  ) || 16;
  const heroHeight = viewportWidth <= 767
    ? Math.max(viewportHeight * 0.65, 22 * rootFontSize)
    : Math.max(25 * rootFontSize, Math.min(viewportHeight * 0.65, 43 * rootFontSize));
  return viewportWidth / Math.max(heroHeight, 1);
}

function MediaCropPreview({
  src,
  x,
  y,
  onPositionChange,
}: {
  src: string;
  x: number;
  y: number;
  onPositionChange: (x: number, y: number) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    left: number;
    top: number;
  } | null>(null);
  const [previewRatio, setPreviewRatio] = useState(mediaHeaderPreviewRatio);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 1, height: 1 });
  const [imageState, setImageState] = useState<"empty" | "loading" | "ready" | "error">(
    src ? "loading" : "empty",
  );
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setImageState(src ? "loading" : "empty");
    setNaturalSize({ width: 1, height: 1 });
    dragRef.current = null;
    setDragging(false);
  }, [src]);

  useEffect(() => {
    const updateRatio = () => setPreviewRatio(mediaHeaderPreviewRatio());
    window.addEventListener("resize", updateRatio);
    return () => window.removeEventListener("resize", updateRatio);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };
    updateSize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateSize);
    observer?.observe(stage);
    window.addEventListener("resize", updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, [src, imageState]);

  const imageRatio = naturalSize.width / naturalSize.height;
  const widthFraction = imageRatio > previewRatio ? previewRatio / imageRatio : 1;
  const heightFraction = imageRatio < previewRatio ? imageRatio / previewRatio : 1;
  const boxWidth = stageSize.width * Math.min(1, Math.max(0, widthFraction));
  const boxHeight = stageSize.height * Math.min(1, Math.max(0, heightFraction));
  const maxLeft = Math.max(stageSize.width - boxWidth, 0);
  const maxTop = Math.max(stageSize.height - boxHeight, 0);
  const left = maxLeft * boundedNumber(x, 50, 0, 100) / 100;
  const top = maxTop * boundedNumber(y, 50, 0, 100) / 100;
  const canDrag = imageState === "ready" && (maxLeft > 0.5 || maxTop > 0.5);

  const applyPixels = (nextLeft: number, nextTop: number) => {
    const nextX = maxLeft > 0.5 ? nextLeft / maxLeft * 100 : 50;
    const nextY = maxTop > 0.5 ? nextTop / maxTop * 100 : 50;
    onPositionChange(
      Math.round(boundedNumber(nextX, 50, 0, 100) * 10) / 10,
      Math.round(boundedNumber(nextY, 50, 0, 100) * 10) / 10,
    );
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canDrag) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      left,
      top,
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const stage = stageRef.current;
    const rect = stage?.getBoundingClientRect();
    const scaleX = stage && rect?.width ? stage.offsetWidth / rect.width : 1;
    const scaleY = stage && rect?.height ? stage.offsetHeight / rect.height : 1;
    applyPixels(
      Math.min(maxLeft, Math.max(0, start.left + (event.clientX - start.clientX) * scaleX)),
      Math.min(maxTop, Math.max(0, start.top + (event.clientY - start.clientY) * scaleY)),
    );
  };

  const stopDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 5 : 1;
    let nextX = x;
    let nextY = y;
    if (event.key === "ArrowLeft" && maxLeft > 0.5) nextX -= step;
    else if (event.key === "ArrowRight" && maxLeft > 0.5) nextX += step;
    else if (event.key === "ArrowUp" && maxTop > 0.5) nextY -= step;
    else if (event.key === "ArrowDown" && maxTop > 0.5) nextY += step;
    else return;
    event.preventDefault();
    onPositionChange(
      boundedNumber(nextX, 50, 0, 100),
      boundedNumber(nextY, 50, 0, 100),
    );
  };

  const empty = !src || imageState === "error";
  return (
    <article className="fa-media-preview-block fa-media-cover-block">
      <h3>头图预览</h3>
      <p className="fa-media-preview-meta">当前按前台头图比例预览：{previewRatio.toFixed(2)} : 1</p>
      {empty ? (
        <div className="fa-media-preview-empty">
          <ImageIcon size={25} />
          <span>{src ? "图片无法加载，请检查地址" : "暂无头图预览"}</span>
        </div>
      ) : (
        <>
          <div className="fa-media-front-preview" style={{ aspectRatio: `${previewRatio} / 1` }}>
            <img
              src={src}
              alt="前台头图预览"
              style={{ objectPosition: `${x}% ${y}%` }}
              onError={() => setImageState("error")}
            />
          </div>
          <p className="fa-media-preview-tip">拖拽下方选框可设置展示范围，滑块、数字输入与选框实时同步。</p>
          <div
            className="fa-media-crop-stage"
            ref={stageRef}
            style={imageState === "ready" ? {
              aspectRatio: `${naturalSize.width} / ${naturalSize.height}`,
              maxWidth: `${20 * imageRatio}rem`,
              minHeight: 0,
            } : undefined}
          >
            <img
              className="fa-media-crop-image"
              src={src}
              alt="头图裁剪编辑"
              draggable={false}
              onLoad={(event) => {
                setNaturalSize({
                  width: event.currentTarget.naturalWidth || 1,
                  height: event.currentTarget.naturalHeight || 1,
                });
                setImageState("ready");
              }}
              onError={() => setImageState("error")}
            />
            {imageState === "ready" ? (
              <button
                type="button"
                className={`fa-media-crop-selection${canDrag ? "" : " is-static"}${dragging ? " is-dragging" : ""}`}
                style={{ width: boxWidth, height: boxHeight, transform: `translate(${left}px, ${top}px)` }}
                aria-label={canDrag
                  ? `头图展示范围，横向 ${x.toFixed(1)}%，纵向 ${y.toFixed(1)}%`
                  : "当前图片比例无需移动展示范围"}
                disabled={!canDrag}
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
                onKeyDown={moveWithKeyboard}
              >
                <span>{canDrag ? "拖拽选框" : "完整展示"}</span>
              </button>
            ) : null}
          </div>
        </>
      )}
    </article>
  );
}

function MediaAssetPreview({
  title,
  src,
  kind,
}: {
  title: string;
  src: string;
  kind: "avatar" | "favicon";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <article className="fa-media-preview-block">
      <h3>{title}</h3>
      {!src || failed ? (
        <div className="fa-media-preview-empty is-compact">
          {kind === "avatar" ? <UserRound size={23} /> : <Globe2 size={23} />}
          <span>{failed ? "图片无法加载，请检查地址" : "暂无预览"}</span>
        </div>
      ) : (
        <img
          className={`fa-media-preview-asset is-${kind}`}
          src={src}
          alt={title}
          onError={() => setFailed(true)}
        />
      )}
    </article>
  );
}

type AdminAccount = {
  id: string | number;
  username: string;
  displayName?: string;
  role?: string;
  isActive?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastLoginAt?: string | null;
};

type AdminAccountDraft = {
  username: string;
  displayName: string;
  role: string;
  password: string;
  isActive: boolean;
};

type AccountDialog = {
  mode: "create" | "edit" | "reset";
  account?: AdminAccount;
};

const EMPTY_ACCOUNT_DRAFT: AdminAccountDraft = {
  username: "",
  displayName: "",
  role: "admin",
  password: "",
  isActive: true,
};

function normalizeAdminAccounts(value: unknown): AdminAccount[] {
  let records: unknown[] = [];
  if (Array.isArray(value)) records = value;
  else if (value && typeof value === "object") {
    const payload = value as Record<string, unknown>;
    for (const key of ["items", "accounts", "users", "data"]) {
      if (Array.isArray(payload[key])) {
        records = payload[key] as unknown[];
        break;
      }
    }
  }
  return records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const item = record as Record<string, unknown>;
    const username = String(item.username ?? item.name ?? "").trim();
    if (!username) return [];
    const active =
      typeof item.isActive === "boolean"
        ? item.isActive
        : item.status === "disabled"
          ? false
          : true;
    const rawId = item.id;
    const id =
      typeof rawId === "string" || typeof rawId === "number"
        ? rawId
        : username;
    return [
      {
        id,
        username,
        displayName: String(item.displayName ?? item.display_name ?? "").trim(),
        role: String(item.role ?? "admin").trim() || "admin",
        isActive: active,
        createdAt:
          typeof item.createdAt === "string"
            ? item.createdAt
            : typeof item.created_at === "string"
              ? item.created_at
              : null,
        updatedAt:
          typeof item.updatedAt === "string"
            ? item.updatedAt
            : typeof item.updated_at === "string"
              ? item.updated_at
              : null,
        lastLoginAt:
          typeof item.lastLoginAt === "string"
            ? item.lastLoginAt
            : typeof item.last_login_at === "string"
              ? item.last_login_at
              : null,
      } satisfies AdminAccount,
    ];
  });
}

function AdminAccounts() {
  const administratorName =
    sessionStorage.getItem("firefly-admin-username")?.trim() || "admin";
  const [items, setItems] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [draft, setDraft] = useState<AdminAccountDraft>(EMPTY_ACCOUNT_DRAFT);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    void adminRequest<unknown>("/api/admin/accounts")
      .then((value) => {
        setItems(normalizeAdminAccounts(value));
        setMessage("");
      })
      .catch((error) => {
        setItems([]);
        setMessage(errorText(error, "管理员账号加载失败，请稍后重试。"));
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const closeDialog = () => {
    if (!saving) setDialog(null);
  };
  const isSelf = (account: AdminAccount) =>
    account.username.trim().toLowerCase() === administratorName.toLowerCase();
  const openCreate = () => {
    setDraft({ ...EMPTY_ACCOUNT_DRAFT });
    setDialog({ mode: "create" });
    setMessage("");
  };
  const openEdit = (account: AdminAccount) => {
    if (isSelf(account)) return;
    setDraft({
      username: account.username,
      displayName: account.displayName ?? "",
      role: account.role ?? "admin",
      password: "",
      isActive: account.isActive !== false,
    });
    setDialog({ mode: "edit", account });
    setMessage("");
  };
  const openReset = (account: AdminAccount) => {
    if (isSelf(account)) return;
    setDraft({ ...EMPTY_ACCOUNT_DRAFT, username: account.username });
    setDialog({ mode: "reset", account });
    setMessage("");
  };

  const saveAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    const username = draft.username.trim();
    const password = draft.password;
    if (dialog.mode === "reset") {
      if (password.length < 8) {
        setMessage("新密码至少需要 8 位。");
        return;
      }
    } else {
      if (!username) {
        setMessage("请输入管理员账号。");
        return;
      }
      if (username.toLowerCase() === administratorName.toLowerCase()) {
        setMessage("不能在这里管理当前登录账号。");
        return;
      }
      if (dialog.mode === "create" && password.length < 8) {
        setMessage("初始密码至少需要 8 位。");
        return;
      }
    }
    setSaving(true);
    setMessage("");
    try {
      if (dialog.mode === "reset") {
        await adminRequest(
          "/api/admin/accounts/" + encodeURIComponent(String(dialog.account?.id)) + "/reset-password",
          { method: "POST", body: JSON.stringify({ password }) },
        );
      } else {
        const body: Record<string, unknown> = {
          username,
          displayName: draft.displayName.trim(),
          role: draft.role.trim() || "admin",
          isActive: draft.isActive,
        };
        if (password) body.password = password;
        await adminRequest(
          dialog.mode === "create"
            ? "/api/admin/accounts"
            : "/api/admin/accounts/" + encodeURIComponent(String(dialog.account?.id)),
          {
            method: dialog.mode === "create" ? "POST" : "PUT",
            body: JSON.stringify(body),
          },
        );
      }
      setDialog(null);
      setMessage(
        dialog.mode === "create"
          ? "管理员账号已创建。"
          : dialog.mode === "reset"
            ? "密码已重置。"
            : "管理员账号已更新。",
      );
      load();
    } catch (error) {
      setMessage(errorText(error, "账号操作失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  const removeAccount = async (account: AdminAccount) => {
    if (isSelf(account)) return;
    if (!window.confirm(`确认删除管理员账号“${account.username}”吗？`)) return;
    setMessage("");
    try {
      await adminRequest(
        "/api/admin/accounts/" + encodeURIComponent(String(account.id)),
        { method: "DELETE" },
      );
      setMessage("管理员账号已删除。");
      load();
    } catch (error) {
      setMessage(errorText(error, "账号删除失败，请稍后重试。"));
    }
  };

  return (
    <div className="fa-page fa-accounts-page">
      <PageHeading
        eyebrow="ACCOUNT CENTER"
        title="管理员账号"
        description="创建和维护其他管理员账号。当前登录账号仅显示状态，不提供删除、编辑或重置密码操作。"
        action={
          <PrimaryButton onClick={openCreate}>
            <Plus size={15} />
            新增管理员
          </PrimaryButton>
        }
      />
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      <section className="fa-panel fa-accounts-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <Users size={18} />
              <h2>账号列表</h2>
              <span>{items.length}</span>
            </div>
            <p>账号密码仅用于后台登录，列表不会展示任何密码信息。</p>
          </div>
          <GhostButton onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "fa-spin" : ""} />
            刷新列表
          </GhostButton>
        </div>
        <div className="fa-table-wrap">
          <table className="fa-table fa-accounts-table">
            <thead>
              <tr>
                <th>账号</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6}>
                    <div className="fa-table-loading">
                      <RefreshCw size={16} className="fa-spin" />
                      正在加载账号
                    </div>
                  </td>
                </tr>
              ) : items.length ? (
                items.map((account) => {
                  const self = isSelf(account);
                  return (
                    <tr key={String(account.id)} className={self ? "fa-account-self-row" : ""}>
                      <td>
                        <div className="fa-account-cell">
                          <span className="fa-account-avatar"><UserRound size={15} /></span>
                          <span>
                            <strong>{account.username}</strong>
                            {account.displayName ? <small>{account.displayName}</small> : null}
                          </span>
                          {self ? <em>当前账号</em> : null}
                        </div>
                      </td>
                      <td><span className="fa-pill">{account.role || "admin"}</span></td>
                      <td><span className={"fa-pill " + (account.isActive === false ? "disabled" : "approved")}>{account.isActive === false ? "已停用" : "正常"}</span></td>
                      <td><span className="fa-date-cell">{account.createdAt ? dateText(account.createdAt) : "未知"}</span></td>
                      <td><span className="fa-date-cell">{account.lastLoginAt ? dateText(account.lastLoginAt) : "尚未登录"}</span></td>
                      <td>
                        {self ? (
                          <span className="fa-account-protected"><ShieldCheck size={14} />当前账号受保护</span>
                        ) : (
                          <div className="fa-inline-actions">
                            <button type="button" title="编辑账号" onClick={() => openEdit(account)}><Pencil size={14} /></button>
                            <button type="button" title="重置密码" onClick={() => openReset(account)}><RotateCcw size={14} /></button>
                            <button type="button" title="删除账号" onClick={() => void removeAccount(account)}><Trash2 size={14} /></button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6}><EmptyState>暂无其他管理员账号</EmptyState></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {dialog ? (
        <div className="fa-dialog-overlay" role="presentation" onClick={closeDialog}>
          <form className="fa-dialog fa-account-dialog" onSubmit={saveAccount} onClick={(event) => event.stopPropagation()}>
            <div className="fa-dialog-head">
              <div>
                <span className="fa-kicker">{dialog.mode === "create" ? "NEW ADMINISTRATOR" : dialog.mode === "reset" ? "PASSWORD RESET" : "EDIT ADMINISTRATOR"}</span>
                <h2>{dialog.mode === "create" ? "新增管理员账号" : dialog.mode === "reset" ? "重置登录密码" : "编辑管理员账号"}</h2>
              </div>
              <button type="button" title="关闭" onClick={closeDialog}><X size={18} /></button>
            </div>
            {dialog.mode === "reset" ? (
              <>
                <div className="fa-account-target"><UserRound size={16} /><span>正在重置 <strong>{dialog.account?.username}</strong> 的密码</span></div>
                <label>
                  新密码
                  <input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} minLength={8} autoFocus autoComplete="new-password" placeholder="至少 8 位" required />
                </label>
              </>
            ) : (
              <>
                <div className="fa-account-form-grid">
                  <label>
                    管理员账号
                    <input type="text" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} minLength={3} maxLength={60} autoFocus={dialog.mode === "create"} autoComplete="username" placeholder="例如 editor" required />
                  </label>
                  <label>
                    显示名称
                    <input type="text" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} maxLength={120} placeholder="可选" />
                  </label>
                  <label>
                    角色
                    <select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
                      <option value="admin">普通管理员</option>
                      <option value="superadmin">超级管理员</option>
                    </select>
                  </label>
                  <label>
                    {dialog.mode === "create" ? "初始密码" : "新密码（留空则不修改）"}
                    <input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} minLength={8} autoComplete="new-password" placeholder={dialog.mode === "create" ? "至少 8 位" : "保持原密码"} required={dialog.mode === "create"} />
                  </label>
                </div>
                <label className="fa-inline-check fa-account-active-check">
                  <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
                  允许登录
                </label>
              </>
            )}
            {message ? <div className="fa-error">{message}</div> : null}
            <div className="fa-dialog-footer">
              <GhostButton onClick={closeDialog} disabled={saving}>取消</GhostButton>
              <PrimaryButton type="submit" disabled={saving}>
                {saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}
                {saving ? "保存中" : dialog.mode === "reset" ? "确认重置" : "保存账号"}
              </PrimaryButton>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function AdminSiteSettings() {
  const [section, setSection] = useState<SiteSettingsSection>("center");
  const [form, setForm] = useState<SiteSettingsForm>(() => normalizeSiteSettings({}));
  const [features, setFeatures] = useState<FeatureSettings>(DEFAULT_FEATURE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [featureLoading, setFeatureLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [hitokotoPreview, setHitokotoPreview] = useState("");
  const [hitokotoLoading, setHitokotoLoading] = useState(false);
  const [activeMediaUploads, setActiveMediaUploads] = useState(0);
  const handleMediaUploadingChange = useCallback((uploading: boolean) => {
    setActiveMediaUploads((current) => (uploading ? current + 1 : Math.max(0, current - 1)));
  }, []);
  const mediaUploadsActive = activeMediaUploads > 0;

  const load = () => {
    if (mediaUploadsActive) return;
    setLoading(true);
    setMessage("");
    void adminRequestCompatible<unknown>(SITE_SETTINGS_ENDPOINTS)
      .then((value) => setForm(normalizeSiteSettings(value)))
      .catch((error) => setMessage(errorText(error, "站点设置加载失败。")))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const loadFeatures = () => {
    setFeatureLoading(true);
    void adminRequest<unknown>(FEATURE_SETTINGS_ENDPOINT)
      .then((value) => setFeatures(normalizeFeatureSettings(value)))
      .catch((error) => setMessage(errorText(error, "功能开关加载失败。")))
      .finally(() => setFeatureLoading(false));
  };

  useEffect(loadFeatures, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (section === "media" && mediaUploadsActive) {
      setMessage("媒体正在上传，请等待上传完成后再保存。");
      return;
    }
    if (section === "features") {
      setSaving(true);
      setSaved(false);
      setMessage("");
      try {
        const value = await adminRequest<unknown>(FEATURE_SETTINGS_ENDPOINT, {
          method: "PATCH",
          body: JSON.stringify(features),
        });
        setFeatures(normalizeFeatureSettings(value ?? features));
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1800);
      } catch (error) {
        setMessage(errorText(error, "功能开关保存失败。"));
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!form.title.trim() || !form.titleConfig.title.trim()) {
      setMessage("站点标题与首页主标题不能为空。");
      return;
    }
    setSaving(true);
    setSaved(false);
    setMessage("");
    try {
      const payload = {
        ...form,
        title: form.title.trim(),
        subtitle: form.subtitle.trim(),
        hue: Number(form.hue),
        videoUploadMaxSizeMb: Math.round(
          boundedNumber(form.videoUploadMaxSizeMb, 1024, 1, 2048),
        ),
        siteFavicon: form.siteFavicon.trim(),
        indexImage: form.cover.value.trim(),
        topImageCropX: coverPosition(form.cover.position).x,
        topImageCropY: coverPosition(form.cover.position).y,
        avatarImage: form.author.avatar.trim(),
        cover: { ...form.cover, value: form.cover.value.trim(), apiUrl: form.cover.apiUrl.trim() },
        titleConfig: {
          ...form.titleConfig,
          title: form.titleConfig.title.trim(),
          subtitle: form.titleConfig.subtitle.trim(),
        },
        author: {
          ...form.author,
          name: form.author.name.trim(),
          links: form.author.links.filter((item) => item.label.trim() && item.url.trim()),
        },
      };
      const value = await adminRequestCompatible<unknown>(SITE_SETTINGS_ENDPOINTS, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setForm(value ? normalizeSiteSettings(value) : payload);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (error) {
      setMessage(errorText(error, "站点设置保存失败。"));
    } finally {
      setSaving(false);
    }
  };

  const showUploadError = (error: unknown) =>
    setMessage(errorText(error, "媒体上传失败。"));
  const position = coverPosition(form.cover.position);
  const coverPreview = form.cover.mode === "api" ? form.cover.apiUrl : form.cover.value;
  const resolvedCoverPreview = resolveAdminMediaUrl(coverPreview);
  const updateCoverPosition = (nextX: number, nextY: number) => {
    const x = Math.round(boundedNumber(nextX, 50, 0, 100) * 10) / 10;
    const y = Math.round(boundedNumber(nextY, 50, 0, 100) * 10) / 10;
    setForm((current) => ({
      ...current,
      cover: { ...current.cover, position: `${x}% ${y}%` },
    }));
  };
  const activeMeta = SITE_SETTINGS_SECTIONS.find((item) => item.id === section);
  const sectionLoading = section === "features" ? featureLoading : loading;
  const testHitokoto = async () => {
    if (!form.titleConfig.hitokotoApi.trim()) return;
    setHitokotoLoading(true);
    setHitokotoPreview("");
    try {
      const response = await fetch(form.titleConfig.hitokotoApi.trim());
      if (!response.ok) throw new Error("一言接口请求失败。");
      const value = (await response.json()) as { hitokoto?: unknown };
      if (typeof value.hitokoto !== "string" || !value.hitokoto.trim())
        throw new Error("一言接口没有返回有效文案。");
      setHitokotoPreview(value.hitokoto.trim());
    } catch (error) {
      setMessage(errorText(error, "一言接口测试失败。"));
    } finally {
      setHitokotoLoading(false);
    }
  };

  return (
    <div className={`fa-page fa-site-settings ${section === "center" ? "is-center" : "is-detail"}`}>
      <PageHeading
        eyebrow="站点设置"
        title={section === "center" ? "设置中心" : activeMeta?.title ?? "站点设置"}
        description={
          section === "center"
            ? "按功能分区管理配置，避免多个模块堆叠在同一页面。"
            : activeMeta?.description ?? "维护前台展示内容。"
        }
        action={
          section === "center" || section === "media" ? undefined : (
            <GhostButton onClick={section === "features" ? loadFeatures : load} disabled={sectionLoading || saving}>
              <RefreshCw size={15} className={sectionLoading ? "fa-spin" : ""} />
              重新加载
            </GhostButton>
          )
        }
      />
      <nav className="fa-settings-nav" aria-label="站点设置分区">
        {SITE_SETTINGS_NAV.map((item) =>
          item.href ? (
            <Link to={item.href} key={item.label}>
              {item.label}
            </Link>
          ) : (
            <button
              type="button"
              className={section === item.section ? "is-active" : ""}
              onClick={() => item.section && setSection(item.section)}
              key={item.label}
            >
              {item.label}
            </button>
          ),
        )}
      </nav>
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      {loading ? (
        <section className="fa-panel fa-settings-loading">
          <RefreshCw size={20} className="fa-spin" />
          正在加载设置
        </section>
      ) : section === "center" ? (
        <>
          <section className="fa-settings-center-grid">
            {SITE_SETTINGS_CARDS.map((item) => {
              const content = (
                <>
                  <span className="fa-settings-card-hint">{item.hint}</span>
                  <strong>{item.title}</strong>
                  <span className="fa-settings-card-description">{item.description}</span>
                </>
              );
              return item.href ? (
                <Link className="fa-settings-center-card" to={item.href} key={item.title}>
                  {content}
                </Link>
              ) : (
                <button
                  className="fa-settings-center-card"
                  type="button"
                  onClick={() => item.section && setSection(item.section)}
                  key={item.title}
                >
                  {content}
                </button>
              );
            })}
          </section>
          <section className="fa-panel fa-settings-quick">
            <div>
              <span className="fa-kicker">CONTENT SHORTCUTS</span>
              <strong>内容管理快捷入口</strong>
            </div>
            <button type="button" onClick={() => setSection("music")}><Music2 size={15} />音乐管理</button>
            <Link to="/admin/announcement"><Bell size={15} />公告管理</Link>
            <Link to="/admin/dynamics"><Quote size={15} />动态管理</Link>
            <Link to="/admin/posts"><FileText size={15} />文章管理</Link>
          </section>
        </>
      ) : (
        <form className={`fa-settings-workspace${section === "media" ? " is-media" : ""}`} onSubmit={save}>
          {section === "features" ? (
            <section className="fa-panel fa-settings-section fa-feature-settings">
              <div className="fa-settings-section-head">
                <span className="fa-settings-section-icon"><SlidersHorizontal size={20} /></span>
                <div><strong>前台功能开放范围</strong><p>关闭后对应入口会从前台隐藏，相关接口也会拒绝请求。已有数据不会被删除。</p></div>
              </div>
              {featureLoading ? (
                <div className="fa-settings-loading"><RefreshCw size={18} className="fa-spin" />正在加载功能开关</div>
              ) : (
                <div className="fa-feature-switch-list">
                  {FEATURE_SETTINGS_FIELDS.map((item) => (
                    <label className="fa-switch-row" key={item.key}>
                      <span><strong>{item.label}</strong><small>{item.description}</small></span>
                      <button
                        type="button"
                        className={"fa-switch " + (features[item.key] ? "is-on" : "")}
                        aria-label={item.label + (features[item.key] ? "已开启" : "已关闭")}
                        aria-pressed={features[item.key]}
                        onClick={() => setFeatures((current) => ({ ...current, [item.key]: !current[item.key] }))}
                      ><span /></button>
                    </label>
                  ))}
                </div>
              )}
              <p className="fa-field-note">提示：关闭用户登录会同时阻止用户中心、图床和在线剪贴板的登录后操作；公开资源访问可单独关闭。</p>
            </section>
          ) : null}

          {section === "basic" ? (
            <section className="fa-panel fa-settings-section">
              <div className="fa-settings-section-head">
                <span className="fa-settings-section-icon"><SlidersHorizontal size={20} /></span>
                <div><strong>站点身份</strong><p>这些内容用于导航、浏览器元信息和分享摘要。</p></div>
              </div>
              <div className="fa-settings-grid">
                <label>站点标题<input value={form.title} maxLength={120} required onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
                <label>站点副标题<input value={form.subtitle} maxLength={255} onChange={(event) => setForm((current) => ({ ...current, subtitle: event.target.value }))} /></label>
              </div>
              <label>站点描述<textarea value={form.description} maxLength={1000} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
              <label className="fa-range-label">
                <span>主题色相 <output>{form.hue}°</output></span>
                <input type="range" min="0" max="360" value={form.hue} onChange={(event) => setForm((current) => ({ ...current, hue: Number(event.target.value) }))} />
                <span className="fa-hue-preview" style={{ background: `hsl(${form.hue} 70% 45%)` }} />
              </label>
            </section>
          ) : null}

          {section === "media" ? (
            <div className="fa-media-settings-grid">
              <section className="fa-panel fa-settings-section fa-media-settings-form">
                <div className="fa-settings-section-head">
                  <span className="fa-settings-section-icon"><ImageIcon size={20} /></span>
                  <div><strong>媒体资源配置</strong><p>管理视频链路预留参数、首页头图、头像与浏览器网站图标。</p></div>
                </div>

                <label className="fa-media-size-field">
                  <span>视频上传大小上限（MB，视频链路接入后生效）</span>
                  <input
                    type="number"
                    min="1"
                    max="2048"
                    step="1"
                    value={form.videoUploadMaxSizeMb}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      videoUploadMaxSizeMb: Math.round(
                        boundedNumber(event.target.value, current.videoUploadMaxSizeMb, 1, 2048),
                      ),
                    }))}
                  />
                </label>

                <div className="fa-media-switch-field">
                  <div><strong>服务器自动转码（预留）</strong><span>视频处理链路接入后，超过 1080p 或 12Mbps 的 MP4 将自动转换为适合网页播放的规格。</span></div>
                  <button
                    type="button"
                    className={`fa-switch ${form.videoAutoTranscodeEnabled ? "is-on" : ""}`}
                    aria-label={`服务器自动转码${form.videoAutoTranscodeEnabled ? "已开启" : "已关闭"}`}
                    aria-pressed={form.videoAutoTranscodeEnabled}
                    onClick={() => setForm((current) => ({
                      ...current,
                      videoAutoTranscodeEnabled: !current.videoAutoTranscodeEnabled,
                    }))}
                  ><span /></button>
                </div>

                <div className="fa-media-field-group">
                  <div className="fa-media-field-heading"><strong>首页头图</strong><span>支持上传、图床链接或随机图片 API。</span></div>
                  <div className="fa-segmented" role="group" aria-label="头图来源">
                    {[
                      { value: "upload", label: "本地上传", icon: Upload },
                      { value: "url", label: "图床链接", icon: Link2 },
                      { value: "api", label: "图片 API", icon: Sparkles },
                    ].map((item) => {
                      const Icon = item.icon;
                      return <button type="button" className={form.cover.mode === item.value ? "is-active" : ""} aria-pressed={form.cover.mode === item.value} onClick={() => setForm((current) => ({ ...current, cover: { ...current.cover, mode: item.value as SiteSettingsForm["cover"]["mode"] } }))} key={item.value}><Icon size={15} />{item.label}</button>;
                    })}
                  </div>
                  {form.cover.mode === "api" ? (
                    <label>图片 API 地址<input value={form.cover.apiUrl} placeholder="https://example.com/random-image" onChange={(event) => setForm((current) => ({ ...current, cover: { ...current.cover, apiUrl: event.target.value } }))} /><small className="fa-field-note">接口可直接返回图片，或重定向到实际图片地址。</small></label>
                  ) : (
                    <label>首页头图路径<input value={form.cover.value} placeholder="/images/banner.webp" onChange={(event) => setForm((current) => ({ ...current, cover: { ...current.cover, value: event.target.value } }))} /></label>
                  )}
                  <div className="fa-media-upload-row">
                    <AdminMediaUpload kind="image" accept=".jpg,.jpeg,.png,.gif,.webp,.avif,.svg,image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml" label="上传头图" disabled={mediaUploadsActive} onUploadingChange={handleMediaUploadingChange} onError={showUploadError} onUploaded={(url) => setForm((current) => ({ ...current, cover: { ...current.cover, mode: "upload", value: url } }))} />
                  </div>
                </div>

                <div className="fa-media-crop-controls">
                  {[
                    { axis: "x", label: "页面头图截取横向位置（X%）", value: position.x },
                    { axis: "y", label: "页面头图截取纵向位置（Y%）", value: position.y },
                  ].map((item) => (
                    <div className="fa-media-crop-control" key={item.axis}>
                      <label htmlFor={`media-crop-${item.axis}`}>{item.label}</label>
                      <div>
                        <input
                          id={`media-crop-${item.axis}`}
                          type="range"
                          min="0"
                          max="100"
                          step="0.1"
                          value={item.value}
                          onChange={(event) => updateCoverPosition(
                            item.axis === "x" ? Number(event.target.value) : position.x,
                            item.axis === "y" ? Number(event.target.value) : position.y,
                          )}
                        />
                        <span className="fa-media-percent-input">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            aria-label={item.label}
                            value={item.value}
                            onChange={(event) => updateCoverPosition(
                              item.axis === "x" ? Number(event.target.value) : position.x,
                              item.axis === "y" ? Number(event.target.value) : position.y,
                            )}
                          />
                          <i>%</i>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="fa-media-field-group">
                  <label>头像路径<input value={form.author.avatar} placeholder="/images/avatar.webp" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, avatar: event.target.value } }))} /></label>
                  <div className="fa-media-upload-row">
                    <AdminMediaUpload kind="image" accept=".jpg,.jpeg,.png,.gif,.webp,.avif,.svg,image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml" label="上传头像" disabled={mediaUploadsActive} onUploadingChange={handleMediaUploadingChange} onError={showUploadError} onUploaded={(url) => setForm((current) => ({ ...current, author: { ...current.author, avatar: url } }))} />
                  </div>
                </div>

                <div className="fa-media-field-group">
                  <label>网站图标（Favicon）路径<input value={form.siteFavicon} placeholder="/images/favicon.ico" onChange={(event) => setForm((current) => ({ ...current, siteFavicon: event.target.value }))} /></label>
                  <div className="fa-media-upload-row">
                    <AdminMediaUpload kind="image" accept=".ico,.png,.svg,.webp,image/x-icon,image/vnd.microsoft.icon,image/png,image/svg+xml,image/webp" label="上传图标" disabled={mediaUploadsActive} onUploadingChange={handleMediaUploadingChange} onError={showUploadError} onUploaded={(url) => setForm((current) => ({ ...current, siteFavicon: url }))} />
                  </div>
                  <small className="fa-field-note">建议使用正方形 PNG、ICO、SVG 或 WebP 文件。</small>
                </div>

                <div className="fa-media-form-actions">
                  <PrimaryButton type="submit" disabled={saving || mediaUploadsActive}>
                    {saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}
                    {saving ? "保存中" : saved ? "已保存" : "保存媒体资源"}
                  </PrimaryButton>
                  <GhostButton onClick={load} disabled={loading || saving || mediaUploadsActive}>
                    <RefreshCw size={15} className={loading ? "fa-spin" : ""} />重新加载
                  </GhostButton>
                </div>
              </section>

              <aside className="fa-panel fa-media-preview-panel" aria-label="媒体资源预览">
                <MediaCropPreview
                  src={resolvedCoverPreview}
                  x={position.x}
                  y={position.y}
                  onPositionChange={updateCoverPosition}
                />
                <div className="fa-media-asset-previews">
                  <MediaAssetPreview title="头像预览" src={resolveAdminMediaUrl(form.author.avatar)} kind="avatar" />
                  <MediaAssetPreview title="网站图标预览" src={resolveAdminMediaUrl(form.siteFavicon)} kind="favicon" />
                </div>
              </aside>
            </div>
          ) : null}

          {section === "content" ? (
            <>
              <section className="fa-panel fa-settings-section">
                <div className="fa-settings-section-head">
                  <span className="fa-settings-section-icon"><Sparkles size={20} /></span>
                  <div><strong>首页主副标题</strong><p>一言不可用时会自动回退到默认副标题文案。</p></div>
                </div>
                <div className="fa-settings-grid">
                  <label>首页主标题<input value={form.titleConfig.title} required maxLength={120} onChange={(event) => setForm((current) => ({ ...current, titleConfig: { ...current.titleConfig, title: event.target.value } }))} /></label>
                  <label>副标题来源<select value={form.titleConfig.subtitleMode} onChange={(event) => setForm((current) => ({ ...current, titleConfig: { ...current.titleConfig, subtitleMode: event.target.value as "text" | "hitokoto" } }))}><option value="text">默认文案</option><option value="hitokoto">主页 - 一言</option></select></label>
                </div>
                <label>默认副标题<textarea value={form.titleConfig.subtitle} maxLength={500} placeholder="支持多行文案；一言失败时也会显示这里的内容。" onChange={(event) => setForm((current) => ({ ...current, titleConfig: { ...current.titleConfig, subtitle: event.target.value } }))} /></label>
                {form.titleConfig.subtitleMode === "hitokoto" ? (
                  <div className="fa-hitokoto-settings">
                    <label>一言 API<input value={form.titleConfig.hitokotoApi} placeholder="https://v1.hitokoto.cn/?encode=json" onChange={(event) => setForm((current) => ({ ...current, titleConfig: { ...current.titleConfig, hitokotoApi: event.target.value } }))} /></label>
                    <GhostButton onClick={() => void testHitokoto()} disabled={hitokotoLoading}><RefreshCw size={15} className={hitokotoLoading ? "fa-spin" : ""} />测试一言</GhostButton>
                    {hitokotoPreview ? <blockquote>“{hitokotoPreview}”</blockquote> : null}
                  </div>
                ) : null}
              </section>
              <section className="fa-panel fa-settings-section">
                <div className="fa-settings-section-head">
                  <span className="fa-settings-section-icon"><Type size={20} /></span>
                  <div><strong>字体资源</strong><p>支持 TTF、OTF、WOFF 与 WOFF2，上传后会自动写入对应地址。</p></div>
                </div>
                <div className="fa-font-grid">
                  {FONT_FIELDS.map((item) => (
                    <div className="fa-font-field" key={item.key}>
                      <div><strong>{item.label}</strong><span>{item.description}</span></div>
                      <input value={form.titleConfig[item.key]} placeholder="/uploads/font/example.woff2" onChange={(event) => setForm((current) => ({ ...current, titleConfig: { ...current.titleConfig, [item.key]: event.target.value } }))} />
                      <AdminMediaUpload kind="font" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" label="导入字体文件" onError={showUploadError} onUploaded={(url) => setForm((current) => ({ ...current, titleConfig: { ...current.titleConfig, [item.key]: url } }))} />
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {section === "music" ? (
            <section className="fa-panel fa-settings-section">
              <div className="fa-settings-section-head">
                <span className="fa-settings-section-icon"><Music2 size={20} /></span>
                <div><strong>前台音乐播放器</strong><p>关闭后前台隐藏音乐入口，音乐文件仍会保留。</p></div>
                <button type="button" className={`fa-switch ${form.music.enabled ? "is-on" : ""}`} aria-label="切换音乐播放器" aria-pressed={form.music.enabled} onClick={() => setForm((current) => ({ ...current, music: { ...current.music, enabled: !current.music.enabled } }))}><span /></button>
              </div>
              <div className="fa-settings-grid">
                <label>歌曲名称<input value={form.music.title} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, music: { ...current.music, title: event.target.value } }))} /></label>
                <label>歌手 / 来源<input value={form.music.artist} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, music: { ...current.music, artist: event.target.value } }))} /></label>
              </div>
              <label>音乐文件地址<input value={form.music.src} placeholder="https://music.example.com/song.mp3" onChange={(event) => setForm((current) => ({ ...current, music: { ...current.music, src: event.target.value } }))} /></label>
              <AdminMediaUpload kind="audio" accept="audio/mpeg,audio/wav,audio/ogg,audio/flac,audio/mp4,.mp3,.wav,.ogg,.flac,.m4a" label="导入音乐文件" onError={showUploadError} onUploaded={(url, file) => setForm((current) => ({ ...current, music: { ...current.music, src: url, title: current.music.title || file.name.replace(/\.[^.]+$/u, "") } }))} />
              <label>歌曲封面<input value={form.music.cover} placeholder="https://images.example.com/album.webp" onChange={(event) => setForm((current) => ({ ...current, music: { ...current.music, cover: event.target.value } }))} /></label>
              <AdminMediaUpload kind="image" accept="image/jpeg,image/png,image/webp,image/avif" label="上传歌曲封面" onError={showUploadError} onUploaded={(url) => setForm((current) => ({ ...current, music: { ...current.music, cover: url } }))} />
              <div className="fa-toggle-row">
                <label><input type="checkbox" checked={form.music.autoplay} onChange={(event) => setForm((current) => ({ ...current, music: { ...current.music, autoplay: event.target.checked } }))} />自动播放</label>
                <label><input type="checkbox" checked={form.music.loop} onChange={(event) => setForm((current) => ({ ...current, music: { ...current.music, loop: event.target.checked } }))} />循环播放</label>
              </div>
              {form.music.src ? (
                <div className="fa-music-preview">
                  {form.music.cover ? <img src={resolveAdminMediaUrl(form.music.cover)} alt="歌曲封面" /> : <span><FileAudio size={24} /></span>}
                  <div><strong>{form.music.title || "未命名曲目"}</strong><small>{form.music.artist || "未填写歌手"}</small><audio controls preload="metadata" src={resolveAdminMediaUrl(form.music.src)} loop={form.music.loop} /></div>
                </div>
              ) : null}
            </section>
          ) : null}

          {section === "author" ? (
            <section className="fa-panel fa-settings-section">
              <div className="fa-settings-section-head">
                <span className="fa-settings-section-icon"><UserRound size={20} /></span>
                <div><strong>左侧作者栏</strong><p>头像、昵称、介绍和链接会直接显示在前台侧边栏。</p></div>
              </div>
              <div className="fa-author-editor">
                <div className="fa-avatar-editor">
                  <div>{form.author.avatar ? <img src={resolveAdminMediaUrl(form.author.avatar)} alt="作者头像预览" /> : <UserRound size={32} />}</div>
                  <AdminMediaUpload kind="image" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" label="更换头像" onError={showUploadError} onUploaded={(url) => setForm((current) => ({ ...current, author: { ...current.author, avatar: url } }))} />
                </div>
                <div className="fa-author-fields">
                  <label>头像链接<input value={form.author.avatar} onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, avatar: event.target.value } }))} /></label>
                  <label>昵称<input value={form.author.name} maxLength={80} onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, name: event.target.value } }))} /></label>
                  <label>个人介绍<textarea value={form.author.bio} maxLength={500} onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, bio: event.target.value } }))} /></label>
                </div>
              </div>
              <div className="fa-settings-grid">
                <label>Email<input type="email" value={form.author.email} placeholder="you@example.com" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, email: event.target.value } }))} /></label>
                <label>GitHub<input value={form.author.githubUrl} placeholder="https://github.com/yourname" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, githubUrl: event.target.value } }))} /></label>
                <label>QQ 跳转链接<input value={form.author.qqUrl} placeholder="https://wpa.qq.com/..." onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, qqUrl: event.target.value } }))} /></label>
                <label>RSS 地址<input value={form.author.rssUrl} placeholder="/rss.xml" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, rssUrl: event.target.value } }))} /></label>
              </div>
              <div className="fa-custom-links-head"><div><strong>自定义跳转链接</strong><span>可添加主页、社交账号或任意公开页面。</span></div><GhostButton onClick={() => setForm((current) => ({ ...current, author: { ...current.author, links: [...current.author.links, { label: "", url: "", icon: "link" }] } }))}><Plus size={14} />添加链接</GhostButton></div>
              <div className="fa-custom-links">
                {form.author.links.length ? form.author.links.map((link, index) => (
                  <div key={`${index}-${link.url}`}>
                    <input value={link.label} aria-label={`链接 ${index + 1} 名称`} placeholder="名称" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, links: current.author.links.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) } }))} />
                    <input value={link.url} aria-label={`链接 ${index + 1} 地址`} placeholder="https://example.com" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, links: current.author.links.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item) } }))} />
                    <input value={link.icon ?? ""} aria-label={`链接 ${index + 1} 图标`} placeholder="图标名称（可选）" onChange={(event) => setForm((current) => ({ ...current, author: { ...current.author, links: current.author.links.map((item, itemIndex) => itemIndex === index ? { ...item, icon: event.target.value } : item) } }))} />
                    <button type="button" title="删除链接" onClick={() => setForm((current) => ({ ...current, author: { ...current.author, links: current.author.links.filter((_, itemIndex) => itemIndex !== index) } }))}><Trash2 size={15} /></button>
                  </div>
                )) : <EmptyState>还没有自定义链接</EmptyState>}
              </div>
            </section>
          ) : null}

          {section !== "media" ? <footer className="fa-settings-savebar">
            <div><strong>{activeMeta?.title}</strong><span>{saved ? "配置已同步到前台。" : "修改后请保存当前配置。"}</span></div>
            <GhostButton onClick={() => setSection("center")}><ChevronRight size={15} />返回设置中心</GhostButton>
            <PrimaryButton type="submit" disabled={saving}>
              {saving ? <RefreshCw size={15} className="fa-spin" /> : <Save size={15} />}
              {saving ? "保存中" : saved ? "已保存" : "保存设置"}
            </PrimaryButton>
          </footer> : null}
        </form>
      )}
    </div>
  );
}

function normalizeHistory(value: unknown): AnnouncementHistoryItem[] {
  if (Array.isArray(value)) return value as AnnouncementHistoryItem[];
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items)
  )
    return (value as { items: AnnouncementHistoryItem[] }).items;
  return [];
}

function AdminAnnouncement() {
  const [current, setCurrent] = useState<AnnouncementState>({
    content: "",
    updatedAt: "",
  });
  const [history, setHistory] = useState<AnnouncementHistoryItem[]>([]);
  const [draft, setDraft] = useState("");
  const [historyDraft, setHistoryDraft] = useState({
    id: "" as string | number,
    content: "",
    publishedAt: "",
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = () => {
    setLoading(true);
    void Promise.all([
      adminRequest<AnnouncementState>("/api/admin/announcement"),
      adminRequest<unknown>(
        "/api/admin/announcements/history?limit=50&keyword=" +
          encodeURIComponent(keyword),
      ),
    ])
      .then(([currentValue, historyValue]) => {
        const normalized =
          currentValue &&
          typeof currentValue === "object" &&
          "announcement" in currentValue
            ? (currentValue as { announcement: AnnouncementState }).announcement
            : currentValue;
        setCurrent(normalized);
        setDraft(normalized.content ?? "");
        setHistory(normalizeHistory(historyValue));
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);
  const saveCurrent = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const value = await adminRequest<AnnouncementState>(
        "/api/admin/announcement",
        { method: "POST", body: JSON.stringify({ content: draft }) },
      );
      setCurrent(value);
      setDraft(value.content ?? draft);
      load();
    } finally {
      setSaving(false);
    }
  };
  const openNew = () => {
    setHistoryDraft({
      id: "",
      content: "",
      publishedAt: toDateTimeLocal(new Date().toISOString()),
    });
    setDialogOpen(true);
  };
  const openEdit = (item: AnnouncementHistoryItem) => {
    setHistoryDraft({
      id: item.id ?? "",
      content: item.content,
      publishedAt: toDateTimeLocal(item.publishedAt),
    });
    setDialogOpen(true);
  };
  const saveHistory = async (event: FormEvent) => {
    event.preventDefault();
    if (!historyDraft.content.trim()) return;
    const path = historyDraft.id
      ? "/api/admin/announcements/history/" + historyDraft.id
      : "/api/admin/announcements/history";
    await adminRequest(path, {
      method: historyDraft.id ? "PUT" : "POST",
      body: JSON.stringify({
        content: historyDraft.content,
        publishedAt: historyDraft.publishedAt
          ? new Date(historyDraft.publishedAt).toISOString()
          : undefined,
      }),
    });
    setDialogOpen(false);
    load();
  };
  const historyAction = async (path: string, options: RequestInit = {}) => {
    await adminRequest(path, options);
    load();
  };
  return (
    <div className="fa-page">
      <PageHeading
        eyebrow="CONTENT CENTER"
        title="公告管理"
        description="发布当前公告、维护历史归档，并控制公告栏的展示顺序。"
        action={
          <PrimaryButton onClick={openNew}>
            <Plus size={15} />
            新增历史公告
          </PrimaryButton>
        }
      />
      <form className="fa-panel fa-announcement-current" onSubmit={saveCurrent}>
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <Bell size={18} />
              <h2>当前公告</h2>
              <span className="fa-pill published">正在展示</span>
            </div>
            <p>保存后会同步到前台侧边栏公告组件。</p>
          </div>
          <div className="fa-meta-stack">
            <span>存储：{current.storage ?? "MySQL"}</span>
            <span>更新：{dateText(current.updatedAt)}</span>
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={20000}
          rows={7}
          placeholder="输入公告内容，可使用简洁的 HTML 文本"
        />
        <div className="fa-form-footer">
          <span>{draft.length}/20000</span>
          <PrimaryButton type="submit" disabled={saving}>
            {saving ? (
              <>
                <RefreshCw size={15} className="fa-spin" />
                发布中
              </>
            ) : (
              <>
                <Bell size={15} />
                发布公告
              </>
            )}
          </PrimaryButton>
        </div>
      </form>
      <section className="fa-panel fa-history-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <Archive size={18} />
              <h2>历史公告</h2>
              <span>{history.length} 条记录</span>
            </div>
            <p>历史版本可以重新发布，也可以单独控制公告栏展示、置顶与排序。</p>
          </div>
          <div className="fa-history-search">
            <Search size={15} />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") load();
              }}
              placeholder="搜索内容"
            />
            <button type="button" onClick={load} title="搜索">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
        <div className="fa-table-wrap">
          <table className="fa-table fa-history-table">
            <thead>
              <tr>
                <th>公告内容</th>
                <th>公告栏</th>
                <th>排序</th>
                <th>置顶</th>
                <th>发布时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6}>
                    <div className="fa-table-loading">
                      <RefreshCw size={17} className="fa-spin" />
                      加载中
                    </div>
                  </td>
                </tr>
              ) : history.length ? (
                history.map((item) => {
                  const readOnly = Boolean(item.readOnly);
                  return (
                  <tr key={String(item.id)}>
                    <td>
                      <div className="fa-history-content">
                        {item.isCurrent ? (
                          <span className="fa-pill published">当前</span>
                        ) : null}
                        <span title={item.content}>{item.content}</span>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={readOnly}
                        className={
                          "fa-switch " + (item.isVisible ? "is-on" : "")
                        }
                        onClick={() =>
                          void historyAction(
                            "/api/admin/announcements/history/" +
                              item.id +
                              "/display",
                            {
                              method: "PATCH",
                              body: JSON.stringify({
                                isVisible: !item.isVisible,
                                isPinned: item.isPinned,
                                sortOrder: item.sortOrder,
                              }),
                            },
                          )
                        }
                      >
                        <span />
                      </button>
                    </td>
                    <td>
                      <input
                        className="fa-sort-input"
                        type="number"
                        disabled={readOnly}
                        value={item.sortOrder}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          setHistory((rows) =>
                            rows.map((row) =>
                              row.id === item.id
                                ? { ...row, sortOrder: value }
                                : row,
                            ),
                          );
                        }}
                        onBlur={() =>
                          void historyAction(
                            "/api/admin/announcements/history/" +
                              item.id +
                              "/display",
                            {
                              method: "PATCH",
                              body: JSON.stringify({
                                isVisible: item.isVisible,
                                isPinned: item.isPinned,
                                sortOrder: item.sortOrder,
                              }),
                            },
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={readOnly}
                        className={
                          "fa-pin-button " + (item.isPinned ? "is-on" : "")
                        }
                        onClick={() =>
                          void historyAction(
                            "/api/admin/announcements/history/" +
                              item.id +
                              "/display",
                            {
                              method: "PATCH",
                              body: JSON.stringify({
                                isVisible: item.isVisible,
                                isPinned: !item.isPinned,
                                sortOrder: item.sortOrder,
                              }),
                            },
                          )
                        }
                      >
                        {item.isPinned ? "已置顶" : "置顶"}
                      </button>
                    </td>
                    <td>
                      <span className="fa-date-cell">
                        {dateText(item.publishedAt)}
                      </span>
                    </td>
                    <td>
                      <div className="fa-inline-actions">
                        <button
                          type="button"
                          title="设为当前"
                          disabled={Boolean(item.isCurrent)}
                          onClick={() =>
                            void historyAction(
                              "/api/admin/announcements/history/" +
                                item.id +
                                "/publish",
                              { method: "POST" },
                            )
                          }
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          title="编辑"
                          disabled={readOnly}
                          onClick={() => openEdit(item)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          title="删除"
                          disabled={readOnly}
                          onClick={() => {
                            if (window.confirm("确认删除这条历史公告吗？"))
                              void historyAction(
                                "/api/admin/announcements/history/" + item.id,
                                { method: "DELETE" },
                              );
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6}>
                    <EmptyState>暂无历史公告</EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {dialogOpen ? (
        <div
          className="fa-dialog-overlay"
          role="presentation"
          onClick={() => setDialogOpen(false)}
        >
          <form
            className="fa-dialog"
            onSubmit={saveHistory}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="fa-dialog-head">
              <div>
                <span className="fa-kicker">ANNOUNCEMENT ARCHIVE</span>
                <h2>{historyDraft.id ? "编辑历史公告" : "新增历史公告"}</h2>
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => setDialogOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              发布时间
              <input
                type="datetime-local"
                value={historyDraft.publishedAt}
                onChange={(event) =>
                  setHistoryDraft({
                    ...historyDraft,
                    publishedAt: event.target.value,
                  })
                }
              />
            </label>
            <label>
              公告内容
              <textarea
                rows={9}
                maxLength={20000}
                value={historyDraft.content}
                onChange={(event) =>
                  setHistoryDraft({
                    ...historyDraft,
                    content: event.target.value,
                  })
                }
                placeholder="输入历史公告内容"
                required
              />
            </label>
            <div className="fa-dialog-footer">
              <GhostButton onClick={() => setDialogOpen(false)}>
                取消
              </GhostButton>
              <PrimaryButton type="submit">
                <Save size={15} />
                保存归档
              </PrimaryButton>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function AdminPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="fa-page">
      <PageHeading
        eyebrow="MODULE PLACEHOLDER"
        title={title}
        description={description}
      />
      <section className="fa-panel fa-placeholder">
        <span className="fa-placeholder-icon">
          <CircleHelp size={24} />
        </span>
        <h2>功能模块预留中</h2>
        <p>
          这个入口已按 mini_blog
          的信息架构保留，后续可以接入更完整的媒体、监控、页面或权限服务。
        </p>
        <div>
          <Link className="fa-button fa-button-primary" to="/admin">
            回到仪表盘
            <ChevronRight size={15} />
          </Link>
        </div>
      </section>
    </div>
  );
}

export default function AdminApp() {
  const location = useLocation();
  if (location.pathname === "/admin/login") return <AdminLogin />;
  if (!sessionStorage.getItem("firefly-admin-token"))
    return <Navigate to="/admin/login" replace />;
  return <AdminShell />;
}
