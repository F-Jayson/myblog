import type { Paginated, Post, PostSummary, SiteData } from "./types";

const tags = [
	{ id: 6, name: "Markdown", slug: "markdown", postCount: 9 },
	{ id: 7, name: "Firefly", slug: "firefly", postCount: 8 },
	{ id: 14, name: "示例", slug: "example", postCount: 7 },
	{ id: 8, name: "博客", slug: "blog", postCount: 4 },
	{ id: 11, name: "指南", slug: "guide", postCount: 2 },
	{ id: 1, name: "Astro", slug: "astro", postCount: 1 },
	{ id: 15, name: "KaTeX", slug: "katex", postCount: 1 },
	{ id: 16, name: "Math", slug: "math", postCount: 1 },
	{ id: 17, name: "MDX", slug: "mdx", postCount: 1 },
	{ id: 18, name: "Mermaid", slug: "mermaid", postCount: 1 },
	{ id: 19, name: "Obsidian", slug: "obsidian", postCount: 1 },
	{ id: 20, name: "PlantUML", slug: "plantuml", postCount: 1 },
	{ id: 21, name: "Wiki-Link", slug: "wiki-link", postCount: 1 },
	{ id: 9, name: "主题", slug: "theme", postCount: 1 },
	{ id: 22, name: "密码保护", slug: "password-protected", postCount: 1 },
	{ id: 12, name: "布局", slug: "layout", postCount: 1 },
	{ id: 10, name: "模板", slug: "template", postCount: 1 },
	{ id: 13, name: "演示", slug: "demo", postCount: 1 },
	{ id: 23, name: "视频", slug: "video", postCount: 1 },
];

const categories = [
	{ id: 4, name: "文章示例", slug: "examples", description: "Markdown、代码块和主题功能示例", postCount: 10 },
	{ id: 1, name: "博客指南", slug: "guide", description: "Firefly 的使用指南与布局说明", postCount: 3 },
];

const tag = (slug: string) => {
	const match = tags.find((item) => item.slug === slug);
	if (!match) throw new Error(`Unknown fallback tag: ${slug}`);
	return match;
};

const category = (slug: string) => {
	const match = categories.find((item) => item.slug === slug);
	if (!match) throw new Error(`Unknown fallback category: ${slug}`);
	return match;
};

