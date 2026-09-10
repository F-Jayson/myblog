# Firefly React 生产部署

`deploy/manage.sh` 是 Firefly React 的 Debian/Ubuntu 单服务器部署入口。它统一管理安全同步、依赖安装、MySQL、Docker 编译沙箱、构建、systemd、Nginx 和 HTTPS。脚本需以 root 身份或具备 sudo 权限的用户运行：

```bash
chmod +x deploy/manage.sh
sudo ./deploy/manage.sh
```

也可直接执行某个命令，例如 `sudo ./deploy/manage.sh first`。首次部署前准备 Git 仓库地址、域名（HTTPS 时必需）、服务器公网 IP，以及云数据库模式所需连接信息。建议使用干净的 Debian 12 或 Ubuntu 22.04/24.04，保证 80、443 端口未被其他服务占用。

## 命令

| 命令 | 实际行为 |
| --- | --- |
| `first` | 收集配置与管理员密码，安装依赖，克隆代码，准备数据库，安装项目依赖、迁移、可选 seed、构建，并创建/启动 systemd 和 Nginx；可选申请 SSL。 |
| `pull` | 仅安全拉取并快进远程代码；不安装依赖、不迁移、不构建、不重启。 |
| `update` | 安全拉取，安装系统与 Node/pnpm 依赖，验证数据库，安装项目依赖、迁移、构建、更新服务/Nginx 并重启。 |
| `configure` | 重新收集并应用部署和数据库配置（包括数据库密码）；安装依赖、准备/验证数据库、迁移、构建、更新服务/Nginx 并重启。 |
| `status` | 查看 API、Nginx、本地健康检查和存在时的 Certbot 定时器状态。 |
| `start` | 启动 API 并等待健康检查成功。 |
| `stop` | 停止 API。 |
| `restart` | 重启 API 并等待健康检查成功。 |
| `logs` | 跟随查看 API 的 systemd 日志。 |
| `migrate` | 单独验证数据库并执行迁移；若 systemd 服务已存在，随后会重启 API。 |
| `ssl` | 申请/续用 Let's Encrypt 证书，启用 HTTPS 和自动续期，并执行续期演练。 |

不带命令时脚本显示交互菜单。常规发布使用 `update`；只想取得远程代码且不影响线上运行时使用 `pull`。

## 首次部署

首次部署会校验安装目录、仓库、分支、域名、端口、数据库标识符和服务用户。应用目录仅允许位于 `/var/www`、`/srv` 或 `/opt` 下。API 监听 `127.0.0.1` 上配置的端口，默认端口为 `5180`，公网流量由 Nginx 转发。

脚本固定使用 Node.js 22 和 pnpm `11.22.0`。它会安装 Git、curl、CA 证书、GnuPG、OpenSSL、编译工具、Nginx、Docker、MySQL 客户端和 `util-linux`；本地数据库模式还会安装默认 MySQL 服务端。因此目标服务器需能访问系统软件源和 NodeSource。

在线编译器使用 Docker 作为执行边界。首次部署、更新和重新配置会启动 Docker daemon，将编译器服务用户加入 `docker` 组，并预拉取 JavaScript/TypeScript、Python、Java、C/C++、C#、Go、Rust、PHP、Ruby、Kotlin、Swift 和 Bash 镜像。每次任务仍由 API 以 `--network=none`、非 root 用户、只读根文件系统、临时 `/tmp`、CPU/内存/PID 和超时限制启动一次性容器；代码和标准输入不会写入数据库。请确保服务器允许安装 Docker 并有足够磁盘空间保存这些镜像。

首次部署必须以隐藏输入方式两次输入 `admin` 的初始密码。密码须为 12 至 128 位且不能含换行；脚本会先完成迁移和可选 seed，再通过 CLI 写入该密码并验证。seed 不会创建或修改管理员凭据。

向导默认**不**初始化演示数据。若选择初始化，脚本才执行 `pnpm db:seed`；seed 只写入演示内容，不包含任何管理员默认凭据。

## 配置文件与数据库密码

部署参数保存在：

```text
/etc/firefly-react/deploy.env
```

脚本创建 `/etc/firefly-react` 时设为 `700`，并将该文件设为 `600`。它保存应用路径、仓库、分支、域名、端口、运行用户、数据库模式和数据库非敏感连接参数；数据库密码、令牌和私钥不会写入其中。

应用运行时配置位于：

```text
<APP_DIR>/.env
```

脚本拒绝写入符号链接，原子写入此文件并设为 `600`，所有者是 API 服务用户。它包含数据库连接信息、应用端口与生产环境变量。为可靠表示任意复杂云数据库密码，脚本以 `MYSQL_PASSWORD_BASE64` 保存 Base64 编码的密码，而不是直接写入 `MYSQL_PASSWORD`。Base64 不是加密，文件权限才是保密边界；不要手工修改、提交、共享或记录其内容。

### 本地 MySQL

