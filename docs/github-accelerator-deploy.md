# GitHub 下载加速：部署说明

这份文档讲的是**怎么把 GitHub 下载加速真正跑起来**：一台低带宽的主站（博客本身），加一台高带宽的加速节点。协议契约、接口细节、限速实现见 [`docs/github-accelerator.md`](./github-accelerator.md)；节点的代码地图与单测说明见 [`packages/github-accel/README.md`](../packages/github-accel/README.md)。本文只讲部署、验收、运维和排错。

## 0. 这套功能由什么组成

```
浏览器 ──① 解析/签发──▶ 主站 API（低带宽机器）──② 302 跳转──┐
   │                                                        │
   └────────③ 直连下载字节流（不经主站）──────────▶ 加速节点（高带宽机器）
                                                     │
                                                     └──④ 回源──▶ github.com / codeload / release-assets
```

- **① 与 ②** 走主站：解析用户贴进来的 GitHub 地址、用 HMAC 签一张 30 分钟的 ticket、把浏览器 302 到节点。主站上跑的是普通 Node 进程，流量只有几百字节。
- **③** 是真正的字节流，由节点直接发给浏览器，**不经过主站**。这正是把功能拆成两台机器的原因：主站带宽低，几个 GB 的安装包会把它的出口打满，博客自己就打不开了。
- **④** 节点回源 GitHub，支持 Range 透传与断点续传；命中磁盘缓存时直接从缓存读，夜里重复下载同一个 Release 不会再去打 GitHub。

拆分带来的代价只有两个，都可以接受：多一个域名和证书；两端要共享一段密钥（签票与验票必须一致）。

## 1. 准备清单

| 项目 | 节点机器（高带宽） | 主站机器（低带宽） |
| --- | --- | --- |
| 角色 | 跑 `github-accel`，把字节流发给浏览器 | 已有博客部署，只加环境变量 |
| 系统 | Debian 12 / Ubuntu 22.04+ 等任意 Linux | 不变（`deploy/manage.sh` 支持的 Debian/Ubuntu） |
| 运行时 | Docker（方案 A）或 Node.js ≥ 22（方案 B） | 不变 |
| 出口带宽 | 决定体验上限，见第 5 节 | 只需承受页面与 API 的小请求 |
| 磁盘 | 缓存盘，默认上限 20 GiB；不缓存可省 | 不变 |
| 网络 | 能顺畅访问 `github.com`、`codeload.github.com`、`*.githubusercontent.com` | 能访问节点域名的 443 |
| 端口 | 22 / 80 / 443 对外，8787 只听本机 | 不变 |
| 域名 | 一个子域，例如 `gh.example.com`（必须 HTTPS） | 不变 |

再准备**一段共享密钥**，两端逐字节相同：

```bash
openssl rand -hex 32   # 输出 64 个字符，直接当 ACCEL_SECRET / GITHUB_ACCEL_SECRET
```

> 密钥只放服务器上的环境变量文件（`chmod 600`），不要写进仓库、不要贴到聊天里。两端不一致时所有下载都是 401，而且从浏览器侧看不出原因——第 7 节有对照表。

## 2. 节点机器：部署加速节点

下面是两条互斥的路线，**选一条**。Docker 路线更省心（不用在宿主机装 Node），systemd 路线没有容器开销、排障更直接。

两条路线都只让节点监听 `127.0.0.1:8787`，公网 443 交给同机的 Nginx（第 2.3 节）。**不要**把 8787 直接暴露到公网：那会绕过 TLS，ticket 明文出现在链路上。

### 2.1 方案 A：Docker Compose（推荐）

```bash
# 1) 装 Docker（官方脚本，或发行版仓库）
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker

# 2) 取代码：整仓 clone 后进入该目录（compose 的构建上下文就是它）
sudo git clone https://github.com/F-Jayson/myblog.git /opt/myblog
cd /opt/myblog/packages/github-accel

# 3) 写节点自己的 .env（compose 会读这个文件，权限设成 600）
sudo tee .env >/dev/null <<'EOF'
ACCEL_SECRET=把上面 openssl rand -hex 32 的输出粘这里
ACCEL_ALLOW_PUBLIC=true
ACCEL_GUEST_BYTES_PER_SECOND=10485760
ACCEL_MEMBER_BYTES_PER_SECOND=104857600
EOF
sudo chmod 600 .env

# 4) 启动
sudo docker compose up -d --build
```

