# GitHub 下载加速（GitHub Accelerator）

## 1. 为什么这样分层

本站部署在低带宽服务器上，而 GitHub 的 Release 安装包动辄几十到几百 MB。任何"主站转发字节流"的做法都会立刻打满带宽。因此把功能拆成两半：

```
浏览器 /tools/github
   │  ① 解析链接、列 Release（几 KB JSON）
   ▼
主站 API（低带宽）  apps/api   /api/tools/github/*
   │  ② 用共享密钥签发 HMAC ticket
   │  ③ 302 重定向到加速节点（只有响应头）
   ▼
加速节点（高带宽，独立服务器）  packages/github-accel
   │  ④ 透传 Range、原样流式转发
   ▼
github.com → objects.githubusercontent.com
```

主站只承担三类工作：URL 解析（纯本地，不联网）、Release 元数据代理（JSON，KB 级）、302 跳转（几十字节）。**文件字节从不经过主站。**

## 2. ticket 格式（两端唯一必须严格一致的东西）

```text
ticket = base64url(JSON) + "." + hmacHex(16 字节)
JSON   = { "u": string, "e": number, "k": "file" | "git" }
```

- `u`：目标。`k=file` 时是完整 https URL；`k=git` 时是仓库路径，形如 `/owner/repo.git`。
- `e`：过期时间，Unix 秒。
- HMAC-SHA256 的 message 就是 base64url(JSON) 这段字符串本身；密钥为 `ACCEL_SECRET`（两端相同，至少 32 字符）。
- 校验失败返回 `401`，响应体 `{ "error": "...", "code": "TICKET_INVALID" | "TICKET_EXPIRED" }`。
- 主站与节点都用 `base64url` 无填充（`Buffer.toString("base64url")`）。
- JSON 字段顺序固定为 `u`、`e`、`k`，否则同一密文签名不同。

**固定测试向量**（两端单测都必须断言；任何一端改了算法都会在这里失败）：

```text
secret  = test-secret-0123456789abcdef0123456789
u       = https://github.com/o/r/releases/download/v1/a.zip
e       = 1800000000
k       = file
payload = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0
ticket  = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0.1fdb9326cecbc1dae9177cd18b229837

u       = /o/r.git
k       = git
payload = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0
ticket  = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0.e3b1ec8cf96bc251c12bcf34aa369b7c
```

签名取 HMAC-SHA256 十六进制的前 32 个字符（16 字节）。`payload` 就是签名 message 本身。

## 3. 加速节点接口

公共前缀 `ACCEL_BASE_URL`，例如 `https://gh.example.com`。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/health` | `{ "ok": true, "version": string, "publicAllowed": boolean }`，无鉴权，无缓存 |
| `GET /api/releases/:owner/:repo` | Release 列表，服务端调 `api.github.com`，内存缓存 10 分钟 |
| `GET /download/<ticket>` | 签名下载，返回 `Content-Disposition: attachment` |
| `GET /download?url=<encoded>` | 公开下载（`ACCEL_ALLOW_PUBLIC=true` 时），同样限流 |
| `HEAD /download`、`HEAD /download/<ticket>` | 只回头部，用于预检文件名与大小 |
| `GET /git/:owner/:repo.git/info/refs?service=git-upload-pack` | git smart HTTP 广告 |
| `POST /git/:owner/:repo.git/git-upload-pack` | git 拉取流（原样管道转发） |
| `GET /git/<ticket>/:owner/:repo.git/...` | 同上，但走签名路径 |

**只允许 `https` 且 host 属于白名单**：`github.com`、`api.github.com`、`codeload.github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`。其余一律 400 `HOST_NOT_ALLOWED`。

公开下载路径按 IP 限流：`ACCEL_RATE_PER_MINUTE`（默认 30）、`ACCEL_CONCURRENCY_PER_IP`（默认 3）；全局并发 `ACCEL_MAX_CONCURRENCY`（默认 64）。超限返回 `429`（带 `Retry-After`）或 `503`。

## 4. 主站接口（apps/api）

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/tools/github/config` | `{ enabled, configured, online, acceleratorBase, publicAllowed, ticketTtlMinutes }` |
| `POST /api/tools/github/resolve` | body `{ input }`，纯本地解析，见第 5 节 |
| `GET /api/tools/github/releases?owner=&repo=` | 代理节点 `/api/releases/...`，加 60 秒内存缓存 |
| `POST /api/tools/github/download` | body `{ url }` → `{ downloadPath, fileName, expiresAt }` |
| `GET /api/tools/github/dl/:ticket` | 校验 ticket 后 `302` 到 `<ACCEL_BASE_URL>/download/<ticket>` |
| `POST /api/tools/github/clone` | body `{ owner, repo }` → `{ cloneUrl, command, insteadOf }` |

