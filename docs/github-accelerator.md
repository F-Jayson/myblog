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
JSON   = { "u": string, "e": number, "k": "file" | "git", "t": "guest" | "member" }
```

- `u`：目标。`k=file` 时是完整 https URL；`k=git` 时是仓库路径，形如 `/owner/repo.git`。
- `e`：过期时间，Unix 秒。
- `k`：`file`（下载）或 `git`（克隆）。
- `t`：**速率档位**，`guest`（游客）或 `member`（登录用户）。档位在签发时确定并进入签名，客户端改不了——
  否则谁都能把自己伪装成会员。缺省（旧 ticket 没有 `t`）一律按 `guest` 处理。
- HMAC-SHA256 的 message 就是 base64url(JSON) 这段字符串本身；密钥为 `ACCEL_SECRET`（两端相同，至少 32 字符）。
- 校验失败返回 `401`，响应体 `{ "error": "...", "code": "TICKET_INVALID" | "TICKET_EXPIRED" }`。
- 主站与节点都用 `base64url` 无填充（`Buffer.toString("base64url")`）。
- JSON 字段顺序固定为 `u`、`e`、`k`、`t`，否则同一密文签名不同。

**固定测试向量**（两端单测都必须断言；任何一端改了算法都会在这里失败）：

```text
secret  = test-secret-0123456789abcdef0123456789
e       = 1800000000
u       = https://github.com/o/r/releases/download/v1/a.zip

k=file t=guest
payload = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Imd1ZXN0In0
ticket  = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Imd1ZXN0In0.c1f6b1ac1ab2aaac6e0a3c8e5d19f943

k=file t=member
payload = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Im1lbWJlciJ9
ticket  = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIiwidCI6Im1lbWJlciJ9.7ef37acc7057c396f905918b914e77cb

u       = /o/r.git

k=git t=guest
payload = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Imd1ZXN0In0
ticket  = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Imd1ZXN0In0.954481962b3921ce992e13fcb4343fe7

k=git t=member
payload = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Im1lbWJlciJ9
ticket  = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0IiwidCI6Im1lbWJlciJ9.9644aedea787e8ec02ba5bf8a337daff

旧 ticket（没有 t，节点仍接受，按 guest 处理）
k=file
payload = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0
ticket  = eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0.1fdb9326cecbc1dae9177cd18b229837

k=git
payload = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0
ticket  = eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0.e3b1ec8cf96bc251c12bcf34aa369b7c
```

四组带 `t` 的向量由 `apps/api/src/githubAccel.ts` 的 `assertTicketAlgorithm()` 与
`packages/github-accel/test/ticket.test.ts` 同时逐字节断言；两组"旧 ticket"用于验证滚动发布窗口的兼容性
（主站还没升级时签出的 ticket 必须仍能下载，只是按游客限速）。

签名取 HMAC-SHA256 十六进制的前 32 个字符（16 字节）。`payload` 就是签名 message 本身。

## 3. 加速节点接口

公共前缀 `ACCEL_BASE_URL`，例如 `https://gh.example.com`。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/health` | `{ ok, version, publicAllowed, guestBytesPerSecond, memberBytesPerSecond }`，无鉴权、无缓存；主站读它拿到两档速率并透传给前台 |
| `GET /api/releases/:owner/:repo` | Release 列表，服务端调 `api.github.com`，内存缓存 10 分钟 |
| `GET /download/<ticket>` | 签名下载，返回 `Content-Disposition: attachment` |
| `GET /download?url=<encoded>` | 公开下载（`ACCEL_ALLOW_PUBLIC=true` 时），同样限流 |
| `HEAD /download`、`HEAD /download/<ticket>` | 只回头部，用于预检文件名与大小 |
| `GET /git/:owner/:repo.git/info/refs?service=git-upload-pack` | git smart HTTP 广告 |
| `POST /git/:owner/:repo.git/git-upload-pack` | git 拉取流（原样管道转发） |
| `GET /git/<ticket>/:owner/:repo.git/...` | 同上，但走签名路径 |

**只允许 `https` 且 host 属于白名单**：`github.com`、`api.github.com`、`codeload.github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`。其余一律 400 `HOST_NOT_ALLOWED`。

公开下载路径按 IP 限流：`ACCEL_RATE_PER_MINUTE`（默认 30）；全局并发 `ACCEL_MAX_CONCURRENCY`（默认 64）。超限返回 `429`（带 `Retry-After`）或 `503`。

**所有错误响应都带 `cache-control: no-store`**（401/403/404/405/429/5xx 一律如此）。节点常被 CDN 顶在前面，
若一次 429 或一次过期 ticket 的 401 被边缘缓存住，接下来一段时间内所有用户都会拿到同一个错误页，
所以成功响应是否可缓存交由 CDN 决定，失败响应一律不许缓存。

### 3.1 分档限速（游客 / 登录用户）

带宽按**单个连接**限速，档位来自 ticket 的 `t`，客户端改不了：

