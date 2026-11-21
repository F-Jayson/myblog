import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
	ArrowLeft,
	Bot,
	CheckCircle2,
	Copy,
	Laptop,
	ShieldCheck,
	Terminal,
	TriangleAlert,
} from "lucide-react";
import "./knowledge.css";

function CopyBlock({ code, label }: { code: string; label: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	};
	return (
		<div style={{ position: "relative", margin: "0.6rem 0 1rem 0" }}>
			<pre
				style={{
					margin: 0,
					padding: "0.9rem 1rem",
					borderRadius: "0.7rem",
					border: "1px solid var(--line)",
					background: "color-mix(in srgb, var(--card-bg-solid) 60%, #000 4%)",
					fontSize: "0.76rem",
					lineHeight: 1.7,
					overflowX: "auto",
					whiteSpace: "pre",
				}}
			>
				<code>{code}</code>
			</pre>
			<button
				type="button"
				className="kb-btn kb-btn-ghost kb-btn-xs"
				onClick={copy}
				style={{ position: "absolute", top: "0.5rem", right: "0.5rem", background: "var(--card-bg-solid)" }}
			>
				{copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
				{copied ? "已复制" : label}
			</button>
		</div>
	);
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
	return (
		<div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}>
			<span
				style={{
					flexShrink: 0,
					width: "1.6rem",
					height: "1.6rem",
					borderRadius: "9999px",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: "0.78rem",
					fontWeight: 700,
					color: "white",
					background: "var(--primary)",
				}}
			>
				{index}
			</span>
			<div style={{ minWidth: 0 }}>
				<strong style={{ display: "block", fontSize: "0.88rem", marginBottom: "0.25rem" }}>{title}</strong>
				<div style={{ fontSize: "0.82rem", color: "var(--muted-text)", lineHeight: 1.75 }}>{children}</div>
			</div>
		</div>
	);
}

