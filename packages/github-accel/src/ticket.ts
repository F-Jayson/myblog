import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export type TicketKind = "file" | "git";

export interface TicketPayload {
	readonly u: string;
	readonly e: number;
	readonly k: TicketKind;
}

export type TicketFailureCode = "TICKET_INVALID" | "TICKET_EXPIRED";

export type TicketVerification =
	| { readonly ok: true; readonly payload: TicketPayload }
	| { readonly ok: false; readonly code: TicketFailureCode; readonly error: string };

/** 文档第 2 节：签名是 HMAC-SHA256 十六进制的前 32 个字符（16 字节）。 */
const SIGNATURE_HEX_LENGTH = 32;
const SIGNATURE_PATTERN = /^[0-9a-f]{32}$/;
/** base64url 无填充：出现 + / = 说明不是两端约定的编码。 */
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]+$/;

function sign(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex").slice(0, SIGNATURE_HEX_LENGTH);
}

function fail(code: TicketFailureCode, error: string): TicketVerification {
	return { ok: false, code, error };
}

function isTicketKind(value: unknown): value is TicketKind {
	return value === "file" || value === "git";
}

export function createTicket(payload: TicketPayload, secret: string = config.secret): string {
	// 字段顺序固定成 u,e,k：两端必须产出同一段 payload 字符串，否则文档里的固定向量会对不上。
	const body = Buffer.from(JSON.stringify({ u: payload.u, e: payload.e, k: payload.k }), "utf8").toString("base64url");
	return body + "." + sign(body, secret);
}

export function verifyTicket(
	ticket: string | null | undefined,
	expectedKind?: TicketKind,
	secret: string = config.secret,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): TicketVerification {
	if (ticket === undefined || ticket === null || ticket === "") return fail("TICKET_INVALID", "缺少 ticket");
	const dot = ticket.lastIndexOf(".");
	if (dot <= 0 || dot === ticket.length - 1) return fail("TICKET_INVALID", "ticket 格式不正确");
	const payload = ticket.slice(0, dot);
	const signature = ticket.slice(dot + 1);
	if (!PAYLOAD_PATTERN.test(payload) || !SIGNATURE_PATTERN.test(signature)) {
		return fail("TICKET_INVALID", "ticket 格式不正确");
	}

	// secret 为空表示调试模式：签名校验放行（启动时已打印告警），但过期时间与类型仍然校验。
	if (secret !== "") {
		const expected = sign(payload, secret);
		if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"))) {
			return fail("TICKET_INVALID", "ticket 签名校验失败（两端 ACCEL_SECRET 是否一致？）");
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
	} catch {
		return fail("TICKET_INVALID", "ticket 内容无法解析");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return fail("TICKET_INVALID", "ticket 内容无法解析");
	}
	const record = parsed as Record<string, unknown>;
	const u = record.u;
	const e = record.e;
	const k = record.k;
	if (typeof u !== "string" || u === "") return fail("TICKET_INVALID", "ticket 缺少目标地址");
	if (typeof e !== "number" || !Number.isFinite(e)) return fail("TICKET_INVALID", "ticket 缺少过期时间");
	if (!isTicketKind(k)) return fail("TICKET_INVALID", "ticket 类型不合法");
	if (expectedKind !== undefined && k !== expectedKind) {
		return fail("TICKET_INVALID", "ticket 类型不匹配（期望 " + expectedKind + "，实际 " + k + "）");
	}
	if (e <= nowSeconds) return fail("TICKET_EXPIRED", "ticket 已过期，请重新获取下载链接");
	return { ok: true, payload: { u, e, k } };
}