几点必须知道：

- `docker-compose.yml` 里已经固定了 `ACCEL_HOST=0.0.0.0`、`ACCEL_PORT=8787`、`ACCEL_CACHE_DIR=/data/cache`。`environment` 的优先级高于 `env_file`，所以 `.env` 里再写这几个变量不会生效，别在那里改成别的值。
- 缓存挂的是命名卷 `accel-cache`，容器重建不丢缓存。**不想要磁盘缓存时改的是 `docker-compose.yml`**：把 `environment` 里的 `ACCEL_CACHE_DIR: /data/cache` 删掉（或置空），因为它在 `.env` 之上的优先级。
- 容器以 `node` 用户运行，`/data` 已 chown 好；自定义挂载路径时要自己保证可写，否则缓存命中率永远是 0。
- 日志驱动限制在 10 MB × 3，不会把磁盘写满。

验证：

```bash
sudo docker compose ps
sudo docker compose logs --tail=50
sudo docker compose exec github-accel node -e \
  "fetch('http://127.0.0.1:8787/api/health').then(r=>r.text()).then(console.log)"
# {"ok":true,"version":"1.0.0","publicAllowed":true,"guestBytesPerSecond":10485760,"memberBytesPerSecond":104857600}
```

启动日志里还会打印一行档位摘要（游客/登录两档速率与并发），以及"SECRET 为空或过短"的中文告警。看到告警就回去补密钥。

### 2.2 方案 B：systemd 裸机

```bash
# 1) Node.js 22（NodeSource 仓库；发行版自带的一般太旧）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2) 取代码并构建（节点零运行时依赖，dist 就够跑）
sudo git clone https://github.com/F-Jayson/myblog.git /opt/myblog
cd /opt/myblog/packages/github-accel
sudo corepack enable pnpm          # Node 22 自带 corepack，会按 packageManager 字段装 pnpm 11.22.0
sudo pnpm install --frozen-lockfile
sudo pnpm build            # 产出 dist/

# 3) 建运行用户与目录
sudo useradd --system --home /opt/github-accel --shell /usr/sbin/nologin gitaccel
sudo mkdir -p /opt/github-accel /var/lib/github-accel/cache
sudo cp -r dist package.json /opt/github-accel/
sudo chown -R gitaccel:gitaccel /opt/github-accel /var/lib/github-accel

# 4) 密钥文件（只给 root 与运行用户读）
sudo install -m 600 -o root -g gitaccel /dev/null /etc/github-accel.env
sudo tee /etc/github-accel.env >/dev/null <<'EOF'
ACCEL_SECRET=把 openssl rand -hex 32 的输出粘这里
ACCEL_HOST=127.0.0.1
ACCEL_PORT=8787
ACCEL_CACHE_DIR=/var/lib/github-accel/cache
ACCEL_ALLOW_PUBLIC=true
ACCEL_GUEST_BYTES_PER_SECOND=10485760
ACCEL_MEMBER_BYTES_PER_SECOND=104857600
EOF
sudo chmod 600 /etc/github-accel.env

# 5) 装 unit 并启动
sudo cp systemd/github-accel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now github-accel
sudo systemctl status github-accel --no-pager
```

注意：

- `ACCEL_PORT` 是**节点自己**的端口；`.env.example` 里那些 `API_PORT` 是主站的，别混。
- unit 文件里 `ProtectSystem=strict` + `ReadWritePaths=/var/lib/github-accel/cache`：缓存目录换了位置就必须同步改这一行，否则写入被拒、只剩纯流式。
- `LimitNOFILE=65535` 不要删：每个下载/git 会话都是长连接，默认 1024 很容易先被打满。
- 升级就是重新 `pnpm build` → 覆盖 `/opt/github-accel/dist` → `systemctl restart github-accel`。

### 2.3 反向代理与 HTTPS

仓库带了可直接用的模板 `packages/github-accel/nginx.conf`。

```bash
sudo apt-get install -y nginx certbot

# 1) 放进 sites-available 并改域名
sudo cp /opt/myblog/packages/github-accel/nginx.conf /etc/nginx/sites-available/github-accel
sudo sed -i 's/accel.example.com/gh.example.com/g' /etc/nginx/sites-available/github-accel
sudo ln -sf /etc/nginx/sites-available/github-accel /etc/nginx/sites-enabled/github-accel

# 2) ACME webroot 目录（配置里 http 段用的就是它）
sudo mkdir -p /var/www/certbot

# 3) 先只上 HTTP 让 80 可达，再申请证书
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d gh.example.com

# 4) 证书到位后重新校验并 reload（www 配置里的证书路径形如 /etc/letsencrypt/live/gh.example.com/）
sudo nginx -t && sudo systemctl reload nginx
```

