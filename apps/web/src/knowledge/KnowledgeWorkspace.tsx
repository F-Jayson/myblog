import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
	AlertTriangle,
	ArrowLeft,
	BookOpen,
	Check,
	ChevronDown,
	ChevronRight,
	Clock,
	Columns2,
	Copy,
	Download,
	Edit3,
	Eye,
	FileText,
	Folder,
	FolderPlus,
	GitCompare,
	Globe,
	History,
	MessageCircle,
	Moon,
	PanelLeft,
	PanelLeftClose,
	Paperclip,
	Plus,
	RefreshCw,
	Save,
	Search,
	Settings,
	Share2,
	SquarePen,
	Sun,
	Tag,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import MdEditorBridge from "../admin/MdEditorBridge";
import { kbApi, KbApiError } from "./api";
import "./knowledge.css";
import type {
	AttachmentSummary,
	DocumentDetail,
	KbCommentItem,
	KbShareLinkItem,
	LibrarySummary,
	RevisionSummary,
	SearchResultItem,
	TreeNode,
} from "./types";

const EMOJI_OPTIONS = ["📄", "📝", "💡", "🚀", "📌", "📚", "✨", "🎯", "💻", "🔥", "🛠️", "📖"];

function computeSimpleDiff(oldText: string, newText: string) {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const diff: Array<{ type: "add" | "del" | "normal"; text: string }> = [];

	let i = 0;
	let j = 0;
	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			diff.push({ type: "normal", text: oldLines[i] });
			i++;
			j++;
		} else if (j < newLines.length && !oldLines.slice(i, i + 5).includes(newLines[j])) {
			diff.push({ type: "add", text: newLines[j] });
			j++;
		} else if (i < oldLines.length && !newLines.slice(j, j + 5).includes(oldLines[i])) {
			diff.push({ type: "del", text: oldLines[i] });
			i++;
		} else {
			if (i < oldLines.length) {
				diff.push({ type: "del", text: oldLines[i] });
				i++;
			}
			if (j < newLines.length) {
				diff.push({ type: "add", text: newLines[j] });
				j++;
			}
		}
	}
	return diff;
}

