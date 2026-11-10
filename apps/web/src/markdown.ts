import { resolveMediaUrl } from "./media";

export type DynamicImageSize = "small" | "medium" | "large";

export type DynamicImage = {
	src: string;
	alt: string;
	width?: number;
	height?: number;
};

const IMAGE_SIZE_COMMENT = /<!--\s*image-size=(small|medium|large)\s*-->/giu;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?(?:\s+'([^']*)')?(?:\s+=\s*(\d+)(?:x(\d+))?)?\s*\)/gu;
const HTML_IMAGE = /<img\b[^>]*>/giu;

// [233] 动态图片的业务阈值集中定义，避免散落多处
const MAX_DYNAMIC_IMAGES = 9;
const MIN_IMAGE_DIMENSION = 16;
const MAX_IMAGE_DIMENSION = 1600;
// 代码块与行内代码里的 ![](…) 是示例文本，不能当成真实图片：按 code 片段切分后只处理普通文本
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu;

function transformOutsideCode(source: string, transform: (chunk: string) => string) {
	return source
		.split(CODE_SEGMENT)
		.map((chunk, index) => (index % 2 === 1 ? chunk : transform(chunk)))
		.join("");
}
function resetRegex(pattern: RegExp) {
	pattern.lastIndex = 0;
	return pattern;
}

function escapeAttribute(value: string) {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function clampDimension(value: string | number | undefined) {
	const size = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(size) || size < MIN_IMAGE_DIMENSION) return undefined;
	return Math.min(Math.round(size), MAX_IMAGE_DIMENSION);
}

// [235] 属性名是有限的字面量集合：按 name 预编译缓存，避免把外部字符串直接拼进正则
const ATTRIBUTE_PATTERNS = new Map<string, RegExp>();

function attributeValue(tag: string, name: string) {
	let pattern = ATTRIBUTE_PATTERNS.get(name);
	if (!pattern) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		pattern = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
		ATTRIBUTE_PATTERNS.set(name, pattern);
	}
	const match = tag.match(pattern);
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
	const match = resetRegex(IMAGE_SIZE_COMMENT).exec(body); // [237] 复用顶部常量，避免规则漂移
	const size = match?.[1]?.toLowerCase();
	return size === "small" || size === "large" ? size : "medium";
}

export function withDynamicImageSize(body: string, size: DynamicImageSize) {
	const stripped = body.replace(resetRegex(IMAGE_SIZE_COMMENT), "").trim();
	if (size === "medium") return stripped;
	return `<!-- image-size=${size} -->\n${stripped}`;
}

export function stripMarkdownImages(source: string) {
	return transformOutsideCode(source, (chunk) =>
		chunk
			.replace(resetRegex(IMAGE_SIZE_COMMENT), "")
			.replace(resetRegex(HTML_IMAGE), "")
			.replace(resetRegex(MARKDOWN_IMAGE), "")
			// [232] 兜底删除也复用 MARKDOWN_IMAGE 同一语义，避免 `![alt] (url)` 被删掉却不进图片列表
			.replace(/!\[[^\]]*\]\s*\(\s*<?[^)]+>?\s*(?:"[^"]*"|'[^']*')?(?:\s*=\s*\d+(?:x\d+)?)?\s*\)/gu, ""),
	)
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
	return images.slice(0, MAX_DYNAMIC_IMAGES);
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
	// [236] 正文已经清洗过一次，这里直接复用，避免 markdownToPlainText 再完整解析一遍
	const previewText = markdownToPlainText(content) || (images.length ? "分享了一张图片" : "");
	return { size, content, images, previewText };
}

/** Turn `![](url =240x180)` into HTML so marked and the sanitizer keep width/height. */
export function rewriteMarkdownImageSizes(content: string) {
	return transformOutsideCode(content, (chunk) =>
		chunk.replace(resetRegex(MARKDOWN_IMAGE), (full, alt: string, url: string, titleDq?: string, titleSq?: string, width?: string, height?: string) => {
			const safeWidth = clampDimension(width);
			if (safeWidth === undefined) return full;
			const safeHeight = clampDimension(height);
			const title = titleDq || titleSq;
			const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
			const heightAttr = safeHeight === undefined ? "" : ` height="${safeHeight}"`;
			return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}" width="${safeWidth}"${heightAttr}${titleAttr}>`;
		}),
	);
}
