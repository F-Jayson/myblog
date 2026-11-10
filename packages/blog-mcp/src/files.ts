import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const SKIPPED = new Set(["node_modules", "dist", ".git", ".cursor", "uploads", ".blog-run", ".compiler-work"]);
const MAX_BYTES = 1_500_000;
const MAX_FILES = 100;

export type MarkdownDocument = { externalKey: string; title: string; content: string; path: string };

// front matter 必须在文件开头、且结束行是单独的 ---：
// 用 indexOf("\n---") 会把正文里的 "\n---foo"、"--- 分隔线后面的内容" 也当成结束标记
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

function stripFrontMatter(content: string) {
	if (!content.startsWith("---")) return { content, title: "" };
	const matched = FRONT_MATTER.exec(content);
	if (!matched) return { content, title: "" };
	const match = matched[1].match(/^title:\s*["']?(.+?)["']?\s*$/mu);
	return { content: content.slice(matched[0].length), title: match?.[1]?.trim() ?? "" };
}

function titleFromMarkdown(content: string, fallback: string) {
	const { content: body, title } = stripFrontMatter(content.replace(/^\uFEFF/u, ""));
	const heading = body.match(/^\s*#\s+(.+)$/mu)?.[1]?.replace(/\s+#+\s*$/u, "").trim();
	return { title: (title || heading || fallback).slice(0, 255), content: body };
}

export function externalKeyFor(filePath: string) {
	const absolute = resolve(filePath);
	const fromCwd = relative(process.cwd(), absolute);
	// startsWith("..") 会把 cwd 下的 "..foo/x.md" 也判成越界，必须带上分隔符比较
	const outside = fromCwd === ".." || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd);
	const key = outside ? absolute : fromCwd;
	return key.split(sep).join("/");
}

export async function readMarkdown(filePath: string): Promise<MarkdownDocument> {
	const absolute = resolve(filePath);
	const fileStat = await stat(absolute);
	if (!fileStat.isFile()) throw new Error(`${filePath} 不是文件`);
	if (fileStat.size > MAX_BYTES) throw new Error(`${filePath} 超过 ${(MAX_BYTES / 1_000_000).toFixed(1)}MB，请拆分后再同步`);
	const raw = await readFile(absolute, "utf8");
	if (raw.includes("\u0000")) throw new Error(`${filePath} 不是文本文件`);
	const fallback = basename(absolute, extname(absolute));
	const parsed = titleFromMarkdown(raw, fallback);
	return { ...parsed, externalKey: externalKeyFor(absolute), path: absolute };
}

function skipped(relativePath: string) {
	return relativePath.split(/[\\/]/u).some((part) => SKIPPED.has(part));
}

async function walkMarkdown(directory: string, root: string, recursive: boolean, files: Set<string>) {
	// 任一子目录不可读不能让整次同步失败：跳过并提示，其余文件照常收集
	const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
		console.error(`[blog-mcp] 跳过无法读取的目录 ${directory}：${error instanceof Error ? error.message : String(error)}`);
		return [];
	});
	for (const entry of entries) {
		const full = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (recursive && !SKIPPED.has(entry.name)) await walkMarkdown(full, root, true, files);
			continue;
		}
		const extension = extname(entry.name).toLowerCase();
		if (extension !== ".md" && extension !== ".markdown") continue;
		if (skipped(relative(root, full))) continue;
		files.add(full);
	}
}

export async function collectMarkdown(input: { paths?: string[]; directory?: string; recursive?: boolean }) {
	const files = new Set<string>();
	for (const filePath of input.paths ?? []) {
		const absolute = resolve(filePath);
		// 与目录分支保持一致：显式路径也必须给出 Markdown 文件，否则同步时才会在读取阶段莫名报错
		const extension = extname(absolute).toLowerCase();
		if (extension !== ".md" && extension !== ".markdown") throw new Error(`${filePath} 不是 Markdown 文件`);
		files.add(absolute);
	}
	if (input.directory) await walkMarkdown(resolve(input.directory), resolve(input.directory), input.recursive !== false, files);
	const selected = [...files].sort((left, right) => left.localeCompare(right, "zh-CN"));
	if (!selected.length) throw new Error("没有找到要同步的 Markdown 文件");
	if (selected.length > MAX_FILES) throw new Error(`一次最多同步 ${MAX_FILES} 个文件，请缩小目录或改用 paths`);
	return selected;
}