// [427] 剪贴板写入需要 HTTPS 与授权环境：统一封装，失败返回 false 而不是 unhandled rejection
async function copyTextToClipboard(text: string): Promise<boolean> {
	try {
		if (!navigator.clipboard) return false;
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

export default function KnowledgeWorkspace() {
	const { libraryId: paramLibId, documentId: paramDocId } = useParams<{
		libraryId: string;
		documentId?: string;
	}>();
	const navigate = useNavigate();

	const libraryId = Number(paramLibId);
	const activeDocId = paramDocId ? Number(paramDocId) : null;

	const [library, setLibrary] = useState<LibrarySummary | null>(null);
	const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
	const [treeLoading, setTreeLoading] = useState(true);

	// 当前文档详情
	const [currentDoc, setCurrentDoc] = useState<DocumentDetail | null>(null);
	const [docLoading, setDocLoading] = useState(false);
	const [docError, setDocError] = useState<string | null>(null);

	// 编辑状态
	const [editTitle, setEditTitle] = useState("");
	const [editMarkdown, setEditMarkdown] = useState("");
	const [editTags, setEditTags] = useState<string[]>([]);
	const [newTagInput, setNewTagInput] = useState("");
	const [docEmoji, setDocEmoji] = useState("📄");
	const [showEmojiPicker, setShowEmojiPicker] = useState(false);
	const [currentVersion, setCurrentVersion] = useState(1);

	// 保存状态: 'saved' | 'saving' | 'dirty' | 'error' | 'conflict'
	const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "dirty" | "error" | "conflict">("saved");
	const [saveError, setSaveError] = useState<string | null>(null);

	// 冲突弹窗状态
	const [conflictData, setConflictData] = useState<{
		serverDoc?: DocumentDetail;
		localContent: string;
		localTitle: string;
	} | null>(null);

	// 视图与布局响应式控制
	const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 960);
	const [rightTab, setRightTab] = useState<"toc" | "revisions" | "attachments" | "comments" | null>("toc");
	const [viewMode, setViewMode] = useState<"split" | "edit" | "preview">("split");

	// 主题控制 (亮色 / 暗色同步)
	const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

	useEffect(() => {
		const observer = new MutationObserver(() => {
			setIsDark(document.documentElement.classList.contains("dark"));
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	const toggleDarkTheme = () => {
		const next = !isDark;
		setIsDark(next);
		document.documentElement.classList.toggle("dark", next);
		// [424] 隐私模式下写入会抛异常，不能中断主题切换
		try { localStorage.setItem("site-theme", next ? "dark" : "light"); } catch { /* ignore */ }
	};

	// 历史版本、附件与评论
	const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
	const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
	const [uploadingAttachment, setUploadingAttachment] = useState(false);
	const [copiedAttachmentId, setCopiedAttachmentId] = useState<number | null>(null);

	// 历史版本对比 (Diff) 弹窗状态
	const [diffModalRev, setDiffModalRev] = useState<{
		rev: RevisionSummary;
		detail?: {
			title: string;
			markdown: string;
			tags: string[];
			createdAt: string;
		};
		loading: boolean;
	} | null>(null);
	const [diffViewMode, setDiffViewMode] = useState<"diff" | "preview">("diff");

	const [comments, setComments] = useState<KbCommentItem[]>([]);
	const [commentsLoading, setCommentsLoading] = useState(false);
	const [commentBody, setCommentBody] = useState("");
	const [submittingComment, setSubmittingComment] = useState(false);

	// 受限分享链接弹窗
	const [shareModalOpen, setShareModalOpen] = useState(false);
	const [shareLinks, setShareLinks] = useState<KbShareLinkItem[]>([]);
	const [shareLinksLoading, setShareLinksLoading] = useState(false);
	const [shareExpiryDays, setShareExpiryDays] = useState(7);
	const [newShareToken, setNewShareToken] = useState<string | null>(null);
	const [shareActionLoading, setShareActionLoading] = useState(false);
	const [copiedShareLink, setCopiedShareLink] = useState(false);

	// 公开快照发布弹窗
	const [publishModalOpen, setPublishModalOpen] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const [copiedPublishLink, setCopiedPublishLink] = useState(false);

	// 搜索功能
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
	const [searching, setSearching] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);

	// 展开的文件夹集合
	const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set());

	// 自动保存防抖
	const autoSaveTimerRef = useRef<number | null>(null);
	// [417] 保存进行中新产生的修改：保存结束后补存一次
	const pendingSaveRef = useRef(false);
	// [420] 搜索防抖定时器与请求序号（序号用于丢弃过期响应）
	const searchDebounceRef = useRef<number | null>(null);
	const searchSeqRef = useRef(0);
	const lastSaveTimeRef = useRef<number>(Date.now());
	// 当前文档 id 的镜像，供自动保存定时器判断期间是否已切换文档
	const activeDocIdRef = useRef<number | null>(activeDocId);
	useEffect(() => {
		activeDocIdRef.current = activeDocId;
	}, [activeDocId]);

	// 1. 加载库信息与目录树
	// [418] 初始引导（跳转首篇/重置展开）只应执行一次：activeDocId 变化时不再重拉库与树，
	// 否则每次切文档都会重置用户手动折叠的文件夹
	const initialBootRef = useRef(false);
	const loadLibraryAndTree = useCallback(async () => {
		// [419] 非法路由参数要结束加载态：否则侧边栏永远停在加载中且没有任何提示
		if (!libraryId || Number.isNaN(libraryId)) {
			setTreeLoading(false);
			setDocError("知识库 ID 无效，请从知识库列表重新进入");
			return;
		}
		try {
			const [lib, tree] = await Promise.all([
				kbApi.getLibrary(libraryId),
				kbApi.getLibraryTree(libraryId),
			]);
			setLibrary(lib);
			setTreeNodes(tree);

			if (!initialBootRef.current) {
				initialBootRef.current = true;
				// 默认展开所有文件夹（仅首次；之后用户自己的折叠状态不被重置）
				const initialExpanded = new Set<number>();
				for (const node of tree) {
					if (node.kind === "folder") initialExpanded.add(node.id);
				}
				setExpandedFolders(initialExpanded);

				// 若未选中任何文档且树中有文档，跳转第一篇（仅首次）
				const firstDoc = tree.find((n) => n.kind === "document");
				if (firstDoc) {
					navigate(`/knowledge/${libraryId}/docs/${firstDoc.id}`, { replace: true });
				}
			}
		} catch (err) {
			setDocError(err instanceof Error ? err.message : "加载知识库失败");
		} finally {
			setTreeLoading(false);
		}
	}, [libraryId, navigate]);

	useEffect(() => {
		void loadLibraryAndTree();
	}, [loadLibraryAndTree]);

	// 2. 加载文档内容
	const loadDocumentContent = useCallback(async (docId: number) => {
		setDocLoading(true);
		setDocError(null);
		setSaveStatus("saved");
		try {
			const doc = await kbApi.getDocument(docId);
			setCurrentDoc(doc);
			setEditTitle(doc.title);
			setEditMarkdown(doc.markdown);
			setEditTags(doc.tags ?? []);
			setCurrentVersion(doc.version);

			kbApi.getRevisions(docId).then(setRevisions).catch(() => undefined);
			kbApi.listAttachments(docId).then(setAttachments).catch(() => undefined);
		} catch (err) {
			setDocError(err instanceof Error ? err.message : "读取文档失败");
		} finally {
			setDocLoading(false);
		}
	}, []);

	useEffect(() => {
		if (activeDocId) {
			loadDocumentContent(activeDocId);
		} else {
			setCurrentDoc(null);
		}
	}, [activeDocId, loadDocumentContent]);

	// 3. 执行保存
	const performSave = useCallback(
		async (isManual = false) => {
			// [417] 正在保存时来的新修改不能被静默丢弃：记一个待存标记，保存结束后补存一次
			if (saveStatus === "saving") {
				pendingSaveRef.current = true;
				return;
			}
			if (!activeDocId || !currentDoc) return;

			setSaveStatus("saving");
			setSaveError(null);

			try {
				const result = await kbApi.saveDocument(activeDocId, {
					expectedVersion: currentVersion,
					title: editTitle,
					markdown: editMarkdown,
					tags: editTags,
					isManualSave: isManual,
				});

				if (result.status === "saved" || result.status === "unchanged") {
					setCurrentVersion(result.version);
					setSaveStatus("saved");
					lastSaveTimeRef.current = Date.now();
					// [423] 保存成功后同步 currentDoc：否则发布用的是过期 revisionId，头部时间/版本号也会滞后
					setCurrentDoc((prev) =>
						prev && prev.id === activeDocId
							? {
									...prev,
									version: result.version,
									currentRevisionId: result.revisionId ?? prev.currentRevisionId,
									title: editTitle,
									updatedAt: new Date().toISOString(),
							  }
							: prev,
					);
					// [417] 保存期间又有新的修改：补一次保存，避免内容停留在 dirty
					if (pendingSaveRef.current) {
						pendingSaveRef.current = false;
						void performSave(false);
					}

					if (result.status === "saved") {
						kbApi.getRevisions(activeDocId).then(setRevisions).catch(() => undefined);
						setTreeNodes((prev) =>
							prev.map((n) => (n.id === activeDocId ? { ...n, title: editTitle, version: result.version } : n)),
						);
					}
				}
			} catch (err) {
				if (err instanceof KbApiError && err.status === 409) {
					setSaveStatus("conflict");
					const latestServerDoc = await kbApi.getDocument(activeDocId).catch(() => undefined);
					setConflictData({
						serverDoc: latestServerDoc,
						localContent: editMarkdown,
						localTitle: editTitle,
					});
				} else {
					setSaveStatus("error");
					setSaveError(err instanceof Error ? err.message : "保存失败");
					if (pendingSaveRef.current) {
						pendingSaveRef.current = false;
						void performSave(false);
					}
				}
			}
		},
		[activeDocId, currentDoc, currentVersion, editMarkdown, editTags, editTitle, saveStatus],
	);

	// 键盘快捷键监听 (Ctrl+S, Ctrl+K)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				performSave(true);
			}
			if ((e.ctrlKey || e.metaKey) && e.key === "k") {
				e.preventDefault();
				if (!sidebarOpen) setSidebarOpen(true);
				setTimeout(() => searchInputRef.current?.focus(), 100);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [performSave, sidebarOpen]);

	// 4. 输入变更处理
	const scheduleAutoSave = useCallback((delay: number) => {
		// [417] 版本冲突未解决前暂停自动保存：旧 expectedVersion 只会反复触发 409
		if (saveStatus === "conflict") return;
		if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
		const docId = activeDocId;
		autoSaveTimerRef.current = window.setTimeout(() => {
			autoSaveTimerRef.current = null;
			// 文档已切换：丢弃这次待执行保存，避免旧闭包写进新文档的界面状态
			if (activeDocIdRef.current !== docId) return;
			void performSave(false);
		}, delay);
	}, [activeDocId, performSave, saveStatus]);

	// 卸载时清掉待触发的定时器，避免组件卸载后仍执行保存与 setState
	useEffect(() => () => {
		if (autoSaveTimerRef.current) {
			window.clearTimeout(autoSaveTimerRef.current);
			autoSaveTimerRef.current = null;
		}
	}, []);

	const handleContentChange = (nextMarkdown: string) => {
		setEditMarkdown(nextMarkdown);
		setSaveStatus("dirty");

		const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
		const delay = timeSinceLastSave > 15000 ? 500 : 2000;

		scheduleAutoSave(delay);
	};

	const handleTitleChange = (nextTitle: string) => {
		setEditTitle(nextTitle);
		setSaveStatus("dirty");

		scheduleAutoSave(2000);
	};

	// 5. 标签管理
	const handleAddTag = () => {
		const trimmed = newTagInput.trim().replace(/^#/, "");
		if (trimmed && !editTags.includes(trimmed)) {
			const nextTags = [...editTags, trimmed];
			setEditTags(nextTags);
			setNewTagInput("");
			setSaveStatus("dirty");
			scheduleAutoSave(1500);
		}
	};

	const handleRemoveTag = (tagToRemove: string) => {
		const nextTags = editTags.filter((t) => t !== tagToRemove);
		setEditTags(nextTags);
		setSaveStatus("dirty");
		scheduleAutoSave(1500);
	};

	// 6. 新建与重命名
	const handleCreateItem = async (kind: "document" | "folder", parentId: number | null = null) => {
		const title = prompt(kind === "folder" ? "请输入新建文件夹名称：" : "请输入新建文档标题：");
		if (!title?.trim()) return;

		try {
			const newDoc = await kbApi.createDocument({
				libraryId,
				parentId,
				kind,
				title: title.trim(),
				markdown: kind === "document" ? `# ${title.trim()}\n\n开始撰写你的文档内容...` : "",
			});

			await loadLibraryAndTree();
			if (kind === "document") {
				navigate(`/knowledge/${libraryId}/docs/${newDoc.id}`);
			}
		} catch (err) {
			alert(err instanceof Error ? err.message : "创建失败");
		}
	};

	const handleDeleteDoc = async (docId: number) => {
		if (!confirm("确定要将此项移入回收站吗？（可在知识库设置中随时恢复）")) return;
		try {
			await kbApi.trashDocument(docId);
			if (activeDocId === docId) {
				navigate(`/knowledge/${libraryId}`);
			}
			await loadLibraryAndTree();
		} catch (err) {
			alert(err instanceof Error ? err.message : "删除失败");
		}
	};

	// 7. 恢复指定历史版本
	const handleRestoreRevision = async (rev: RevisionSummary) => {
		if (!confirm(`确定要将版本 v${rev.version} 恢复为当前最新版本吗？`)) return;
		// [421] 确认弹窗期间文档可能已被切换/删除：currentDoc 必须重新判空，不能用非空断言
		const doc = currentDoc;
		if (!doc) return;
		try {
			const res = await kbApi.restoreRevision(doc.id, rev.id, currentVersion);
			setCurrentVersion(res.version);
			await loadDocumentContent(doc.id);
			alert(`已成功恢复为最新版本 v${res.version}`);
		} catch (err) {
			alert(err instanceof Error ? err.message : "恢复版本失败");
		}
	};

	// 历史版本详情与 Diff 查看
	const handleOpenDiff = async (rev: RevisionSummary) => {
		if (!activeDocId) return;
		setDiffModalRev({ rev, loading: true });
		try {
			const detail = await kbApi.getRevisionDetail(activeDocId, rev.id);
			setDiffModalRev({ rev, detail, loading: false });
		} catch (err) {
			alert(err instanceof Error ? err.message : "获取历史版本详情失败");
			setDiffModalRev(null);
		}
	};

	// 8. 附件上传
	const handleUploadAttachment = async (file: File) => {
		// [424] 没有文档上下文时必须抛错终止上传：返回空串会被写进 Markdown 变成坏图
		if (!activeDocId) {
			alert("请先选择要插入附件的文档");
			throw new Error("缺少文档上下文，无法上传附件");
		}
		setUploadingAttachment(true);
		try {
			const att = await kbApi.uploadAttachment(activeDocId, file);
			setAttachments((prev) => [att, ...prev]);
			return att.url || `/api/knowledge/attachments/${att.id}`;
		} catch (err) {
			alert(err instanceof Error ? err.message : "上传失败");
			throw err;
		} finally {
			setUploadingAttachment(false);
		}
	};

	// 9. Markdown 导出下载
	const handleExportMarkdown = () => {
		if (!currentDoc) return;
		const blob = new Blob([editMarkdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${editTitle || "document"}.md`;
		link.click();
		URL.revokeObjectURL(url);
	};

	// 10. 大纲解析 (TOC)
	const tableOfContents = useMemo(() => {
		const lines = editMarkdown.split("\n");
		const items: Array<{ level: number; text: string; id: string }> = [];
		for (const line of lines) {
			const match = line.match(/^(#{1,4})\s+(.+)$/);
			if (match) {
				const level = match[1].length;
				const text = match[2].trim();
				const id = text.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-");
				items.push({ level, text, id });
			}
		}
		return items;
	}, [editMarkdown]);

	// 大纲点击平滑滚动至预览标题
	const handleHeadingClick = (headingText: string) => {
		const preview = document.querySelector(".md-editor-preview");
		if (preview) {
			const headings = preview.querySelectorAll("h1, h2, h3, h4, h5, h6");
			for (const h of headings) {
				if (h.textContent?.trim().includes(headingText.trim())) {
					h.scrollIntoView({ behavior: "smooth", block: "start" });
					return;
				}
			}
		}
	};

	// 11. 字数与阅读时间统计
	const wordStats = useMemo(() => {
		const clean = editMarkdown.replace(/```[\s\S]*?```/g, "").replace(/#+\s/g, "");
		const cjk = (clean.match(/[\u4e00-\u9fa5]/g) || []).length;
		const words = (clean.match(/[a-zA-Z0-9_-]+/g) || []).length;
		const total = cjk + words;
		const readingTime = Math.max(1, Math.ceil(total / 300));
		return { total, readingTime };
	}, [editMarkdown]);

	// 12. 内部评论
	const loadComments = useCallback(async (docId: number) => {
		setCommentsLoading(true);
		try {
			const list = await kbApi.listComments(docId, "internal");
			setComments(list);
		} catch (err) {
			console.error("加载评论失败", err);
		} finally {
			setCommentsLoading(false);
		}
	}, []);

	useEffect(() => {
		if (activeDocId && rightTab === "comments") {
			loadComments(activeDocId);
		}
	}, [activeDocId, rightTab, loadComments]);

	const handleAddComment = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!currentDoc || !commentBody.trim() || submittingComment) return;
		setSubmittingComment(true);
		try {
			await kbApi.addComment(currentDoc.id, {
				body: commentBody.trim(),
				channel: "internal",
			});
			setCommentBody("");
			await loadComments(currentDoc.id);
		} catch (err) {
			alert(err instanceof Error ? err.message : "发表评论失败");
		} finally {
			setSubmittingComment(false);
		}
	};

	const handleToggleResolve = async (comment: KbCommentItem) => {
		if (!currentDoc) return;
		try {
			await kbApi.resolveComment(comment.id);
			await loadComments(currentDoc.id);
		} catch (err) {
			alert(err instanceof Error ? err.message : "更新评论状态失败");
		}
	};

	// 13. 受限分享链接管理
	const loadShareLinks = useCallback(async (docId: number) => {
		setShareLinksLoading(true);
		try {
			const links = await kbApi.listShareLinks(docId);
			setShareLinks(links);
		} catch (err) {
			console.error("加载分享链接失败", err);
		} finally {
			setShareLinksLoading(false);
		}
	}, []);

	const handleCreateShareLink = async () => {
		if (!currentDoc || shareActionLoading) return;
		setShareActionLoading(true);
		try {
			const res = await kbApi.createShareLink(currentDoc.id, { expiresInDays: shareExpiryDays });
			setNewShareToken(res.token);
			await loadShareLinks(currentDoc.id);
		} catch (err) {
			alert(err instanceof Error ? err.message : "创建分享链接失败")
		} finally {
			setShareActionLoading(false);
		}
	};

	const handleRevokeShareLink = async (linkId: number) => {
		if (!currentDoc || !window.confirm("确定要作废该分享链接吗？作废后持有链接的人将无法访问。")) return;
		try {
			await kbApi.revokeShareLink(linkId);
			await loadShareLinks(currentDoc.id);
		} catch (err) {
			alert(err instanceof Error ? err.message : "撤销失败")
		}
	};

	// 14. 公开快照发布管理
	const handlePublishSnapshot = async () => {
		if (!currentDoc || publishing) return;
		setPublishing(true);
		try {
			const res = await kbApi.publishDocument(currentDoc.id, currentDoc.currentRevisionId ?? undefined);
			setCurrentDoc((prev) => (prev ? { ...prev, publishedRevisionId: res.publishedRevisionId } : null));
			alert("已成功发布为公开快照！任何人可通过公开链接阅读当前版本。");
		} catch (err) {
			alert(err instanceof Error ? err.message : "发布失败")
		} finally {
			setPublishing(false);
		}
	};

	const handleUnpublishSnapshot = async () => {
		if (!currentDoc || publishing || !window.confirm("确定要撤回公开快照吗？撤回后外部访问将返回 404。")) return;
		setPublishing(true);
		try {
			await kbApi.unpublishDocument(currentDoc.id);
			setCurrentDoc((prev) => (prev ? { ...prev, publishedRevisionId: null } : null));
			alert("已撤回公开快照。");
		} catch (err) {
			alert(err instanceof Error ? err.message : "撤回失败")
		} finally {
			setPublishing(false);
		}
	};

	// 目录树递归渲染
	const renderTreeNodes = (parentId: number | null = null, depth = 0) => {
		const nodes = treeNodes.filter((n) => n.parentId === parentId);
		if (nodes.length === 0) return null;

		return (
			<ul className={depth > 0 ? "kb-tree-sublist" : "kb-tree-list"}>
				{nodes.map((node) => {
					const isFolder = node.kind === "folder";
					const isExpanded = expandedFolders.has(node.id);
					const isActive = node.id === activeDocId;

					return (
						<li key={node.id}>
							<div
								className={`kb-tree-node ${isActive ? "is-active" : ""}`}
								onClick={() => {
									if (isFolder) {
										setExpandedFolders((prev) => {
											const next = new Set(prev);
											if (next.has(node.id)) next.delete(node.id);
											else next.add(node.id);
											return next;
										});
									} else {
										navigate(`/knowledge/${libraryId}/docs/${node.id}`);
									}
								}}
							>
								<div className="kb-tree-node-main">
									{isFolder ? (
										<>
											{isExpanded ? (
												<ChevronDown size={14} className="kb-folder-chevron" />
											) : (
												<ChevronRight size={14} className="kb-folder-chevron" />
											)}
											<Folder size={16} className="kb-folder-icon" />
										</>
									) : (
										<FileText size={15} className="kb-doc-icon" />
									)}
									<span className="kb-tree-node-title">{node.title || "未命名"}</span>
								</div>

								{/* 悬浮操作按键 */}
								<div className="kb-tree-actions" onClick={(e) => e.stopPropagation()}>
									{isFolder && (
										<button
											type="button"
											className="kb-tree-action-btn"
											title="新建子文档"
											onClick={() => handleCreateItem("document", node.id)}
										>
											<Plus size={13} />
										</button>
									)}
									<button
										type="button"
										className="kb-tree-action-btn is-danger"
										title="移入回收站"
										onClick={() => handleDeleteDoc(node.id)}
									>
										<Trash2 size={13} />
									</button>
								</div>
							</div>

							{isFolder && isExpanded && renderTreeNodes(node.id, depth + 1)}
						</li>
					);
				})}
			</ul>
		);
	};

	return (
		<div className="kb-workspace-layout">
			{/* ============================================================== */}
			{/* 1. 顶部全局导航栏 */}
			{/* ============================================================== */}
			<header className="kb-workspace-topbar">
				<div className="kb-topbar-left">
					<button
						type="button"
						className="kb-icon-btn"
						title={sidebarOpen ? "收起知识库目录" : "展开知识库目录"}
						onClick={() => setSidebarOpen(!sidebarOpen)}
					>
						{sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
					</button>

					<Link to="/knowledge" className="kb-icon-btn" title="返回知识库中心">
						<ArrowLeft size={18} />
					</Link>

					<div className="kb-breadcrumb-wrap">
						<Link to="/knowledge" className="kb-breadcrumb-link">
							<BookOpen size={14} />
							<span>{library?.title || "知识库"}</span>
						</Link>
						<span className="kb-breadcrumb-sep">/</span>
						<span className="kb-breadcrumb-doc">{editTitle || "无标题文档"}</span>
					</div>

					{currentDoc && (
						<div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginLeft: "0.5rem" }}>
							<span className="kb-version-badge">v{currentVersion}</span>

							{saveStatus === "saved" && (
								<span className="kb-status-capsule is-saved">
									<Check size={12} /> 已同步
								</span>
							)}
							{saveStatus === "saving" && (
								<span className="kb-status-capsule is-saving">
									<RefreshCw size={12} className="kb-spin" /> 保存中
								</span>
							)}
							{saveStatus === "dirty" && (
								<span className="kb-status-capsule is-dirty">
									<span className="kb-dot-pulse" /> 未保存
								</span>
							)}
							{saveStatus === "conflict" && (
								<span className="kb-status-capsule is-conflict">
									<AlertTriangle size={12} /> 版本冲突
								</span>
							)}
							{saveStatus === "error" && (
								<span className="kb-status-capsule is-conflict">
									<AlertTriangle size={12} /> {saveError || "保存失败"}
								</span>
							)}
						</div>
					)}
				</div>

				<div className="kb-topbar-right">
					{currentDoc && (
						<>
							{/* 写作模式切换 */}
							<div className="kb-segmented-group">
								<button
									type="button"
									className={`kb-segmented-item ${viewMode === "split" ? "is-active" : ""}`}
									onClick={() => setViewMode("split")}
									title="双栏编辑与预览"
								>
									<Columns2 size={13} />
									<span style={{ display: "inline-block" }}>分屏</span>
								</button>
								<button
									type="button"
									className={`kb-segmented-item ${viewMode === "edit" ? "is-active" : ""}`}
									onClick={() => setViewMode("edit")}
									title="专注写作（纯编辑）"
								>
									<SquarePen size={13} />
									<span style={{ display: "inline-block" }}>写作</span>
								</button>
								<button
									type="button"
									className={`kb-segmented-item ${viewMode === "preview" ? "is-active" : ""}`}
									onClick={() => setViewMode("preview")}
									title="沉浸阅读（纯预览）"
								>
									<Eye size={13} />
									<span style={{ display: "inline-block" }}>阅读</span>
								</button>
							</div>

							{/* 文档操作快捷键 */}
							<button
								type="button"
								onClick={() => performSave(true)}
								disabled={saveStatus === "saving"}
								className={`kb-btn kb-btn-sm ${saveStatus === "dirty" ? "kb-btn-primary" : "kb-btn-ghost"}`}
								title={
									saveStatus === "dirty"
										? "立即保存当前修改 (Ctrl+S)"
										: "将当前草稿封存为一个全新历史里程碑版本 (Ctrl+S)"
								}
							>
								<Save size={13} />
								<span>{saveStatus === "dirty" ? "保存" : "存为里程碑"}</span>
							</button>

							<button
								type="button"
								onClick={() => {
									setShareModalOpen(true);
									if (currentDoc) loadShareLinks(currentDoc.id);
								}}
								className="kb-btn kb-btn-ghost kb-btn-sm"
								title="受限只读分享"
							>
								<Share2 size={13} />
								<span>分享</span>
							</button>

							<button
								type="button"
								onClick={() => setPublishModalOpen(true)}
								className={`kb-btn kb-btn-sm ${
									currentDoc.publishedRevisionId ? "kb-btn-outline-success" : "kb-btn-ghost"
								}`}
								title="公开发布快照"
							>
								<Globe size={13} />
								<span>{currentDoc.publishedRevisionId ? "已上线" : "公开"}</span>
							</button>

							<button
								type="button"
								onClick={handleExportMarkdown}
								className="kb-btn kb-btn-ghost kb-btn-sm"
								title="导出 Markdown (.md)"
							>
								<Download size={13} />
								<span>导出</span>
							</button>

							<div className="kb-topbar-divider" />
						</>
					)}

					{/* 亮暗色切换 */}
					<button
						type="button"
						onClick={toggleDarkTheme}
						className="kb-icon-btn"
						title={isDark ? "切换为亮色模式" : "切换为暗色模式"}
					>
						{isDark ? <Sun size={17} /> : <Moon size={17} />}
					</button>

					{/* 检查器抽屉切换按键 */}
					{currentDoc && (
						<div style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
							<button
								type="button"
								onClick={() => setRightTab(rightTab === "toc" ? null : "toc")}
								className={`kb-inspector-btn ${rightTab === "toc" ? "is-active" : ""}`}
								title="大纲目录"
							>
								<FileText size={13} />
								<span>大纲</span>
							</button>

							<button
								type="button"
								onClick={() => setRightTab(rightTab === "revisions" ? null : "revisions")}
								className={`kb-inspector-btn ${rightTab === "revisions" ? "is-active" : ""}`}
								title="版本追溯历史"
							>
								<History size={13} />
								<span>历史</span>
								{revisions.length > 0 && <span className="kb-count-pill">{revisions.length}</span>}
							</button>

							<button
								type="button"
								onClick={() => setRightTab(rightTab === "attachments" ? null : "attachments")}
								className={`kb-inspector-btn ${rightTab === "attachments" ? "is-active" : ""}`}
								title="文档附件"
							>
								<Paperclip size={13} />
								<span>附件</span>
								{attachments.length > 0 && <span className="kb-count-pill">{attachments.length}</span>}
							</button>

							<button
								type="button"
								onClick={() => {
									// [425] 只切换 tab：评论列表由 useEffect([activeDocId, rightTab]) 统一加载，
									// 这里再显式调用会与 effect 并发两次请求且互相覆盖
									setRightTab(rightTab === "comments" ? null : "comments");
								}}
								className={`kb-inspector-btn ${rightTab === "comments" ? "is-active" : ""}`}
								title="工作评论"
							>
								<MessageCircle size={13} />
								<span>讨论</span>
								{comments.length > 0 && <span className="kb-count-pill">{comments.length}</span>}
							</button>
						</div>
					)}
				</div>
			</header>

			{/* ============================================================== */}
			{/* 2. 工作区主体三栏结构 */}
			{/* ============================================================== */}
			<div className="kb-workspace-body">
				{/* ------------------------------------------------------------ */}
				{/* 左侧栏：库信息、目录树与快捷搜索 */}
				{/* ------------------------------------------------------------ */}
				<aside className={`kb-workspace-sidebar ${sidebarOpen ? "" : "is-collapsed"}`}>
					<div className="kb-sidebar-hero">
						<div className="kb-library-badge">
							<div className="kb-library-icon">
								{library?.title ? library.title.slice(0, 1).toUpperCase() : "B"}
							</div>
							<div className="kb-library-meta">
								<span className="kb-library-title" title={library?.title}>
									{library?.title || "知识库"}
								</span>
								<span className="kb-library-sub">
									私有知识库 · {treeNodes.filter((n) => n.kind === "document").length} 篇文档
								</span>
							</div>
						</div>

						<Link
							to={`/knowledge/${libraryId}/settings`}
							className="kb-icon-btn"
							title="知识库设置"
						>
							<Settings size={16} />
						</Link>
					</div>

					{/* 快捷新建与搜索 */}
					<div className="kb-sidebar-actions">
						<div className="kb-action-row">
							<button
								type="button"
								onClick={() => handleCreateItem("document", null)}
								className="kb-create-btn is-primary"
							>
								<Plus size={14} />
								<span>新建文档</span>
							</button>
							<button
								type="button"
								onClick={() => handleCreateItem("folder", null)}
								className="kb-create-btn is-secondary"
							>
								<FolderPlus size={14} />
								<span>文件夹</span>
							</button>
						</div>

						<div className="kb-search-box">
							<Search size={14} className="kb-search-icon" />
							<input
								ref={searchInputRef}
								type="text"
								placeholder="搜索文档... (Ctrl+K)"
								className="kb-search-input"
								value={searchQuery}
								onChange={(e) => {
									const value = e.target.value;
									setSearchQuery(value);
									// [420] 每次输入丢弃上一次未触发的搜索（防抖）
									if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
									const keyword = value.trim();
									if (keyword.length > 1) {
										setSearching(true);
										const seq = ++searchSeqRef.current;
										searchDebounceRef.current = window.setTimeout(async () => {
											try {
												const items = await kbApi.search(keyword, libraryId);
												// 过期响应丢弃：只采纳最后一次键入的结果
												if (seq !== searchSeqRef.current) return;
												setSearchResults(items);
											} catch (err) {
												if (seq === searchSeqRef.current) {
													setSearchResults([]);
													setDocError(err instanceof Error ? err.message : "搜索失败");
												}
											} finally {
												if (seq === searchSeqRef.current) setSearching(false);
											}
										}, 300);
									} else {
										++searchSeqRef.current;
										setSearching(false);
										setSearchResults([]);
									}
								}}
							/>
							{searchQuery && (
								<button
									type="button"
									className="kb-search-clear"
									onClick={() => {
										setSearchQuery("");
										setSearchResults([]);
									}}
								>
									<X size={12} />
								</button>
							)}
						</div>
					</div>

					{/* 目录树展示区 */}
					<div className="kb-tree-container">
						{searchQuery.trim().length > 1 ? (
							<div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
								<span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--muted-text)", padding: "0 0.25rem" }}>
									搜索结果 ({searchResults.length}):
								</span>
								{searching ? (
									<div style={{ textAlign: "center", padding: "1.5rem 0", fontSize: "0.8rem", color: "var(--muted-text)" }}>
										检索中...
									</div>
								) : searchResults.length === 0 ? (
									<div style={{ textAlign: "center", padding: "1.5rem 0", fontSize: "0.8rem", color: "var(--muted-text)" }}>
										未找到匹配的文档
									</div>
								) : (
									searchResults.map((item) => (
										<div
											key={item.documentId}
											onClick={() => {
												navigate(`/knowledge/${libraryId}/docs/${item.documentId}`);
												setSearchQuery("");
												setSearchResults([]);
											}}
											className="kb-tree-node"
											style={{ flexDirection: "column", alignItems: "flex-start", gap: "0.2rem" }}
										>
											<div style={{ fontWeight: 700, color: "var(--deep-text)" }}>{item.title}</div>
											<div style={{ fontSize: "0.72rem", color: "var(--muted-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
												{item.excerpt}
											</div>
										</div>
									))
								)}
							</div>
						) : treeLoading ? (
							<div style={{ display: "flex", justifyContent: "center", padding: "2rem 0" }}>
								<RefreshCw size={20} className="kb-spin" style={{ color: "var(--primary)" }} />
							</div>
						) : treeNodes.length === 0 ? (
							<div style={{ textAlign: "center", padding: "2.5rem 1rem", fontSize: "0.8rem", color: "var(--muted-text)" }}>
								知识库尚无文档，点击上方按钮创建
							</div>
						) : (
							renderTreeNodes(null)
						)}
					</div>

					{/* 侧边栏底部 */}
					<div className="kb-sidebar-footer">
						<Link to="/" className="kb-sidebar-footer-link">
							<ArrowLeft size={13} />
							<span>返回博客前台</span>
						</Link>
						<span style={{ fontSize: "0.72rem", color: "var(--muted-text)" }}>Firefly Docs</span>
					</div>
				</aside>

				{/* ------------------------------------------------------------ */}
				{/* 中间核心工作区：文档画布与沉浸式编辑器 */}
				{/* ------------------------------------------------------------ */}
				<main className="kb-workspace-canvas">
					{docLoading ? (
						<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
							<RefreshCw size={28} className="kb-spin" style={{ color: "var(--primary)" }} />
						</div>
					) : docError ? (
						<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "2rem", textAlign: "center" }}>
							<AlertTriangle size={36} style={{ color: "#ef4444", marginBottom: "0.75rem" }} />
							<p style={{ fontWeight: 600, color: "var(--deep-text)" }}>{docError}</p>
						</div>
					) : !currentDoc ? (
						<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "2rem", textAlign: "center", color: "var(--muted-text)" }}>
							<BookOpen size={48} style={{ opacity: 0.25, marginBottom: "1rem" }} />
							<p style={{ fontSize: "1rem", fontWeight: 600, color: "var(--deep-text)" }}>从左侧选择一篇笔记开始整理</p>
							<p style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>支持 Markdown 语法、历史不可变版本追溯与公开快照发布</p>
						</div>
					) : (
						<>
							{/* 文档头部元信息与标题 */}
							<div className="kb-doc-canvas-header">
								<div className="kb-doc-title-row">
									<div className="relative">
										<button
											type="button"
											className="kb-doc-emoji-btn"
											onClick={() => setShowEmojiPicker(!showEmojiPicker)}
											title="更换文档图标"
										>
											{docEmoji}
										</button>
										{showEmojiPicker && (
											<div
												style={{
													position: "absolute",
													top: "calc(100% + 0.4rem)",
													left: 0,
													background: "var(--card-bg-solid)",
													border: "1px solid var(--line)",
													borderRadius: "0.75rem",
													padding: "0.5rem",
													display: "grid",
													gridTemplateColumns: "repeat(4, 1fr)",
													gap: "0.35rem",
													boxShadow: "0 10px 25px rgb(0 0 0 / 0.15)",
													zIndex: 50,
												}}
											>
												{EMOJI_OPTIONS.map((emoji) => (
													<button
														key={emoji}
														type="button"
														style={{
															fontSize: "1.2rem",
															background: "transparent",
															border: 0,
															cursor: "pointer",
															padding: "0.3rem",
															borderRadius: "0.4rem",
														}}
														onClick={() => {
															setDocEmoji(emoji);
															setShowEmojiPicker(false);
														}}
													>
														{emoji}
													</button>
												))}
											</div>
										)}
									</div>

									<input
										type="text"
										className="kb-doc-title-input"
										placeholder="输入文档标题..."
										value={editTitle}
										onChange={(e) => handleTitleChange(e.target.value)}
										maxLength={255}
									/>
								</div>

								{/* 文档元信息与标签 */}
								<div className="kb-meta-strip">
									<div className="kb-meta-item">
										<Clock size={13} />
										<span>修改于 {currentDoc.updatedAt.slice(0, 16)}</span>
									</div>
									<span>·</span>
									<div className="kb-meta-item">
										<span>{wordStats.total} 字符</span>
									</div>
									<span>·</span>
									<div className="kb-meta-item">
										<span>阅读约 {wordStats.readingTime} 分钟</span>
									</div>
								</div>

								{/* 标签栏 */}
								<div className="kb-tags-strip">
									<Tag size={13} style={{ color: "var(--muted-text)", marginRight: "0.15rem" }} />
									{editTags.map((tag) => (
										<span key={tag} className="kb-tag-pill">
											#{tag}
											<button
												type="button"
												className="kb-tag-del-btn"
												onClick={() => handleRemoveTag(tag)}
												title="删除标签"
											>
												<X size={10} />
											</button>
										</span>
									))}
									<input
										type="text"
										className="kb-tag-add-input"
										placeholder="+ 标签..."
										value={newTagInput}
										onChange={(e) => setNewTagInput(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleAddTag();
											}
										}}
									/>
								</div>
							</div>

							{/* Vue 桥接 Markdown 编辑器容器 */}
							<div className="kb-editor-wrap">
								<MdEditorBridge
									value={editMarkdown}
									onChange={handleContentChange}
									onUploadImage={handleUploadAttachment}
									preview={viewMode !== "edit"}
									subfield={viewMode === "split"}
									theme={isDark ? "dark" : "light"}
									previewTheme="github"
									noBorder={true}
									placeholder="开始记录你的知识与思考... (支持 Markdown 语法与图片拖拽粘贴)"
								/>
							</div>
						</>
					)}
				</main>

				{/* ------------------------------------------------------------ */}
				{/* 右侧检查器抽屉：大纲、版本追溯、附件与评论 */}
				{/* ------------------------------------------------------------ */}
				{rightTab && currentDoc && (
					<aside className="kb-workspace-inspector">
						<div className="kb-inspector-header">
							<div className="kb-inspector-tabs">
								<button
									type="button"
									className={`kb-tab-pill ${rightTab === "toc" ? "is-active" : ""}`}
									onClick={() => setRightTab("toc")}
								>
									大纲
								</button>
								<button
									type="button"
									className={`kb-tab-pill ${rightTab === "revisions" ? "is-active" : ""}`}
									onClick={() => setRightTab("revisions")}
								>
									历史
								</button>
								<button
									type="button"
									className={`kb-tab-pill ${rightTab === "attachments" ? "is-active" : ""}`}
									onClick={() => setRightTab("attachments")}
								>
									附件
								</button>
								<button
									type="button"
									className={`kb-tab-pill ${rightTab === "comments" ? "is-active" : ""}`}
									onClick={() => setRightTab("comments")}
								>
									讨论
								</button>
							</div>

							<button
								type="button"
								onClick={() => setRightTab(null)}
								className="kb-icon-btn"
								style={{ width: "1.75rem", height: "1.75rem" }}
							>
								<X size={14} />
							</button>
						</div>

						<div className="kb-inspector-body">
							{/* 大纲 Tab */}
							{rightTab === "toc" && (
								tableOfContents.length === 0 ? (
									<div style={{ textAlign: "center", padding: "2.5rem 0", color: "var(--muted-text)", fontSize: "0.8rem" }}>
										在正文中使用 # 标题可自动生成大纲
									</div>
								) : (
									<ul className="kb-outline-list">
										{tableOfContents.map((item, index) => (
											<li
												key={index}
												style={{ paddingLeft: `${(item.level - 1) * 12}px` }}
												className="kb-outline-item"
												onClick={() => handleHeadingClick(item.text)}
												title={`跳转至: ${item.text}`}
											>
												<span className="kb-outline-dot" />
												<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
													{item.text}
												</span>
											</li>
										))}
									</ul>
								)
							)}

							{/* 版本历史 Tab */}
							{rightTab === "revisions" && (
								<div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
									<p style={{ margin: 0, fontSize: "0.75rem", color: "var(--muted-text)" }}>
										每次内容保存自动生成不可变 Revision，支持随时恢复。
									</p>
									<div className="kb-revisions-timeline">
										{revisions.map((rev, index) => {
											const prevRev = revisions[index + 1];
											const diffBytes = prevRev ? rev.byteSize - prevRev.byteSize : 0;
											return (
												<div key={rev.id} className="kb-revision-card">
													<span className="kb-revision-node" />
													<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
														<div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
															<span style={{ fontWeight: 700, fontFamily: "monospace" }}>v{rev.version}</span>
															{diffBytes > 0 && <span className="kb-diff-badge is-add">+{diffBytes} B</span>}
															{diffBytes < 0 && <span className="kb-diff-badge is-del">{diffBytes} B</span>}
															{diffBytes === 0 && <span className="kb-diff-badge is-same">0 B</span>}
														</div>
														<span style={{ fontSize: "0.7rem", color: "var(--muted-text)" }}>
															{rev.createdAt.slice(5, 16)}
														</span>
													</div>
													<div style={{ color: "var(--muted-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
														{rev.title}
													</div>
													<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: "0.25rem", borderTop: "1px solid var(--line)" }}>
														<span style={{ fontSize: "0.7rem", color: "var(--muted-text)" }}>
															{(rev.byteSize / 1024).toFixed(1)} KB
														</span>
														<div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
															<button
																type="button"
																onClick={() => handleOpenDiff(rev)}
																className="kb-btn kb-btn-outline kb-btn-xs"
																title="查看与当前内容的变动对比 (Diff)"
															>
																<GitCompare size={12} />
																<span>对比</span>
															</button>
															{rev.version !== currentVersion ? (
																<button
																	type="button"
																	onClick={() => handleRestoreRevision(rev)}
																	className="kb-btn kb-btn-outline kb-btn-xs"
																>
																	恢复此版
																</button>
															) : (
																<span style={{ fontSize: "0.7rem", color: "var(--primary)", fontWeight: 700 }}>
																	当前版本
																</span>
															)}
														</div>
													</div>
												</div>
											);
										})}
									</div>
								</div>
							)}

							{/* 附件管理 Tab */}
							{rightTab === "attachments" && (
								<div>
									<label className="kb-dropzone">
										<Upload size={20} style={{ color: "var(--primary)" }} />
										<span>{uploadingAttachment ? "正在上传..." : "点击或拖拽上传附件 (最大 10MB)"}</span>
										<input
											type="file"
											style={{ display: "none" }}
											disabled={uploadingAttachment}
											onChange={async (e) => {
												const file = e.target.files?.[0];
												if (file) {
													await handleUploadAttachment(file);
													e.target.value = "";
												}
											}}
										/>
									</label>

									<div>
										{attachments.map((att) => (
											<div key={att.id} className="kb-attachment-card">
												<div style={{ overflow: "hidden", flex: 1 }}>
													<div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={att.filename}>
														{att.filename}
													</div>
													<div style={{ fontSize: "0.7rem", color: "var(--muted-text)" }}>
														{(att.byteSize / 1024).toFixed(1)} KB
													</div>
												</div>
												<button
													type="button"
													onClick={() => {
														const mdLink = `[${att.filename}](/api/knowledge/attachments/${att.id})`;
														// [427] 非 HTTPS/未授权环境 writeText 会 reject：失败时提示而不是假报“已复制”
														void copyTextToClipboard(mdLink).then((ok) => {
															if (!ok) {
																alert("复制失败：请手动选中链接复制");
																return;
															}
															setCopiedAttachmentId(att.id);
															setTimeout(() => setCopiedAttachmentId(null), 2000);
														});
													}}
													className="kb-icon-btn"
													style={{ width: "1.75rem", height: "1.75rem" }}
													title="复制 Markdown 引用链接"
												>
													{copiedAttachmentId === att.id ? (
														<Check size={13} style={{ color: "var(--primary)" }} />
													) : (
														<Copy size={13} />
													)}
												</button>
											</div>
										))}
									</div>
								</div>
							)}

							{/* 内部工作讨论 Tab */}
							{rightTab === "comments" && (
								<div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
									<form onSubmit={handleAddComment} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
										<textarea
											className="kb-textarea"
											style={{ minHeight: "4rem", fontSize: "0.8rem" }}
											placeholder="发表内部工作沟通与备忘..."
											value={commentBody}
											onChange={(e) => setCommentBody(e.target.value)}
											maxLength={5000}
											required
										/>
										<button
											type="submit"
											disabled={submittingComment || !commentBody.trim()}
											className="kb-btn kb-btn-primary kb-btn-sm"
											style={{ width: "100%" }}
										>
											{submittingComment ? "发表中..." : "发表评论"}
										</button>
									</form>

									{commentsLoading ? (
										<div style={{ textAlign: "center", padding: "1.5rem 0", color: "var(--muted-text)", fontSize: "0.8rem" }}>
											加载中...
										</div>
									) : comments.length === 0 ? (
										<div style={{ textAlign: "center", padding: "2rem 0", color: "var(--muted-text)", fontSize: "0.8rem" }}>
											暂无工作评论，协作者可在此交流
										</div>
									) : (
										<div>
											{comments.map((c) => (
												<div key={c.id} className={`kb-comment-card ${c.resolvedAt ? "is-resolved" : ""}`}>
													<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
														<span style={{ fontWeight: 700, color: "var(--primary)" }}>{c.authorName}</span>
														<span style={{ fontSize: "0.7rem", color: "var(--muted-text)" }}>
															{c.createdAt.slice(5, 16)}
														</span>
													</div>
													<p style={{ margin: 0, whiteSpace: "pre-wrap", textDecoration: c.resolvedAt ? "line-through" : "none" }}>
														{c.body}
													</p>
													<div style={{ display: "flex", justifyContent: "flex-end" }}>
														<button
															type="button"
															onClick={() => handleToggleResolve(c)}
															className={`kb-btn kb-btn-xs ${c.resolvedAt ? "kb-btn-ghost" : "kb-btn-outline"}`}
														>
															{c.resolvedAt ? "已解决" : "标记为解决"}
														</button>
													</div>
												</div>
											))}
										</div>
									)}
								</div>
							)}
						</div>
					</aside>
				)}
			</div>

			{/* ============================================================== */}
			{/* 3. 弹窗群：409 版本冲突解决弹窗 */}
			{/* ============================================================== */}
			{conflictData && (
				<div className="kb-modal-overlay">
					<div className="kb-modal-card max-w-2xl">
						<div className="kb-modal-header">
							<h3 className="kb-modal-title" style={{ color: "#ef4444" }}>
								<AlertTriangle size={20} />
								检测到版本冲突 (409 Conflict)
							</h3>
						</div>
						<p style={{ fontSize: "0.8rem", color: "var(--muted-text)", margin: "0 0 1rem 0" }}>
							该文档在其他窗口或设备已被更新至新版本。为防止覆盖他人内容，请选择处理方式：
						</p>

						<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem", fontFamily: "monospace", fontSize: "0.75rem" }}>
							<div style={{ border: "1px solid var(--line)", borderRadius: "0.75rem", padding: "0.75rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)" }}>
								<span style={{ fontWeight: 700, color: "var(--primary)", display: "block", marginBottom: "0.35rem" }}>
									服务端版本 (v{conflictData.serverDoc?.version})
								</span>
								<div style={{ maxHeight: "10rem", overflowY: "auto", whiteSpace: "pre-wrap", color: "var(--muted-text)" }}>
									{conflictData.serverDoc?.markdown}
								</div>
							</div>
							<div style={{ border: "1px solid var(--line)", borderRadius: "0.75rem", padding: "0.75rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)" }}>
								<span style={{ fontWeight: 700, color: "#f59e0b", display: "block", marginBottom: "0.35rem" }}>
									本地草稿内容
								</span>
								<div style={{ maxHeight: "10rem", overflowY: "auto", whiteSpace: "pre-wrap", color: "var(--muted-text)" }}>
									{conflictData.localContent}
								</div>
							</div>
						</div>

						<div className="kb-modal-footer">
							<button
								type="button"
								onClick={() => {
									if (conflictData.serverDoc) {
										const serverDoc = conflictData.serverDoc;
										setEditTitle(serverDoc.title);
										setEditMarkdown(serverDoc.markdown);
										setCurrentVersion(serverDoc.version);
										// [426] 标签也要同步：否则本地旧标签会在下一次保存时覆盖服务端
										setEditTags(serverDoc.tags ?? []);
										setCurrentDoc(serverDoc);
										setSaveStatus("saved");
									}
									setConflictData(null);
								}}
								className="kb-btn kb-btn-outline kb-btn-sm"
							>
								拉取服务端版本 (放弃本地)
							</button>

							<button
								type="button"
								onClick={() => {
									if (conflictData.serverDoc) {
										setCurrentVersion(conflictData.serverDoc.version);
										setSaveStatus("dirty");
									}
									setConflictData(null);
								}}
								className="kb-btn kb-btn-primary kb-btn-sm"
							>
								基于新版本强制覆盖提交
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ============================================================== */}
			{/* 4. 弹窗群：受限只读分享弹窗 */}
			{/* ============================================================== */}
			{shareModalOpen && currentDoc && (
				<div className="kb-modal-overlay">
					<div className="kb-modal-card">
						<div className="kb-modal-header">
							<h3 className="kb-modal-title">
								<Share2 size={18} style={{ color: "var(--primary)" }} />
								受限只读分享
							</h3>
							<button
								type="button"
								onClick={() => {
									setShareModalOpen(false);
									setNewShareToken(null);
									setCopiedShareLink(false);
								}}
								className="kb-icon-btn"
							>
								<X size={16} />
							</button>
						</div>

						<p style={{ fontSize: "0.8rem", color: "var(--muted-text)", margin: "0 0 1rem 0" }}>
							生成高熵只读访问 Token，获取链接者可在有效期内免登录只读访问该文档。
						</p>

						<div style={{ padding: "0.85rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)", borderRadius: "0.75rem", border: "1px solid var(--line)", marginBottom: "1rem" }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
								<div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem" }}>
									<span>有效期:</span>
									<select
										className="kb-select"
										style={{ width: "auto", padding: "0.25rem 0.5rem", fontSize: "0.8rem" }}
										value={shareExpiryDays}
										onChange={(e) => setShareExpiryDays(Number(e.target.value))}
										disabled={shareActionLoading}
									>
										<option value={1}>1 天</option>
										<option value={7}>7 天</option>
										<option value={30}>30 天</option>
									</select>
								</div>
								<button
									type="button"
									onClick={handleCreateShareLink}
									disabled={shareActionLoading}
									className="kb-btn kb-btn-primary kb-btn-sm"
								>
									{shareActionLoading ? "生成中..." : "生成新链接"}
								</button>
							</div>

							{newShareToken && (
								<div style={{ marginTop: "0.75rem", padding: "0.6rem", background: "color-mix(in srgb, var(--primary) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 30%, transparent)", borderRadius: "0.55rem" }}>
									<div style={{ fontSize: "0.75rem", color: "var(--primary)", fontWeight: 600, marginBottom: "0.35rem" }}>
										链接生成成功（仅在此展示一次）：
									</div>
									<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
										<input
											type="text"
											readOnly
											value={`${window.location.origin}/ks/${newShareToken}`}
											className="kb-input"
											style={{ fontSize: "0.75rem", padding: "0.35rem 0.55rem", fontFamily: "monospace" }}
										/>
										<button
											type="button"
											onClick={() => {
												// [427] 同上：剪贴板写入失败时不显示“已复制”
												void copyTextToClipboard(`${window.location.origin}/ks/${newShareToken}`).then((ok) => {
													if (!ok) {
														alert("复制失败：请手动选中链接复制");
														return;
													}
													setCopiedShareLink(true);
													setTimeout(() => setCopiedShareLink(false), 2000);
												});
											}}
											className="kb-btn kb-btn-primary kb-btn-sm"
										>
											{copiedShareLink ? <Check size={13} /> : <Copy size={13} />}
											<span>{copiedShareLink ? "已复制" : "复制"}</span>
										</button>
									</div>
								</div>
							)}
						</div>

						{/* 现有链接列表 */}
						<div>
							<div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--deep-text)", marginBottom: "0.5rem" }}>
								已生成的有效分享链接:
							</div>
							{shareLinksLoading ? (
								<div style={{ textAlign: "center", padding: "1.5rem 0", fontSize: "0.8rem", color: "var(--muted-text)" }}>
									加载中...
								</div>
							) : shareLinks.length === 0 ? (
								<div style={{ textAlign: "center", padding: "1.5rem 0", fontSize: "0.8rem", color: "var(--muted-text)" }}>
									当前暂无活跃的分享链接
								</div>
							) : (
								<div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "10rem", overflowY: "auto" }}>
									{shareLinks.map((link) => (
										<div
											key={link.id}
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												padding: "0.5rem 0.75rem",
												borderRadius: "0.55rem",
												border: "1px solid var(--line)",
												background: "color-mix(in srgb, var(--card-bg-solid) 60%, transparent)",
												fontSize: "0.75rem",
											}}
										>
											<div style={{ overflow: "hidden", marginRight: "0.5rem" }}>
												<div style={{ fontFamily: "monospace" }}>分享 #{link.id} · 创建于 {link.createdAt.slice(0, 16)}</div>
												<div style={{ color: "var(--muted-text)", fontSize: "0.7rem" }}>
													到期时间: {link.expiresAt ? link.expiresAt.slice(0, 16) : "永久有效"}
												</div>
											</div>
											<button
												type="button"
												onClick={() => handleRevokeShareLink(link.id)}
												className="kb-btn kb-btn-danger kb-btn-xs"
											>
												作废
											</button>
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			{/* ============================================================== */}
			{/* 5. 弹窗群：公开快照发布弹窗 */}
			{/* ============================================================== */}
			{publishModalOpen && currentDoc && (
				<div className="kb-modal-overlay">
					<div className="kb-modal-card">
						<div className="kb-modal-header">
							<h3 className="kb-modal-title">
								<Globe size={18} style={{ color: "var(--primary)" }} />
								公开快照发布
							</h3>
							<button
								type="button"
								onClick={() => {
									setPublishModalOpen(false);
									setCopiedPublishLink(false);
								}}
								className="kb-icon-btn"
							>
								<X size={16} />
							</button>
						</div>

						<div style={{ padding: "0.75rem 1rem", borderRadius: "0.75rem", background: "color-mix(in srgb, #3b82f6 10%, transparent)", border: "1px solid color-mix(in srgb, #3b82f6 25%, transparent)", fontSize: "0.78rem", color: "var(--deep-text)", marginBottom: "1rem" }}>
							<p style={{ margin: "0 0 0.25rem 0", fontWeight: 700 }}>草稿与快照彻底隔离说明：</p>
							<p style={{ margin: 0, color: "var(--muted-text)" }}>
								公开发布后，系统将把当前版本 (v{currentDoc.version}) 冻结为公开不可变快照。您后续在工作台中继续编辑草稿、保存修改均不会直接影响已公开内容。
							</p>
						</div>

						<div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", fontSize: "0.8rem" }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem", borderRadius: "0.65rem", background: "color-mix(in srgb, var(--card-bg-solid) 70%, transparent)", border: "1px solid var(--line)" }}>
								<div>
									<div style={{ fontWeight: 600 }}>当前发布状态</div>
									<div style={{ fontSize: "0.72rem", color: "var(--muted-text)" }}>
										{currentDoc.publishedRevisionId
											? `已发布快照 (关联版本 ID: ${currentDoc.publishedRevisionId})`
											: "当前未公开发布（草稿私密）"}
									</div>
								</div>
								<span className={`kb-status-capsule ${currentDoc.publishedRevisionId ? "is-saved" : ""}`}>
									{currentDoc.publishedRevisionId ? "已上线" : "未发布"}
								</span>
							</div>

							{currentDoc.publishedRevisionId && (
								<div style={{ padding: "0.75rem", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)", borderRadius: "0.65rem", border: "1px solid var(--line)" }}>
									<div style={{ fontSize: "0.75rem", fontWeight: 600, marginBottom: "0.4rem" }}>公开阅读地址:</div>
									<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
										<input
											type="text"
											readOnly
											value={`${window.location.origin}/k/${libraryId}/${currentDoc.id}`}
											className="kb-input"
											style={{ fontSize: "0.75rem", padding: "0.35rem 0.55rem", fontFamily: "monospace" }}
										/>
										<button
											type="button"
											onClick={() => {
												// [427] 同上：剪贴板写入失败时不显示“已复制”
												void copyTextToClipboard(
													`${window.location.origin}/k/${libraryId}/${currentDoc.id}`,
												).then((ok) => {
													if (!ok) {
														alert("复制失败：请手动选中链接复制");
														return;
													}
													setCopiedPublishLink(true);
													setTimeout(() => setCopiedPublishLink(false), 2000);
												});
											}}
											className="kb-btn kb-btn-primary kb-btn-sm"
										>
											{copiedPublishLink ? <Check size={13} /> : <Copy size={13} />}
											<span>{copiedPublishLink ? "已复制" : "复制"}</span>
										</button>
										<a
											href={`/k/${libraryId}/${currentDoc.id}`}
											target="_blank"
											rel="noopener noreferrer"
											className="kb-btn kb-btn-outline kb-btn-sm"
											title="新标签页打开预览"
										>
											<Eye size={13} />
										</a>
									</div>
								</div>
							)}

							<div className="kb-modal-footer">
								{currentDoc.publishedRevisionId && (
									<button
										type="button"
										onClick={handleUnpublishSnapshot}
										disabled={publishing}
										className="kb-btn kb-btn-danger kb-btn-sm"
									>
										撤回公开快照
									</button>
								)}
								<button
									type="button"
									onClick={handlePublishSnapshot}
									disabled={publishing}
									className="kb-btn kb-btn-primary kb-btn-sm"
								>
									{publishing
										? "发布中..."
										: currentDoc.publishedRevisionId
											? "更新公开快照至当前版本"
											: "发布当前版本为公开快照"}
								</button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* ============================================================== */}
			{/* 6. 历史版本对比 (Diff) 弹窗 */}
			{/* ============================================================== */}
			{diffModalRev && (
				<div className="kb-modal-overlay">
					<div className="kb-modal-card max-w-2xl">
						<div className="kb-modal-header">
							<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
								<History size={18} style={{ color: "var(--primary)" }} />
								<h3 className="kb-modal-title">
									版本对比：v{diffModalRev.rev.version} 与当前草稿
								</h3>
							</div>
							<button type="button" onClick={() => setDiffModalRev(null)} className="kb-icon-btn">
								<X size={16} />
							</button>
						</div>

						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem", fontSize: "0.75rem", color: "var(--muted-text)" }}>
							<div>
								版本生成时间: {diffModalRev.rev.createdAt.slice(0, 16)} · 大小: {(diffModalRev.rev.byteSize / 1024).toFixed(1)} KB
							</div>
							<div className="kb-segmented-group">
								<button
									type="button"
									className={`kb-segmented-item ${diffViewMode === "diff" ? "is-active" : ""}`}
									onClick={() => setDiffViewMode("diff")}
								>
									差异变动 (Diff)
								</button>
								<button
									type="button"
									className={`kb-segmented-item ${diffViewMode === "preview" ? "is-active" : ""}`}
									onClick={() => setDiffViewMode("preview")}
								>
									历史正文
								</button>
							</div>
						</div>

						{diffModalRev.loading ? (
							<div style={{ textAlign: "center", padding: "3rem 0" }}>
								<RefreshCw size={24} className="kb-spin" style={{ color: "var(--primary)" }} />
								<p style={{ fontSize: "0.8rem", color: "var(--muted-text)", marginTop: "0.5rem" }}>加载版本详情中...</p>
							</div>
						) : (
							<>
								{diffModalRev.detail && diffModalRev.detail.title !== editTitle && (
									<div style={{ padding: "0.5rem 0.75rem", borderRadius: "0.5rem", background: "color-mix(in srgb, #f59e0b 10%, transparent)", border: "1px solid color-mix(in srgb, #f59e0b 30%, transparent)", fontSize: "0.78rem", marginBottom: "0.75rem" }}>
										<strong>标题改动：</strong>
										<span style={{ textDecoration: "line-through", color: "#ef4444", marginRight: "0.5rem" }}>{diffModalRev.detail.title}</span>
										➔
										<span style={{ color: "#10b981", marginLeft: "0.5rem", fontWeight: 700 }}>{editTitle}</span>
									</div>
								)}

								{diffViewMode === "diff" ? (
									<div className="kb-diff-viewer">
										{computeSimpleDiff(diffModalRev.detail?.markdown || "", editMarkdown).map((line, idx) => (
											<div key={idx} className={`kb-diff-line is-${line.type}`}>
												<span className="kb-diff-sign">
													{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
												</span>
												<span className="kb-diff-content">{line.text || " "}</span>
											</div>
										))}
									</div>
								) : (
									<div style={{ padding: "1rem", borderRadius: "0.75rem", border: "1px solid var(--line)", background: "color-mix(in srgb, var(--card-bg-solid) 80%, transparent)", maxHeight: "25rem", overflowY: "auto", fontFamily: "monospace", fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>
										{diffModalRev.detail?.markdown}
									</div>
								)}

								<div className="kb-modal-footer">
									{diffModalRev.rev.version !== currentVersion && (
										<button
											type="button"
											onClick={() => {
												handleRestoreRevision(diffModalRev.rev);
												setDiffModalRev(null);
											}}
											className="kb-btn kb-btn-primary kb-btn-sm"
										>
											恢复至此历史版本 (v{diffModalRev.rev.version})
										</button>
									)}
									<button
										type="button"
										onClick={() => setDiffModalRev(null)}
										className="kb-btn kb-btn-outline kb-btn-sm"
									>
										关闭
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