**这份 Nginx 配置里有几行是硬性要求，缺一个就会出现"clone 卡住"或"断点续传失效"：**

```nginx
proxy_buffering off;          # 开了缓冲 = 把节点磁盘当瓶颈，大文件与 clone 直接卡死
proxy_request_buffering off;
client_max_body_size 0;
proxy_read_timeout 3600s;     # 默认 60s 一定会掐断慢线路上的大文件
proxy_send_timeout 3600s;
gzip off;                     # 压缩对 zip/tar.gz/pack 无意义，还会让 Content-Length 失配
proxy_http_version 1.1;
```

另外两点：

- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 必须保留。节点用这个头的**最后一段**做每 IP 限流，前面的段客户端可以随便伪造；少了这行，所有请求都算同一个 IP，全站会被一个人限死。
- `http2 on;` 需要 Nginx ≥ 1.25.1。旧版把 `listen 443 ssl;` 改成 `listen 443 ssl http2;`，同时删掉 `http2 on;`。

> 如果节点前面还有一层 CDN 在吃带宽，上面最后这条会变成**反效果**：`$proxy_add_x_forwarded_for` 追加的是 CDN 回源 IP，所有用户会被压成同一个限流桶。套 CDN 时按下面 2.3.1 节改。

### 2.3.1 前面套一层 CDN 时的额外配置

CDN 回源时，真实客户端地址不是 `$remote_addr`（那是 CDN 的回源节点），而是 CDN 写在请求头里的。这时要做三处调整，否则会踩两个坑。

**坑一：限流桶塌成一个。** 节点按 `X-Forwarded-For` 的最后一段做每 IP 限流，而 `$proxy_add_x_forwarded_for` 会把 `$remote_addr`（CDN 回源 IP）追加到末尾，于是所有用户都被认成同一个 IP：游客的"每 IP 1 个并发"变成**全站共 1 个并发**，每分钟 30 次的额度也变成全站共享。CDN 回源 IP 往往还是轮换的，表现为"有时能用有时 429"。

**坑二：证书其实不需要自己签。** CDN 终止 TLS 时，回源可以是明文 HTTP，节点这层只要 `listen 80`。此时 `server_name` 要写 CDN 回源时用的 Host（有的 CDN 回源用 IP，那就保留 `_` 兜底）。

改法（模板里没有，套 CDN 时手动加）：

```nginx
# 放在 server{} 之外，http 段里
map $http_x_forwarded_for $accel_client_xff {
    ""      $remote_addr;             # 没带 XFF（CDN 直连或本机自检）就用连接地址
    default $http_x_forwarded_for;    # CDN 已经写好了真实地址，原样透传，不要再追加
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name gh.example.com _;

    location / {
        proxy_pass http://github_accel;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        # 关键：不是 $proxy_add_x_forwarded_for。那样会在末尾追加 CDN 回源 IP，
        # 节点取最后一段时就拿到回源 IP 了。
        proxy_set_header X-Forwarded-For $accel_client_xff;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        # 下面几行与 2.3 节完全一致，不能省
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 0;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        gzip off;
    }
}
```

验证方式很简单：从**外部**网络连两次节点，看节点日志里的客户端 IP 是不是自己的公网 IP 而不是 CDN 的：

```bash
# 节点机上看最近几条请求的来源 IP
sudo journalctl -u github-accel -n 20 --no-pager | grep -o 'from [0-9.]*' | sort -u
```

如果这里出现的是**自己的公网 IP**，配置就对了。如果只出现两三个固定 IP（CDN 回源 IP），只有两种可能：