const summaries: PostSummary[] = [
	{
		id: 4,
		slug: "firefly",
		title: "Firefly 一款清新美观的 Astro 博客主题模板",
		excerpt: "Firefly 是一款基于 Astro 框架和 Fuwari 模板开发的清新美观且现代化个人博客主题模板，专为技术爱好者和内容创作者设计。",
		cover: "/images/posts/firefly2.avif",
		category: category("examples"),
		tags: [tag("markdown"), tag("firefly"), tag("blog"), tag("theme"), tag("template")],
		pinned: true,
		views: 128,
		words: 640,
		minutes: 4,
		publishedAt: "1970-01-02 00:00:00",
		updatedAt: "1970-01-02 00:00:00",
	},
	{
		id: 5,
		slug: "guide/index",
		title: "Firefly 简单使用指南",
		excerpt: "如何使用 Firefly 博客模板。",
		cover: "/images/posts/guide-cover.avif",
		category: category("guide"),
		tags: [tag("markdown"), tag("firefly"), tag("blog"), tag("guide")],
		pinned: true,
		views: 96,
		words: 430,
		minutes: 3,
		publishedAt: "1970-01-02 00:00:00",
		updatedAt: "1970-01-02 00:00:00",
	},
	{
		id: 7,
		slug: "code-examples",
		title: "Firefly 代码块示例",
		excerpt: "在 Firefly 中使用表达性代码块的 Markdown 示例。",
		cover: "/images/posts/firefly3.avif",
		category: category("examples"),
		tags: [tag("markdown"), tag("firefly")],
		pinned: false,
		views: 64,
		words: 780,
		minutes: 4,
		publishedAt: "1970-01-03 00:00:00",
		updatedAt: "1970-01-03 00:00:00",
	},
	{
		id: 6,
		slug: "guide/firefly-layout-system",
		title: "Firefly 布局系统详解",
		excerpt: "深入了解 Firefly 的布局系统，包括侧边栏布局（左侧/双侧）和文章列表布局（列表/网格），以及自适应网格列数。",
		cover: "/images/posts/firefly1.avif",
		category: category("guide"),
		tags: [tag("astro"), tag("firefly"), tag("blog"), tag("guide"), tag("layout")],
		pinned: false,
		views: 91,
		words: 900,
		minutes: 5,
		publishedAt: "1970-01-03 00:00:00",
		updatedAt: "1970-01-03 00:00:00",
	},
	{
		id: 11,
		slug: "guide/firefly-wiki-link",
		title: "Firefly Wiki Link 内部链接示例",
		excerpt: "在 Firefly 文章中使用 Obsidian 风格的 Wiki Link 内部链接，并自动生成文章链接卡片。",
		cover: null,
		category: category("guide"),
		tags: [tag("markdown"), tag("example"), tag("obsidian"), tag("wiki-link")],
		pinned: false,
		views: 38,
		words: 420,
		minutes: 3,
		publishedAt: "1970-01-03 00:00:00",
		updatedAt: "1970-01-03 00:00:00",
	},
	{
		id: 12,
		slug: "encrypted-demo",
		title: "Firefly 文章加密",
		excerpt: "这是一篇密码保护的示例文章，用于演示文章加密功能。",
		cover: null,
		category: category("examples"),
		tags: [tag("example"), tag("password-protected")],
		pinned: false,
		views: 31,
		words: 160,
		minutes: 1,
		publishedAt: "1970-01-02 00:00:00",
		updatedAt: "1970-01-02 00:00:00",
	},
	{
		id: 13,
		slug: "katex-math-example",
		title: "KaTeX 数学公式示例",
		excerpt: "展示 Firefly 主题对 KaTeX 数学公式的支持，包括行内公式、块级公式和复杂数学符号。",
		cover: null,
		category: category("examples"),
		tags: [tag("example"), tag("katex"), tag("math")],
		pinned: false,
		views: 27,
		words: 260,
		minutes: 2,
		publishedAt: "1970-01-02 00:00:00",
		updatedAt: "1970-01-02 00:00:00",
	},
	{
		id: 14,
		slug: "mdx-example",
		title: "MDX 格式文章示例",
		excerpt: "这是一个 MDX 格式的示例文章，展示了如何在 Markdown 中使用 JSX。",
		cover: null,
		category: category("examples"),
		tags: [tag("markdown"), tag("example"), tag("mdx")],
		pinned: false,
		views: 24,
		words: 230,
		minutes: 2,
		publishedAt: "1970-01-02 00:00:00",
		updatedAt: "1970-01-02 00:00:00",
	},
	{
		id: 10,
		slug: "markdown-extended",
		title: "Markdown 扩展功能",
		excerpt: "了解 Firefly 中的 Markdown 功能。",
		cover: null,
		category: category("examples"),
		tags: [tag("markdown"), tag("firefly"), tag("demo"), tag("example")],
		pinned: false,
		views: 52,
		words: 374,
		minutes: 2,
		publishedAt: "1970-01-01 07:00:00",
		updatedAt: "1970-01-01 07:00:00",
	},
	{
		id: 15,
		slug: "markdown-mermaid",
		title: "Markdown Mermaid 图表",
		excerpt: "一个包含 Mermaid 的 Markdown 博客文章简单示例。",
		cover: null,
		category: category("examples"),
		tags: [tag("markdown"), tag("firefly"), tag("blog"), tag("mermaid")],
		pinned: false,
		views: 20,
		words: 280,
		minutes: 2,
		publishedAt: "1970-01-01 00:00:00",
		updatedAt: "1970-01-01 00:00:00",
	},
	{
		id: 16,
		slug: "markdown-plantuml",
		title: "Markdown PlantUML 图表",
		excerpt: "用于验证 Firefly 中 PlantUML 插件渲染、主题切换与交互能力的示例文章。",
		cover: null,
		category: category("examples"),
		tags: [tag("markdown"), tag("firefly"), tag("plantuml")],
		pinned: false,
		views: 18,
		words: 250,
		minutes: 2,
		publishedAt: "1970-01-01 00:00:00",
		updatedAt: "1970-01-01 00:00:00",
	},
	{
		id: 17,
		slug: "markdown-tutorial",
		title: "Markdown 教程",
		excerpt: "一个简明的 Markdown 博客示例。",
		cover: null,
		category: category("examples"),
		tags: [tag("markdown"), tag("example")],
		pinned: false,
		views: 16,
		words: 220,
		minutes: 2,
		publishedAt: "1970-01-01 00:00:00",
		updatedAt: "1970-01-01 00:00:00",
	},
	{
		id: 18,
		slug: "video",
		title: "在文章中嵌入视频",
		excerpt: "这篇文章演示如何在博客文章中嵌入视频。",
		cover: null,
		category: category("examples"),
		tags: [tag("firefly"), tag("example"), tag("video")],
		pinned: false,
		views: 14,
		words: 120,
		minutes: 1,
		publishedAt: "1970-01-01 00:00:00",
		updatedAt: "1970-01-01 00:00:00",
	},
];