选择本地数据库后，脚本使用 `127.0.0.1:3306`，启动 MySQL/MariaDB，创建配置的数据库及专用应用账户，并授予该库权限。应用密码可留空由脚本生成；MySQL root 可使用 socket 登录，不能时需输入 root 密码。生产环境不要直接使用 `.env.example` 中的任何示例凭据（包括 `change-this-password`），也不要把 3306 暴露到公网。

### 云 MySQL

选择云数据库后，脚本不会创建实例或数据库，只收集主机、端口、数据库名、用户名和密码，并用目标库执行连接验证。数据库和拥有迁移权限的账户必须由云厂商或运维人员预先创建。安全组/防火墙应仅允许本服务器访问数据库端口；TLS、备份和高可用等设置按云厂商文档配置。

## 代码同步与持久化数据

首次克隆会先在应用父目录创建 `.firefly-react-clone.*` 临时目录，只有 `git clone` 成功后才移动到应用目录；克隆失败不会改动目标目录，可能留下临时目录供人工检查或删除。

已有仓库使用 fetch、切换目标分支和 `merge --ff-only` 同步。受 Git 跟踪文件有本地修改、分支已分叉或远程版本不匹配时会中止；脚本不使用 `git clean` 或破坏性 reset，也不删除未跟踪持久化数据。

上传文件位于 `<APP_DIR>/uploads`，用户空间位于 `<APP_DIR>/uploads/user-space`。脚本会为服务用户创建和授权这些目录；更新、重新配置和同步时不得删除它们或 `.env`。

`update` 与 `configure` 都运行 `pnpm install --frozen-lockfile`、`pnpm db:migrate` 和 `pnpm build`。迁移可能修改线上数据结构，务必在执行前备份数据库并选择合适维护窗口。

## 服务与 Nginx

systemd 服务运行 `<APP_DIR>/apps/api/dist/server.js`，工作目录是 `<APP_DIR>/apps/api`，环境文件是 `<APP_DIR>/.env`。服务以配置的非 root 系统用户运行，并仅允许写入 `<APP_DIR>/uploads` 与 `<APP_DIR>/.compiler-work`；后者是 Docker daemon 可见的临时编译工作目录。为启动 Docker 沙箱，服务还通过 `SupplementaryGroups=docker` 访问 Docker socket。排障时可使用：

```bash
sudo ./deploy/manage.sh status
sudo ./deploy/manage.sh logs
sudo systemctl status firefly-react
sudo journalctl -u firefly-react -n 200 --no-pager
```

Nginx 提供 `<APP_DIR>/apps/web/dist` 的静态文件，并把 `/api/` 反代到本机 API。站点配置以临时文件生成，先经独立及完整 `nginx -t` 校验，失败会恢复旧配置；上传请求体限制为 64 MB，并设置较长反向代理超时。

## HTTPS、webroot 与自动续期

在 DNS 的 A/AAAA 记录已解析到本机并且公网可访问 80 端口后执行：

```bash
sudo ./deploy/manage.sh ssl
```

脚本安装 `certbot`，不使用 Certbot 的 Nginx 插件。它先让 Nginx 在 `/.well-known/acme-challenge/` 提供 `/var/www/letsencrypt`，再通过 `certbot certonly --webroot` 申请或续用证书。首次无证书申请失败时，站点会保持 HTTP 可用；已有证书续期失败时，现有 HTTPS 配置不会被覆盖。

成功后脚本写入 HTTPS 配置、将 HTTP 跳转至 HTTPS、写入 Nginx 重载 deploy hook、启用 `certbot.timer`，重启 API 并执行 `certbot renew --dry-run`。可检查定时器：

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

证书申请失败通常是 DNS 未生效、80 端口被防火墙/其他 Web 服务拦截，或输入的不是裸域名。域名输入不得含协议、路径或端口。

## 备份与恢复

每次 `update`、`migrate`、大版本升级或数据库配置调整前，至少备份数据库和上传目录：

```bash
sudo mysqldump --single-transaction --routines --triggers -u <db_user> -p <db_name> > firefly-$(date +%F).sql
sudo tar -C <APP_DIR> -czf firefly-uploads-$(date +%F).tar.gz uploads
```

云数据库应优先启用快照、自动备份和时间点恢复，并保存独立逻辑备份。备份含用户数据，应加密、限制访问并放在独立存储；应定期演练恢复。恢复时先停止 API，恢复数据库和 `uploads/`，核对 `.env` 与权限，再启动服务并通过 `status` 或 `GET /api/health` 验证。

## 限制与安全边界

此脚本只支持 Debian/Ubuntu、apt 与 systemd 的单服务器部署，不替代多节点发布、容器编排、数据库高可用、对象存储、CDN/WAF 或监控告警。Windows 开发机不能实际执行 apt、systemd、Nginx 或 Certbot；首次部署必须在目标 Linux 服务器完成。

脚本不会替用户决定域名、DNS、云数据库权限、安全组、防火墙及备份保留策略。建议限制 SSH 登录，启用系统安全更新，保护 `/etc/firefly-react/deploy.env` 和 `<APP_DIR>/.env` 的读取权限，定期检查日志、磁盘空间、备份可恢复性和证书续期状态。
