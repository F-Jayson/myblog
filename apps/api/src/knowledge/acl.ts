import type {
	AccessEvaluationContext,
	AccessEvaluationPrincipal,
	AccessEvaluationResult,
	EntitlementStatus,
	KbEffectiveRole,
	KbMemberRole,
	KbScope,
} from "./types.js";

const ROLE_RANK: Record<KbEffectiveRole, number> = {
	viewer: 1,
	commenter: 2,
	editor: 3,
	manager: 4,
	owner: 5,
};

function minMemberRole(roleA: KbMemberRole, roleB: KbMemberRole): KbMemberRole {
	return ROLE_RANK[roleA] <= ROLE_RANK[roleB] ? roleA : roleB;
}

/**
 * 核心权限判决算法 (纯函数，易于高覆盖率单元测试与确定性回归)
 */
export function evaluateAccess(
	principal: AccessEvaluationPrincipal,
	context: AccessEvaluationContext,
): AccessEvaluationResult {
	const deny = (reason: string): AccessEvaluationResult => ({
		canRead: false,
		canComment: false,
		canEdit: false,
		canPublish: false,
		canManage: false,
		canDelete: false,
		effectiveRole: null,
		denyReason: reason,
	});

	// 1. 知识库或文档已软删除
	if (context.library.deletedAt) {
		return deny("KNOWLEDGE_BASE_DELETED");
	}
	if (context.targetDocument?.deletedAt) {
		return deny("DOCUMENT_DELETED");
	}
	for (const ancestor of context.ancestors ?? []) {
		if (ancestor.deletedAt) {
			return deny("ANCESTOR_DOCUMENT_DELETED");
		}
	}

	const isOwner = principal.userId !== undefined && principal.userId === context.library.ownerUserId;

	// 2. 匿名 / 分享链接访问通道
	if (!principal.userId) {
		if (context.library.visibility === "private" && !principal.isShareLink) {
			return deny("PRIVATE_LIBRARY_REQUIRES_AUTH");
		}
		if (context.library.visibility === "unlisted" && !principal.isShareLink) {
			return deny("UNLISTED_LIBRARY_REQUIRES_SHARE_LINK");
		}
		// 匿名访问只读取已发布快照
		if (context.targetDocument && context.targetDocument.publishedRevisionId === null) {
			return deny("UNPUBLISHED_DRAFT_CANNOT_BE_READ_BY_PUBLIC");
		}

		// 检查祖先链及当前节点是否包含 members_only 或 restricted
		const allChainNodes = [...(context.ancestors ?? []), ...(context.targetDocument ? [context.targetDocument] : [])];
		for (const node of allChainNodes) {
			if (node.accessMode === "members_only") {
				return deny("MEMBERS_ONLY_BLOCKS_ANONYMOUS");
			}
			if (node.accessMode === "restricted") {
				return deny("RESTRICTED_NODE_BLOCKS_ANONYMOUS");
			}
		}

		return {
			canRead: true,
			canComment: false,
			canEdit: false,
			canPublish: false,
			canManage: false,
			canDelete: false,
			effectiveRole: null,
		};
	}

	// 3. 用户账号封禁状态检查
	if (principal.isSuspended || context.actorEntitlement === "suspended") {
		return deny("ACCOUNT_SUSPENDED");
	}

	// 4. AI Grant 范围初步过滤
	if (principal.grant) {
		if (!principal.grant.allowedLibraryIds.includes(context.library.id)) {
			return deny("LIBRARY_NOT_IN_AGENT_GRANT");
		}
	}

	// 5. 库所有者 (Owner) 权限计算
	if (isOwner) {
		const ownerStatus: EntitlementStatus = context.ownerEntitlement ?? "active";
		const actorStatus: EntitlementStatus = context.actorEntitlement ?? "active";

		// 写入能力：所有者本人必须处于 eligible / active / grace 之一
		const canWrite = ["eligible", "active", "grace"].includes(ownerStatus) && ["eligible", "active", "grace"].includes(actorStatus);
		// 发布能力：必须严格达标 (eligible / active)，grace 下暂停发布
		const canPublish = ["eligible", "active"].includes(ownerStatus) && ["eligible", "active"].includes(actorStatus);

		return applyGrantScopes(principal.grant?.scopes, {
			canRead: true,
			canComment: canWrite,
			canEdit: canWrite,
			canPublish,
			canManage: true,
			canDelete: canWrite,
			effectiveRole: "owner",
		});
	}

	// 6. 普通成员或受邀协作者权限计算
	let baseRole: KbMemberRole | null = context.libraryMemberRole ?? null;
	const explicitDocRole = context.targetDocument ? context.documentExplicitRoles?.get(context.targetDocument.id) : null;

	// 单篇直接授权如果角色更高，提升为单篇有效角色 (但最高为 editor，不能越级为 manager)
	let currentRole: KbMemberRole | null = baseRole;
	if (explicitDocRole) {
		if (!currentRole || ROLE_RANK[explicitDocRole] > ROLE_RANK[currentRole]) {
			currentRole = explicitDocRole === "manager" ? "editor" : explicitDocRole;
		}
	}

	// 遍历祖先链上的 restricted 约束
	const chain = [...(context.ancestors ?? []), ...(context.targetDocument ? [context.targetDocument] : [])];
	for (const node of chain) {
		if (node.accessMode === "restricted") {
			const explicitRoleOnRestrictedNode = context.documentExplicitRoles?.get(node.id);
			// 如果不在该 restricted 节点的显式名单中
			if (!explicitRoleOnRestrictedNode) {
				// 仅有库级 manager 可以穿透 restricted 祖先节点
				if (baseRole !== "manager") {
					return deny("RESTRICTED_ANCESTOR_ACCESS_DENIED");
				}
			} else {
				// 名单上的角色作为该子树下的权限上限收缩
				currentRole = currentRole ? minMemberRole(currentRole, explicitRoleOnRestrictedNode) : explicitRoleOnRestrictedNode;
			}
		}
	}

	if (!currentRole) {
		return deny("NO_EXPLICIT_ROLE_FOR_RESOURCE");
	}

	// 7. 资格状态流转对协作者与所有者的协同判定
	const actorStatus: EntitlementStatus = context.actorEntitlement ?? "locked";
	const ownerStatus: EntitlementStatus = context.ownerEntitlement ?? "active";

	// 规则矩阵：
	// 既有库编辑：操作者状态 in (eligible, active, grace) 且 库所有者状态 in (active, grace)
	const isOperatorWritable = ["eligible", "active", "grace"].includes(actorStatus);
	const isOwnerWritable = ["active", "grace"].includes(ownerStatus);
	const canCollaborateWrite = isOperatorWritable && isOwnerWritable;

	const roleCanEdit = currentRole === "manager" || currentRole === "editor";
	const roleCanComment = roleCanEdit || currentRole === "commenter";
	const roleCanManage = currentRole === "manager";

	// 协作者扩大共享或发布公开快照：要求当前严格达标 (eligible / active)，且所有者严格达标 (active)
	const isOperatorStrictlyActive = ["eligible", "active"].includes(actorStatus);
	const isOwnerStrictlyActive = ownerStatus === "active";
	const canPublish = roleCanManage && isOperatorStrictlyActive && isOwnerStrictlyActive;

	const result: AccessEvaluationResult = {
		canRead: true,
		canComment: roleCanComment && isOwnerWritable,
		canEdit: roleCanEdit && canCollaborateWrite,
		canPublish,
		canManage: roleCanManage && isOperatorStrictlyActive && isOwnerStrictlyActive,
		canDelete: roleCanEdit && canCollaborateWrite,
		effectiveRole: currentRole,
	};

	return applyGrantScopes(principal.grant?.scopes, result);
}

/**
 * 将智能体 Grant 中的 Scope 与服务端计算的原始权限做交集
 */
function applyGrantScopes(
	scopes: KbScope[] | undefined,
	base: AccessEvaluationResult,
): AccessEvaluationResult {
	if (!scopes) return base;

	const has = (scope: KbScope) => scopes.includes(scope);

	return {
		...base,
		canRead: base.canRead && has("kb:read"),
		canComment: base.canComment && has("kb:comment"),
		canEdit: base.canEdit && has("kb:write"),
		canPublish: base.canPublish && has("kb:publish"),
		canManage: base.canManage && has("kb:share"),
		canDelete: base.canDelete && has("kb:delete"),
	};
}
