import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, HardDrive, KeyRound, RefreshCw, Search, Trash2, Upload } from "lucide-react";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
const AUTH_EXPIRED_EVENT = "site-admin-auth-expired";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

type DriveFile = {
  id: number;
  name: string;
  mimeType: string;
  byteSize: number;
  downloadCount: number;
  downloadUrl: string;
  createdAt: string;
  hasAccessPassword?: boolean;
  accessPasswordHint?: string;
};

type DriveList = {
  items: DriveFile[];
  total: number;
  maxBytes: number;
  publicOrigin: string;
};

type DriveSession = {
  uploadId: string;
  chunkSize: number;
  receivedBytes: number;
  byteSize: number;
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

async function driveRequest<T>(path: string, options: RequestInit = {}) {
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

export default function AdminDrive() {
  const [items, setItems] = useState<DriveFile[]>([]);
  const [total, setTotal] = useState(0);
  const [maxBytes, setMaxBytes] = useState(DEFAULT_MAX_BYTES);
  const [publicOrigin, setPublicOrigin] = useState("https://files.fjayson.com");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<"uploading" | "saving">("uploading");
  const [progress, setProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchCurrent, setBatchCurrent] = useState(0);
  const [batchCurrentName, setBatchCurrentName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");
  const [latestUrl, setLatestUrl] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const [uploadPassword, setUploadPassword] = useState("");
  const [uploadHint, setUploadHint] = useState("");
  const [passwordFor, setPasswordFor] = useState<number | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [hintDraft, setHintDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const payload = await driveRequest<DriveList>("/api/admin/drive");
      setItems(payload.items);
      setTotal(payload.total);
      setMaxBytes(payload.maxBytes || DEFAULT_MAX_BYTES);
      setPublicOrigin(payload.publicOrigin || "https://files.fjayson.com");
      if (!quiet) setMessage("");
    } catch (error) {
      if (!quiet) setMessage(error instanceof Error ? error.message : "文件列表加载失败。");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !uploadingRef.current) void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase();
    if (!query) return items;
    return items.filter((item) => item.name.toLocaleLowerCase().includes(query));
  }, [items, keyword]);

  const usedBytes = items.reduce((sum, item) => sum + item.byteSize, 0);
  const downloads = items.reduce((sum, item) => sum + item.downloadCount, 0);

  const markCopied = (key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? "" : current)), 1600);
  };

  const copyLink = async (key: string, url: string) => {
    try {
      await copyText(url);
      markCopied(key);
    } catch {
      setMessage("复制失败，请手动选择链接。");
    }
  };

  const reportUpload = (sent: number, total: number) => {
    if (total < 1 || sent >= total) {
      setPhase("saving");
      setProgress(99);
      setUploadedBytes(total);
      return;
    }
    setPhase("uploading");
    setUploadedBytes(sent);
    setProgress(Math.min(99, Math.round((sent / total) * 100)));
  };

  const sendChunk = (uploadId: string, body: Blob, offset: number, total: number) => new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", API_ORIGIN + "/api/admin/drive/sessions/" + uploadId);
    xhr.timeout = 0;
    const token = sessionStorage.getItem("site-admin-token");
    if (token) xhr.setRequestHeader("authorization", "Bearer " + token);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-upload-offset", String(offset));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      reportUpload(offset + event.loaded, total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        expireAdminSession();
        reject(new Error("登录状态已失效"));
        return;
      }
      let payload: { error?: string; receivedBytes?: number } | null = null;
      try { payload = JSON.parse(xhr.responseText) as { error?: string; receivedBytes?: number }; } catch { payload = null; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(payload?.error || "上传失败，请稍后重试。"));
        return;
      }
      const receivedBytes = payload?.receivedBytes;
      if (typeof receivedBytes !== "number" || !Number.isFinite(receivedBytes)) {
        reject(new Error("上传失败，请稍后重试。"));
        return;
      }
      resolve(receivedBytes);
    };
    xhr.onerror = () => reject(new Error("无法连接到内容服务。"));
    xhr.onabort = () => reject(new Error("上传已中断。"));
    xhr.send(body);
  });

  const uploadFiles = async (filesToUpload: FileList | File[] | (File | undefined)[]) => {
    const list = Array.from(filesToUpload).filter((f): f is File => Boolean(f));
    if (list.length === 0 || uploadingRef.current) return;

    for (const file of list) {
      if (file.size > maxBytes) {
        setMessage(`文件“${file.name}”大小超过单个文件限制 (${bytesText(maxBytes)})。`);
        return;
      }
    }

    const password = uploadPassword;
    const hint = uploadHint.trim();
    if (password && (password.length < 4 || password.length > 64)) {
      setMessage("访问密码需要 4 到 64 位。");
      return;
    }
    if (hint.length > 40) {
      setMessage("密码提示不能超过 40 字。");
      return;
    }
    if (hint && !password) {
      setMessage("请先设置访问密码。");
      return;
    }
    if (password && hint.includes(password)) {
      setMessage("密码提示不能包含密码。");
      return;
    }

    uploadingRef.current = true;
    setUploading(true);
    setMessage("");

    let successCount = 0;
    const newItems: DriveFile[] = [];

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setBatchCurrent(i + 1);
      setBatchTotal(list.length);
      setBatchCurrentName(file.name);
      setPhase("uploading");
      setProgress(0);
      setUploadedBytes(0);
      setUploadTotal(file.size);

      let uploadId = "";
      try {
        const session = await driveRequest<DriveSession>("/api/admin/drive/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name || "file", byteSize: file.size, mimeType: file.type || "application/octet-stream" }),
        });
        uploadId = session.uploadId;
        const chunkSize = Number.isFinite(session.chunkSize) && session.chunkSize >= 1024 * 1024 ? session.chunkSize : 8 * 1024 * 1024;
        let offset = session.receivedBytes || 0;
        while (offset < file.size) {
          const end = Math.min(file.size, offset + chunkSize);
          const received = await sendChunk(uploadId, file.slice(offset, end), offset, file.size);
          if (received <= offset) throw new Error("上传没有继续写入，请重试。");
          offset = received;
          reportUpload(offset, file.size);
        }
        setPhase("saving");
        setProgress(99);
        const saved = await driveRequest<DriveFile>("/api/admin/drive/sessions/" + uploadId + "/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(password ? { accessPassword: password, ...(hint ? { accessPasswordHint: hint } : {}) } : {}),
        });
        uploadId = "";
        successCount++;
        newItems.push(saved);
        setLatestUrl(saved.downloadUrl);
      } catch (error) {
        if (uploadId) {
          await driveRequest("/api/admin/drive/sessions/" + uploadId, { method: "DELETE" }).catch(() => undefined);
        }
        if (!(error instanceof Error) || error.message !== "登录状态已失效") {
          setMessage(`文件“${file.name}”上传失败: ${error instanceof Error ? error.message : "上传失败，请重试。"}`);
        }
        break;
      }
    }

    if (newItems.length > 0) {
      setItems((current) => [...newItems, ...current.filter((item) => !newItems.some((n) => n.id === item.id))]);
      setUploadPassword("");
      setUploadHint("");
      if (successCount === list.length && list.length > 1) {
        setMessage(`已成功批量上传 ${successCount} 个文件！`);
      }
      void load(true);
    }

    uploadingRef.current = false;
    setUploading(false);
    setPhase("uploading");
    setBatchTotal(0);
    setBatchCurrent(0);
    setBatchCurrentName("");
  };

  const uploadFile = (file: File | undefined) => {
    if (file) void uploadFiles([file]);
  };

  const savePassword = async (item: DriveFile, clear: boolean) => {
    const hint = hintDraft.trim();
    if (!clear && passwordDraft && (passwordDraft.length < 4 || passwordDraft.length > 64)) {
      setMessage("访问密码需要 4 到 64 位。");
      return;
    }
    if (!clear && hint.length > 40) {
      setMessage("密码提示不能超过 40 字。");
      return;
    }
    if (!clear && passwordDraft && hint.includes(passwordDraft)) {
      setMessage("密码提示不能包含密码。");
      return;
    }
    if (!clear && !passwordDraft && !item.hasAccessPassword) {
      setMessage(hint ? "请先设置访问密码。" : "访问密码需要 4 到 64 位。");
      return;
    }
    try {
      const saved = await driveRequest<DriveFile>("/api/admin/drive/" + item.id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(clear ? { clearAccessPassword: true } : passwordDraft ? { accessPassword: passwordDraft, accessPasswordHint: hint } : { accessPasswordHint: hint }),
      });
      setItems((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
      setPasswordDraft("");
      setHintDraft("");
      setPasswordFor(null);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "访问密码更新失败。");
    }
  };

  const remove = async (item: DriveFile) => {
    if (!window.confirm(`确认删除“${item.name}”吗？已分享的链接会立即失效。`)) return;
    try {
      await driveRequest(`/api/admin/drive/${item.id}`, { method: "DELETE" });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setTotal((current) => Math.max(0, current - 1));
      if (latestUrl === item.downloadUrl) setLatestUrl("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败。");
    }
  };

  return (
    <div className="fa-page fa-drive-page">
      <div className="fa-page-heading">
        <div>
          <span className="fa-kicker">SHARED FILES</span>
          <h1>文件网盘</h1>
          <p>上传任意文件后获得下载链接。可以给文件设置访问密码，未设置时拿到链接即可下载；设置后必须输入正确密码才能下载。单个文件不超过 2GB，下载不限速。</p>
        </div>
      </div>
      {message ? <div className="fa-error fa-page-error">{message}</div> : null}
      <section className="fa-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title"><HardDrive size={18} /><h2>上传文件</h2></div>
            <p>文件保存在服务器私有目录，对外只通过 {publicOrigin} 的链接下载。</p>
          </div>
        </div>
        <label
          className={"fa-drive-drop" + (dragging ? " is-hot" : "") + (uploading ? " is-busy" : "")}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = event.dataTransfer.files;
            if (files && files.length > 0) {
              void uploadFiles(files);
            }
          }}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={uploading}
            onChange={(event) => {
              const files = event.target.files;
              if (files && files.length > 0) {
                void uploadFiles(files);
              }
              event.target.value = "";
            }}
          />
          <span className="fa-drive-drop-icon">{uploading ? <RefreshCw size={22} className="fa-spin" /> : <Upload size={22} />}</span>
          <strong>
            {uploading
              ? (batchTotal > 1
                ? `正在上传 (${batchCurrent}/${batchTotal}): ${batchCurrentName}`
                : (phase === "saving" ? "正在保存" : "正在上传"))
              : "选择文件或拖到这里（支持多选批量上传）"}
          </strong>
          <small>任意格式，最大 {bytesText(maxBytes)}，支持批量上传</small>
        </label>
        <label className="fa-drive-password">
          访问密码（可选）
          <input type="password" value={uploadPassword} maxLength={64} autoComplete="new-password" disabled={uploading} placeholder={uploadHint.trim() || "留空则链接可直接下载，至少 4 位"} title={uploadHint.trim() || undefined} onChange={(event) => setUploadPassword(event.target.value)} />
        </label>
        <label className="fa-drive-password">
          密码提示（可选）
          <input type="text" value={uploadHint} maxLength={40} autoComplete="off" disabled={uploading} placeholder="显示在密码框中，不要写入真实密码" onChange={(event) => setUploadHint(event.target.value)} />
        </label>
        {uploading ? (
          <div className="fa-drive-progress-wrap">
            <div className={"fa-drive-progress" + (phase === "saving" ? " is-saving" : "")} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <span style={{ width: progress + "%" }} />
            </div>
            <small>
              {batchTotal > 1 ? `第 ${batchCurrent}/${batchTotal} 个文件 · ` : ""}
              {phase === "saving" ? "正在写入服务器，请稍候" : progress + "% · " + bytesText(uploadedBytes) + " / " + bytesText(uploadTotal)}
            </small>
          </div>
        ) : null}
        {latestUrl ? (
          <div className="fa-drive-link">
            <span>下载链接</span>
            <a href={latestUrl} target="_blank" rel="noreferrer">{latestUrl}</a>
            <button type="button" onClick={() => void copyLink("latest", latestUrl)}>
              {copiedKey === "latest" ? <Check size={15} /> : <Copy size={15} />}
              {copiedKey === "latest" ? "已复制" : "复制"}
            </button>
          </div>
        ) : null}
      </section>
      <section className="fa-panel">
        <div className="fa-panel-head">
          <div>
            <div className="fa-panel-title"><h2>我的文件</h2><span>{total}</span></div>
            <p>只显示当前管理员上传的文件。列表中的次数是下载开始的次数，中断后续传不会重复计数。</p>
          </div>
          <button type="button" className="fa-button fa-button-ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "fa-spin" : ""} />刷新
          </button>
        </div>
        <div className="fa-drive-summary">
          <span>文件 {total}</span>
          <span>占用 {bytesText(usedBytes)}</span>
          <span>下载 {downloads} 次</span>
        </div>
        <div className="fa-toolbar">
          <label className="fa-search">
            <Search size={15} />
            <input value={keyword} placeholder="搜索文件名" onChange={(event) => setKeyword(event.target.value)} />
          </label>
        </div>
        <div className="fa-table-wrap">
          <table className="fa-table fa-drive-table">
            <thead>
              <tr>
                <th>文件</th>
                <th>大小</th>
                <th>下载次数</th>
                <th>上传时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && !items.length ? (
                <tr><td colSpan={5}><div className="fa-table-loading"><RefreshCw size={16} className="fa-spin" />正在加载</div></td></tr>
              ) : visible.length ? visible.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="fa-drive-name">
                      <strong title={item.name}><span>{item.name}</span>{item.hasAccessPassword ? <em>需密码</em> : null}</strong>
                      <a href={item.downloadUrl} target="_blank" rel="noreferrer" title={item.downloadUrl}>{item.downloadUrl}</a>
                    </div>
                  </td>
                  <td>{bytesText(item.byteSize)}</td>
                  <td><b className="fa-drive-count">{item.downloadCount}</b></td>
                  <td>{dateText(item.createdAt)}</td>
                  <td>
                    <div className="fa-inline-actions">
                      <button type="button" title="访问密码" onClick={() => { if (passwordFor === item.id) { setPasswordFor(null); setPasswordDraft(""); setHintDraft(""); } else { setPasswordFor(item.id); setPasswordDraft(""); setHintDraft(item.accessPasswordHint ?? ""); } }}>
                        <KeyRound size={15} />
                      </button>
                      <button type="button" title="复制链接" onClick={() => void copyLink(String(item.id), item.downloadUrl)}>
                        {copiedKey === String(item.id) ? <Check size={15} /> : <Copy size={15} />}
                      </button>
                      <button type="button" title="删除" className="is-danger" onClick={() => void remove(item)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              )).flatMap((row, index) => {
                const item = visible[index];
                if (!item || passwordFor !== item.id) return [row];
                return [row, <tr key={`password-${item.id}`}>
                  <td colSpan={5}>
                    <form className="fa-drive-password-row" onSubmit={(event) => { event.preventDefault(); void savePassword(item, false); }}>
                      <input type="password" value={passwordDraft} maxLength={64} autoComplete="new-password" placeholder={hintDraft.trim() || (item.hasAccessPassword ? "输入新的访问密码" : "设置访问密码")} title={hintDraft.trim() || undefined} onChange={(event) => setPasswordDraft(event.target.value)} />
                      <input type="text" value={hintDraft} maxLength={40} autoComplete="off" placeholder="密码提示，可选" aria-label="密码提示" onChange={(event) => setHintDraft(event.target.value)} />
                      <button type="submit">保存</button>
                      {item.hasAccessPassword ? <button type="button" onClick={() => void savePassword(item, true)}>清除密码</button> : null}
                    </form>
                  </td>
                </tr>];
              }) : (
                <tr><td colSpan={5}><div className="fa-empty"><HardDrive size={22} /><span>{keyword ? "没有匹配的文件" : "还没有上传文件"}</span></div></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
