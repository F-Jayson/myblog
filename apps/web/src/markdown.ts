import { resolveMediaUrl } from "./media";

export type DynamicImageSize = "small" | "medium" | "large";

export type DynamicImage = {
	src: string;
	alt: string;
	width?: number;
	height?: number;
};

const IMAGE_SIZE_COMMENT = /<!--\s*firefly:image-size=(small|medium|large)\s*-->/giu;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?(?:\s+'([^']*)')?(?:\s+=\s*(\d+)(?:x(\d+))?)?\s*\)/gu;
const HTML_IMAGE = /<img\b[^>]*>/giu;

function resetRegex(pattern: RegExp) {
	pattern.lastIndex = 0;
	return pattern;
}

function escapeAttribute(value: string) {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function clampDimension(value: string | number | undefined) {
	const size = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(size) || size < 16) return undefined;
	return Math.min(Math.round(size), 1600);
}

function attributeValue(tag: string, name: string) {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function pushImage(images: DynamicImage[], src: string, alt = "", width?: number, height?: number) {
	const resolved = resolveMediaUrl(src);
	if (!resolved || images.some((image) => image.src === resolved)) return;
	images.push({
		src: resolved,
		alt: alt.trim(),
		width: clampDimension(width),
		height: clampDimension(height),
	});
}

export function parseDynamicImageSize(body: string): DynamicImageSize {
	const match = body.match(/<!--\s*firefly:image-size=(small|medium|large)\s*-->/iu);
	const size = match?.[1]?.toLowerCase();
	return size === "small" || size === "large" ? size : "medium";
}

export function withDynamicImageSize(body: string, size: DynamicImageSize) {
	const stripped = body.replace(resetRegex(IMAGE_SIZE_COMMENT), "").trim();
	if (size === "medium") return stripped;
	return `<!-- firefly:image-size=${size} -->\n${stripped}`;
}

export function stripMarkdownImages(source: string) {
	return source
		.replace(resetRegex(IMAGE_SIZE_COMMENT), "")
		.replace(resetRegex(HTML_IMAGE), "")
		.replace(resetRegex(MARKDOWN_IMAGE), "")
		.replace(/!\[[^\]]*\]\s*\n?\(\s*<?[^)]+>?\s*\)/gu, "")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

export function extractMarkdownImages(source: string): DynamicImage[] {
	const images: DynamicImage[] = [];
	for (const tag of source.match(resetRegex(HTML_IMAGE)) ?? []) {
		const src = attributeValue(tag, "src");
		if (!src) continue;
		pushImage(images, src, attributeValue(tag, "alt"), Number(attributeValue(tag, "width")), Number(attributeValue(tag, "height")));
	}
	for (const match of source.matchAll(resetRegex(MARKDOWN_IMAGE))) {
		pushImage(images, match[2] ?? "", match[1] ?? "", Number(match[5] || ""), Number(match[6] || ""));
	}
	return images;
}

export function collectDynamicImages(body: string, extra: string[] = []): DynamicImage[] {
	const images = extractMarkdownImages(body);
	for (const item of extra) pushImage(images, item);
	return images.slice(0, 9);
}

export function markdownToPlainText(source: string, maxLength = 72) {
	const text = stripMarkdownImages(source)
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
		.replace(/^#{1,6}\s+/gmu, "")
		.replace(/^\s*>+\s?/gmu, "")
		.replace(/^\s*[-*+]\s+/gmu, "")
		.replace(/^\s*\d+\.\s+/gmu, "")
		.replace(/[*_~]+/gu, "")
		.replace(/<[^>]+>/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!text) return "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).replace(/\s+\S*$/u, "").trim() || text.slice(0, maxLength)}…`;
}

export function parseDynamicBody(body: string, extraImages: string[] = []) {
	const size = parseDynamicImageSize(body);
	const images = collectDynamicImages(body, extraImages);
	const content = stripMarkdownImages(body);
	const previewText = markdownToPlainText(body) || (images.length ? "分享了一张图片" : "");
	return { size, content, images, previewText };
}

/** Turn `![](url =240x180)` into HTML so marked and the sanitizer keep width/height. */
export function rewriteMarkdownImageSizes(content: string) {
	return content.replace(resetRegex(MARKDOWN_IMAGE), (full, alt: string, url: string, titleDq?: string, titleSq?: string, width?: string, height?: string) => {
		if (!width) return full;
		const title = titleDq || titleSq;
		const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
		const heightAttr = height ? ` height="${escapeAttribute(height)}"` : "";
		return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}" width="${escapeAttribute(width)}"${heightAttr}${titleAttr}>`;
	});
}
