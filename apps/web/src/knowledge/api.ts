import type {
	AttachmentSummary,
	DocumentDetail,
	KbDocumentKind,
	KbEligibilityResponse,
	KbQuotaUsage,
	KbVisibility,
	LibrarySummary,
	RevisionSummary,
	SearchResultItem,
	TrashedDocumentItem,
	TreeNode,
} from "./types";

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");
const USER_TOKEN_KEY = "site-user-token";

function authHeaders(headers?: HeadersInit): Headers {
	const result = new Headers(headers);
	const token = localStorage.getItem(USER_TOKEN_KEY);
	if (token && !result.has("authorization")) {
		result.set("authorization", `Bearer ${token}`);
	}
	return result;
}

export class KbApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
		public payload?: unknown,
	) {
		super(message);
		this.name = "KbApiError";
	}
}

async function kbRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = authHeaders(init.headers);
	let body = init.body;

	if (body && typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob)) {
		if (!headers.has("content-type")) {
			headers.set("content-type", "application/json");
		}
		body = JSON.stringify(body);
	}

	const response = await fetch(`${API_ORIGIN}${path}`, {
		...init,
		headers,
		body,
	});

	const text = await response.text();
	let payload: any = null;
	if (text) {
		try { payload = JSON.parse(text); } catch { payload = text; }
	}

	if (!response.ok) {
		const code = payload?.error || `HTTP_${response.status}`;
		const message = payload?.message || payload?.error || response.statusText;
		throw new KbApiError(response.status, code, message, payload);
	}

	return payload as T;
}

export const kbApi = {
	async getEligibility(): Promise<KbEligibilityResponse> {
		return kbRequest<KbEligibilityResponse>("/api/knowledge/eligibility");
	},

	async listLibraries(): Promise<LibrarySummary[]> {
		const res = await kbRequest<{ libraries: LibrarySummary[] }>("/api/knowledge/libraries");
		return res.libraries;
	},

	async createLibrary(data: {
		title: string;
		description?: string;
		coverUrl?: string;
		visibility?: KbVisibility;
	}): Promise<{ id: number }> {
		return kbRequest<{ id: number }>("/api/knowledge/libraries", {
			method: "POST",
			body: data as unknown as BodyInit,
		});
	},

	async getLibrary(id: number): Promise<LibrarySummary> {
		return kbRequest<LibrarySummary>(`/api/knowledge/libraries/${id}`);
	},

	async updateLibrary(id: number, data: Partial<LibrarySummary>): Promise<void> {
		await kbRequest(`/api/knowledge/libraries/${id}`, {
			method: "PUT",
			body: data as unknown as BodyInit,
		});
	},

	async deleteLibrary(id: number): Promise<void> {
		await kbRequest(`/api/knowledge/libraries/${id}`, { method: "DELETE" });
	},

	async getLibraryTree(libraryId: number): Promise<TreeNode[]> {
		const res = await kbRequest<{ tree: TreeNode[] }>(`/api/knowledge/libraries/${libraryId}/tree`);
		return res.tree;
	},

	async createDocument(data: {
		libraryId: number;
		parentId?: number | null;
		kind: KbDocumentKind;
		title: string;
		markdown?: string;
		tags?: string[];
		sourceUrl?: string;
	}): Promise<DocumentDetail> {
		return kbRequest<DocumentDetail>("/api/knowledge/documents", {
			method: "POST",
			body: data as unknown as BodyInit,
		});
	},

	async getDocument(documentId: number): Promise<DocumentDetail> {
		return kbRequest<DocumentDetail>(`/api/knowledge/documents/${documentId}`);
	},

	async saveDocument(
		documentId: number,
		data: {
			expectedVersion: number;
			title: string;
			markdown: string;
			tags?: string[];
			sourceUrl?: string;
			isManualSave?: boolean;
		},
	): Promise<{ status: "saved" | "unchanged"; version: number; revisionId?: number }> {
		return kbRequest<{ status: "saved" | "unchanged"; version: number; revisionId?: number }>(
			`/api/knowledge/documents/${documentId}`,
			{
				method: "PUT",
				body: data as unknown as BodyInit,
			},
		);
	},

	async moveDocument(documentId: number, targetParentId: number | null, sortOrder = 0): Promise<void> {
		await kbRequest(`/api/knowledge/documents/${documentId}/move`, {
			method: "POST",
			body: { targetParentId, sortOrder } as unknown as BodyInit,
		});
	},

	async trashDocument(documentId: number): Promise<void> {
		await kbRequest(`/api/knowledge/documents/${documentId}/trash`, { method: "POST" });
	},

	async restoreDocument(documentId: number): Promise<void> {
		await kbRequest(`/api/knowledge/documents/${documentId}/restore`, { method: "POST" });
	},

	async getRevisions(documentId: number): Promise<RevisionSummary[]> {
		const res = await kbRequest<{ revisions: RevisionSummary[] }>(`/api/knowledge/documents/${documentId}/revisions`);
		return res.revisions;
	},

	async restoreRevision(
		documentId: number,
		revisionId: number,
		expectedVersion: number,
	): Promise<{ status: "saved"; version: number }> {
		return kbRequest<{ status: "saved"; version: number }>(
			`/api/knowledge/documents/${documentId}/revisions/${revisionId}/restore`,
			{
				method: "POST",
				body: { expectedVersion } as unknown as BodyInit,
			},
		);
	},

	async search(query: string, libraryId?: number): Promise<SearchResultItem[]> {
		const params = new URLSearchParams({ q: query });
		if (libraryId) params.set("libraryId", String(libraryId));
		const res = await kbRequest<{ items: SearchResultItem[] }>(`/api/knowledge/search?${params.toString()}`);
		return res.items;
	},

	async uploadAttachment(documentId: number, file: File): Promise<AttachmentSummary> {
		const formData = new FormData();
		formData.append("file", file);
		return kbRequest<AttachmentSummary>(`/api/knowledge/documents/${documentId}/attachments`, {
			method: "POST",
			body: formData,
		});
	},

	async listAttachments(documentId: number): Promise<AttachmentSummary[]> {
		const res = await kbRequest<{ attachments: AttachmentSummary[] }>(
			`/api/knowledge/documents/${documentId}/attachments`,
		);
		return res.attachments;
	},

	async getQuota(): Promise<KbQuotaUsage> {
		return kbRequest<KbQuotaUsage>("/api/knowledge/quota");
	},

	async listTrash(libraryId: number): Promise<TrashedDocumentItem[]> {
		const res = await kbRequest<{ items: TrashedDocumentItem[] }>(`/api/knowledge/libraries/${libraryId}/trash`);
		return res.items;
	},
};
