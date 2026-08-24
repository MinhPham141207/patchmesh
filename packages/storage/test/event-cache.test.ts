import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolRequestedEvent } from "patchmesh-protocol";
import {
  clearEventCache,
  eventCacheStats,
  readEventsCached,
  readWindowCached,
  SqliteEventStore,
} from "../src/index.js";

function ledger(): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-cache-"));
  return { root, path: join(root, "ledger.db") };
}

/** One valid event, distinguished only by the two things these tests vary. */
function event(sequence: number, at: string): ToolRequestedEvent {
  return {
    schemaVersion: 1,
    eventId: `evt_${String(sequence).padStart(32, "0")}`,
    eventType: "tool.requested",
    source: {
      kind: "gateway",
      sourceId: "source_gateway",
      instanceId: "11111111-1111-4111-8111-111111111111",
    },
    timestamp: at,
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_a",
    taskId: null,
    correlationId: "corr_00000000000000000000000000000001",
    causationId: null,
    sourceSequence: sequence,
    payload: {
      toolName: "read_file",
      operation: "read src/example.ts",
      targetResourceId: null,
      opaque: false,
    },
  };
}

function write(path: string, events: readonly ToolRequestedEvent[]): void {
  const store = SqliteEventStore.open(path);
  try {
    store.appendAtomic(events);
  } finally {
    store.close();
  }
}

test("an unchecked read reconstructs the same events a checked read does", () => {
  const { root, path } = ledger();
  try {
    write(path, [event(1, "2026-08-22T10:00:00.000Z"), event(2, "2026-08-22T10:01:00.000Z")]);
    const store = SqliteEventStore.open(path);
    try {
      const checked = store.read({});
      const unchecked = store.read({}, { validate: false });
      // Validation is what the read skips, not content: the rows were validated when written.
      assert.deepEqual(JSON.parse(JSON.stringify(unchecked)), JSON.parse(JSON.stringify(checked)));
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cached read serves the same rows and a later append invalidates it", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [event(1, "2026-08-22T10:00:00.000Z")]);
    const first = readEventsCached(path, {}, { validate: false });
    assert.equal(first.length, 1);

    // Same query, untouched ledger: served from memory, and identical.
    assert.equal(readEventsCached(path, {}, { validate: false }), first);

    // The ledger is append-only, so size and mtime moving is what says a window may have new
    // rows in it. A cache that outlived this would answer with yesterday's work.
    write(path, [event(2, "2026-08-22T10:01:00.000Z")]);
    assert.equal(readEventsCached(path, {}, { validate: false }).length, 2);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("two different queries do not share one cache entry", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [event(1, "2026-08-22T10:00:00.000Z"), event(2, "2026-08-22T12:00:00.000Z")]);
    assert.equal(readEventsCached(path, {}, { validate: false }).length, 2);
    assert.equal(
      readEventsCached(path, { since: "2026-08-22T11:00:00.000Z" }, { validate: false }).length,
      1,
    );
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a window read answers the exact boundary while sharing one read per minute", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [
      event(1, "2026-08-22T10:00:10.000Z"),
      event(2, "2026-08-22T10:00:40.000Z"),
      event(3, "2026-08-22T10:01:10.000Z"),
    ]);

    // Two boundaries inside the same minute. They must answer differently -- that is the whole
    // point of asking for a boundary -- while costing one read between them.
    const early = readWindowCached(path, { since: "2026-08-22T10:00:05.000Z" }, { validate: false });
    const late = readWindowCached(path, { since: "2026-08-22T10:00:30.000Z" }, { validate: false });
    assert.equal(early.length, 3);
    assert.equal(late.length, 2);

    // One miss for the first, a hit for the second: before the bucketing, every call minted a
    // new key and the hit count here was zero however many times it was called.
    assert.deepEqual(eventCacheStats(), { hits: 1, misses: 1 });
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a window read never returns an event older than the boundary asked for", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    // The widened read starts at 10:00:00, so this row is inside the *read* and outside the
    // *window*. Returning it would be the cost of bucketing leaking into the answer.
    write(path, [event(1, "2026-08-22T10:00:01.000Z"), event(2, "2026-08-22T10:00:59.000Z")]);
    const events = readWindowCached(path, { since: "2026-08-22T10:00:30.000Z" }, { validate: false });
    assert.deepEqual(events.map((entry) => entry.timestamp), ["2026-08-22T10:00:59.000Z"]);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a window read is still invalidated by an append", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [event(1, "2026-08-22T10:00:10.000Z")]);
    const since = "2026-08-22T10:00:05.000Z";
    assert.equal(readWindowCached(path, { since }, { validate: false }).length, 1);
    // Bucketing widens the key; it must not outlive a write, or a hook would inject the
    // previous session's view of the repository into this one.
    write(path, [event(2, "2026-08-22T10:00:20.000Z")]);
    assert.equal(readWindowCached(path, { since }, { validate: false }).length, 2);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});