1. map 放错了位置——它必须在 `server { }` 之外。
2. 有些 CDN 会在 `X-Forwarded-For` 末尾**再追加自己的回源 IP**，这时"原样透传"也会把回源 IP 送到最后一段。改用 Nginx 的 `real_ip` 模块把真实地址纠正回 `$remote_addr`，再单独下发：

   ```nginx
   # 回源 IP 网段问 CDN 服务商要，或用日志里观察到的那几个换算出网段
   set_real_ip_from 198.51.100.0/24;
   real_ip_header    X-Forwarded-For;
   real_ip_recursive on;          # 从右往左跳过可信地址，取真正的客户端
   # 然后在 location 里用纠正后的 $remote_addr，而不是 add_x_forwarded_for
   proxy_set_header X-Forwarded-For $remote_addr;
   ```

   好处是 `$remote_addr` 一并变成真实客户端地址，依赖它的 `allow`/`deny` 也恢复有效；代价是 CDN 换回源网段时要跟着改。

**另外两条与 CDN 相关的取舍：**

- CDN 边缘缓存与节点的磁盘缓存是两层，别指望它们互相"命中加速"：节点的 `x-cache` 只反映节点自己。如果 CDN 把 `/download` 也缓存了，用户可能拿到 CDN 边缘上的旧副本；节点已经给所有错误响应加了 `cache-control: no-store`（401/403/429/5xx 与 405），避免"一次限流被缓存成一段时间全站 429"，但**成功响应**的缓存策略取决于 CDN 配置，必要时在 CDN 侧对大文件路径关掉缓存。
- CDN 边缘带宽通常不是一个稳定值：同一份缓存文件隔几分钟再测，速度可能从 3 MB/s 掉到 0.4 MB/s。判断"是节点慢还是 CDN 慢"的方法是**绕过 CDN 直连节点**再测一次（节点上 `curl -o /dev/null -w '%{speed_download}\n' http://127.0.0.1:8787/download/<ticket>`，或在节点本机对 GitHub 测原始带宽）。节点到 GitHub 单连接应该能到几十 MB/s；如果直连节点很快、走 CDN 很慢，问题在 CDN 侧，与节点档位配置无关。

### 2.4 防火墙

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
# 确认 8787 只在回环地址上
ss -ltnp | grep 8787        # 期望 127.0.0.1:8787，不是 0.0.0.0:8787
```

云厂商的安全组同样只放行 22/80/443。

### 2.5 节点自检（部署完先做这四条）

```bash
# ① 本机健康检查
curl -s http://127.0.0.1:8787/api/health

# ② 经 Nginx + TLS 的健康检查（这条通了才说明域名/证书/反代都对）
curl -s https://gh.example.com/api/health

# ③ 真下载一个公开仓库归档，看状态码、大小、速度、档位头
curl -sL -D /tmp/h -o /dev/null \
  'https://gh.example.com/download?url=https%3A%2F%2Fgithub.com%2Foctocat%2FHello-World%2Farchive%2Frefs%2Fheads%2Fmaster.zip' \
  -w 'status=%{http_code} size=%{size_download} speed=%{speed_download}\n'
grep -i x-accel /tmp/h      # 期望 x-accel-tier: guest / x-accel-rate: 10485760

# ④ Range 请求（断点续传的地基）
curl -s -o /dev/null -w '%{http_code}\n' -r 0-99 \
  'https://gh.example.com/download?url=https%3A%2F%2Fgithub.com%2Foctocat%2FHello-World%2Farchive%2Frefs%2Fheads%2Fmaster.zip'
# 期望 206
```

第 ③ 条顺便验证了限速：`speed` 应该贴近 `ACCEL_GUEST_BYTES_PER_SECOND`（默认 10 MiB/s ≈ 10485760 B/s）。如果明显更快，说明变量拼错了或没生效；如果明显更慢，先看是不是 Nginx 还开着 `proxy_buffering`。

> `/download?url=` 是无签名的公开路径，只在 `ACCEL_ALLOW_PUBLIC=true` 时可用。自检完建议按第 9 节决定是否关掉。

## 3. 主站机器：只加变量

主站不装、不跑任何节点进程，字节流量也不经过它。

### 3.1 追加四个变量

`<APP_DIR>/.env` 由 `deploy/manage.sh` 生成并设为 600，手工追加时保留权限：

```bash
APP_DIR=/var/www/myblog      # 换成你的实际目录
sudo tee -a "$APP_DIR/.env" >/dev/null <<'EOF'

