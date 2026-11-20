import {
	Check,
	ChevronRight,
	CircleAlert,
	Copy,
	Download,
	ExternalLink,
	Github,
	LoaderCircle,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { createGithubClone, createGithubDownload, fetchGithubAccelConfig, fetchGithubReleases, resolveGithubInput } from "./api";
import { useAuth } from "./auth";
import {
	GITHUB_INPUT_EXAMPLES,
	GITHUB_SUPPORTED_PATTERNS,
	formatBytes,
	formatCount,
	formatRelativeTime,
	githubAccelStatus,
	isResolvedKind,
	matchesGithubAsset,
	releaseTagOf,
	resolvedRepo,
	type GithubAccelConfig,
	type GithubCloneInfo,
	type GithubRelease,
	type GithubResolved,
} from "./githubAccel";

type ReleasePhase = "idle" | "loading" | "ready" | "error";

const DOWNLOAD_HINT = "已交给浏览器下载，可在浏览器下载列表里查看进度、暂停或续传。";

const ORIGIN_LABELS: Record<"release" | "archive" | "raw", string> = {
	release: "Release 附件",
	archive: "仓库归档",
	raw: "raw 文件",
};

/** 复制到剪贴板：非安全上下文里 navigator.clipboard 不可用，退回 execCommand。 */
async function copyText(text: string) {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return;
		}
	} catch {
		/* 落回下面的兜底路径 */
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	document.execCommand("copy");
	area.remove();
}

/**
 * 先探一次再下载：直接用 window.location 跳到下载短链，一旦节点返回 4xx/5xx（ticket 过期、
 * 上游超时、限流），浏览器会把整个页面换成错误页，用户既看不到原因也丢了当前输入。
 * 这里先用 HEAD 预检状态码（不发 Range，避免为探测真的向上游拉一次字节、污染缓存语义），
 * 失败就把节点/主站的中文错误留在页面上，成功才真正触发下载。
 */
async function probeDownload(path: string): Promise<string> {
	let response: Response;
	try {
		// HEAD 不传输文件字节：命中缓存时只回响应头，未命中时节点也只向上游发一次 HEAD。
		response = await fetch(path, { method: "HEAD", redirect: "follow", cache: "no-store" });
	} catch {
		// 网络层异常（离线、被插件拦截）交给后面真正的下载去尝试，不在这里拦。
		return "";
	}
	// 405 说明这条链路不支持 HEAD，不能据此判定失败，交给真正的下载去试。
	if (response.ok || response.status === 405) {
		await response.body?.cancel().catch(() => undefined);
		return "";
	}
	const raw = await response.text().catch(() => "");
	await response.body?.cancel().catch(() => undefined);
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			const message = (parsed as { error?: unknown }).error;
			if (typeof message === "string" && message.trim()) return message.trim();
		}
	} catch {
		/* 非 JSON 响应，退回到状态码 */
	}
	// 节点对上游错误是透传的，body 往往是 GitHub 的纯文本 "Not Found"，
	// 这里按状态码给中文说明，比把英文原文丢给用户更容易理解。
	if (response.status === 404) return "GitHub 返回 404：仓库、Release 或附件不存在，请检查地址。";
	if (response.status === 429) return "请求过于频繁，已被限流，请稍后再试。";
	if (response.status === 401 || response.status === 403) return "下载被拒绝（ticket 无效或已过期），请重新点一次下载。";
	if (response.status >= 500) return "加速节点暂时不可用（HTTP " + response.status + "），请稍后重试。";
	return "加速节点返回 HTTP " + response.status + "，请稍后重试。";
}

/** 用临时 <a download> 触发下载：不接管当前页面，失败也不会把工具页顶掉。 */
function triggerDownload(path: string, fileName: string) {
	const link = document.createElement("a");
	link.href = path;
	link.rel = "noopener";
	if (fileName) link.download = fileName;
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	link.remove();
}

/** 时间精确到分钟即可，用于"链接几点前有效"和 Release 发布时间。 */
function clockOf(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function CopyChip({ text, label = "复制" }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<button
			className="user-tool-button"
			type="button"
			disabled={!text}
			onClick={() => {
				void copyText(text).then(() => {
					setCopied(true);
					setFailed(false);
					window.setTimeout(() => setCopied(false), 1600);
				}).catch(() => {
					setCopied(false);
					setFailed(true);
				});
			}}
		>
			{copied ? <Check size={14} /> : <Copy size={14} />}
			{copied ? "已复制" : failed ? "复制失败" : label}
		</button>
	);
}

