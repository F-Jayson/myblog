import { Calculator, X } from "lucide-react";

export interface ActivityThresholds {
	minScore: number;
	minLoginDaysD: number;
	minServiceDaysS: number;
	minTimeWindowsW: number;
	minAgeDays: number;
}

const SERVICE_ROWS = [
	{ action: "保存在线剪贴板", points: "1 分", note: "同一份内容每天最多 1 次" },
	{ action: "上传图片到图床", points: "1 分", note: "同一张图每天最多 1 次" },
	{ action: "在线编译器成功运行", points: "2 分", note: "同一段代码每天最多 1 次，报错/超时不算" },
	{ action: "评论被管理员审核通过", points: "1 分", note: "每条评论只算 1 次" },
	{ action: "手动保存知识库文档", points: "1 分", note: "自动保存不算，按保存出的新版本计" },
];

export default function KnowledgeActivityGuide({
	open,
	onClose,
	thresholds,
}: {
	open: boolean;
	onClose: () => void;
	thresholds: ActivityThresholds;
}) {
	if (!open) return null;

	return (
		<div className="kb-modal-overlay" onClick={onClose} role="presentation">
			<div
				className="kb-modal-card max-w-2xl"
				onClick={(event) => event.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-labelledby="kb-activity-guide-title"
			>
				<div className="kb-modal-header">
					<h2 className="kb-modal-title" id="kb-activity-guide-title">
						<Calculator className="w-5 h-5 text-primary" />
						活跃度怎么算？
					</h2>
					<button type="button" className="kb-btn kb-btn-ghost kb-btn-xs" onClick={onClose} aria-label="关闭">
						<X className="w-4 h-4" />
					</button>
				</div>

				<p style={{ fontSize: "0.85rem", color: "var(--muted-text)", margin: "0 0 1rem 0", lineHeight: 1.7 }}>
					开通知识库需要同时满足四项指标和综合分。统计范围是<strong>最近 30 个已结算的 UTC 自然日</strong>（截止到 UTC 昨天，不含今天），所以今天做的事明天才会体现在数字里。
				</p>

				<div
					style={{
						padding: "0.9rem 1rem",
						borderRadius: "0.75rem",
						border: "1px solid var(--line)",
						background: "color-mix(in srgb, var(--primary) 6%, transparent)",
						fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
						fontSize: "0.78rem",
						lineHeight: 1.8,
						marginBottom: "1.1rem",
					}}
				>
					综合分 = round( 50 × min(D/15, 1) + 35 × min(U/60, 1) + 15 × min(W/4, 1) )
					<br />
					达标线：综合分 ≥ {thresholds.minScore} 且 D ≥ {thresholds.minLoginDaysD} 且 S ≥ {thresholds.minServiceDaysS} 且 W ≥ {thresholds.minTimeWindowsW}
				</div>

				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))", gap: "0.75rem", marginBottom: "1.1rem" }}>
					{[
						{ key: "D", name: "有效登录", desc: "当天登录过站点就算 1 天，同一天登录多次仍算 1 天", target: `≥ ${thresholds.minLoginDaysD} 天` },
						{ key: "U", name: "服务积分", desc: "下面表格里的行为累计得分，60 分封顶", target: "参与算分" },
						{ key: "S", name: "服务天数", desc: "当天至少完成 1 次有效服务行为就算 1 天", target: `≥ ${thresholds.minServiceDaysS} 天` },
						{ key: "W", name: "时间跨度", desc: "30 天切成 4 个 7 天段，至少覆盖 2 段，避免临时抱佛脚", target: `≥ ${thresholds.minTimeWindowsW} 段` },
					].map((item) => (
						<div key={item.key} style={{ padding: "0.75rem 0.85rem", borderRadius: "0.7rem", border: "1px solid var(--line)" }}>
							<div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.3rem" }}>
								<span className="kb-status-badge">{item.key}</span>
								<strong style={{ fontSize: "0.86rem" }}>{item.name}</strong>
							</div>
							<p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted-text)", lineHeight: 1.6 }}>{item.desc}</p>
							<span style={{ display: "inline-block", marginTop: "0.35rem", fontSize: "0.75rem", color: "var(--primary)", fontWeight: 700 }}>
								{item.target}
							</span>
						</div>
					))}
				</div>

				<h3 style={{ fontSize: "0.9rem", fontWeight: 700, margin: "0 0 0.5rem 0" }}>哪些行为会加分</h3>
				<div style={{ overflowX: "auto", marginBottom: "0.9rem" }}>
					<table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
						<thead>
							<tr style={{ textAlign: "left", color: "var(--muted-text)" }}>
								<th style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>行为</th>
								<th style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>分值</th>
								<th style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>去重规则</th>
							</tr>
						</thead>
						<tbody>
							{SERVICE_ROWS.map((row) => (
								<tr key={row.action}>
									<td style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)" }}>{row.action}</td>
									<td style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)", fontWeight: 700, color: "var(--primary)" }}>{row.points}</td>
									<td style={{ padding: "0.4rem 0.5rem", borderBottom: "1px solid var(--line)", color: "var(--muted-text)" }}>{row.note}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<p style={{ fontSize: "0.78rem", color: "var(--muted-text)", margin: "0 0 1rem 0", lineHeight: 1.7 }}>
					每日上限：同一类行为每天最多 4 分，所有行为合计每天最多 8 分；重复提交相同内容不会重复计分。注册时间还需要严格超过 {thresholds.minAgeDays} 天。
				</p>

				<h3 style={{ fontSize: "0.9rem", fontWeight: 700, margin: "0 0 0.5rem 0" }}>怎么快速达标</h3>
				<ul style={{ margin: "0 0 1rem 0", paddingLeft: "1.2rem", fontSize: "0.8rem", color: "var(--muted-text)", lineHeight: 1.8 }}>
					<li>每天登录一次，先把 D 攒够 {thresholds.minLoginDaysD} 天。</li>
					<li>每天至少做一次会加分的事（保存剪贴板、传图、跑代码、写评论、保存知识库），把 S 攒够 {thresholds.minServiceDaysS} 天。</li>
					<li>不要集中在一两天做完，至少跨 2 个 7 天段，W 才会达标。</li>
					<li>如果确实来不及，可以在知识库首页提交「申请直接开通」，由管理员审核。</li>
				</ul>

				<div style={{ padding: "0.75rem 0.9rem", borderRadius: "0.7rem", background: "color-mix(in srgb, #f59e0b 8%, transparent)", border: "1px solid color-mix(in srgb, #f59e0b 30%, var(--line))", fontSize: "0.78rem", color: "var(--muted-text)", lineHeight: 1.7 }}>
					状态说明：达标后为「正常使用」；已开通但活跃度下降会进入 14 天宽限期，期间仍可编辑既有库但不能发布；宽限期结束仍未恢复会变成只读，但内容不会被删除。
				</div>

				<div className="kb-modal-footer">
					<button type="button" className="kb-btn kb-btn-primary" onClick={onClose}>
						我知道了
					</button>
				</div>
			</div>
		</div>
	);
}
