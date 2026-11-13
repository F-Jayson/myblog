# WebDAV 云盘设计（管理员 + 注册用户 + 网页文件管理器）

日期：2026-11-11
状态：实施中

## 目标

- 管理员与注册用户都能用任意 WebDAV 客户端（Windows 资源管理器、macOS Finder、RaiDrive、ES 文件浏览器、rclone 等）挂载本站的独立云盘空间。
- 复用现有账号体系（`admin_users` / `comment_users`）与用户配额（30MB 本地 / 50MB Cloudflare）。
- 提供 Firefly 风格的网页文件管理器（浏览、上传、下载、新建文件夹、重命名、删除、配额展示、挂载教程），用户入口 `/user/drive`，管理员入口 `/admin/webdav`。
- 不破坏现有 `/api/admin/drive`（管理员公共下载网盘）与 `/api/user/space`（用户空间统计）。

## 挂载端点

- 统一入口：`/dav`（Basic Auth）。
  - 先按 `admin_users.username` 校验管理员；失败再按 `comment_users.account`（或邮箱）校验注册用户。同名时管理员优先，文档中说明。
  - 成功返回 `DAV: 1, 2`（支持 LOCK/UNLOCK）。
  - 用户侧受功能开关 `webdavEnabled` 控制；管理员始终可用。
- 生产环境由 nginx 反代到 API（5180）；开发环境 Vite 把 `/dav` 代理到 5180。
- 路径语义：根 `/` 为虚拟目录（不入库），其子节点是用户的顶层文件/文件夹；路径使用 NFC 归一化，禁止 `.`、`..`、反斜杠与控制字符。

## 数据模型

