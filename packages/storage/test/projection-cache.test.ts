import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import type {
  EventId,
  FileChangedEvent,
  FileReadEvent,
  LogicalResource,
  ProtocolEvent,
  ResourceId,
  ResourceVersion,
  RepositoryId,
  TaskId,
  ToolCompletedEvent,
  ToolRequestedEvent,
  WorktreeId,
  WorkspaceId,
} from "patchmesh-protocol";
import { openDatabase } from "../src/database.js";
import { canonicalBytes, SqliteEventStore, clearProjectionCacheStats, projectWorkGraph, projectWorkGraphCached, projectionCacheStats } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "patchmesh-projection-cache-"));
  dirs.push(dir);
  return join(dir, "ledger.db");
}

const repositoryId = "repo_11111111-1111-4111-8111-111111111111" as RepositoryId;
const workspaceId = "ws_22222222-2222-4222-8222-222222222222" as WorkspaceId;
const resourceId = `res_${"a".repeat(64)}` as ResourceId;
const taskId = "task_task-a" as TaskId;

const resource: LogicalResource = {
  resourceId,
  repositoryId,
  kind: "file",
  locator: "src/example.ts",
};

function contentVersion(id: ResourceId, value: string, eventId: string): ResourceVersion {
  return {
    resourceId: id,
    domain: {
      repositoryId,
      workspaceId,
      worktreeId: "wt_33333333-3333-4333-8333-333333333333" as WorktreeId,
    },
    kind: "content_hash",
    value,
    evidenceEventIds: [eventId as EventId],
  };
}

function baseEvent(
  eventId: string,
  correlationId: string,
): Omit<ProtocolEvent, "eventType" | "payload"> {
  return {
    schemaVersion: 1,
    eventId: eventId as EventId,
    source: {
      kind: "watcher",
      sourceId: "source_watcher",
      instanceId: "11111111-1111-4111-8111-111111111111",
    },
    timestamp: "2026-08-08T00:00:00.000Z",
    repositoryId,
    workspaceId,
    worktreeId: "wt_33333333-3333-4333-8333-333333333333" as WorktreeId,
    agentId: "agent_agent-a",
    taskId,
    correlationId: correlationId as ProtocolEvent["correlationId"],
    causationId: null,
    sourceSequence: null,
  };
}

const scenarioGateway = {
  kind: "gateway",
  sourceId: "source_gateway",
  instanceId: "11111111-1111-4111-8111-111111111111",
} as const;