| 档位 | 默认单连接速率 | 环境变量 | 每 IP 并发 |
| --- | --- | --- | --- |
| `guest` | 10 MiB/s（10 485 760 B/s） | `ACCEL_GUEST_BYTES_PER_SECOND` | `ACCEL_GUEST_CONCURRENCY_PER_IP`（默认 1） |
| `member` | 100 MiB/s（104 857 600 B/s） | `ACCEL_MEMBER_BYTES_PER_SECOND` | `ACCEL_CONCURRENCY_PER_IP`（默认 3） |

- 令牌桶实现在 `packages/github-accel/src/throttle.ts`：容量 `max(速率 × 0.1s, 64 KiB)`，开局满桶，之后均匀放行切片。
  桶只挂在"节点 → 客户端"方向，上游仍按满速回源，落盘也不受影响（缓存里存的永远是全速原件）。
- 四个出流点全部过桶：缓存命中（完整响应与 `Range` 切片）、不可缓存的上游直传、
  "边回传边落盘"的 `tee` 之后那一段、git pack 转发。
- 每个响应都带 `x-accel-tier` 与 `x-accel-rate`（304/416/HEAD 也带）。排查"为什么速度没变"时先看这两个头。
- 填 `0` 表示该档不限速；只有变量缺失或非法时才会回退默认值（`Number("")` 是 0，所以解析层单独处理了空串）。
- 实际峰值 ≈ 单连接速率 × 每 IP 并发数。游客档 10 MiB/s × 1 = 10 MiB/s；登录档 100 MiB/s × 3 = 300 MiB/s。
  机房带宽吃紧时先调 `ACCEL_CONCURRENCY_PER_IP` 与 `ACCEL_MAX_CONCURRENCY`，只降单连接速率会同时拖慢正常用户。
- 限速会拉长传输时间：同样 100 MB，游客档约 10 秒、登录档约 1 秒。上游连接保持更久，GitHub 中途断连的概率略升，
  但缓存只在"完整收到且长度吻合"时才 rename，不会留下脏条目，客户端用 Range 续传即可。