# GitHub 下载加速（入口 /tools/github，字节流由另一台节点直传）
GITHUB_ACCEL_BASE_URL=https://gh.example.com
GITHUB_ACCEL_SECRET=与节点 ACCEL_SECRET 逐字节相同
# 可选：请求节点（健康检查、Release 列表）的超时，默认 8000ms
GITHUB_ACCEL_TIMEOUT_MS=8000
# 可选：下载 / 克隆 ticket 有效期，默认 30 分钟
GITHUB_ACCEL_TICKET_TTL_MINUTES=30
EOF
sudo chmod 600 "$APP_DIR/.env"
```

`GITHUB_ACCEL_BASE_URL` 只写协议 + 域名 + 可选端口，**不要**带路径或结尾斜杠（代码会自己去掉结尾斜杠，但带 `/download` 这类路径会拼错）。必须是 `https://`：ticket 在 URL 上，明文传输等于把下载权限送人。

### 3.2 生效与验证

```bash
sudo ./deploy/manage.sh restart        # 或 sudo systemctl restart jayson-blog

# 主站视角看节点状态：
curl -s https://blog.example.com/api/tools/github/config
# {"enabled":true,"configured":true,"online":true,"acceleratorBase":"https://gh.example.com",
#  "publicAllowed":true,"ticketTtlMinutes":30,
#  "rates":{"guest":10485760,"member":104857600}}
```

三个字段分开看：`configured` = 变量配了；`online` = 主站能连到节点 `/api/health`；`rates` = 节点上报了两档速率（旧节点没有这个字段，页面会显示"未知"，不是错误）。

### 3.3 功能开关

整页可用性由站点设置里的 `features.githubAccelEnabled` 控制（默认开）。关掉之后接口一律返回中文错误、页面显示不可用；这与"没配节点"是两件事：后者页面仍能解析地址，只是不能下载。

## 4. 端到端验收清单

按顺序做一遍，全部通过就可以对外了。

| # | 动作 | 期望 |
| --- | --- | --- |
| 1 | 节点机 `curl -s https://gh.example.com/api/health` | `ok:true`，两档速率与实际配置一致 |
| 2 | 主站机 `curl -s <站点>/api/tools/github/config` | `configured:true`、`online:true`、带 `rates` |
| 3 | 打开 `/tools/github` | 顶部徽标"加速节点已就绪"；身份行显示"当前身份 游客 · 10 MiB/s"，右侧提示"登录后单连接提速到 100 MiB/s" |
| 4 | 贴一个 Release 资产地址 → 解析 → 开始下载 | 浏览器下载列表出现任务；响应头有 `x-accel-tier: guest` |
| 5 | 登录后再下一次 | `x-accel-tier: member`，速度上限到 100 MiB/s（受线路与节点带宽约束） |
| 6 | 贴一个不存在的地址（如 `.../heads/nope.zip`）→ 开始下载 | **留在页面**显示"GitHub 返回 404：…"，不跳错误页（这是同源预检在起作用） |
| 7 | 断点续传：下载中途暂停再继续 | 恢复正常，不从头开始（需要节点与 Nginx 都透传 Range） |
| 8 | `git clone https://gh.example.com/git/octocat/Hello-World.git` | 克隆成功；同样受限速影响 |
| 9 | 大文件下到一半把节点停掉再启动 | 浏览器报错；节点重启后重新点下载即可（节点缓存里不会有半截文件） |

第 6 条如果变成了跳错误页，说明主站还在跑旧版本（没有 `/api/tools/github/probe/` 路由），见第 6.1 节的升级顺序。

## 5. 容量与限速怎么定

节点用的是**单连接令牌桶**：每条下载/git 连接各有一个桶，按档位给速率。它不会拒绝请求，超卖只是让每条连接变慢——所以"能同时服务多少人"取决于出口带宽除以每人速率。

### 5.1 先算出口带宽

```
需要的最低出口带宽 ≈ 同时满速的会话数 × 单连接速率
1 Gbps ≈ 125 MB/s（119 MiB/s）
```

| 节点出口 | 大约能同时满速支撑 |
| --- | --- |
| 100 Mbps | 1 个游客（10 MiB/s ≈ 80 Mbps） |
| 1 Gbps | 1 个登录用户（100 MiB/s ≈ 800 Mbps）或 12 个游客 |
| 2.5 Gbps | 3 个登录用户，或 30 个游客 |

