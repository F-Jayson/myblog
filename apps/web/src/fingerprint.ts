/**
 * Browser fingerprinting & persistent device identification for strict cooldown enforcement.
 */

let cachedFingerprint = "";
let cachedDeviceId = "";

function parseCookie(name: string): string | null {
	if (typeof document === "undefined") return null;
	const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

function setCookie(name: string, value: string, maxAgeSeconds = 365 * 24 * 60 * 60) {
	if (typeof document === "undefined") return;
	document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

export function getOrCreateDeviceId(): string {
	if (cachedDeviceId) return cachedDeviceId;
	if (typeof window === "undefined") return "";

	let id: string | null = null;
	try {
		id = localStorage.getItem("blog_device_id");
	} catch {
		/* ignore storage access error */
	}
	if (!id) {
		try {
			id = sessionStorage.getItem("blog_device_id");
		} catch {
			/* ignore */
		}
	}
	if (!id) {
		id = parseCookie("blog_device_id");
	}

	if (!id || id.length < 8) {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			id = crypto.randomUUID();
		} else {
			id = `dev_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
		}
	}

	// Cross-synchronize to ensure resilience against clearing one vector
	try {
		localStorage.setItem("blog_device_id", id);
	} catch {
		/* ignore */
	}
	try {
		sessionStorage.setItem("blog_device_id", id);
	} catch {
		/* ignore */
	}
	setCookie("blog_device_id", id);

	cachedDeviceId = id;
	return id;
}

function getCanvasFingerprint(): string {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 240;
		canvas.height = 60;
		const ctx = canvas.getContext("2d");
		if (!ctx) return "";
		ctx.textBaseline = "top";
		ctx.font = "14px 'Arial', 'Segoe UI', 'PingFang SC', sans-serif";
		ctx.textBaseline = "alphabetic";
		ctx.fillStyle = "#f60";
		ctx.fillRect(125, 1, 62, 20);
		ctx.fillStyle = "#069";
		ctx.fillText("Fingerprint ⚡ 🐱‍👤 <canvas> 1.0", 2, 15);
		ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
		ctx.fillText("Fingerprint ⚡ 🐱‍👤 <canvas> 1.0", 4, 17);
		ctx.strokeStyle = "#a23";
		ctx.beginPath();
		ctx.arc(50, 40, 15, 0, Math.PI * 2, true);
		ctx.stroke();
		return canvas.toDataURL();
	} catch {
		return "";
	}
}

function getWebGLFingerprint(): string {
	try {
		const canvas = document.createElement("canvas");
		const gl = (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
		if (!gl) return "";
		const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
		const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : "";
		const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : "";
		const version = gl.getParameter(gl.VERSION);
		const shadingLang = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
		return `${vendor}~${renderer}~${version}~${shadingLang}`;
	} catch {
		return "";
	}
}

function getAudioFingerprint(): Promise<string> {
	return new Promise((resolve) => {
		try {
			const AudioContextClass = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
			if (!AudioContextClass) {
				resolve("");
				return;
			}
			const context = new AudioContextClass(1, 44100, 44100);
			const oscillator = context.createOscillator();
			oscillator.type = "triangle";
			oscillator.frequency.setValueAtTime(10000, context.currentTime);

			const compressor = context.createDynamicsCompressor();
			compressor.threshold.setValueAtTime(-50, context.currentTime);
			compressor.knee.setValueAtTime(40, context.currentTime);
			compressor.ratio.setValueAtTime(12, context.currentTime);
			compressor.attack.setValueAtTime(0, context.currentTime);
			compressor.release.setValueAtTime(0.25, context.currentTime);

			oscillator.connect(compressor);
			compressor.connect(context.destination);
			oscillator.start(0);

			context.oncomplete = (event) => {
				try {
					const samples = event.renderedBuffer.getChannelData(0);
					let sum = 0;
					for (let i = 0; i < samples.length; i += 100) {
						sum += Math.abs(samples[i]);
					}
					resolve(sum.toFixed(6));
				} catch {
					resolve("");
				}
			};
			context.startRendering().catch(() => resolve(""));
		} catch {
			resolve("");
		}
	});
}

async function sha256(text: string): Promise<string> {
	if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
		try {
			const encoder = new TextEncoder();
			const data = encoder.encode(text);
			const hashBuffer = await crypto.subtle.digest("SHA-256", data);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
		} catch {
			/* fallback below */
		}
	}
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		const chr = text.charCodeAt(i);
		hash = (hash << 5) - hash + chr;
		hash |= 0;
	}
	return `h_${Math.abs(hash).toString(16)}`;
}

export async function getBrowserFingerprint(): Promise<string> {
	if (cachedFingerprint) return cachedFingerprint;
	if (typeof window === "undefined") return "";

	const canvasFp = getCanvasFingerprint();
	const webglFp = getWebGLFingerprint();
	const audioFp = await Promise.race([
		getAudioFingerprint(),
		new Promise<string>((r) => setTimeout(() => r(""), 200)),
	]);

	const nav = navigator as Navigator & { deviceMemory?: number };
	const screenMetrics = typeof screen !== "undefined" ? `${screen.width}x${screen.height}x${screen.colorDepth}` : "";
	const pixelRatio = window.devicePixelRatio || 1;
	const concurrency = nav.hardwareConcurrency || 1;
	const memory = nav.deviceMemory || 0;
	const touch = nav.maxTouchPoints || 0;
	const languages = Array.isArray(nav.languages) ? nav.languages.join(",") : nav.language || "";
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	const tzOffset = new Date().getTimezoneOffset();

	const rawData = [
		canvasFp,
		webglFp,
		audioFp,
		screenMetrics,
		pixelRatio,
		concurrency,
		memory,
		touch,
		languages,
		timezone,
		tzOffset,
		nav.platform || "",
	].join("###");

	const fp = await sha256(rawData);
	cachedFingerprint = fp.slice(0, 32);
	return cachedFingerprint;
}

export function getCachedFingerprint(): string {
	return cachedFingerprint || "init";
}

// Pre-initialize on module load in browser
if (typeof window !== "undefined") {
	getOrCreateDeviceId();
	void getBrowserFingerprint();
}
