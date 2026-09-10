USE firefly_blog;

-- Do not seed a reusable administrator password. Run
-- `pnpm --filter @firefly-rebuild/api db:migrate`, then pipe a unique
-- 12+ character password to `tsx src/cli.ts set-admin-password`, or run it
-- interactively in a terminal and follow the hidden prompts.

INSERT INTO authors (id, name, bio, avatar, email, github_url, qq_url, rss_url, links)
VALUES (1, 'Firefly', 'Hello, I\'m Firefly.', '/images/avatar.avif', 'hello@example.com', 'https://github.com/', 'https://wpa.qq.com/', '/rss.xml', JSON_ARRAY())
ON DUPLICATE KEY UPDATE name = VALUES(name), bio = VALUES(bio), avatar = VALUES(avatar), email = VALUES(email), github_url = VALUES(github_url), qq_url = VALUES(qq_url), rss_url = VALUES(rss_url), links = VALUES(links);

INSERT INTO categories (name, slug, description) VALUES
  ('博客指南', 'guide', 'Firefly 的使用指南与布局说明'),
  ('文章示例', 'examples', 'Markdown、代码块和主题功能示例'),
  ('开发笔记', 'dev-note', '前端、后端与工具链记录'),
  ('随笔', 'essay', '生活与灵感的片段')
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description);

INSERT INTO tags (name, slug) VALUES
  ('Astro', 'astro'), ('React', 'react'), ('TypeScript', 'typescript'), ('设计', 'design'), ('随笔', 'essay'),
  ('Markdown', 'markdown'), ('Firefly', 'firefly'), ('博客', 'blog'), ('主题', 'theme'), ('模板', 'template'),
  ('指南', 'guide'), ('布局', 'layout'), ('演示', 'demo'), ('示例', 'example'), ('KaTeX', 'katex'), ('Math', 'math'), ('MDX', 'mdx'), ('Mermaid', 'mermaid'), ('Obsidian', 'obsidian'), ('PlantUML', 'plantuml'), ('Wiki-Link', 'wiki-link'), ('密码保护', 'password-protected'), ('视频', 'video')
ON DUPLICATE KEY UPDATE name = VALUES(name), slug = VALUES(slug);

-- Remove records from the initial scaffold so the demo archive matches the source site.
DELETE FROM posts WHERE slug IN ('firefly-layout-system', 'react-and-express', 'a-small-archive');
DELETE FROM categories WHERE slug IN ('dev-note', 'essay');

-- The first four records mirror the source Firefly content collection.
INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'firefly', 'Firefly 一款清新美观的 Astro 博客主题模板',
  'Firefly 是一款基于 Astro 框架和 Fuwari 模板开发的清新美观且现代化个人博客主题模板，专为技术爱好者和内容创作者设计。',
  '## 项目概述\n\nFirefly 是一款基于 Astro 和 Fuwari 的清新美观博客主题模板，提供现代 Web 技术栈、响应式布局和高度可定制的界面。\n\n**在线预览：** [Firefly Demo](https://firefly.cuteleaf.cn/)\n\n## 技术架构\n\n- 基于 Astro 的静态站点生成\n- 完整的 TypeScript 支持\n- 使用 Tailwind CSS 的响应式设计\n- Astro 与 Svelte 组件化开发\n\n## 配置说明\n\n详细配置可以参考 Firefly 使用文档。',
  '/images/posts/firefly2.avif', id, 'published', TRUE, 128, 640, 4, '1970-01-02 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'guide/index', 'Firefly 简单使用指南', '如何使用 Firefly 博客模板。',
  '## 开始使用\n\n这个博客模板基于 [Astro](https://astro.build/) 构建。文章内容放在 `src/content/posts/` 目录中，保存为 Markdown 文件即可。\n\n## 文章 Front-matter\n\n```yaml\n---\ntitle: 我的第一篇博客文章\npublished: 2023-09-09\ndescription: 这是我新 Astro 博客的第一篇文章。\ntags: [前端, 开发]\ncategory: 前端开发\n---\n```\n\n## 自定义文章 URL\n\n可以通过 `slug` 字段为文章设置简洁、稳定的地址。更多配置请参考 Astro 文档。',
  '/images/posts/guide-cover.avif', id, 'published', TRUE, 96, 430, 3, '1970-01-02 00:00:00'