功能开关 `githubAccelEnabled` 控制整页可用性；`GITHUB_ACCEL_BASE_URL` 为空时 `configured=false`，页面显示"加速节点未配置"，不报错。

```text
GITHUB_ACCEL_BASE_URL=https://gh.example.com
GITHUB_ACCEL_SECRET=<与 ACCEL_SECRET 相同>
GITHUB_ACCEL_TIMEOUT_MS=8000
GITHUB_ACCEL_TICKET_TTL_MINUTES=30
```

## 5. 输入解析规则（resolve）

接受下列写法（大小写不敏感，忽略查询串与 `#fragment`）：

```text
owner/repo
https://github.com/owner/repo
https://github.com/owner/repo.git
git@github.com:owner/repo.git
https://github.com/owner/repo/releases/tag/v1.2.3
https://github.com/owner/repo/releases/download/v1.2.3/app.zip
https://github.com/owner/repo/archive/refs/heads/main.zip
https://github.com/owner/repo/archive/refs/tags/v1.2.3.tar.gz
https://raw.githubusercontent.com/owner/repo/main/docs/a.md
https://codeload.github.com/owner/repo/zip/refs/heads/main
```

返回 `{ resolved }`，类型为：

```ts
type GithubResolved =
  | { kind: "repo"; owner: string; repo: string; repoUrl: string }
  | { kind: "release"; owner: string; repo: string; tag: string; repoUrl: string }
  | { kind: "file"; owner: string; repo: string; fileName: string; url: string;
      origin: "release" | "archive" | "raw"; tag?: string; ref?: string }
  | { kind: "invalid"; error: string };
```

约束：owner/repo 只允许 `[A-Za-z0-9._-]`，长度上限 100；`fileName` 取 URL 最后一段并 `decodeURIComponent`；无法识别时 `kind: "invalid"` 并给出中文原因。

## 6. 缓存（加速节点）

- key = `sha256(目标 URL)`，文件 `<key>.bin` + `<key>.json`（`{ fileName, contentType, etag, lastModified, size, storedAt }`）。
- 只有拿到完整 200 响应（有 `Content-Length` 且与实际写入一致）才落盘，先写 `.part` 再 rename；中断则不保留。
- 命中时直接按 Range 提供切片，支持 `206` / `Content-Range` / `If-Range`。
- `ACCEL_CACHE_MAX_BYTES` 超出时按最后访问时间淘汰；`ACCEL_CACHE_TTL_HOURS` 到期删除。
- `ACCEL_CACHE_DIR` 为空表示不缓存，纯流式。

## 7. 上游请求的关键细节

- 用 `node:https` 的 `request()` + `pipe()`，**不要用 fetch**：fetch 会解压 `Content-Encoding` 并丢失原始 `Content-Length`，破坏 git 二进制流与断点续传。
- 手动跟随 3xx，最多 5 跳，每跳重新校验白名单。
- 转发前剔除 hop-by-hop 头：`connection`、`keep-alive`、`transfer-encoding`、`upgrade`、`proxy-*`、`te`、`trailer`。
- `Range` / `If-Range` / `If-Modified-Since` 透传给上游；`206`、`Content-Range`、`Accept-Ranges` 透传给客户端。
- 不转发客户端的 `Cookie` / `Authorization`；`api.github.com` 的 token 由节点用 `ACCEL_GITHUB_TOKEN` 注入。
- `User-Agent`：下载用本服务标识 + 原始 UA 的末尾；git 路径保留客户端 UA（GitHub 依赖 UA 判断 git 客户端）。

## 8. 部署（另一台服务器）

