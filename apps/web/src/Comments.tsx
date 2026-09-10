import { ChevronDown, ChevronUp, ImagePlus, LoaderCircle, MessageCircle, Send, Smile, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import MarkdownContent from "./MarkdownContent";
import { api } from "./api";
import { useAuth, UserAvatar } from "./auth";
import MdEditorBridge from "./admin/MdEditorBridge";
import { resolveMediaUrl } from "./media";
import type { CommentRecord, EmojiSticker, PublicUser } from "./types";

type CommentsProps = { postId: number };

function commentAuthor(comment: CommentRecord): PublicUser {
	const author: PublicUser = comment.author ?? { id: comment.id };
	return { id: author.id ?? comment.id, username: author.username, nickname: author.nickname ?? comment.authorName, displayName: author.displayName ?? comment.authorName, avatar: author.avatar ?? comment.avatar, isAdmin: author.isAdmin ?? comment.isAdmin, badge: author.badge ?? comment.badge };
}

function flattenComments(items: CommentRecord[]): CommentRecord[] {
	return items.flatMap((item) => [item, ...flattenComments(item.children ?? item.replies ?? [])]);
}

export default function Comments({ postId }: CommentsProps) {
	const { user, settings, features, openAuth } = useAuth();
	const [comments, setComments] = useState<CommentRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [refreshKey, setRefreshKey] = useState(0);
	const [replyTo, setReplyTo] = useState<CommentRecord | null>(null);
	const [body, setBody] = useState("");
	const [anonymousName, setAnonymousName] = useState("");
	const [anonymousAvatar, setAnonymousAvatar] = useState("");
	const [preview, setPreview] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [uploadedImages, setUploadedImages] = useState<string[]>([]);
	const [stickers, setStickers] = useState<EmojiSticker[]>([]);
	const [stickersOpen, setStickersOpen] = useState(false);
	const editorUploads = useRef(0);
	const imageInput = useRef<HTMLInputElement>(null);
	const stickerInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		let active = true;
		setLoading(true);
		api.comments(postId).then((result) => { if (active) { setComments(result); setLoading(false); } }).catch(() => { if (active) { setError("评论加载失败"); setLoading(false); } });
		return () => { active = false; };
	}, [postId, refreshKey]);
	useEffect(() => {
		if (!user || !features.commentsEnabled || !features.userCenterEnabled) { setStickers([]); return; }
		void Promise.all([api.emojis(), api.userStickers()]).then(([shared, own]) => setStickers([...shared, ...own]));
	}, [features.commentsEnabled, features.userCenterEnabled, user]);
	const totalCount = useMemo(() => flattenComments(comments).length, [comments]);
	const canComment = settings.commentsEnabled && features.commentsEnabled;
	const requiresLogin = !settings.allowAnonymous && !user;
	const displayName = user?.nickname || user?.displayName || user?.username || "用户";
	const uploadImage = async (file: File) => {
		if (!features.imageHostingEnabled) throw new Error("图片上传功能当前已关闭");
		if (!file.type.startsWith("image/")) throw new Error("评论图片必须是图片文件");
		if (file.size > 5 * 1024 * 1024) throw new Error("每张评论图片不能超过 5MB");
		if (editorUploads.current + uploadedImages.length >= 3) throw new Error("每条评论最多上传 3 张图片");
		editorUploads.current += 1;
		try {
			const url = await api.uploadCommentImage(file);
			setUploadedImages((items) => [...items, url].slice(0, 3));
			return url;
		} finally { editorUploads.current = Math.max(0, editorUploads.current - 1); }
	};
	const addImage = async (file: File | undefined) => {
		if (!file) return;
		try { await uploadImage(file); } catch (reason) { setError(reason instanceof Error ? reason.message : "图片上传失败"); }
	};
	const submit = async () => {
		const content = body.trim();
		if (!content) { setError("请输入评论内容"); return; }
		if (requiresLogin) { openAuth("login"); return; }
		if (!user && settings.allowAnonymous && !anonymousName.trim()) { setError("请输入昵称"); return; }
		setSubmitting(true); setError("");
		try {
			await api.createComment({ postId, body: content, parentId: replyTo?.id ?? null, authorName: user ? undefined : anonymousName.trim(), avatar: user ? undefined : anonymousAvatar || undefined, images: uploadedImages });
			setBody(""); setUploadedImages([]); setReplyTo(null); setPreview(false); setStickersOpen(false); setRefreshKey((value) => value + 1);
		} catch (reason) { setError(reason instanceof Error ? reason.message : "评论提交失败，请稍后重试"); }
		finally { setSubmitting(false); }
	};
	const insertSticker = (sticker: EmojiSticker) => { setBody((value) => `${value}${value && !value.endsWith(" ") ? " " : ""}![${sticker.name || "表情"}](${sticker.url}) `); setStickersOpen(false); };
	const uploadSticker = async (file: File | undefined) => {
		if (!file || !user || !features.imageHostingEnabled || !features.userCenterEnabled) return;
		if (!file.type.startsWith("image/")) { setError("表情必须是图片文件"); return; }
		if (file.size > 5 * 1024 * 1024) { setError("单个表情不能超过 5MB"); return; }
		try {
			setError("");
			const sticker = await api.uploadSticker(file, file.name.replace(/\.[^.]+$/u, "").slice(0, 120));
			setStickers((items) => [sticker, ...items]);
		} catch (reason) { setError(reason instanceof Error ? reason.message : "表情上传失败"); }
	};
	if (!canComment) return <section className="comments"><CommentHeading count={totalCount} /><div className="comments-disabled"><MessageCircle size={22} /><strong>评论功能暂未开启</strong><span>管理员暂时关闭了评论。</span></div></section>;
	return <section className="comments"><CommentHeading count={totalCount} />
		<div className="comments-compose">
			{replyTo ? <div className="comment-replying"><span>回复 {commentAuthor(replyTo).nickname || commentAuthor(replyTo).displayName || replyTo.authorName}</span><button type="button" title="取消回复" onClick={() => setReplyTo(null)}><X size={14} /></button></div> : null}
			{requiresLogin ? <div className="comments-login-prompt"><UserRound size={22} /><div><strong>登录后参与评论</strong><span>登录账号即可回复文章和使用表情包。</span></div><button type="button" onClick={() => openAuth("login")}>登录 / 注册</button></div> : <>
				{!user && settings.allowAnonymous ? <div className="anonymous-fields"><input value={anonymousName} onChange={(event) => setAnonymousName(event.target.value)} placeholder="昵称" aria-label="昵称" /><select value={anonymousAvatar} onChange={(event) => setAnonymousAvatar(event.target.value)} aria-label="选择头像"><option value="">随机预设头像</option>{settings.avatarPresets.map((avatar) => <option key={avatar} value={avatar}>预设头像</option>)}</select></div> : null}
				<div className="comment-editor-shell"><MdEditorBridge value={body} preview={preview} onChange={setBody} onUploadImage={features.imageHostingEnabled ? uploadImage : undefined} onUploadError={(reason) => setError(reason instanceof Error ? reason.message : "图片上传失败")} /><div className="comment-editor-tools"><button type="button" className={preview ? "selected" : ""} onClick={() => setPreview((value) => !value)}>{preview ? <ChevronUp size={15} /> : <ChevronDown size={15} />}预览</button>{features.imageHostingEnabled ? <button type="button" onClick={() => imageInput.current?.click()}><ImagePlus size={15} />图片 {uploadedImages.length}/3</button> : null}{features.userCenterEnabled ? <button type="button" className={stickersOpen ? "selected" : ""} onClick={() => setStickersOpen((value) => !value)}><Smile size={15} />表情</button> : null}<input ref={imageInput} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { void addImage(event.target.files?.[0]); event.currentTarget.value = ""; }} /><input ref={stickerInput} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => { void uploadSticker(event.target.files?.[0]); event.currentTarget.value = ""; }} /></div>{stickersOpen && features.userCenterEnabled ? <div className="comment-sticker-popover"><div className="comment-sticker-popover-head"><span>共享与我的表情</span>{user ? <button type="button" onClick={() => stickerInput.current?.click()}><ImagePlus size={14} />上传</button> : null}</div>{stickers.length ? stickers.map((sticker) => <button type="button" key={`${sticker.id}-${sticker.url}`} title={sticker.name || "表情"} onClick={() => insertSticker(sticker)}><img src={resolveMediaUrl(sticker.url)} alt={sticker.name || "表情"} /></button>) : <span>暂无可用表情</span>}</div> : null}{preview ? <div className="comment-preview"><MarkdownContent content={body || "还没有内容"} /></div> : null}</div>
				<div className="comment-submit-row"><span>{settings.commentModerationEnabled ? "评论提交后需等待管理员审核" : "请友善交流，尊重彼此。"}</span><button type="button" className="comment-submit" disabled={submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{submitting ? "提交中" : "发表评论"}</button></div>
			</>}
			{error ? <p className="comment-error" role="alert">{error}</p> : null}
		</div>
		<div className="comment-list">{loading ? <div className="comment-loading">正在加载评论...</div> : comments.length ? comments.map((comment) => <CommentItem key={comment.id} comment={comment} depth={0} onReply={setReplyTo} />) : <div className="comment-empty"><MessageCircle size={20} /><span>还没有评论，来留下第一条想法吧。</span></div>}</div>
	</section>;
}

