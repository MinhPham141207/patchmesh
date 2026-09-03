import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoleConfig, roleById } from "patchmesh-protocol";
import { classifyContention, isWithinScope } from "patchmesh-query";
import { resolveRoleClaim } from "patchmesh-recorder";

const config = parseRoleConfig({
  version: 1,
  roles: [
    { id: "builder", purpose: "builds", owns: ["packages/**"], reads: ["docs/**"], handoffTo: ["reviewer"] },
    { id: "reviewer", purpose: "reviews", owns: ["docs/**"], reads: ["packages/**"], handoffTo: ["builder"] },
  ],
  bindings: [{ host: "codex", role: "reviewer" }],
});

test("parseRoleConfig rejects unknown binding role", () => {
  assert.throws(() =>
    parseRoleConfig({
      version: 1,
      roles: [{ id: "builder", purpose: "b", owns: [], reads: [], handoffTo: [] }],
      bindings: [{ host: "codex", role: "ghost" }],
    }),
  );
});

test("scope check matches owns globs, not prefixes", () => {
  const builder = roleById(config, "builder")!;
  assert.equal(isWithinScope(builder, "packages/foo/bar.ts"), true);
  assert.equal(isWithinScope(builder, "docs/foo.md"), false);
  assert.equal(isWithinScope(builder, "packages-evil/foo.ts"), false);
});

test("env claim beats host binding", () => {
  const resolved = resolveRoleClaim({ envRole: "builder", hostId: "codex", config });
  assert.equal(resolved?.role.id, "builder");
  assert.equal(resolved?.method, "env");
});

test("host binding applies when no env claim", () => {
  const resolved = resolveRoleClaim({ hostId: "codex", config });
  assert.equal(resolved?.role.id, "reviewer");
  assert.equal(resolved?.method, "binding");
});

test("unassigned agent resolves null", () => {
  assert.equal(resolveRoleClaim({ hostId: "opencode", config }), null);
  assert.equal(resolveRoleClaim({ hostId: "codex", config: null }), null);
});

const builderScope = { roleId: "builder", owns: ["packages/**"] as readonly string[] };
const reviewerScope = { roleId: "reviewer", owns: ["docs/**"] as readonly string[] };

test("overlap is contention when both workers own the file", () => {
  assert.equal(
    classifyContention({
      earlier: builderScope,
      later: { roleId: "builder2", owns: ["packages/**"] },
      logicalPath: "packages/foo.ts",
    }),
    "contention",
  );
});

test("overlap is boundary when the writer's role does not own the file", () => {
  assert.equal(
    classifyContention({ earlier: builderScope, later: reviewerScope, logicalPath: "packages/foo.ts" }),
    "boundary",
  );
});

test("overlap is contention when one worker is unassigned", () => {
  assert.equal(
    classifyContention({ earlier: builderScope, later: null, logicalPath: "packages/foo.ts" }),
    "contention",
  );
  assert.equal(
    classifyContention({ earlier: null, later: null, logicalPath: "packages/foo.ts" }),
    "contention",
  );
});
