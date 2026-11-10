import { useEffect, useState, type ReactNode } from "react";
import { AUTH_CHANGED_EVENT, USER_TOKEN_KEY } from "./api";
import { resolveMediaUrl } from "./media";

const ADMIN_TOKEN_KEY = "site-admin-token";
const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/u, "");

/** 只对同源或显式配置的 API 源附带凭证：绝对不能用路径正则决定是否发送 token */
function isTrustedOrigin(url: string) {
	try {
		const origin = new URL(url, window.location.href).origin;
		if (origin === window.location.origin) return true;
		return Boolean(API_ORIGIN) && origin === new URL(API_ORIGIN, window.location.href).origin;
	} catch {
		return false;
	}
}

function authHeaderFor(url: string) {
	if (!isTrustedOrigin(url)) return "";
	if (/\/api\/admin\//u.test(url)) {
		try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? ""; } catch { return ""; }
	}
	try { return localStorage.getItem(USER_TOKEN_KEY) ?? ""; } catch { return ""; }
}

export function AuthImage({ src, alt = "", fallback = null }: { src: string; alt?: string; fallback?: ReactNode }) {
	const [objectUrl, setObjectUrl] = useState("");
	const [authVersion, setAuthVersion] = useState(0);

	// 登录/登出后 token 变了，已经加载过的鉴权图片需要重新拉一次
	useEffect(() => {
		const handleChanged = () => setAuthVersion((value) => value + 1);
		window.addEventListener(AUTH_CHANGED_EVENT, handleChanged);
		return () => window.removeEventListener(AUTH_CHANGED_EVENT, handleChanged);
	}, []);

	useEffect(() => {
		let cancelled = false;
		let created = "";
		setObjectUrl("");
		const resolved = resolveMediaUrl(src);
		if (!resolved) return;
		const token = authHeaderFor(resolved);
		const headers = new Headers();
		if (token) headers.set("authorization", `Bearer ${token}`);
		const controller = new AbortController();
		void fetch(resolved, {
			headers,
			signal: controller.signal,
			// 带凭证的图片不进 HTTP 缓存；公开图片沿用浏览器缓存，避免重复下载
			cache: token ? "no-store" : "default",
		})
			.then(async (response) => {
				const type = response.headers.get("content-type") ?? "";
				if (!response.ok || !type.startsWith("image/")) throw new Error("preview unavailable");
				return response.blob();
			})
			.then((blob) => {
				if (cancelled) return;
				created = URL.createObjectURL(blob);
				setObjectUrl(created);
			})
			.catch(() => {
				// 未登录/网络失败/不是图片都退回 fallback，保持界面稳定
				if (!cancelled) setObjectUrl("");
			});
		return () => {
			cancelled = true;
			controller.abort();
			if (created) URL.revokeObjectURL(created);
		};
	}, [src, authVersion]);

	if (!objectUrl) return <>{fallback}</>;
	return <img src={objectUrl} alt={alt} />;
}
