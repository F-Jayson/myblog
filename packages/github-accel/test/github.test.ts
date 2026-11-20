import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	checkAllowedUrl,
	fileNameFromUrl,
	isAllowedGitPath,
	MAX_ASSETS_PER_RELEASE,
	normalizeReleases,
	parseGithubInput,
	parseGitPath,
} from "../src/github.ts";

describe("白名单：只允许 https + 六个 GitHub 域名", () => {
	it("接受白名单内的 https 地址", () => {
		for (const url of [
			"https://github.com/o/r/releases/download/v1/a.zip",
			"https://api.github.com/repos/o/r/releases",
			"https://codeload.github.com/o/r/zip/refs/heads/main",
			"https://raw.githubusercontent.com/o/r/main/a.md",
			"https://objects.githubusercontent.com/x",
			"https://release-assets.githubusercontent.com/x",
		]) {
			const result = checkAllowedUrl(url);
			assert.equal(result.ok, true, url);
		}
	});

	it("拒绝非 https", () => {
		const result = checkAllowedUrl("http://github.com/o/r");
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.code, "PROTOCOL_NOT_ALLOWED");
	});

	it("拒绝白名单外的域名与内网地址", () => {
		for (const url of [
			"https://evil.com/x",
			"https://github.com.evil.com/x",
			"https://127.0.0.1/x",
			"https://192.168.1.1/x",
			"https://localhost/x",
		]) {
			const result = checkAllowedUrl(url);
			assert.equal(result.ok, false, url);
			if (result.ok) return;
			assert.equal(result.code, "HOST_NOT_ALLOWED", url);
		}
	});

	it("拒绝畸形 URL 与带凭据的 URL", () => {
		assert.equal(checkAllowedUrl("not a url").ok, false);
		const credentials = checkAllowedUrl("https://user:pass@github.com/o/r");
		assert.equal(credentials.ok, false);
		if (credentials.ok) return;
		assert.equal(credentials.code, "URL_INVALID");
	});

	it("isAllowedGitPath 只接受两段 owner/repo", () => {
		assert.equal(isAllowedGitPath("/o/r.git"), true);
		assert.equal(isAllowedGitPath("o/r"), true);
		assert.equal(isAllowedGitPath("/o/r/extra"), false);
		assert.equal(isAllowedGitPath("/../etc/passwd"), false);
		assert.equal(isAllowedGitPath("/o/.."), false);
	});

	it("parseGitPath 去掉 .git 后缀", () => {
		assert.deepEqual(parseGitPath("/o/r.git"), { owner: "o", repo: "r" });
		assert.equal(parseGitPath("/o/r/sub"), null);
		assert.equal(parseGitPath("/o/.."), null);
	});
});