并发不是无限的，还有三道闸门：`ACCEL_GUEST_CONCURRENCY_PER_IP`（游客每 IP 默认 1）、`ACCEL_CONCURRENCY_PER_IP`（登录档每 IP 默认 3）、`ACCEL_MAX_CONCURRENCY`（全站默认 64）。超了分别回 429 `IP_CONCURRENCY_LIMITED` 与 503 `GLOBAL_CONCURRENCY_LIMITED`，浏览器侧看到的就是"下载失败，稍后再试"。

### 5.2 变量建议

| 用途 | `ACCEL_GUEST_BYTES_PER_SECOND` | `ACCEL_MEMBER_BYTES_PER_SECOND` | 说明 |
| --- | --- | --- | --- |
| 小站 / 演示 | `0`（不限速） | `0` | 只适合带宽充裕或用户极少 |
| 默认（10 / 100 MiB/s） | `10485760` | `104857600` | 游客够用，登录用户能跑满千兆 |
| 带宽紧张 | `3145728`（3 MiB/s） | `20971520`（20 MiB/s） | 1 Gbps 节点能撑更多游客 |
| 完全不提速 | `0` 改成极小值不推荐 | — | 想临时关掉限速就填 `0`，注意这是"不限速"不是"禁止下载" |

改完必须重启节点进程；`/api/health` 里的两个数字与启动日志那行摘要是确认配置生效的最快方式。速率填 `0` 表示不限速。

### 5.3 缓存盘

- 只有"完整 200 + 有 Content-Length + 未压缩 + 客户端没带 Range"的响应才会落盘，先写 `.part` 再原子 rename；中断即丢弃，不会有半截文件被当成缓存。
- `ACCEL_CACHE_MAX_BYTES`（默认 20 GiB）与 `ACCEL_CACHE_TTL_HOURS`（默认 7 天）共同决定占用；超了按最后访问时间淘汰。
- 给缓存盘留出上限 **1.5 倍**的空间（默认 20 GiB 上限 → 建议 ≥ 30 GiB 空闲），并加磁盘监控。
- 多个节点实例**不要**共享同一个缓存目录：缓存没有跨进程锁，会重复下载、互相覆盖。
- 纯流式（`ACCEL_CACHE_DIR` 留空）省磁盘，但每个请求都回源 GitHub，反复下载同一个大文件时既不省流量也更容易触发上游限流。

## 6. 日常运维

### 6.1 升级顺序（重要）

**先升节点，再升主站。** 原因是兼容方向只有一个：

- 新节点能识别带档位 `t` 的 ticket，也仍然接受没有 `t` 的旧 ticket（按游客限速）。
- 旧节点不认识 `t`，但会忽略它——所以新主站配旧节点也能下载，只是"登录用户 100 MiB/s"不生效，看 `/api/health` 有没有 `guestBytesPerSecond` 就能确认是不是旧节点。

所以滚动发布窗口里，任何一种错序都还能下载，只是速度档位可能暂时不对。升级动作：

```bash
# 节点（Docker）
cd /opt/myblog && sudo git pull --ff-only
cd packages/github-accel && sudo docker compose up -d --build

# 节点（systemd）
cd /opt/myblog && sudo git pull --ff-only
cd packages/github-accel && sudo pnpm install --frozen-lockfile && sudo pnpm build
sudo cp -r dist /opt/github-accel/ && sudo systemctl restart github-accel

# 主站
sudo ./deploy/manage.sh update
```

节点重启会中断正在进行的下载（浏览器可以续传），挑低峰做。

### 6.2 日志

```bash
# Docker
cd /opt/myblog/packages/github-accel
sudo docker compose logs -f --tail=100

# systemd
sudo journalctl -u github-accel -f
```

日志里能看到每条请求的状态、档位、限流拒绝原因。**不要**把 ticket 贴进工单：它在有效期内就是一张可用的下载凭证（虽然只能下白名单里的 GitHub 地址）。

### 6.3 清理缓存

```bash
# Docker（命名卷名是 <项目名>_accel-cache，项目名默认取目录名；先 down 再删）
cd /opt/myblog/packages/github-accel
sudo docker compose down
sudo docker volume ls | grep accel-cache      # 确认卷名
sudo docker volume rm github-accel_accel-cache

# systemd
sudo systemctl stop github-accel
sudo rm -rf /var/lib/github-accel/cache/*
sudo systemctl start github-accel
```

正常不需要手工清：TTL 与容量淘汰会自动跑，启动时也会清理上次进程留下的 `.part` 残片。

### 6.4 备份

