import {
	Archive,
	ArrowUp,
	BookOpen,
	Boxes,
	CalendarDays,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Cloud,
	Copy,
	Clock3,
	Code2,
	ExternalLink,
	Folder,
	Flower2,
	Github,
	Globe2,
	Heart,
	Home,
	Image,
	Info,
	Library,
	List,
	Mail,
	Menu,
	MessageCircle,
	MoreHorizontal,
	Music2,
	Moon,
	Palette,
	Pause,
	Pin,
	Play,
	Quote,
	RotateCcw,
	Rss,
	Rocket,
	Search,
	Send,
	Sun,
	Tag,
	UserRound,
	Wrench,
	X,
} from "lucide-react";
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
	Link,
	NavLink,
	Outlet,
	Route,
	Routes,
	useLocation,
	useNavigate,
	useOutletContext,
	useParams,
	useSearchParams,
} from "react-router-dom";
import { api } from "./api";
import AdminWorkspace from "./admin/AdminApp";
import Comments from "./Comments";
import { AccountMenu, AuthProvider, useAuth } from "./auth";
import CompilerPage from "./CompilerPage";
import { ClipboardPage, ImageHostPage, UserProfilePage, UserSpacePage } from "./UserTools";
import AuthorProfilePage from "./AuthorProfilePage";
import { fallbackPosts, fallbackPostsFor, fallbackSite } from "./data";
import { isSafeNavigationUrl, isSafeResourceUrl, resolveMediaUrl } from "./media";
import type { ChangelogEntry, ManagedFriendLink, ManagedPage, ManagedPageKey, Post, PostSummary, SiteData, SiteMusic } from "./types";

const SiteContext = createContext<SiteData>(fallbackSite);
const MarkdownContent = lazy(() => import("./MarkdownContent"));
const fallbackHeroSources = Array.from({ length: 6 }, (_, index) => ({
	desktop: "/images/DesktopWallpaper/d" + (index + 1) + ".avif",
	mobile: "/images/MobileWallpaper/m" + (index + 1) + ".avif",
}));

const configuredFontDefinitions = [
	{ key: "titleFontUrl", family: "FireflySiteTitle", variable: "--site-title-font" },
	{ key: "subtitleFontUrl", family: "FireflySiteSubtitle", variable: "--site-subtitle-font" },
	{ key: "postTitleFontUrl", family: "FireflyPostTitle", variable: "--site-post-title-font" },
	{ key: "bodyFontUrl", family: "FireflySiteBody", variable: "--site-body-font" },
	{ key: "postContentFontUrl", family: "FireflyPostContent", variable: "--site-post-content-font" },
	{ key: "tagFontUrl", family: "FireflySiteTag", variable: "--site-tag-font" },
] as const;

type ArchiveItem = {
	year: number;
	id: number;
	slug: string;
	title: string;
	publishedAt: string;
	category: string | null;
};

const fallbackArchiveItems: ArchiveItem[] = fallbackPosts.map((post) => ({
	year: Number((post.publishedAt ?? "2026").slice(0, 4)),
	id: post.id,
	slug: post.slug,
	title: post.title,
	publishedAt: post.publishedAt ?? "",
	category: post.category?.name ?? null,
}));

function useSite() {
	return useContext(SiteContext);
}

type MusicPlaybackValue = {
	music: SiteMusic | null;
	playing: boolean;
	currentTime: number;
	duration: number;
	toggle: () => void;
	seek: (value: number) => void;
};

const MusicPlaybackContext = createContext<MusicPlaybackValue>({ music: null, playing: false, currentTime: 0, duration: 0, toggle: () => undefined, seek: () => undefined });

function MusicPlaybackProvider({ children }: { children: ReactNode }) {
	const site = useSite();
	const audioRef = useRef<HTMLAudioElement>(null);
	const music = useMemo<SiteMusic | null>(() => {
		if (site.music?.enabled === false || !site.music?.src) return null;
		return { ...site.music, src: resolveMediaUrl(site.music.src), cover: resolveMediaUrl(site.music.cover) || undefined };
	}, [site.music?.enabled, site.music?.src, site.music?.cover, site.music?.title, site.music?.artist, site.music?.autoplay, site.music?.loop]);
	const [playing, setPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	useEffect(() => {
		setPlaying(false);
		setCurrentTime(0);
		setDuration(0);
		if (music?.autoplay) void audioRef.current?.play().catch(() => undefined);
	}, [music?.src, music?.autoplay]);
	const toggle = () => {
		const audio = audioRef.current;
		if (!audio || !music) return;
		if (audio.paused) void audio.play().catch(() => setPlaying(false));
		else audio.pause();
	};
	const seek = (value: number) => {
		if (!audioRef.current || !Number.isFinite(value)) return;
		audioRef.current.currentTime = value;
		setCurrentTime(value);
	};
	return <MusicPlaybackContext.Provider value={{ music, playing, currentTime, duration, toggle, seek }}>
		{children}
		{music ? <audio className="site-audio-engine" ref={audioRef} src={music.src} preload="metadata" autoPlay={music.autoplay} loop={music.loop} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} /> : null}
	</MusicPlaybackContext.Provider>;
}

function formatPlaybackTime(value: number) {
	if (!Number.isFinite(value) || value < 0) return "0:00";
	const minutes = Math.floor(value / 60);
	return minutes + ":" + String(Math.floor(value % 60)).padStart(2, "0");
}

function safeHeroPosition(value: string | null | undefined) {
	const source = typeof value === "string" ? value.trim() : "";
	return /^(?:(?:left|center|right)|-?\d+(?:\.\d+)?%)(?:\s+(?:(?:top|center|bottom)|-?\d+(?:\.\d+)?%))?$/iu.test(source) ? source : "center 35%";
}

function ConfiguredMusicPlayer({ compact = false }: { compact?: boolean }) {
	const { music, playing, currentTime, duration, toggle, seek } = useContext(MusicPlaybackContext);
	if (!music) return null;
	return <div className={"configured-music " + (compact ? "is-compact" : "")}>
		<div className="configured-music-track">
			{music.cover ? <img src={music.cover} alt="" width="52" height="52" loading="lazy" decoding="async" /> : <span className="configured-music-placeholder"><Music2 size={21} /></span>}
			<div><strong>{music.title || "背景音乐"}</strong><small>{music.artist || "站点音乐"}</small></div>
			<button type="button" className="configured-music-toggle" title={playing ? "暂停" : "播放"} aria-label={playing ? "暂停" : "播放"} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
		</div>
		<div className="configured-music-progress"><span>{formatPlaybackTime(currentTime)}</span><input type="range" min="0" max={duration || 1} step="0.1" value={Math.min(currentTime, duration || 1)} aria-label="音乐播放进度" onChange={(event) => seek(Number(event.target.value))} /><span>{formatPlaybackTime(duration)}</span></div>
	</div>;
}

function dateText(value: string | null | undefined) {
	if (!value) return "未发布";
	return value.replace(/[-]/gu, ".").slice(0, 10);
}

function daysSince(date: string | null | undefined) {
	if (!date) return null;
	const start = new Date(date).getTime();
	if (!Number.isFinite(start) || start > Date.now()) return null;
	return Math.max(1, Math.floor((Date.now() - start) / 86_400_000) + 1);
}

function relativeActivityText(date: string | null | undefined) {
	if (!date) return "暂无文章";
	const timestamp = new Date(date).getTime();
	if (!Number.isFinite(timestamp)) return "暂不可用";
	const delta = Date.now() - timestamp;
	if (delta < 0) return "刚刚";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.floor(hours / 24);
	return days <= 3650 ? `${days} 天前` : "较早";
}

function numberText(value: number) {
	return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat("zh-CN").format(Math.floor(value)) : "0";
}

type ButtonProps = {
	children: ReactNode;
	title: string;
	onClick?: () => void;
	active?: boolean;
	className?: string;
};

function IconButton({ children, title, onClick, active, className = "" }: ButtonProps) {
	return (
		<button type="button" title={title} aria-label={title} onClick={onClick} className={`icon-button ${active ? "is-active" : ""} ${className}`}>
			{children}
		</button>
	);
}

function WidgetTitle({ children, icon: Icon }: { children: ReactNode; icon?: typeof Info }) {
	return (
		<div className="widget-title">
			{Icon ? <Icon size={17} strokeWidth={2.25} /> : null}
			<span>{children}</span>
		</div>
	);
}

type DisplaySettingsProps = {
	hue: number;
	setHue: (value: number) => void;
	wallpaper: string;
	setWallpaper: (value: string) => void;
	layout: "list" | "grid";
	setLayout: (value: "list" | "grid") => void;
	cardBorder: boolean;
	setCardBorder: (value: boolean) => void;
	cardFollowTheme: boolean;
	setCardFollowTheme: (value: boolean) => void;
	bannerTitle: boolean;
	setBannerTitle: (value: boolean) => void;
	carousel: boolean;
	setCarousel: (value: boolean) => void;
	wavesEnabled: boolean;
	setWavesEnabled: (value: boolean) => void;
	gradientEnabled: boolean;
	setGradientEnabled: (value: boolean) => void;
	sakuraEnabled: boolean;
	setSakuraEnabled: (value: boolean) => void;
	overlayOpacity: number;
	setOverlayOpacity: (value: number) => void;
	overlayBlur: number;
	setOverlayBlur: (value: number) => void;
	overlayCardOpacity: number;
	setOverlayCardOpacity: (value: number) => void;
};

