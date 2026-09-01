import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import {
  claimFile,
  claimsDirectory,
  cleanupExpiredClaims,
  readActiveClaims,
  releaseClaims,
} from "../src/claims.js";

function worktree(): string {
  const root = join(tmpdir(), `patchmesh-claims-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root);
  return root;
}

test("claimFile creates a claim and readActiveClaims returns it", () => {
  const root = worktree();
  try {
    const claim = claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/a.ts", "src/b.ts"] });
    assert.equal(claim.agentId, "agent_a");
    assert.deepEqual([...claim.paths], ["src/a.ts", "src/b.ts"]);
    assert.equal(typeof claim.started, "string");
    assert.equal(typeof claim.expires, "string");

    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 1);
    assert.equal(active[0]!.agentId, "agent_a");
    assert.deepEqual([...active[0]!.paths], ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claimsDirectory returns the correct path", () => {
  assert.ok(claimsDirectory("/repo").endsWith(join(".patchmesh", "claims")));
  assert.ok(claimsDirectory("/repo", ".other").endsWith(join(".other", "claims")));
});

test("default TTL is 5 minutes", () => {
  const root = worktree();
  try {
    const claim = claimFile({ worktreeRoot: root, agentId: "agent_ttl", paths: ["x.ts"] });
    const started = new Date(claim.started).getTime();
    const expires = new Date(claim.expires).getTime();
    assert.equal(expires - started, 300_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TTL is clamped to max 1800 seconds", () => {
  const root = worktree();
  try {
    const claim = claimFile({ worktreeRoot: root, agentId: "agent_max", paths: ["x.ts"], ttlSeconds: 9999 });
    const started = new Date(claim.started).getTime();
    const expires = new Date(claim.expires).getTime();
    assert.equal(expires - started, 1800_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TTL minimum is 1 second", () => {
  const root = worktree();
  try {
    const claim = claimFile({ worktreeRoot: root, agentId: "agent_min", paths: ["x.ts"], ttlSeconds: -10 });
    const started = new Date(claim.started).getTime();
    const expires = new Date(claim.expires).getTime();
    assert.equal(expires - started, 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readActiveClaims excludes expired claims", async () => {
  const root = worktree();
  try {
    const dir = claimsDirectory(root);
    mkdirSync(dir, { recursive: true });
    const expired = {
      agentId: "agent_expired",
      paths: ["old.ts"],
      started: "2026-01-01T00:00:00.000Z",
      expires: "2026-01-01T00:00:01.000Z",
    };
    writeFileSync(join(dir, "agent_expired.json"), JSON.stringify(expired));

    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readActiveClaims returns empty for missing directory", () => {
  const root = worktree();
  try {
    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseClaims removes matching paths from claim", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_rel", paths: ["a.ts", "b.ts", "c.ts"] });
    releaseClaims({ worktreeRoot: root, agentId: "agent_rel", paths: ["b.ts"] });

    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 1);
    assert.deepEqual([...active[0]!.paths], ["a.ts", "c.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseClaims deletes file when all paths released", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_all", paths: ["only.ts"] });
    releaseClaims({ worktreeRoot: root, agentId: "agent_all", paths: ["only.ts"] });

    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseClaims is no-op for non-existent agent", () => {
  const root = worktree();
  try {
    releaseClaims({ worktreeRoot: root, agentId: "ghost", paths: ["x.ts"] });
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredClaims removes expired files and returns count", () => {
  const root = worktree();
  try {
    const dir = claimsDirectory(root);
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "expired.json"),
      JSON.stringify({ agentId: "expired", paths: ["x.ts"], started: "2026-01-01T00:00:00Z", expires: "2026-01-01T00:00:01Z" }),
    );
    writeFileSync(
      join(dir, "valid.json"),
      JSON.stringify({ agentId: "valid", paths: ["y.ts"], started: "2099-01-01T00:00:00Z", expires: "2099-12-31T23:59:59Z" }),
    );

    const removed = cleanupExpiredClaims({ worktreeRoot: root });
    assert.equal(removed, 1);
    assert.ok(!existsSync(join(dir, "expired.json")));
    assert.ok(existsSync(join(dir, "valid.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredClaims handles missing directory", () => {
  const root = worktree();
  try {
    assert.equal(cleanupExpiredClaims({ worktreeRoot: root }), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupExpiredClaims removes corrupt JSON files", () => {
  const root = worktree();
  try {
    const dir = claimsDirectory(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "not json {{{");

    const removed = cleanupExpiredClaims({ worktreeRoot: root });
    assert.equal(removed, 1);
    assert.ok(!existsSync(join(dir, "bad.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent claims from different agents are independent", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_x", paths: ["shared.ts"] });
    claimFile({ worktreeRoot: root, agentId: "agent_y", paths: ["shared.ts"] });

    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 2);
    const ids = active.map((c) => c.agentId).sort();
    assert.deepEqual(ids, ["agent_x", "agent_y"]);

    releaseClaims({ worktreeRoot: root, agentId: "agent_x", paths: ["shared.ts"] });
    const after = readActiveClaims({ worktreeRoot: root });
    assert.equal(after.length, 1);
    assert.equal(after[0]!.agentId, "agent_y");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty paths array creates a valid claim", () => {
  const root = worktree();
  try {
    const claim = claimFile({ worktreeRoot: root, agentId: "agent_empty", paths: [] });
    assert.deepEqual([...claim.paths], []);
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agentId with special characters is sanitized in filename", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent/with:special chars", paths: ["x.ts"] });
    const dir = claimsDirectory(root);
    const files = readdirSync(dir);
    assert.ok(files.length === 1);
    assert.ok(!files[0]!.includes("/"));
    assert.ok(!files[0]!.includes(":"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TTL expiry with real delay", async () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_short", paths: ["fast.ts"], ttlSeconds: 1 });
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1);
    await sleep(1100);
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
