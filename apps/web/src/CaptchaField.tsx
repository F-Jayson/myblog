import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type CaptchaFieldProps = {
	code: string;
	onCodeChange: (value: string) => void;
	onCaptchaIdChange: (id: string) => void;
	refreshKey?: number;
	disabled?: boolean;
};

function waitLabel(seconds: number) {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes <= 0) return `${seconds} 秒`;
	if (rest === 0) return `${minutes} 分钟`;
	return `${minutes} 分 ${rest} 秒`;
}

export function CaptchaField({ code, onCodeChange, onCaptchaIdChange, refreshKey = 0, disabled = false }: CaptchaFieldProps) {
	const [image, setImage] = useState("");
	const [expiresIn, setExpiresIn] = useState(0);
	const [cooldown, setCooldown] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [reload, setReload] = useState(0);
	const onId = useRef(onCaptchaIdChange);
	const onCode = useRef(onCodeChange);
	onId.current = onCaptchaIdChange;
	onCode.current = onCodeChange;

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				const result = await api.authCaptcha();
				if (cancelled) return;
				onId.current(result.id);
				setImage(result.image);
				setExpiresIn(result.expiresInSeconds);
				setCooldown(0);
				setError("");
			} catch (reason) {
				if (cancelled) return;
				onId.current("");
				setImage("");
				setExpiresIn(0);
				const payload = reason && typeof reason === "object" && "payload" in reason ? (reason as { payload?: { retryAfterSeconds?: unknown } }).payload : undefined;
				const retryAfter = Number(payload?.retryAfterSeconds ?? 0);
				if (Number.isFinite(retryAfter) && retryAfter > 0) setCooldown(Math.ceil(retryAfter));
				setError(reason instanceof Error ? reason.message : "图形验证码加载失败");
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		void load();
		return () => { cancelled = true; };
	}, [refreshKey, reload]);

	useEffect(() => {
		if (expiresIn <= 0 && cooldown <= 0) return undefined;
		const timer = window.setInterval(() => {
			setExpiresIn((value) => Math.max(0, value - 1));
			setCooldown((value) => Math.max(0, value - 1));
		}, 1000);
		return () => window.clearInterval(timer);
	}, [cooldown > 0, expiresIn > 0]);

	const refresh = () => {
		if (loading || cooldown > 0 || disabled) return;
		onCode.current("");
		setReload((value) => value + 1);
	};
	const hint = cooldown > 0
		? `冷静期剩余 ${waitLabel(cooldown)}，暂时不能发送邮箱验证码`
		: expiresIn > 0
			? `点击图片可刷新，${expiresIn} 秒内有效`
			: image
				? "图形验证码已过期，请点击图片刷新"
				: error || "点击图片刷新图形验证码";
	return (
		<label className="captcha-field">
			<span>图形验证码</span>
			<div className="captcha-row">
				<input value={code} onChange={(event) => onCodeChange(event.target.value.toUpperCase())} maxLength={6} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="请输入图中字符" disabled={disabled || cooldown > 0} />
				<button type="button" className="captcha-image" title="点击刷新图形验证码" onClick={refresh} disabled={loading || cooldown > 0 || disabled}>
					{image ? <img src={image} alt="图形验证码" /> : <span>{loading ? "加载中" : "刷新"}</span>}
				</button>
			</div>
			<small className="captcha-hint">{hint}</small>
		</label>
	);
}