const contentBySlug: Record<string, string> = {
	firefly: `## 项目概述

Firefly 是一款基于 Astro 和 Fuwari 的清新美观博客主题模板，提供现代 Web 技术栈、响应式布局和高度可定制的界面。

**在线预览：** [Firefly Demo](https://firefly.cuteleaf.cn/)

## 技术架构

- 基于 Astro 的静态站点生成
- 完整的 TypeScript 支持
- 使用 Tailwind CSS 的响应式设计
- Astro 与 Svelte 组件化开发

## 配置说明

详细配置可以参考 Firefly 使用文档。`,
	"guide/index": `## 开始使用

这个博客模板基于 [Astro](https://astro.build/) 构建。文章内容放在 \`src/content/posts/\` 目录中，保存为 Markdown 文件即可。

## 文章 Front-matter

\`\`\`yaml
---
title: 我的第一篇博客文章
published: 2023-09-09
description: 这是我新 Astro 博客的第一篇文章。
tags: [前端, 开发]
category: 前端开发
---
\`\`\`

## 自定义文章 URL

可以通过 \`slug\` 字段为文章设置简洁、稳定的地址。更多配置请参考 Astro 文档。`,
	"guide/firefly-layout-system": `## 概述

Firefly 提供灵活的布局系统，可以根据内容需求自定义侧边栏和文章列表。

## 侧边栏布局

博客支持左侧、右侧和双侧边栏。双侧边栏适合宽屏显示器，单侧边栏则为文章保留更多阅读空间。

## 文章列表布局

列表模式展示封面、摘要和标签；网格模式根据容器宽度自适应列数，还可以开启瀑布流。

## 响应式行为

屏幕变窄时网格列数会减少，双侧边栏会收起，页面自然变为单栏布局。`,
	"guide/firefly-wiki-link": `## 文章链接卡片

Firefly 支持在 Markdown、MDX 文章中使用 Obsidian 风格的 Wiki Link 内部链接。

\`[[slug]]\` 单独成段时，会读取目标文章信息并渲染为文章链接卡片；出现在正文中间时，则渲染为普通链接。`,
	"code-examples": `## 表达性代码

Firefly 支持在 Markdown 中展示带语法高亮的代码块。

### 语法高亮

\`\`\`js
console.log("此代码有语法高亮!");
\`\`\`

### 文件框架

\`\`\`js title="example.js"
export function greet(name) {
  return \`Hello, \${name}\`;
}
\`\`\`

### 行标记与自动换行

代码块还可以标记行、显示行号，并按需要启用自动换行。`,
	"encrypted-demo": `## 成功解锁了这篇文章！

这是密码保护文章的示例内容。文章内容在构建时加密，访客输入正确密码后才能查看。`,
	"katex-math-example": `## 行内公式

本文展示 Firefly 主题对数学公式的渲染支持。

欧拉公式 $e^{i\\pi} + 1 = 0$ 是数学中最优美的公式之一。

## 块级公式

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$`,
	"mdx-example": `## MDX

Firefly 支持 Markdown 和 MDX 两种类型的文章，可以在 Markdown 文档中混合使用 JSX 组件。

| 特性 | Markdown | MDX |
| :--- | :--- | :--- |
| 基础语法 | 支持 | 支持 |
| 组件导入 | 不支持 | 支持 |
| 动态数据 | 不支持 | 支持 |`,
	"markdown-extended": `## Markdown 功能

文章页支持代码块、引用、表格和链接，并保持与列表页一致的色彩语言。

### 提醒框

可以使用 GitHub、Obsidian、VitePress 和 Docusaurus 风格的提示块。

### 图片画廊

\`[grid]\` 标签可以把多张图片排列成响应式画廊。`,
	"markdown-mermaid": `## Markdown 中 Mermaid 图表完整指南

本文演示如何在 Markdown 文档中使用 Mermaid 创建流程图、时序图和 ER 图。

\`\`\`mermaid
graph TD
    A[开始] --> B{条件检查}
    B -->|是| C[处理步骤]
    B -->|否| D[处理步骤]
\`\`\``,
	"markdown-plantuml": `## Markdown 中 PlantUML 图表指南

PlantUML 使用纯文本描述工程图表，并能与 Markdown 无缝结合。

\`\`\`plantuml
@startuml
Alice -> Bob: Hello
Bob --> Alice: Hi
@enduml
\`\`\``,
	"markdown-tutorial": `## Markdown

这是一篇 Markdown 基础教程示例，涵盖标题、列表、引用、代码块、表格、链接和图片等常用语法。`,
	video: `只需从 YouTube 或其他平台复制嵌入代码，然后将其粘贴到 Markdown 文件中。

## YouTube

文章可以通过 iframe 嵌入 YouTube 或其他平台的视频。`,
};

