# WebDAV 云盘

WebDAV 云盘让管理员和注册用户把本站空间挂载到 Windows 资源管理器、macOS Finder、手机文件管理器或 rclone，像本地磁盘一样上传、下载和管理文件。本文介绍挂载地址、账号与配额规则、各平台挂载步骤和常见问题；设计与接口契约见 [WebDAV 云盘设计](superpowers/specs/2026-11-11-webdav-drive-design.md)。

## 功能说明

- 所有文件操作通过标准 WebDAV 协议完成，支持 `OPTIONS`、`PROPFIND`（Depth 0/1/infinity）、`GET`、`HEAD`、`PUT`、`DELETE`、`MKCOL`、`MOVE`、`COPY`、`LOCK`、`UNLOCK` 和 `PROPPATCH`。
- 账号直接复用站点现有账号，不需要额外注册或配置密码。
- 网页端提供同款文件管理器：用户入口 `/user/drive`，管理员入口 `/admin/webdav`，可以浏览、上传、下载、新建文件夹、重命名、删除和查看配额，并显示当前站点的挂载地址与教程。
- 根目录 `/` 是虚拟目录，不会写入数据库；根目录下就是该账号自己的第一层文件和文件夹。
- 文件正文保存在站点配置的存储位置（服务器本地磁盘或 Cloudflare Worker/R2），MySQL 只保存路径、大小、ETag 等元数据。
- 文件夹不占用存储空间；配额只按文件字节数计算。
- `GET` 支持单段 `Range` 请求，并支持 `If-None-Match`/ETag 校验，同一文件可以分段读取。
- `.`、`..`、反斜杠和控制字符等非法名称会被拒绝；文件名统一使用 Unicode NFC 归一化。

## 挂载地址

| 环境 | 挂载地址 |
| --- | --- |
| 生产（HTTPS） | `https://你的域名/dav` |
| 开发（API 直连） | `http://localhost:5180/dav` |
| 开发（Vite 代理） | `http://localhost:5174/dav` |

- 生产环境由 `deploy/manage.sh` 生成的 nginx 配置把 `/dav` 与 `/dav/` 反向代理到 API；开发环境 Vite 也会把 `/dav` 代理到 `http://localhost:5180`。
- 大多数客户端会自动补全末尾的 `/`。如果连接异常，可显式填写 `https://你的域名/dav/`。
- 网页端云盘页面会显示完整挂载地址和当前账号的用户名，可直接复制。
- 管理员和注册用户使用同一个挂载地址，用不同账号登录即可进入各自的空间，彼此不可见。

## 账号规则

| 身份 | 用户名 | 密码 | 空间 |
| --- | --- | --- | --- |
| 管理员 | `admin_users.username`（后台登录名） | 管理员密码 | 独立 2GB |
| 注册用户 | `comment_users.account` 或注册邮箱 | 用户密码 | 与用户空间共享 30MB / 50MB |

- 认证方式为 HTTP Basic Auth（`Authorization: Basic ...`），认证域为 `Jayson Blog WebDAV`。
- 系统先按管理员用户名查找并校验；失败后再按注册用户的账号或邮箱校验。
- 同名规则：如果注册用户的账号与某个管理员用户名相同，管理员身份优先。若两边密码不同，输入注册用户密码仍会按注册用户登录（管理员校验失败后会回退到注册用户）。
- 注册用户能否使用云盘由「站点设置 → 功能开关」中的 WebDAV 云盘（`webdavEnabled`）控制；关闭后注册用户无法认证，管理员始终可用。
- 账号被停用或封禁时无法通过认证；修改密码后，已保存凭据的客户端需要重新输入。
- 一个账号可以同时在多台设备挂载，但多个客户端同时写同一个文件可能触发 `423 Locked`，建议同一时间只在一个客户端编辑。

## 配额

- 注册用户：与现有用户空间共用一份配额。
  - 存储位置为「本站服务器」时上限 30MB；
  - 存储位置为「Cloudflare」时上限 50MB。
  - 图床图片、剪贴板文本、头像、个人贴纸和云盘文件全部计入同一份已用空间，文件夹本身不占空间。
- 管理员：独立配额，上限 2GB，与注册用户的 30MB / 50MB 互不影响。
- 超出配额的上传或写入返回 `507 Insufficient Storage`，网页端会提示剩余空间。
- 在 `/user/space`（用户）或后台用户空间页面可以看到已用字节、剩余空间和 `drive` 分类；云盘页面也显示配额条。
- 配额按文件实际字节数统计，不是字符数。

## 客户端挂载

### Windows 资源管理器

前置条件：

