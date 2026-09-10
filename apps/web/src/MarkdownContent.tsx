import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import { useMemo } from "react";
import { resolveMediaUrl } from "./media";

type MarkdownContentProps = {
	content: string;
};

export default function MarkdownContent({ content }: MarkdownContentProps) {
	const html = useMemo(() => {
		let headingIndex = 0;
		const renderer = new Renderer();
		renderer.heading = function ({ tokens, depth }) {
			const inline = this.parser.parseInline(tokens);
			const id = `toc-${headingIndex++}`;
			return `<h${depth} id="${id}">${inline}</h${depth}>`;
		};
		const rendered = marked.parse(content, {
			async: false,
			renderer,
		});
		const sanitized = DOMPurify.sanitize(String(rendered));
		const container = document.createElement("div");
		container.innerHTML = sanitized;
		container.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
			const source = resolveMediaUrl(image.getAttribute("src"));
			if (source) image.setAttribute("src", source);
		});
		return container.innerHTML;
	}, [content]);
	return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
