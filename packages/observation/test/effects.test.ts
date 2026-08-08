import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileResourceId,
  normalizeLogicalPath,
  sanitizeDiagnostic,
} from "../src/index.js";

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
