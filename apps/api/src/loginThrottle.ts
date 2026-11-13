const WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_LIMIT = 8;
const ADDRESS_LIMIT = 30;

export type LoginDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * 密码尝试计数。同一地址下单个账号 8 次、该地址全部账号合计 30 次后锁定 15 分钟。
 * 成功登录只清掉这个账号的计数，地址上其他账号的失败仍然保留。
 */
export class LoginThrottle {
	private readonly accountHits = new Map<string, number[]>();
	private readonly addressHits = new Map<string, number[]>();

	constructor(private readonly now: () => number = Date.now) {}

	check(scope: string, ip: string, account: string): LoginDecision {
		const now = this.now();
		const accountKey = this.accountKey(scope, ip, account);
		const addressKey = this.addressKey(scope, ip);
		const accountAttempts = this.prune(this.accountHits.get(accountKey) ?? [], now);
		const addressAttempts = this.prune(this.addressHits.get(addressKey) ?? [], now);
		this.accountHits.set(accountKey, accountAttempts);
		this.addressHits.set(addressKey, addressAttempts);
		if (accountAttempts.length >= ACCOUNT_LIMIT) return { allowed: false, retryAfterSeconds: this.retryAfter(accountAttempts, now) };
		if (addressAttempts.length >= ADDRESS_LIMIT) return { allowed: false, retryAfterSeconds: this.retryAfter(addressAttempts, now) };
		return { allowed: true };
	}

	fail(scope: string, ip: string, account: string) {
		const now = this.now();
		const accountKey = this.accountKey(scope, ip, account);
		const addressKey = this.addressKey(scope, ip);
		this.accountHits.set(accountKey, [...this.prune(this.accountHits.get(accountKey) ?? [], now), now]);
		this.addressHits.set(addressKey, [...this.prune(this.addressHits.get(addressKey) ?? [], now), now]);
	}

	succeed(scope: string, ip: string, account: string) {
		this.accountHits.delete(this.accountKey(scope, ip, account));
	}

	private accountKey(scope: string, ip: string, account: string) {
		return `${scope}\n${ip.trim() || "unknown"}\n${account.trim().toLowerCase() || "unknown"}`;
	}

	private addressKey(scope: string, ip: string) {
		return `${scope}\n${ip.trim() || "unknown"}`;
	}

	private prune(hits: number[], now: number) {
		return hits.filter((at) => now - at < WINDOW_MS);
	}

	private retryAfter(hits: number[], now: number) {
		const oldest = hits[0] ?? now;
		return Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
	}
}

export const loginGate = new LoginThrottle();