```sql
CREATE TABLE IF NOT EXISTS drive_nodes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_type ENUM('admin','user') NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  path VARCHAR(700) NOT NULL,
  name VARCHAR(255) NOT NULL,
  node_type ENUM('file','folder') NOT NULL DEFAULT 'file',
  storage_key VARCHAR(255) NOT NULL DEFAULT '',
  mime_type VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  etag CHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_drive_nodes_owner_path (owner_type, owner_id, path),
  KEY idx_drive_nodes_parent (owner_type, owner_id, parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS drive_locks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_type ENUM('admin','user') NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  path VARCHAR(700) NOT NULL,
  lock_token CHAR(64) NOT NULL,
  lock_owner VARCHAR(255) NOT NULL DEFAULT '',
  depth VARCHAR(16) NOT NULL DEFAULT 'infinity',
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_drive_locks_path (owner_type, owner_id, path),
  KEY idx_drive_locks_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- 文件内容仍保存在 `uploads/user-space/`（或 Cloudflare Worker/R2），对象键为扁平唯一文件名 `dav-<ownerType>-<ownerId>-<uuid>.<ext>`，通过 `storage_key` 关联；文件夹不占存储。
- 用户配额：`lockedUserUsage` 增加 `drive_nodes`（owner_type='user'）字节合计，`getUserSpace` 的 `categories` 增加 `drive`，`usedBytes` 一并计算。管理员配额独立，上限 2GB（复用 `ADMIN_DRIVE_MAX_BYTES`）。
- 删除文件夹递归删除数据库中该前缀的所有节点与物理文件。

## WebDAV 协议

支持方法：`OPTIONS`、`PROPFIND`（Depth 0/1/infinity）、`GET`、`HEAD`、`PUT`、`DELETE`、`MKCOL`、`MOVE`、`COPY`、`LOCK`、`UNLOCK`、`PROPPATCH`（返回 207 成功占位）。

- 属性：`displayname`、`resourcetype`（collection）、`getcontentlength`、`getcontenttype`、`getlastmodified`（RFC 1123）、`getetag`（带引号）、`creationdate`（ISO8601）、`supportedlock`、`lockdiscovery`。
- `GET` 支持单段 `Range`（复用 `parseSingleByteRange`）与 `If-None-Match`。
- `PUT` 流式写临时文件，父目录必须存在（否则 409）；超配额返回 507；成功后替换内容并更新 etag。
- `MOVE`/`COPY` 读取 `Destination`（绝对 URL 或路径），`Overwrite` 默认 `T`；目标存在且 `F` 时返回 412；父目录不存在 409。
- `LOCK` 生成 `opaquelocktoken:<uuid>`，支持 `Timeout` 头（默认 3600 秒）与空文件 lock-null；写入/删除/MOVE 时若存在未过期锁且 `If` 头不含该 token，返回 423。`UNLOCK` 校验 token，不匹配 409/423。
- 认证失败 401 + `WWW-Authenticate: Basic realm="Jayson Blog WebDAV", charset="UTF-8"`。
- 错误响应使用纯文本/XML 均可，但状态码必须正确。

## 网页文件管理器 JSON API

用户端（`requireCommentUser`，需要 `userCenterEnabled` 且 `webdavEnabled`）：

- `GET /api/user/drive?path=/` → `{ path, name, breadcrumbs, items, quota, webdav, storageLocation }`
- `POST /api/user/drive/folder` body `{ path, name }` → `{ item }`
- `POST /api/user/drive/upload?path=%2F&name=a.txt`（raw body 即文件内容，`Content-Type` 作为 MIME）→ `{ item }`
- `PATCH /api/user/drive` body `{ path, name }` → `{ item }`（重命名，保持原父目录）
- `DELETE /api/user/drive?path=/a.txt` → 204
- `GET /api/user/drive/file?path=/a.txt` → 文件流（`Content-Disposition: attachment`），支持 Range
- `GET /api/user/drive/info` → `{ webdav: { enabled, url, username, mountUrl }, quota }`（挂载教程用）

管理员端（`requireAdmin`）：路径前缀 `/api/admin/webdav`，结构完全一致（`GET /api/admin/webdav`、`POST /api/admin/webdav/folder`、`POST /api/admin/webdav/upload`、`PATCH /api/admin/webdav`、`DELETE /api/admin/webdav`、`GET /api/admin/webdav/file`、`GET /api/admin/webdav/info`）。

`item` 形状：

```ts
type DriveItem = {
  id: number;
  name: string;
  path: string;
  type: "file" | "folder";
  mimeType: string;
  byteSize: number;
  updatedAt: string;
  etag: string;
};
```

`quota`：`{ limitBytes, usedBytes, remainingBytes, fileCount, folderCount, driveBytes }`。
`breadcrumbs`：`[{ name, path }]`，第一项为根。
`webdav`：`{ enabled: boolean, url: string, mountUrl: string, username: string }`；`url` 是浏览器可访问的 `/dav` 完整地址（优先 `VITE_API_ORIGIN`，否则当前 origin），`mountUrl` 为供客户端填写的完整 URL。

## 前端

- 新文件 `apps/web/src/WebDavDrive.tsx`：共享 `DriveBrowser`（列表/网格、面包屑、上传、新建文件夹、重命名、删除、下载、配额条、挂载说明），导出 `UserDrivePage` 与 `AdminDrivePage`。
- 用户路由 `/user/drive`，入口加在 `App.tsx` 的“小工具/用户中心”链接区；管理员路由 `/admin/webdav`，加在 `AdminApp.tsx` 侧栏（图标可用 `HardDrive`/`Cloud`）。
- 风格与 Firefly 参考站一致：沿用现有卡片、按钮、表格/列表样式与 CSS 变量，不引入新依赖。
- 中文界面；空状态、加载、错误、成功提示齐全；移动端可用。
- 上传使用 `fetch` raw body（`POST .../upload?path=&name=`），带 `Authorization: Bearer <token>`；管理员 token 存 `sessionStorage["site-admin-token"]`，用户 token 由 `api` 客户端自动附带。

## 部署

- `deploy/manage.sh` 生成的 nginx 配置新增 `location /dav/`：`client_max_body_size 2200m`、`proxy_request_buffering off`、`proxy_read_timeout/proxy_send_timeout 7200s`，转发到 API。
- `vite.config.ts` 增加 `/dav` 开发代理。
- 文档：`docs/webdav-drive.md`（功能说明、Windows/macOS/手机/rclone 挂载步骤、常见问题），README 增加入口。

## 验证

- `pnpm --filter @jayson-blog/api type-check`、`pnpm --filter @jayson-blog/web build`。
- 单元测试：路径归一化、名称校验、XML 转义、ETag/Range、配额累加（纯函数，不依赖数据库）。
- 手工协议验证：启动 API 后用 curl 执行 OPTIONS / PROPFIND / MKCOL / PUT / GET / MOVE / LOCK / UNLOCK / DELETE（Basic Auth 使用测试账号）。