节点**不存任何用户数据**：缓存可以随时重建，ticket 是签出来的不是存出来的。真正需要备份的只有：

- 节点：`/etc/github-accel.env` 或 `packages/github-accel/.env`（就是那段密钥）。
- 主站：`<APP_DIR>/.env`（含 `GITHUB_ACCEL_SECRET`），按 `deploy/DEPLOYMENT.md` 的备份流程一起做。

密钥丢了不影响已有部署（两个文件都还在），但换机器时必须两端一起换。

### 6.5 证书续期

`certbot` 装好会自动加 `certbot.timer`：

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

证书过期时浏览器直接拒绝连接，页面上的表现是"加速节点不可达"——第 7 节第一条就是这个。

## 7. 故障定位

先分清是**哪台机器**的问题，再用对应的命令。表里"在哪台机器执行"一列就是定位路径。

| 现象 | 大概率原因 | 在哪台机器验证 |
| --- | --- | --- |
| 页面显示"加速节点未配置" | 主站 `GITHUB_ACCEL_BASE_URL` 为空或没重启 | 主站：`curl -s <站点>/api/tools/github/config` 看 `configured` |
| 页面显示"加速节点不可达" | 主站到节点的 `/api/health` 失败：DNS、443、防火墙、证书过期、节点没起 | 主站：`curl -sv https://gh.example.com/api/health` |
| 下载一律 401 `TICKET_INVALID` | 两端密钥不一致（最常见），或主站/节点只重启了一端 | 两端各自打印 `ACCEL_SECRET`/`GITHUB_ACCEL_SECRET` 长度比对（别直接打印内容） |
| 下载 401 `TICKET_EXPIRED` | 生成链接后放了超过 30 分钟才点 | 重新生成；或调大 `GITHUB_ACCEL_TICKET_TTL_MINUTES` |
| 下载 400 `HOST_NOT_ALLOWED` | 目标不在白名单（不是 GitHub 域名） | 节点日志里的目标 URL |
| 下载 403 `PUBLIC_DISABLED` | 节点关了公开下载，但请求没带 ticket（例如手写的 `/download?url=` 自检命令） | 这是预期行为，见第 9 节 |
| clone 卡住 / 断点续传失效 | Nginx 开了 `proxy_buffering` / `proxy_request_buffering` | 节点机：`nginx -T \| grep -A2 buffering` |
| 速度一直是游客档 | ticket 里没有 `member`：签发时没有登录态 | 看响应头 `x-accel-tier`；确认下载前页面身份行是"登录用户" |
| 速度完全没变（还是旧速度） | 节点没升级，不认识 `t` | `/api/health` 缺 `guestBytesPerSecond` 即为旧版 |
| 429 `IP_CONCURRENCY_LIMITED` 变多 | 游客每 IP 只允许 1 个并发会话 | 调 `ACCEL_GUEST_CONCURRENCY_PER_IP`，或让用户登录 |
| 明明是不同的人，却互相抢并发、一起 429 | 节点把 CDN 回源 IP 当成了客户端地址（只有两三个 IP 在轮换） | 节点机看日志来源 IP，按 2.3.1 节换成 `$accel_client_xff` |
| 一段时间内所有人一起 401/429，过后自己恢复 | 错误响应被 CDN 边缘缓存了 | 新版节点会给所有错误响应发 `cache-control: no-store`；若仍复现，在 CDN 侧对该路径关缓存 |
| 走 CDN 只有 0.x MB/s，直连节点却有 3 MB/s 以上 | CDN 边缘带宽被限速或不稳定，与节点档位无关 | 绕开 CDN 直连节点再测一次（2.3.1 节最后一段） |
| 429 `RATE_LIMITED` 变多 | 节点每 IP 每分钟 30 次请求（含 HEAD 预检） | 调 `ACCEL_RATE_PER_MINUTE` |
| 429 `GITHUB_ACCEL_RATE_LIMITED` | **主站**自己的限流：解析 30 次/分钟、签发 60 次/分钟，刷新页面与反复解析都会计数 | 主站日志；这是应用层限流，改节点变量没用 |
| 503 `GLOBAL_CONCURRENCY_LIMITED` | 节点并发打满 | 调 `ACCEL_MAX_CONCURRENCY`，或加带宽/加实例 |
| Release 列表 403/429 | GitHub API 限额（未配 token 时 60 次/小时/IP） | 配一个只读 `ACCEL_GITHUB_TOKEN` |
| 下载能开始但很快就断 | 上游超时 `ACCEL_UPSTREAM_TIMEOUT_MS` 太小、或机器出口被限速 | 节点日志里的 `UPSTREAM_TIMEOUT` / `UPSTREAM_FAILED` |

