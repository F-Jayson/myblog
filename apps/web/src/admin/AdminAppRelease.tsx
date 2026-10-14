import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  History,
  Info,
  Layers,
  PlusCircle,
  RefreshCw,
  Rocket,
  RotateCcw,
  Smartphone,
  Square,
  Trash2,
} from "lucide-react";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
const AUTH_EXPIRED_EVENT = "site-admin-auth-expired";

export type AppScheduleAsset = {
  abi: string; // "universal" | "arm64-v8a" | "armeabi-v7a" | "x86_64" | string
  driveFileId?: number | null;
  fileName: string;
  downloadUrl: string;
  byteSize: number;
};

export type AppScheduleRelease = {
  id: string;
  versionName: string;
  versionCode: number;
  releaseNotes: string;
  driveFileId: number | null;
  downloadUrl: string;
  fileName: string;
  byteSize: number;
  publishedAt: string;
  assets?: AppScheduleAsset[];
  isActive?: boolean;
};

export type DriveApkFile = {
  id: number;
  name: string;
  mimeType: string;
  byteSize: number;
  downloadCount: number;
  downloadUrl: string;
  createdAt: string;
};

type ReleaseResponse = {
  release: AppScheduleRelease | null;
  releases?: AppScheduleRelease[];
  apkFiles: DriveApkFile[];
  allDriveFiles: DriveApkFile[];
  publicOrigin: string;
};

function authHeaders() {
  const headers = new Headers();
  const token = sessionStorage.getItem("site-admin-token");
  if (token) headers.set("authorization", "Bearer " + token);
  return headers;
}

function expireAdminSession() {
  sessionStorage.removeItem("site-admin-token");
  sessionStorage.removeItem("site-admin-username");
  sessionStorage.setItem("site-admin-auth-message", "登录状态已失效，请重新输入管理员账号和密码。");
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || "请求失败，请稍后重试。";
}

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = authHeaders();
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(API_ORIGIN + path, { ...options, headers });
  if (response.status === 401) {
    expireAdminSession();
    throw new Error("登录状态已失效");
  }
  if (!response.ok) throw new Error(await readError(response));
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function bytesText(value: number) {
  if (!Number.isFinite(value) || value < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return amount.toFixed(index > 1 ? 1 : 0) + " " + units[index];
}

function dateText(value: string) {
  if (!value) return "未知时间";
  const date = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function detectAbiFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("arm64-v8a") || lower.includes("arm64") || lower.includes("aarch64")) return "arm64-v8a";
  if (lower.includes("armeabi-v7a") || lower.includes("armv7") || lower.includes("armeabi")) return "armeabi-v7a";
  if (lower.includes("x86_64") || lower.includes("x64")) return "x86_64";
  if (lower.includes("x86")) return "x86";
  if (lower.includes("universal")) return "universal";
  return "universal";
}

function abiBadgeText(abi: string): { label: string; bg: string; color: string } {
  switch (abi.toLowerCase()) {
    case "arm64-v8a":
      return { label: "ARM64 (手机主力)", bg: "#e0f2fe", color: "#0369a1" };
    case "universal":
      return { label: "Universal (全架构通用)", bg: "#fef3c7", color: "#b45309" };
    case "armeabi-v7a":
      return { label: "ARM32 (旧设备)", bg: "#f3e8ff", color: "#7e22ce" };
    case "x86_64":
      return { label: "x86_64 (PC模拟器)", bg: "#ecfdf5", color: "#047857" };
    default:
      return { label: abi, bg: "#f1f5f9", color: "#475569" };
  }
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "true");
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

type SelectedAssetItem = {
  driveFileId: number;
  fileName: string;
  byteSize: number;
  downloadUrl: string;
  abi: string;
  isPrimary: boolean;
};