见 `packages/github-accel/README.md`。要点：

- Docker Compose 或 systemd 二选一，监听内网端口，公网由 Nginx/Caddy 终止 TLS。
- **Nginx 必须关闭缓冲**，否则等于把节点磁盘当瓶颈：
  ```nginx
  proxy_buffering off;
  proxy_request_buffering off;
  client_max_body_size 0;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  gzip off;
  ```
- 节点所在机器需要能顺畅访问 GitHub（境外或线路良好的机房最理想）。
- `ACCEL_SECRET` 与主站 `GITHUB_ACCEL_SECRET` 必须相同；两个服务部署在不同机器时通过 `.env` 传递，不写进仓库。

### 8.1 主站侧只需要两个必填变量

低带宽机器上**不安装、不运行**加速节点，只加环境变量然后重启 API：

```bash
# 另一台高带宽服务器上的节点地址（HTTPS，由那台机器的 Nginx 终止 TLS）
GITHUB_ACCEL_BASE_URL=https://gh.example.com
# 必须与节点 ACCEL_SECRET 逐字节相同，至少 32 字符
GITHUB_ACCEL_SECRET=<openssl rand -hex 32 的输出>
# 可选：请求节点（健康检查、Release 列表）的超时，默认 8000ms
GITHUB_ACCEL_TIMEOUT_MS=8000
# 可选：下载 / 克隆 ticket 有效期，默认 30 分钟
GITHUB_ACCEL_TICKET_TTL_MINUTES=30
```

四个变量都在 `apps/api/src/config.ts:99-106` 读取，`.env.example` 末尾有对应的注释段。`BASE_URL` 留空时页面显示"加速节点未配置"、接口返回 503 中文错误，不会 500，因此可以先发版再配节点。

### 8.2 本地联调

仓库根新增了四个脚本，加速节点不在默认的 `dev`/`build` 里（它通常不跟主站部署在一起）：

```bash
pnpm accel:dev     # tsx watch 启动节点，读本身的环境变量
pnpm accel:build   # tsc 编译到 packages/github-accel/dist
pnpm accel:start   # 跑编译产物
pnpm test:github   # 主站 ticket 单测 + 节点全部单测
```

两台"机器"可以先用两个本地端口模拟：

```bash
ACCEL_PORT=43110 ACCEL_HOST=127.0.0.1 ACCEL_SECRET=<32+ 字符> \
ACCEL_ALLOW_PUBLIC=1 ACCEL_CACHE_DIR=/tmp/accel-cache pnpm accel:dev
```

```bash
API_PORT=5180 GITHUB_ACCEL_BASE_URL=http://127.0.0.1:43110 \
GITHUB_ACCEL_SECRET=<同一个值> pnpm --filter @jayson-blog/api dev
```

然后打开 <http://localhost:5174/tools/github>（Vite 把 `/api` 代理到 5180）。页面顶部的徽标会直接显示节点是否可达。

## 9. 排错

| 现象 | 原因 |
| --- | --- |
| 页面显示"加速节点未配置" | 主站 `GITHUB_ACCEL_BASE_URL` 为空 |
| 页面显示"加速节点不可达" | 主站请求 `/api/health` 超时；检查域名、443、防火墙 |
| 下载 401 | 两端 `SECRET` 不一致，或 ticket 过期 |
| 下载 400 `HOST_NOT_ALLOWED` | 粘贴的不是 GitHub 白名单域名 |
| Release 列表 403/429 | GitHub API 限额（未配 `ACCEL_GITHUB_TOKEN` 时 60 次/小时/IP），配置只读 PAT 即可 |
| clone 卡住 | Nginx 开了 `proxy_buffering` 或 `proxy_request_buffering` |
| 断点续传失效 | 上游未透传 `Range`，或节点把 `Content-Encoding` 解掉后又声明了原长度 |

## 10. 已知边界

- 只支持公开仓库。私有仓库需要用户自带 token，本方案不做（避免把用户凭据存到服务器）。
- 不支持 `git push`（`git-receive-pack` 一律 405）。
- Cloudflare Worker 方案不在本仓库实现：大文件代理与 CF 条款冲突，自建 VPS 更可控。