function scenarioId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(32, "0")}`;
}

/**
 * One intercepted call as three events - request, watcher change bound to it, completion
 * naming the change as its effect. Deterministic in identity and order only.
 */
function scenarioCall(index: number): readonly ProtocolEvent[] {
  const at = new Date(Date.parse("2026-08-08T00:00:00.000Z") + index * 1000).toISOString();
  const requestEventId = scenarioId("evt", index * 3) as EventId;
  const changeEventId = scenarioId("evt", index * 3 + 1) as EventId;
  const completionEventId = scenarioId("evt", index * 3 + 2) as EventId;
  const correlationId = scenarioId("corr", index) as ProtocolEvent["correlationId"];

  const request: ToolRequestedEvent = {
    ...baseEvent(requestEventId, correlationId),
    source: scenarioGateway,
    sourceSequence: index * 2,
    timestamp: at,
    eventType: "tool.requested",
    payload: { toolName: "edit_file", operation: `edit src/f${index}.ts`, targetResourceId: resourceId, opaque: false },
  };

  const change: FileChangedEvent = {
    ...baseEvent(changeEventId, correlationId),
    timestamp: at,
    causationId: requestEventId,
    eventType: "file.changed",
    payload: {
      resource,
      beforeVersion: contentVersion(resourceId, `before-${index}`, changeEventId),
      afterVersion: contentVersion(resourceId, `after-${index}`, changeEventId),
      changeKind: "modified",
    },
  };

  const completion: ToolCompletedEvent = {
    ...baseEvent(completionEventId, correlationId),
    source: scenarioGateway,
    sourceSequence: index * 2 + 1,
    timestamp: at,
    causationId: requestEventId,
    eventType: "tool.completed",
    payload: { requestEventId, outcome: "succeeded", exitCode: 0, effectEventIds: [changeEventId] },
  };

  return [request, change, completion];
}

/** `count` intercepted calls, three events each; the same N always yields the same prefix. */
function buildScenarioEvents(count: number): readonly ProtocolEvent[] {
  const events: ProtocolEvent[] = [];
  for (let index = 0; index < count; index += 1) events.push(...scenarioCall(index));
  return events;
}

function buildLedger(events: readonly ProtocolEvent[]): string {
  const path = tempLedgerPath();
  const store = SqliteEventStore.open(path);
  try {
    for (const event of events) store.append(event);
  } finally {
    store.close();
  }
  return path;
}

test("first read rebuilds fully; second read of an unchanged ledger applies zero events", () => {
  clearProjectionCacheStats();
  const path = buildLedger(buildScenarioEvents(30));
  const first = projectWorkGraphCached(path);
  assert.equal(projectionCacheStats().lastAppliedCount > 0, true);
  const second = projectWorkGraphCached(path);
  assert.equal(JSON.stringify(second.snapshot), JSON.stringify(first.snapshot));
  const stats = projectionCacheStats();
  assert.equal(stats.zeroDeltaServes, 1);
  assert.equal(stats.lastAppliedCount, 0);
});

test("an appended suffix is applied incrementally and stays byte-identical to full replay", () => {
  clearProjectionCacheStats();
  const early = buildScenarioEvents(25);
  const path = buildLedger(early);
  projectWorkGraphCached(path);

  const later = buildScenarioEvents(40); // superset generator: first 75 events identical ids
  const store = SqliteEventStore.open(path);
  try {
    for (const event of later.slice(early.length)) store.append(event);
  } finally {
    store.close();
  }

  const incremental = projectWorkGraphCached(path);
  const full = projectWorkGraph(later);
  // Canonical rather than literal JSON: ledger rows are stored as canonical JSON, so
  // snapshots rebuilt from read-back events carry sorted object keys that in-memory
  // generator events do not. Canonical bytes are the byte-identity that matters.
  assert.deepEqual(canonicalBytes(incremental.snapshot), canonicalBytes(full.snapshot));
  assert.deepEqual(incremental.sourceSequenceGaps, full.sourceSequenceGaps);
  assert.equal(projectionCacheStats().lastAppliedCount, 45);
});

test("pruning the watermarked row invalidates the checkpoint", () => {
  clearProjectionCacheStats();
  const events = buildScenarioEvents(20);
  const path = buildLedger(events);
  projectWorkGraphCached(path);
  const database = openDatabase(path);
  database.exec("DELETE FROM events"); // brutal prune: the watermarked row cannot survive
  database.close();
  projectWorkGraphCached(path); // must not throw, must serve a correct empty snapshot
  const served = projectWorkGraphCached(path);
  assert.equal(served.snapshot.nodes.length, 0);
});

test("a corrupt checkpoint degrades to full rebuild", () => {
  clearProjectionCacheStats();
  const path = buildLedger(buildScenarioEvents(20));
  projectWorkGraphCached(path);
  const database = openDatabase(path);
  database.exec("UPDATE projection_checkpoint SET state_blob = '{not json'");
  database.close();
  const served = projectWorkGraphCached(path);
  assert.deepEqual(
    canonicalBytes(served.snapshot),
    canonicalBytes(projectWorkGraph(buildScenarioEvents(20)).snapshot),
  );
});

test("verify forces a full validated replay", () => {
  clearProjectionCacheStats();
  const path = buildLedger(buildScenarioEvents(20));
  projectWorkGraphCached(path);
  const verified = projectWorkGraphCached(path, { verify: true });
  assert.deepEqual(
    canonicalBytes(verified.snapshot),
    canonicalBytes(projectWorkGraph(buildScenarioEvents(20)).snapshot),
  );
  // The verified run rewrote the checkpoint, so the next plain read serves zero delta.
  projectWorkGraphCached(path);
  assert.equal(projectionCacheStats().zeroDeltaServes, 1);
});
