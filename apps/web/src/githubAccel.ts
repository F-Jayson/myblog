// GitHub 加速下载：前端共享的类型与纯函数。
// 单独放在这里，是因为 api.ts 需要这些类型、页面组件需要这些格式化函数，
// 而字段名必须和 docs/github-accelerator.md 第 4、5 节的接口契约严格一致。

export type GithubAccelConfig = {
	enabled: boolean;
	configured: boolean;
	online: boolean;
	acceleratorBase: string;
	publicAllowed: boolean;
	ticketTtlMinutes: number;
};

// 与文档第 5 节一字不差。改动必须同步 apps/api/src/githubAccel.ts 的同名类型。
export type GithubResolved =
	| { kind: "repo"; owner: string; repo: string; repoUrl: string }
	| { kind: "release"; owner: string; repo: string; tag: string; repoUrl: string }
	| {
		kind: "file";
		owner: string;
		repo: string;
		fileName: string;
		url: string;
		origin: "release" | "archive" | "raw";
		tag?: string;
		ref?: string;
	}
	| { kind: "invalid"; error: string };

export type GithubReleaseAsset = {
	name: string;
	size: number;
	downloadCount: number;
	url: string;
};

export type GithubRelease = {
	tag: string;
	name: string;
	publishedAt: string;
	prerelease: boolean;
	assets: GithubReleaseAsset[];
};

/** POST /api/tools/github/download 的响应：downloadPath 是主站签发的短链。 */
export type GithubDownloadTicket = {
	downloadPath: string;
	fileName: string;
	expiresAt: string;
};

/** POST /api/tools/github/clone 的响应：clone 命令与 insteadOf 全局配置各一条。 */
export type GithubCloneInfo = {
	cloneUrl: string;
	command: string;
	insteadOf: string;
};

/** 节点状态徽标的三种语气，颜色写在 styles.css 的 github-accel-badge 里。 */
export type GithubAccelTone = "ok" | "warn" | "off";

export type GithubAccelStatus = {
	tone: GithubAccelTone;
	label: string;
	detail: string;
};

/** 输入框的占位示例：覆盖文档第 5 节里最常被粘贴的四类地址。 */
export const GITHUB_INPUT_EXAMPLES = [
	"https://github.com/microsoft/vscode/releases/download/1.95.0/VSCodeSetup-x64.exe",
	"https://github.com/vercel/next.js/releases/tag/v15.0.0",
	"https://github.com/facebook/react",
	"git@github.com:nodejs/node.git",
] as const;

/** 解析失败时给用户看的写法清单，条目来源是文档第 5 节。 */
export const GITHUB_SUPPORTED_PATTERNS = [
	"owner/repo",
	"https://github.com/owner/repo",
	"https://github.com/owner/repo.git",
	"git@github.com:owner/repo.git",
	"https://github.com/owner/repo/releases/tag/v1.2.3",
	"https://github.com/owner/repo/releases/download/v1.2.3/app.zip",
	"https://github.com/owner/repo/archive/refs/heads/main.zip",
	"https://github.com/owner/repo/archive/refs/tags/v1.2.3.tar.gz",
	"https://raw.githubusercontent.com/owner/repo/main/docs/a.md",
	"https://codeload.github.com/owner/repo/zip/refs/heads/main",
] as const;

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 按 1024 进制格式化体积；负数与非法值显示为破折号，避免表格里出现 NaN。 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${Number(value.toFixed(digits))} ${BYTE_UNITS[unit]}`;
}

/**
 * 相对时间。GitHub 的发布时间对读者来说"多久以前"比精确到分更有用；
 * 传 now 是为了让调用方在同一个渲染里保持多个时间一致。
 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
	if (!iso) return "";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const diff = now - time;
	if (diff < 60_000) return "刚刚";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} 天前`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months} 个月前`;
	return `${Math.floor(months / 12)} 年前`;
}

/** 下载量：GitHub 的计数可能上万，用"万"比五位数字好读。 */
export function formatCount(count: number): string {
	if (!Number.isFinite(count) || count < 0) return "0";
	if (count < 10_000) return count.toLocaleString("zh-CN");
	return `${Number((count / 10_000).toFixed(1))} 万`;
}

/** 把 config 与错误折叠成一个可直接渲染的徽标，页面不用再判断三四个布尔值。 */
export function githubAccelStatus(config: GithubAccelConfig | null, loadError = ""): GithubAccelStatus {
	if (loadError) return { tone: "warn", label: "状态未知", detail: loadError };
	if (!config) return { tone: "off", label: "读取配置中", detail: "正在读取加速节点的配置…" };
	if (!config.enabled) return { tone: "off", label: "功能已关闭", detail: "站点已关闭 GitHub 加速下载，请联系管理员开启。" };
	if (!config.configured) return { tone: "off", label: "加速节点未配置", detail: "主站没有设置 GITHUB_ACCEL_BASE_URL，暂时只能解析地址，不能下载。" };
	if (!config.online) return { tone: "warn", label: "加速节点不可达", detail: "主站访问不到加速节点，请检查域名、443 端口和防火墙。" };
	const access = config.publicAllowed ? "已开放公开下载" : "仅签名下载";
	return { tone: "ok", label: "加速节点已就绪", detail: `${config.acceleratorBase || "加速节点"} · ${access}` };
}

/** 判别辅助：让调用方在拿到 GithubResolved 后安全地收窄到某个分支。 */
export function isResolvedKind<K extends GithubResolved["kind"]>(
	value: GithubResolved,
	kind: K,
): value is Extract<GithubResolved, { kind: K }> {
	return value.kind === kind;
}

/** repo / release / file 三种结果都带 owner 和 repo，用来拉 Release 列表。 */
export function resolvedRepo(resolved: GithubResolved): { owner: string; repo: string } | null {
	return resolved.kind === "invalid" ? null : { owner: resolved.owner, repo: resolved.repo };
}

/** kind=release 时需要自动展开的 tag。 */
export function releaseTagOf(resolved: GithubResolved): string {
	return resolved.kind === "release" ? resolved.tag : "";
}

/**
 * 比较两个 GitHub 下载地址是否指向同一个资产：resolve 返回的地址可能保留了
 * 百分号编码，而 Release 列表里的 url 可能是解码后的，直接字符串比较会漏匹配。
 */
export function matchesGithubAsset(url: string, assetUrl: string): boolean {
	return Boolean(url && assetUrl) && normalizeAssetUrl(url) === normalizeAssetUrl(assetUrl);
}

function normalizeAssetUrl(url: string): string {
	const clean = url.trim().split("?")[0]?.split("#")[0] ?? "";
	try {
		return decodeURIComponent(clean);
	} catch {
		return clean;
	}
}