function SettingToggle({ icon: Icon, label, checked, onChange }: { icon: typeof Info; label: string; checked: boolean; onChange: (value: boolean) => void }) {
	return <button type="button" className={`settings-toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
		<Icon size={19} /><span>{label}</span><i className="toggle-switch"><b /></i>
	</button>;
}

function SettingsSection({ title, onReset, children }: { title: string; onReset?: () => void; children: ReactNode }) {
	return <section className="settings-section"><div className="settings-section-title"><strong>{title}</strong>{onReset ? <button type="button" title={`重置${title}`} onClick={onReset}><RotateCcw size={14} /></button> : null}</div>{children}</section>;
}

function DisplaySettingsPanel(props: DisplaySettingsProps) {
	const [tab, setTab] = useState<"appearance" | "wallpaper" | "effects">("appearance");
	return <div className="floating-panel settings-panel settings-panel-rich">
		<div className="settings-tabs"><button type="button" className={tab === "appearance" ? "selected" : ""} onClick={() => setTab("appearance")}><Palette size={17} />外观</button><button type="button" className={tab === "wallpaper" ? "selected" : ""} onClick={() => setTab("wallpaper")}><Image size={17} />壁纸</button><button type="button" className={tab === "effects" ? "selected" : ""} onClick={() => setTab("effects")}><Flower2 size={17} />特效</button></div>
		{tab === "appearance" ? <>
			<SettingsSection title="主题色相" onReset={() => props.setHue(165)}><div className="hue-heading"><span>{props.hue}</span></div><input className="hue-slider" aria-label="主题色相" type="range" min="0" max="360" step="5" value={props.hue} onChange={(event) => props.setHue(Number(event.target.value))} /></SettingsSection>
			<SettingsSection title="文章布局" onReset={() => props.setLayout("list")}><div className="settings-choice-grid"><button type="button" className={props.layout === "list" ? "selected" : ""} onClick={() => props.setLayout("list")}><List size={19} />列表</button><button type="button" className={props.layout === "grid" ? "selected" : ""} onClick={() => props.setLayout("grid")}><Library size={19} />网格</button></div></SettingsSection>
			<SettingsSection title="卡片样式" onReset={() => { props.setCardBorder(false); props.setCardFollowTheme(false); }}><SettingToggle icon={Library} label="卡片边框和阴影" checked={props.cardBorder} onChange={props.setCardBorder} /><SettingToggle icon={Palette} label="卡片跟随主题色" checked={props.cardFollowTheme} onChange={props.setCardFollowTheme} /></SettingsSection>
		</> : null}
		{tab === "wallpaper" ? <>
			<SettingsSection title="壁纸模式" onReset={() => props.setWallpaper("banner")}><div className="settings-choice-grid wallpaper-choice-grid"><button type="button" className={props.wallpaper === "banner" ? "selected" : ""} onClick={() => props.setWallpaper("banner")}><Image size={19} />横幅壁纸</button><button type="button" className={props.wallpaper === "full" ? "selected" : ""} onClick={() => props.setWallpaper("full")}><Image size={19} />全屏壁纸</button><button type="button" className={props.wallpaper === "overlay" ? "selected" : ""} onClick={() => props.setWallpaper("overlay")}><Image size={19} />全屏透明</button><button type="button" className={props.wallpaper === "none" ? "selected" : ""} onClick={() => props.setWallpaper("none")}><Image size={19} />纯色背景</button></div></SettingsSection>
			{props.wallpaper === "overlay" ? <SettingsSection title="透明模式设置" onReset={() => { props.setOverlayOpacity(80); props.setOverlayBlur(10); props.setOverlayCardOpacity(50); }}><div className="settings-range"><label>背景透明度 <output>{props.overlayOpacity}%</output></label><input type="range" min="20" max="100" value={props.overlayOpacity} onChange={(event) => props.setOverlayOpacity(Number(event.target.value))} /></div><div className="settings-range"><label>背景模糊 <output>{props.overlayBlur}px</output></label><input type="range" min="0" max="20" step="0.5" value={props.overlayBlur} onChange={(event) => props.setOverlayBlur(Number(event.target.value))} /></div><div className="settings-range"><label>卡片透明度 <output>{props.overlayCardOpacity}%</output></label><input type="range" min="20" max="100" value={props.overlayCardOpacity} onChange={(event) => props.setOverlayCardOpacity(Number(event.target.value))} /></div></SettingsSection> : null}
			<SettingsSection title="壁纸设置" onReset={() => { props.setBannerTitle(true); props.setCarousel(false); props.setWavesEnabled(true); props.setGradientEnabled(true); }}><SettingToggle icon={Palette} label="首页壁纸标题" checked={props.bannerTitle} onChange={props.setBannerTitle} /><SettingToggle icon={Library} label="壁纸轮播" checked={props.carousel} onChange={props.setCarousel} /><SettingToggle icon={Quote} label="水波纹动画" checked={props.wavesEnabled} onChange={props.setWavesEnabled} /><SettingToggle icon={Image} label="渐变过渡" checked={props.gradientEnabled} onChange={props.setGradientEnabled} /></SettingsSection>
		</> : null}
		{tab === "effects" ? <SettingsSection title="特效设置" onReset={() => props.setSakuraEnabled(false)}><SettingToggle icon={Flower2} label="樱花特效" checked={props.sakuraEnabled} onChange={props.setSakuraEnabled} /></SettingsSection> : null}
	</div>;
}

function Header({ dark, setDark, wallpaper, setWallpaper, settings }: { dark: boolean; setDark: (value: boolean) => void; wallpaper: string; setWallpaper: (value: string) => void; settings: DisplaySettingsProps }) {
	const [mobileOpen, setMobileOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [musicOpen, setMusicOpen] = useState(false);
	const [query, setQuery] = useState("");
	const site = useSite();
	const { music, playing, toggle } = useContext(MusicPlaybackContext);
	const { features } = useAuth();
	const navigate = useNavigate();
	const submitSearch = (event: FormEvent) => {
		event.preventDefault();
		const term = query.trim();
		if (!term) return;
		navigate(`/search?q=${encodeURIComponent(term)}`);
		setSearchOpen(false);
		setMobileOpen(false);
	};

	return (
		<header className="top-row">
			<nav className="navbar" aria-label="主导航">
				<Link to="/" className="brand" aria-label={`${site.title} 首页`}>
					<img src={dark ? "/images/logo/firefly-dark.png" : "/images/logo/firefly-light.png"} alt="" width="32" height="32" decoding="async" />
					<span>{site.title}</span>
				</Link>
				<div className="desktop-navigation">
					<NavLink to="/" end><Home size={17} />主页</NavLink>
					<NavLink to="/tags"><Tag size={17} />标签</NavLink>
					<NavLink to="/archive"><Archive size={17} />归档</NavLink>
					<NavLink to="/categories"><Folder size={17} />分类</NavLink>
					<div className="nav-dropdown">
						<button type="button"><MoreHorizontal size={17} />更多 <ChevronDown size={15} /></button>
						<div className="dropdown-menu">
							<Link to="/about"><Heart size={16} />关于</Link>
							<Link to="/transfer"><ExternalLink size={16} />传送</Link>
							<Link to="/issues"><Wrench size={16} />问题总结</Link>
							<Link to="/feedback"><MessageCircle size={16} />问题反馈</Link>
							<Link to="/changelog"><Clock3 size={16} />更新日志</Link>
						</div>
					</div>
				</div>
				<form className="nav-search" onSubmit={submitSearch}>
					<Search size={17} aria-hidden="true" />
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索文章" />
				</form>
				<div className="nav-actions">
					<AccountMenu />
					<IconButton title="搜索" className="mobile-search-button" onClick={() => { setSearchOpen((open) => !open); setSettingsOpen(false); setMusicOpen(false); }} active={searchOpen}><Search size={19} /></IconButton>
					{music ? <IconButton title="音乐播放器" onClick={() => { setMusicOpen((open) => !open); setSearchOpen(false); setSettingsOpen(false); }} active={musicOpen}><Music2 size={19} /></IconButton> : null}
					{music ? <IconButton title={playing ? "暂停音乐" : "播放音乐"} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</IconButton> : null}
					<IconButton title={dark ? "切换为浅色模式" : "切换为深色模式"} onClick={() => setDark(!dark)}>{dark ? <Moon size={19} /> : <Sun size={19} />}</IconButton>
					<IconButton title="显示设置" onClick={() => { setSettingsOpen((open) => !open); setSearchOpen(false); setMusicOpen(false); }} active={settingsOpen}><Palette size={19} /></IconButton>
					<IconButton title="打开菜单" className="mobile-menu-button" onClick={() => setMobileOpen(true)}><Menu size={21} /></IconButton>
				</div>
				{searchOpen ? (
					<form className="floating-panel search-panel" onSubmit={submitSearch}>
						<Search size={18} />
						<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文章" aria-label="搜索文章" />
						<button type="submit" aria-label="提交搜索"><ChevronRight size={19} /></button>
					</form>
				) : null}
				{settingsOpen ? <DisplaySettingsPanel {...settings} /> : null}
				{musicOpen ? <div className="floating-panel music-panel"><WidgetTitle icon={Music2}>背景音乐</WidgetTitle><ConfiguredMusicPlayer /></div> : null}
			</nav>
			{mobileOpen ? (
				<div className="mobile-overlay" role="presentation" onClick={() => setMobileOpen(false)}>
					<div className="mobile-drawer" role="dialog" aria-modal="true" aria-label="导航菜单" onClick={(event) => event.stopPropagation()}>
						<div className="drawer-heading"><span>{site.title}</span><IconButton title="关闭菜单" onClick={() => setMobileOpen(false)}><X size={20} /></IconButton></div>
						<form className="drawer-search" onSubmit={submitSearch}><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文章" /><button type="submit" title="搜索"><ChevronRight size={18} /></button></form>
						<div className="drawer-links">
							<Link onClick={() => setMobileOpen(false)} to="/"><Home size={18} />主页</Link><Link onClick={() => setMobileOpen(false)} to="/tags"><Tag size={18} />标签</Link><Link onClick={() => setMobileOpen(false)} to="/archive"><Archive size={18} />归档</Link><Link onClick={() => setMobileOpen(false)} to="/categories"><Folder size={18} />分类</Link><span className="drawer-section-label"><Wrench size={17} />小工具</span>{features.compilerEnabled ? <Link onClick={() => setMobileOpen(false)} to="/tools/compiler"><Code2 size={18} />在线编译器</Link> : null}{features.imageHostingEnabled ? <Link onClick={() => setMobileOpen(false)} to="/tools/image-host"><Image size={18} />图床</Link> : null}{features.clipboardEnabled ? <Link onClick={() => setMobileOpen(false)} to="/tools/clipboard"><Copy size={18} />在线剪贴板</Link> : null}<span className="drawer-section-label"><MoreHorizontal size={17} />更多</span><Link onClick={() => setMobileOpen(false)} to="/about"><Heart size={18} />关于</Link><Link onClick={() => setMobileOpen(false)} to="/transfer"><ExternalLink size={18} />传送</Link><Link onClick={() => setMobileOpen(false)} to="/issues"><Wrench size={18} />问题总结</Link><Link onClick={() => setMobileOpen(false)} to="/feedback"><MessageCircle size={18} />问题反馈</Link><Link onClick={() => setMobileOpen(false)} to="/changelog"><Clock3 size={18} />更新日志</Link>
						</div>
						<div className="drawer-account"><AccountMenu /></div>
					</div>
				</div>
			) : null}
		</header>
	);
}

function Hero({ wallpaper, showTitle, carousel, wavesEnabled, gradientEnabled }: { wallpaper: string; showTitle: boolean; carousel: boolean; wavesEnabled: boolean; gradientEnabled: boolean }) {
	const location = useLocation();
	const site = useSite();
	const isHome = location.pathname === "/";
	const coverSource = resolveMediaUrl(site.cover?.mode === "api" ? (site.cover.apiUrl || site.cover.value) : site.cover?.value);
	const configuredCover = isSafeResourceUrl(coverSource) ? coverSource : "";
	const heroSources = configuredCover ? [{ desktop: configuredCover, mobile: configuredCover }] : fallbackHeroSources;
	const [wallpaperIndex, setWallpaperIndex] = useState(configuredCover ? 0 : 1);
	const [outgoingWallpaperIndex, setOutgoingWallpaperIndex] = useState<number | null>(null);
	const wallpaperIndexRef = useRef(wallpaperIndex);
	useEffect(() => {
		const nextIndex = configuredCover ? 0 : 1;
		wallpaperIndexRef.current = nextIndex;
		setWallpaperIndex(nextIndex);
		setOutgoingWallpaperIndex(null);
	}, [configuredCover]);
	useEffect(() => {
		if (!carousel || heroSources.length < 2) return;
		let transitionTimer: number | undefined;
		const timer = window.setInterval(() => {
			const previousIndex = wallpaperIndexRef.current;
			const nextIndex = (previousIndex + 1) % heroSources.length;
			wallpaperIndexRef.current = nextIndex;
			setOutgoingWallpaperIndex(previousIndex);
			setWallpaperIndex(nextIndex);
			transitionTimer = window.setTimeout(() => setOutgoingWallpaperIndex((current) => current === previousIndex ? null : current), 1100);
		}, 8000);
		return () => { window.clearInterval(timer); if (transitionTimer) window.clearTimeout(transitionTimer); };
	}, [carousel, heroSources.length]);
	if (wallpaper === "none") return <div className="hero-spacer" />;
	const imageStyle = (index: number) => {
		const source = heroSources[index] || heroSources[0] || fallbackHeroSources[1];
		return {
			"--hero-desktop-image": "url(\"" + source.desktop.replace(/["\\]/gu, "\\$&") + "\")",
			"--hero-mobile-image": "url(\"" + source.mobile.replace(/["\\]/gu, "\\$&") + "\")",
			"--hero-position": safeHeroPosition(site.cover?.position),
		} as CSSProperties;
	};
	const crossfadeImages = (className = "") => <>{outgoingWallpaperIndex !== null ? <div className={`hero-image hero-image-outgoing ${className}`} style={imageStyle(outgoingWallpaperIndex)} /> : null}<div className={`hero-image hero-image-current ${outgoingWallpaperIndex !== null ? "is-crossfading" : ""} ${className}`} style={imageStyle(wallpaperIndex)} /></>;
	if (wallpaper === "overlay") return <div className={`hero-overlay-layer ${gradientEnabled ? "" : "hero-gradient-off"}`}>{crossfadeImages()}<div className="hero-scrim" /></div>;
	const title = site.titleConfig?.title?.trim() || site.title || "Firefly";
	const subtitle = site.titleConfig?.subtitle?.trim() || site.subtitle || "愿每一颗心，都能免于哀伤。";
	return (
		<section className={`hero ${wallpaper === "full" ? "hero-full" : ""} ${gradientEnabled ? "" : "hero-gradient-off"} hero-home`}>
			{crossfadeImages()}
			<div className="hero-scrim" />
			{showTitle && isHome ? <div className="hero-content">
				<h1>{title}</h1><TypewriterSubtitle fallbackText={subtitle} mode={site.titleConfig?.subtitleMode || "text"} endpoint={site.titleConfig?.hitokotoApi} />
			</div> : null}
			{wallpaper === "full" && isHome ? <a className="hero-scroll" href="#content" aria-label="向下查看内容"><ChevronDown size={34} strokeWidth={1.8} /></a> : null}
			{wavesEnabled ? <div className="hero-waves" aria-hidden="true"><svg viewBox="0 24 150 28" preserveAspectRatio="none" shapeRendering="geometricPrecision"><defs><path id="firefly-wave" d="M-160 44c30 0 58-18 88-18s58 18 88 18 58-18 88-18 58 18 88 18v48h-352z" /></defs><g className="wave-parallax"><use className="wave-layer wave-layer-one" href="#firefly-wave" x="48" y="0" /><use className="wave-layer wave-layer-two" href="#firefly-wave" x="48" y="3" /><use className="wave-layer wave-layer-three" href="#firefly-wave" x="48" y="5" /><use className="wave-layer wave-layer-four" href="#firefly-wave" x="48" y="7" /></g></svg></div> : null}
		</section>
	);
}

function TypewriterSubtitle({ fallbackText, mode, endpoint }: { fallbackText: string; mode: "text" | "hitokoto"; endpoint?: string }) {
	const [target, setTarget] = useState(fallbackText);
	const [value, setValue] = useState("");
	useEffect(() => {
		setTarget(fallbackText);
		if (mode !== "hitokoto") return;
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 6000);
		fetch(endpoint?.trim() || "https://v1.hitokoto.cn/?encode=json", { signal: controller.signal })
			.then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json() as Promise<{ hitokoto?: string }>; })
			.then((payload) => { const text = payload.hitokoto?.trim(); if (text) setTarget(text); })
			.catch(() => setTarget(fallbackText))
			.finally(() => window.clearTimeout(timeout));
		return () => { window.clearTimeout(timeout); controller.abort(); };
	}, [endpoint, fallbackText, mode]);
	useEffect(() => { setValue(""); }, [target]);
	useEffect(() => {
		if (value === target) return;
		const timer = window.setTimeout(() => setValue(target.slice(0, value.length + 1)), 72);
		return () => window.clearTimeout(timer);
	}, [target, value]);
	return <p className="hero-subtitle typewriter-subtitle">{value || " "}</p>;
}

function SakuraEffect() {
	return <div className="sakura-layer" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <img key={index} src="/sakura.png" alt="" style={{ left: `${(index * 17 + 3) % 100}%`, width: `${1 + (index % 4) * .28}rem`, opacity: .34 + (index % 5) * .1, animationDuration: `${8 + (index % 6) * 1.2}s`, animationDelay: `${(index % 7) * -1.1}s` }} />)}</div>;
}

function LeftSidebar() {
	const site = useSite();
	const author = site.author ?? fallbackSite.author!;
	const { music } = useContext(MusicPlaybackContext);
	const { features } = useAuth();
	const avatar = resolveMediaUrl(author.avatar || fallbackSite.author?.avatar || "/images/avatar.avif");
	const navigationUrl = (value: string | null | undefined) => isSafeNavigationUrl(value) ? value!.trim() : "#";
	const displayAnnouncements = (site.announcement?.displayItems ?? []).filter((item) => item.isVisible).sort((left, right) => Number(right.isPinned) - Number(left.isPinned) || left.sortOrder - right.sortOrder || new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime() || right.id - left.id);
	const announcement = (displayAnnouncements[0]?.content ?? site.announcement?.content ?? "欢迎来到我的博客！这是一则示例公告。").trim();
	return <aside className="sidebar left-sidebar">
		<section className="card profile-card profile-card-large"><Link className="profile-avatar-link" to="/author" title={`查看 ${author.name} 的主页`}><img className="avatar" src={avatar} alt={`${author.name} 的头像`} width="256" height="256" loading="eager" decoding="async" /></Link><div className="profile-name-row"><h2>{author.name}</h2><span className="profile-status" title="正在记录生活" aria-label="正在记录生活" /></div><p>{author.bio || "飞萤之火自无梦的长夜亮起，绽放在终竟的明天。"}</p><div className="profile-rule" aria-hidden="true" /><div className="profile-links"><a href={navigationUrl(author.qqUrl)} title="QQ"><MessageCircle size={18} /></a><a href={navigationUrl(author.githubUrl)} title="GitHub"><Github size={18} /></a><a href={author.email ? `mailto:${author.email}` : "#"} title="Email"><Mail size={18} /></a><a href={navigationUrl(author.rssUrl)} title="RSS"><Rss size={18} /></a>{(author.links ?? []).filter((link) => link.label.trim() && isSafeNavigationUrl(link.url)).map((link) => <a key={link.label + link.url} href={navigationUrl(link.url)} title={link.label} target={/^https?:\/\//u.test(link.url) ? "_blank" : undefined} rel={/^https?:\/\//u.test(link.url) ? "noreferrer" : undefined}><ExternalLink size={18} /></a>)}</div></section>
		{announcement ? <section className="card widget announcement"><WidgetTitle icon={Info}>公告</WidgetTitle><p>{announcement}</p><Link className="widget-more" to="/about">了解更多 <ChevronRight size={14} /></Link></section> : null}
		<div className="sidebar-sticky-section">
			{music ? <section className="card widget music-widget"><WidgetTitle icon={Music2}>音乐</WidgetTitle><ConfiguredMusicPlayer compact /></section> : null}
			<section className="card widget"><WidgetTitle icon={Folder}>分类</WidgetTitle><div className="category-list">{site.categories.map((category) => <Link key={category.slug} to={`/archive?category=${category.slug}`}><span>{category.name}</span><small>{category.postCount}</small></Link>)}</div></section>
			<section className="card widget"><WidgetTitle icon={Tag}>标签</WidgetTitle><div className="tag-cloud">{site.tags.map((tag) => <Link key={tag.slug} to={`/archive?tag=${tag.slug}`}>{tag.name}</Link>)}<Link to="/tags" className="tag-more">更多</Link></div></section>
			{(features.compilerEnabled || features.imageHostingEnabled || features.clipboardEnabled || features.userCenterEnabled) ? <section className="card widget tools-widget"><WidgetTitle icon={Wrench}>小工具</WidgetTitle><div className="tools-widget-links">{features.compilerEnabled ? <Link to="/tools/compiler"><Code2 size={15}/>在线编译器</Link> : null}{features.imageHostingEnabled ? <Link to="/tools/image-host"><Image size={15}/>图床</Link> : null}{features.clipboardEnabled ? <Link to="/tools/clipboard"><Copy size={15}/>在线剪贴板</Link> : null}{features.userCenterEnabled ? <><Link to="/user/center"><UserRound size={15}/>用户中心</Link><Link to="/user/space"><Cloud size={15}/>空间管理</Link></> : null}</div></section> : null}
		</div>
	</aside>;
}

function SiteInfoWidget() {
	const [expanded, setExpanded] = useState(false);
	const site = useSite();
	const runtime = site.runtime;
	const browserLocation: Location | null = typeof window === "undefined" ? null : window.location;
	const siteAddress = browserLocation?.host || "当前站点";
	const startedAt = runtime?.startedAt ? new Date(runtime.startedAt) : null;
	const serviceStartedAt = startedAt && !Number.isNaN(startedAt.getTime())
		? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(startedAt)
		: "运行信息暂不可用";
	const applicationName = runtime?.application.name || "Firefly";
	const applicationVersion = runtime?.application.version || "未获取";
	return <section className="card widget site-info">
		<WidgetTitle icon={Info}>站点信息</WidgetTitle>
		<div className="site-info-rows">
			<div className="site-info-row"><Globe2 size={16} /><span>访问地址</span><strong>{siteAddress}</strong></div>
			<div className="site-info-row"><Rocket size={16} /><span>应用版本</span><strong>{applicationVersion === "unknown" ? "未获取" : `v${applicationVersion}`}</strong></div>
			<div className="site-info-row"><BookOpen size={16} /><span>已发布文章</span><strong>{site.stats.posts}</strong></div>
		</div>
		{expanded ? <>
			<div className="site-info-domain"><Globe2 size={17} /><span>当前访问地址</span><strong>{browserLocation?.origin || siteAddress}</strong></div>
			<div className="site-info-version-grid">
				<div><Rocket size={15} /><span>{applicationName}</span><strong>{applicationVersion === "unknown" ? "未获取" : `v${applicationVersion}`}</strong></div>
				<div><Code2 size={15} /><span>Node.js</span><strong>{runtime?.node || "未获取"}</strong></div>
				<div><Boxes size={15} /><span>文章浏览</span><strong>{site.stats.views}</strong></div>
				<div><Cloud size={15} /><span>服务状态</span><strong>{runtime ? "运行中" : "本地预览"}</strong></div>
			</div>
			<div className="site-info-detail"><CalendarDays size={16} /><span>服务启动时间</span><strong>{serviceStartedAt}</strong></div>
			<div className="site-info-detail"><Boxes size={16} /><span>系统信息</span><strong>{runtime ? `${runtime.platform} / ${runtime.architecture}` : "浏览器本地预览"}</strong></div>
		</> : null}
		<button type="button" className="site-info-toggle" onClick={() => setExpanded((value) => !value)}>
			{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
			{expanded ? "收起构建信息" : "展开构建信息"}
		</button>
	</section>;
}

function UpdateFrequency() {
	const levels = [
		0, 1, 0, 2, 1, 0, 3, 1, 0, 2, 1, 0,
		1, 2, 1, 0, 3, 1, 0, 2, 1, 0, 1, 2,
		0, 1, 3, 2, 1, 0, 2, 1, 0, 1, 2, 0,
		2, 1, 0, 1, 2, 3, 1, 0, 2, 1, 0, 1,
	];
	return <div className="update-frequency" aria-label="文章更新频率">
		<div className="update-frequency-heading"><span>更新频率</span><small>文章发布热力图</small></div>
		<div className="frequency-months" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
		<div className="frequency-grid">{levels.map((level, index) => <span key={index} className={`frequency-cell level-${level}`} title={`${index + 1} 个更新单位`} />)}</div>
		<div className="frequency-legend"><span>少</span><i className="frequency-cell level-0" /><i className="frequency-cell level-1" /><i className="frequency-cell level-2" /><i className="frequency-cell level-3" /><span>多</span></div>
	</div>;
}

type TocItem = { id: string; title: string; depth: number };
function extractToc(content: string): TocItem[] {
	const items: TocItem[] = [];
	const headingPattern = /^(#{2,4})\s+(.+)$/gmu;
	let match: RegExpExecArray | null;
	while ((match = headingPattern.exec(content)) !== null) {
		items.push({ id: `toc-${items.length}`, title: match[2].replace(/[`*_~]/gu, "").trim(), depth: match[1].length });
	}
	return items;
}

