# 智能体内容管理

这套工具让 Cursor 里的智能体直接管理已经部署的博客，效果接近连接 Notion：智能体调用本机工具写入文章，授权发生在浏览器里。管理员密码只提交给博客 API，不会进入聊天记录、MCP 进程或本机凭据文件。

## 组成

```text
Cursor 智能体
    │  MCP 工具
    ▼
packages/blog-mcp          本机进程，保存令牌并打开浏览器
    │  HTTPS，Authorization: Bearer ag_...
    ▼
apps/api  /api/agent/*     校验令牌、权限，写入 posts 表
apps/web  /agent/authorize 管理员登录并确认权限
apps/web  /admin/agents    查看和撤销授权
```

文章仍然以 Markdown 存在 MySQL 的 `posts` 表里。智能体不使用后台网页的 session，而是使用单独的 `agent_grants` 令牌。撤销智能体不会把正在使用的后台登录踢掉。

## 授权流程

1. 智能体调用 `blog_connect`。
2. MCP 向 `POST /api/agent/device/start` 申请一次待授权请求，得到公开的 8 位授权码和只留给本机轮询的 `deviceCode`。
3. MCP 打开 `CLIENT_ORIGIN` 上的 `/agent/authorize?code=授权码`。
4. 管理员在页面输入账号和密码。这个请求发往已有的 `POST /api/admin/login`。
5. 页面展示客户端名称、授权码和可勾选的权限。点「允许」后，API 签发 `ag_` 开头的令牌。
6. MCP 用 `deviceCode` 轮询 `POST /api/agent/device/token`，把令牌写入 `~/.jayson-blog/credentials.json`。
7. 如果这次登录是授权页新产生的，页面在允许或拒绝后会撤销该次后台 session。已经打开的后台标签页如果复用了原有 session，则保持登录。

待授权请求 10 分钟内有效。允许之后，令牌还保留 2 分钟供 MCP 取回。正式授权默认 90 天，可用环境变量 `AGENT_GRANT_DAYS` 调整，范围 1 到 365。

`deviceCode` 和访问令牌只存哈希。数据库里的明文令牌只存在于那 2 分钟的投递窗口，过期后清空。

## 权限

授权页会列出全部权限。智能体默认申请的权限会预先勾选。标为敏感的权限即使被申请，也保持未勾选，管理员可以单独允许，也可以额外勾选这次没有申请的权限。勾选发布或管理类权限时，会自动带上完成该操作所需的读取和写入权限。

| 权限 | 敏感 | 能做的事 |
| --- | --- | --- |
| `posts:read` | 否 | 读取文章、分类和标签 |
| `posts:write` | 否 | 创建和更新文章、分类、标签；把智能体同步的文章转回草稿 |
| `posts:publish` | 是 | 发布、撤回或修改任何文章 |
| `posts:delete` | 是 | 删除任何文章 |
| `media:write` | 否 | 上传 jpeg、png、gif、webp、avif，单张不超过 8MB |
| `taxonomy:manage` | 是 | 修改或删除分类和标签 |
| `comments:read` | 否 | 读取评论，不返回原始 IP 和浏览器标识 |
| `comments:moderate` | 是 | 通过、标记垃圾或删除评论 |
| `content:read` | 否 | 读取动态、页面、更新日志、公告和反馈 |
| `content:write` | 否 | 保存更新日志草稿、公告草稿，处理反馈状态 |
| `content:publish` | 是 | 发布公告和更新日志，编辑会立即公开的动态和页面 |
| `content:delete` | 是 | 删除动态、页面自定义内容、更新日志、公告和反馈 |
| `site:read` | 否 | 查看站点概况、功能开关和作者资料 |
| `site:write` | 是 | 修改站点外观、作者资料、功能开关和评论开关 |
| `users:read` | 否 | 查看前台用户 |
| `users:manage` | 是 | 修改昵称、停用或删除前台用户 |

默认申请读取文章、写入草稿、上传图片、读取站点内容和读取站点设置。已经连上的授权不会自动获得新权限，需要断开后重新连接，再在授权页确认。

