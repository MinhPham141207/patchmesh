import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProtocolValidationError,
  type ToolCompletedEvent,
  type ToolRequestedEvent,
} from "@patchmesh/protocol";
import {
  canonicalDigest,
  SqliteEventStore,
  StorageError,
} from "../src/index.js";

const request: ToolRequestedEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001",
  eventType: "tool.requested",
  source: {
    kind: "gateway",
    sourceId: "source_gateway",
    instanceId: "11111111-1111-4111-8111-111111111111",
  },
  timestamp: "2026-08-08T00:00:00.000Z",
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_22222222-2222-4222-8222-222222222222",
  worktreeId: "wt_33333333-3333-4333-8333-333333333333",
  agentId: "agent_a",
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0,
  payload: {
    toolName: "read_file",
    operation: "read src/example.ts",
    targetResourceId: null,
    opaque: false,
  },
};

const completion: ToolCompletedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000002",
  eventType: "tool.completed",
  causationId: request.eventId,
  sourceSequence: 1,
  payload: {
    requestEventId: request.eventId,
    outcome: "succeeded",
    exitCode: 0,
    effectEventIds: [],
  },
};

async function withTemporaryDatabase(run: (databasePath: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m2-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    await run(databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test("creates the migration and events tables", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  assert.deepEqual(store.read(), []);
  store.close();
}));

test("reopens the same database after migration", () => withTemporaryDatabase((databasePath) => {
  const first = SqliteEventStore.open(databasePath);
  first.close();

  const second = SqliteEventStore.open(databasePath);
  assert.deepEqual(second.read(), []);
  second.close();
}));

test("canonical digest ignores object key insertion order", () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };

  assert.equal(canonicalDigest(left), canonicalDigest(right));
});

test("identical duplicate is a no-op", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.equal(store.append(request).status, "inserted");
  const duplicate = store.append(structuredClone(request));

  assert.equal(duplicate.status, "duplicate");
  assert.equal(store.read().length, 1);
  store.close();
}));

test("conflicting content for one event ID fails deterministically", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.append(request);

  assert.throws(
    () => store.append({ ...request, timestamp: "2026-08-08T00:00:01.000Z" }),
    (error: unknown) => error instanceof StorageError && error.code === "PHASE0_ID_CONFLICT",
  );
  assert.equal(store.read().length, 1);
  store.close();
}));

test("malformed input is rejected before persistence", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.throws(() => store.append({}), ProtocolValidationError);
  assert.deepEqual(store.read(), []);
  store.close();
}));

test("out-of-order causal child can be appended before its parent", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.equal(store.append(completion).status, "inserted");
  assert.equal(store.read()[0]?.eventId, completion.eventId);
  store.close();
}));

test("raw reads preserve arrival order across restart", () => withTemporaryDatabase((databasePath) => {
  const first = SqliteEventStore.open(databasePath);
  first.append(completion);
  first.append(request);
  assert.deepEqual(first.read().map((event) => event.eventId), [completion.eventId, request.eventId]);
  first.close();

  const second = SqliteEventStore.open(databasePath);
  assert.deepEqual(second.read().map((event) => event.eventId), [completion.eventId, request.eventId]);
  second.close();
}));

test("raw read results are frozen defensive copies", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.append(request);
  const [event] = store.read();
  assert.ok(event);

  assert.throws(() => {
    (event as { timestamp: string }).timestamp = "2026-08-09T00:00:00.000Z";
  }, TypeError);
  assert.equal(store.read()[0]?.timestamp, request.timestamp);
  store.close();
}));

test("raw reads support event, correlation, and causation filters", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.append(request);
  store.append(completion);

  assert.deepEqual(store.read({ eventType: "tool.completed" }).map((event) => event.eventId), [completion.eventId]);
  assert.deepEqual(store.read({ correlationId: request.correlationId }).map((event) => event.eventId), [request.eventId, completion.eventId]);
  assert.deepEqual(store.read({ causationId: request.eventId }).map((event) => event.eventId), [completion.eventId]);
  store.close();
}));

test("operations after close return a typed storage error", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.close();

  assert.throws(
    () => store.read(),
    (error: unknown) => error instanceof StorageError && error.code === "STORAGE_CLOSED",
  );
}));
