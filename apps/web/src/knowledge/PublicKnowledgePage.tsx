import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
	AlertTriangle,
	ArrowLeft,
	BookOpen,
	Clock,
	Globe,
	MessageCircle,
	RefreshCw,
	Send,
	Share2,
	User,
} from "lucide-react";
import { useAuth } from "../auth";
import { kbApi } from "./api";
import "./knowledge.css";
import type { KbCommentItem, PublicDocumentSnapshot } from "./types";

const MarkdownContent = lazy(() => import("../MarkdownContent"));

export default function PublicKnowledgePage() {
	const { libraryId: paramLibId, documentId: paramDocId, token: paramToken } = useParams<{
		libraryId?: string;
		documentId?: string;
		token?: string;
	}>();

	const { user, openAuth } = useAuth();

	const [snapshot, setSnapshot] = useState<PublicDocumentSnapshot | null>(null);
	const [comments, setComments] = useState<KbCommentItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// 评论表单
	const [commentBody, setCommentBody] = useState("");
	const [submittingComment, setSubmittingComment] = useState(false);

	const isShareLink = Boolean(paramToken);
	const documentId = paramDocId ? Number(paramDocId) : snapshot?.id ?? 0;

	useEffect(() => {
		let isMounted = true;
		setLoading(true);
		setError(null);

		const fetchData = async () => {
			try {
				if (paramToken) {
					// 1. 通过分享 Token 读取
					const shared = await kbApi.getSharedDocument(paramToken);
					if (!isMounted) return;
					setSnapshot({
						id: shared.document.id,
						libraryId: shared.library.id,
						libraryTitle: shared.library.title,
						title: shared.document.title,
						markdown: shared.document.markdown,
						tags: shared.document.tags,
						publishedRevisionId: shared.document.publishedRevisionId || 0,
						version: shared.document.version,
						authorName: "知识库作者",
						authorAvatar: "",
						updatedAt: shared.document.updatedAt,
						createdAt: shared.document.createdAt,
					});
				} else if (paramDocId) {
					// 2. 通过公开发布快照读取
					const pubDoc = await kbApi.getPublicDocument(Number(paramDocId));
					if (!isMounted) return;
					setSnapshot(pubDoc);

					// 加载公开评论
					const commentList = await kbApi.listComments(Number(paramDocId), "public").catch(() => []);
					if (isMounted) setComments(commentList);
				}
			} catch (err) {
				if (isMounted) {
					setError(err instanceof Error ? err.message : "获取文档失败");
				}
			} finally {
				if (isMounted) setLoading(false);
			}
		};

		fetchData();
		return () => {
			isMounted = false;
		};
	}, [paramLibId, paramDocId, paramToken]);

	// 提交公开评论
	const handleSendComment = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!commentBody.trim() || !snapshot) return;
		setSubmittingComment(true);
		try {
			await kbApi.addComment(snapshot.id, {
				body: commentBody.trim(),
				channel: "public",
			});
			setCommentBody("");
			// 刷新评论列表
			const commentList = await kbApi.listComments(snapshot.id, "public");
			setComments(commentList);
		} catch (err) {
			alert(err instanceof Error ? err.message : "发表评论失败");
		} finally {
			setSubmittingComment(false);
		}
	};

	if (loading) {
		return (
			<div className="kb-container" style={{ textAlign: "center", padding: "6rem 0" }}>
				<RefreshCw className="w-8 h-8 animate-spin" style={{ margin: "0 auto 1rem auto", opacity: 0.6 }} />
				<p style={{ color: "var(--muted-text)" }}>正在加载文档快照...</p>
			</div>
		);
	}

	if (error || !snapshot) {
		return (
			<div className="kb-container" style={{ maxWidth: "36rem", margin: "4rem auto" }}>
				<div className="kb-card" style={{ textAlign: "center", padding: "3rem" }}>
					<AlertTriangle className="w-12 h-12 text-warning" style={{ margin: "0 auto 1rem auto" }} />
					<h2 style={{ fontSize: "1.35rem", fontWeight: 700, margin: "0 0 0.5rem 0" }}>文档不可访问</h2>
					<p style={{ color: "var(--muted-text)", lineHeight: 1.6, margin: "0 0 1.5rem 0" }}>
						{error || "此文档不存在、尚未公开发布或分享链接已失效。"}
					</p>
					<Link to="/" className="kb-btn kb-btn-primary">返回博客首页</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="kb-container" style={{ maxWidth: "56rem", margin: "2rem auto 4rem auto" }}>
			{/* 顶部面包屑与通道标识 */}
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.75rem" }}>
				<Link to="/" className="kb-btn kb-btn-ghost kb-btn-sm">
					<ArrowLeft className="w-4 h-4" />
					返回首页
				</Link>

				<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
					<span className="kb-status-badge">
						{isShareLink ? (
							<>
								<Share2 className="w-3.5 h-3.5" />
								受保护的分享链接
							</>
						) : (
							<>
								<Globe className="w-3.5 h-3.5" />
								公开快照 (v{snapshot.version})
							</>
						)}
					</span>
				</div>
			</div>

			{/* 正文卡片 */}
			<article className="kb-card" style={{ padding: "2.5rem 2rem", marginBottom: "2rem" }}>
				<header style={{ marginBottom: "2rem", paddingBottom: "1.25rem", borderBottom: "1px solid var(--line)" }}>
					<div style={{ fontSize: "0.85rem", color: "var(--primary)", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.35rem", marginBottom: "0.5rem" }}>
						<BookOpen className="w-4 h-4" />
						{snapshot.libraryTitle}
					</div>

					<h1 style={{ fontSize: "2rem", fontWeight: 800, color: "var(--deep-text)", margin: "0 0 1rem 0", lineHeight: 1.3 }}>
						{snapshot.title}
					</h1>

					<div style={{ display: "flex", alignItems: "center", gap: "1.25rem", fontSize: "0.8rem", color: "var(--muted-text)", flexWrap: "wrap" }}>
						<span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
							<User className="w-4 h-4" />
							{snapshot.authorName}
						</span>
						<span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
							<Clock className="w-4 h-4" />
							发布于 {snapshot.updatedAt.slice(0, 16)}
						</span>
						{snapshot.tags && snapshot.tags.length > 0 && (
							<div style={{ display: "flex", gap: "0.35rem" }}>
								{snapshot.tags.map((tag) => (
									<span key={tag} className="badge badge-sm badge-outline">
										#{tag}
									</span>
								))}
							</div>
						)}
					</div>
				</header>

				{/* Markdown 渲染 */}
				<div className="markdown-body">
					<Suspense fallback={<div aria-busy="true">正文渲染中...</div>}>
						<MarkdownContent content={snapshot.markdown} />
					</Suspense>
				</div>
			</article>

			{/* 公开评论区 (仅公开快照通道展示) */}
			{!isShareLink && (
				<section className="kb-card">
					<h3 style={{ fontSize: "1.2rem", fontWeight: 700, margin: "0 0 1.25rem 0", display: "flex", alignItems: "center", gap: "0.5rem" }}>
						<MessageCircle className="w-5 h-5 text-primary" />
						读者评论 ({comments.length})
					</h3>

					{/* 评论发表框 */}
					{user ? (
						<form onSubmit={handleSendComment} style={{ marginBottom: "2rem" }}>
							<textarea
								className="kb-textarea"
								style={{ minHeight: "5rem", marginBottom: "0.75rem" }}
								placeholder="畅所欲言，留下你的见解..."
								value={commentBody}
								onChange={(e) => setCommentBody(e.target.value)}
								maxLength={5000}
								required
							/>
							<div style={{ display: "flex", justifyContent: "flex-end" }}>
								<button
									type="submit"
									className="kb-btn kb-btn-primary kb-btn-sm"
									disabled={submittingComment || !commentBody.trim()}
								>
									<Send className="w-3.5 h-3.5" />
									{submittingComment ? "发送中..." : "发表评论"}
								</button>
							</div>
						</form>
					) : (
						<div
							style={{
								padding: "1.25rem",
								borderRadius: "0.75rem",
								background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)",
								border: "1px solid var(--line)",
								textAlign: "center",
								marginBottom: "2rem",
							}}
						>
							<p style={{ margin: "0 0 0.75rem 0", fontSize: "0.85rem", color: "var(--muted-text)" }}>
								登录博客账号后即可参与讨论与留下评论
							</p>
							<button
								type="button"
								className="kb-btn kb-btn-primary kb-btn-sm"
								onClick={() => openAuth("login")}
							>
								立即登录
							</button>
						</div>
					)}

					{/* 评论列表 */}
					{comments.length === 0 ? (
						<div style={{ textAlign: "center", padding: "1.5rem 0", color: "var(--muted-text)", fontSize: "0.85rem" }}>
							暂无评论，来做第一个发言的人吧！
						</div>
					) : (
						<div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
							{comments.map((comment) => (
								<div
									key={comment.id}
									style={{
										padding: "1rem",
										borderRadius: "0.75rem",
										border: "1px solid var(--line)",
										background: "color-mix(in srgb, var(--card-bg-solid) 75%, transparent)",
									}}
								>
									<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
										<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
											<strong style={{ fontSize: "0.85rem" }}>{comment.authorName}</strong>
											<span style={{ fontSize: "0.75rem", color: "var(--faint-text)" }}>
												{comment.createdAt.slice(0, 16)}
											</span>
										</div>
									</div>
									<p style={{ margin: 0, fontSize: "0.875rem", color: "var(--deep-text)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
										{comment.body}
									</p>
								</div>
							))}
						</div>
					)}
				</section>
			)}
		</div>
	);
}