export default function KnowledgeMcpHelpPage() {
	const origin = typeof window === "undefined" ? "https://你的站点地址" : window.location.origin;
	const localConfig = JSON.stringify(
		{
			mcpServers: {
				"knowledge-base": {
					command: "node",
					args: ["<项目路径>\\packages\\knowledge-mcp\\dist\\index.js"],
					env: { BLOG_ORIGIN: origin },
				},
			},
		},
		null,
		2,
	);

	return (
		<div className="kb-container" style={{ maxWidth: "56rem" }}>
			<div style={{ marginBottom: "1.25rem" }}>
				<Link to="/knowledge" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", color: "var(--muted-text)" }}>
					<ArrowLeft className="w-4 h-4" /> 返回个人知识库
				</Link>
			</div>

			<div className="kb-card" style={{ marginBottom: "1.25rem" }}>
				<h1 className="kb-page-title" style={{ marginBottom: "0.4rem" }}>
					<Bot className="w-7 h-7 text-primary" />
					MCP 接入帮助
				</h1>
				<p style={{ margin: 0, fontSize: "0.88rem", color: "var(--muted-text)", lineHeight: 1.8 }}>
					MCP 是让 AI 客户端（Claude Desktop、Cursor 等）安全访问你个人知识库的协议。接入后，你可以直接对 AI 说「帮我找一下读书笔记里关于深度工作的内容」，它会自己调用知识库工具完成检索和整理。下面按「本地客户端」和「远程客户端」两种情况说明，照着做即可。
				</p>
			</div>

			<div className="kb-card" style={{ marginBottom: "1.25rem" }}>
				<h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.75rem 0" }}>开始前请确认</h2>
				<ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem", color: "var(--muted-text)", lineHeight: 1.9 }}>
					<li>你已经用普通账号登录本站（不是管理员账号）。</li>
					<li>你已经开通个人知识库，并且至少创建了 1 个知识库。</li>
					<li>你的电脑安装了 Node.js 18 或更高版本（终端执行 <code>node -v</code> 能看到版本号）。</li>
					<li>仓库已经构建过知识库 MCP：<code>pnpm --filter @jayson-blog/knowledge-mcp build</code>。</li>
				</ul>
			</div>

			<div className="kb-card" style={{ marginBottom: "1.25rem" }}>
				<h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.35rem 0", display: "flex", alignItems: "center", gap: "0.45rem" }}>
					<Laptop className="w-4 h-4 text-primary" />
					方式一：本地客户端（推荐，Claude Desktop / Cursor）
				</h2>
				<p style={{ margin: "0 0 1rem 0", fontSize: "0.82rem", color: "var(--muted-text)" }}>
					本地客户端会在你的电脑上启动一个小程序，授权凭证只保存在本机，不会上传到聊天记录。
				</p>

				<Step index={1} title="找到客户端的 MCP 配置文件">
					<ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
						<li>Cursor：项目根目录的 <code>.cursor/mcp.json</code>，或全局的 <code>~/.cursor/mcp.json</code>。</li>
						<li>Claude Desktop：Windows 是 <code>%APPDATA%\Claude\claude_desktop_config.json</code>；macOS 是 <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>。</li>
					</ul>
				</Step>

				<Step index={2} title="把下面的配置粘贴进去">
					把 <code>&lt;项目路径&gt;</code> 换成你克隆仓库的目录（例如 <code>F:\@ts\myblog</code>）。如果文件里已经有别的 MCP，只需要把 <code>knowledge-base</code> 这一项加到 <code>mcpServers</code> 里。
				</Step>
				<CopyBlock code={localConfig} label="复制配置" />

				<Step index={3} title="重启客户端">
					完全退出并重新打开 Cursor / Claude Desktop，在 MCP 工具列表里应该能看到 <code>kb_status</code>、<code>kb_search</code>、<code>kb_create_document</code> 等工具。
				</Step>

				<Step index={4} title="让 AI 发起连接">
					在聊天框里输入：「连接我的个人知识库，需要读和写的权限」。AI 会调用 <code>kb_connect</code>，终端或输出面板会打印一个 8 位配对码，并自动打开浏览器授权页。
				</Step>

				<Step index={5} title="在浏览器里批准">
					用普通账号登录后，勾选允许访问的知识库、需要的权限和有效期（1–30 天），点「批准授权」。页面提示授权成功后，客户端会在几秒内自动拿到令牌。
				</Step>

				<Step index={6} title="验证">
					对 AI 说「查看知识库连接状态」，它调用 <code>kb_status</code> 后会返回授权账号、知识库范围和到期时间。看到这些信息就说明接入成功了。
				</Step>
			</div>

			<div className="kb-card" style={{ marginBottom: "1.25rem" }}>
				<h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.35rem 0", display: "flex", alignItems: "center", gap: "0.45rem" }}>
					<Terminal className="w-4 h-4 text-primary" />
					方式二：远程客户端（只填一个地址）
				</h2>
				<p style={{ margin: "0 0 0.5rem 0", fontSize: "0.82rem", color: "var(--muted-text)", lineHeight: 1.8 }}>
					如果你的客户端支持远程 MCP，只需要填下面这个地址，授权流程会自动弹出：
				</p>
				<CopyBlock code={origin + "/mcp/knowledge/sse"} label="复制地址" />
				<p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted-text)", lineHeight: 1.8 }}>
					注意：远程方式只能获得「读取、编辑、评论、上传附件」四类权限；公开发布、分享管理、删除、批量导出属于敏感操作，必须使用本地客户端授权。
				</p>
			</div>

			<div className="kb-card" style={{ marginBottom: "1.25rem" }}>
				<h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.6rem 0", display: "flex", alignItems: "center", gap: "0.45rem" }}>
					<ShieldCheck className="w-4 h-4 text-primary" />
					权限说明
				</h2>
				<div style={{ overflowX: "auto" }}>
					<table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
						<thead>
							<tr style={{ textAlign: "left", color: "var(--muted-text)" }}>
								<th style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>权限</th>
								<th style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>能做什么</th>
								<th style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>远程是否可用</th>
							</tr>
						</thead>
						<tbody>
							{[
								["kb:read", "浏览目录、读取文档、搜索", "可用"],
								["kb:write", "新建文档、编辑正文、移动目录、恢复版本", "可用"],
								["kb:comment", "发表和查看评论", "可用"],
								["kb:attachments", "上传图片和附件", "可用"],
								["kb:publish", "发布公开快照、撤回发布", "仅本地"],
								["kb:share", "管理协作者和分享链接", "仅本地"],
								["kb:delete", "移入回收站、恢复文档", "仅本地"],
								["kb:export", "批量导出 Markdown", "仅本地"],
							].map(([scope, desc, remote]) => (
								<tr key={scope}>
									<td style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)", fontFamily: "ui-monospace, monospace" }}>{scope}</td>
									<td style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)", color: "var(--muted-text)" }}>{desc}</td>
									<td style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)", color: remote === "可用" ? "var(--primary)" : "var(--muted-text)", fontWeight: 600 }}>{remote}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<div className="kb-card">
				<h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.6rem 0", display: "flex", alignItems: "center", gap: "0.45rem" }}>
					<TriangleAlert className="w-4 h-4 text-warning" />
					常见问题
				</h2>
				<div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.82rem", color: "var(--muted-text)", lineHeight: 1.75 }}>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>授权页打不开或打开的是 API 端口？</strong>
						<br />
						检查配置里的 <code>BLOG_ORIGIN</code> 是否填了站点地址。开发环境填 <code>http://localhost:5174</code>，生产环境填你的域名。
					</div>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>调用工具返回 401？</strong>
						<br />
						令牌过期或被撤销了。重新让 AI 调用 <code>kb_connect</code>，再走一次浏览器授权即可。
					</div>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>返回 403 权限不足？</strong>
						<br />
						当前授权的 Scope 或知识库范围不够。到「知识库设置 → AI 客户端连接」撤销旧授权，再重新授权并勾选需要的库和权限。
					</div>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>保存时提示 409 版本冲突？</strong>
						<br />
						文档在你读取之后被修改过。让 AI 重新读取最新版本再保存，不要覆盖别人的修改。
					</div>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>客户端里看不到工具？</strong>
						<br />
						先确认 <code>node -v</code> 正常、<code>dist/index.js</code> 存在，再完全重启客户端。Cursor 还需要在 MCP 面板里手动刷新。
					</div>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>怎么撤销授权？</strong>
						<br />
						打开「知识库设置 → AI 客户端连接 (MCP 授权)」，点「撤销授权」。撤销后客户端下一次调用会立即失败。
					</div>
					<div>
						<strong style={{ color: "var(--deep-text)" }}>令牌安全吗？</strong>
						<br />
						访问令牌只保存在你本机的 <code>~/.jayson-blog-knowledge/credentials.json</code>，不会出现在聊天记录里。请不要把令牌或这个文件发给别人。
					</div>
				</div>
			</div>
		</div>
	);
}