function CommentHeading({ count }: { count: number }) { return <div className="comments-heading"><div><MessageCircle size={18} /><strong>评论</strong><span>{count}</span></div><small>Markdown · 楼中楼</small></div>; }

function CommentItem({ comment, depth, onReply }: { comment: CommentRecord; depth: number; onReply: (comment: CommentRecord) => void }) {
	const author = commentAuthor(comment);
	const children = comment.children ?? comment.replies ?? [];
	const label = author.nickname || author.displayName || comment.authorName || "匿名用户";
	return <article className={`comment-item ${depth ? "is-reply" : ""}`} style={{ "--comment-depth": Math.min(depth, 3) } as CSSProperties}><div className="comment-avatar"><UserAvatar user={author} size={depth ? 34 : 40} /></div><div className="comment-main"><header><strong>{label}</strong>{comment.isAdmin || author.isAdmin ? <b className="comment-admin-badge">管理员</b> : null}{comment.badge ? <b className="comment-user-badge">{comment.badge}</b> : null}<time>{new Date(comment.createdAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</time></header><div className="comment-meta">{comment.ipLocation ? <span>{comment.ipLocation}</span> : null}{comment.device ? <span>{comment.device}</span> : null}{comment.browser ? <span>{comment.browser}</span> : null}</div><div className="comment-body"><MarkdownContent content={comment.body} />{comment.images?.length ? <div className="comment-images">{comment.images.slice(0, 3).map((image) => <img key={image} src={resolveMediaUrl(image)} alt="评论图片" loading="lazy" decoding="async" />)}</div> : null}</div><footer><button type="button" onClick={() => onReply(comment)}><MessageCircle size={14} />回复</button></footer>{children.length ? <div className="comment-replies">{children.map((child) => <CommentItem key={child.id} comment={child} depth={depth + 1} onReply={onReply} />)}</div> : null}</div></article>;
}