describe("parseGithubInput：文档第 5 节的全部写法", () => {
	it("owner/repo", () => {
		const result = parseGithubInput("owner/repo");
		assert.equal(result.kind, "repo");
	});

	it("github.com 链接与 .git 后缀", () => {
		assert.equal(parseGithubInput("https://github.com/owner/repo").kind, "repo");
		assert.equal(parseGithubInput("https://github.com/owner/repo.git").kind, "repo");
		assert.equal(parseGithubInput("github.com/owner/repo").kind, "repo");
	});

	it("ssh 形式", () => {
		const result = parseGithubInput("git@github.com:owner/repo.git");
		assert.equal(result.kind, "repo");
		if (result.kind !== "repo") return;
		assert.equal(result.owner, "owner");
		assert.equal(result.repo, "repo");
	});

	it("release 页与 release 文件", () => {
		const tag = parseGithubInput("https://github.com/owner/repo/releases/tag/v1.2.3");
		assert.equal(tag.kind, "release");
		const file = parseGithubInput("https://github.com/owner/repo/releases/download/v1.2.3/app.zip");
		assert.equal(file.kind, "file");
		if (file.kind !== "file") return;
		assert.equal(file.origin, "release");
		assert.equal(file.tag, "v1.2.3");
		assert.equal(file.fileName, "app.zip");
	});

	it("archive 源码包", () => {
		const zip = parseGithubInput("https://github.com/owner/repo/archive/refs/heads/main.zip");
		assert.equal(zip.kind, "file");
		if (zip.kind !== "file") return;
		assert.equal(zip.ref, "main");
		assert.equal(zip.fileName, "main.zip");
		const tarball = parseGithubInput("https://github.com/owner/repo/archive/refs/tags/v1.2.3.tar.gz");
		assert.equal(tarball.kind, "file");
		if (tarball.kind !== "file") return;
		assert.equal(tarball.tag, "v1.2.3");
		assert.equal(tarball.fileName, "v1.2.3.tar.gz");
	});

	it("raw 文件", () => {
		const raw = parseGithubInput("https://raw.githubusercontent.com/owner/repo/main/docs/a.md");
		assert.equal(raw.kind, "file");
		if (raw.kind !== "file") return;
		assert.equal(raw.origin, "raw");
		assert.equal(raw.ref, "main");
		assert.equal(raw.fileName, "a.md");
		assert.equal(raw.url, "https://raw.githubusercontent.com/owner/repo/main/docs/a.md");
	});

	it("codeload 打包地址", () => {
		const result = parseGithubInput("https://codeload.github.com/owner/repo/zip/refs/heads/main");
		assert.equal(result.kind, "file");
		if (result.kind !== "file") return;
		assert.equal(result.origin, "archive");
		assert.equal(result.ref, "main");
		assert.equal(result.url, "https://codeload.github.com/owner/repo/zip/refs/heads/main");
	});

	it("忽略查询串与 fragment", () => {
		assert.equal(parseGithubInput("owner/repo?tab=readme").kind, "repo");
		assert.equal(parseGithubInput("https://github.com/owner/repo#readme").kind, "repo");
	});

	it("非法输入返回 invalid 与中文原因", () => {
		const cases = ["", "   ", "onlyone", "a/b/c/d", "https://gitlab.com/o/r", "ftp://github.com/o/r"];
		for (const input of cases) {
			const result = parseGithubInput(input);
			assert.equal(result.kind, "invalid", input);
			if (result.kind !== "invalid") return;
			assert.equal(result.error.length > 0, true);
		}
	});

	it("owner/repo 超过 100 字符拒绝", () => {
		const long = "a".repeat(101);
		assert.equal(parseGithubInput(long + "/repo").kind, "invalid");
	});
});

describe("fileNameFromUrl", () => {
	it("取最后一段并解码", () => {
		assert.equal(fileNameFromUrl("https://github.com/o/r/releases/download/v1/%E4%B8%AD%E6%96%87.zip"), "中文.zip");
		assert.equal(fileNameFromUrl("https://github.com/"), "download.bin");
		assert.equal(fileNameFromUrl("不是链接"), "download.bin");
	});
});

describe("Release 列表归一化", () => {
	it("把 GitHub 的 snake_case 转成节点契约", () => {
		const releases = normalizeReleases([
			{
				tag_name: "v1.2.3",
				name: "v1.2.3",
				published_at: "2026-01-01T00:00:00Z",
				prerelease: true,
				assets: [{ name: "app.zip", size: 1024, download_count: 7, browser_download_url: "https://github.com/o/r/releases/download/v1.2.3/app.zip" }],
			},
			{ name: "没有 tag 的条目应被丢弃" },
		]);
		assert.equal(releases.length, 1);
		const first = releases[0];
		assert.ok(first);
		assert.equal(first.tag, "v1.2.3");
		assert.equal(first.publishedAt, "2026-01-01T00:00:00Z");
		assert.equal(first.prerelease, true);
		assert.equal(first.assets.length, 1);
		assert.equal(first.assets[0]?.downloadCount, 7);
	});

	it("非数组输入返回空列表", () => {
		assert.deepEqual(normalizeReleases(null), []);
		assert.deepEqual(normalizeReleases({ releases: [] }), []);
		assert.equal(MAX_ASSETS_PER_RELEASE, 40);
	});
});
