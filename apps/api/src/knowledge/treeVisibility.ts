export type TreeAccessNode = {
	id: number;
	parentId: number | null;
	kind: "document" | "folder";
	accessMode: "inherit" | "members_only" | "restricted";
	publishedRevisionId: number | null;
};

function indexNodes(nodes: TreeAccessNode[]) {
	return new Map(nodes.map((node) => [node.id, node]));
}

function walkAncestors(node: TreeAccessNode, byId: Map<number, TreeAccessNode>, visit: (current: TreeAccessNode) => boolean) {
	const seen = new Set<number>();
	let current: TreeAccessNode | undefined = node;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		if (visit(current)) return true;
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return false;
}

/** 匿名公开目录：只要节点或祖先是受限/仅成员，或者文档还没有发布快照，就不出现。 */
export function publicVisitorVisibleIds(nodes: TreeAccessNode[]): Set<number> {
	const byId = indexNodes(nodes);
	const blocked = (node: TreeAccessNode) => walkAncestors(node, byId, (current) => current.accessMode === "restricted" || current.accessMode === "members_only");
	const visible = new Set<number>();
	for (const node of nodes) {
		if (node.kind !== "document" || node.publishedRevisionId === null || blocked(node)) continue;
		visible.add(node.id);
		let parentId = node.parentId;
		while (parentId !== null) {
			const parent = byId.get(parentId);
			if (!parent || blocked(parent)) break;
			visible.add(parent.id);
			parentId = parent.parentId;
		}
	}
	return visible;
}

/** 库成员可以看到未发布文档；受限节点及其子树仍要求显式名单。 */
export function memberVisibleIds(nodes: TreeAccessNode[], explicitNodeIds: Set<number>): Set<number> {
	const byId = indexNodes(nodes);
	const visible = new Set<number>();
	for (const node of nodes) {
		const hidden = walkAncestors(node, byId, (current) => current.accessMode === "restricted" && !explicitNodeIds.has(current.id));
		if (!hidden) visible.add(node.id);
	}
	return visible;
}
