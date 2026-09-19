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

export type Post = PostSummary & { content: string };

export type PublicUser = {
	id: number | string;
	username?: string;
	account?: string;
	nickname?: string;
	displayName?: string;
	avatar?: string | null;
	email?: string | null;
	role?: string;
	isAdmin?: boolean;
	badge?: string | null;
};

export type UserStorageItem = {
 id: number | string;
 userId?: number | string;
 kind?: string;
 name?: string | null;
 url?: string | null;
 storageKey?: string;
 sizeBytes?: number;
 isPublic?: boolean;
 publicToken?: string | null;
 accessCount?: number;
 createdAt?: string;
 updatedAt?: string;
};

export type ClipboardContentType = "text" | "markdown" | "code";

export type UserClipboard = {
 id: number | string;
 title: string;
 content: string;
 contentType?: ClipboardContentType;
 language?: string;
 sizeBytes?: number;
 isPublic?: boolean;
 publicToken?: string | null;
 publicUrl?: string | null;
 accessCount?: number;
 createdAt?: string;
 updatedAt?: string;
};

export type UserSpaceStats = {
 limitBytes: number;
 usedBytes: number;
 remainingBytes: number;
 categories?: Record<string, number>;
};

export type CommentRecord = {
	id: number | string;
	postId?: number;
	parentId?: number | string | null;
	body: string;
	authorName?: string;
	authorEmail?: string | null;
	author?: PublicUser | null;
	avatar?: string | null;
	createdAt: string;
	status?: string;
	ipLocation?: string | null;
	device?: string | null;
	browser?: string | null;
	isAdmin?: boolean;
	badge?: string | null;
	children?: CommentRecord[];
	replies?: CommentRecord[];
	images?: string[];
};

export type CommentSettings = {
	commentsEnabled: boolean;
	commentRegistrationEnabled: boolean;
	commentModerationEnabled: boolean;
	allowAnonymous: boolean;
	emailRegistrationEnabled: boolean;
	avatarPresets: string[];
};

export type FeatureSettings = {
	commentsEnabled: boolean;
	registrationEnabled: boolean;
	loginEnabled: boolean;
	imageHostingEnabled: boolean;
	clipboardEnabled: boolean;
	userCenterEnabled: boolean;
	publicResourcesEnabled: boolean;
	compilerEnabled: boolean;
};

export type CompilerLanguage = {
	key: string;
	label: string;
	extension: string;
	version?: string;
};

export type CompilerRunRequest = {
	language: string;
	code: string;
	stdin?: string;
	breakpoints?: number[];
	debug?: boolean;
};

export type CompilerRunResult = {
	output?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
	exitCode?: number | null;
	durationMs?: number;
	status?: string;
	diagnostics?: Array<{ line?: number; column?: number; message: string; severity?: "error" | "warning" | "info" }>;
	breakpoints?: number[];
	hitBreakpoints?: number[];
	debug?: {
		breakpoints?: number[];
		hitBreakpoints?: number[];
		stoppedAt?: number | null;
		variables?: Record<string, unknown>;
		stack?: string[];
		message?: string;
	};
};

export type EmojiSticker = {
	id: number | string;
	name?: string;
	url: string;
	ownerId?: number | string | null;
};

export type Paginated<T> = {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
};

export type SiteCover = {
	mode: "upload" | "url" | "api";
	value: string;
	apiUrl?: string;
	position?: string;
};

export type SiteTitleConfig = {
	title?: string;
	subtitle?: string;
	subtitleMode?: "text" | "hitokoto";
	hitokotoApi?: string;
	titleFontUrl?: string;
	subtitleFontUrl?: string;
	postTitleFontUrl?: string;
	bodyFontUrl?: string;
	postContentFontUrl?: string;
	tagFontUrl?: string;
};

export type SiteMusic = {
	enabled?: boolean;
	src?: string;
	title?: string;
	artist?: string;
	cover?: string;
	autoplay?: boolean;
	loop?: boolean;
};

export type SiteRuntimeInfo = {
	application: {
		name: string;
		version: string;
	};
	node: string;
	platform: string;
	architecture: string;
	startedAt: string;
};

export type AuthorLink = {
	label: string;
	url: string;
	icon?: string | null;
};

export type AuthorProfileSkill = {
	name: string;
	level: number;
	description?: string | null;
	icon?: string | null;
};

export type AuthorProfileLearning = {
	name: string;
	progress: number;
	description?: string | null;
	status?: string | null;
};

export type AuthorProfile = {
	name: string;
	bio: string;
	avatar: string;
	email?: string | null;
	githubUrl?: string | null;
	qqUrl?: string | null;
	rssUrl?: string | null;
	links?: AuthorLink[];
	headline?: string | null;
	location?: string | null;
	website?: string | null;
	introduction?: string | null;
	skills?: AuthorProfileSkill[];
	learning?: AuthorProfileLearning[];
};

export type AuthorHeatmapDay = {
	date: string;
	count: number;
};

export type AuthorHeatmap = {
	from: string | null;
	to: string | null;
	totalPosts: number;
	days: AuthorHeatmapDay[];
};

export type AuthorProfilePayload = {
	author: AuthorProfile;
	heatmap: AuthorHeatmap;
};

export type ManagedPageKey = "about" | "transfer" | "issues";

export type ManagedFriendLink = {
	name: string;
	url: string;
	logo?: string | null;
	description?: string | null;
};

export type ManagedPage = {
	page?: ManagedPageKey | string;
	title: string;
	content: string;
	friendLinksIntro?: string;
	friendLinks?: ManagedFriendLink[];
	updatedAt?: string;
	relativePath?: string;
};

export type ChangelogEntry = {
	fileName?: string;
	slug?: string;
	title: string;
	version?: string;
	date?: string;
	published?: boolean;
	content: string;
	updatedAt?: string;
};

export type FeedbackSettings = {
	enabled: boolean;
	maxFiles?: number;
	maxFileSizeMb?: number;
};

export type SiteData = {
	title: string;
	subtitle: string;
	description: string;
	/** Optional public favicon configured from the site media settings. */
	siteFavicon?: string;
	hue: number;
	author: {
		name: string;
		bio: string;
		avatar: string;
		email: string | null;
		githubUrl: string | null;
		qqUrl: string | null;
		rssUrl: string | null;
		links?: AuthorLink[];
	} | null;
	cover?: SiteCover | null;
	titleConfig?: SiteTitleConfig | null;
	music?: SiteMusic | null;
	runtime?: SiteRuntimeInfo | null;
	stats: {
		posts: number;
		views: number;
		totalWords: number;
		startDate: string | null;
		lastActivityAt: string | null;
	};
	categories: Category[];
	tags: Tag[];
	dynamics: Array<{ id: number; body: string; images?: string[]; publishedAt: string }>;
	announcement?: {
		content: string;
		updatedAt: string;
		displayItems?: Array<{
			id: number;
			content: string;
			publishedAt: string;
			updatedAt: string;
			isVisible: boolean;
			isPinned: boolean;
			sortOrder: number;
			isCurrent?: boolean;
		}>;
	};
};
