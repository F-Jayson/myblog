/**
 * WebDAV end-to-end smoke test. It talks to a *running* API server over HTTP and
 * writes to the real database, so it is not part of `node --test`:
 *
 *   pnpm --filter @jayson-blog/api build
 *   API_PORT=5190 node apps/api/dist/server.js &
 *   node apps/api/test/webdav-e2e.mjs            # WEBDAV_E2E_BASE overrides the URL
 *
 * Temporary accounts (davcheckadmin / davcheckuser), their drive rows and the
 * uploaded bytes are removed in `finally`, including on assertion failure.
 */
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../dist/db.js";
import {
	authenticateAdmin,
	authenticateCommentUser,
	createAdminUser,
	deleteAdminUser,
	deleteCommentUser,
	registerCommentUser,
} from "../dist/repository.js";

const BASE = process.env.WEBDAV_E2E_BASE ?? "http://127.0.0.1:5190";
const ADMIN = { username: "davcheckadmin", password: "DavCheck!2026", displayName: "DAV Check Admin" };
const USER = { account: "davcheckuser", nickname: "DAV Check User", password: "DavCheck!2026", email: "davcheck@example.com" };
const USER_SPACE_DIR = fileURLToPath(new URL("../../uploads/user-space/", import.meta.url));

let passed = 0;
// Set while the feature toggle is disabled, so a failed assertion still restores
// the site's real switch values.
let restoreFeatures = null;
function check(condition, message) {
	if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
	passed += 1;
	console.log(`ok - ${message}`);
}
function basic(username, password) {
	return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
async function call(method, pathname, options = {}) {
	const headers = { ...(options.headers ?? {}) };
	if (options.auth) headers.Authorization = options.auth;
	const response = await fetch(`${BASE}${pathname}`, {
		method,
		headers,
		body: options.body,
		redirect: "manual",
	});
	const body = Buffer.from(await response.arrayBuffer());
	return { status: response.status, headers: response.headers, body, text: body.toString("utf8") };
}
function xmlBody(text, extraHeaders = {}) {
	return { headers: { "Content-Type": "application/xml; charset=utf-8", ...extraHeaders }, body: text };
}

const lockInfo = `<?xml version="1.0" encoding="utf-8"?>
<d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype><d:owner><d:href>e2e</d:href></d:owner></d:lockinfo>`;

async function cleanup() {
	if (restoreFeatures) {
		await restoreFeatures().catch((error) => console.error("restore features failed:", error));
		restoreFeatures = null;
	}
	const adminRows = await pool.query("SELECT id FROM admin_users WHERE username = ?", [ADMIN.username]);
	for (const row of adminRows[0]) {
		const adminId = Number(row.id);
		const nodes = await pool.query("SELECT storage_key FROM drive_nodes WHERE owner_type = 'admin' AND owner_id = ? AND storage_key IS NOT NULL", [adminId]);
		for (const node of nodes[0]) {
			await fs.rm(`${USER_SPACE_DIR}${node.storage_key}`, { force: true }).catch(() => {});
		}
		await pool.execute("DELETE FROM drive_locks WHERE owner_type = 'admin' AND owner_id = ?", [adminId]).catch(() => {});
		await pool.execute("DELETE FROM drive_nodes WHERE owner_type = 'admin' AND owner_id = ?", [adminId]).catch(() => {});
		await pool.execute("DELETE FROM admin_sessions WHERE user_id = ?", [adminId]).catch(() => {});
		await deleteAdminUser(adminId).catch(() => {});
	}
	const userRows = await pool.query("SELECT id FROM comment_users WHERE account = ?", [USER.account]);
	for (const row of userRows[0]) {
		const userId = Number(row.id);
		const nodes = await pool.query("SELECT storage_key FROM drive_nodes WHERE owner_type = 'user' AND owner_id = ? AND storage_key IS NOT NULL", [userId]);
		for (const node of nodes[0]) {
			await fs.rm(`${USER_SPACE_DIR}${node.storage_key}`, { force: true }).catch(() => {});
		}
		await pool.execute("DELETE FROM drive_locks WHERE owner_type = 'user' AND owner_id = ?", [userId]).catch(() => {});
		await pool.execute("DELETE FROM drive_nodes WHERE owner_type = 'user' AND owner_id = ?", [userId]).catch(() => {});
		await pool.execute("DELETE FROM comment_sessions WHERE user_id = ?", [userId]).catch(() => {});
		await deleteCommentUser(userId).catch(() => {});
	}
}

async function run() {
	await cleanup();
	await createAdminUser(ADMIN);
	const user = await registerCommentUser(USER);
	check(Number(user.id) > 0, "临时用户创建成功");

	const adminAuth = basic(ADMIN.username, ADMIN.password);
	const userAuth = basic(USER.account, USER.password);

	let res = await call("OPTIONS", "/dav", { auth: adminAuth });
	check(res.status === 200 || res.status === 204, `OPTIONS /dav 返回 200/204（实际 ${res.status}）`);
	check((res.headers.get("dav") ?? "").includes("1"), "OPTIONS 返回 DAV: 1");
	check((res.headers.get("allow") ?? "").includes("PROPFIND"), "OPTIONS Allow 包含 PROPFIND");

	res = await call("PROPFIND", "/dav", { auth: adminAuth, headers: { Depth: "0", "Content-Type": "application/xml" }, body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>` });
	check(res.status === 207, `管理员 PROPFIND / 返回 207（实际 ${res.status}）`);
	check(res.text.includes("multistatus"), "PROPFIND 返回 multistatus");

	res = await call("PROPFIND", "/dav", { auth: basic(ADMIN.username, "wrong-password") });
	check(res.status === 401, `错误密码返回 401（实际 ${res.status}）`);
	check((res.headers.get("www-authenticate") ?? "").includes("Jayson Blog WebDAV"), "401 带 WWW-Authenticate 挑战");

	res = await call("PROPFIND", "/dav");
	check(res.status === 401, `无认证返回 401（实际 ${res.status}）`);

	res = await call("MKCOL", "/dav/e2e-docs", { auth: adminAuth });
	check(res.status === 201, `MKCOL 目录返回 201（实际 ${res.status}）`);

	res = await call("PUT", "/dav/e2e-docs/hello.txt", { auth: adminAuth, headers: { "Content-Type": "text/plain" }, body: "hello webdav" });
	check(res.status === 201, `PUT 新文件返回 201（实际 ${res.status}）`);
	check(Boolean(res.headers.get("etag")), "PUT 返回 ETag");

	res = await call("GET", "/dav/e2e-docs/hello.txt", { auth: adminAuth });
	check(res.status === 200 && res.text === "hello webdav", `GET 文件内容正确（实际 ${res.status}）`);
	check((res.headers.get("accept-ranges") ?? "") === "bytes", "GET 返回 Accept-Ranges: bytes");

	res = await call("HEAD", "/dav/e2e-docs/hello.txt", { auth: adminAuth });
	check(res.status === 200 && res.headers.get("content-length") === "12", `HEAD Content-Length=12（实际 ${res.status}/${res.headers.get("content-length")}）`);

	res = await call("GET", "/dav/e2e-docs/hello.txt", { auth: adminAuth, headers: { Range: "bytes=0-4" } });
	check(res.status === 206 && res.text === "hello", `Range 请求返回 206 和 hello（实际 ${res.status}/${res.text}）`);

	res = await call("PROPFIND", "/dav/e2e-docs", { auth: adminAuth, headers: { Depth: "1" } });
	check(res.status === 207 && res.text.includes("hello.txt"), `PROPFIND Depth 1 列出 hello.txt（实际 ${res.status}）`);

	res = await call("PROPFIND", "/dav", { auth: adminAuth, headers: { Depth: "infinity" } });
	check(res.status === 207 && res.text.includes("e2e-docs") && res.text.includes("hello.txt"), `PROPFIND Depth infinity 列出递归内容（实际 ${res.status}）`);

	res = await call("LOCK", "/dav/e2e-docs/hello.txt", { auth: adminAuth, ...xmlBody(lockInfo, { Timeout: "Second-600", Depth: "0" }) });
	check(res.status === 200 || res.status === 201, `LOCK 返回 200/201（实际 ${res.status}）`);
	const lockToken = res.headers.get("lock-token");
	check(Boolean(lockToken && lockToken.startsWith("<")), `LOCK 返回 Lock-Token（实际 ${lockToken}）`);

	res = await call("PUT", "/dav/e2e-docs/hello.txt", { auth: adminAuth, headers: { "Content-Type": "text/plain" }, body: "blocked" });
	check(res.status === 423, `锁定后无令牌 PUT 返回 423（实际 ${res.status}）`);

	res = await call("PUT", "/dav/e2e-docs/hello.txt", { auth: adminAuth, headers: { "Content-Type": "text/plain", If: `(${lockToken})` }, body: "still locked" });
	check(res.status === 204, `带 If 令牌 PUT 返回 204（实际 ${res.status}）`);

	res = await call("UNLOCK", "/dav/e2e-docs/hello.txt", { auth: adminAuth, headers: { "Lock-Token": lockToken } });
	check(res.status === 204, `UNLOCK 返回 204（实际 ${res.status}）`);

	res = await call("MOVE", "/dav/e2e-docs/hello.txt", { auth: adminAuth, headers: { Destination: `${BASE}/dav/e2e-docs/renamed.txt` } });
	check(res.status === 201, `MOVE 返回 201（实际 ${res.status}）`);
	res = await call("GET", "/dav/e2e-docs/hello.txt", { auth: adminAuth });
	check(res.status === 404, `MOVE 后旧路径 404（实际 ${res.status}）`);
	res = await call("GET", "/dav/e2e-docs/renamed.txt", { auth: adminAuth });
	check(res.status === 200 && res.text === "still locked", `MOVE 后新路径内容正确（实际 ${res.status}/${res.text}）`);

	res = await call("COPY", "/dav/e2e-docs", { auth: adminAuth, headers: { Destination: `${BASE}/dav/e2e-copy`, Depth: "infinity" } });
	check(res.status === 201, `COPY 目录返回 201（实际 ${res.status}）`);
	res = await call("GET", "/dav/e2e-copy/renamed.txt", { auth: adminAuth });
	check(res.status === 200 && res.text === "still locked", `COPY 后副本内容正确（实际 ${res.status}）`);

	res = await call("DELETE", "/dav/e2e-copy", { auth: adminAuth });
	check(res.status === 204, `DELETE 副本目录返回 204（实际 ${res.status}）`);
	res = await call("PROPFIND", "/dav/e2e-copy", { auth: adminAuth, headers: { Depth: "0" } });
	check(res.status === 404, `删除后 PROPFIND 返回 404（实际 ${res.status}）`);

	res = await call("PROPFIND", "/dav", { auth: userAuth, headers: { Depth: "0" } });
	check(res.status === 207, `注册用户 PROPFIND / 返回 207（实际 ${res.status}）`);
	res = await call("PUT", "/dav/user-file.txt", { auth: userAuth, headers: { "Content-Type": "text/plain" }, body: "user content" });
	check(res.status === 201, `注册用户 PUT 返回 201（实际 ${res.status}）`);
	res = await call("GET", "/dav/user-file.txt", { auth: userAuth });
	check(res.status === 200 && res.text === "user content", `注册用户 GET 内容正确（实际 ${res.status}）`);

	const userSession = await authenticateCommentUser(USER.account, USER.password);
	check(Boolean(userSession?.token), "用户 Bearer 会话创建成功");
	const bearer = { Authorization: `Bearer ${userSession.token}` };
	res = await call("GET", "/api/user/drive", { headers: bearer });
	check(res.status === 200, `GET /api/user/drive 返回 200（实际 ${res.status}）`);
	const listing = JSON.parse(res.text);
	check(Array.isArray(listing.items), "用户列表返回 items 数组");
	check((listing.webdav?.url ?? "").endsWith("/dav"), `用户列表返回 WebDAV 地址（实际 ${listing.webdav?.url}）`);
	check(typeof listing.quota?.usedBytes === "number" && listing.quota.limitBytes > 0, "用户列表返回配额");

	res = await call("POST", "/api/user/drive/folder", { headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify({ name: "json-folder" }) });
	check(res.status === 201, `JSON 创建目录返回 201（实际 ${res.status}）`);

	res = await call("POST", "/api/user/drive/upload?path=%2Fjson-folder&name=note.txt", { headers: { ...bearer, "Content-Type": "text/plain" }, body: "hello json" });
	check(res.status === 201, `JSON 上传返回 201（实际 ${res.status}）`);

	res = await call("GET", "/api/user/drive/file?path=%2Fjson-folder%2Fnote.txt", { headers: bearer });
	check(res.status === 200 && res.text === "hello json", `JSON 下载内容正确（实际 ${res.status}/${res.text}）`);

	res = await call("PATCH", "/api/user/drive", { headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify({ path: "/json-folder/note.txt", name: "note2.txt" }) });
	check(res.status === 200, `JSON 重命名返回 200（实际 ${res.status}）`);

	res = await call("DELETE", "/api/user/drive?path=%2Fjson-folder", { headers: bearer });
	check(res.status === 200, `JSON 删除目录返回 200（实际 ${res.status}）`);

	const adminSession = await authenticateAdmin(ADMIN.username, ADMIN.password);
	check(Boolean(adminSession?.token), "管理员 Bearer 会话创建成功");
	const adminBearer = { Authorization: `Bearer ${adminSession.token}` };
	res = await call("GET", "/api/admin/webdav", { headers: adminBearer });
	check(res.status === 200, `GET /api/admin/webdav 返回 200（实际 ${res.status}）`);
	const adminListing = JSON.parse(res.text);
	check(Array.isArray(adminListing.items), "管理员列表返回 items 数组");
	check((adminListing.webdav?.username ?? "") === ADMIN.username, `管理员 WebDAV 用户名为 admin（实际 ${adminListing.webdav?.username}）`);
	check(adminListing.quota?.limitBytes === 2 * 1024 * 1024 * 1024, `管理员配额为 2GB（实际 ${adminListing.quota?.limitBytes}）`);

	// 功能开关：关闭后注册用户的 WebDAV 与网页接口都应 403，管理员不受影响。
	const adminJson = { Authorization: `Bearer ${adminSession.token}`, "Content-Type": "application/json" };
	const before = JSON.parse((await call("GET", "/api/admin/features", { headers: { Authorization: `Bearer ${adminSession.token}` } })).text);
	restoreFeatures = async () => {
		await call("PATCH", "/api/admin/features", { headers: adminJson, body: JSON.stringify(before) });
	};
	res = await call("PATCH", "/api/admin/features", { headers: adminJson, body: JSON.stringify({ ...before, webdavEnabled: false }) });
	check(res.status === 200 && JSON.parse(res.text).webdavEnabled === false, `功能开关可关闭 WebDAV（实际 ${res.status}）`);
	res = await call("PROPFIND", "/dav", { auth: userAuth, headers: { Depth: "0" } });
	check(res.status === 403, `关闭后用户 DAV 返回 403（实际 ${res.status}）`);
	res = await call("GET", "/api/user/drive", { headers: bearer });
	check(res.status === 403, `关闭后用户网页接口返回 403（实际 ${res.status}）`);
	res = await call("PROPFIND", "/dav", { auth: adminAuth, headers: { Depth: "0" } });
	check(res.status === 207, `关闭后管理员 DAV 仍可用（实际 ${res.status}）`);
	await restoreFeatures();
	restoreFeatures = null;
	res = await call("PROPFIND", "/dav", { auth: userAuth, headers: { Depth: "0" } });
	check(res.status === 207, `恢复开关后用户 DAV 返回 207（实际 ${res.status}）`);

	res = await call("DELETE", "/dav/e2e-docs", { auth: adminAuth });
	check(res.status === 204, `DELETE e2e-docs 返回 204（实际 ${res.status}）`);
	res = await call("DELETE", "/dav/user-file.txt", { auth: userAuth });
	check(res.status === 204, `DELETE user-file.txt 返回 204（实际 ${res.status}）`);

	console.log(`\n全部通过：${passed} 项断言`);
}

try {
	await run();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	await cleanup().catch((error) => console.error("cleanup failed:", error));
	// fetch keeps keep-alive sockets, so the pool alone does not release the loop.
	await pool.end().catch(() => {});
	process.exit(process.exitCode ?? 0);
}