## 4. 主站接口（apps/api）

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/tools/github/config` | `{ enabled, configured, online, acceleratorBase, publicAllowed, ticketTtlMinutes, rates? }` |
| `POST /api/tools/github/resolve` | body `{ input }`，纯本地解析，见第 5 节 |
| `GET /api/tools/github/releases?owner=&repo=` | 代理节点 `/api/releases/...`，加 60 秒内存缓存 |
| `POST /api/tools/github/download` | body `{ url }` → `{ downloadPath, fileName, expiresAt }`；带登录态时签 `member` 档 |
| `GET /api/tools/github/dl/:ticket` | 校验 ticket 后 `302` 到 `<ACCEL_BASE_URL>/download/<ticket>` |
| `GET /api/tools/github/probe/:ticket` | 校验 ticket 后由主站 `HEAD` 一次节点，回 `{ ok, status, error?, code? }`，见 §4.2 |
| `POST /api/tools/github/clone` | body `{ owner, repo }` → `{ cloneUrl, command, insteadOf }`；带登录态时签 `member` 档 |

功能开关 `githubAccelEnabled` 控制整页可用性；`GITHUB_ACCEL_BASE_URL` 为空时 `configured=false`，页面显示"加速节点未配置"，不报错。

```text
GITHUB_ACCEL_BASE_URL=https://gh.example.com
GITHUB_ACCEL_SECRET=<与 ACCEL_SECRET 相同>
GITHUB_ACCEL_TIMEOUT_MS=8000
GITHUB_ACCEL_TICKET_TTL_MINUTES=30
```

### 4.1 档位由谁决定

- 浏览器带着自己的登录态调 `POST /api/tools/github/download` 或 `/clone`；主站用 `loadCommentUser` 认
  `Authorization: Bearer <comment session token>`。
- 认到用户 → `tier: "member"`；没带 token、token 失效、或站点关闭了登录功能 → `"guest"`（不报错，静默降级）。
  非法的 token 不会让请求失败：它跟游客走同一条路径，只是慢一些。
- 档位写进 ticket 之后主站才 302 到节点，节点只认 ticket 里的 `t`，不再回查主站。
  所以下载链接在有效期内（默认 30 分钟）复制给别人也是该档速度——这是有意的取舍：
  每条连接都回主站鉴权会让低带宽机器重新变成瓶颈。
- 前台的身份行与速率数字来自 `GET /api/tools/github/config` 的 `rates`（节点 `/api/health` 透传上来的），
  不是硬编码；节点没上报 `rates`（旧版本）时前台回退到 10 / 100 MiB/s 的默认展示。

### 4.2 下载预检（probe）

页面在触发下载前先调 `GET /api/tools/github/probe/:ticket`，由**主站**替浏览器 `HEAD` 一次节点。

为什么不让浏览器自己探：下载短链 `/api/tools/github/dl/:ticket` 会 `302` 到节点，主站与节点是不
同域名（通常还是不同机器），跨域响应读不到节点回的错误正文，浏览器只能拿到一个
`TypeError: Failed to fetch`。而 `<a download>` 一旦跳过去，节点/上游的错误会**顶掉整个工具页**，
用户既看不到原因也丢了当前输入。所以预检必须在同源（主站）这一侧做。

| 节点状态 | 主站返回 | 页面表现 |
| --- | --- | --- |
| `2xx` | `{ ok: true, status }` | 放行，触发下载 |
| `401` / `403` | `{ ok: false, code: "GITHUB_ACCEL_TICKET_REJECTED" }` | "下载被拒绝：链接无效或已过期，请重新生成。" |
| `404` | `{ ok: false, code: "GITHUB_ACCEL_NOT_FOUND" }` | "GitHub 返回 404：仓库、Release 或附件不存在…" |
| `429` | `{ ok: false, code: "GITHUB_ACCEL_RATE_LIMITED" }` | "请求过于频繁，已被限流，请稍后再试。" |
| `5xx` | `{ ok: false, code: "GITHUB_ACCEL_UPSTREAM" }` | "加速节点暂时不可用（HTTP …）" |
| 连不上 | `{ ok: false, status: 502, code: "GITHUB_ACCEL_UNREACHABLE" }` | "加速节点连不上（网络或 DNS 异常）" |
| 超时 | `{ ok: true, status: 0 }` | **放行**：节点这时可能正在向 GitHub 要文件头，真下载往往还能成 |
| ticket 本身不合法 | `401 { error, code }`（主站本地验签，不碰节点） | 页面直接把 `error` 显示出来 |

预检走 `resolve` 那一档限流（每 IP 每分钟 30 次），因为它会实打实打到节点、再由节点打上游。
预检用的是 `HEAD`：命中缓存时只回响应头，未命中时节点也只向上游发一次 `HEAD`，不传字节、不污染缓存语义。

页面侧对应 `apps/web/src/api.ts` 的 `probeGithubDownload(downloadPath)`：把路径里的 `/dl/` 换成
`/probe/` 再请求。**预检本身的任何异常（限流、断网、主站 5xx、响应不是 JSON）都返回空串 = 放行**，
绝不能让"预检坏了"变成"下载不能用了"——最终的保障仍是真下载是否成功。

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

完整步骤（两台机器逐条命令、验收清单、容量换算、运维与排错）见 [`docs/github-accelerator-deploy.md`](./github-accelerator-deploy.md)；本节只留要点：

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

### 8.1 节点侧的三个限速变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACCEL_GUEST_BYTES_PER_SECOND` | `10485760`（10 MiB/s） | 游客档单连接速率，`0` = 不限速 |
| `ACCEL_MEMBER_BYTES_PER_SECOND` | `104857600`（100 MiB/s） | 登录用户档单连接速率，`0` = 不限速 |
| `ACCEL_GUEST_CONCURRENCY_PER_IP` | `1` | 游客每 IP 并发会话数；登录用户仍用 `ACCEL_CONCURRENCY_PER_IP`（默认 3） |

节点启动日志会打印一行档位摘要，`/api/health` 也会返回这两个速率，用来确认配置真的生效了。

### 8.2 主站侧只需要两个必填变量

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

### 8.3 本地联调

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
| 速度一直是游客档 | ticket 签发时没有登录态（未登录 / token 失效 / 站点关闭了登录功能）；看响应头 `x-accel-tier` |
| 速度比设置的慢一截 | 限速是单连接速率，加上上游回源更慢时会取更慢的那个；先拉开单连接实测，或看 `x-accel-rate` 是否等于配置值 |
| 速度完全没变 | 节点还是旧版本（不认识 `t`，按 HTTP 原速转发）；`/api/health` 里没有 `guestBytesPerSecond` 就说明没升级 |
| 429 `IP_CONCURRENCY_LIMITED` 变多 | 游客档默认每 IP 只允许 1 个并发会话，这是限速的配套设计；调 `ACCEL_GUEST_CONCURRENCY_PER_IP` |

## 10. 已知边界

- 限速的颗粒度是"单连接"，不是"单用户总量"：同一个人开 3 个连接拿到的就是 3 倍带宽。
  真正的用量上限要靠 `ACCEL_CONCURRENCY_PER_IP` 与 `ACCEL_MAX_CONCURRENCY` 收口。
- 档位与站点账号体系耦合：只有走主站 `/download`、`/clone` 签发流程的链接才有会员档；
  直接把 `https://gh.example.com/download?url=...` 公开路径贴给别人，永远是游客档。
- 只支持公开仓库。私有仓库需要用户自带 token，本方案不做（避免把用户凭据存到服务器）。
- 不支持 `git push`（`git-receive-pack` 一律 405）。
- Cloudflare Worker 方案不在本仓库实现：大文件代理与 CF 条款冲突，自建 VPS 更可控。
