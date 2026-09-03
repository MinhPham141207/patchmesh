import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoleConfig, roleById } from "patchmesh-protocol";
import { isWithinScope } from "patchmesh-query";
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
