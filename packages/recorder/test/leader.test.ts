import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimFile, claimsDirectory } from "../src/claims.js";
import {
  MAX_RETRIES,
  checkContention,
  cleanupRetryFiles,
  incrementRetry,
  readRetryState,
  shouldAllow,
} from "../src/leader.js";

function worktree(): string {
  const root = join(tmpdir(), `patchmesh-leader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root);
  return root;
}

test("checkContention returns empty when no claims or in-flight calls", () => {
  const root = worktree();
  try {
    const result = checkContention({ worktreeRoot: root, path: "src/a.ts" });
    assert.equal(result.hasContention, false);
    assert.equal(result.claims.length, 0);
    assert.equal(result.inFlight.length, 0);
    assert.equal(result.overlapping, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkContention detects active claims on the same path", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/auth.ts"] });
    const result = checkContention({ worktreeRoot: root, path: "src/auth.ts", agentId: "agent_b" });
    assert.equal(result.hasContention, true);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0]!.agentId, "agent_a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkContention excludes own claims", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/auth.ts"] });
    const result = checkContention({ worktreeRoot: root, path: "src/auth.ts", agentId: "agent_a" });
    assert.equal(result.hasContention, false);
    assert.equal(result.claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkContention returns claims on different paths as no contention", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/b.ts"] });
    const result = checkContention({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_b" });
    assert.equal(result.hasContention, false);
    assert.equal(result.claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readRetryState returns null when no retry file exists", () => {
  const root = worktree();
  try {
    const state = readRetryState({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    assert.equal(state, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incrementRetry creates a retry state with count 1", () => {
  const root = worktree();
  try {
    const state = incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    assert.equal(state.retryCount, 1);
    assert.equal(state.path, "src/a.ts");
    assert.equal(state.agentId, "agent_x");
    assert.equal(typeof state.lastDeniedAt, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incrementRetry increments existing retry count", () => {
  const root = worktree();
  try {
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    const state = incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    assert.equal(state.retryCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readRetryState returns persisted state", () => {
  const root = worktree();
  try {
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    const state = readRetryState({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    assert.notEqual(state, null);
    assert.equal(state!.retryCount, 1);
    assert.equal(state!.path, "src/a.ts");
    assert.equal(state!.agentId, "agent_x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldAllow returns false when retryCount < MAX_RETRIES", () => {
  const root = worktree();
  try {
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    assert.equal(shouldAllow({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldAllow returns true when retryCount >= MAX_RETRIES", () => {
  const root = worktree();
  try {
    for (let i = 0; i < MAX_RETRIES; i++) {
      incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    }
    assert.equal(shouldAllow({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shouldAllow returns false when no retry file exists", () => {
  const root = worktree();
  try {
    assert.equal(shouldAllow({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry files are independent per path + agent combination", () => {
  const root = worktree();
  try {
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    incrementRetry({ worktreeRoot: root, path: "src/b.ts", agentId: "agent_x" });
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_y" });

    assert.equal(readRetryState({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" })!.retryCount, 1);
    assert.equal(readRetryState({ worktreeRoot: root, path: "src/b.ts", agentId: "agent_x" })!.retryCount, 1);
    assert.equal(readRetryState({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_y" })!.retryCount, 1);

    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    assert.equal(readRetryState({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" })!.retryCount, 2);
    assert.equal(readRetryState({ worktreeRoot: root, path: "src/b.ts", agentId: "agent_x" })!.retryCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupRetryFiles removes stale retry files older than 30 minutes", () => {
  const root = worktree();
  try {
    const dir = join(root, ".patchmesh", "pending");
    mkdirSync(dir, { recursive: true });

    const stale = {
      path: "src/stale.ts",
      agentId: "agent_old",
      retryCount: 1,
      lastDeniedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(dir, "retry_stale.json"), JSON.stringify(stale));

    const fresh = {
      path: "src/fresh.ts",
      agentId: "agent_new",
      retryCount: 1,
      lastDeniedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, "retry_fresh.json"), JSON.stringify(fresh));

    const removed = cleanupRetryFiles({ worktreeRoot: root });
    assert.equal(removed, 1);
    assert.ok(!existsSync(join(dir, "retry_stale.json")));
    assert.ok(existsSync(join(dir, "retry_fresh.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupRetryFiles removes corrupt retry files", () => {
  const root = worktree();
  try {
    const dir = join(root, ".patchmesh", "pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "retry_bad.json"), "not json {{{");

    const removed = cleanupRetryFiles({ worktreeRoot: root });
    assert.equal(removed, 1);
    assert.ok(!existsSync(join(dir, "retry_bad.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupRetryFiles handles missing directory", () => {
  const root = worktree();
  try {
    const removed = cleanupRetryFiles({ worktreeRoot: root });
    assert.equal(removed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupRetryFiles ignores non-retry files in pending directory", () => {
  const root = worktree();
  try {
    const dir = join(root, ".patchmesh", "pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other_file.json"), "{}");

    const removed = cleanupRetryFiles({ worktreeRoot: root });
    assert.equal(removed, 0);
    assert.ok(existsSync(join(dir, "other_file.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkContention returns overlapping true when claims exist on same path", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/auth.ts"] });
    const result = checkContention({ worktreeRoot: root, path: "src/auth.ts", agentId: "agent_b" });
    assert.equal(result.overlapping, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry sidecar file is written to pending directory", () => {
  const root = worktree();
  try {
    incrementRetry({ worktreeRoot: root, path: "src/a.ts", agentId: "agent_x" });
    const dir = join(root, ".patchmesh", "pending");
    assert.ok(existsSync(dir));
    const files = readdirSync(dir).filter((f) => f.startsWith("retry_") && f.endsWith(".json"));
    assert.equal(files.length, 1);
    const content = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
    assert.equal(content.path, "src/a.ts");
    assert.equal(content.agentId, "agent_x");
    assert.equal(content.retryCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
