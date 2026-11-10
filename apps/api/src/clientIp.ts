import { config } from "./config.js";

/** 只要够拿到连接地址的字段，便于测试替身与 Express Request 共用 */
export interface ClientIpRequest {
	header: (name: string) => string | undefined;
	ip?: string;
	socket?: { remoteAddress?: string } | null;
}

/**
 * 取客户端 IP。
 *
 * X-Forwarded-For 完全由客户端写入，直连部署时信任它等于让冷却/限流按伪造 IP 生效
 * （每个请求换一个值就绕过）。因此只有显式打开 TRUST_PROXY 才读取该头部，并且取
 * 最后一段：反向代理会把真实地址追加在伪造链的末尾，第一段恰恰是最容易被伪造的。
 */
export function resolveClientIp(req: ClientIpRequest): string {
	if (config.trustProxy) {
		const forwarded = req.header("x-forwarded-for");
		if (forwarded) {
			const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
			const last = parts[parts.length - 1];
			if (last) return last;
		}
	}
	return req.ip || req.socket?.remoteAddress || "";
}
