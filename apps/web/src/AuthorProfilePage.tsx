import { AtSign, BookOpen, Boxes, Braces, Code2, Cpu, Database, GitBranch, Github, Globe2, Layers3, Mail, MapPin, MessageCircle, Palette, Pencil, Rss, Server, ShieldCheck, Terminal, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import MarkdownContent from "./MarkdownContent";
import { api } from "./api";
import { fallbackSite } from "./data";
import { isSafeNavigationUrl, resolveMediaUrl } from "./media";
import type { LucideIcon } from "lucide-react";
import type { AuthorHeatmap, AuthorHeatmapDay, AuthorProfile, SiteData } from "./types";

type HeatmapCell = { date: string; count: number } | null;
type MonthLabel = { label: string; week: number };

function initialAuthor(site: SiteData): AuthorProfile {
	const author = site.author ?? fallbackSite.author!;
	return { name: author.name, bio: author.bio, avatar: author.avatar, email: author.email, githubUrl: author.githubUrl, qqUrl: author.qqUrl, rssUrl: author.rssUrl, links: author.links ?? [], headline: null, location: null, website: null, introduction: null, skills: [], learning: [] };
}

function localDate(value: string) { return new Date(value + "T00:00:00"); }
function dateKey(value: Date) { return String(value.getFullYear()) + "-" + String(value.getMonth() + 1).padStart(2, "0") + "-" + String(value.getDate()).padStart(2, "0"); }
function addDays(value: Date, days: number) { const result = new Date(value); result.setDate(result.getDate() + days); return result; }

function buildHeatmap(days: AuthorHeatmapDay[]) {
	const activity = days.filter((day) => /^\d{4}-\d{2}-\d{2}$/u.test(day.date)).sort((left, right) => left.date.localeCompare(right.date));
	if (!activity.length) return { cells: [] as HeatmapCell[], months: [] as MonthLabel[] };
	const first = localDate(activity[0].date); const last = localDate(activity[activity.length - 1].date);
	const start = addDays(first, -first.getDay()); const finish = addDays(last, 6 - last.getDay());
	const byDate = new Map(activity.map((day) => [day.date, Math.max(0, day.count)]));
	const cells: HeatmapCell[] = []; const months: MonthLabel[] = []; let previousMonth = -1;
	for (let cursor = new Date(start), index = 0; cursor <= finish; cursor = addDays(cursor, 1), index += 1) {
		const date = dateKey(cursor);
		if (cursor.getMonth() !== previousMonth && Math.floor(index / 7) < 53) { months.push({ label: new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(cursor), week: Math.floor(index / 7) }); previousMonth = cursor.getMonth(); }
		cells.push(byDate.has(date) ? { date, count: byDate.get(date) ?? 0 } : null);
	}
	return { cells: cells.slice(0, 53 * 7), months };
}

function levelFor(count: number, maximum: number) { return count <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(count / Math.max(1, maximum) * 4))); }

function ArticleHeatmap({ heatmap }: { heatmap: AuthorHeatmap | null }) {
	const layout = useMemo(() => buildHeatmap(heatmap?.days ?? []), [heatmap]);
	if (!heatmap || !layout.cells.length || heatmap.totalPosts <= 0) return <section className="author-section author-heatmap-section"><div className="author-section-heading"><div><span className="author-eyebrow">CONTRIBUTIONS</span><h2>文章发布热力图</h2></div></div><p className="author-empty">暂时没有可展示的文章发布记录。</p></section>;
	const maximum = Math.max(1, ...layout.cells.flatMap((cell) => cell ? [cell.count] : []));
	const total = Number.isFinite(heatmap.totalPosts) ? heatmap.totalPosts : layout.cells.reduce((sum, cell) => sum + (cell?.count ?? 0), 0);
	const period = heatmap.from && heatmap.to ? heatmap.from + " 至 " + heatmap.to : "最近 365 天";
	return <section className="author-section author-heatmap-section"><div className="author-section-heading"><div><span className="author-eyebrow">CONTRIBUTIONS</span><h2>文章发布热力图</h2></div><strong>{total} 篇</strong></div><p className="author-heatmap-period">{period}</p><div className="author-heatmap-scroll" role="region" aria-label="文章发布热力图，可横向滚动查看全部 53 周"><div className="author-heatmap"><div className="author-heatmap-months">{layout.months.map((month) => <span key={month.label + month.week} style={{ gridColumnStart: month.week + 1 }}>{month.label}</span>)}</div><div className="author-heatmap-grid" role="grid" aria-label={period + "文章发布情况"}>{layout.cells.map((cell, index) => cell ? <span className={"author-heatmap-cell level-" + levelFor(cell.count, maximum)} key={cell.date} role="gridcell" aria-label={cell.date + " 发布 " + cell.count + " 篇文章"} title={cell.date + "：" + cell.count + " 篇文章"} /> : <span className="author-heatmap-cell is-outside" key={"outside-" + index} aria-hidden="true" />)}</div><div className="author-heatmap-legend" aria-label="热力图图例"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i className={"author-heatmap-cell level-" + level} key={level} aria-hidden="true" />)}<span>多</span></div></div></div></section>;
}

