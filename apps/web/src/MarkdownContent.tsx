import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { useMemo } from "react";
import { rewriteMarkdownImageSizes } from "./markdown";
import { resolveMediaUrl } from "./media";

type MarkdownContentProps = {
	content: string;
};

// 正文只在 h2–h4 上挂锚点；侧边栏目录（App.tsx 的 extractToc）必须用同一套规则，
// 否则文章里出现 h1/h5/h6 之后编号会整体错位，点目录会跳到别的标题
export function isTocDepth(depth: number) {
	return depth >= 2 && depth <= 4;
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
	const html = useMemo(() => {
		// [394] marked/DOMPurify 对畸形输入可能抛错：整个渲染包进 try/catch，降级而不是整页白屏
		try {
		let headingIndex = 0;
		const renderer = new Renderer();
		renderer.heading = function ({ tokens, depth }) {
			const inline = this.parser.parseInline(tokens);
			if (!isTocDepth(depth)) return `<h${depth}>${inline}</h${depth}>`;
			const id = `toc-${headingIndex++}`;
			return `<h${depth} id="${id}">${inline}</h${depth}>`;
		};
		const rendered = marked.parse(rewriteMarkdownImageSizes(content), {
			async: false,
			renderer,
		});
		const sanitized = DOMPurify.sanitize(String(rendered));
		// [395] 安全不变量：resolveMediaUrl 只放行 http(s):// 与 "/" 开头的同源路径，
		// 永远不会返回 javascript:/data:/协议相对地址，因此“先净化后改写 src”不会重新引入 XSS；
		// 若日后放宽 resolveMediaUrl 的白名单，必须先把改写挪回 DOMPurify 钩子内。
		return sanitized.replace(/<img\b[^>]*\bsrc="([^"]*)"/giu, (match, src: string) => {
			const resolved = resolveMediaUrl(src);
			// [395] 解析失败（如 images/a.png 相对路径）时保留原值，避免静默改坏相对引用
			return resolved ? match.replace(src, resolved) : match;
		});
	} catch (error) {
		// [394] marked/DOMPurify 对畸形输入可能抛错：降级为转义后的纯文本而不是整页白屏
		console.error("Markdown 渲染失败", error);
		const fallback = String(content)
			.replace(/&/gu, "&amp;")
			.replace(/</gu, "&lt;")
			.replace(/>/gu, "&gt;");
		return `<p>${fallback.replace(/\n/gu, "<br />")}</p>`;
	}
	}, [content]);
	return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