FROM categories WHERE slug = 'guide'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'guide/firefly-layout-system', 'Firefly 布局系统详解',
  '深入了解 Firefly 的布局系统，包括侧边栏布局、文章列表布局和自适应网格。',
  '## 概述\n\nFirefly 提供灵活的布局系统，可以根据内容需求自定义侧边栏和文章列表。\n\n## 侧边栏布局\n\n博客支持左侧、右侧和双侧边栏。双侧边栏适合宽屏显示器，单侧边栏则为文章保留更多阅读空间。\n\n## 文章列表布局\n\n列表模式展示封面、摘要和标签；网格模式根据容器宽度自适应列数，还可以开启瀑布流。\n\n## 响应式行为\n\n屏幕变窄时网格列数会减少，双侧边栏会收起，页面自然变为单栏布局。',
  '/images/posts/firefly1.avif', id, 'published', FALSE, 91, 900, 5, '1970-01-03 00:00:00'
FROM categories WHERE slug = 'guide'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'code-examples', 'Firefly 代码块示例', '在 Firefly 中使用表达性代码块的 Markdown 示例。',
  '## 表达性代码\n\nFirefly 支持在 Markdown 中展示带语法高亮的代码块。\n\n### 语法高亮\n\n```js\nconsole.log("此代码有语法高亮!");\n```\n\n### 文件框架\n\n```js title="example.js"\nexport function greet(name) {\n  return `Hello, ${name}`;\n}\n```\n\n### 行标记与自动换行\n\n代码块还可以标记行、显示行号，并按需要启用自动换行。',
  '/images/posts/firefly3.avif', id, 'published', FALSE, 64, 780, 4, '1970-01-03 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

-- Additional demo records keep the separated app useful before importing a full archive.
INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'react-and-express', '用 React 与 Express 重建博客', '将静态博客拆分为可独立部署的前端与后端服务。',
  '## 前后端分离\n\nReact 负责页面交互和视觉呈现，Express 提供文章、分类、标签和评论 API。MySQL 负责长期保存内容。\n\n```ts\nconst response = await fetch("/api/posts");\nconst data = await response.json();\n```\n\n这种结构让内容管理、部署和扩展都更直接。',
  '/images/posts/both-grid.avif', id, 'published', FALSE, 76, 118, 2, '2026-07-12 09:30:00'
FROM categories WHERE slug = 'dev-note'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'a-small-archive', '给未来的自己留一份小档案', '把最近读过、写过和正在思考的事情整理下来。',
  '## 小档案\n\n博客不只是文章列表，也可以是一个持续更新的个人索引。\n\n最近在做的事情：\n\n1. 整理旧文章\n2. 学习更好的排版\n3. 给每一段代码写下原因',
  '/images/posts/masonry.avif', id, 'published', FALSE, 41, 74, 1, '2026-07-08 18:20:00'
FROM categories WHERE slug = 'essay'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'markdown-extended', 'Markdown 扩展功能', '了解 Firefly 中的 Markdown 功能。',
  '## Markdown 功能\n\n文章页支持代码块、引用、表格和链接，并保持与列表页一致的色彩语言。\n\n### 提醒框\n\n可以使用 GitHub、Obsidian、VitePress 和 Docusaurus 风格的提示块。\n\n### 图片画廊\n\n`[grid]` 标签可以把多张图片排列成响应式画廊。',
  NULL, id, 'published', FALSE, 52, 374, 2, '1970-01-01 07:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), cover = VALUES(cover), category_id = VALUES(category_id), status = VALUES(status), pinned = VALUES(pinned), views = VALUES(views), words = VALUES(words), minutes = VALUES(minutes), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'guide/firefly-wiki-link', 'Firefly Wiki Link 内部链接示例', '在 Firefly 文章中使用 Obsidian 风格的 Wiki Link 内部链接，并自动生成文章链接卡片。',
  '## 文章链接卡片\n\nFirefly 支持在 Markdown、MDX 文章中使用 Obsidian 风格的 Wiki Link 内部链接。',
  NULL, id, 'published', FALSE, 38, 420, 3, '1970-01-03 00:00:00'