1. **使用 HTTPS**。Windows 的 WebDAV 重定向器默认只允许 HTTPS 下的 Basic 认证（`BasicAuthLevel=1`）；生产环境请使用 `https://`。
2. 启动 `WebClient` 服务：打开「服务」（`services.msc`），找到 `WebClient`，把启动类型设为「自动」并启动。
3. 证书必须被系统信任。自签名证书会导致连接失败。

步骤：

1. 打开「此电脑」，在工具栏或右键菜单中选择「映射网络驱动器」（也可以选择「添加网络位置」）。
2. 地址填写 `https://你的域名/dav`。
3. 勾选「使用其他凭据连接」，输入账号和密码。
4. 完成后「此电脑」会出现一个网络位置，可以像本地文件夹一样拖放文件。
5. 也可以在 PowerShell 或 CMD 中挂载：

```powershell
net use Z: https://你的域名/dav /user:你的账号 你的密码
```

断开：`net use Z: /delete`。

大文件限制：Windows WebDAV 客户端默认限制单文件约 50,000,000 字节（约 47.7MB），不同版本可能不同。如需上传更大的文件（例如管理员 2GB 空间中的大文件），把注册表 `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\WebClient\Parameters` 下的 `FileSizeLimitInBytes`（DWORD）改为 `4294967295`，然后重启 `WebClient` 服务。

如果必须用 HTTP（仅限本地开发或内网）：把同一位置下的 `BasicAuthLevel`（DWORD）改为 `2`，表示允许 HTTP 和 HTTPS 的 Basic 认证，然后重启 `WebClient` 服务。修改注册表有风险，生产环境必须使用 HTTPS。

### macOS Finder

1. 打开访达，菜单「前往」→「连接服务器」（快捷键 ⌘K）。
2. 输入 `https://你的域名/dav`，点「连接」。
3. 选择「注册用户」，输入账号和密码；可以勾选「在我的钥匙串中记住此密码」。
4. 连接成功后，卷会出现在访达边栏和 `/Volumes` 下，可以像普通文件夹一样使用。
5. 如果提示证书无效或认证失败，先检查域名证书是否受信任；旧的错误凭据可以在「钥匙串访问」中删除后重试。

### iOS / Android

iOS 自带的「文件」App 不支持 WebDAV，需要第三方客户端；Android 也需要支持 WebDAV 的文件管理器。

**ES 文件浏览器（Android）**

1. 打开侧边栏，选择「网络存储」→「添加」。
2. 选择「WebDAV」，填写地址 `https://你的域名/dav`、账号和密码。
3. 保存后即可浏览、上传、下载和重命名。不同版本的 ES 文件浏览器菜单名称可能略有差异，找不到时在「网络」或「存储」分类下查找。

**Documents by Readdle（iOS / Android）**

1. 底部「连接」或「添加账户」→「添加连接」→「WebDAV」。
2. 填写地址 `https://你的域名/dav`、账号和密码，保存。
3. 在「我的文件」中打开该连接即可操作。

手机系统通常禁止明文 HTTP（Android 9+ 默认禁止 cleartext，iOS 有 ATS），请使用 HTTPS。开发环境的 `http://localhost:5180/dav` 只适合本机或模拟器调试。

### rclone

交互式配置：

```text
rclone config
# n) New remote
# name> myblog
# Storage> webdav
# url> https://你的域名/dav
# vendor> other
# user> 你的账号
# pass> y            （输入密码，rclone 会以 obscured 形式保存）
# bearer_token>      （留空）
```

配置完成后先验证：

```bash
rclone lsd myblog:
rclone copy ./本地文件 myblog:
```

挂载：

```bash
# Windows（需要安装 WinFsp）
rclone mount myblog: Z: --vfs-cache-mode writes

# macOS / Linux（需要 macFUSE 或 fuse3）
rclone mount myblog: ~/myblog-dav --vfs-cache-mode writes
```

非交互式配置：

```bash
rclone config create myblog webdav url=https://你的域名/dav vendor=other user=你的账号
rclone config password myblog pass
```

`rclone config password` 会提示输入密码并以 obscured 形式保存，避免把明文密码写进命令历史。

### 其他客户端

RaiDrive、Cyberduck、Mountain Duck、Solid Explorer 等客户端同样支持 WebDAV：新建 WebDAV/HTTPS 连接，地址填 `https://你的域名/dav`，再填账号密码即可。

## 必须使用 HTTPS

- Basic Auth 只对账号密码做 Base64 编码，HTTP 明文传输等同于泄露密码。
- Windows 默认只允许 HTTPS 上的 Basic 认证，用 HTTP 必须改注册表并重启服务。
- 生产环境由 nginx 提供 Let's Encrypt 证书；挂载前先确认浏览器能正常打开 `https://你的域名/api/health`。
- 开发环境的 `http://localhost:5180/dav` 仅用于本机调试，不要暴露到公网。

