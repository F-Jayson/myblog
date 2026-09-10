# Firefly Headless

基于当前 Firefly 站点视觉重建的前后端分离博客项目。原站仍保留在相邻的 `Firefly` 目录中，本项目独立使用 pnpm 工作区：

```text
apps/web   React + Vite，负责路由、主题、壁纸和页面组件
apps/api   Express + TypeScript，负责 REST API、MySQL 访问和 Docker 编译沙箱
database   MySQL 迁移与演示种子数据
```

## 启动

环境要求：Node.js 22+、pnpm 11+、MySQL 8+。在线编译器还需要本机 Docker Engine/Desktop；没有 Docker 时博客其他页面仍可正常启动。

```powershell
pnpm install
Copy-Item .env.example .env
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Windows 也可以直接双击根目录中的 `start.bat`。它优先使用 PowerShell 7，自动安装锁定版本的依赖、对已配置且可连接的 MySQL 自动执行幂等的 schema 迁移、构建前端和 API，然后启动两个开发服务；首次运行时会由 `.env.example` 创建本地 `.env`。启动脚本不会自动写入演示种子数据。启动成功后窗口会保留并显示首页、管理员后台、API 和健康检查地址，按任意键即可关闭提示窗口，后台服务不会停止。停止时双击 `stop.cmd`。PowerShell 用户可以使用：

```powershell
.\start.ps1 -OpenBrowser
.\stop.ps1
```

如果需要自动启动 Docker MySQL 并执行迁移、种子数据初始化：

```powershell
.\start.ps1 -DockerMySql -Database -OpenBrowser
```

依赖已安装或只想跳过构建时，可以分别使用 `-SkipInstall` 和 `-SkipBuild`。`-Database` 额外执行 `pnpm db:seed`，因此仅应在需要导入或重置演示内容时使用。若本地 MySQL 未启动，普通启动会跳过迁移并以可预览的前端演示模式继续启动；数据库恢复后执行 `pnpm db:migrate`，或再次运行启动脚本即可。启动日志写入 `logs/`，运行中的进程 PID 保存在 `.firefly-run/`。

前端默认运行在 `http://localhost:5174`，API 默认运行在 `http://localhost:5180`。启动脚本会在端口被占用时明确提示，避免前端代理地址不一致。

登录后可在 `/tools/compiler` 使用在线编译器。工具支持 JavaScript/TypeScript、Python、Java、C/C++、C#、Go、Rust、PHP、Ruby、Kotlin、Swift 和 Bash，代码高亮、格式化、标准输入以及双击行号断点调试均在同一页面完成；Python、JavaScript 和 TypeScript 提供真实行追踪，其它语言返回断点元数据和运行诊断。代码执行由 API 调用网络隔离的 Docker 一次性容器完成；未登录用户和被管理员关闭的功能开关都会在前端与 API 两层被拒绝。

没有配置数据库时，前端会使用内置演示数据保持页面可预览；配置 MySQL 后，启动脚本会先更新数据库 schema（包括后台公告历史所需的表），再由 API 读取文章、分类、标签、动态和评论。

## 部署

开发环境中的 `/api` 请求由 Vite 转发到 `API_PROXY_TARGET`。生产环境可以将同源的 `/api` 反向代理到 Express；如果前端和 API 分别部署，则在构建前设置 `VITE_API_ORIGIN` 为 API 的完整来源，例如 `https://api.example.com`，并把 API 的 `CLIENT_ORIGIN` 设为前端站点来源。`VITE_API_ORIGIN` 会在构建时写入前端资源。

## MySQL

也可以使用项目附带的 Docker Compose：

```powershell
Copy-Item .env.docker.example .env
```

启动容器前，必须先编辑 `.env`，将 `MYSQL_PASSWORD` 设置为唯一的高强度密码。请保留单引号，例如 `MYSQL_PASSWORD='a-unique-$password'`；这样 Compose、启动脚本和 Node 读取到的特殊字符含义一致。然后执行：

