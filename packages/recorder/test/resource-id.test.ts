import assert from "node:assert/strict";
import { test } from "node:test";
import { fileResourceId } from "@patchmesh/observation";
import type { RepositoryId } from "@patchmesh/protocol";
import { resourceIdForPath } from "../src/index.js";

const REPOSITORY = "repo_8c5e3b00-39c9-5b2e-83a3-050ecab9cf1b" as RepositoryId;

/**
 * The recorder cannot import the shared derivation - it is loaded by the per-tool-call hook,
 * whose import graph must stay free of packages. This is the same arrangement redaction uses:
 * duplicate the implementation, and pin the two together with a test.
 */
test("recorded call resources and observed effect resources are the same identity", () => {
  const paths = [
    "notes.md",
    "src/index.ts",
    "packages/recorder/src/identity.ts",
    "a/b/c/deeply/nested/file.json",
    "unicode/café.txt",
    "spaced name/with-dash_and.dot.ts",
  ];
  for (const path of paths) {
    assert.equal(
      resourceIdForPath(REPOSITORY, path),
      fileResourceId(REPOSITORY, path),
      `a call and an effect must name ${path} identically, or a change never joins its call`,
    );
  }
});

test("the same path always resolves to the same resource, and different paths do not collide", () => {
  assert.equal(resourceIdForPath(REPOSITORY, "notes.md"), resourceIdForPath(REPOSITORY, "notes.md"));
  assert.notEqual(resourceIdForPath(REPOSITORY, "notes.md"), resourceIdForPath(REPOSITORY, "other.md"));
  assert.match(resourceIdForPath(REPOSITORY, "notes.md"), /^res_[0-9a-f]{64}$/u);
});