function ContactLink({ href, label, Icon }: { href: string | null | undefined; label: string; Icon: typeof Mail }) {
	if (!href || !isSafeNavigationUrl(href)) return null;
	const external = /^https?:\/\//u.test(href);
	return <a href={href} title={label} aria-label={label} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}><Icon size={16} /><span>{label}</span></a>;
}

const skillIcons: Record<string, LucideIcon> = {
	code: Code2, coding: Code2, react: Boxes, typescript: Braces, javascript: Braces,
	node: Server, nodejs: Server, backend: Server, api: Terminal, database: Database,
	git: GitBranch, github: Github, design: Palette, ui: Palette, writing: Pencil,
	book: BookOpen, learning: BookOpen, system: Layers3, architecture: Layers3,
	security: ShieldCheck, devops: Wrench, cloud: Cpu,
};

function SkillIcon({ value }: { value?: string | null }) {
	const icon = value?.trim() ?? "";
	const Icon = skillIcons[icon.toLowerCase()] ?? Code2;
	return <span className="author-skill-icon" aria-label={icon ? "技能图标：" + icon : "技能图标"}><Icon size={17} aria-hidden="true" /></span>;
}

export default function AuthorProfilePage({ site }: { site: SiteData }) {
	const [author, setAuthor] = useState<AuthorProfile>(() => initialAuthor(site));
	const [heatmap, setHeatmap] = useState<AuthorHeatmap | null>(null);
	useEffect(() => { let active = true; setAuthor(initialAuthor(site)); setHeatmap(null); api.authorProfile().then((payload) => { if (active && payload) { setAuthor(payload.author); setHeatmap(payload.heatmap); } }); return () => { active = false; }; }, [site]);
	const avatar = resolveMediaUrl(author.avatar || site.author?.avatar || fallbackSite.author?.avatar || "/images/avatar.avif");
	const links = (author.links ?? []).filter((link) => link.label.trim() && isSafeNavigationUrl(link.url));
	return <section className="card content-card author-profile-page"><header className="author-profile-hero"><img src={avatar} alt={(author.name || "作者") + " 的头像"} width="128" height="128" loading="eager" decoding="async" /><div className="author-profile-intro"><span className="author-eyebrow">AUTHOR PROFILE</span><h1>{author.name || "博主"}</h1>{author.headline ? <p className="author-headline">{author.headline}</p> : null}<p className="author-bio">{author.bio || "这个博主还没有留下个人签名。"}</p><div className="author-meta">{author.location ? <span><MapPin size={15} />{author.location}</span> : null}{author.website && isSafeNavigationUrl(author.website) ? <a href={author.website} target="_blank" rel="noreferrer"><Globe2 size={15} />个人网站</a> : null}</div></div></header><nav className="author-contact-links" aria-label="联系作者"><ContactLink href={author.email ? "mailto:" + author.email : null} label="Email" Icon={Mail} /><ContactLink href={author.githubUrl} label="GitHub" Icon={Github} /><ContactLink href={author.qqUrl} label="QQ" Icon={MessageCircle} /><ContactLink href={author.rssUrl} label="RSS" Icon={Rss} />{links.map((link) => <ContactLink href={link.url} label={link.label} Icon={AtSign} key={link.label + link.url} />)}</nav>{author.introduction ? <section className="author-introduction"><MarkdownContent content={author.introduction} /></section> : null}<div className="author-profile-columns"><section className="author-section"><div className="author-section-heading"><div><span className="author-eyebrow">EXPERTISE</span><h2>技能专长</h2></div></div><div className="author-progress-list">{author.skills?.length ? author.skills.map((skill) => <div className="author-progress-item author-skill-item" key={skill.name}><SkillIcon value={skill.icon} /><div className="author-progress-copy"><div><strong>{skill.name}</strong><b>{Math.round(skill.level)}%</b></div><div className="author-progress-track"><i style={{ width: String(Math.max(0, Math.min(100, skill.level))) + "%" }} /></div>{skill.description ? <small>{skill.description}</small> : null}</div></div>) : <p className="author-empty">博主暂未配置技能专长。</p>}</div></section><section className="author-section"><div className="author-section-heading"><div><span className="author-eyebrow">LEARNING</span><h2>知识学习进度</h2></div></div><div className="author-progress-list">{author.learning?.length ? author.learning.map((item) => <div className="author-progress-item" key={item.name}><div className="author-learning-heading"><strong>{item.name}</strong><span>{item.status || "学习中"}</span><b>{Math.round(item.progress)}%</b></div><div className="author-progress-track learning"><i style={{ width: String(Math.max(0, Math.min(100, item.progress))) + "%" }} /></div>{item.description ? <small>{item.description}</small> : null}</div>) : <p className="author-empty">博主暂未设置学习计划。</p>}</div></section></div><ArticleHeatmap heatmap={heatmap} /></section>;
}
