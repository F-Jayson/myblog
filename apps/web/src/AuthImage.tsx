import { useEffect, useState, type ReactNode } from "react";
import { USER_TOKEN_KEY } from "./api";
import { resolveMediaUrl } from "./media";

const ADMIN_TOKEN_KEY = "firefly-admin-token";

function authHeaderFor(url: string) {
	if (/\/api\/admin\//u.test(url)) {
		try { return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? ""; } catch { return ""; }
	}
	try { return localStorage.getItem(USER_TOKEN_KEY) ?? ""; } catch { return ""; }
}

export function AuthImage({ src, alt = "", fallback = null }: { src: string; alt?: string; fallback?: ReactNode }) {
	const [objectUrl, setObjectUrl] = useState("");

	useEffect(() => {
		let cancelled = false;
		let created = "";
		setObjectUrl("");
		const resolved = resolveMediaUrl(src);
		if (!resolved) return;
		const headers = new Headers();
		const token = authHeaderFor(resolved);
		if (token) headers.set("authorization", `Bearer ${token}`);
		void fetch(resolved, { headers, cache: "no-store" })
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
				if (!cancelled) setObjectUrl("");
			});
		return () => {
			cancelled = true;
			if (created) URL.revokeObjectURL(created);
		};
	}, [src]);

	if (!objectUrl) return <>{fallback}</>;
	return <img src={objectUrl} alt={alt} />;
}
