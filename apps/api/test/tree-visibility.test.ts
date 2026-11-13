import assert from "node:assert/strict";
import test from "node:test";
import { memberVisibleIds, publicVisitorVisibleIds, type TreeAccessNode } from "../src/knowledge/treeVisibility.js";

const nodes: TreeAccessNode[] = [
	{ id: 1, parentId: null, kind: "folder", accessMode: "inherit", publishedRevisionId: null },
	{ id: 2, parentId: 1, kind: "document", accessMode: "inherit", publishedRevisionId: 20 },
	{ id: 3, parentId: 1, kind: "document", accessMode: "inherit", publishedRevisionId: null },
	{ id: 4, parentId: null, kind: "folder", accessMode: "restricted", publishedRevisionId: null },
	{ id: 5, parentId: 4, kind: "document", accessMode: "inherit", publishedRevisionId: 50 },
	{ id: 6, parentId: null, kind: "document", accessMode: "members_only", publishedRevisionId: 60 },
];

test("public visitors only see published nodes outside restricted and members-only subtrees", () => {
	assert.deepEqual([...publicVisitorVisibleIds(nodes)].sort((a, b) => a - b), [1, 2]);
});

test("members keep unpublished documents but not restricted subtrees they are not listed on", () => {
	assert.deepEqual([...memberVisibleIds(nodes, new Set())].sort((a, b) => a - b), [1, 2, 3, 6]);
	assert.deepEqual([...memberVisibleIds(nodes, new Set([4]))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});
