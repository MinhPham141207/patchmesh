import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveCoverage,
  diffSnapshots,
  fileResourceId,
  normalizeLogicalPath,
  sanitizeDiagnostic,
  type ObservationSnapshot,
} from "../src/index.js";

const emptySnapshot = (): ObservationSnapshot => ({
  repository: { commonDirectory: "C:/repo/.git", revision: "abc" },
  worktree: { administrativeDirectory: "C:/repo/.git" },
  files: new Map(),
});

const file = (contentHash: string) => ({
  contentHash,
  gitBlob: null,
  fileKind: "file" as const,
});

test("normalizes a repository-relative NFC path", () => {
  assert.equal(normalizeLogicalPath("src/cafe\u0301.ts"), "src/caf\u00e9.ts");
});

for (const invalid of [
  "C:/repo/file.ts",
  "src\\file.ts",
  "src/../file.ts",
  "src//file.ts",
  "src/file.ts/",
  "src/\u0000file.ts",
]) {
  test(`rejects ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => normalizeLogicalPath(invalid));
  });
}

test("derives a stable repository-scoped file resource ID", () => {
  assert.equal(
    fileResourceId("repo_11111111111111111111111111111111", "src/example.ts"),
    fileResourceId("repo_11111111111111111111111111111111", "src/example.ts"),
  );
  assert.notEqual(
    fileResourceId("repo_11111111111111111111111111111111", "src/example.ts"),
    fileResourceId("repo_22222222222222222222222222222222", "src/example.ts"),
  );
});

test("redacts secret-shaped diagnostics", () => {
  const result = sanitizeDiagnostic("Authorization: Bearer synthetic-token-value");
  assert.equal(result.includes("synthetic-token-value"), false);
  assert.equal(result.includes("<redacted>"), true);
});

test("normalizes created, modified, deleted, and unchanged file effects", () => {
  const before = emptySnapshot();
  const beforeFiles = new Map([
    ["changed.txt", file("before")],
    ["deleted.txt", file("deleted")],
    ["same.txt", file("same")],
  ]);
  const after = emptySnapshot();
  const afterFiles = new Map([
    ["changed.txt", file("after")],
    ["created.txt", file("created")],
    ["same.txt", file("same")],
  ]);
  const result = diffSnapshots(
    { ...before, files: beforeFiles },
    { ...after, files: afterFiles },
    false,
  );

  assert.deepEqual(result.changes.map((change) => [change.path, change.changeKind]), [
    ["changed.txt", "modified"],
    ["created.txt", "created"],
    ["deleted.txt", "deleted"],
  ]);
  assert.equal(result.changes.find((change) => change.path === "deleted.txt")?.after, null);
  assert.deepEqual(result.gaps, []);
});

test("pairs same-content delete and create paths as a deterministic rename", () => {
  const before = { ...emptySnapshot(), files: new Map([["old.txt", file("same")]]) };
  const after = { ...emptySnapshot(), files: new Map([["new.txt", file("same")]]) };
  const result = diffSnapshots(before, after, false);

  assert.deepEqual(result.changes, [{
    path: "new.txt",
    previousPath: "old.txt",
    before: file("same"),
    after: file("same"),
    changeKind: "renamed",
    outOfBand: false,
  }]);
});

test("marks opaque effects as degraded coverage", () => {
  const result = diffSnapshots(
    emptySnapshot(),
    { ...emptySnapshot(), files: new Map([["changed.txt", file("after")]]) },
    true,
  );

  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.gaps, [{
    kind: "opaque",
    scope: "tool.effects",
    reason: "opaque operation effects are not prospectively enumerable",
  }]);
});

test("derives deterministic sufficient and degraded coverage", () => {
  const evidenceEventIds = ["evt_11111111111111111111111111111111"] as const;
  const sufficient = deriveCoverage({
    scope: "tool.effects",
    modes: ["intercepted", "verified"],
    gaps: [],
    evidenceEventIds,
  });
  const degraded = deriveCoverage({
    scope: "tool.effects",
    modes: ["intercepted", "verified"],
    gaps: [{
      kind: "opaque",
      scope: "tool.effects",
      reason: "opaque operation effects are not prospectively enumerable",
    }],
    evidenceEventIds,
  });

  assert.equal(sufficient.presentation, "sufficient");
  assert.equal(degraded.presentation, "degraded");
  assert.equal(degraded.gaps[0]?.evidenceEventIds[0], evidenceEventIds[0]);
  assert.equal(degraded.coverageId, deriveCoverage({
    scope: "tool.effects",
    modes: ["intercepted", "verified"],
    gaps: [{
      kind: "opaque",
      scope: "tool.effects",
      reason: "opaque operation effects are not prospectively enumerable",
    }],
    evidenceEventIds,
  }).coverageId);
});
