import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const SKIPPED = new Set(["node_modules", "dist", ".git", ".cursor", "uploads", ".blog-run", ".compiler-work"]);
const MAX_BYTES = 1_500_000;
const MAX_FILES = 100;

export type MarkdownDocument = { externalKey: string; title: string; content: string; path: string };

function stripFrontMatter(content: string) {
	if (!content.startsWith("---")) return { content, title: "" };
	const end = content.indexOf("\n---", 3);
	if (end < 0) return { content, title: "" };
	const block = content.slice(3, end);
	const match = block.match(/^title:\s*["']?(.+?)["']?\s*$/mu);
	return { content: content.slice(end + 4).replace(/^\s+/u, ""), title: match?.[1]?.trim() ?? "" };
}

function titleFromMarkdown(content: string, fallback: string) {
	const { content: body, title } = stripFrontMatter(content.replace(/^\uFEFF/u, ""));
	const heading = body.match(/^\s*#\s+(.+)$/mu)?.[1]?.replace(/\s+#+\s*$/u, "").trim();
	return { title: (title || heading || fallback).slice(0, 255), content: body };
}

export function externalKeyFor(filePath: string) {
	const absolute = resolve(filePath);
	const fromCwd = relative(process.cwd(), absolute);
	const key = fromCwd.startsWith("..") || isAbsolute(fromCwd) ? absolute : fromCwd;
	return key.split(sep).join("/");
}

export async function readMarkdown(filePath: string): Promise<MarkdownDocument> {
	const absolute = resolve(filePath);
	const fileStat = await stat(absolute);
	if (!fileStat.isFile()) throw new Error(`${filePath} 不是文件`);
	if (fileStat.size > MAX_BYTES) throw new Error(`${filePath} 超过 1.5MB，请拆分后再同步`);
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
	const entries = await readdir(directory, { withFileTypes: true });
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
	for (const filePath of input.paths ?? []) files.add(resolve(filePath));
	if (input.directory) await walkMarkdown(resolve(input.directory), resolve(input.directory), input.recursive !== false, files);
	const selected = [...files].sort((left, right) => left.localeCompare(right, "zh-CN"));
	if (!selected.length) throw new Error("没有找到要同步的 Markdown 文件");
	if (selected.length > MAX_FILES) throw new Error(`一次最多同步 ${MAX_FILES} 个文件，请缩小目录或改用 paths`);
	return selected;
}
