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
	Copy,
	Download,
	FileText,
	Folder,
	FolderPlus,
	History,
	Menu,
	Paperclip,
	Plus,
	RefreshCw,
	Save,
	Search,
	Settings,
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
	LibrarySummary,
	RevisionSummary,
	SearchResultItem,
	TreeNode,
} from "./types";

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

	// 当前打开的文档详情
	const [currentDoc, setCurrentDoc] = useState<DocumentDetail | null>(null);
	const [docLoading, setDocLoading] = useState(false);
	const [docError, setDocError] = useState<string | null>(null);

	// 编辑状态
	const [editTitle, setEditTitle] = useState("");
	const [editMarkdown, setEditMarkdown] = useState("");
	const [editTags, setEditTags] = useState<string[]>([]);
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

	// 侧边栏与抽屉响应式控制
	const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
	const [rightTab, setRightTab] = useState<"toc" | "revisions" | "attachments" | null>("toc");

	// 历史版本与附件
	const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
	const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
	const [uploadingAttachment, setUploadingAttachment] = useState(false);

	// 搜索弹窗
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
	const [searching, setSearching] = useState(false);

	// 展开的文件夹 ID 集合
	const [expandedFolders, setExpandedFolders] = useState<Set<number>>(new Set());

	// 自动保存定时器
	const autoSaveTimerRef = useRef<number | null>(null);
	const lastSaveTimeRef = useRef<number>(Date.now());

	// 1. 加载库信息与目录树
	const loadLibraryAndTree = useCallback(async () => {
		if (!libraryId) return;
		try {
			const [lib, tree] = await Promise.all([
				kbApi.getLibrary(libraryId),
				kbApi.getLibraryTree(libraryId),
			]);
			setLibrary(lib);
			setTreeNodes(tree);

			// 默认展开所有一级文件夹
			const initialExpanded = new Set<number>();
			for (const node of tree) {
				if (node.kind === "folder") initialExpanded.add(node.id);
			}
			setExpandedFolders(initialExpanded);

			// 如果没有选中任何文档，且树中有文档，自动跳转第一篇
			if (!activeDocId && tree.length > 0) {
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
	}, [libraryId, activeDocId, navigate]);

	useEffect(() => {
		loadLibraryAndTree();
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

			// 同步加载其历史版本与附件
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

	// 3. 保存逻辑 (手动或自动保存)
	const performSave = useCallback(
		async (isManual = false) => {
			if (!activeDocId || !currentDoc || saveStatus === "saving") return;

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

					// 重新刷新版本历史与目录树标题
					if (result.status === "saved") {
						kbApi.getRevisions(activeDocId).then(setRevisions).catch(() => undefined);
						setTreeNodes((prev) =>
							prev.map((n) => (n.id === activeDocId ? { ...n, title: editTitle, version: result.version } : n)),
						);
					}
				}
			} catch (err) {
				if (err instanceof KbApiError && err.status === 409) {
					// 409 版本冲突！弹出冲突解决弹窗
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
				}
			}
		},
		[activeDocId, currentDoc, currentVersion, editMarkdown, editTags, editTitle, saveStatus],
	);

	// 4. 输入变更处理与自动保存 Debounce
	const handleContentChange = (nextMarkdown: string) => {
		setEditMarkdown(nextMarkdown);
		setSaveStatus("dirty");

		if (autoSaveTimerRef.current) {
			window.clearTimeout(autoSaveTimerRef.current);
		}

		// 规则：停止输入 2 秒触发保存，或距离上次保存超过 15 秒强制保存
		const timeSinceLastSave = Date.now() - lastSaveTimeRef.current;
		const delay = timeSinceLastSave > 15000 ? 500 : 2000;

		autoSaveTimerRef.current = window.setTimeout(() => {
			performSave(false);
		}, delay);
	};

	const handleTitleChange = (nextTitle: string) => {
		setEditTitle(nextTitle);
		setSaveStatus("dirty");

		if (autoSaveTimerRef.current) {
			window.clearTimeout(autoSaveTimerRef.current);
		}
		autoSaveTimerRef.current = window.setTimeout(() => {
			performSave(false);
		}, 2000);
	};

	// 5. 新建文档或文件夹
	const handleCreateItem = async (kind: "document" | "folder", parentId: number | null = null) => {
		const title = prompt(kind === "folder" ? "请输入新建文件夹名称：" : "请输入新建文档标题：");
		if (!title?.trim()) return;

		try {
			const newDoc = await kbApi.createDocument({
				libraryId,
				parentId,
				kind,
				title: title.trim(),
				markdown: kind === "document" ? `# ${title.trim()}\n\n开始撰写...` : "",
			});

			await loadLibraryAndTree();
			if (kind === "document") {
				navigate(`/knowledge/${libraryId}/docs/${newDoc.id}`);
			}
		} catch (err) {
			alert(err instanceof Error ? err.message : "创建失败");
		}
	};

	// 6. 删除到回收站
	const handleDeleteDoc = async (docId: number) => {
		if (!confirm("确定要将此项移入回收站吗？（可在设置中随时恢复）")) return;
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
		try {
			const res = await kbApi.restoreRevision(currentDoc!.id, rev.id, currentVersion);
			setCurrentVersion(res.version);
			await loadDocumentContent(currentDoc!.id);
			alert(`已成功恢复为最新版本 v${res.version}`);
		} catch (err) {
			alert(err instanceof Error ? err.message : "恢复版本失败");
		}
	};

	// 8. 附件上传
	const handleUploadAttachment = async (file: File) => {
		if (!activeDocId) return "";
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

	// 10. 解析大纲 (TOC)
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

	// 目录树递归渲染
	const renderTreeNodes = (parentId: number | null = null, depth = 0) => {
		const nodes = treeNodes.filter((n) => n.parentId === parentId);
		if (nodes.length === 0) return null;

		return (
			<ul className={`space-y-0.5 ${depth > 0 ? "pl-3 ml-2 border-l border-base-content/10" : ""}`}>
				{nodes.map((node) => {
					const isFolder = node.kind === "folder";
					const isExpanded = expandedFolders.has(node.id);
					const isActive = node.id === activeDocId;

					return (
						<li key={node.id} className="text-sm">
							<div
								className={`group flex items-center justify-between px-2 py-1.5 rounded-lg transition-colors cursor-pointer ${
									isActive
										? "bg-primary text-primary-content font-medium"
										: "hover:bg-base-200/80 text-base-content/85"
								}`}
							>
								<div
									className="flex items-center gap-1.5 flex-1 min-w-0"
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
											setLeftDrawerOpen(false);
										}
									}}
								>
									{isFolder ? (
										<>
											{isExpanded ? (
												<ChevronDown className="w-3.5 h-3.5 opacity-60 shrink-0" />
											) : (
												<ChevronRight className="w-3.5 h-3.5 opacity-60 shrink-0" />
											)}
											<Folder className="w-4 h-4 text-warning shrink-0" />
										</>
									) : (
										<FileText className="w-4 h-4 opacity-70 shrink-0" />
									)}
									<span className="truncate select-none">{node.title || "未命名"}</span>
								</div>

								{/* 节点操作按键 */}
								<div className="hidden group-hover:flex items-center gap-0.5">
									{isFolder && (
										<button
											type="button"
											className="btn btn-ghost btn-circle btn-xs"
											title="新建子文档"
											onClick={(e) => {
												e.stopPropagation();
												handleCreateItem("document", node.id);
											}}
										>
											<Plus className="w-3.5 h-3.5" />
										</button>
									)}
									<button
										type="button"
										className="btn btn-ghost btn-circle btn-xs text-error/70 hover:text-error"
										title="移入回收站"
										onClick={(e) => {
											e.stopPropagation();
											handleDeleteDoc(node.id);
										}}
									>
										<Trash2 className="w-3.5 h-3.5" />
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
		<div className="flex h-[calc(100vh-4.5rem)] overflow-hidden bg-base-100">
			{/* ============================================================== */}
			{/* 左侧栏：目录树与库导航 */}
			{/* ============================================================== */}
			<aside
				className={`fixed inset-y-0 left-0 z-30 w-72 bg-base-100/95 backdrop-blur-md border-r border-base-content/10 flex flex-col transition-transform duration-300 md:static md:translate-x-0 ${
					leftDrawerOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				{/* 库头部信息 */}
				<div className="p-4 border-b border-base-content/10 flex items-center justify-between">
					<div className="flex items-center gap-2 overflow-hidden">
						<Link to="/knowledge" className="btn btn-ghost btn-circle btn-xs" title="返回知识库列表">
							<ArrowLeft className="w-4 h-4" />
						</Link>
						<span className="font-bold text-base truncate" title={library?.title}>
							{library?.title || "知识库"}
						</span>
					</div>
					<div className="flex items-center gap-1">
						<Link
							to={`/knowledge/${libraryId}/settings`}
							className="btn btn-ghost btn-circle btn-xs"
							title="知识库设置"
						>
							<Settings className="w-4 h-4" />
						</Link>
						<button
							type="button"
							className="btn btn-ghost btn-circle btn-xs md:hidden"
							onClick={() => setLeftDrawerOpen(false)}
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* 快捷操作：新建文档、新建文件夹、搜索 */}
				<div className="p-3 border-b border-base-content/5 space-y-2">
					<div className="grid grid-cols-2 gap-2">
						<button
							type="button"
							onClick={() => handleCreateItem("document", null)}
							className="btn btn-outline btn-xs gap-1.5"
						>
							<Plus className="w-3.5 h-3.5" />
							新文档
						</button>
						<button
							type="button"
							onClick={() => handleCreateItem("folder", null)}
							className="btn btn-outline btn-xs gap-1.5"
						>
							<FolderPlus className="w-3.5 h-3.5" />
							新文件夹
						</button>
					</div>

					<div className="relative">
						<Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/40" />
						<input
							type="text"
							placeholder="库内快速搜索..."
							className="input input-xs input-bordered w-full pl-8"
							value={searchQuery}
							onChange={async (e) => {
								setSearchQuery(e.target.value);
								if (e.target.value.trim().length > 1) {
									setSearching(true);
									const items = await kbApi.search(e.target.value.trim(), libraryId);
									setSearchResults(items);
									setSearching(false);
								} else {
									setSearchResults([]);
								}
							}}
						/>
					</div>
				</div>

				{/* 搜索结果弹层展示或目录树展示 */}
				<div className="flex-1 overflow-y-auto p-3">
					{searchQuery.trim().length > 1 ? (
						<div className="space-y-2">
							<span className="text-xs font-bold text-base-content/50 px-1">搜索结果:</span>
							{searching ? (
								<div className="text-center py-4 text-xs text-base-content/40">检索中...</div>
							) : searchResults.length === 0 ? (
								<div className="text-center py-4 text-xs text-base-content/40">未匹配到相关文档</div>
							) : (
								searchResults.map((item) => (
									<div
										key={item.documentId}
										onClick={() => {
											navigate(`/knowledge/${libraryId}/docs/${item.documentId}`);
											setSearchQuery("");
											setSearchResults([]);
											setLeftDrawerOpen(false);
										}}
										className="p-2 rounded-lg hover:bg-base-200 cursor-pointer text-xs"
									>
										<div className="font-bold text-base-content">{item.title}</div>
										<div className="text-base-content/60 truncate mt-0.5">{item.excerpt}</div>
									</div>
								))
							)}
						</div>
					) : treeLoading ? (
						<div className="flex justify-center py-8">
							<span className="loading loading-spinner loading-sm text-primary" />
						</div>
					) : treeNodes.length === 0 ? (
						<div className="text-center py-8 text-xs text-base-content/40">
							暂无文档，点击上方按钮创建
						</div>
					) : (
						renderTreeNodes(null)
					)}
				</div>
			</aside>

			{/* ============================================================== */}
			{/* 中间编辑工作区 */}
			{/* ============================================================== */}
			<main className="flex-1 flex flex-col min-w-0 bg-base-100 overflow-hidden">
				{/* 顶部工具栏 */}
				<header className="h-12 border-b border-base-content/10 px-4 flex items-center justify-between shrink-0 bg-base-100/60 backdrop-blur">
					<div className="flex items-center gap-2 overflow-hidden">
						<button
							type="button"
							className="btn btn-ghost btn-circle btn-xs md:hidden"
							onClick={() => setLeftDrawerOpen(true)}
						>
							<Menu className="w-4 h-4" />
						</button>

						{currentDoc && (
							<div className="flex items-center gap-2">
								<span className="badge badge-sm font-mono badge-outline">
									v{currentVersion}
								</span>
								<div className="flex items-center gap-1.5 text-xs text-base-content/60">
									{saveStatus === "saved" && (
										<span className="flex items-center gap-1 text-success">
											<Check className="w-3.5 h-3.5" /> 已保存
										</span>
									)}
									{saveStatus === "saving" && (
										<span className="flex items-center gap-1 text-primary">
											<RefreshCw className="w-3.5 h-3.5 animate-spin" /> 保存中...
										</span>
									)}
									{saveStatus === "dirty" && (
										<span className="text-warning">● 未保存更改</span>
									)}
									{saveStatus === "conflict" && (
										<span className="flex items-center gap-1 text-error font-bold">
											<AlertTriangle className="w-3.5 h-3.5" /> 版本冲突
										</span>
									)}
									{saveStatus === "error" && (
										<span className="text-error">{saveError || "保存失败"}</span>
									)}
								</div>
							</div>
						)}
					</div>

					{/* 动作按键组 */}
					{currentDoc && (
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => performSave(true)}
								disabled={saveStatus === "saving" || saveStatus === "saved"}
								className="btn btn-ghost btn-xs gap-1"
								title="手动保存 (Ctrl+S)"
							>
								<Save className="w-3.5 h-3.5" />
								<span className="hidden sm:inline">保存</span>
							</button>

							<button
								type="button"
								onClick={handleExportMarkdown}
								className="btn btn-ghost btn-xs gap-1"
								title="导出为 Markdown"
							>
								<Download className="w-3.5 h-3.5" />
								<span className="hidden sm:inline">导出</span>
							</button>

							<div className="divider divider-horizontal my-1" />

							<button
								type="button"
								onClick={() => setRightTab(rightTab === "toc" ? null : "toc")}
								className={`btn btn-xs ${rightTab === "toc" ? "btn-primary" : "btn-ghost"}`}
								title="大纲"
							>
								大纲
							</button>

							<button
								type="button"
								onClick={() => setRightTab(rightTab === "revisions" ? null : "revisions")}
								className={`btn btn-xs ${rightTab === "revisions" ? "btn-primary" : "btn-ghost"}`}
								title="历史版本"
							>
								<History className="w-3.5 h-3.5" />
							</button>

							<button
								type="button"
								onClick={() => setRightTab(rightTab === "attachments" ? null : "attachments")}
								className={`btn btn-xs ${rightTab === "attachments" ? "btn-primary" : "btn-ghost"}`}
								title="附件"
							>
								<Paperclip className="w-3.5 h-3.5" />
							</button>
						</div>
					)}
				</header>

				{/* 主编辑器区域 */}
				<div className="flex-1 flex min-h-0 overflow-hidden">
					{docLoading ? (
						<div className="flex-1 flex items-center justify-center">
							<span className="loading loading-spinner loading-lg text-primary" />
						</div>
					) : docError ? (
						<div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
							<AlertTriangle className="w-12 h-12 text-error mb-3" />
							<p className="text-base-content/80 font-medium">{docError}</p>
						</div>
					) : !currentDoc ? (
						<div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-base-content/40">
							<BookOpen className="w-16 h-16 mb-4 opacity-30" />
							<p>请从左侧选择或新建一篇文档开始记录</p>
						</div>
					) : (
						<div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
							{/* 标题输入行 */}
							<div className="px-6 pt-4 pb-2 border-b border-base-content/5 shrink-0">
								<input
									type="text"
									className="w-full text-2xl font-extrabold bg-transparent outline-none placeholder:text-base-content/30"
									placeholder="无标题文档..."
									value={editTitle}
									onChange={(e) => handleTitleChange(e.target.value)}
									maxLength={255}
								/>
							</div>

							{/* Vue 桥接 Markdown 编辑器 */}
							<div className="flex-1 min-h-0 relative">
								<MdEditorBridge
									value={editMarkdown}
									onChange={handleContentChange}
									onUploadImage={handleUploadAttachment}
									preview={true}
								/>
							</div>
						</div>
					)}

					{/* ============================================================== */}
					{/* 右侧折叠面板：大纲、版本历史、附件 */}
					{/* ============================================================== */}
					{rightTab && currentDoc && (
						<aside className="w-64 border-l border-base-content/10 flex flex-col bg-base-100/90 shrink-0">
							<div className="p-3 border-b border-base-content/10 flex items-center justify-between text-xs font-bold">
								<span>
									{rightTab === "toc" && "文章大纲"}
									{rightTab === "revisions" && "版本追溯 (不可变快照)"}
									{rightTab === "attachments" && "文档附件"}
								</span>
								<button
									type="button"
									onClick={() => setRightTab(null)}
									className="btn btn-ghost btn-circle btn-xs"
								>
									<X className="w-3.5 h-3.5" />
								</button>
							</div>

							<div className="flex-1 overflow-y-auto p-3 text-xs">
								{/* 大纲 Tab */}
								{rightTab === "toc" && (
									tableOfContents.length === 0 ? (
										<div className="text-center py-8 text-base-content/40">
											在文档中使用 # 标题可自动生成大纲
										</div>
									) : (
										<ul className="space-y-1.5">
											{tableOfContents.map((item, index) => (
												<li
													key={index}
													style={{ paddingLeft: `${(item.level - 1) * 12}px` }}
													className="truncate text-base-content/75 hover:text-primary cursor-pointer"
													title={item.text}
												>
													{item.text}
												</li>
											))}
										</ul>
									)
								)}

								{/* 版本历史 Tab */}
								{rightTab === "revisions" && (
									<div className="space-y-3">
										<p className="text-[11px] text-base-content/50">
											每次内容保存自动生成不可变 Revision，支持一键恢复。
										</p>
										{revisions.map((rev) => (
											<div
												key={rev.id}
												className="p-2.5 rounded-xl border border-base-content/10 bg-base-200/50 space-y-1.5"
											>
												<div className="flex items-center justify-between">
													<span className="font-bold font-mono">v{rev.version}</span>
													<span className="text-[10px] text-base-content/40">
														{rev.createdAt.slice(0, 16)}
													</span>
												</div>
												<div className="text-base-content/70 truncate">{rev.title}</div>
												<div className="flex items-center justify-between pt-1 border-t border-base-content/5">
													<span className="text-[10px] text-base-content/40">
														{(rev.byteSize / 1024).toFixed(1)} KB
													</span>
													{rev.version !== currentVersion && (
														<button
															type="button"
															onClick={() => handleRestoreRevision(rev)}
															className="btn btn-xs btn-outline btn-primary py-0 h-6 min-h-0"
														>
															恢复此版
														</button>
													)}
												</div>
											</div>
										))}
									</div>
								)}

								{/* 附件管理 Tab */}
								{rightTab === "attachments" && (
									<div className="space-y-3">
										<div>
											<label className="btn btn-outline btn-xs w-full gap-1.5 cursor-pointer">
												<Upload className="w-3.5 h-3.5" />
												{uploadingAttachment ? "上传中..." : "上传附件 (最大 10MB)"}
												<input
													type="file"
													className="hidden"
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
										</div>

										<div className="space-y-2">
											{attachments.map((att) => (
												<div
													key={att.id}
													className="p-2 rounded-lg border border-base-content/10 bg-base-200/40 text-xs flex items-center justify-between gap-2"
												>
													<div className="truncate flex-1">
														<div className="truncate font-medium" title={att.filename}>
															{att.filename}
														</div>
														<div className="text-[10px] text-base-content/40">
															{(att.byteSize / 1024).toFixed(1)} KB
														</div>
													</div>
													<button
														type="button"
														onClick={() => {
															const mdLink = `[${att.filename}](/api/knowledge/attachments/${att.id})`;
															navigator.clipboard.writeText(mdLink);
															alert("已复制 Markdown 链接到剪贴板");
														}}
														className="btn btn-ghost btn-circle btn-xs"
														title="复制 Markdown 引用链接"
													>
														<Copy className="w-3.5 h-3.5" />
													</button>
												</div>
											))}
										</div>
									</div>
								)}
							</div>
						</aside>
					)}
				</div>
			</main>

			{/* ============================================================== */}
			{/* A07: 409 版本冲突解决弹窗 */}
			{/* ============================================================== */}
			{conflictData && (
				<div className="modal modal-open backdrop-blur-sm z-50">
					<div className="modal-box max-w-2xl rounded-2xl">
						<h3 className="font-bold text-lg text-error flex items-center gap-2 mb-2">
							<AlertTriangle className="w-5 h-5" />
							检测到版本冲突 (409 Conflict)
						</h3>
						<p className="text-xs text-base-content/70 mb-4">
							该文档在其他窗口或设备已被更新至新版本。为防止覆盖他人内容，请选择处理方式：
						</p>

						<div className="grid grid-cols-2 gap-4 text-xs font-mono mb-4">
							<div className="border border-base-content/20 rounded-xl p-3 bg-base-200/40">
								<span className="font-bold block text-primary mb-1">
									服务端当前版本 (v{conflictData.serverDoc?.version})
								</span>
								<div className="line-clamp-6 text-base-content/70 whitespace-pre-wrap">
									{conflictData.serverDoc?.markdown}
								</div>
							</div>
							<div className="border border-base-content/20 rounded-xl p-3 bg-base-200/40">
								<span className="font-bold block text-warning mb-1">
									您当前编辑内容 (本地草稿)
								</span>
								<div className="line-clamp-6 text-base-content/70 whitespace-pre-wrap">
									{conflictData.localContent}
								</div>
							</div>
						</div>

						<div className="modal-action">
							<button
								type="button"
								onClick={() => {
									// 采用服务端版本覆盖本地
									if (conflictData.serverDoc) {
										setEditTitle(conflictData.serverDoc.title);
										setEditMarkdown(conflictData.serverDoc.markdown);
										setCurrentVersion(conflictData.serverDoc.version);
										setSaveStatus("saved");
									}
									setConflictData(null);
								}}
								className="btn btn-outline btn-sm"
							>
								拉取服务端最新版本 (放弃本地)
							</button>

							<button
								type="button"
								onClick={() => {
									// 基于服务端最新版本强制重试提交本地修改
									if (conflictData.serverDoc) {
										setCurrentVersion(conflictData.serverDoc.version);
										setSaveStatus("dirty");
									}
									setConflictData(null);
								}}
								className="btn btn-primary btn-sm"
							>
								基于新版本重新提交本地草稿
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