## 反向代理与部署

`deploy/manage.sh` 在生成 HTTP 和 HTTPS 两个 server 块时都会写入 `/dav` 与 `/dav/` 的 location，部署或更新后无需手工改 nginx：

- `proxy_pass` 到与 `/api/` 相同的 API 地址（默认 `http://127.0.0.1:5180`）；
- `client_max_body_size 2200m`，与管理员文件网盘一致；
- `proxy_request_buffering off` 和 `proxy_buffering off`，大文件和慢速客户端不会被 nginx 落盘缓冲；
- `proxy_read_timeout 7200s`、`proxy_send_timeout 7200s`，避免长传输中途 504；
- `proxy_http_version 1.1` 和 `Connection ""`，支持长连接与流式读写；
- 不限制 HTTP 方法，`PROPFIND`、`MKCOL`、`MOVE`、`LOCK`、`UNLOCK` 等 WebDAV 方法会原样转发到 API；
- 没有 `proxy_cache`，文件内容不会被缓存。

`http://` 的裸域名会 301 到 HTTPS；`/dav` 和 `/dav/` 都会直接代理到 API，不依赖重定向。修改 nginx 后执行：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

如果重新部署，运行 `deploy/manage.sh update`（脚本会重新生成配置、校验并重载）。不要直接编辑服务器上的 `/etc/nginx/sites-available/` 文件，下次部署会被覆盖。

## 常见问题

### 401 Unauthorized：认证失败或反复弹出密码框

- 确认账号和密码正确；注册用户可以用注册账号或邮箱登录，密码与网页登录相同。
- 如果注册账号与管理员用户名相同，系统会先按管理员校验；密码不同时会回退到注册用户。若仍失败，建议把注册账号改成不与管理员重名的名称。
- 检查「站点设置 → 功能开关」中的 WebDAV 云盘开关是否已打开；关闭时注册用户会被拒绝，管理员不受影响。
- 账号被停用/封禁、或密码刚修改过，需要重新输入凭据。
- Windows 用户确认使用 HTTPS、`WebClient` 服务已启动，并清理「凭据管理器 → Windows 凭据」中的旧条目。
- 用 curl 快速验证：

```bash
curl -i -u '账号:密码' -X OPTIONS https://你的域名/dav/
```

返回 `2xx` 且带 `DAV` 或 `Allow` 响应头说明认证通过；返回 `401` 则是凭据或开关问题（响应头会包含 `WWW-Authenticate: Basic realm="Jayson Blog WebDAV", charset="UTF-8"`）。

### 423 Locked：文件被锁定

- WebDAV 用 LOCK/UNLOCK 防止多人同时编辑。Office 打开文件、客户端崩溃或网络中断时，锁可能没有正常释放。
- 锁的默认有效期是 3600 秒（1 小时），等待过期后重试即可；也可以断开所有挂载了该目录的客户端，再重新连接。
- 多个客户端同时写同一个文件很容易触发 423，建议同一时间只在一个客户端编辑。
- 网页端对同一路径的写入、重命名、删除和移动也可能返回 423，等锁过期后再操作。
- 如果客户端一直显示文件被占用，先关闭 Word/Excel 等打开该文件的程序，再重试。

### 507 Insufficient Storage：空间不足

- 注册用户与图床、剪贴板、头像、贴纸共享 30MB（本地）或 50MB（Cloudflare）配额；管理员有独立 2GB。
- 打开 `/user/space` 或云盘页面查看已用空间和 `drive` 分类，删除不需要的文件释放空间；空文件夹不占空间。
- 配额按文件实际字节计算；一次上传超过剩余空间会直接返回 507，而不是截断保存。
- 如果刚删除文件仍提示空间不足，刷新页面或重新挂载客户端后再试（客户端可能缓存了旧状态）。

### 中文文件名乱码

- 服务端以 UTF-8 保存文件名，并在写入时做 NFC 归一化；macOS 习惯使用 NFD，文件名在两端显示可能有细微差异，这不属于乱码。
- Windows 资源管理器使用 Unicode，一般不会乱码。出现乱码时优先改用 rclone、Cyberduck 等明确使用 UTF-8 的客户端，或检查旧客户端的编码设置。
- 避免在文件名中使用控制字符、反斜杠、`.`、`..`；文件名最长 255 字符、路径最长 700 字符，超长会被拒绝。
- 如果只有部分中文变成问号，通常是客户端编码问题，不是服务端存储问题。

### nginx 413 Request Entity Too Large

