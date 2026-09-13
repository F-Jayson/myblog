const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");

function siteOrigin() {
	if (API_ORIGIN) return API_ORIGIN;
	if (typeof window !== "undefined" && window.location?.origin) return window.location.origin.replace(/\/+$/u, "");
	return "";
}

/** Turn an API-relative path into a pasteable absolute URL. */
export function absoluteMediaUrl(value: string | null | undefined): string {
	const source = typeof value === "string" ? value.trim() : "";
	if (!source) return "";
	if (/^https?:\/\//iu.test(source)) return source;
	if (!/^\/(?!\/)/u.test(source)) return "";
	const origin = siteOrigin();
	return origin ? `${origin}${source}` : source;
}

/** Resolve media paths returned by the API when the web app is deployed separately. */
export function resolveMediaUrl(value: string | null | undefined): string {
	const source = typeof value === "string" ? value.trim() : "";
	if (!source) return "";
	if (/^https?:\/\//iu.test(source)) return source;
	if (!/^\/(?!\/)/u.test(source)) return "";
	if (/^\/api\/(?:uploads|public\/resources|user\/storage|admin\/user-space)(?:\/|$)/u.test(source) || /^\/uploads(?:\/|$)/u.test(source)) {
		return API_ORIGIN ? `${API_ORIGIN}${source}` : source;
	}
	return source;
}

export function isSafeResourceUrl(value: string | null | undefined): boolean {
	const source = typeof value === "string" ? value.trim() : "";
	if (!/^(?:https?:\/\/|\/(?!\/))/iu.test(source) || /[\\"'<>\u0000-\u001f\u007f]/u.test(source)) return false;
	if (/^\//u.test(source)) return true;
	try {
		const parsed = new URL(source);
		return /^(?:http|https):$/u.test(parsed.protocol) && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

export function isSafeNavigationUrl(value: string | null | undefined): boolean {
	const source = typeof value === "string" ? value.trim() : "";
	return /^(?:https?:\/\/|\/(?!\/)|mailto:|tel:)/iu.test(source) && !/["'\r\n]/u.test(source);
}
