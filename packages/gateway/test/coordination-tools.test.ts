import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimFile,
  releaseClaims,
  readActiveClaims,
  cleanupExpiredClaims,
  checkContention,
  readRetryState,
  incrementRetry,
} from "patchmesh-recorder";
import { filterContentionCalls, renderContentionCheck } from "../src/index.js";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-coordination-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".patchmesh"), { recursive: true });
  return root;
}

// --- Claim system ---

test("claimFile creates a claim file", () => {
  const root = repository();
  try {
    const claim = claimFile({
      worktreeRoot: root,
      agentId: "agent_test",
      paths: ["src/auth.ts", "src/config.ts"],
      ttlSeconds: 60,
    });

    assert.equal(claim.agentId, "agent_test");
    assert.equal(claim.paths.length, 2);
    assert.ok(claim.paths.includes("src/auth.ts"));
    assert.ok(claim.paths.includes("src/config.ts"));
    assert.ok(new Date(claim.expires) > new Date());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readActiveClaims returns non-expired claims", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_active",
      paths: ["src/active.ts"],
      ttlSeconds: 60,
    });

    const claims = readActiveClaims({ worktreeRoot: root });
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.agentId, "agent_active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readActiveClaims filters out expired claims", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_expired",
      paths: ["src/expired.ts"],
      ttlSeconds: 1,
    });

    // Manually expire the claim by modifying the file
    const claimPath = join(root, ".patchmesh", "claims", "agent_expired.json");
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    claim.expires = new Date(Date.now() - 1000).toISOString();
    writeFileSync(claimPath, JSON.stringify(claim), "utf8");

    const claims = readActiveClaims({ worktreeRoot: root });
    assert.equal(claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseClaims removes specified paths", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_release",
      paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      ttlSeconds: 60,
    });

    releaseClaims({
      worktreeRoot: root,
      agentId: "agent_release",
      paths: ["src/a.ts", "src/c.ts"],
    });

    const claims = readActiveClaims({ worktreeRoot: root });
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.paths.length, 1);
    assert.ok(claims[0]!.paths.includes("src/b.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseClaims removes claim file when all paths released", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_full_release",
      paths: ["src/only.ts"],
      ttlSeconds: 60,
    });

    releaseClaims({
      worktreeRoot: root,
      agentId: "agent_full_release",
      paths: ["src/only.ts"],
    });

    const claims = readActiveClaims({ worktreeRoot: root });
    assert.equal(claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredClaims removes expired claims", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_cleanup",
      paths: ["src/cleanup.ts"],
      ttlSeconds: 1,
    });

    // Manually expire the claim
    const claimPath = join(root, ".patchmesh", "claims", "agent_cleanup.json");
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    claim.expires = new Date(Date.now() - 1000).toISOString();
    writeFileSync(claimPath, JSON.stringify(claim), "utf8");

    const removed = cleanupExpiredClaims({ worktreeRoot: root });
    assert.equal(removed, 1);

    const claims = readActiveClaims({ worktreeRoot: root });
    assert.equal(claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Contention check ---

test("checkContention returns no contention when no claims or in-flight calls", () => {
  const root = repository();
  try {
    const result = checkContention({
      worktreeRoot: root,
      path: "src/clean.ts",
    });

    assert.equal(result.hasContention, false);
    assert.equal(result.claims.length, 0);
    assert.equal(result.inFlight.length, 0);
    assert.equal(result.overlapping, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkContention detects active claims", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_other",
      paths: ["src/shared.ts"],
      ttlSeconds: 60,
    });

    const result = checkContention({
      worktreeRoot: root,
      path: "src/shared.ts",
      agentId: "agent_me",
    });

    assert.equal(result.hasContention, true);
    assert.equal(result.claims.length, 1);
    assert.equal(result.overlapping, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkContention excludes caller's own claims", () => {
  const root = repository();
  try {
    claimFile({
      worktreeRoot: root,
      agentId: "agent_me",
      paths: ["src/mine.ts"],
      ttlSeconds: 60,
    });

    const result = checkContention({
      worktreeRoot: root,
      path: "src/mine.ts",
      agentId: "agent_me",
    });

    assert.equal(result.hasContention, false);
    assert.equal(result.claims.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Retry state ---

test("readRetryState returns null when no retries", () => {
  const root = repository();
  try {
    const state = readRetryState({
      worktreeRoot: root,
      path: "src/new.ts",
      agentId: "agent_fresh",
    });

    assert.equal(state, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incrementRetry creates and increments retry state", () => {
  const root = repository();
  try {
    const first = incrementRetry({
      worktreeRoot: root,
      path: "src/retry.ts",
      agentId: "agent_retry",
    });

    assert.equal(first.retryCount, 1);
    assert.equal(first.path, "src/retry.ts");
    assert.equal(first.agentId, "agent_retry");

    const second = incrementRetry({
      worktreeRoot: root,
      path: "src/retry.ts",
      agentId: "agent_retry",
    });

    assert.equal(second.retryCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Render functions ---

test("renderContentionCheck with claims data", () => {
  const calls = [
    {
      at: "2026-08-31T11:59:50.000Z",
      agentId: "agent_abc",
      hostToolName: "Edit",
      operation: null,
      filePath: "src/auth.ts",
      runningForMs: 10_000,
    },
  ];

  const text = renderContentionCheck(calls, "src/auth.ts");
  assert.ok(text.includes("agent_abc"));
  assert.ok(text.includes("Edit"));
  assert.ok(text.includes("src/auth.ts"));
});

test("renderContentionCheck handles empty list", () => {
  const text = renderContentionCheck([], "src/empty.ts");
  assert.equal(text, "No agents currently modifying `src/empty.ts`.");
});