function RightSidebar() {
	const site = useSite();
	const location = useLocation();
	const articleSlug = location.pathname.startsWith("/posts/") ? decodeURIComponent(location.pathname.slice("/posts/".length)).replace(/^guide$/u, "guide/index") : "";
	const runningDays = daysSince(site.stats.startDate);
	const [toc, setToc] = useState<TocItem[]>([]);
	useEffect(() => {
		let active = true;
		if (!articleSlug) { setToc([]); return () => { active = false; }; }
		const fallback = fallbackPosts.find((post) => post.slug === articleSlug);
		setToc(extractToc(fallback?.content ?? ""));
		api.post(articleSlug).then((post) => { if (active) setToc(extractToc(post?.content ?? "")); });
		return () => { active = false; };
	}, [articleSlug]);
	return <aside className="sidebar right-sidebar">
		<section className="card widget"><WidgetTitle icon={Quote}>最新动态</WidgetTitle><div className="dynamic-mini">{site.dynamics.slice(0, 2).map((dynamic) => { const image = resolveMediaUrl(dynamic.images?.[0]); return <Link to="/dynamic" key={dynamic.id}><p>{dynamic.body}</p>{image ? <img src={image} alt="" loading="lazy" decoding="async" /> : null}<time>{dateText(dynamic.publishedAt)}</time></Link>; })}<Link className="widget-more" to="/dynamic">更多动态 <ChevronRight size={14} /></Link></div></section>
		<section className="card widget"><WidgetTitle icon={Library}>站点统计</WidgetTitle><div className="site-stats-list"><div><Library size={16} /><span>文章</span><strong>{numberText(site.stats.posts)}</strong></div><div><Folder size={16} /><span>分类</span><strong>{numberText(site.categories.length)}</strong></div><div><Tag size={16} /><span>标签</span><strong>{numberText(site.tags.length)}</strong></div><div><Code2 size={16} /><span>总字数</span><strong>{numberText(site.stats.totalWords)}</strong></div><div><Clock3 size={16} /><span>运行时长</span><strong>{runningDays === null ? (site.stats.posts ? "暂不可用" : "暂无文章") : runningDays > 3650 ? "较早" : `${runningDays} 天`}</strong></div><div><CalendarDays size={16} /><span>最后活动</span><strong>{relativeActivityText(site.stats.lastActivityAt)}</strong></div></div></section>
		<SiteInfoWidget />
		<div className="sidebar-sticky-section">
			{articleSlug ? (toc.length ? <section className="card widget toc-card"><WidgetTitle icon={List}>文章目录</WidgetTitle><nav className="article-toc">{toc.map((item) => <a key={item.id} className={`toc-depth-${item.depth}`} href={`#${item.id}`}>{item.title}</a>)}</nav></section> : null) : <section className="card widget calendar-card"><WidgetTitle icon={CalendarDays}>日历</WidgetTitle><div className="calendar-month"><b>2026 年 8 月</b><div className="calendar-grid">{"日一二三四五六".split("").map((day) => <span key={day}>{day}</span>)}{Array.from({ length: 31 }, (_, index) => <i key={index} className={index === 17 ? "today" : ""}>{index + 1}</i>)}</div></div><UpdateFrequency /></section>}
		</div>
	</aside>;
}