新文章在没有传入 `status` 时保存为草稿。更新时如果不传 `status`，保持文章当前的发布状态。不传摘要时，会根据正文重新生成摘要。已经发布的文章被修改时，仍然需要发布权限。

以下操作故意不向智能体开放：后台管理员账号的创建和改密、前台用户密码重置、邮件密码和其他密钥、清空审计日志、网盘分片上传，以及用户剪贴板和私有文件的内容。

新文章在没有传入 `status` 时保存为草稿。更新时如果不传 `status`，保持文章当前的发布状态。不传摘要时，会根据正文重新生成摘要。

相同管理员下，同一个 `externalKey` 始终对应同一篇文章。再次同步会更新原文。内容、摘要、slug、封面、分类、标签、置顶和状态都没有变化时，接口返回 `unchanged`，不写数据库。

## 数据表

`pnpm db:migrate` 会执行 `database/schema.sql` 里新增的四张表：

- `agent_device_requests`：一次浏览器授权请求。
- `agent_grants`：发给智能体的令牌哈希、权限、过期时间和撤销时间。
- `agent_documents`：管理员、外部编号和文章 id 的对应关系。
- `agent_audit`：授权、写入、发布、删除和上传记录。正文不写入这张表。

`/api/agent/*` 也不进入通用 `audit_logs`，避免把 Markdown 和一次性设备码记进请求日志。

## HTTP 接口

除设备码轮询和授权页读取外，内容接口都要求 `Authorization: Bearer ag_...`。

```text
POST /api/agent/device/start
POST /api/agent/device/token
GET  /api/agent/device/:userCode
POST /api/agent/device/:userCode/approve
POST /api/agent/device/:userCode/deny
GET  /api/agent/me
POST /api/agent/revoke
GET  /api/agent/posts?q=&status=&page=&pageSize=
GET  /api/agent/posts/lookup?id=&slug=&externalKey=
GET  /api/agent/posts/:id
POST /api/agent/posts
POST /api/agent/posts/:id/publish
POST /api/agent/posts/:id/unpublish
DELETE /api/agent/posts/:id
GET/POST /api/agent/categories
PUT/DELETE /api/agent/categories/:id
GET/POST /api/agent/tags
PUT/DELETE /api/agent/tags/:id
POST /api/agent/images
GET /api/agent/comments
POST /api/agent/comments/:id/status
DELETE /api/agent/comments/:id
GET/POST /api/agent/dynamics
PUT/DELETE /api/agent/dynamics/:id
GET /api/agent/pages
GET/DELETE /api/agent/pages/:page
PUT /api/agent/pages
GET/POST /api/agent/changelogs
PUT/DELETE /api/agent/changelogs/:id
GET/POST /api/agent/announcements
PUT/DELETE /api/agent/announcements/:id
PATCH /api/agent/announcements/:id/display
POST /api/agent/announcements/:id/publish
GET /api/agent/feedback
POST /api/agent/feedback/:id/status
DELETE /api/agent/feedback/:id
GET/PATCH /api/agent/site
PATCH /api/agent/features
PATCH /api/agent/comment-settings
GET /api/agent/users
PATCH/DELETE /api/agent/users/:id
GET  /api/admin/agent-grants
DELETE /api/admin/agent-grants/:id
GET  /api/admin/agent-audit
```

创建或更新文章：

```json
{
  "externalKey": "docs/架构.md",
  "title": "架构",
  "content": "# 架构\n\n正文",
  "categories": ["项目文档"],
  "tags": ["设计"],
  "status": "draft"
}
```

成功时 `action` 为 `created`、`updated` 或 `unchanged`。权限不足返回 `403`，`error` 为 `insufficient_scope`。

旧版 `ADMIN_API_TOKEN` 不能用来批准智能体。批准人必须是 `admin_users` 里的账号。

## MCP 工具

包名是 `@jayson-blog/mcp`，入口是 `packages/blog-mcp/src/index.ts`。它直接使用 MCP 的 stdio 协议，运行时不依赖第三方包。

