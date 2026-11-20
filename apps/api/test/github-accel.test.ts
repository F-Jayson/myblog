/**
 * githubAccel.ts 的单元测试。协议见 docs/github-accelerator.md：
 * 这里把文档第 2 节的固定测试向量、第 5 节的解析写法全部钉死，
 * 因为加速节点有另一份 ticket 实现（packages/github-accel/src/ticket.ts），
 * 任何一边改了签名细节，都必须在这些用例上失败。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.ts";
import {
	GITHUB_ACCEL_DL_PATH,
	GithubAccelError,
	assertTicketAlgorithm,
	buildCloneInfo,
	buildDownloadRedirect,
	buildDownloadTicket,
	checkGithubAccelRate,
	createTicket,
	fetchAcceleratorReleases,
	getAcceleratorStatus,
	parseGithubInput,
	requireGithubAccelRate,
	resetGithubAccelRateLimits,
	verifyTicket,
	type GithubResolved,
	type TicketPayload,
} from "../src/githubAccel.ts";

// 文档第 2 节的固定测试向量，与加速度节点的单测共用同一组常量值。
const VECTOR_SECRET = "test-secret-0123456789abcdef0123456789";
const VECTOR_EXPIRES_AT = 1_800_000_000;
const VECTOR_FILE_PAYLOAD: TicketPayload = { u: "https://github.com/o/r/releases/download/v1/a.zip", e: VECTOR_EXPIRES_AT, k: "file" };
const VECTOR_FILE_BODY = "eyJ1IjoiaHR0cHM6Ly9naXRodWIuY29tL28vci9yZWxlYXNlcy9kb3dubG9hZC92MS9hLnppcCIsImUiOjE4MDAwMDAwMDAsImsiOiJmaWxlIn0";
const VECTOR_FILE_TICKET = VECTOR_FILE_BODY + ".1fdb9326cecbc1dae9177cd18b229837";
const VECTOR_GIT_PAYLOAD: TicketPayload = { u: "/o/r.git", e: VECTOR_EXPIRES_AT, k: "git" };
const VECTOR_GIT_BODY = "eyJ1IjoiL28vci5naXQiLCJlIjoxODAwMDAwMDAwLCJrIjoiZ2l0In0";
const VECTOR_GIT_TICKET = VECTOR_GIT_BODY + ".e3b1ec8cf96bc251c12bcf34aa369b7c";

type RepoResolved = Extract<GithubResolved, { kind: "repo" }>;
type ReleaseResolved = Extract<GithubResolved, { kind: "release" }>;
type FileResolved = Extract<GithubResolved, { kind: "file" }>;

function expectRepo(value: GithubResolved): RepoResolved {
	assert.equal(value.kind, "repo", "期望 repo，实际 " + JSON.stringify(value));
	if (value.kind !== "repo") throw new Error("unreachable");
	return value;
}

function expectRelease(value: GithubResolved): ReleaseResolved {
	assert.equal(value.kind, "release", "期望 release，实际 " + JSON.stringify(value));
	if (value.kind !== "release") throw new Error("unreachable");
	return value;
}

function expectFile(value: GithubResolved): FileResolved {
	assert.equal(value.kind, "file", "期望 file，实际 " + JSON.stringify(value));
	if (value.kind !== "file") throw new Error("unreachable");
	return value;
}

function expectInvalid(value: GithubResolved): string {
	assert.equal(value.kind, "invalid", "期望 invalid，实际 " + JSON.stringify(value));
	if (value.kind !== "invalid") throw new Error("unreachable");
	assert.ok(value.error.length > 0, "invalid 必须带中文原因");
	assert.match(value.error, /[\u4e00-\u9fa5]/u, "invalid 的原因必须是中文");
	return value.error;
}

function expectGithubAccelError(run: () => unknown, code: string, statusCode: number) {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof GithubAccelError, "抛出的应是 GithubAccelError");
		assert.equal(error.code, code);
		assert.equal(error.statusCode, statusCode);
		return true;
	});
}

// ---------------------------------------------------------------------------
// 第 5 节：链接解析
// ---------------------------------------------------------------------------

test("解析裸写的 owner/repo", () => {
	const resolved = expectRepo(parseGithubInput("microsoft/vscode"));
	assert.equal(resolved.owner, "microsoft");
	assert.equal(resolved.repo, "vscode");
	assert.equal(resolved.repoUrl, "https://github.com/microsoft/vscode");

	// 前后空格、结尾多余斜杠都不该影响结果。
	const padded = expectRepo(parseGithubInput("  microsoft/vscode/  "));
	assert.equal(padded.repoUrl, "https://github.com/microsoft/vscode");
});

test("解析完整仓库地址、.git 后缀与 query/fragment", () => {
	assert.equal(expectRepo(parseGithubInput("https://github.com/microsoft/vscode")).repo, "vscode");
	assert.equal(expectRepo(parseGithubInput("https://github.com/microsoft/vscode.git")).repo, "vscode");
	assert.equal(expectRepo(parseGithubInput("http://github.com/microsoft/vscode?tab=readme")).repo, "vscode");
	assert.equal(expectRepo(parseGithubInput("https://github.com/microsoft/vscode/#readme")).repo, "vscode");
	// 地址栏复制来的无协议链接也要认。
	assert.equal(expectRepo(parseGithubInput("github.com/microsoft/vscode")).repo, "vscode");
});

test("解析 ssh 形式的 git 地址", () => {
	const resolved = expectRepo(parseGithubInput("git@github.com:microsoft/vscode.git"));
	assert.equal(resolved.owner, "microsoft");
	assert.equal(resolved.repo, "vscode");
	assert.equal(resolved.repoUrl, "https://github.com/microsoft/vscode");
});

test("解析 release tag 页", () => {
	const resolved = expectRelease(parseGithubInput("https://github.com/vuejs/core/releases/tag/v3.5.0"));
	assert.equal(resolved.owner, "vuejs");
	assert.equal(resolved.repo, "core");
	assert.equal(resolved.tag, "v3.5.0");
	assert.equal(resolved.repoUrl, "https://github.com/vuejs/core");
});

test("解析 release 附件直链", () => {
	const resolved = expectFile(parseGithubInput("https://github.com/o/r/releases/download/v1.2.3/app%20setup.zip"));
	assert.equal(resolved.owner, "o");
	assert.equal(resolved.repo, "r");
	assert.equal(resolved.tag, "v1.2.3");
	assert.equal(resolved.origin, "release");
	assert.equal(resolved.fileName, "app setup.zip", "fileName 需要 decodeURIComponent");
	assert.equal(resolved.url, "https://github.com/o/r/releases/download/v1.2.3/app%20setup.zip");
});

test("解析源码包 /archive/refs/heads 与 /archive/refs/tags", () => {
	const branch = expectFile(parseGithubInput("https://github.com/o/r/archive/refs/heads/main.zip"));
	assert.equal(branch.origin, "archive");
	assert.equal(branch.ref, "main");
	assert.equal(branch.tag, undefined, "分支不应写进 tag");
	assert.equal(branch.fileName, "main.zip");
	assert.equal(branch.url, "https://github.com/o/r/archive/refs/heads/main.zip");

	const tag = expectFile(parseGithubInput("https://github.com/o/r/archive/refs/tags/v1.2.3.tar.gz"));
	assert.equal(tag.origin, "archive");
	assert.equal(tag.tag, "v1.2.3");
	assert.equal(tag.ref, undefined, "标签不应写进 ref");
	assert.equal(tag.fileName, "v1.2.3.tar.gz");
});

test("解析旧式 /archive/<ref>.zip", () => {
	const resolved = expectFile(parseGithubInput("https://github.com/o/r/archive/main.zip"));
	assert.equal(resolved.ref, "main");
	assert.equal(resolved.origin, "archive");
});

test("解析 raw.githubusercontent.com", () => {
	const resolved = expectFile(parseGithubInput("https://raw.githubusercontent.com/o/r/main/docs/a.md"));
	assert.equal(resolved.owner, "o");
	assert.equal(resolved.repo, "r");
	assert.equal(resolved.origin, "raw");
	assert.equal(resolved.ref, "main");
	assert.equal(resolved.fileName, "a.md");
	assert.equal(resolved.url, "https://raw.githubusercontent.com/o/r/main/docs/a.md");
});

test("解析 codeload.github.com", () => {
	const resolved = expectFile(parseGithubInput("https://codeload.github.com/o/r/zip/refs/heads/main"));
	assert.equal(resolved.owner, "o");
	assert.equal(resolved.repo, "r");
	assert.equal(resolved.origin, "archive");
	assert.equal(resolved.ref, "main");
	assert.equal(resolved.fileName, "main");

	const tar = expectFile(parseGithubInput("https://codeload.github.com/o/r/tar.gz/refs/tags/v1.2.3"));
	assert.equal(tar.tag, "v1.2.3");
});

test("域名与写法大小写不敏感", () => {
	const resolved = expectRepo(parseGithubInput("HTTPS://GITHUB.COM/Microsoft/VSCode"));
	assert.equal(resolved.owner, "Microsoft");
	assert.equal(resolved.repo, "VSCode", "owner/repo 保留原始大小写，只有域名与关键字归一化");

	const file = expectFile(parseGithubInput("https://github.com/o/r/Releases/Download/v1/a.zip"));
	assert.equal(file.origin, "release");
});

test("无法识别的输入返回 invalid + 中文原因", () => {
	expectInvalid(parseGithubInput(""));
	expectInvalid(parseGithubInput("   "));
	expectInvalid(parseGithubInput("https://gitlab.com/o/r"));
	expectInvalid(parseGithubInput("https://example.com/o/r/releases/tag/v1"));
	expectInvalid(parseGithubInput("ftp://github.com/o/r"));
	expectInvalid(parseGithubInput("o/r/tree/main"));
	expectInvalid(parseGithubInput("o"));
	expectInvalid(parseGithubInput("a".repeat(101) + "/r"));
	expectInvalid(parseGithubInput("o!/r"));
	expectInvalid(parseGithubInput("o/.."));
	expectInvalid(parseGithubInput("https://github.com/o/r/issues/1"));
	expectInvalid(parseGithubInput("https://github.com/o/r/releases/download/v1"));
});

test("非法输入不会带出 query 或 fragment", () => {
	const resolved = expectRepo(parseGithubInput("https://github.com/o/r.git?x=1#y"));
	assert.equal(resolved.repo, "r");
	assert.equal(resolved.repoUrl, "https://github.com/o/r");
});

// ---------------------------------------------------------------------------
// 第 2 节：ticket
// ---------------------------------------------------------------------------

test("ticket 与文档固定测试向量完全一致", () => {
	assertTicketAlgorithm();
	assert.equal(createTicket(VECTOR_FILE_PAYLOAD, VECTOR_SECRET), VECTOR_FILE_TICKET);
	assert.equal(createTicket(VECTOR_GIT_PAYLOAD, VECTOR_SECRET), VECTOR_GIT_TICKET);
});

test("固定向量能验签，且 payload 原样返回", () => {
	const fileResult = verifyTicket(VECTOR_FILE_TICKET, "file", VECTOR_SECRET, VECTOR_EXPIRES_AT - 1);
	assert.equal(fileResult.ok, true);
	if (!fileResult.ok) throw new Error("unreachable");
	assert.deepEqual(fileResult.payload, VECTOR_FILE_PAYLOAD);

	const gitResult = verifyTicket(VECTOR_GIT_TICKET, "git", VECTOR_SECRET, VECTOR_EXPIRES_AT - 1);
	assert.equal(gitResult.ok, true);
	if (!gitResult.ok) throw new Error("unreachable");
	assert.deepEqual(gitResult.payload, VECTOR_GIT_PAYLOAD);
});

test("ticket 签发与验签往返", () => {
	const now = 1_700_000_000;
	const payload: TicketPayload = { u: "https://github.com/o/r/releases/download/v1/a.zip", e: now + 60, k: "file" };
	const ticket = createTicket(payload, VECTOR_SECRET);
	assert.equal(ticket.split(".").length, 2, "ticket 是 payload.signature 两段");
	const result = verifyTicket(ticket, "file", VECTOR_SECRET, now);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("unreachable");
	assert.deepEqual(result.payload, payload);
});

test("过期 ticket 返回 TICKET_EXPIRED", () => {
	const expired = verifyTicket(VECTOR_FILE_TICKET, "file", VECTOR_SECRET, VECTOR_EXPIRES_AT);
	assert.equal(expired.ok, false);
	if (expired.ok) throw new Error("unreachable");
	assert.equal(expired.code, "TICKET_EXPIRED");
	assert.match(expired.error, /过期/u);
});

test("篡改 payload 或签名返回 TICKET_INVALID", () => {
	const tamperedBody = "x" + VECTOR_FILE_TICKET;
	assert.equal((() => { const r = verifyTicket(tamperedBody, "file", VECTOR_SECRET, VECTOR_EXPIRES_AT - 1); return r.ok ? "ok" : r.code; })(), "TICKET_INVALID");

	const [body, signature] = VECTOR_FILE_TICKET.split(".") as [string, string];
	const flipped = signature.slice(0, -1) + (signature.endsWith("0") ? "1" : "0");
	const flippedResult = verifyTicket(body + "." + flipped, "file", VECTOR_SECRET, VECTOR_EXPIRES_AT - 1);
	assert.equal(flippedResult.ok, false);
	if (flippedResult.ok) throw new Error("unreachable");
	assert.equal(flippedResult.code, "TICKET_INVALID");

	// 换一把密钥等于换了签名，必须失败而不是靠过期时间挡。
	const wrongSecret = verifyTicket(VECTOR_FILE_TICKET, "file", "test-secret-ffffffffffffffffffffffff", VECTOR_EXPIRES_AT - 1);
	assert.equal(wrongSecret.ok, false);
	if (wrongSecret.ok) throw new Error("unreachable");
	assert.equal(wrongSecret.code, "TICKET_INVALID");
});

test("kind 不匹配返回 TICKET_INVALID", () => {
	const result = verifyTicket(VECTOR_GIT_TICKET, "file", VECTOR_SECRET, VECTOR_EXPIRES_AT - 1);
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "TICKET_INVALID");
	assert.match(result.error, /类型/u);
});

test("格式错误的 ticket 返回 TICKET_INVALID", () => {
	for (const bad of ["", "abc", "abc.def.ghi", ".sig", "body."]) {
		const result = verifyTicket(bad, "file", VECTOR_SECRET, VECTOR_EXPIRES_AT - 1);
		assert.equal(result.ok, false, "应对 " + JSON.stringify(bad) + " 返回失败");
		if (result.ok) throw new Error("unreachable");
		assert.equal(result.code, "TICKET_INVALID");
	}
});

test("未配置密钥时签发与验签都直接 503", () => {
	expectGithubAccelError(() => createTicket(VECTOR_FILE_PAYLOAD, "   "), "GITHUB_ACCEL_NOT_CONFIGURED", 503);
	expectGithubAccelError(() => verifyTicket(VECTOR_FILE_TICKET, "file", ""), "GITHUB_ACCEL_NOT_CONFIGURED", 503);
});

// ---------------------------------------------------------------------------
// 下载入口与 302 Location
// ---------------------------------------------------------------------------

test("buildDownloadTicket 返回主站 302 入口与过期时间", () => {
	const now = 1_700_000_000;
	const info = buildDownloadTicket("https://github.com/o/r/releases/download/v1/a.zip", { now, ttlMinutes: 30, secret: VECTOR_SECRET });
	assert.ok(info.downloadPath.startsWith(GITHUB_ACCEL_DL_PATH), "downloadPath 必须走 /api/tools/github/dl/");
	assert.equal(info.fileName, "a.zip");
	assert.equal(info.expiresAt, new Date((now + 30 * 60) * 1000).toISOString());

	const ticket = info.downloadPath.slice(GITHUB_ACCEL_DL_PATH.length);
	const verified = verifyTicket(ticket, "file", VECTOR_SECRET, now);
	assert.equal(verified.ok, true, "签发出的 ticket 必须能自己验过");
	if (!verified.ok) throw new Error("unreachable");
	assert.equal(verified.payload.u, "https://github.com/o/r/releases/download/v1/a.zip");
	assert.equal(verified.payload.e, now + 30 * 60);
});

test("buildDownloadTicket 拒绝非白名单或带凭据的地址", () => {
	expectGithubAccelError(() => buildDownloadTicket("https://example.com/a.zip", { secret: VECTOR_SECRET }), "HOST_NOT_ALLOWED", 400);
	expectGithubAccelError(() => buildDownloadTicket("ftp://github.com/a.zip", { secret: VECTOR_SECRET }), "GITHUB_ACCEL_INVALID_INPUT", 400);
	expectGithubAccelError(() => buildDownloadTicket("https://user:pw@github.com/a.zip", { secret: VECTOR_SECRET }), "GITHUB_ACCEL_INVALID_INPUT", 400);
	expectGithubAccelError(() => buildDownloadTicket("not a url", { secret: VECTOR_SECRET }), "GITHUB_ACCEL_INVALID_INPUT", 400);
});

test("buildDownloadRedirect 拼出节点的 /download/<ticket>", () => {
	assert.equal(
		buildDownloadRedirect(VECTOR_FILE_TICKET, "https://gh.example.com"),
		"https://gh.example.com/download/" + VECTOR_FILE_TICKET,
	);
	// 尾斜杠要去掉，否则会拼出 //download/。
	assert.equal(
		buildDownloadRedirect(VECTOR_FILE_TICKET, "https://gh.example.com///"),
		"https://gh.example.com/download/" + VECTOR_FILE_TICKET,
	);
	const [body, signature] = VECTOR_FILE_TICKET.split(".") as [string, string];
	assert.ok(body.length > 0 && signature.length === 32);
});

test("未配置节点地址时下载与克隆都返回 503", () => {
	expectGithubAccelError(() => buildDownloadRedirect(VECTOR_FILE_TICKET, ""), "GITHUB_ACCEL_NOT_CONFIGURED", 503);
	expectGithubAccelError(() => buildCloneInfo("o", "r", { publicAllowed: true, baseUrl: "" }), "GITHUB_ACCEL_NOT_CONFIGURED", 503);
});

// ---------------------------------------------------------------------------
// 克隆命令
// ---------------------------------------------------------------------------

test("公开模式 clone 使用无签名的 /git/<owner>/<repo>.git", () => {
	const info = buildCloneInfo("o", "r", { publicAllowed: true, baseUrl: "https://gh.example.com/" });
	assert.equal(info.cloneUrl, "https://gh.example.com/git/o/r.git");
	assert.equal(info.command, "git clone https://gh.example.com/git/o/r.git");
	assert.equal(info.insteadOf, 'git config --global url."https://gh.example.com/git/".insteadOf "https://github.com/"');
});

test("关闭公开下载时 clone 使用带 ticket 的路径", () => {
	const now = 1_700_000_000;
	const info = buildCloneInfo("o", "r", { publicAllowed: false, baseUrl: "https://gh.example.com", now, ttlMinutes: 30, secret: VECTOR_SECRET });
	const expectedTicket = createTicket({ u: "/o/r.git", e: now + 30 * 60, k: "git" }, VECTOR_SECRET);
	assert.equal(info.cloneUrl, "https://gh.example.com/git/" + expectedTicket + "/o/r.git");
	assert.equal(info.command, "git clone " + info.cloneUrl);

	// 路径里的那一段必须能被节点的 git 路由当作 git ticket 验过。
	const verified = verifyTicket(expectedTicket, "git", VECTOR_SECRET, now);
	assert.equal(verified.ok, true);
	if (!verified.ok) throw new Error("unreachable");
	assert.equal(verified.payload.u, "/o/r.git");
});

test("clone 会挡住不合法的 owner/repo", () => {
	expectGithubAccelError(() => buildCloneInfo("o!", "r", { publicAllowed: true, baseUrl: "https://gh.example.com" }), "GITHUB_ACCEL_INVALID_INPUT", 400);
	expectGithubAccelError(() => buildCloneInfo("o", "a".repeat(101), { publicAllowed: true, baseUrl: "https://gh.example.com" }), "GITHUB_ACCEL_INVALID_INPUT", 400);
});

// ---------------------------------------------------------------------------
// 节点状态
// ---------------------------------------------------------------------------

// 只有没配节点时才走这条本地分支；配了节点就是真实网络请求，交给联调而不是单测。
test("未配置节点时状态查询返回 configured=false 且不报错", { skip: config.githubAccel.baseUrl !== "" }, async () => {
	const status = await getAcceleratorStatus();
	assert.deepEqual(status, { configured: false, online: false, publicAllowed: false, version: null });
});

test("未配置节点时 Release 代理返回 503 中文错误", { skip: config.githubAccel.baseUrl !== "" }, async () => {
	await assert.rejects(() => fetchAcceleratorReleases("o", "r"), (error: unknown) => {
		assert.ok(error instanceof GithubAccelError);
		assert.equal(error.statusCode, 503);
		assert.equal(error.code, "GITHUB_ACCEL_NOT_CONFIGURED");
		assert.match(error.message, /未配置/u);
		return true;
	});
});

// ---------------------------------------------------------------------------
// 每 IP 限流窗口
// ---------------------------------------------------------------------------

test("解析接口每 IP 每分钟 30 次", () => {
	resetGithubAccelRateLimits();
	const now = 1_700_000_000_000;
	for (let index = 0; index < 30; index += 1) {
		assert.equal(checkGithubAccelRate("resolve", "10.0.0.1", now).allowed, true, "第 " + (index + 1) + " 次应放行");
	}
	const blocked = checkGithubAccelRate("resolve", "10.0.0.1", now);
	assert.equal(blocked.allowed, false);
	assert.equal(blocked.retryAfterSeconds, 60);
	// 另一个 IP 有独立窗口。
	assert.equal(checkGithubAccelRate("resolve", "10.0.0.2", now).allowed, true);
	// 窗口到期后重新放行。
	assert.equal(checkGithubAccelRate("resolve", "10.0.0.1", now + 60_000).allowed, true);
});

test("签发接口每 IP 每分钟 60 次", () => {
	resetGithubAccelRateLimits();
	const now = 1_700_000_000_000;
	for (let index = 0; index < 60; index += 1) {
		assert.equal(checkGithubAccelRate("issue", "10.0.0.3", now).allowed, true);
	}
	assert.equal(checkGithubAccelRate("issue", "10.0.0.3", now).allowed, false);
	// 解析与签发是两个独立的桶。
	assert.equal(checkGithubAccelRate("resolve", "10.0.0.3", now).allowed, true);
});

test("超限时 requireGithubAccelRate 抛 429", () => {
	resetGithubAccelRateLimits();
	for (let index = 0; index < 30; index += 1) requireGithubAccelRate("resolve", "10.9.9.9");
	assert.throws(() => requireGithubAccelRate("resolve", "10.9.9.9"), (error: unknown) => {
		assert.ok(error instanceof GithubAccelError);
		assert.equal(error.statusCode, 429);
		assert.equal(error.code, "GITHUB_ACCEL_RATE_LIMITED");
		assert.ok((error.retryAfterSeconds ?? 0) >= 1, "必须给出 Retry-After 秒数");
		return true;
	});
});