function CategoryBar() {
	const site = useSite();
	return <div className="category-bar"><Link to="/" className="all" title="主页"><Home size={17} /></Link><Link to="/archive" className="category-pill">归档 <small>{site.stats.posts}</small></Link>{site.categories.map((category) => <Link key={category.slug} className="category-pill" to={`/archive?category=${category.slug}`}>{category.name} <small>{category.postCount}</small></Link>)}<Link to="/categories" className="category-more">更多 <ChevronRight size={14} /></Link></div>;
}

function PostCard({ post }: { post: PostSummary }) {
	const cover = resolveMediaUrl(post.cover);
	return <article className={`post-card card ${cover ? "has-cover" : "no-cover"}`}>
		<div className="post-copy">
			<Link to={`/posts/${post.slug}`} className="post-title">{post.title}</Link>
			<div className="post-meta">{post.pinned ? <span className="post-badge"><Pin size={14} />置顶</span> : null}<time><CalendarDays size={14} />{dateText(post.publishedAt)}</time>{post.category ? <Link to={`/archive?category=${post.category.slug}`}><Folder size={14} />{post.category.name}</Link> : null}</div>
			<p className="post-excerpt">{post.excerpt}</p>
			<div className="post-bottom"><div className="post-tags">{post.tags.slice(0, 3).map((tag) => <Link key={tag.slug} to={`/archive?tag=${tag.slug}`}>#{tag.name}</Link>)}</div>{!post.cover ? <span className="reading-meta"><Code2 size={14} />{post.words} 字 <Clock3 size={14} />{post.minutes} 分钟</span> : null}</div>
		</div>
		{cover ? <Link to={`/posts/${post.slug}`} className="post-cover" aria-label={`阅读 ${post.title}`}><img src={cover} alt="" width="960" height="540" loading="lazy" decoding="async" /><span><ChevronRight size={35} /></span></Link> : <Link to={`/posts/${post.slug}`} className="post-enter" title="阅读文章"><ChevronRight size={29} /></Link>}
	</article>;
}

function PostsPanel({ query, category, tag, heading, initialPage = 1 }: { query?: string; category?: string; tag?: string; heading?: string; initialPage?: number }) {
	const [page, setPage] = useState(initialPage);
	const initialResult = fallbackPostsFor({ page: initialPage, category, tag, q: query });
	const [posts, setPosts] = useState<PostSummary[]>(initialResult.items);
	const [total, setTotal] = useState(initialResult.total);
	const [loading, setLoading] = useState(false);
	useEffect(() => { setPage(initialPage); }, [query, category, tag, initialPage]);
	useEffect(() => {
		let active = true;
		const immediate = fallbackPostsFor({ page, category, tag, q: query });
		setPosts(immediate.items);
		setTotal(immediate.total);
		setLoading(false);
		api.posts({ page, category, tag, q: query }).then((result) => { if (active) { setPosts(result.items); setTotal(result.total); setLoading(false); } });
		return () => { active = false; };
	}, [page, query, category, tag]);
	return <section className={`posts-panel ${heading ? "posts-panel-compact" : "posts-panel-home"}`}>
		{heading ? <div className="page-heading compact"><h2>{heading}</h2><span>{total} 篇文章</span></div> : null}
		<div className={`post-list ${heading ? "post-list-compact" : "post-list-home"}`}>{loading ? Array.from({ length: 3 }, (_, index) => <div className="card skeleton" key={index} />) : posts.length ? posts.map((post) => <PostCard post={post} key={post.id} />) : <EmptyState title="没有找到文章" description="换个关键词或筛选条件试试。" />}</div>
		{total > 10 ? <div className="pagination"><button type="button" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>{page}</span><button type="button" disabled={posts.length < 10} onClick={() => setPage((value) => value + 1)}>下一页</button></div> : null}
	</section>;
}

function HomePage() { return <><CategoryBar /><PostsPanel /></>; }

function PageNumberPage() {
	const { page: pageParam } = useParams();
	const page = Math.max(1, Number(pageParam) || 1);
	return <><CategoryBar /><PostsPanel heading={`第 ${page} 页`} initialPage={page} /></>;
}

function ArchivePage() {
	const [search] = useSearchParams();
	const site = useSite();
	const category = search.get("category") ?? undefined;
	const tag = search.get("tag") ?? undefined;
	const title = category ? `${site.categories.find((item) => item.slug === category || item.name === category)?.name ?? category} 下的文章` : tag ? `#${site.tags.find((item) => item.slug === tag || item.name === tag)?.name ?? tag}` : "文章归档";
	return <><CategoryBar /><PostsPanel key={`${category ?? ""}:${tag ?? ""}`} heading={title} category={category} tag={tag} /></>;
}

function SearchPage() { const [search] = useSearchParams(); const term = search.get("q") ?? ""; return <PostsPanel key={term} heading={term ? `搜索：${term}` : "搜索文章"} query={term} />; }

function ArchiveTimelinePage() {
	const [items, setItems] = useState<ArchiveItem[]>(fallbackArchiveItems);
	useEffect(() => {
		let active = true;
		api.archive().then((result) => { if (active) setItems(result); });
		return () => { active = false; };
	}, []);
	const grouped = useMemo(() => items.reduce<Record<number, typeof items>>((result, item) => { (result[item.year] ??= []).push(item); return result; }, {}), [items]);
	return <section className="card content-card timeline"><div className="page-heading"><h2>时间归档</h2><span>按发布时间整理</span></div>{Object.entries(grouped).sort(([a], [b]) => Number(b) - Number(a)).map(([year, posts]) => <div className="timeline-year" key={year}><h3>{year}</h3>{posts.map((post) => <Link key={post.id} to={`/posts/${post.slug}`}><time>{dateText(post.publishedAt)}</time><span>{post.title}</span><small>{post.category}</small></Link>)}</div>)}</section>;
}

function TaxonomyPage({ type }: { type: "categories" | "tags" }) {
	const site = useSite();
	const isCategory = type === "categories";
	return <section className="card content-card"><div className="page-heading"><h2>{isCategory ? "分类" : "标签"}</h2><span>{isCategory ? site.categories.length : site.tags.length} 个{isCategory ? "分类" : "标签"}</span></div>{isCategory ? <div className="taxonomy-grid">{site.categories.map((item) => <Link key={item.slug} to={`/archive?category=${item.slug}`} className="taxonomy-card"><Folder size={22} /><div><strong>{item.name}</strong><p>{item.description}</p></div><small>{item.postCount}</small></Link>)}</div> : <div className="tag-page-cloud">{site.tags.map((item) => <Link key={item.slug} to={`/archive?tag=${item.slug}`} className="tag-page-item"><Tag size={15} />{item.name}<small>{item.postCount}</small></Link>)}</div>}</section>;
}

function Markdown({ content }: { content: string }) { return <Suspense fallback={<div className="markdown-body" aria-busy="true" />}><MarkdownContent content={content} /></Suspense>; }

function PostPage() {
	const params = useParams();
	const routeSlug = (params["*"] ?? "").replace(/^\/+|\/+$/gu, "");
	const slug = routeSlug === "guide" ? "guide/index" : routeSlug;
	const [post, setPost] = useState<Post | null | undefined>(() => fallbackPosts.find((item) => item.slug === slug));
	useEffect(() => { let active = true; setPost(fallbackPosts.find((item) => item.slug === slug)); api.post(slug).then((result) => { if (active) setPost(result); }); return () => { active = false; }; }, [slug]);
	if (post === undefined) return <div className="card loading-card">正在载入文章...</div>;
	if (!post) return <EmptyState title="文章不存在" description="它可能已被移动或暂时不可访问。" />;
	const cover = resolveMediaUrl(post.topImage || post.cover);
	return <article className="card article-card"><header className="article-header"><h1>{post.title}</h1><div className="article-meta"><time><CalendarDays size={15} />发布于 {dateText(post.publishedAt)}</time><span><Code2 size={15} />{post.words} 字</span><span><Clock3 size={15} />{post.minutes} 分钟</span><span><BookOpen size={15} />{post.views} 阅读</span></div>{cover ? <img className="article-cover" src={cover} alt="" width="1200" height="675" loading="eager" decoding="async" /> : null}</header><Markdown content={post.content} /><footer className="article-footer"><div className="post-tags">{post.tags.map((tag) => <Link key={tag.slug} to={`/archive?tag=${tag.slug}`}>#{tag.name}</Link>)}</div><div className="license"><Info size={18} /><span>本文采用 CC BY-NC-SA 4.0 协议，转载请注明出处。</span></div></footer><Comments postId={post.id} /></article>;
}

function StaticPage({ title, children }: { title: string; children: ReactNode }) { return <section className="card content-card"><div className="page-heading"><h2>{title}</h2></div><div className="static-content">{children}</div></section>; }

function AuthorProfileRoute() { return <AuthorProfilePage site={useSite()} />; }

function AboutPage() {
	const site = useSite();
	const author = site.author ?? fallbackSite.author!;
	const avatar = resolveMediaUrl(author.avatar || fallbackSite.author?.avatar || "/images/avatar.avif");
	return <StaticPage title="关于我"><div className="about-intro about-intro-wide"><img src={avatar} alt={author.name + " 的头像"} width="96" height="96" loading="lazy" decoding="async" /><div><h3>关于我 / About Me</h3><p>你好！我是 <strong>{author.name}</strong>，{author.bio || "一个在数字世界中记录生活与思考的人。"}</p><p className="about-signature">{site.subtitle || "愿每一颗心，都能免于哀伤。"}</p></div></div><Markdown content={"### 🛠️ 关于本站\n\n这个网站使用 React、Express 和 MySQL 构建，视觉上延续 Firefly 模板的清新布局。Firefly 是一款基于 Astro 和 Fuwari 二次开发的个人博客主题，专为技术爱好者和内容创作者设计。\n\n- 在线预览：[Firefly Demo](https://firefly.cuteleaf.cn/)\n- 我的博客：[blog.cuteleaf.cn](https://blog.cuteleaf.cn/)\n- 使用文档：[Firefly Docs](https://docs.firefly.cuteleaf.cn/)\n- 开源地址：[CuteLeaf/Firefly](https://github.com/CuteLeaf/Firefly)\n\n### 现在正在做的事\n\n- 让内容从 Markdown 顺利迁移到 MySQL\n- 持续打磨长文章的阅读体验\n- 收集值得反复访问的链接\n\n感谢你的来访！希望在这里能找到对你有用的内容！"} /></StaticPage>;
}

function FriendsPage() { const friends = [{ name: "夏夜流萤", text: "飞萤之火自无梦的长夜亮起，绽放在终竟的明天。", group: "Blog", href: "https://blog.cuteleaf.cn/" }, { name: "Firefly Docs", text: "Firefly 主题模板文档", group: "Docs", href: "https://docs.firefly.cuteleaf.cn/" }, { name: "Astro", text: "The web framework for content-driven websites. ⭐️", group: "Framework", href: "https://astro.build/" }]; return <StaticPage title="友链"><p className="page-lead">这里是我的朋友们，欢迎互相访问交流</p><div className="friend-filter" aria-label="友链分类"><button type="button" className="selected">全部</button><button type="button">Blog</button><button type="button">Docs</button><button type="button">Framework</button></div><div className="friend-grid friend-grid-rich">{friends.map((friend, index) => <a key={friend.name} className="friend-card" href={friend.href} target="_blank" rel="noreferrer"><span className="friend-avatar">{index === 0 ? "夏" : index === 1 ? "F" : "A"}</span><div><strong>{friend.name}</strong><p>{friend.text}</p><small>{friend.group}</small></div><ChevronRight size={19} /></a>)}</div><div className="friend-apply"><h3>申请友链</h3><ol><li>请先在您的网站友链页面添加本站信息</li><li>评论区留言或发送申请邮件至 <a href="mailto:xiaye@msn.com">xiaye@msn.com</a></li><li>确认信息无误后会尽快添加您的友链</li></ol><p className="friend-note">互换原则：请先将本站添加到您的友链页面；站点需支持 HTTPS、能够正常访问并保持更新。</p></div></StaticPage>; }

function GuestbookPage() { return <StaticPage title="留言"><p className="page-lead">欢迎在这里留下你的足迹，分享你的想法和建议。</p><div className="guestbook-guidelines"><p>请保持友善和尊重，营造良好的交流氛围</p><p>欢迎分享你的想法，也可以提出对网站的建议</p><p>你的每一条留言都是对我最大的支持 ✨</p></div><div className="guestbook-disabled"><MessageCircle size={25} /><strong>评论系统暂未配置</strong><span>您还未在配置文件中启用评论系统，启用后访客才可在此留言</span></div><div className="guestbook-form"><input placeholder="昵称" aria-label="昵称" /><textarea placeholder="写下留言..." aria-label="留言内容" rows={5} /><button type="button"><Send size={16} />发送留言</button></div></StaticPage>; }

const managedPageFallbacks: Record<ManagedPageKey, ManagedPage> = {
	about: {
		page: "about",
		title: "关于",
		content: "### 关于本站\n\n这里记录站点的来历、正在进行的事情，以及值得分享的内容。页面正文由后台 Markdown 内容管理。\n\n感谢你的来访！",
	},
	transfer: {
		page: "transfer",
		title: "传送",
		content: "### 传送\n\n这里整理常用的外部入口与协作站点。友情链接会显示在正文下方。",
		friendLinksIntro: "欢迎通过这些入口访问朋友们的站点。",
		friendLinks: [
			{ name: "Firefly 文档", url: "https://docs.firefly.cuteleaf.cn/", description: "Firefly 主题使用文档" },
			{ name: "CuteLeaf", url: "https://github.com/CuteLeaf/Firefly", description: "开源项目主页" },
		],
	},
	issues: {
		page: "issues",
		title: "问题总结",
		content: "### 问题总结\n\n这里汇总站点使用过程中遇到的问题、处理方式和后续计划。正文支持完整 Markdown。",
	},
};

function ManagedPageView({ page }: { page: ManagedPageKey }) {
	const fallback = managedPageFallbacks[page];
	const [data, setData] = useState<ManagedPage>(fallback);
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		let active = true;
		setData(fallback);
		setLoading(true);
		api.page(page).then((result) => {
			if (active && result) setData({ ...fallback, ...result, friendLinks: result.friendLinks ?? fallback.friendLinks });
		}).finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [page, fallback]);
	const links: ManagedFriendLink[] = page === "transfer" ? (data.friendLinks ?? []).filter((link) => isSafeNavigationUrl(link.url)) : [];
	return <section className={"card content-card managed-page managed-page-" + page}>
		<div className="page-heading"><h2>{data.title || fallback.title}</h2>{loading ? <span>正在加载</span> : data.updatedAt ? <span>更新于 {dateText(data.updatedAt)}</span> : null}</div>
		<div className="static-content"><Markdown content={data.content || fallback.content} />
			{page === "transfer" ? <section className="transfer-links-section"><div className="transfer-links-heading"><h3>友情链接</h3>{data.friendLinksIntro ? <p>{data.friendLinksIntro}</p> : null}</div>{links.length ? <div className="transfer-links-grid">{links.map((link, index) => { const logo = resolveMediaUrl(link.logo); const external = /^https?:\/\//u.test(link.url); return <a className="transfer-link-card" href={link.url} key={link.name + "-" + link.url + "-" + index} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined}>{logo && isSafeResourceUrl(logo) ? <img src={logo} alt="" width="48" height="48" loading="lazy" decoding="async" /> : <span className="transfer-link-avatar">{link.name.slice(0, 1)}</span>}<span className="transfer-link-copy"><strong>{link.name}</strong>{link.description ? <small>{link.description}</small> : null}<em>{link.url}</em></span><ChevronRight size={17} /></a>; })}</div> : <p className="transfer-links-empty">暂时还没有配置友情链接。</p>}</section> : null}
		</div>
	</section>;
}

function AboutContentPage() { return <ManagedPageView page="about" />; }
function TransferPage() { return <ManagedPageView page="transfer" />; }
function IssuesPage() { return <ManagedPageView page="issues" />; }

function FeedbackPage() {
	const [enabled, setEnabled] = useState(true);
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [message, setMessage] = useState("");
	const [form, setForm] = useState({ category: "bug", subject: "", content: "", contact: "" });
	useEffect(() => { let active = true; api.feedbackSettings().then((settings) => { if (active) setEnabled(settings.enabled); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!form.subject.trim() || !form.content.trim()) { setMessage("请填写反馈主题和问题描述。"); return; }
		setSubmitting(true); setMessage("");
		try {
			await api.submitFeedback({ ...form, subject: form.subject.trim(), content: form.content.trim(), contact: form.contact.trim(), pageUrl: window.location.href });
			setMessage("反馈已提交，感谢你的建议。");
			setForm({ category: "bug", subject: "", content: "", contact: "" });
		} catch (error) { setMessage(error instanceof Error ? error.message : "反馈提交失败，请稍后重试。"); } finally { setSubmitting(false); }
	};
	return <section className="card content-card feedback-page"><div className="page-heading"><h2>问题反馈</h2><span>FEEDBACK</span></div>{loading ? <p className="page-lead">正在检查反馈入口...</p> : !enabled ? <div className="feedback-disabled"><MessageCircle size={24} /><strong>反馈入口暂未开放</strong><span>管理员尚未开启问题反馈。</span></div> : <form className="feedback-form" onSubmit={submit}><label>问题类型<select value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}><option value="bug">页面问题</option><option value="content">内容问题</option><option value="suggestion">功能建议</option><option value="other">其他</option></select></label><label>反馈主题<input value={form.subject} maxLength={160} required placeholder="简要说明遇到的问题" onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))} /></label><label>问题描述<textarea value={form.content} maxLength={5000} rows={7} required placeholder="请描述出现问题时的页面、操作和结果" onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} /></label><label>联系方式（选填）<input value={form.contact} maxLength={254} placeholder="邮箱、QQ 或其他联系方式" onChange={(event) => setForm((current) => ({ ...current, contact: event.target.value }))} /></label>{message ? <p className="feedback-message" role="status">{message}</p> : null}<button className="feedback-submit" type="submit" disabled={submitting}>{submitting ? "提交中..." : "提交反馈"}</button></form>}</section>;
}

function ChangelogPage() {
	const [entries, setEntries] = useState<ChangelogEntry[]>([]);
	const [loading, setLoading] = useState(true);
	useEffect(() => { let active = true; api.changelogs(100).then((result) => { if (active) setEntries(result.filter((entry) => entry.published !== false)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
	return <section className="card content-card changelog-page"><div className="changelog-heading"><span className="changelog-eyebrow">RELEASE NOTES</span><h2>更新日志</h2><p>记录博客功能、体验与维护内容的每一次变化。</p></div>{loading ? <div className="changelog-state">正在加载更新日志...</div> : entries.length ? <div className="changelog-timeline">{entries.map((entry, index) => <article className="changelog-entry" key={entry.fileName || entry.slug || entry.title + "-" + index}><div className="changelog-marker" aria-hidden="true" /><div className="changelog-entry-head"><div>{entry.version ? <span className="changelog-version">{entry.version}</span> : null}<h3>{entry.title}</h3></div>{entry.date ? <time>{dateText(entry.date)}</time> : null}</div><Markdown content={entry.content} /></article>)}</div> : <div className="changelog-state">暂时还没有已发布的更新日志。</div>}</section>;
}

function DynamicPage() {
	const site = useSite();
	const author = site.author ?? fallbackSite.author!;
	const avatar = resolveMediaUrl(author.avatar || fallbackSite.author?.avatar || "/images/avatar.avif");
	const entries = site.dynamics ?? [];
	const [selectedImage, setSelectedImage] = useState<string | null>(null);
	useEffect(() => {
		if (!selectedImage) return;
		const listener = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedImage(null); };
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [selectedImage]);
	return <section className="dynamic-page">
		<div className="card content-card dynamic-heading"><div className="page-heading"><h2>动态</h2><span>{entries.length} 条动态</span></div><p className="page-lead">随手记下此刻的想法与日常。</p><div className="dynamic-filters"><button type="button" className="selected">全部年份</button></div></div>
		<div className="dynamic-feed">
			{entries.length ? entries.map((dynamic) => {
				const images = (dynamic.images ?? []).map((image) => resolveMediaUrl(image)).filter(Boolean).slice(0, 9);
				return <article className="card dynamic-item" key={dynamic.id}>
					<Link className="dynamic-author-link" to="/author" title={`查看 ${author.name} 的主页`}><img src={avatar} alt={`${author.name} 的头像`} width="42" height="42" loading="lazy" decoding="async" /></Link>
					<div><header><strong>{author.name}</strong><time>{dateText(dynamic.publishedAt)} UTC+8</time></header><Markdown content={dynamic.body} />
						{images.length ? <div className="dynamic-image-grid" data-count={images.length}>{images.map((image, index) => <button type="button" className="dynamic-image" key={`${dynamic.id}-${image}-${index}`} title="查看图片" onClick={() => setSelectedImage(image)}><img src={image} alt={`${author.name} 的动态图片 ${index + 1}`} loading="lazy" decoding="async" /></button>)}</div> : null}
						<div className="dynamic-actions"><button type="button" title="回复"><MessageCircle size={16} />评论</button><button type="button" title="喜欢"><Heart size={16} />喜欢</button></div>
					</div>
				</article>;
			}) : <div className="card dynamic-empty"><Quote size={28} /><strong>还没有动态</strong><span>后台发布的生活记录会显示在这里。</span></div>}
		</div>
		{selectedImage ? <div className="dynamic-image-viewer" role="dialog" aria-modal="true" aria-label="查看动态图片" onClick={() => setSelectedImage(null)}><button type="button" className="dynamic-image-close" title="关闭图片" aria-label="关闭图片" onClick={() => setSelectedImage(null)}><X size={21} /></button><img src={selectedImage} alt="动态图片预览" onClick={(event) => event.stopPropagation()} /></div> : null}
	</section>;
}

function GalleryPage() {
	const photos = [
		{ src: "/images/posts/1.avif", width: 2192, height: 1233 },
		{ src: "/images/posts/firefly3.avif", width: 3840, height: 2160 },
		{ src: "/images/posts/both-list.avif", width: 2192, height: 1233 },
		{ src: "/images/posts/right-grid2.avif", width: 2192, height: 1233 },
		{ src: "/images/posts/left-grid3.avif", width: 2192, height: 1233 },
		{ src: "/images/posts/masonry.avif", width: 2192, height: 1233 },
	];

	return <StaticPage title="相册"><p className="page-lead">记录生活中的美好瞬间</p><div className="gallery-tabs"><button type="button" className="selected">全部</button><button type="button">加密相册</button><button type="button">崩坏星穹铁道</button><button type="button">流萤</button></div><div className="gallery-grid">{photos.map((photo, index) => <button type="button" className="gallery-item" title={`查看照片 ${index + 1}`} key={photo.src}><img src={photo.src} alt={`相册照片 ${index + 1}`} width={photo.width} height={photo.height} loading="lazy" decoding="async" /><span className="gallery-caption">{index === 0 ? "可爱流萤" : index === 1 ? "崩坏：星穹铁道" : "Firefly 主题记录"}</span></button>)}</div><div className="album-summary"><strong>可爱流萤</strong><span>飞萤之火自无梦的长夜亮起，绽放在终竟的明天。</span><time>2026-01-01 · 9 张照片</time></div></StaticPage>;
}

function BooknavPage() { const groups = [{ title: "开发", description: "写代码时离不开的站点", items: [{ name: "GitHub", text: "全球最大的代码托管平台", href: "https://github.com/" }, { name: "MDN Web Docs", text: "最权威的 Web 技术文档", href: "https://developer.mozilla.org/" }, { name: "Astro", text: "内容驱动型网站的 Web 框架", href: "https://astro.build/" }, { name: "Svelte", text: "把组件编译成高效原生 JS 的框架", href: "https://svelte.dev/" }, { name: "Tailwind CSS", text: "一个功能强大且灵活的 CSS 框架", href: "https://tailwindcss.com/" }] }, { title: "项目", description: "好用的开源项目", items: [{ name: "Firefly", text: "清晰美观的 Astro 个人博客主题模板", href: "https://github.com/CuteLeaf/Firefly" }] }, { title: "设计", description: "配色、图标与灵感来源", items: [{ name: "Iconify", text: "海量开源图标集合搜索", href: "https://icon-sets.iconify.design/" }, { name: "iconfont", text: "阿里巴巴矢量图标库", href: "https://www.iconfont.cn/" }] }, { title: "工具", description: "顺手的在线小工具", items: [{ name: "TinyPNG", text: "在线压缩 PNG / JPEG 图片", href: "https://tinypng.com/" }, { name: "Squoosh", text: "Google 出品的图片压缩与格式转换", href: "https://squoosh.app/" }, { name: "Carbon", text: "把代码片段生成漂亮的图片", href: "https://carbon.now.sh/" }] }, { title: "资源", description: "文档、教程与阅读", items: [{ name: "Firefly Docs", text: "Firefly 主题模板文档", href: "https://docs.firefly.cuteleaf.cn/" }, { name: "夏夜流萤", text: "飞萤之火自无梦的长夜亮起", href: "https://blog.cuteleaf.cn/" }] }]; return <StaticPage title="书签导航"><p className="page-lead">收藏一些好用的网站，按分类整理</p><div className="bookmark-summary">{groups.map((group) => <span key={group.title}><strong>{group.items.length}</strong>{group.title}</span>)}</div><div className="bookmark-groups bookmark-groups-rich">{groups.map((group) => <section key={group.title}><h3>{group.title}</h3><p>{group.description}</p><div>{group.items.map((item) => <a href={item.href} key={item.name} target="_blank" rel="noreferrer"><span>{item.name.slice(0, 1)}</span><div><strong>{item.name}</strong><small>{item.text}</small></div><ChevronRight size={16} /></a>)}</div></section>)}</div></StaticPage>; }

function SponsorPage() { return <StaticPage title="打赏支持"><p className="page-lead">如果我的内容对你有帮助，欢迎通过以下方式打赏我，你的支持是我持续创作的动力！</p><p>您的打赏将用于服务器维护、内容创作和功能开发，帮助我持续提供优质内容。</p><div className="sponsor-options sponsor-options-rich"><a href="https://www.alipay.com/" target="_blank" rel="noreferrer"><img src="/assets/images/sponsor/alipay.png" alt="支付宝" width="80" height="80" /><span><strong>支付宝</strong><small>使用支付宝扫码打赏</small></span></a><a href="https://pay.weixin.qq.com/" target="_blank" rel="noreferrer"><img src="/assets/images/sponsor/wechat.png" alt="微信" width="80" height="80" /><span><strong>微信</strong><small>使用微信扫码打赏</small></span></a><a href="https://ko-fi.com/" target="_blank" rel="noreferrer"><span className="sponsor-icon">☕</span><span><strong>ko-fi</strong><small>Buy a Coffee for Firefly</small></span></a><a href="https://afdian.com/" target="_blank" rel="noreferrer"><span className="sponsor-icon">❤</span><span><strong>爱发电</strong><small>通过爱发电进行打赏</small></span></a></div><div className="supporters"><WidgetTitle icon={Heart}>打赏列表</WidgetTitle><div className="supporter-list"><div><strong>夏叶</strong><b>¥50</b><small>2025-10-01</small></div><div><strong>匿名用户</strong><b>¥20</b><small>2025-10-01</small></div></div></div></StaticPage>; }

function RssPage() { return <StaticPage title="RSS"><p>订阅 Firefly，随时获取新文章。</p><a className="rss-link" href="/api/rss.xml"><Rss size={20} />打开 RSS 订阅地址</a></StaticPage>; }

function EmptyState({ title, description }: { title: string; description: string }) { return <section className="card empty-state"><Search size={29} /><h2>{title}</h2><p>{description}</p><Link to="/">返回首页</Link></section>; }

function ScrollTop() { const [visible, setVisible] = useState(false); useEffect(() => { const listener = () => setVisible(window.scrollY > 400); window.addEventListener("scroll", listener, { passive: true }); return () => window.removeEventListener("scroll", listener); }, []); if (!visible) return null; return <button className="scroll-top" type="button" title="回到顶部" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><ArrowUp size={20} /></button>; }

function prefersReducedMotion() {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function withInstantScroll(run: () => void) {
	const html = document.documentElement;
	const previous = html.style.scrollBehavior;
	html.style.scrollBehavior = "auto";
	run();
	html.style.scrollBehavior = previous;
}

function scrollToMainContent(smooth: boolean) {
	const content = document.getElementById("content");
	if (!content) return;
	const useSmooth = smooth && !prefersReducedMotion();
	if (!useSmooth) {
		withInstantScroll(() => content.scrollIntoView({ behavior: "auto", block: "start" }));
		return;
	}
	content.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToPageTop(smooth: boolean) {
	const useSmooth = smooth && !prefersReducedMotion();
	if (!useSmooth) {
		withInstantScroll(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
		return;
	}
	window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
}

function revealPageForPath(pathname: string, wallpaper: string, smooth: boolean) {
	const isHome = pathname === "/";
	if (wallpaper === "full" || wallpaper === "banner") {
		if (isHome) scrollToPageTop(smooth);
		else scrollToMainContent(smooth);
		return;
	}
	if (!isHome) scrollToPageTop(smooth);
}

function WallpaperNavigationScroll({ wallpaper }: { wallpaper: string }) {
	const location = useLocation();
	const wallpaperRef = useRef(wallpaper);
	const previousPathRef = useRef<string | null>(null);
	wallpaperRef.current = wallpaper;

	useEffect(() => {
		if ("scrollRestoration" in history) history.scrollRestoration = "manual";
	}, []);

	useEffect(() => {
		const path = location.pathname;
		const previousPath = previousPathRef.current;
		previousPathRef.current = path;
		const isFirstLoad = previousPath === null;
		if (!isFirstLoad && previousPath === path) return;

		const frame = window.requestAnimationFrame(() => {
			revealPageForPath(path, wallpaperRef.current, !isFirstLoad);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [location.pathname]);

	return null;
}

function faviconMimeType(source: string): string {
	const pathname = source.split(/[?#]/u, 1)[0].toLowerCase();
	if (pathname.endsWith(".ico")) return "image/x-icon";
	if (pathname.endsWith(".svg")) return "image/svg+xml";
	if (pathname.endsWith(".webp")) return "image/webp";
	if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
	if (pathname.endsWith(".gif")) return "image/gif";
	return "image/png";
}










function SiteShell() {
	const [site, setSite] = useState<SiteData>(fallbackSite);
	const [dark, setDark] = useState(() => localStorage.getItem("firefly-theme") === "dark" || (!localStorage.getItem("firefly-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches));
	const [wallpaper, setWallpaperState] = useState(() => localStorage.getItem("firefly-wallpaper") ?? "banner");
	const [hue, setHueState] = useState(() => Number(localStorage.getItem("firefly-hue") ?? 165));
	const [layout, setLayout] = useState<"list" | "grid">(() => (localStorage.getItem("firefly-layout") as "list" | "grid") ?? "list");
	const [cardBorder, setCardBorder] = useState(() => localStorage.getItem("firefly-card-border") === "true");
	const [cardFollowTheme, setCardFollowTheme] = useState(() => localStorage.getItem("firefly-card-theme") === "true");
	const [bannerTitle, setBannerTitle] = useState(() => localStorage.getItem("firefly-banner-title") !== "false");
	const [carousel, setCarousel] = useState(() => localStorage.getItem("firefly-carousel") === "true");
	const [wavesEnabled, setWavesEnabled] = useState(() => localStorage.getItem("firefly-waves") !== "false");
	const [gradientEnabled, setGradientEnabled] = useState(() => localStorage.getItem("firefly-gradient") !== "false");
	const [sakuraEnabled, setSakuraEnabled] = useState(() => localStorage.getItem("firefly-sakura") === "true");
	const [overlayOpacity, setOverlayOpacity] = useState(() => Number(localStorage.getItem("firefly-overlay-opacity") ?? 80));
	const [overlayBlur, setOverlayBlur] = useState(() => Number(localStorage.getItem("firefly-overlay-blur") ?? 10));
	const [overlayCardOpacity, setOverlayCardOpacity] = useState(() => Number(localStorage.getItem("firefly-overlay-card-opacity") ?? 50));
	useEffect(() => {
		let active = true;
		const refreshSite = () => { api.site().then((result) => { if (active) setSite(result); }); };
		refreshSite();
		const retryTimer = window.setInterval(refreshSite, 30_000);
		return () => { active = false; window.clearInterval(retryTimer); };
	}, []);
	useEffect(() => {
		const favicon = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
		if (!favicon) return;

		const defaultHref = favicon.dataset.defaultHref || "/images/logo/firefly-light.png";
		const defaultType = favicon.dataset.defaultType || "image/png";
		const source = resolveMediaUrl(site.siteFavicon);
		if (!isSafeResourceUrl(source)) {
			favicon.href = defaultHref;
			favicon.type = defaultType;
			return;
		}

		favicon.href = source;
		favicon.type = faviconMimeType(source);
	}, [site.siteFavicon]);
	useEffect(() => {
		const styleId = "firefly-configured-fonts";
		document.getElementById(styleId)?.remove();
		const config = site.titleConfig ?? {};
		const rules = configuredFontDefinitions.map((item) => {
			const source = resolveMediaUrl(config[item.key]);
			if (!isSafeResourceUrl(source)) return "";
			const safeSource = source.replace(/["'\\\r\n]/gu, "");
			return `@font-face{font-family:"${item.family}";src:url("${safeSource}");font-display:swap;}`;
		}).filter(Boolean).join("");
		if (!rules) return undefined;
		const style = document.createElement("style");
		style.id = styleId;
		style.textContent = rules;
		document.head.appendChild(style);
		return () => style.remove();
	}, [site.titleConfig]);
	useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("firefly-theme", dark ? "dark" : "light"); }, [dark]);
	useEffect(() => { document.documentElement.style.setProperty("--hue", String(hue)); localStorage.setItem("firefly-hue", String(hue)); }, [hue]);
	useEffect(() => { document.documentElement.dataset.wallpaper = wallpaper; localStorage.setItem("firefly-wallpaper", wallpaper); }, [wallpaper]);
	useEffect(() => { localStorage.setItem("firefly-layout", layout); }, [layout]);
	useEffect(() => { localStorage.setItem("firefly-card-border", String(cardBorder)); }, [cardBorder]);
	useEffect(() => { localStorage.setItem("firefly-card-theme", String(cardFollowTheme)); }, [cardFollowTheme]);
	useEffect(() => { localStorage.setItem("firefly-banner-title", String(bannerTitle)); }, [bannerTitle]);
	useEffect(() => { localStorage.setItem("firefly-carousel", String(carousel)); }, [carousel]);
	useEffect(() => { localStorage.setItem("firefly-waves", String(wavesEnabled)); }, [wavesEnabled]);
	useEffect(() => { localStorage.setItem("firefly-gradient", String(gradientEnabled)); }, [gradientEnabled]);
	useEffect(() => { localStorage.setItem("firefly-sakura", String(sakuraEnabled)); }, [sakuraEnabled]);
	useEffect(() => { localStorage.setItem("firefly-overlay-opacity", String(overlayOpacity)); }, [overlayOpacity]);
	useEffect(() => { localStorage.setItem("firefly-overlay-blur", String(overlayBlur)); }, [overlayBlur]);
	useEffect(() => { localStorage.setItem("firefly-overlay-card-opacity", String(overlayCardOpacity)); }, [overlayCardOpacity]);
	const displaySettings: DisplaySettingsProps = { hue, setHue: setHueState, wallpaper, setWallpaper: setWallpaperState, layout, setLayout, cardBorder, setCardBorder, cardFollowTheme, setCardFollowTheme, bannerTitle, setBannerTitle, carousel, setCarousel, wavesEnabled, setWavesEnabled, gradientEnabled, setGradientEnabled, sakuraEnabled, setSakuraEnabled, overlayOpacity, setOverlayOpacity, overlayBlur, setOverlayBlur, overlayCardOpacity, setOverlayCardOpacity };
	const shellClasses = [`site-shell wallpaper-${wallpaper}`, `post-layout-${layout}`, cardBorder ? "card-enhanced" : "", cardFollowTheme ? "card-follow-theme" : "", gradientEnabled ? "gradient-enabled" : "gradient-disabled"].filter(Boolean).join(" ");
	const systemFontStack = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
	const fontVars: Record<string, string> = {};
	for (const item of configuredFontDefinitions) {
		const source = resolveMediaUrl(site.titleConfig?.[item.key]);
		fontVars[item.variable] = isSafeResourceUrl(source) ? `"${item.family}", ${item.key === "bodyFontUrl" ? systemFontStack : "var(--site-body-font)"}` : item.key === "bodyFontUrl" ? systemFontStack : "var(--site-body-font)";
	}
	fontVars["--font-hero-title"] = fontVars["--site-title-font"];
	fontVars["--font-hero-subtitle"] = fontVars["--site-subtitle-font"];
	fontVars["--font-post-title"] = fontVars["--site-post-title-font"];
	fontVars["--font-body"] = fontVars["--site-body-font"];
	fontVars["--font-post-content"] = fontVars["--site-post-content-font"];
	fontVars["--font-tag"] = fontVars["--site-tag-font"];
	const shellStyle = { "--overlay-opacity": overlayOpacity / 100, "--overlay-blur": `${overlayBlur}px`, "--overlay-card-opacity": overlayCardOpacity / 100, ...fontVars } as CSSProperties;
	return <SiteContext.Provider value={site}><MusicPlaybackProvider><div className={shellClasses} style={shellStyle}><Header dark={dark} setDark={setDark} wallpaper={wallpaper} setWallpaper={setWallpaperState} settings={displaySettings} /><Hero wallpaper={wallpaper} showTitle={bannerTitle} carousel={carousel} wavesEnabled={wavesEnabled} gradientEnabled={gradientEnabled} />{sakuraEnabled ? <SakuraEffect /> : null}<main id="content" className="site-grid"><LeftSidebar /><div className="main-column"><Outlet context={site} /></div><RightSidebar /></main><footer className="site-footer"><span>界面风格参考 <a href="https://github.com/CuteLeaf/Firefly" target="_blank" rel="noreferrer">Firefly</a>（MIT）</span><a href="/rss.xml">RSS</a><a href="/sitemap.xml">Sitemap</a></footer><ScrollTop /><WallpaperNavigationScroll wallpaper={wallpaper} /></div></MusicPlaybackProvider></SiteContext.Provider>;
}

export default function App() { return <AuthProvider><Routes><Route path="/admin/*" element={<AdminWorkspace />} /><Route element={<SiteShell />}><Route path="/" element={<HomePage />} /><Route path="/tools/compiler" element={<CompilerPage />} /><Route path="/tools/image-host" element={<ImageHostPage />} /><Route path="/tools/clipboard" element={<ClipboardPage />} /><Route path="/user/center" element={<UserProfilePage />} /><Route path="/user/space" element={<UserSpacePage />} /><Route path="/page/:page" element={<PageNumberPage />} /><Route path="/archive" element={<ArchivePage />} /><Route path="/timeline" element={<ArchiveTimelinePage />} /><Route path="/archive/timeline" element={<ArchiveTimelinePage />} /><Route path="/categories" element={<TaxonomyPage type="categories" />} /><Route path="/tags" element={<TaxonomyPage type="tags" />} /><Route path="/search" element={<SearchPage />} /><Route path="/posts/*" element={<PostPage />} /><Route path="/author" element={<AuthorProfileRoute />} /><Route path="/about" element={<AboutContentPage />} /><Route path="/transfer" element={<TransferPage />} /><Route path="/friends" element={<TransferPage />} /><Route path="/issues" element={<IssuesPage />} /><Route path="/feedback" element={<FeedbackPage />} /><Route path="/changelog" element={<ChangelogPage />} /><Route path="/guestbook" element={<GuestbookPage />} /><Route path="/dynamic" element={<DynamicPage />} /><Route path="/dynamic/comments" element={<DynamicPage />} /><Route path="/gallery" element={<GalleryPage />} /><Route path="/gallery/:album" element={<GalleryPage />} /><Route path="/booknav" element={<BooknavPage />} /><Route path="/sponsor" element={<SponsorPage />} /><Route path="/rss" element={<RssPage />} /><Route path="/rss.xml" element={<RssPage />} /><Route path="/404" element={<EmptyState title="页面不存在" description="这个地址没有对应的页面。" />} /><Route path="*" element={<EmptyState title="页面不存在" description="这个地址没有对应的页面。" />} /></Route></Routes></AuthProvider>; }