export default function AdminAppRelease() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"info" | "error" | "success">("info");
  const [release, setRelease] = useState<AppScheduleRelease | null>(null);
  const [releases, setReleases] = useState<AppScheduleRelease[]>([]);
  const [expandedReleaseId, setExpandedReleaseId] = useState<string | null>(null);
  const [apkFiles, setApkFiles] = useState<DriveApkFile[]>([]);
  const [allFiles, setAllFiles] = useState<DriveApkFile[]>([]);
  const [publicOrigin, setPublicOrigin] = useState("https://files.fjayson.com");
  const [copiedKey, setCopiedKey] = useState("");

  // Form State
  const [versionName, setVersionName] = useState("");
  const [versionCode, setVersionCode] = useState<number | "">("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<SelectedAssetItem[]>([]);

  // 自定义单外链降级支持
  const [allowCustomFallback, setAllowCustomFallback] = useState(false);
  const [customDownloadUrl, setCustomDownloadUrl] = useState("");
  const [customFileName, setCustomFileName] = useState("");
  const [customFileSize, setCustomFileSize] = useState<number | "">("");

  const candidateFiles = useMemo(() => {
    if (apkFiles.length > 0) return apkFiles;
    return allFiles;
  }, [apkFiles, allFiles]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<ReleaseResponse>("/api/admin/app-releases/schedule");
      setRelease(data.release);
      const historyList = data.releases && data.releases.length > 0
        ? data.releases
        : (data.release ? [data.release] : []);
      setReleases(historyList);
      setApkFiles(data.apkFiles || []);
      setAllFiles(data.allDriveFiles || []);
      setPublicOrigin(data.publicOrigin || "https://files.fjayson.com");

      // 仅当表单完全空白时，根据最新发布版本预填充建议信息
      if (data.release && !versionName && versionCode === "") {
        setVersionName(data.release.versionName);
        setVersionCode(data.release.versionCode + 1);
        setReleaseNotes(data.release.releaseNotes);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载发布信息失败。");
      setMessageType("error");
    } finally {
      setLoading(false);
    }
  }, [versionName, versionCode]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 切换选中某一个网盘文件
  const toggleSelectApk = (file: DriveApkFile) => {
    const isSelected = selectedAssets.some((a) => a.driveFileId === file.id);
    let next: SelectedAssetItem[];

    if (isSelected) {
      next = selectedAssets.filter((a) => a.driveFileId !== file.id);
      if (next.length > 0 && !next.some((a) => a.isPrimary)) {
        next[0].isPrimary = true;
      }
    } else {
      const autoAbi = detectAbiFromName(file.name);
      const isFirst = selectedAssets.length === 0;
      next = [
        ...selectedAssets,
        {
          driveFileId: file.id,
          fileName: file.name,
          byteSize: file.byteSize,
          downloadUrl: file.downloadUrl,
          abi: autoAbi,
          isPrimary: isFirst || autoAbi === "universal",
        },
      ];

      // 智能识别版本名称与版本代码
      const match = /(?:v)?(\d+\.\d+(?:\.\d+)?)/i.exec(file.name);
      if (match && !versionName) {
        setVersionName(match[1]);
      }
      const codeMatch = /code(\d+)/i.exec(file.name);
      if (codeMatch && versionCode === "") {
        setVersionCode(parseInt(codeMatch[1], 10));
      }
    }

    setSelectedAssets(next);
  };

  // 修改某个选定资产的 ABI
  const updateAssetAbi = (driveFileId: number, newAbi: string) => {
    setSelectedAssets((current) =>
      current.map((a) => (a.driveFileId === driveFileId ? { ...a, abi: newAbi } : a))
    );
  };

  // 设置某一个为默认主下载包
  const setPrimaryAsset = (driveFileId: number) => {
    setSelectedAssets((current) =>
      current.map((a) => ({ ...a, isPrimary: a.driveFileId === driveFileId }))
    );
  };

  // 一键选择所有网盘中的候选 APK
  const selectAllApks = () => {
    if (candidateFiles.length === 0) return;
    const allSelected = candidateFiles.every((f) =>
      selectedAssets.some((a) => a.driveFileId === f.id)
    );
    if (allSelected) {
      setSelectedAssets([]);
      return;
    }

    const items: SelectedAssetItem[] = candidateFiles.map((file, idx) => {
      const existing = selectedAssets.find((a) => a.driveFileId === file.id);
      const abi = existing ? existing.abi : detectAbiFromName(file.name);
      return {
        driveFileId: file.id,
        fileName: file.name,
        byteSize: file.byteSize,
        downloadUrl: file.downloadUrl,
        abi,
        isPrimary: existing ? existing.isPrimary : (abi === "universal" || idx === 0),
      };
    });

    if (!items.some((i) => i.isPrimary) && items.length > 0) {
      items[0].isPrimary = true;
    }

    setSelectedAssets(items);

    // 智能提取版本
    for (const f of candidateFiles) {
      const match = /(?:v)?(\d+\.\d+(?:\.\d+)?)/i.exec(f.name);
      if (match && !versionName) setVersionName(match[1]);
      const codeMatch = /code(\d+)/i.exec(f.name);
      if (codeMatch && versionCode === "") setVersionCode(parseInt(codeMatch[1], 10));
    }
  };

  const handleCopy = async (key: string, text: string) => {
    try {
      await copyText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((c) => (c === key ? "" : c)), 2000);
    } catch {
      setMessage("复制失败，请手动复制。");
      setMessageType("error");
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!versionName.trim()) {
      setMessage("请填写版本名称（如 1.1.0）。");
      setMessageType("error");
      return;
    }
    const codeNum = typeof versionCode === "number" ? versionCode : parseInt(String(versionCode), 10);
    if (Number.isNaN(codeNum) || codeNum < 1) {
      setMessage("版本号必须为大于 0 的整数。");
      setMessageType("error");
      return;
    }

    let primaryDownloadUrl = "";
    let primaryFileName = "";
    let primaryByteSize = 0;
    let primaryDriveFileId: number | null = null;
    let assetsPayload: AppScheduleAsset[] = [];

    if (selectedAssets.length > 0) {
      const primary = selectedAssets.find((a) => a.isPrimary) || selectedAssets[0];
      primaryDownloadUrl = primary.downloadUrl;
      primaryFileName = primary.fileName;
      primaryByteSize = primary.byteSize;
      primaryDriveFileId = primary.driveFileId || null;

      assetsPayload = selectedAssets.map((a) => ({
        abi: a.abi,
        driveFileId: a.driveFileId,
        fileName: a.fileName,
        downloadUrl: a.downloadUrl,
        byteSize: a.byteSize,
      }));
    } else if (allowCustomFallback) {
      if (!customDownloadUrl.trim()) {
        setMessage("请选择网盘 APK 文件或输入自定义下载直链。");
        setMessageType("error");
        return;
      }
      primaryDownloadUrl = customDownloadUrl.trim();
      primaryFileName = customFileName.trim() || "MobileSchedule.apk";
      primaryByteSize = typeof customFileSize === "number" ? customFileSize : 0;
      assetsPayload = [
        {
          abi: "universal",
          fileName: primaryFileName,
          downloadUrl: primaryDownloadUrl,
          byteSize: primaryByteSize,
        },
      ];
    } else {
      setMessage("请至少在下方勾选一个网盘中的 APK 安装包文件。");
      setMessageType("error");
      return;
    }

    setSubmitting(true);
    setMessage("");
    try {
      const saved = await apiRequest<AppScheduleRelease>("/api/admin/app-releases/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionName: versionName.trim(),
          versionCode: codeNum,
          releaseNotes: releaseNotes.trim(),
          driveFileId: primaryDriveFileId,
          downloadUrl: primaryDownloadUrl,
          fileName: primaryFileName,
          byteSize: primaryByteSize,
          assets: assetsPayload,
        }),
      });
      setRelease(saved);
      setReleases((prev) => [saved, ...prev.filter((r) => r.id !== saved.id).map((r) => ({ ...r, isActive: false }))]);
      setMessage(`版本 v${saved.versionName} 新建发布成功！已归档至历史记录中，包含 ${assetsPayload.length} 个架构安装包，客户端将自动按机型精准匹配下载。`);
      setMessageType("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发布失败，请稍后重试。");
      setMessageType("error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleActivateRelease = async (id: string, vName: string) => {
    setSubmitting(true);
    setMessage("");
    try {
      const res = await apiRequest<{ success: boolean; activeRelease: AppScheduleRelease; releases: AppScheduleRelease[] }>(
        `/api/admin/app-releases/schedule/${encodeURIComponent(id)}/active`,
        { method: "POST" }
      );
      setRelease(res.activeRelease);
      setReleases(res.releases || []);
      setMessage(`已成功将历史版本 v${vName} 切换为当前在线生效版本！`);
      setMessageType("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "切换生效版本失败。");
      setMessageType("error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteRelease = async (id: string, vName: string) => {
    if (!window.confirm(`确定要删除历史版本 v${vName} 的发布记录吗？此操作不会删除网盘中的 APK 原文件。`)) return;
    setSubmitting(true);
    setMessage("");
    try {
      const res = await apiRequest<{ success: boolean; activeRelease: AppScheduleRelease | null; releases: AppScheduleRelease[] }>(
        `/api/admin/app-releases/schedule/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      setRelease(res.activeRelease || null);
      setReleases(res.releases || []);
      setMessage(`已成功删除版本 v${vName} 的发布记录。`);
      setMessageType("info");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败。");
      setMessageType("error");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrefillFrom = (target: AppScheduleRelease) => {
    setVersionName(target.versionName);
    setVersionCode(target.versionCode + 1);
    setReleaseNotes(target.releaseNotes);
    if (target.assets && target.assets.length > 0) {
      const loadedAssets: SelectedAssetItem[] = target.assets.map((a, idx) => ({
        driveFileId: a.driveFileId || 0,
        fileName: a.fileName,
        byteSize: a.byteSize,
        downloadUrl: a.downloadUrl,
        abi: a.abi,
        isPrimary: idx === 0 || a.downloadUrl === target.downloadUrl,
      }));
      setSelectedAssets(loadedAssets);
    } else if (target.driveFileId) {
      setSelectedAssets([
        {
          driveFileId: target.driveFileId,
          fileName: target.fileName,
          byteSize: target.byteSize,
          downloadUrl: target.downloadUrl,
          abi: detectAbiFromName(target.fileName),
          isPrimary: true,
        },
      ]);
    } else {
      setAllowCustomFallback(true);
      setCustomDownloadUrl(target.downloadUrl);
      setCustomFileName(target.fileName);
      setCustomFileSize(target.byteSize);
    }
    setMessage(`已载入 v${target.versionName} 的信息作为新建模板（版本代码已自动建议为 ${target.versionCode + 1}）。`);
    setMessageType("info");
    document.getElementById("publish-form-card")?.scrollIntoView({ behavior: "smooth" });
  };

  const handleResetForm = () => {
    setVersionName("");
    setVersionCode("");
    setReleaseNotes("");
    setSelectedAssets([]);
    setAllowCustomFallback(false);
    setCustomDownloadUrl("");
    setCustomFileName("");
    setCustomFileSize("");
  };

  const handleUnpublish = async () => {
    if (!window.confirm("确定要下架当前的所有课表发布吗？下架后客户端将无法通过此源获取更新。")) return;
    setSubmitting(true);
    try {
      await apiRequest<{ success: boolean }>("/api/admin/app-releases/schedule", {
        method: "DELETE",
      });
      setRelease(null);
      setReleases([]);
      setMessage("所有课表发布记录已成功清空/下架。");
      setMessageType("info");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下架失败。");
      setMessageType("error");
    } finally {
      setSubmitting(false);
    }
  };

  const publicApiUrl = `${window.location.origin}/api/app/schedule/latest`;
  const directDownloadUrl = `${window.location.origin}/api/app/schedule/download`;

  return (
    <div className="fa-page fa-drive-page">
      <div className="fa-page-heading">
        <div>
          <span className="fa-kicker">APPLICATION RELEASE</span>
          <h1>移动端应用发布 / 课表下载源</h1>
          <p>
            将网盘中打包好的课程表 APK 发布为官方高速更新源。支持多架构（Universal、ARM64、x86_64 等）同时发布，移动端客户端可自动识别手机 CPU 并高速匹配下载。
          </p>
        </div>
      </div>

      {message ? (
        <div
          className={`fa-alert fa-alert-${messageType}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            borderRadius: "8px",
            background: messageType === "error" ? "#fef2f2" : messageType === "success" ? "#ecfdf5" : "#eff6ff",
            color: messageType === "error" ? "#dc2626" : messageType === "success" ? "#059669" : "#2563eb",
            border: `1px solid ${messageType === "error" ? "#fecaca" : messageType === "success" ? "#a7f3d0" : "#bfdbfe"}`,
          }}
        >
          {messageType === "error" ? <AlertCircle size={18} /> : <Info size={18} />}
          <span style={{ fontWeight: 500, fontSize: "0.92rem" }}>{message}</span>
        </div>
      ) : null}

      {/* 当前发布状态卡片 */}
      <section className="fa-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <Rocket size={18} />
              <h2>当前运行中的下载源</h2>
              {release ? (
                <span style={{ marginLeft: "0.5rem", padding: "0.2rem 0.6rem", borderRadius: "999px", background: "#ecfdf5", color: "#059669", fontSize: "0.8rem", fontWeight: "bold" }}>
                  ● 运行中
                </span>
              ) : (
                <span style={{ marginLeft: "0.5rem", padding: "0.2rem 0.6rem", borderRadius: "999px", background: "#f1f5f9", color: "#64748b", fontSize: "0.8rem", fontWeight: "bold" }}>
                  未发布
                </span>
              )}
            </div>
            <p>客户端请求更新接口时实时返回此配置</p>
          </div>
          <button type="button" className="fa-button fa-button-ghost" onClick={() => void loadData()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "fa-spin" : ""} />
            刷新
          </button>
        </div>

        {release ? (
          <div style={{ display: "grid", gap: "1.25rem", marginTop: "0.5rem" }}>
            {/* 基本元数据展示 */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "1rem",
                padding: "1rem 1.25rem",
                background: "var(--fa-surface-sunken, #f8fafc)",
                borderRadius: "10px",
                border: "1px solid var(--fa-line, #e2e8f0)",
              }}
            >
              <div>
                <small style={{ color: "var(--fa-muted, #64748b)", display: "block", marginBottom: "0.2rem" }}>版本名称</small>
                <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "var(--fa-primary, #0891b2)" }}>
                  v{release.versionName}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-muted, #64748b)", display: "block", marginBottom: "0.2rem" }}>内部构建版本号 (code)</small>
                <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "var(--fa-text, #1e293b)" }}>
                  {release.versionCode}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-muted, #64748b)", display: "block", marginBottom: "0.2rem" }}>发布包含架构包</small>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--fa-text, #1e293b)" }}>
                  {release.assets && release.assets.length > 0 ? `${release.assets.length} 个架构安装包` : "1 个通用包"}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-muted, #64748b)", display: "block", marginBottom: "0.2rem" }}>发布生效时间</small>
                <div style={{ fontSize: "0.95rem", fontWeight: 500, color: "var(--fa-text, #1e293b)" }}>
                  {dateText(release.publishedAt)}
                </div>
              </div>
            </div>

            {/* 多架构 APK 包列表展示 */}
            {release.assets && release.assets.length > 0 ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.6rem", fontWeight: 600, fontSize: "0.95rem" }}>
                  <Layers size={16} /> 已上线的各设备架构安装包 ({release.assets.length})：
                </div>
                <div style={{ display: "grid", gap: "0.6rem" }}>
                  {release.assets.map((asset) => {
                    const badge = abiBadgeText(asset.abi);
                    const isDef = asset.downloadUrl === release.downloadUrl;
                    return (
                      <div
                        key={asset.fileName}
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "0.75rem",
                          padding: "0.75rem 1rem",
                          borderRadius: "8px",
                          background: "var(--fa-surface, #ffffff)",
                          border: `1px solid ${isDef ? "var(--fa-primary, #0891b2)" : "var(--fa-line, #e2e8f0)"}`,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0, flex: "1 1 300px" }}>
                          <span
                            style={{
                              padding: "0.25rem 0.6rem",
                              borderRadius: "6px",
                              fontSize: "0.8rem",
                              fontWeight: "bold",
                              background: badge.bg,
                              color: badge.color,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {badge.label}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: "0.9rem", wordBreak: "break-all" }}>
                              {asset.fileName} {isDef && <span style={{ color: "var(--fa-primary, #0891b2)", fontSize: "0.78rem" }}>[默认主包]</span>}
                            </div>
                            <small style={{ color: "var(--fa-muted, #64748b)" }}>{bytesText(asset.byteSize)}</small>
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                          <a
                            href={asset.downloadUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="fa-button fa-button-ghost"
                            style={{ padding: "0.35rem 0.75rem", height: "32px", fontSize: "0.82rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
                          >
                            <Download size={13} /> 下载 APK
                          </a>
                          <button
                            type="button"
                            className="fa-button fa-button-ghost"
                            style={{ padding: "0.35rem 0.6rem", height: "32px", fontSize: "0.82rem" }}
                            onClick={() => void handleCopy(asset.fileName, asset.downloadUrl)}
                          >
                            {copiedKey === asset.fileName ? <Check size={13} /> : <Copy size={13} />}
                            {copiedKey === asset.fileName ? "已复制" : "直链"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* 更新日志卡片 */}
            {release.releaseNotes ? (
              <div
                style={{
                  padding: "0.85rem 1rem",
                  background: "var(--fa-surface-sunken, #f8fafc)",
                  borderRadius: "8px",
                  border: "1px solid var(--fa-line, #e2e8f0)",
                }}
              >
                <strong style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.4rem", fontSize: "0.9rem" }}>
                  <FileText size={15} /> 版本更新说明
                </strong>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    fontSize: "0.88rem",
                    lineHeight: 1.6,
                    color: "var(--fa-text, #334155)",
                  }}
                >
                  {release.releaseNotes}
                </pre>
              </div>
            ) : null}

            {/* 接口地址展示 */}
            <div style={{ display: "grid", gap: "0.6rem" }}>
              <div className="fa-drive-link">
                <span style={{ minWidth: "120px", fontWeight: 600 }}>检查更新 API</span>
                <a href={publicApiUrl} target="_blank" rel="noreferrer">{publicApiUrl}</a>
                <button type="button" onClick={() => void handleCopy("api", publicApiUrl)}>
                  {copiedKey === "api" ? <Check size={15} /> : <Copy size={15} />}
                  {copiedKey === "api" ? "已复制" : "复制"}
                </button>
              </div>
              <div className="fa-drive-link">
                <span style={{ minWidth: "120px", fontWeight: 600 }}>自动匹配直链</span>
                <a href={directDownloadUrl} target="_blank" rel="noreferrer">{directDownloadUrl} (支持 ?abi= 架构筛选)</a>
                <button type="button" onClick={() => void handleCopy("download", directDownloadUrl)}>
                  {copiedKey === "download" ? <Check size={15} /> : <Copy size={15} />}
                  {copiedKey === "download" ? "已复制" : "复制"}
                </button>
              </div>
            </div>

            {/* 下架按钮 */}
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.25rem" }}>
              <button
                type="button"
                className="fa-button"
                style={{
                  background: "#fee2e2",
                  color: "#dc2626",
                  border: "1px solid #fca5a5",
                  borderRadius: "8px",
                  padding: "0.5rem 1rem",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  cursor: "pointer",
                }}
                onClick={() => void handleUnpublish()}
                disabled={submitting}
              >
                <Trash2 size={16} /> 下架此版本
              </button>
            </div>
          </div>
        ) : (
          <div className="fa-empty" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
            <Smartphone size={36} style={{ opacity: 0.3, margin: "0 auto 0.5rem" }} />
            <div style={{ fontWeight: 600, fontSize: "1rem" }}>尚未发布任何课表应用下载源</div>
            <small style={{ color: "var(--fa-muted, #64748b)" }}>
              请在下方表单中选择网盘中的 APK 安装包文件并填写版本信息。
            </small>
          </div>
        )}
      </section>

      {/* 历史版本发布记录面板 */}
      <section className="fa-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <History size={18} />
              <h2>版本发布历史记录 ({releases.length})</h2>
            </div>
            <p>保存全部历史发布记录，支持随时查看历史版本下载直链、架构包与更新说明，或一键回滚生效</p>
          </div>
          <button
            type="button"
            className="fa-button fa-button-ghost"
            onClick={() => {
              handleResetForm();
              document.getElementById("publish-form-card")?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <PlusCircle size={15} />
            发布全新版本
          </button>
        </div>

        {releases.length > 0 ? (
          <div style={{ display: "grid", gap: "1rem" }}>
            {releases.map((item) => {
              const isItemActive = item.isActive || (release && release.id === item.id);
              const isExpanded = expandedReleaseId === item.id;
              const assetCount = item.assets && item.assets.length > 0 ? item.assets.length : 1;

              return (
                <div
                  key={item.id}
                  style={{
                    borderRadius: "10px",
                    border: `1.5px solid ${isItemActive ? "var(--fa-primary, #0891b2)" : "var(--fa-line, #e2e8f0)"}`,
                    background: isItemActive ? "var(--fa-surface, #ffffff)" : "var(--fa-surface-sunken, #f8fafc)",
                    overflow: "hidden",
                    transition: "all 0.2s ease",
                  }}
                >
                  {/* 版本卡片头部 */}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.75rem",
                      padding: "0.9rem 1.15rem",
                      background: isItemActive ? "rgba(8, 145, 178, 0.04)" : "transparent",
                      borderBottom: isExpanded ? "1px solid var(--fa-line, #e2e8f0)" : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.85rem", minWidth: 0, flex: "1 1 320px" }}>
                      <span
                        style={{
                          fontSize: "1.15rem",
                          fontWeight: "bold",
                          color: isItemActive ? "var(--fa-primary, #0891b2)" : "var(--fa-text, #1e293b)",
                        }}
                      >
                        v{item.versionName}
                      </span>

                      <span
                        style={{
                          fontSize: "0.82rem",
                          fontWeight: 600,
                          color: "var(--fa-muted, #64748b)",
                          background: "var(--fa-surface, #ffffff)",
                          padding: "0.15rem 0.5rem",
                          borderRadius: "6px",
                          border: "1px solid var(--fa-line, #e2e8f0)",
                        }}
                      >
                        Code: {item.versionCode}
                      </span>

                      {isItemActive ? (
                        <span
                          style={{
                            padding: "0.2rem 0.6rem",
                            borderRadius: "999px",
                            background: "#ecfdf5",
                            color: "#059669",
                            fontSize: "0.8rem",
                            fontWeight: "bold",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                          }}
                        >
                          ● 当前在线生效中
                        </span>
                      ) : (
                        <span
                          style={{
                            padding: "0.2rem 0.6rem",
                            borderRadius: "999px",
                            background: "#f1f5f9",
                            color: "#64748b",
                            fontSize: "0.8rem",
                            fontWeight: 500,
                          }}
                        >
                          历史版本
                        </span>
                      )}

                      <span style={{ fontSize: "0.82rem", color: "var(--fa-muted, #64748b)" }}>
                        {dateText(item.publishedAt)} · {assetCount} 个架构安装包
                      </span>
                    </div>

                    {/* 操作按钮区 */}
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      {!isItemActive ? (
                        <button
                          type="button"
                          className="fa-button"
                          style={{
                            padding: "0.35rem 0.75rem",
                            height: "32px",
                            fontSize: "0.82rem",
                            fontWeight: 600,
                            borderRadius: "6px",
                            border: "1px solid #059669",
                            background: "#ecfdf5",
                            color: "#059669",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                          }}
                          disabled={submitting}
                          onClick={() => void handleActivateRelease(item.id, item.versionName)}
                          title="将此历史版本设为当前在线生效版本，客户端更新将立即指向此版本"
                        >
                          <RotateCcw size={13} />
                          设为当前生效
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="fa-button fa-button-ghost"
                        style={{
                          padding: "0.35rem 0.75rem",
                          height: "32px",
                          fontSize: "0.82rem",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.3rem",
                        }}
                        onClick={() => handlePrefillFrom(item)}
                        title="以此版本信息为模板填入下方新建表单"
                      >
                        以此为模板新建
                      </button>

                      <button
                        type="button"
                        className="fa-button fa-button-ghost"
                        style={{
                          padding: "0.35rem 0.65rem",
                          height: "32px",
                          fontSize: "0.82rem",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.2rem",
                        }}
                        onClick={() => setExpandedReleaseId(isExpanded ? null : item.id)}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {isExpanded ? "收起详情" : "查看详情"}
                      </button>

                      <button
                        type="button"
                        className="fa-button fa-button-ghost"
                        style={{
                          padding: "0.35rem 0.5rem",
                          height: "32px",
                          color: "#dc2626",
                        }}
                        disabled={submitting}
                        onClick={() => void handleDeleteRelease(item.id, item.versionName)}
                        title="删除该条发布记录"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {/* 展开的详情部分 */}
                  {isExpanded ? (
                    <div style={{ padding: "1rem 1.15rem", display: "grid", gap: "0.85rem", background: "var(--fa-surface, #ffffff)" }}>
                      {/* 更新说明 */}
                      {item.releaseNotes ? (
                        <div
                          style={{
                            padding: "0.75rem 0.9rem",
                            borderRadius: "6px",
                            background: "var(--fa-surface-sunken, #f8fafc)",
                            border: "1px solid var(--fa-line, #e2e8f0)",
                          }}
                        >
                          <strong style={{ fontSize: "0.85rem", display: "block", marginBottom: "0.3rem", color: "var(--fa-muted, #64748b)" }}>
                            更新日志与说明：
                          </strong>
                          <pre
                            style={{
                              margin: 0,
                              whiteSpace: "pre-wrap",
                              fontFamily: "inherit",
                              fontSize: "0.85rem",
                              lineHeight: 1.5,
                              color: "var(--fa-text, #334155)",
                            }}
                          >
                            {item.releaseNotes}
                          </pre>
                        </div>
                      ) : null}

                      {/* 包含的架构包 */}
                      <div>
                        <div style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--fa-muted, #64748b)", marginBottom: "0.4rem" }}>
                          包含的 APK 安装包文件：
                        </div>
                        <div style={{ display: "grid", gap: "0.4rem" }}>
                          {(item.assets && item.assets.length > 0
                            ? item.assets
                            : [
                                {
                                  abi: "universal",
                                  fileName: item.fileName,
                                  downloadUrl: item.downloadUrl,
                                  byteSize: item.byteSize,
                                },
                              ]
                          ).map((asset) => {
                            const badge = abiBadgeText(asset.abi);
                            const isDef = asset.downloadUrl === item.downloadUrl;
                            const copyKey = `${item.id}_${asset.fileName}`;
                            return (
                              <div
                                key={asset.fileName}
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "0.5rem",
                                  padding: "0.5rem 0.75rem",
                                  borderRadius: "6px",
                                  background: "var(--fa-surface-sunken, #f8fafc)",
                                  border: "1px solid var(--fa-line, #e2e8f0)",
                                  fontSize: "0.85rem",
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}>
                                  <span
                                    style={{
                                      padding: "0.15rem 0.45rem",
                                      borderRadius: "4px",
                                      fontSize: "0.75rem",
                                      fontWeight: "bold",
                                      background: badge.bg,
                                      color: badge.color,
                                    }}
                                  >
                                    {badge.label}
                                  </span>
                                  <span style={{ fontWeight: 600, wordBreak: "break-all" }}>
                                    {asset.fileName} {isDef ? <span style={{ color: "var(--fa-primary, #0891b2)", fontSize: "0.75rem" }}>[默认包]</span> : null}
                                  </span>
                                  <small style={{ color: "var(--fa-muted, #64748b)" }}>{bytesText(asset.byteSize)}</small>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                  <a
                                    href={asset.downloadUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="fa-button fa-button-ghost"
                                    style={{ padding: "0.2rem 0.5rem", height: "26px", fontSize: "0.78rem", display: "inline-flex", alignItems: "center", gap: "0.2rem" }}
                                  >
                                    <Download size={12} /> 下载
                                  </a>
                                  <button
                                    type="button"
                                    className="fa-button fa-button-ghost"
                                    style={{ padding: "0.2rem 0.5rem", height: "26px", fontSize: "0.78rem" }}
                                    onClick={() => void handleCopy(copyKey, asset.downloadUrl)}
                                  >
                                    {copiedKey === copyKey ? <Check size={12} /> : <Copy size={12} />}
                                    {copiedKey === copyKey ? "已复制" : "复制直链"}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="fa-empty" style={{ padding: "2rem 1rem", textAlign: "center" }}>
            <History size={32} style={{ opacity: 0.3, margin: "0 auto 0.5rem" }} />
            <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>暂无发布历史记录</div>
            <small style={{ color: "var(--fa-muted, #64748b)" }}>在下方发布新版本后，将自动在这里归档记录。</small>
          </div>
        )}
      </section>

      {/* 发布与配置表单 */}
      <section className="fa-panel" id="publish-form-card">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title">
              <HardDrive size={18} />
              <h2>发布新版本下载源（新建并归档至历史记录）</h2>
            </div>
            <p>从网盘选择一个或多个 APK（支持多 CPU 架构分发），配置版本与更新日志。每次发布将在系统中新建一条独立的版本发布记录，历史版本均可随时查阅并一键回滚。</p>
          </div>
          <button
            type="button"
            className="fa-button fa-button-ghost"
            onClick={handleResetForm}
            title="清空当前表单输入内容"
          >
            <PlusCircle size={15} />
            清空表单（新建空白发布）
          </button>
        </div>

        <form onSubmit={(e) => void handlePublish(e)} style={{ display: "grid", gap: "1.5rem" }}>
          {/* 选择网盘 APK 资产（多选支持） */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
              <label style={{ fontWeight: "700", fontSize: "0.95rem", color: "var(--fa-text, #1e293b)" }}>
                选择网盘中的 APK 安装包文件 (支持多选不同架构包) <span style={{ color: "#ef4444" }}>*</span>
              </label>
              {candidateFiles.length > 0 ? (
                <button
                  type="button"
                  onClick={selectAllApks}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--fa-primary, #0891b2)",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontWeight: 600,
                  }}
                >
                  {candidateFiles.every((f) => selectedAssets.some((a) => a.driveFileId === f.id)) ? (
                    <><CheckSquare size={16} /> 取消全选</>
                  ) : (
                    <><Square size={16} /> 全选候选 APK</>
                  )}
                </button>
              ) : null}
            </div>

            {candidateFiles.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gap: "0.6rem",
                  padding: "0.75rem",
                  background: "var(--fa-surface-sunken, #f8fafc)",
                  borderRadius: "10px",
                  border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                  maxHeight: "320px",
                  overflowY: "auto",
                }}
              >
                {candidateFiles.map((file) => {
                  const isChecked = selectedAssets.some((a) => a.driveFileId === file.id);
                  const selectedItem = selectedAssets.find((a) => a.driveFileId === file.id);
                  const currentAbi = selectedItem ? selectedItem.abi : detectAbiFromName(file.name);
                  const badge = abiBadgeText(currentAbi);

                  return (
                    <div
                      key={file.id}
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0.6rem 0.85rem",
                        borderRadius: "8px",
                        background: isChecked ? "#f0fdf4" : "var(--fa-surface, #ffffff)",
                        border: `1.5px solid ${isChecked ? "#86efac" : "var(--fa-line, #e2e8f0)"}`,
                        transition: "all 0.15s ease",
                        cursor: "pointer",
                      }}
                      onClick={() => toggleSelectApk(file)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0, flex: "1 1 260px" }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}} // 由外层 onClick 驱动
                          style={{
                            width: "18px",
                            height: "18px",
                            cursor: "pointer",
                            accentColor: "var(--fa-primary, #0891b2)",
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: "0.92rem", wordBreak: "break-all", color: "var(--fa-text, #1e293b)" }}>
                            {file.name}
                          </div>
                          <small style={{ color: "var(--fa-muted, #64748b)" }}>
                            {bytesText(file.byteSize)} · 上传于 {dateText(file.createdAt)}
                          </small>
                        </div>
                      </div>

                      {/* 选定后配置其架构与主包属性 */}
                      {isChecked ? (
                        <div
                          style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.82rem", fontWeight: 500 }}>
                            架构:
                            <select
                              value={currentAbi}
                              onChange={(e) => updateAssetAbi(file.id, e.target.value)}
                              style={{
                                padding: "0.25rem 0.5rem",
                                borderRadius: "6px",
                                border: "1.5px solid #cbd5e1",
                                background: "#ffffff",
                                fontSize: "0.82rem",
                                fontWeight: "bold",
                                color: "#0f172a",
                              }}
                            >
                              <option value="universal">Universal (全架构通用)</option>
                              <option value="arm64-v8a">ARM64-v8a (主流手机)</option>
                              <option value="armeabi-v7a">ARMeabi-v7a (32位老机)</option>
                              <option value="x86_64">x86_64 (PC模拟器)</option>
                              <option value="other">其它架构</option>
                            </select>
                          </label>

                          <button
                            type="button"
                            onClick={() => setPrimaryAsset(file.id)}
                            style={{
                              padding: "0.25rem 0.6rem",
                              borderRadius: "6px",
                              fontSize: "0.8rem",
                              fontWeight: "bold",
                              border: selectedItem?.isPrimary ? "1.5px solid #059669" : "1.5px solid #cbd5e1",
                              background: selectedItem?.isPrimary ? "#059669" : "#ffffff",
                              color: selectedItem?.isPrimary ? "#ffffff" : "#475569",
                              cursor: "pointer",
                            }}
                          >
                            {selectedItem?.isPrimary ? "✓ 默认主包" : "设为主包"}
                          </button>
                        </div>
                      ) : (
                        <span
                          style={{
                            padding: "0.2rem 0.5rem",
                            borderRadius: "6px",
                            fontSize: "0.78rem",
                            fontWeight: 600,
                            background: badge.bg,
                            color: badge.color,
                          }}
                        >
                          建议: {badge.label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                style={{
                  padding: "1.5rem",
                  background: "var(--fa-surface-sunken, #f8fafc)",
                  borderRadius: "8px",
                  border: "1.5px dashed var(--fa-line-strong, #cbd5e1)",
                  textAlign: "center",
                }}
              >
                <div style={{ color: "var(--fa-muted, #64748b)", fontSize: "0.92rem", marginBottom: "0.5rem" }}>
                  网盘中暂未检测到以 <code>.apk</code> 结尾的文件。
                </div>
                <small style={{ color: "var(--fa-soft, #94a3b8)" }}>
                  请先前往左侧导航栏的“文件网盘”上传打包好的 APK 安装包。
                </small>
              </div>
            )}

            <div style={{ marginTop: "0.4rem", display: "flex", justifyContent: "space-between" }}>
              <small style={{ color: "var(--fa-muted, #64748b)" }}>
                已勾选 <strong>{selectedAssets.length}</strong> 个安装包作为本次发布的下载资产。
              </small>
              <button
                type="button"
                onClick={() => setAllowCustomFallback(!allowCustomFallback)}
                style={{ background: "none", border: "none", color: "var(--fa-primary, #0891b2)", fontSize: "0.82rem", cursor: "pointer" }}
              >
                {allowCustomFallback ? "收起自定义外部外链" : "使用外部直接 URL (不经过网盘)"}
              </button>
            </div>
          </div>

          {/* 外部自定义外链 */}
          {allowCustomFallback ? (
            <div
              style={{
                display: "grid",
                gap: "0.75rem",
                padding: "1rem",
                background: "var(--fa-surface-sunken, #f8fafc)",
                borderRadius: "8px",
                border: "1.5px dashed var(--fa-line-strong, #cfdae3)",
              }}
            >
              <div>
                <label style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.88rem", fontWeight: 600 }}>
                  下载直链 URL
                </label>
                <input
                  type="url"
                  placeholder="https://example.com/mobileschedule.apk"
                  value={customDownloadUrl}
                  onChange={(e) => setCustomDownloadUrl(e.target.value)}
                  style={{
                    display: "block",
                    width: "100%",
                    minHeight: "40px",
                    padding: "0.5rem 0.85rem",
                    borderRadius: "8px",
                    border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                    background: "var(--fa-surface, #ffffff)",
                    color: "var(--fa-text, #14344b)",
                    fontSize: "0.95rem",
                  }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.88rem", fontWeight: 600 }}>
                    文件名称
                  </label>
                  <input
                    type="text"
                    placeholder="mobileschedule.apk"
                    value={customFileName}
                    onChange={(e) => setCustomFileName(e.target.value)}
                    style={{
                      display: "block",
                      width: "100%",
                      minHeight: "40px",
                      padding: "0.5rem 0.85rem",
                      borderRadius: "8px",
                      border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                      background: "var(--fa-surface, #ffffff)",
                      color: "var(--fa-text, #14344b)",
                      fontSize: "0.95rem",
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.88rem", fontWeight: 600 }}>
                    文件大小 (字节，可选)
                  </label>
                  <input
                    type="number"
                    placeholder="13474302"
                    value={customFileSize}
                    onChange={(e) => setCustomFileSize(e.target.value ? parseInt(e.target.value, 10) : "")}
                    style={{
                      display: "block",
                      width: "100%",
                      minHeight: "40px",
                      padding: "0.5rem 0.85rem",
                      borderRadius: "8px",
                      border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                      background: "var(--fa-surface, #ffffff)",
                      color: "var(--fa-text, #14344b)",
                      fontSize: "0.95rem",
                    }}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* 版本信息输入区域（明确边框与文本框外观） */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1.25rem" }}>
            <div>
              <label style={{ display: "block", marginBottom: "0.45rem", fontWeight: "700", fontSize: "0.95rem", color: "var(--fa-text, #1e293b)" }}>
                版本名称 (Version Name) <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="text"
                placeholder="例如 1.1.0"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                required
                style={{
                  display: "block",
                  width: "100%",
                  minHeight: "42px",
                  padding: "0.55rem 0.9rem",
                  borderRadius: "8px",
                  border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                  background: "var(--fa-surface, #ffffff)",
                  color: "var(--fa-text, #14344b)",
                  fontSize: "0.95rem",
                  fontWeight: "500",
                }}
              />
              <small style={{ display: "block", marginTop: "0.3rem", color: "var(--fa-muted, #64748b)" }}>
                展示给用户的版本名，如 1.0.0、1.1.0
              </small>
            </div>

            <div>
              <label style={{ display: "block", marginBottom: "0.45rem", fontWeight: "700", fontSize: "0.95rem", color: "var(--fa-text, #1e293b)" }}>
                版本代码 (Version Code) <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="number"
                min="1"
                placeholder="例如 5"
                value={versionCode}
                onChange={(e) => setVersionCode(e.target.value ? parseInt(e.target.value, 10) : "")}
                required
                style={{
                  display: "block",
                  width: "100%",
                  minHeight: "42px",
                  padding: "0.55rem 0.9rem",
                  borderRadius: "8px",
                  border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                  background: "var(--fa-surface, #ffffff)",
                  color: "var(--fa-text, #14344b)",
                  fontSize: "0.95rem",
                  fontWeight: "500",
                }}
              />
              <small style={{ display: "block", marginTop: "0.3rem", color: "var(--fa-muted, #64748b)" }}>
                Android 应用内部版本递增整数，如 4、5
              </small>
            </div>
          </div>

          {/* 更新日志 */}
          <div>
            <label style={{ display: "block", marginBottom: "0.45rem", fontWeight: "700", fontSize: "0.95rem", color: "var(--fa-text, #1e293b)" }}>
              更新日志与说明 (Release Notes)
            </label>
            <textarea
              rows={6}
              placeholder="在此输入新版本功能说明与修复内容，支持多行，如：&#10;1. 优化界面显示效果，增加现代化莫兰迪主题色&#10;2. 增加周课表切周平滑过渡动画&#10;3. 支持在线更新与多下载镜像源加速&#10;4. 支持针对设备 CPU 架构自动匹配下载"
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              style={{
                display: "block",
                width: "100%",
                padding: "0.75rem 0.9rem",
                borderRadius: "8px",
                border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                background: "var(--fa-surface, #ffffff)",
                color: "var(--fa-text, #14344b)",
                fontSize: "0.92rem",
                fontFamily: "inherit",
                lineHeight: 1.6,
                resize: "vertical",
              }}
            />
          </div>

          {/* 操作按钮 */}
          <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}>
            <button
              type="submit"
              className="fa-button"
              disabled={submitting}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.6rem 1.4rem",
                height: "42px",
                borderRadius: "8px",
                border: "none",
                background: "var(--fa-primary, #0891b2)",
                color: "#ffffff",
                fontWeight: "bold",
                fontSize: "0.95rem",
                cursor: "pointer",
                boxShadow: "0 2px 4px rgba(8, 145, 178, 0.2)",
              }}
            >
              {submitting ? <RefreshCw size={16} className="fa-spin" /> : <Rocket size={16} />}
              {submitting ? "正在发布并归档..." : "新建并发布为当前版本"}
            </button>

            <button
              type="button"
              className="fa-button"
              style={{
                padding: "0.6rem 1.25rem",
                height: "42px",
                borderRadius: "8px",
                border: "1.5px solid var(--fa-line-strong, #cfdae3)",
                background: "var(--fa-surface, #ffffff)",
                color: "var(--fa-text, #14344b)",
                fontWeight: 600,
                fontSize: "0.95rem",
                cursor: "pointer",
              }}
              onClick={handleResetForm}
            >
              清空表单（新建空白）
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