| 工具 | 作用 |
| --- | --- |
| `blog_status` | 查看是否已授权 |
| `blog_connect` | 打开授权页并等待确认。`force: true` 会先撤销再重来 |
| `blog_disconnect` | 撤销本机令牌 |
| `blog_list_posts` / `blog_get_post` | 搜索和读取文章 |
| `blog_upsert_post` | 写入一篇文章，可传正文或本机 `path` |
| `blog_sync_markdown` | 同步多个文件或一个目录，跳过 `node_modules`、`dist`、`.git` |
| `blog_publish_post` / `blog_unpublish_post` | 更改文章发布状态。撤回后台文章需要发布权限 |
| `blog_delete_post` | 删除文章，包含后台手工创建的文章 |
| `blog_upload_image` | 上传本机图片或 base64 |
| `blog_list_categories` / `blog_ensure_category` | 查看或补齐分类 |
| `blog_update_category` / `blog_delete_category` | 修改或删除分类 |
| `blog_list_tags` / `blog_ensure_tag` | 查看或补齐标签 |
| `blog_update_tag` / `blog_delete_tag` | 修改或删除标签 |
| `blog_list_comments` / `blog_moderate_comment` / `blog_delete_comment` | 读取、审核和删除评论 |
| `blog_list_dynamics` / `blog_save_dynamic` / `blog_delete_dynamic` | 读取、发布和删除动态 |
| `blog_list_pages` / `blog_get_page` / `blog_save_page` / `blog_delete_page` | 管理关于、传送和问题总结页面 |
| `blog_list_changelogs` / `blog_save_changelog` / `blog_delete_changelog` | 管理更新日志 |
| `blog_list_announcements` / `blog_save_announcement` / `blog_publish_announcement` / `blog_delete_announcement` | 管理公告草稿和发布 |
| `blog_list_feedback` / `blog_update_feedback` / `blog_delete_feedback` | 处理访客反馈 |
| `blog_site_overview` / `blog_update_site` / `blog_update_features` / `blog_update_comment_settings` | 查看或修改站点设置 |
| `blog_list_users` / `blog_update_user` / `blog_delete_user` | 查看或管理前台用户 |

`blog_connect` 会在工具内部最多等待 8 分钟。超时后授权请求仍保留在本机，再次调用会打开同一个页面并继续等待。

## 接入 Cursor

先构建 MCP：

```powershell
pnpm install
pnpm --filter @jayson-blog/mcp build
```

开发环境可以在 `.cursor/mcp.json` 里指向本机或已部署的 API：

```json
{
  "mcpServers": {
    "jayson-blog": {
      "command": "node",
      "args": ["./packages/blog-mcp/dist/index.js"],
      "env": {
        "BLOG_ORIGIN": "http://127.0.0.1:5180"
      }
    }
  }
}
```

连接已部署的博客时，把 `BLOG_ORIGIN` 改成能够访问 `/api/agent/*` 的源，不要带路径，也不要写密码。授权页地址来自 API 的 `CLIENT_ORIGIN`，所以生产环境里它必须是浏览器能打开的前台地址。前台和 API 分离部署时，前台构建使用 `VITE_API_ORIGIN`，API 的 `CLIENT_ORIGIN` 填前台地址。

数据库变更随平时的迁移一起生效：

```powershell
pnpm db:migrate
```

本地还需要前台在 `http://localhost:5174` 运行，否则授权页打不开。管理员账号仍然用：

```powershell
pnpm --filter @jayson-blog/api exec tsx src/cli.ts set-admin-password
```

连上之后可以这样说：「把 `docs/` 里的 Markdown 同步到博客，分类用项目文档，先存成草稿。」智能体若尚未授权，会打开浏览器。

## 安全约束

- 密码只出现在授权页到 `/api/admin/login` 的请求里。
- 智能体令牌和后台 session 分开存储，权限按 scope 检查。
- 令牌可以在「智能体授权」页撤销，也可以由 `blog_disconnect` 撤销。
- 设备授权请求按 IP 限制为 10 分钟内 20 次，轮询间隔 5 秒。
- 单篇正文上限 150 万字符，单张图片上限 8MB。
- 生产环境通过 HTTPS 访问授权页和 API。
