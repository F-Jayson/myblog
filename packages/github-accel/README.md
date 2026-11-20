# @jayson-blog/github-accel

GitHub 下载与克隆加速节点。协议契约见仓库根目录的 `docs/github-accelerator.md`（唯一真相），
本包只负责"按契约实现节点"这一侧，主站（`apps/api`）通过 `GITHUB_ACCEL_BASE_URL` 指向它。

- 零运行时依赖：只用 `node:http` / `node:https` / `node:crypto` / `node:fs` / `node:path`。
- 只做公开仓库：不支持 `git push`，不保存任何用户凭据。
- 纯流式：下载与 git pack 都是"上游 → 客户端"双向 pipe，不经内存或 Nginx 缓冲。

## 快速开始

```bash
cd packages/github-accel
pnpm install          # 已在 monorepo 里装过可跳过
pnpm type-check       # tsc 检查 src 与 test（strict）
pnpm build            # 产出 dist/
pnpm test             # node:test + tsx，89 个用例，不联网

ACCEL_SECRET=test-secret-0123456789abcdef0123456789 ACCEL_CACHE_DIR= pnpm start
curl -s http://127.0.0.1:8787/api/health
# {"ok":true,"version":"1.0.0","publicAllowed":true}
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACCEL_PORT` | `8787` | 监听端口 |
| `ACCEL_HOST` | `0.0.0.0` | 监听地址，容器内必须是 0.0.0.0 |
| `ACCEL_BASE_URL` | 空 | 节点的公网根地址，末尾斜杠会被去掉 |
| `ACCEL_SECRET` | 空 | **必须与主站 `GITHUB_ACCEL_SECRET` 相同**；为空时放行签名校验（仅限内网调试） |
| `ACCEL_ALLOW_PUBLIC` | `true` | 是否开放无 ticket 的 `/download?url=` 与公开 clone；生产建议 `false` |
| `ACCEL_CACHE_DIR` | 空 | 磁盘缓存目录；**为空表示不缓存**，纯流式 |
| `ACCEL_CACHE_MAX_BYTES` | `21474836480`（20 GiB） | 缓存总量上限，超出按最后访问时间淘汰 |
| `ACCEL_CACHE_TTL_HOURS` | `168`（7 天） | 缓存条目存活时间 |
| `ACCEL_RATE_PER_MINUTE` | `30` | 每 IP 每分钟请求数；`0` 表示不限流 |
| `ACCEL_CONCURRENCY_PER_IP` | `3` | 每 IP 同时进行的下载/git 会话数 |
| `ACCEL_MAX_CONCURRENCY` | `64` | 节点全局并发上限 |
| `ACCEL_GITHUB_TOKEN` | 空 | 只读 PAT，仅用于 `api.github.com` 的 Release 列表（未配置时限额 60 次/小时/IP） |
| `ACCEL_UPSTREAM_TIMEOUT_MS` | `30000` | 连接 GitHub 的超时；**不是**整条下载的超时 |

数字变量留空或填非法值时一律回退默认值（`Number("") === 0` 会让端口变成 0）。
启动时会对"未配置 SECRET / SECRET 过短"打印中文告警。

## 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | `{ ok, version, publicAllowed }`，主站用它判断节点是否可达 |
| `GET /api/releases/:owner/:repo` | Release 列表，10 分钟内存缓存，字段已归一化为 camelCase |
| `GET|HEAD /download/:ticket` | 按 ticket 下载（主站签发的链接） |
| `GET|HEAD /download?url=` | 直接代理白名单 URL，仅当 `ACCEL_ALLOW_PUBLIC=true` |
| `GET /git/:owner/:repo.git/info/refs?service=git-upload-pack` | smart HTTP 引用广告 |
| `POST /git/:owner/:repo.git/git-upload-pack` | pack 协商与传输 |
| `GET|POST /git/:ticket/:owner/:repo.git/...` | 带 ticket 前缀的克隆地址（主站签名模式） |
| 任何 `git-receive-pack` 请求 | `405 GIT_RECEIVE_PACK_DISABLED` |

错误一律是 `{ error: "中文说明", code: "MACHINE_CODE" }`：

| code | HTTP | 含义 |
| --- | --- | --- |
| `TICKET_INVALID` / `TICKET_EXPIRED` | 401 | 签名不匹配（两端 SECRET 不一致或路径不匹配）/ ticket 过期 |
| `HOST_NOT_ALLOWED` / `PROTOCOL_NOT_ALLOWED` / `URL_INVALID` | 400 | 不是白名单域名 / 不是 https / URL 或参数非法 |
| `PUBLIC_DISABLED` | 403 | 节点关闭了公开下载，但请求没带 ticket |
| `RATE_LIMITED` | 429 | 每 IP 每分钟请求数超限，带 `Retry-After` |
| `IP_CONCURRENCY_LIMITED` | 429 | 同一 IP 并发过多 |
| `GLOBAL_CONCURRENCY_LIMITED` | 503 | 节点并发已满 |
| `GIT_RECEIVE_PACK_DISABLED` | 405 | 不支持 push |
| `UPSTREAM_TIMEOUT` / `UPSTREAM_FAILED` | 504 / 502 | 连接 GitHub 超时 / 失败 |
| `REDIRECT_TOO_MANY` / `REDIRECT_WITH_BODY` | 502 | 重定向超过 5 跳 / 带请求体的请求被重定向（无法重放） |
| `NOT_FOUND` | 404 | 路径不对 |

