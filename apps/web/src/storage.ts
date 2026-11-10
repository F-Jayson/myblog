// localStorage 在隐私模式、禁用 Cookie 或配额写满时会抛异常，
// 直接调用会让首屏在 useState 初始化阶段白屏，这里统一兜底。

export function readStoredValue(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeStoredValue(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// 存储不可用时只保留内存状态，不影响页面渲染
	}
}

export function readStoredNumber(key: string, fallback: number): number {
	const raw = readStoredValue(key);
	if (raw === null || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
	const raw = readStoredValue(key);
	if (raw === null) return fallback;
	return raw === "true";
}
