export type Tag = {
	id: number;
	name: string;
	slug: string;
	postCount?: number;
};

export type Category = {
	id: number;
	name: string;
	slug: string;
	description: string;
	postCount?: number;
};

export type PostSummary = {
	id: number;
	slug: string;
	filename?: string;
	title: string;
	excerpt: string;
	cover: string | null;
	topImage?: string | null;
	category: Pick<Category, "name" | "slug"> | null;
	categories?: Pick<Category, "name" | "slug">[];
	tags: Tag[];
	pinned: boolean;
	views: number;
	words: number;
	minutes: number;
	publishedAt: string | null;
	updatedAt: string;
};

export type Post = PostSummary & {
	content: string;
};

export type Paginated<T> = {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
};

export type ManagedPageKey = "about" | "transfer" | "issues";

export type FriendLink = {
	name: string;
	url: string;
	logo: string;
	description: string;
};

export type ManagedPage = {
	page: ManagedPageKey;
	title: string;
	content: string;
	friendLinksIntro: string;
	friendLinks: FriendLink[];
	updatedAt: string;
};

export type Changelog = {
	id: number;
	slug: string;
	title: string;
	version: string;
	date: string;
	published: boolean;
	content: string;
	updatedAt: string;
};

export type FeedbackEntry = {
	id: number;
	category: string;
	subject: string;
	content: string;
	contact: string;
	pageUrl: string;
	status: "open" | "processing" | "resolved";
	clientIp?: string;
	clientUa?: string;
	createdAt: string;
	updatedAt: string;
};

export type UserStorageItem = {
	id: number;
	userId?: number;
	kind: string;
	name: string;
	url: string;
	storageKey?: string;
	mimeType: string;
	byteSize: number;
	isPublic: boolean;
	publicToken?: string | null;
	publicUrl?: string | null;
	viewCount: number;
	createdAt: string;
	updatedAt: string;
};

export type ClipboardContentType = "text" | "markdown" | "code";

export type UserClipboard = {
	id: number;
	userId?: number;
	title: string;
	content?: string;
	contentType: ClipboardContentType;
	language: string;
	byteSize: number;
	isPublic: boolean;
	publicToken?: string | null;
	publicUrl?: string | null;
	viewCount: number;
	createdAt: string;
	updatedAt: string;
};

export type AuthorSkill = {
	name: string;
	level: number;
	description: string;
	icon: string | null;
};

export type AuthorLearningProgress = {
	name: string;
	progress: number;
	description: string;
	status: string | null;
};

export type AuthorProfileDetails = {
	headline: string;
	introduction: string;
	location: string;
	website: string | null;
	skills: AuthorSkill[];
	learningProgress: AuthorLearningProgress[];
};

export type AuthorProfile = {
	name: string;
	bio: string;
	avatar: string;
	email: string | null;
	githubUrl: string | null;
	qqUrl: string | null;
	rssUrl: string | null;
	links: Array<{ label: string; url: string; icon?: string | null }> ;
	profile: AuthorProfileDetails;
};

export type AuthorActivityDay = {
	date: string;
	count: number;
};