## ticket 协议

```
ticket = base64url(JSON{u,e,k}) + "." + hex(hmac_sha256(base64url部分, SECRET))[:32]
```

- `u`：下载目标 URL，或 git 模式下的 `/owner/repo.git`
- `e`：过期时间（Unix 秒）
- `k`：`"file"` 或 `"git"`

固定测试向量（`SECRET=test-secret-0123456789abcdef0123456789`，`e=1800000000`），
实现与测试都逐字节断言这两个值：

```
file: eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0.1fdb9326cecbc1dae9177cd18b229837
git:  eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0.e3b1ec8cf96bc251c12bcf34aa369b7c
```

签名有效只说明"ticket 来自主站"，`u` 仍然要过一遍域名白名单——两者是独立的防线。

## 白名单

只允许 `https` 与以下域名（`github.com`、`api.github.com`、`codeload.github.com`、
`raw.githubusercontent.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com`）。
每一次重定向后的 `Location` 都重新校验：否则一个被攻陷的上游域名就能把节点变成任意地址的代理。

## 缓存

- key = `sha256(目标 URL)`，落盘为 `<key>.bin` + `<key>.json`
  （`{ fileName, contentType, etag, lastModified, size, storedAt }`）。
- 只有"完整 200 + 有 Content-Length + 未压缩 + 客户端未带 Range"才边转发边写缓存，
  先写 `.part`，写入字节数与 Content-Length 一致才 rename 成正式文件；中断即丢弃。
- 命中时按 `Range` 切片返回 206，支持 `If-Range`（弱 ETag 一律退回完整 200）与 304。
- 命中会刷新文件 mtime，淘汰顺序就是"最后访问时间"。
- 启动时清理上次进程留下的 `.part` 残片并按 TTL/容量做一次淘汰。

## 部署

二选一：Docker Compose（`Dockerfile` + `docker-compose.yml`）或 systemd（`systemd/github-accel.service`）。
两种方式都只监听本机端口，公网 443 由 Nginx 终止 TLS。

```bash
# Docker
cp .env .env.example  # 或手写一个，至少含 ACCEL_SECRET=<与主站相同的 32+ 字符随机串>
docker compose up -d --build
docker compose exec github-accel node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(console.log)"

# systemd
pnpm build
sudo useradd --system --home /opt/github-accel --shell /usr/sbin/nologin gitaccel
sudo mkdir -p /var/lib/github-accel/cache /etc
sudo cp -r dist package.json /opt/github-accel/
sudo install -m 600 /dev/null /etc/github-accel.env   # 写入 ACCEL_SECRET=...
sudo systemctl enable --now github-accel
```

### Nginx 必须关闭缓冲

`nginx.conf` 里这几行是硬性要求，缺一个就会出现"clone 卡住"或"断点续传失效"：

```nginx
proxy_buffering off;
proxy_request_buffering off;
client_max_body_size 0;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
gzip off;
proxy_http_version 1.1;
```

节点用 `X-Forwarded-For` 的**最后一段**做限流：Nginx 的 `$proxy_add_x_forwarded_for`
会把真实地址追加在末尾，而前面几段客户端可以随便伪造。

## 排错

| 现象 | 原因 |
| --- | --- |
| 主站显示"加速节点未配置" | 主站 `GITHUB_ACCEL_BASE_URL` 为空 |
| 主站显示"加速节点不可达" | `/api/health` 超时：域名解析、443、防火墙、节点没起 |
| 下载 401 | 两端 SECRET 不一致，或 ticket 过期 |
| 下载 400 `HOST_NOT_ALLOWED` | 目标不是 GitHub 白名单域名 |
| Release 列表 403/429 | GitHub API 限额；配置只读 `ACCEL_GITHUB_TOKEN` |
| clone 卡住 | Nginx 开了 `proxy_buffering` 或 `proxy_request_buffering` |
| 断点续传失效 | 上游没透传 `Range`，或节点解掉 `Content-Encoding` 后又声明了原长度 |
| 429 / 503 | 触发限流；调 `ACCEL_RATE_PER_MINUTE` / 并发上限，或让主站做退避 |

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/config.ts` | 环境变量解析（空串回退默认值）、启动告警 |
| `src/ticket.ts` | HMAC-SHA256 ticket 签发与校验 |
| `src/github.ts` | 域名白名单、GitHub 输入解析、Release 列表（含 10 分钟缓存） |
| `src/proxy.ts` | 上游请求、手动跟随 3xx、hop-by-hop 过滤、UA 策略 |
| `src/cache.ts` | 磁盘 LRU 缓存、Range 解析、`.part` → `.bin` 原子落盘 |
| `src/ratelimit.ts` | 每 IP 每分钟计数 + 每 IP/全局并发（时钟可注入，便于单测） |
| `src/server.ts` | 路由、鉴权、限流、缓存/上游编排、优雅关闭 |

## 已知边界

- 只支持公开仓库：私有仓库需要用户自带 token，本方案不保存用户凭据。
- 不支持 `git push`。
- 缓存无跨进程锁：多实例共享同一目录会出现重复下载，建议每个实例一个目录。