```powershell
docker compose up -d --wait --wait-timeout 120 mysql
pnpm db:migrate
```

需要演示内容时再单独执行 `pnpm db:seed`。Compose 只负责创建数据库和专用应用用户，不会自动执行 `database/schema.sql` 或 `database/seed.sql`。`pnpm db:migrate` 和 `pnpm db:seed` 都不会创建或修改管理员凭据。请运行下列命令，并按隐藏提示输入两次唯一的高强度密码：

```powershell
pnpm --filter @firefly-rebuild/api exec tsx src/cli.ts set-admin-password
```

命令会创建或更新 `admin` 账号。登录成功后，前端会在当前浏览器会话中保存短期 session，并通过 `Authorization: Bearer <session>` 调用管理接口。生产环境请通过 HTTPS 访问管理后台，并按部署规范保管凭据。

`-DockerMySql` 启动或复用的是持久开发数据库。`stop.ps1` 只停止 API 和前端进程；数据库会继续运行，便于重启和排障。需要停止数据库时执行 `docker compose stop mysql`，该命令不会删除数据卷。

为兼容旧版本，设置了非 `change-me` 的 `ADMIN_API_TOKEN` 时仍可使用旧令牌登录；新部署建议删除该配置，统一使用数据库账号体系。

## 后台管理

启动项目后访问 `http://localhost:5174/admin/login`，输入管理员账号和密码即可进入后台。管理界面支持：

- 仪表盘统计与快捷入口
- 文章新建、编辑、Markdown 预览、草稿/发布、置顶、分类和标签
- 分类、标签和动态的增删
- 评论审核、标记垃圾和删除
- 站点标题、副标题、描述和主题色相配置
- 头图上传、图床链接和图片 API
- 一言副标题、标题/文章字体文件、音乐和作者资料配置
- 动态发布、编辑、删除及图片上传
- 管理员账号新增、编辑、停用、删除和重置密码（当前登录账号受保护）

登录 session 只保存在当前浏览器会话中，退出登录时会撤销服务端 session。

## 页面与接口

前端包含首页、文章详情、归档、分类、标签、搜索、关于、友链、留言板、动态、相册、书签导航和打赏页面。API 提供：

```text
GET  /api/health
GET  /api/site
GET  /api/posts?page=&pageSize=&category=&tag=&q=
GET  /api/posts/:slug
GET  /api/categories
GET  /api/tags
GET  /api/archive
GET  /api/dynamics
GET  /api/posts/:postId/comments
POST /api/comments
GET  /api/compiler/languages
POST /api/compiler/run
POST /api/compiler/debug
POST /api/compiler/format
POST /api/admin/login
POST /api/admin/logout
GET  /api/admin/me
GET/POST/PUT/DELETE /api/admin/accounts
POST /api/admin/accounts/:id/reset-password
GET  /api/admin/posts
POST /api/admin/posts
GET  /api/admin/posts/:id
PUT  /api/admin/posts/:id
DELETE /api/admin/posts/:id
GET/POST/PUT/DELETE /api/admin/categories
GET/POST/PUT/DELETE /api/admin/tags
GET/POST/PUT/DELETE /api/admin/dynamics
GET/PATCH/DELETE /api/admin/comments
GET/PUT /api/admin/site
```

文章正文以 Markdown 原文存储在 MySQL，React 端进行安全渲染；图片、壁纸、二维码和音乐继续作为静态资源存放，不写入数据库。

## 视觉迁移

新前端沿用原站的 `hue: 165` 薄荷绿主题变量、半透明圆角卡片、顶部壁纸横幅、波浪过渡、桌面三栏/移动端单栏布局、文章封面列表、侧栏小组件、亮暗模式和壁纸设置。原项目的壁纸、Logo、头像和文章封面已复制到 `apps/web/public/images`。
