import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  Info,
  RefreshCw,
  Rocket,
  Smartphone,
  Trash2,
} from "lucide-react";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
const AUTH_EXPIRED_EVENT = "firefly-admin-auth-expired";

export type AppScheduleRelease = {
  versionName: string;
  versionCode: number;
  releaseNotes: string;
  driveFileId: number | null;
  downloadUrl: string;
  fileName: string;
  byteSize: number;
  publishedAt: string;
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
  apkFiles: DriveApkFile[];
  allDriveFiles: DriveApkFile[];
  publicOrigin: string;
};

function authHeaders() {
  const headers = new Headers();
  const token = sessionStorage.getItem("firefly-admin-token");
  if (token) headers.set("authorization", "Bearer " + token);
  return headers;
}

function expireAdminSession() {
  sessionStorage.removeItem("firefly-admin-token");
  sessionStorage.removeItem("firefly-admin-username");
  sessionStorage.setItem("firefly-admin-auth-message", "登录状态已失效，请重新输入管理员账号和密码。");
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

export default function AdminAppRelease() {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"info" | "error" | "success">("info");
  const [release, setRelease] = useState<AppScheduleRelease | null>(null);
  const [apkFiles, setApkFiles] = useState<DriveApkFile[]>([]);
  const [allFiles, setAllFiles] = useState<DriveApkFile[]>([]);
  const [publicOrigin, setPublicOrigin] = useState("https://files.fjayson.com");
  const [copiedKey, setCopiedKey] = useState("");

  // Form State
  const [selectedFileId, setSelectedFileId] = useState<string>("");
  const [versionName, setVersionName] = useState("");
  const [versionCode, setVersionCode] = useState<number | "">("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [customDownloadUrl, setCustomDownloadUrl] = useState("");
  const [customFileName, setCustomFileName] = useState("");
  const [customFileSize, setCustomFileSize] = useState<number | "">("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<ReleaseResponse>("/api/admin/app-releases/schedule");
      setRelease(data.release);
      setApkFiles(data.apkFiles || []);
      setAllFiles(data.allDriveFiles || []);
      setPublicOrigin(data.publicOrigin || "https://files.fjayson.com");
      if (data.release) {
        setVersionName(data.release.versionName);
        setVersionCode(data.release.versionCode);
        setReleaseNotes(data.release.releaseNotes);
        if (data.release.driveFileId) {
          setSelectedFileId(String(data.release.driveFileId));
        } else {
          setSelectedFileId("custom");
          setCustomDownloadUrl(data.release.downloadUrl);
          setCustomFileName(data.release.fileName);
          setCustomFileSize(data.release.byteSize);
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载发布信息失败。");
      setMessageType("error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const candidateFiles = useMemo(() => {
    if (apkFiles.length > 0) return apkFiles;
    return allFiles;
  }, [apkFiles, allFiles]);

  const handleSelectFile = (fileIdStr: string) => {
    setSelectedFileId(fileIdStr);
    if (!fileIdStr || fileIdStr === "custom") return;

    const file = candidateFiles.find((f) => String(f.id) === fileIdStr);
    if (!file) return;

    // 智能提取版本号：如 MobileSchedule-v1.0.1.apk 或 1.0.1
    const match = /(?:v)?(\d+\.\d+(?:\.\d+)?)/i.exec(file.name);
    if (match && !versionName) {
      setVersionName(match[1]);
    }
    // 智能提取纯数字版本代码：如 code4 或 10001
    const codeMatch = /code(\d+)/i.exec(file.name);
    if (codeMatch && versionCode === "") {
      setVersionCode(parseInt(codeMatch[1], 10));
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
      setMessage("请填写版本名称（如 1.0.1）。");
      setMessageType("error");
      return;
    }
    const codeNum = typeof versionCode === "number" ? versionCode : parseInt(String(versionCode), 10);
    if (Number.isNaN(codeNum) || codeNum < 1) {
      setMessage("版本号必须为大于 0 的整数。");
      setMessageType("error");
      return;
    }

    let downloadUrl = "";
    let fileName = "";
    let byteSize = 0;
    let driveFileId: number | null = null;

    if (selectedFileId && selectedFileId !== "custom") {
      const file = candidateFiles.find((f) => String(f.id) === selectedFileId);
      if (!file) {
        setMessage("所选网盘文件不存在，请重新选择。");
        setMessageType("error");
        return;
      }
      driveFileId = file.id;
      downloadUrl = file.downloadUrl;
      fileName = file.name;
      byteSize = file.byteSize;
    } else {
      if (!customDownloadUrl.trim()) {
        setMessage("请选择网盘文件或输入自定义下载直链。");
        setMessageType("error");
        return;
      }
      downloadUrl = customDownloadUrl.trim();
      fileName = customFileName.trim() || "MobileSchedule.apk";
      byteSize = typeof customFileSize === "number" ? customFileSize : 0;
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
          driveFileId,
          downloadUrl,
          fileName,
          byteSize,
        }),
      });
      setRelease(saved);
      setMessage("课表下载源发布成功！移动端现在可以通过此源检查并高速下载。");
      setMessageType("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发布失败，请稍后重试。");
      setMessageType("error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleUnpublish = async () => {
    if (!window.confirm("确定要下架当前的课表下载源吗？下架后客户端将无法通过此源获取更新。")) return;
    setSubmitting(true);
    try {
      await apiRequest<{ success: boolean }>("/api/admin/app-releases/schedule", {
        method: "DELETE",
      });
      setRelease(null);
      setMessage("下载源已成功下架。");
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
    <div className="fa-drive-page">
      <div className="fa-page-header">
        <div>
          <div className="fa-page-title-row">
            <span className="fa-page-icon"><Smartphone size={24} /></span>
            <h1>应用发布 / 课表下载源</h1>
          </div>
          <p className="fa-page-subtitle">
            将网盘中打包好的 MobileSchedule 课程表 APK 设置为官方更新下载源，客户端可直接通过本博客接口极速下载，免受外部网络影响。
          </p>
        </div>
      </div>

      {message ? (
        <div className={`fa-alert fa-alert-${messageType}`} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {messageType === "error" ? <AlertCircle size={18} /> : <Info size={18} />}
          <span>{message}</span>
        </div>
      ) : null}

      {/* 当前发布状态卡片 */}
      <section className="fa-panel">
        <div className="fa-panel-head">
          <div className="fa-panel-title">
            <Rocket size={18} />
            <h2>当前生效的下载源</h2>
            {release ? (
              <span className="fa-tag" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981", marginLeft: "0.5rem" }}>
                运行中
              </span>
            ) : (
              <span className="fa-tag" style={{ background: "rgba(100, 116, 139, 0.15)", color: "#64748b", marginLeft: "0.5rem" }}>
                未发布
              </span>
            )}
          </div>
          <button type="button" className="fa-button fa-button-ghost" onClick={() => void loadData()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "fa-spin" : ""} />
            刷新
          </button>
        </div>

        {release ? (
          <div style={{ display: "grid", gap: "1rem" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1.5rem", padding: "1rem", background: "var(--fa-surface-2, rgba(0,0,0,0.03))", borderRadius: "8px" }}>
              <div>
                <small style={{ color: "var(--fa-text-muted)" }}>版本名称</small>
                <div style={{ fontSize: "1.25rem", fontWeight: "bold", color: "var(--fa-primary)" }}>
                  v{release.versionName}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-text-muted)" }}>内部版本号 (code)</small>
                <div style={{ fontSize: "1.25rem", fontWeight: "bold" }}>
                  {release.versionCode}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-text-muted)" }}>文件大小</small>
                <div style={{ fontSize: "1.1rem" }}>
                  {bytesText(release.byteSize)}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-text-muted)" }}>发布时间</small>
                <div style={{ fontSize: "1.1rem" }}>
                  {dateText(release.publishedAt)}
                </div>
              </div>
              <div>
                <small style={{ color: "var(--fa-text-muted)" }}>文件名</small>
                <div style={{ fontSize: "1.1rem", wordBreak: "break-all" }}>
                  {release.fileName}
                </div>
              </div>
            </div>

            {release.releaseNotes ? (
              <div style={{ padding: "0.75rem 1rem", background: "var(--fa-surface-1, rgba(0,0,0,0.02))", borderRadius: "8px", border: "1px solid var(--fa-border)" }}>
                <strong style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem", fontSize: "0.9rem" }}>
                  <FileText size={15} /> 更新日志
                </strong>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "0.88rem", color: "var(--fa-text)" }}>
                  {release.releaseNotes}
                </pre>
              </div>
            ) : null}

            {/* 公开接口地址展示与复制 */}
            <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.5rem" }}>
              <div className="fa-drive-link">
                <span style={{ minWidth: "120px" }}>检查更新接口</span>
                <a href={publicApiUrl} target="_blank" rel="noreferrer">{publicApiUrl}</a>
                <button type="button" onClick={() => void handleCopy("api", publicApiUrl)}>
                  {copiedKey === "api" ? <Check size={15} /> : <Copy size={15} />}
                  {copiedKey === "api" ? "已复制" : "复制"}
                </button>
              </div>
              <div className="fa-drive-link">
                <span style={{ minWidth: "120px" }}>APK 直链跳转</span>
                <a href={directDownloadUrl} target="_blank" rel="noreferrer">{directDownloadUrl}</a>
                <button type="button" onClick={() => void handleCopy("download", directDownloadUrl)}>
                  {copiedKey === "download" ? <Check size={15} /> : <Copy size={15} />}
                  {copiedKey === "download" ? "已复制" : "复制"}
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
              <a href={release.downloadUrl} target="_blank" rel="noreferrer" className="fa-button fa-button-ghost" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                <Download size={15} /> 测试下载 APK
              </a>
              <button type="button" className="fa-button is-danger" onClick={() => void handleUnpublish()} disabled={submitting}>
                <Trash2 size={15} /> 下架此版本
              </button>
            </div>
          </div>
        ) : (
          <div className="fa-empty" style={{ padding: "2rem" }}>
            <Smartphone size={32} style={{ opacity: 0.4 }} />
            <span>尚未发布任何课表应用下载源</span>
            <small style={{ color: "var(--fa-text-muted)" }}>请在下方表单中选择网盘已有的 APK 文件并填写版本信息进行发布。</small>
          </div>
        )}
      </section>

      {/* 发布与更新表单 */}
      <section className="fa-panel">
        <div className="fa-panel-head">
          <div className="fa-panel-title">
            <HardDrive size={18} />
            <h2>{release ? "更新或重新发布下载源" : "发布新版本下载源"}</h2>
          </div>
        </div>

        <form onSubmit={(e) => void handlePublish(e)} style={{ display: "grid", gap: "1.25rem" }}>
          {/* 选择网盘文件 */}
          <div>
            <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "600" }}>
              选择网盘中的 APK 安装包文件
            </label>
            <select
              value={selectedFileId}
              onChange={(e) => handleSelectFile(e.target.value)}
              style={{
                width: "100%",
                padding: "0.6rem 0.8rem",
                borderRadius: "6px",
                border: "1px solid var(--fa-border)",
                background: "var(--fa-surface-input)",
                color: "var(--fa-text)",
              }}
            >
              <option value="">-- 请从网盘中选择上传的 APK 文件 --</option>
              {candidateFiles.map((f) => (
                <option key={f.id} value={String(f.id)}>
                  {f.name} ({bytesText(f.byteSize)}) - 上传于 {dateText(f.createdAt)}
                </option>
              ))}
              <option value="custom">-- 自定义外链 URL --</option>
            </select>
            <small style={{ display: "block", marginTop: "0.35rem", color: "var(--fa-text-muted)" }}>
              提示：打包好的 APK 请先在“文件网盘”中上传，上传后即可在上方下拉菜单中直接选中。
            </small>
          </div>

          {/* 若选择自定义外部直链 */}
          {selectedFileId === "custom" ? (
            <div style={{ display: "grid", gap: "0.75rem", padding: "1rem", background: "var(--fa-surface-2, rgba(0,0,0,0.02))", borderRadius: "6px", border: "1px dashed var(--fa-border)" }}>
              <div>
                <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.88rem" }}>下载直链 URL</label>
                <input
                  type="url"
                  placeholder="https://example.com/MobileSchedule.apk"
                  value={customDownloadUrl}
                  onChange={(e) => setCustomDownloadUrl(e.target.value)}
                  style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--fa-border)" }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div>
                  <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.88rem" }}>文件名称</label>
                  <input
                    type="text"
                    placeholder="MobileSchedule.apk"
                    value={customFileName}
                    onChange={(e) => setCustomFileName(e.target.value)}
                    style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--fa-border)" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", marginBottom: "0.3rem", fontSize: "0.88rem" }}>文件大小 (Bytes，可选)</label>
                  <input
                    type="number"
                    placeholder="13293107"
                    value={customFileSize}
                    onChange={(e) => setCustomFileSize(e.target.value ? parseInt(e.target.value, 10) : "")}
                    style={{ width: "100%", padding: "0.5rem", borderRadius: "4px", border: "1px solid var(--fa-border)" }}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* 版本信息 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div>
              <label style={{ display: "block", marginBottom: "0.4rem", fontWeight: "600" }}>
                版本名称 (Version Name) <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="text"
                placeholder="例如 1.0.0"
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                required
                style={{
                  width: "100%",
                  padding: "0.6rem 0.8rem",
                  borderRadius: "6px",
                  border: "1px solid var(--fa-border)",
                  background: "var(--fa-surface-input)",
                  color: "var(--fa-text)",
                }}
              />
              <small style={{ color: "var(--fa-text-muted)" }}>显示给用户的版本号，如 1.0.0、1.0.1</small>
            </div>
            <div>
              <label style={{ display: "block", marginBottom: "0.4rem", fontWeight: "600" }}>
                版本代码 (Version Code) <span style={{ color: "#ef4444" }}>*</span>
              </label>
              <input
                type="number"
                min="1"
                placeholder="例如 4"
                value={versionCode}
                onChange={(e) => setVersionCode(e.target.value ? parseInt(e.target.value, 10) : "")}
                required
                style={{
                  width: "100%",
                  padding: "0.6rem 0.8rem",
                  borderRadius: "6px",
                  border: "1px solid var(--fa-border)",
                  background: "var(--fa-surface-input)",
                  color: "var(--fa-text)",
                }}
              />
              <small style={{ color: "var(--fa-text-muted)" }}>Android 应用内部版本递增数字，如 4、5</small>
            </div>
          </div>

          {/* 更新日志 */}
          <div>
            <label style={{ display: "block", marginBottom: "0.4rem", fontWeight: "600" }}>
              更新日志与说明 (Release Notes)
            </label>
            <textarea
              rows={5}
              placeholder="在此输入新版本功能说明与修复内容，支持多行，如：&#10;1. 优化界面显示效果，增加现代化莫兰迪主题色&#10;2. 增加周课表切周平滑过渡动画&#10;3. 支持在线更新与多下载镜像源加速"
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              style={{
                width: "100%",
                padding: "0.6rem 0.8rem",
                borderRadius: "6px",
                border: "1px solid var(--fa-border)",
                background: "var(--fa-surface-input)",
                color: "var(--fa-text)",
                fontFamily: "inherit",
                fontSize: "0.9rem",
              }}
            />
          </div>

          {/* 操作按钮 */}
          <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}>
            <button type="submit" className="fa-button fa-button-primary" disabled={submitting}>
              {submitting ? <RefreshCw size={16} className="fa-spin" /> : <Rocket size={16} />}
              {submitting ? "正在发布..." : release ? "保存并更新发布" : "确认发布生效"}
            </button>
            <button
              type="button"
              className="fa-button fa-button-ghost"
              onClick={() => {
                if (release) {
                  setVersionName(release.versionName);
                  setVersionCode(release.versionCode);
                  setReleaseNotes(release.releaseNotes);
                } else {
                  setVersionName("");
                  setVersionCode("");
                  setReleaseNotes("");
                  setSelectedFileId("");
                }
              }}
            >
              重置
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
