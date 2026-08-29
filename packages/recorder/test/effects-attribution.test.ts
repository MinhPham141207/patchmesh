import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ObservedFileChange } from "patchmesh-observation";
import { bindChange, type EffectAttributionCall } from "../src/effects.js";

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-attribution-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function makeCall(overrides: Partial<EffectAttributionCall> = {}): EffectAttributionCall {
  return {
    completionEventId: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" as never,
    correlationId: "corr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1" as never,
    agentId: "agent_parent" as never,
    taskId: "task_1" as never,
    startedAtMs: 1000,
    completedAtMs: 5000,
    declaredPath: null,
    ...overrides,
  };
}

function makeChange(root: string, path = "src/index.ts"): ObservedFileChange {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), "content\n", "utf8");
  return {
    path,
    changeKind: "modified",
    before: { contentHash: "aaa", gitBlob: null, fileKind: "file" },
    after: { contentHash: "bbb", gitBlob: null, fileKind: "file" },
    outOfBand: false,
  };
}

function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "." : p.slice(0, idx);
}

test("nestedCallCovering binds to child when parent+child windows overlap", () => {
  const root = temporaryWorktree();
  try {
    const change = makeChange(root);
    const mtime = Math.floor(statSync(join(root, change.path)).mtimeMs);

    const parent = makeCall({
      agentId: "agent_parent" as never,
      startedAtMs: mtime - 5000,
      completedAtMs: mtime + 5000,
    });
    const child = makeCall({
      agentId: "agent_parent.sub_1" as never,
      startedAtMs: mtime - 2000,
      completedAtMs: mtime + 2000,
      taskId: "task_child" as never,
    });

    const result = bindChange(root, change, [parent, child]);
    assert.equal(result?.taskId, "task_child");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nestedCallCovering falls back to null for unrelated concurrent calls", () => {
  const root = temporaryWorktree();
  try {
    const change = makeChange(root);
    const mtime = Math.floor(statSync(join(root, change.path)).mtimeMs);

    const callA = makeCall({
      agentId: "agent_a" as never,
      startedAtMs: mtime - 5000,
      completedAtMs: mtime + 5000,
    });
    const callB = makeCall({
      agentId: "agent_b" as never,
      startedAtMs: mtime - 2000,
      completedAtMs: mtime + 2000,
    });

    const result = bindChange(root, change, [callA, callB]);
    assert.equal(result, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("soleCallCovering unchanged for single call", () => {
  const root = temporaryWorktree();
  try {
    const change = makeChange(root);
    const mtime = Math.floor(statSync(join(root, change.path)).mtimeMs);

    const call = makeCall({
      startedAtMs: mtime - 1000,
      completedAtMs: mtime + 1000,
    });

    const result = bindChange(root, change, [call]);
    assert.equal(result?.agentId, "agent_parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
