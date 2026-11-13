import assert from "node:assert/strict";
import test from "node:test";
import {
	DriveError,
	driveBreadcrumbs,
	driveIfHeaderTokens,
	driveLockTokenFromHeader,
	joinDrivePath,
	normalizeDrivePath,
	normalizeDriveSegment,
	normalizeLockDepth,
	normalizeLockTimeout,
	parentDrivePath,
} from "../src/driveStore.js";

test("normalizeDrivePath normalizes slashes, empty paths and unicode", () => {
	assert.equal(normalizeDrivePath(""), "/");
	assert.equal(normalizeDrivePath("/"), "/");
	assert.equal(normalizeDrivePath("/a//b/"), "/a/b");
	assert.equal(normalizeDrivePath("a\\b"), "/a/b");
	assert.equal(normalizeDrivePath("/cafe\u0301"), "/caf\u00e9");
});

test("normalizeDrivePath rejects traversal, deep paths and invalid segments", () => {
	assert.throws(() => normalizeDrivePath("/../secret"), (error: unknown) => error instanceof DriveError && error.status === 400);
	assert.throws(() => normalizeDrivePath(`/${Array.from({ length: 33 }, (_, index) => `d${index}`).join("/")}`), /目录层级过深/);
	assert.throws(() => normalizeDrivePath(`/${"a".repeat(241)}`), /名称过长/);
});

test("normalizeDriveSegment trims names and rejects illegal characters", () => {
	assert.equal(normalizeDriveSegment("  report.txt  "), "report.txt");
	assert.throws(() => normalizeDriveSegment(".."), /名称无效/);
	assert.throws(() => normalizeDriveSegment("a/b"), /非法字符/);
	assert.throws(() => normalizeDriveSegment("a\tb"), /非法字符/);
	assert.throws(() => normalizeDriveSegment("   "), /名称不能为空/);
});

test("joinDrivePath and parentDrivePath handle the root", () => {
	assert.equal(joinDrivePath("/", "file.txt"), "/file.txt");
	assert.equal(joinDrivePath("/docs", "file.txt"), "/docs/file.txt");
	assert.equal(parentDrivePath("/"), "/");
	assert.equal(parentDrivePath("/docs"), "/");
	assert.equal(parentDrivePath("/docs/2026/file.txt"), "/docs/2026");
});

test("driveBreadcrumbs starts at 全部文件 and accumulates path segments", () => {
	assert.deepEqual(driveBreadcrumbs("/"), [{ name: "全部文件", path: "/" }]);
	assert.deepEqual(driveBreadcrumbs("/docs/2026"), [
		{ name: "全部文件", path: "/" },
		{ name: "docs", path: "/docs" },
		{ name: "2026", path: "/docs/2026" },
	]);
});

test("normalizeLockTimeout clamps to one minute through seven days", () => {
	assert.equal(normalizeLockTimeout(undefined), 3600);
	assert.equal(normalizeLockTimeout("Infinite"), 3600);
	assert.equal(normalizeLockTimeout("Second-600"), 600);
	assert.equal(normalizeLockTimeout("Second-5"), 60);
	assert.equal(normalizeLockTimeout("Second-9999999"), 7 * 24 * 3600);
});

test("normalizeLockDepth and lock tokens accept WebDAV header forms", () => {
	assert.equal(normalizeLockDepth("0"), "0");
	assert.equal(normalizeLockDepth(undefined), "infinity");
	const uuid = "b9e0f082-0212-4e86-813c-ce5c38cae451";
	const header = `(<opaquelocktoken:${uuid.toUpperCase()}>)`;
	assert.equal(driveLockTokenFromHeader(header), `opaquelocktoken:${uuid}`);
	assert.deepEqual(driveIfHeaderTokens(`If: ${header}`), [`opaquelocktoken:${uuid}`]);
	assert.deepEqual(driveIfHeaderTokens(undefined), []);
});
