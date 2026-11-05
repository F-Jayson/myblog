export class KbError extends Error {
	constructor(
		public statusCode: number,
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "KbError";
	}
}

export class UserDeletionBlockedError extends KbError {
	constructor(message = "USER_OWNS_KNOWLEDGE_DATA: 账号名下仍有个人知识库数据，请先注销或清理知识库") {
		super(409, "USER_OWNS_KNOWLEDGE_DATA", message);
		this.name = "UserDeletionBlockedError";
	}
}

export class KbNotEligibleError extends KbError {
	constructor(message = "当前账号未达到知识库开通或编辑资格门槛") {
		super(403, "KB_NOT_ELIGIBLE", message);
		this.name = "KbNotEligibleError";
	}
}

export class KbAccessDeniedError extends KbError {
	constructor(message = "没有访问该知识库资源的权限") {
		super(403, "KB_ACCESS_DENIED", message);
		this.name = "KbAccessDeniedError";
	}
}

export class KbNotFoundError extends KbError {
	constructor(message = "知识库资源不存在") {
		super(404, "KB_NOT_FOUND", message);
		this.name = "KbNotFoundError";
	}
}

export class KbVersionConflictError extends KbError {
	constructor(message = "文档已被其他人修改，版本不一致") {
		super(409, "VERSION_CONFLICT", message);
		this.name = "KbVersionConflictError";
	}
}

export class KbQuotaExceededError extends KbError {
	constructor(message = "知识库存储空间已达上限 (100 MiB)") {
		super(409, "QUOTA_EXCEEDED", message);
		this.name = "KbQuotaExceededError";
	}
}