更进一步的分层判断：主站日志看"签发/预检"，节点日志看"实际传输"。预检失败但真下载能成是正常的（预检超时会放行，见 `docs/github-accelerator.md` §4.2）。

## 8. 回滚

这套功能是渐进式接入的，回滚很简单，而且**不会**影响博客其它部分：

1. **只停下载**：把主站 `.env` 里的 `GITHUB_ACCEL_BASE_URL` 清空并重启 API。页面回到"加速节点未配置"状态：仍能解析 GitHub 地址、仍能看 Release 列表，只是不能点下载。这是最温和的一步。
2. **整页关掉**：站点设置里关 `features.githubAccelEnabled`，接口一律拒绝。前端页面入口可以保留（会显示不可用）。
3. **彻底下线节点**：主站先回滚（第 1 步），再 `docker compose down` 或 `systemctl disable --now github-accel`，最后删 DNS 记录。顺序反过来会让还在点下载的用户看到 502。
4. **代码回滚**：老版本主站不认识 `probe` 路由也没关系——页面会退回"直接跳转下载"的老行为（预检异常一律放行），只是错误提示不如新版友好。

## 9. 安全边界与已知取舍

- **ticket 会出现在 URL 上**（`/download/<ticket>`、`git clone <节点>/git/<ticket>/…`），所以节点**必须**走 HTTPS；有效期默认 30 分钟；ticket 只在请求开始时校验，已开始的传输不会因为到期被中途掐断（限速下这条很重要）。
- **只加速公开仓库**，不支持 `git push`（节点直接 405），也不保存任何用户凭据；私有仓库一律不支持。
- `ACCEL_ALLOW_PUBLIC`：默认 `true`，允许无 ticket 的 `/download?url=` 与无签名的 `/git/owner/repo.git`。**想收紧就设 `false`**，代价是：
  - 用户只能从页面拿带 ticket 的链接下载/克隆（每次 30 分钟有效）；
  - 页面给出的 `git config --global url."…/git/".insteadOf` 全局配置**不再可用**（它指向无签名路径），只能用页面上的 `git clone` 命令。
- **单连接限速 ≠ 单用户总量**：档位限的是每条连接。登录用户默认允许 3 个并发，理论上能拿到 3 倍速率；要按人控总量需要在 Nginx 层加 `limit_rate`/`limit_conn` 或换更复杂的会话级限速。
- **公开路径永远是游客档**：不带 ticket 的 `/download?url=` 与公开 clone 拿不到 `member` 档，无论是否登录。
- **缓存不共享锁**：一个实例一个缓存目录，别让多个容器挂同一个卷。
- **节点是一台对外代理**：它只能访问白名单里的 GitHub 域名（每一次重定向都重新校验），但仍然会消耗你的出口带宽与 GitHub 配额。请监控带宽与磁盘，必要时收紧档位速率，而不是指望"没人知道这个域名"。
- 反向代理链上的 `X-Forwarded-For` 决定限流粒度，前面加了 CDN/WAF 时要确认它是"追加真实地址"而不是"覆盖"。

## 10. 一页速查

```text
节点机（高带宽）                           主站机（低带宽）
├─ 端口 8787（只听 127.0.0.1）             ├─ .env 加 4 个变量
├─ Nginx 443 终止 TLS                      │   GITHUB_ACCEL_BASE_URL=https://gh.example.com
├─ ACCEL_SECRET=<32+ 字符>                  │   GITHUB_ACCEL_SECRET=<同一段>
├─ ACCEL_GUEST_BYTES_PER_SECOND=10485760   │   GITHUB_ACCEL_TIMEOUT_MS=8000（可选）
├─ ACCEL_MEMBER_BYTES_PER_SECOND=104857600 │   GITHUB_ACCEL_TICKET_TTL_MINUTES=30（可选）
└─ ACCEL_CACHE_DIR=/data/cache             └─ 重启 API：sudo ./deploy/manage.sh restart
```

部署完按第 2.5 节四条自检、再走第 4 节验收清单。剩下的日常只需要看两件事：磁盘（缓存）和带宽（限速）。