export const fallbackPosts: Post[] = summaries.map((post) => ({
	...post,
	content: contentBySlug[post.slug] ?? "",
}));

export const fallbackSite: SiteData = {
	title: "Firefly",
	subtitle: "Demo site",
	description: "A calm personal blog built with React, Express and MySQL.",
	siteFavicon: "",
	cover: {
		mode: "upload",
		value: "/images/DesktopWallpaper/d2.avif",
		position: "center 35%",
	},
	titleConfig: {
		title: "Lovely firefly!",
		subtitle: "In Finalized Morrow, I Full Bloom",
		subtitleMode: "text",
		hitokotoApi: "https://v1.hitokoto.cn/?encode=json",
	},
	music: {
		enabled: true,
		src: "/assets/music/使一颗心免于哀伤-哼唱.mp3",
		title: "使一颗心免于哀伤",
		artist: "知更鸟 / HOYO-MiX / Chevy",
		cover: "/assets/music/cover/109951169585655912.webp",
		autoplay: false,
		loop: false,
	},
	author: {
		name: "Firefly",
		bio: "Hello, I'm Firefly.",
		avatar: "/images/avatar.avif",
		email: "hello@example.com",
		githubUrl: "https://github.com/",
		qqUrl: "https://wpa.qq.com/",
		rssUrl: "/rss.xml",
		links: [{ label: "Firefly 文档", url: "https://docs-firefly.cuteleaf.cn", icon: "book" }],
	},
	// Fallback posts are demonstration content with placeholder timestamps, so do
	// not present their dates as a real deployment's activity history.
	stats: { posts: 13, views: 619, totalWords: summaries.reduce((total, post) => total + post.words, 0), startDate: null, lastActivityAt: null },
	categories,
	tags,
	dynamics: [
		{ id: 6, body: "飞萤之火自无梦的长夜亮起，绽放在终竟的明天。", images: ["/images/posts/firefly2.avif", "/images/posts/firefly3.avif"], publishedAt: "2026-07-15 16:15:29" },
		{ id: 5, body: "又是美好的一天！", publishedAt: "2026-07-15 02:11:27" },
		{ id: 7, body: "这是一条测试动态！", publishedAt: "2026-07-15 02:06:13" },
		{ id: 8, body: "今天天气真不错，流萤真可爱。", publishedAt: "2026-07-15 01:07:56" },
	],
	hue: 165,
};

export function fallbackPage(page = 1, pageSize = 10): Paginated<PostSummary> {
	const items = summaries.slice((page - 1) * pageSize, page * pageSize);
	return { items, page, pageSize, total: summaries.length, totalPages: Math.max(1, Math.ceil(summaries.length / pageSize)) };
}

export function fallbackPostsFor(params: { page?: number; pageSize?: number; category?: string; tag?: string; q?: string } = {}): Paginated<PostSummary> {
	const page = params.page ?? 1;
	const pageSize = params.pageSize ?? 10;
	let items = fallbackPosts;
	if (params.category) items = items.filter((post) => post.category?.slug === params.category || post.category?.name === params.category);
	if (params.tag) items = items.filter((post) => post.tags.some((tag) => tag.slug === params.tag || tag.name === params.tag));
	if (params.q) {
		const needle = params.q.toLocaleLowerCase();
		items = items.filter((post) => `${post.title} ${post.excerpt} ${post.content}`.toLocaleLowerCase().includes(needle));
	}
	const total = items.length;
	return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
