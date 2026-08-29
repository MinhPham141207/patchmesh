import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteEventStore } from "patchmesh-storage";
import { backfillAttribution } from "../src/ingest.js";

const source = {
  kind: "gateway" as const,
  sourceId: "source_gateway",
  instanceId: "11111111-1111-4111-8111-111111111111",
};

function request(idNum: number, corr: string, taskId: string | null) {
  return {
    schemaVersion: 1,
    eventId: `evt_${idNum.toString(16).padStart(32, "0")}`,
    eventType: "tool.requested" as const,
    source,
    timestamp: "2026-08-29T00:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_a",
    taskId,
    correlationId: corr,
    causationId: null,
    sourceSequence: 0,
    payload: { toolName: "read_file", operation: "read", targetResourceId: null, opaque: false },
  };
}

function completion(idNum: number, reqId: string, corr: string, taskId: string | null) {
  return {
    schemaVersion: 1,
    eventId: `evt_${idNum.toString(16).padStart(32, "0")}`,
    eventType: "tool.completed" as const,
    source,
    timestamp: "2026-08-29T00:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_a",
    taskId,
    correlationId: corr,
    causationId: reqId,
    sourceSequence: 1,
    payload: { requestEventId: reqId, outcome: "succeeded" as const, exitCode: 0, effectEventIds: [] },
  };
}

function withTmpDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "pm-bf-"));
    try {
      await fn(root);
    } finally {
      // On Windows, SQLite WAL files may still be locked. Retry cleanup without blocking the test.
      try {
        const { rmSync } = await import("node:fs");
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; leftover temp dirs are harmless.
      }
    }
  };
}

test("backfill propagates single task to null-attribution events in same correlation", withTmpDir(async (root) => {
  const dbPath = join(root, "ledger.db");
  const store = SqliteEventStore.open(dbPath);
  const c = "corr_00000000000000000000000000000001";

  store.appendAtomic([request(1, c, "task_real"), completion(2, "evt_00000000000000000000000000000001", c, "task_real")]);
  store.appendAtomic([request(3, c, null), completion(4, "evt_00000000000000000000000000000003", c, null)]);
  store.appendAtomic([request(5, c, null), completion(6, "evt_00000000000000000000000000000005", c, null)]);
  store.close();

  backfillAttribution(dbPath);

  const v = SqliteEventStore.open(dbPath);
  const rows = v.read({});
  assert.equal(rows.filter((r: any) => r.taskId === null).length, 0, "no nulls");
  assert.equal(rows.filter((r: any) => r.taskId === "task_real").length, 6, "all attributed");
  v.close();
}));

test("backfill leaves null when correlation has multiple tasks", withTmpDir(async (root) => {
  const dbPath = join(root, "ledger.db");
  const store = SqliteEventStore.open(dbPath);
  const c = "corr_00000000000000000000000000000002";

  store.appendAtomic([request(1, c, "task_a"), completion(2, "evt_00000000000000000000000000000001", c, "task_a")]);
  store.appendAtomic([request(3, c, "task_b"), completion(4, "evt_00000000000000000000000000000003", c, "task_b")]);
  store.appendAtomic([request(5, c, null), completion(6, "evt_00000000000000000000000000000005", c, null)]);
  store.close();

  backfillAttribution(dbPath);

  const v = SqliteEventStore.open(dbPath);
  const rows = v.read({});
  assert.equal(rows.filter((r: any) => r.taskId === null).length, 2, "ambiguous stays null");
  v.close();
}));

test("backfill leaves null when correlation has zero tasks", withTmpDir(async (root) => {
  const dbPath = join(root, "ledger.db");
  const store = SqliteEventStore.open(dbPath);
  const c = "corr_00000000000000000000000000000003";

  store.appendAtomic([request(1, c, null), completion(2, "evt_00000000000000000000000000000001", c, null)]);
  store.appendAtomic([request(3, c, null), completion(4, "evt_00000000000000000000000000000003", c, null)]);
  store.close();

  backfillAttribution(dbPath);

  const v = SqliteEventStore.open(dbPath);
  const rows = v.read({});
  assert.equal(rows.filter((r: any) => r.taskId === null).length, 4, "all stay null");
  v.close();
}));