- 生成的 `/dav/` 配置允许 2200m；其他路径（例如静态页面 location）仍是 64m。
- 常见原因：服务器上还是旧配置（没有重新部署或重载）、前面还有一层 nginx/CDN 且其上限更小、或用了 `/api/` 下的普通上传接口。
- 处理：重新运行 `deploy/manage.sh update`，或手动执行 `sudo nginx -t && sudo systemctl reload nginx` 后重试。
- 如果经过 Cloudflare 代理，免费版单次上传上限是 100MB；管理员的大文件建议直连源站或在 DNS 中关闭代理（灰云）。

### 504 Gateway Timeout / 上传中断

- `/dav/` 已把 `proxy_read_timeout` 和 `proxy_send_timeout` 调到 7200s，并关闭请求缓冲。
- 如果前面还有 Cloudflare 等 CDN，免费版源站响应超过 100 秒会返回 524/504；大文件传输建议关闭 CDN 代理或使用直连地址。
- 检查服务器磁盘空间、API 服务状态（`systemctl status jayson-blog`、`journalctl -u jayson-blog -n 100`）和 nginx 错误日志。
- 客户端自身也有超时设置，rclone 可以加 `--timeout 10m` 放宽空闲超时。

### Windows 提示「无法连接到网络文件夹」

按顺序排查：

1. 启动 `WebClient` 服务（`services.msc`），启动类型设为「自动」；修改配置后执行 `net stop webclient && net start webclient`（管理员权限）。
2. 确认使用 `https://`；Windows 默认拒绝 HTTP 下的 Basic 认证。必须用 HTTP 时按上文修改 `BasicAuthLevel=2`。
3. 确认 HTTPS 证书受信任；自签名证书会失败。
4. 地址末尾可显式加 `/`，即 `https://你的域名/dav/`，排除重定向兼容问题。
5. 先用浏览器访问 `https://你的域名/api/health`，排除 DNS、防火墙和端口问题；公司网络可能封锁 443 或 WebDAV 方法。
6. 清理「凭据管理器 → Windows 凭据」中保存的错误密码。
7. 上传大文件失败时，检查 `FileSizeLimitInBytes` 是否仍是约 50MB 的默认值。
8. 常见错误码：`0x80070035` 通常是找不到网络路径（DNS/端口/URL），`0x80070005` 是拒绝访问（凭据或权限），`0x80070043` 是找不到网络名。

### 其他问题

- `405 Method Not Allowed`：确认服务器已加载最新 nginx 配置（`/dav/` 不会限制 WebDAV 方法）；如果前面还有 CDN 或 WAF，它们可能拦截 `PROPFIND`、`LOCK` 等非标准方法，需要在 CDN/WAF 中放行。
- 只能读不能写：检查配额是否已满、文件是否被锁定，以及是否用了同一个账号的多台设备。
- 网页端和客户端的已用空间不一致：配额按字节统计且文件夹不占空间，客户端可能缓存了旧状态，重新连接即可。

## 安全建议

- 始终使用 HTTPS；Basic Auth 凭据等同于账号密码。
- 管理员账号权限大，日常同步建议使用普通注册用户账号；确实需要 2GB 空间时再用管理员账号。
- 使用强密码；不要把带密码的挂载命令写进公开脚本、截图或仓库。
- 定期在网页端检查配额和文件内容，删除不再需要的数据。
- 怀疑凭据泄露时立即修改密码，旧客户端需要重新输入。

## 本地验证

改动 WebDAV 相关代码后，建议按下面三步自检：

1. `pnpm --filter @jayson-blog/api type-check`：服务端类型检查。
2. `pnpm --filter @jayson-blog/api test:webdav`：路径归一化、面包屑、锁超时与锁令牌解析的单元测试（`apps/api/test/webdav-path.test.ts`）。
3. 端到端冒烟：先 `pnpm --filter @jayson-blog/api build`，再用独立端口启动服务（例如 `API_PORT=5190 node apps/api/dist/server.js`），最后另开一个终端执行 `node apps/api/test/webdav-e2e.mjs`。脚本会建临时账号 `davcheckadmin` / `davcheckuser`，依次验证 OPTIONS、PROPFIND、匿名与错误密码 401、MKCOL、PUT、GET/HEAD、Range、LOCK → 423 → 带 `If` 令牌写入 → UNLOCK、MOVE、COPY、DELETE，以及用户端与管理员端的 JSON 接口和 2GB 配额；断言 50 项，结束时自动删除临时账号、文件树记录和磁盘上的文件，失败时也会清理。`WEBDAV_E2E_BASE` 可指向其它地址。

注意：端到端脚本直接读写真实数据库和 `uploads/user-space`，请仅在开发环境运行。

## 相关文档

- [WebDAV 云盘设计](superpowers/specs/2026-11-11-webdav-drive-design.md)
- [用户工具与共享空间](user-tools-and-space.md)
- [部署说明](../deploy/DEPLOYMENT.md)