type ReleaseListProps = {
	phase: ReleasePhase;
	error: string;
	releases: GithubRelease[];
	expandedTag: string;
	missingTag: string;
	actionsEnabled: boolean;
	downloading: string;
	onToggle: (tag: string) => void;
	onRefresh: () => void;
	onDownload: (assetUrl: string) => void;
};

function ReleaseList({ phase, error, releases, expandedTag, missingTag, actionsEnabled, downloading, onToggle, onRefresh, onDownload }: ReleaseListProps) {
	return (
		<section className="github-accel-block">
			<div className="github-accel-block-head">
				<h3>Release 附件</h3>
				<button className="user-tool-button" type="button" disabled={phase === "loading"} onClick={onRefresh}>
					<RefreshCw size={14} />刷新
				</button>
			</div>
			{phase === "loading" ? <p className="github-accel-hint"><LoaderCircle className="github-accel-spin" size={15} /> 正在读取 Release 列表…</p> : null}
			{phase === "error" ? <p className="user-tool-error" role="alert">{error}</p> : null}
			{phase === "ready" && !releases.length ? <p className="github-accel-hint">这个仓库最近没有公开的 Release，可以直接用仓库归档地址，或改用下面的 clone 命令。</p> : null}
			{missingTag ? <p className="github-accel-hint">列表里没有 {missingTag}：这里只取最近的 20 个版本，它可能更早发布。</p> : null}
			{releases.map((release) => {
				const expanded = release.tag === expandedTag;
				const published = release.publishedAt;
				return (
					<article className="github-accel-release" key={release.tag}>
						<button
							type="button"
							className="github-accel-release-head"
							aria-expanded={expanded}
							onClick={() => onToggle(release.tag)}
						>
							<ChevronRight className={expanded ? "github-accel-chevron is-open" : "github-accel-chevron"} size={16} />
							<span className="github-accel-tag">{release.tag}</span>
							{release.name && release.name !== release.tag ? <span className="github-accel-release-name">{release.name}</span> : null}
							{release.prerelease ? <span className="github-accel-prerelease">预发布</span> : null}
							<span className="github-accel-release-time" title={published ? clockOf(published) : ""}>
								{formatRelativeTime(published) || "发布时间未知"}
							</span>
							<span className="github-accel-release-count">{release.assets.length} 个文件</span>
						</button>
						{expanded ? (
							release.assets.length ? (
								<div className="github-accel-asset-scroll">
									<table className="github-accel-assets">
										<thead>
											<tr>
												<th scope="col">名称</th>
												<th scope="col">大小</th>
												<th scope="col">下载量</th>
												<th scope="col" aria-label="操作" />
											</tr>
										</thead>
										<tbody>
											{release.assets.map((asset) => {
												const busy = downloading === asset.url;
												return (
													<tr key={asset.url}>
														<td className="github-accel-asset-name">{asset.name}</td>
														<td>{formatBytes(asset.size)}</td>
														<td>{formatCount(asset.downloadCount)}</td>
														<td className="github-accel-asset-action">
															<button
																className="user-tool-button"
																type="button"
																disabled={!actionsEnabled || busy}
																aria-busy={busy}
																onClick={() => onDownload(asset.url)}
															>
																{busy ? <LoaderCircle className="github-accel-spin" size={14} /> : <Download size={14} />}
																{busy ? "签发中…" : "下载"}
															</button>
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							) : (
								<p className="github-accel-hint">这个版本没有可下载的附件。</p>
							)
						) : null}
					</article>
				);
			})}
		</section>
	);
}

export default function GithubAccelPage() {
	const { features } = useAuth();
	const featureEnabled = features.githubAccelEnabled !== false;
	const [config, setConfig] = useState<GithubAccelConfig | null>(null);
	const [configError, setConfigError] = useState("");
	const [input, setInput] = useState("");
	const [resolved, setResolved] = useState<GithubResolved | null>(null);
	const [resolving, setResolving] = useState(false);
	const [resolveError, setResolveError] = useState("");
	const [clone, setClone] = useState<GithubCloneInfo | null>(null);
	const [cloneLoading, setCloneLoading] = useState(false);
	const [cloneError, setCloneError] = useState("");
	const [releases, setReleases] = useState<GithubRelease[]>([]);
	const [releasePhase, setReleasePhase] = useState<ReleasePhase>("idle");
	const [releaseError, setReleaseError] = useState("");
	const [expandedTag, setExpandedTag] = useState("");
	const [downloading, setDownloading] = useState("");
	const [downloadError, setDownloadError] = useState("");
	const [downloadNote, setDownloadNote] = useState("");

	const status = githubAccelStatus(config, configError);
	const actionsEnabled = featureEnabled && config?.enabled !== false && config?.configured === true;

	const loadConfig = useCallback(async () => {
		if (!featureEnabled) {
			setConfig(null);
			setConfigError("");
			return;
		}
		try {
			setConfig(await fetchGithubAccelConfig());
			setConfigError("");
		} catch (error) {
			setConfig(null);
			setConfigError(error instanceof Error ? error.message : "无法读取加速节点配置");
		}
	}, [featureEnabled]);

	useEffect(() => {
		void loadConfig();
	}, [loadConfig]);

	const loadClone = useCallback(async (owner: string, repo: string) => {
		setCloneLoading(true);
		setCloneError("");
		try {
			setClone(await createGithubClone(owner, repo));
		} catch (error) {
			setClone(null);
			setCloneError(error instanceof Error ? error.message : "生成 clone 命令失败，请稍后重试。");
		} finally {
			setCloneLoading(false);
		}
	}, []);

	const loadReleases = useCallback(async (owner: string, repo: string, preferredTag: string) => {
		setReleasePhase("loading");
		setReleaseError("");
		try {
			const list = await fetchGithubReleases(owner, repo);
			setReleases(list);
			setReleasePhase("ready");
			// 优先展开用户点名的版本；否则保留上次展开的，再否则展开最新的一个
			setExpandedTag((current) => preferredTag || (current && list.some((item) => item.tag === current) ? current : list[0]?.tag ?? ""));
		} catch (error) {
			setReleases([]);
			setReleasePhase("error");
			setReleaseError(error instanceof Error ? error.message : "Release 列表加载失败，请稍后重试。");
		}
	}, []);

	const startDownload = async (url: string, key: string) => {
		setDownloading(key);
		setDownloadError("");
		setDownloadNote("");
		try {
			const ticket = await createGithubDownload(url);
			const failure = await probeDownload(ticket.downloadPath);
			if (failure) {
				setDownloadError(failure);
				return;
			}
			const validUntil = clockOf(ticket.expiresAt);
			setDownloadNote(validUntil ? DOWNLOAD_HINT + "本次链接在 " + validUntil + " 前有效。" : DOWNLOAD_HINT);
			// 主站短链会 302 到加速节点并带上 attachment；用 <a download> 触发，页面不会被顶掉
			triggerDownload(ticket.downloadPath, ticket.fileName);
		} catch (error) {
			setDownloadError(error instanceof Error ? error.message : "下载链接签发失败，请稍后重试。");
		} finally {
			setDownloading("");
		}
	};

	const runResolve = async () => {
		const value = input.trim();
		if (!value) {
			setResolveError("请先粘贴 GitHub 链接或 owner/repo。");
			return;
		}
		if (!featureEnabled) return;
		setResolving(true);
		setResolveError("");
		setDownloadError("");
		setDownloadNote("");
		setClone(null);
		setCloneError("");
		setReleases([]);
		setReleasePhase("idle");
		setReleaseError("");
		setExpandedTag("");
		try {
			const result = await resolveGithubInput(value);
			setResolved(result);
			const target = resolvedRepo(result);
			if (!target || result.kind === "invalid") return;
			if (result.kind === "repo") {
				void loadClone(target.owner, target.repo);
				void loadReleases(target.owner, target.repo, "");
				return;
			}
			if (result.kind === "release") {
				void loadReleases(target.owner, target.repo, releaseTagOf(result));
				return;
			}
			// Release 附件顺带查一次列表，好在文件卡片里显示真实大小和下载量
			if (result.origin === "release") void loadReleases(target.owner, target.repo, "");
		} catch (error) {
			setResolved(null);
			setResolveError(error instanceof Error ? error.message : "解析失败，请稍后重试。");
		} finally {
			setResolving(false);
		}
	};

	const matchedAsset = useMemo(() => {
		if (!resolved || !isResolvedKind(resolved, "file") || resolved.origin !== "release") return null;
		for (const release of releases) {
			for (const asset of release.assets) {
				if (matchesGithubAsset(resolved.url, asset.url)) return asset;
			}
		}
		return null;
	}, [releases, resolved]);

	const repoInfo = resolved ? resolvedRepo(resolved) : null;
	const showRepoResult = Boolean(resolved && repoInfo && (resolved.kind === "repo" || resolved.kind === "release"));
	const missingTag = resolved && isResolvedKind(resolved, "release") && releasePhase === "ready" && !releases.some((item) => item.tag === resolved.tag) ? resolved.tag : "";

	return (
		<section className="card content-card user-tool-page github-accel-page">
			<header className="user-tool-heading">
				<div>
					<span className="tool-eyebrow">DEV TOOLS</span>
					<h2><Github size={22} /> GitHub 加速下载</h2>
					<p>把 GitHub 的安装包、Release 附件或仓库地址交给加速节点直传，主站只签发票据并跳转，文件字节不经过本站。</p>
				</div>
				<Link className="user-tool-link" to="/tools">返回列表</Link>
			</header>

			<div className="github-accel-status">
				<span className={"github-accel-badge is-" + status.tone}>{status.label}</span>
				<span className="github-accel-status-text">{status.detail}</span>
				{configError ? <button className="user-tool-button" type="button" onClick={() => void loadConfig()}><RefreshCw size={14} />重试</button> : null}
			</div>

			<p className="github-accel-lead">文件由加速节点直传浏览器，本站只做签名与跳转。</p>

			{!featureEnabled ? <p className="user-tool-error" role="alert"><CircleAlert size={15} /> 站点已关闭 GitHub 加速下载功能。</p> : null}

			<div className="dev-tool-stack">
				<label className="dev-tool-field">
					GitHub 链接或 owner/repo
					<textarea
						className="dev-tool-textarea github-accel-input"
						value={input}
						spellCheck={false}
						disabled={!featureEnabled}
						placeholder={GITHUB_INPUT_EXAMPLES.join("\n")}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={(event) => {
							// 回车直接解析；Shift+回车留给换行，多行粘贴时不会误触
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void runResolve();
							}
						}}
					/>
				</label>
				<div className="dev-tool-actions">
					<button className="user-tool-button primary" type="button" disabled={!featureEnabled || resolving} aria-busy={resolving} onClick={() => void runResolve()}>
						{resolving ? <LoaderCircle className="github-accel-spin" size={15} /> : null}
						{resolving ? "解析中…" : "解析"}
					</button>
					<button
						className="user-tool-button"
						type="button"
						disabled={!input.trim() && !resolved}
						onClick={() => {
							setInput("");
							setResolved(null);
							setResolveError("");
							setClone(null);
							setReleases([]);
							setReleasePhase("idle");
							setDownloadError("");
							setDownloadNote("");
						}}
					>
						清空
					</button>
					<span className="github-accel-hint">粘贴后不会自动请求，确认内容后再点"解析"或按回车。</span>
				</div>
			</div>

			{resolveError ? <p className="user-tool-error" role="alert">{resolveError}</p> : null}

			{resolved && resolved.kind === "invalid" ? (
				<div className="github-accel-block">
					<p className="user-tool-error" role="alert">{resolved.error}</p>
					<p className="github-accel-subtitle">支持下面这些写法：</p>
					<ul className="github-accel-support">
						{GITHUB_SUPPORTED_PATTERNS.map((pattern) => <li key={pattern}><code>{pattern}</code></li>)}
					</ul>
				</div>
			) : null}

			{resolved && resolved.kind === "file" ? (
				<section className="github-accel-card">
					<div className="github-accel-card-head">
						<strong className="github-accel-filename"><Github size={16} />{resolved.fileName}</strong>
						<span className="github-accel-origin">{ORIGIN_LABELS[resolved.origin]}</span>
					</div>
					<dl className="github-accel-facts">
						<div><dt>仓库</dt><dd>{resolved.owner}/{resolved.repo}</dd></div>
						{resolved.tag ? <div><dt>版本</dt><dd>{resolved.tag}</dd></div> : null}
						{resolved.ref ? <div><dt>分支 / 引用</dt><dd>{resolved.ref}</dd></div> : null}
						<div><dt>大小</dt><dd>{matchedAsset ? formatBytes(matchedAsset.size) : "以浏览器下载时为准"}</dd></div>
						{matchedAsset ? <div><dt>下载量</dt><dd>{formatCount(matchedAsset.downloadCount)}</dd></div> : null}
					</dl>
					<div className="dev-tool-actions">
						<button
							className="user-tool-button primary"
							type="button"
							disabled={!actionsEnabled || downloading === "file"}
							aria-busy={downloading === "file"}
							onClick={() => void startDownload(resolved.url, "file")}
						>
							{downloading === "file" ? <LoaderCircle className="github-accel-spin" size={15} /> : <Download size={15} />}
							{downloading === "file" ? "签发中…" : "开始下载"}
						</button>
						<span className="github-accel-hint">{actionsEnabled ? "由加速节点直传，支持断点续传。" : status.detail}</span>
					</div>
				</section>
			) : null}

			{showRepoResult && resolved && repoInfo ? (
				<>
					{resolved.kind === "repo" ? (
						<section className="github-accel-card">
							<div className="github-accel-card-head">
								<strong><Github size={16} />{resolved.owner}/{resolved.repo}</strong>
								<a className="user-tool-link" href={resolved.repoUrl} target="_blank" rel="noreferrer">在 GitHub 打开<ExternalLink size={13} /></a>
							</div>
							{cloneLoading ? <p className="github-accel-hint"><LoaderCircle className="github-accel-spin" size={15} /> 正在生成 clone 命令…</p> : null}
							{cloneError ? (
								<>
									<p className="user-tool-error" role="alert">{cloneError}</p>
									<div className="dev-tool-actions">
										<button className="user-tool-button" type="button" onClick={() => void loadClone(repoInfo.owner, repoInfo.repo)}>
											<RefreshCw size={14} />重试
										</button>
									</div>
								</>
							) : null}
							{clone ? (
								<>
									<div className="github-accel-command">
										<span>克隆命令</span>
										<code>{clone.command}</code>
										<CopyChip text={clone.command} label="复制命令" />
									</div>
									{clone.insteadOf ? (
										<div className="github-accel-command">
											<span>全局配置</span>
											<code>{clone.insteadOf}</code>
											<CopyChip text={clone.insteadOf} label="复制配置" />
										</div>
									) : null}
									<p className="github-accel-hint">全局配置执行一次后，本机所有 github.com 的 clone 都会自动走加速节点；只影响 clone / fetch，不影响 push。</p>
								</>
							) : null}
						</section>
					) : null}
					{resolved.kind === "release" ? (
						<section className="github-accel-card">
							<div className="github-accel-card-head">
								<strong><Github size={16} />{resolved.owner}/{resolved.repo} · {resolved.tag}</strong>
								<a className="user-tool-link" href={resolved.repoUrl + "/releases/tag/" + resolved.tag} target="_blank" rel="noreferrer">在 GitHub 打开<ExternalLink size={13} /></a>
							</div>
							<p className="github-accel-hint">这是某个版本的页面，下面已自动展开 <span className="github-accel-tag">{resolved.tag}</span> 的附件。</p>
						</section>
					) : null}
					<ReleaseList
						phase={releasePhase}
						error={releaseError}
						releases={releases}
						expandedTag={expandedTag}
						missingTag={missingTag}
						actionsEnabled={actionsEnabled}
						downloading={downloading}
						onToggle={(tag) => setExpandedTag((current) => (current === tag ? "" : tag))}
						onRefresh={() => void loadReleases(repoInfo.owner, repoInfo.repo, expandedTag)}
						onDownload={(assetUrl) => void startDownload(assetUrl, assetUrl)}
					/>
				</>
			) : null}

			{downloadNote ? <p className="user-tool-message" role="status">{downloadNote}</p> : null}
			{downloadError ? <p className="user-tool-error" role="alert">{downloadError}</p> : null}

			<section className="github-accel-limits">
				<h3>使用限制</h3>
				<ul>
					<li>只支持公开仓库：私有仓库需要 token，本方案不保存任何用户凭据，因此一律拒绝。</li>
					<li>只加速下载与 clone，不支持 git push；push 请求会被加速节点直接拒绝。</li>
					<li>按 IP 限流：默认每分钟 30 次、同时最多 3 个连接；超限时会提示稍后再试。</li>
					<li>下载短链有有效期，过期后重新点一次"下载"即可重新签发。</li>
				</ul>
			</section>
		</section>
	);
}