FROM categories WHERE slug = 'guide'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'encrypted-demo', 'Firefly 文章加密', '这是一篇密码保护的示例文章，用于演示文章加密功能。',
  '## 成功解锁了这篇文章！\n\n这是密码保护文章的示例内容。',
  NULL, id, 'published', FALSE, 31, 160, 1, '1970-01-02 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'katex-math-example', 'KaTeX 数学公式示例', '展示 Firefly 主题对 KaTeX 数学公式的支持，包括行内公式、块级公式和复杂数学符号。',
  '## 行内公式\n\n本文展示 Firefly 主题对数学公式的渲染支持。',
  NULL, id, 'published', FALSE, 27, 260, 2, '1970-01-02 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'mdx-example', 'MDX 格式文章示例', '这是一个 MDX 格式的示例文章，展示了如何在 Markdown 中使用 JSX。',
  '## MDX\n\nFirefly 支持 Markdown 和 MDX 两种文章格式。',
  NULL, id, 'published', FALSE, 24, 230, 2, '1970-01-02 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'markdown-mermaid', 'Markdown Mermaid 图表', '一个包含 Mermaid 的 Markdown 博客文章简单示例。',
  '## Markdown 中 Mermaid 图表完整指南\n\n本文演示如何在 Markdown 文档中使用 Mermaid。',
  NULL, id, 'published', FALSE, 20, 280, 2, '1970-01-01 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'markdown-plantuml', 'Markdown PlantUML 图表', '用于验证 Firefly 中 PlantUML 插件渲染、主题切换与交互能力的示例文章。',
  '## Markdown 中 PlantUML 图表指南\n\nPlantUML 使用纯文本描述工程图表。',
  NULL, id, 'published', FALSE, 18, 250, 2, '1970-01-01 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'markdown-tutorial', 'Markdown 教程', '一个简明的 Markdown 博客示例。',
  '## Markdown\n\n这是一篇 Markdown 基础教程示例。',
  NULL, id, 'published', FALSE, 16, 220, 2, '1970-01-01 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

INSERT INTO posts (slug, title, excerpt, content, cover, category_id, status, pinned, views, words, minutes, published_at)
SELECT 'video', '在文章中嵌入视频', '这篇文章演示如何在博客文章中嵌入视频。',
  '## 视频\n\n只需从 YouTube 或其他平台复制嵌入代码即可。',
  NULL, id, 'published', FALSE, 14, 120, 1, '1970-01-01 00:00:00'
FROM categories WHERE slug = 'examples'
ON DUPLICATE KEY UPDATE title = VALUES(title), excerpt = VALUES(excerpt), content = VALUES(content), category_id = VALUES(category_id), status = VALUES(status), published_at = VALUES(published_at);

DELETE FROM post_tags
WHERE post_id IN (SELECT id FROM posts WHERE slug IN ('firefly', 'guide/index', 'guide/firefly-layout-system', 'code-examples', 'react-and-express', 'a-small-archive', 'markdown-extended'));

INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('markdown', 'firefly', 'blog', 'theme', 'template') WHERE p.slug = 'firefly';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('firefly', 'blog', 'markdown', 'guide') WHERE p.slug = 'guide/index';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('firefly', 'layout', 'blog', 'guide', 'astro') WHERE p.slug = 'guide/firefly-layout-system';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('markdown', 'firefly') WHERE p.slug = 'code-examples';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('react', 'typescript') WHERE p.slug = 'react-and-express';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('essay', 'design') WHERE p.slug = 'a-small-archive';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('demo', 'example', 'markdown', 'firefly') WHERE p.slug = 'markdown-extended';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('markdown', 'obsidian', 'wiki-link', 'example') WHERE p.slug = 'guide/firefly-wiki-link';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('example', 'password-protected') WHERE p.slug = 'encrypted-demo';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('katex', 'math', 'example') WHERE p.slug = 'katex-math-example';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('mdx', 'markdown', 'example') WHERE p.slug = 'mdx-example';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('markdown', 'mermaid', 'blog', 'firefly') WHERE p.slug = 'markdown-mermaid';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('plantuml', 'firefly', 'markdown') WHERE p.slug = 'markdown-plantuml';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('markdown', 'example') WHERE p.slug = 'markdown-tutorial';
INSERT IGNORE INTO post_tags (post_id, tag_id)
SELECT p.id, t.id FROM posts p JOIN tags t ON t.slug IN ('example', 'video', 'firefly') WHERE p.slug = 'video';

