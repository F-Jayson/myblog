import type { Paginated, Post, PostSummary, SiteData } from "./types";

export const fallbackPosts: Post[] = [];

export const fallbackSite: SiteData = {
	title: "",
	subtitle: "",
	description: "",
	siteFavicon: "",
	cover: null,
	titleConfig: {
		title: "",
		subtitle: "",
		subtitleMode: "text",
		hitokotoApi: "",
	},
	music: {
		enabled: false,
		src: "",
		title: "",
		artist: "",
		cover: "",
		autoplay: false,
		loop: false,
	},
	author: null,
	stats: { posts: 0, views: 0, totalWords: 0, startDate: null, lastActivityAt: null },
	categories: [],
	tags: [],
	dynamics: [],
	announcement: { content: "", updatedAt: "", displayItems: [] },
	hue: 240,
};

export function fallbackPage(page = 1, pageSize = 10): Paginated<PostSummary> {
	return { items: [], page, pageSize, total: 0, totalPages: 1 };
}

export function fallbackPostsFor(params: { page?: number; pageSize?: number; category?: string; tag?: string; q?: string } = {}): Paginated<PostSummary> {
	return { items: [], page: params.page ?? 1, pageSize: params.pageSize ?? 10, total: 0, totalPages: 1 };
}