DELETE FROM dynamics;
INSERT INTO dynamics (body, images, published_at) VALUES
  ('又是美好的一天！', JSON_ARRAY(), '2026-07-15 02:11:27'),
  ('飞萤之火自无梦的长夜亮起，绽放在终竟的明天。', JSON_ARRAY(), '2026-07-15 16:15:29'),
  ('这是一条测试动态！', JSON_ARRAY('/images/posts/firefly1.avif'), '2026-07-15 02:06:13'),
  ('今天天气真不错，流萤真可爱。', JSON_ARRAY(), '2026-07-15 01:07:56');

INSERT INTO site_settings (setting_key, setting_value) VALUES
  ('site', JSON_OBJECT(
    'title', 'Firefly',
    'subtitle', 'Demo site',
    'description', 'A calm personal blog built with React, Express and MySQL.',
    'hue', 165,
    'cover', JSON_OBJECT('mode', 'url', 'value', '/images/DesktopWallpaper/d2.avif', 'position', 'center 35%'),
    'titleConfig', JSON_OBJECT('title', 'Firefly', 'subtitle', 'Demo site', 'subtitleMode', 'text', 'hitokotoApi', 'https://v1.hitokoto.cn/?encode=json', 'titleFontUrl', '', 'subtitleFontUrl', '', 'bodyFontUrl', '', 'postTitleFontUrl', '', 'postContentFontUrl', '', 'tagFontUrl', ''),
    'music', JSON_OBJECT('enabled', true, 'src', '/assets/music/使一颗心免于哀伤-哼唱.mp3', 'title', '使一颗心免于哀伤', 'artist', '知更鸟 / HOYO-MiX / Chevy', 'cover', '/assets/music/cover/109951169585655912.webp', 'autoplay', false, 'loop', false)
  )),
  ('announcement', JSON_OBJECT('content', '欢迎来到我的博客！这是一则示例公告。', 'historyId', NULL)),
  ('navigation', JSON_ARRAY('home', 'tags', 'archive', 'categories', 'more'))
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

-- Standalone Markdown pages and transfer links. Keep existing editorial
-- changes when the seed is run again.
INSERT INTO managed_pages (page_key, title, content, friend_links_intro, friend_links) VALUES
  ('about', '关于', '# 关于\n\n这里是站点的关于页面。\n\nFirefly 是一个以 Markdown 为核心的个人博客空间，记录技术、设计和日常思考。', '', JSON_ARRAY()),
  ('transfer', '传送', '# 传送\n\n这里收集常用入口与值得访问的站点。', '欢迎交换友情链接，也欢迎通过问题反馈告诉我你的站点。', JSON_ARRAY(
    JSON_OBJECT('name', 'Firefly 主页', 'url', 'https://firefly.cuteleaf.cn/', 'logo', '/images/avatar.avif', 'description', '博客主题与项目主页'),
    JSON_OBJECT('name', 'GitHub', 'url', 'https://github.com/', 'logo', '', 'description', '开源项目与代码仓库')
  )),
  ('issues', '问题总结', '# 问题总结\n\n## 常见问题\n\n### 页面没有更新\n\n请刷新浏览器缓存，或稍后再次访问。\n\n### 如何反馈问题\n\n可以从“更多”菜单进入问题反馈页面，提交页面地址、复现步骤和联系方式。', '', JSON_ARRAY())
ON DUPLICATE KEY UPDATE page_key = VALUES(page_key);

INSERT INTO changelogs (slug, title, version, release_date, published, content) VALUES
  ('navigation-content-center-v1', '导航与内容中心升级', 'v1.0.0', '2026-08-22 00:00:00', TRUE, '## 本次更新\n\n- 导航栏整理为主页、标签、归档、分类和更多。\n- 新增关于、传送、问题总结、问题反馈和更新日志页面。\n- 独立页面、动态和更新日志正文支持 Markdown。\n- 传送页支持后台维护友情链接、标志和描述。')
ON DUPLICATE KEY UPDATE slug = VALUES(slug);

INSERT INTO site_settings (setting_key, setting_value) VALUES
  ('feedback', JSON_OBJECT('enabled', TRUE, 'maxFiles', 2, 'maxFileSizeMb', 20))
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);
