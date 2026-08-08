import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EventId,
  FileReadEvent,
  ProtocolEvent,
  ResourceId,
  ResourceVersion,
  RepositoryId,
  WorkspaceId,
  WorktreeId,
} from "@patchmesh/protocol";
import { SqliteEventStore } from "@patchmesh/storage";
import { ReadServiceError, createReadServices } from "../src/index.js";
import { redactValue } from "../src/redaction.js";
import { parseTimeBound } from "../src/time.js";
import type { EventPage } from "../src/types.js";

const fixtureEvent = {
  eventId: "evt_fixture" as EventId,
  agentId: null,
  taskId: null,
} as ProtocolEvent;

const repositoryId = "repo_11111111-1111-4111-8111-111111111111" as RepositoryId;
const workspaceId = "ws_22222222-2222-4222-8222-222222222222" as WorkspaceId;
const worktreeId = "wt_33333333-3333-4333-8333-333333333333" as WorktreeId;
const resourceId = `res_${"a".repeat(64)}` as ResourceId;

const request: ProtocolEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001" as EventId,
  eventType: "tool.requested",
  source: { kind: "gateway", sourceId: "source_gateway", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-08T00:00:00.000Z",
  repositoryId,
  workspaceId,
  worktreeId,
  agentId: "agent_agent-a",
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0,
  payload: { toolName: "read_file", operation: "read src/example.ts", targetResourceId: resourceId, opaque: false },
};

const readVersion: ResourceVersion = {
  resourceId,
  domain: { repositoryId, workspaceId, worktreeId },
  kind: "content_hash",
  value: "hash",
  evidenceEventIds: ["evt_00000000000000000000000000000002" as EventId],
};

const read: FileReadEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000002" as EventId,
  eventType: "file.read",
  correlationId: "corr_00000000000000000000000000000002",
  sourceSequence: null,
  agentId: null,
  taskId: null,
  payload: {
    resource: { resourceId, repositoryId, kind: "file", locator: "src/example.ts" },
    version: readVersion,
    access: "read",
  },
};

const nextRead: FileReadEvent = {
  ...read,
  eventId: "evt_00000000000000000000000000000003" as EventId,
  correlationId: "corr_00000000000000000000000000000003",
  payload: {
    ...read.payload,
    version: { ...read.payload.version, evidenceEventIds: ["evt_00000000000000000000000000000003" as EventId] },
  },
};

function withFixtureStore(run: (store: SqliteEventStore) => void): void {
  const store = SqliteEventStore.open(":memory:");
  try {
    store.append(request);
    store.append(read);
    run(store);
  } finally {
    store.close();
  }
}

test("event DTO preserves null attribution and cursor fields", () => {
  const page: EventPage = {
    events: [fixtureEvent],
    nextCursor: fixtureEvent.eventId,
    hasMore: false,
  };

  assert.equal(page.events[0]?.taskId, null);
  assert.equal(page.nextCursor, fixtureEvent.eventId);
  assert.equal(typeof createReadServices, "function");
});

test("redaction applies to nested raw event values", () => {
  assert.deepEqual(
    redactValue({ authorization: "Bearer secret", nested: { apiKey: "key" }, safe: "x" }),
    { authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" }, safe: "x" },
  );
});

test("time bounds accept ISO timestamps and durations", () => {
  const now = Date.parse("2026-08-08T01:00:00.000Z");

  assert.equal(parseTimeBound("2026-08-08T00:00:00.000Z", now), Date.parse("2026-08-08T00:00:00.000Z"));
  assert.equal(parseTimeBound("10m", now), now - 10 * 60 * 1000);
});

test("status exposes observation counts but no Phase 2 state", () => withFixtureStore((store) => {
  const services = createReadServices({ reader: store });
  const status = services.getStatus();

  assert.equal(status.agentCount, 1);
  assert.equal(status.nullAttributionEventCount > 0, true);
  assert.equal(Object.hasOwn(status, "findings"), false);
  assert.equal(Object.hasOwn(status, "pausedTasks"), false);
}));

test("agents and graph preserve attribution and stable filtering", () => withFixtureStore((store) => {
  const services = createReadServices({ reader: store });
  const agents = services.listAgents();
  const graph = services.getGraph({ resourceId });

  assert.deepEqual(agents.agents[0]?.taskIds, [null]);
  assert.equal(graph.snapshot.nodes.some((node) => node.kind === "resource" && node.resource.resourceId === resourceId), true);
  assert.equal(graph.filters.resourceId, resourceId);
}));

test("event pages filter in insertion order and reject missing cursors", () => withFixtureStore((store) => {
  const services = createReadServices({ reader: store });
  const page = services.listEvents({ eventType: "file.read", limit: 1 });

  assert.deepEqual(page.events.map((event) => event.eventId), [read.eventId]);
  assert.equal(page.hasMore, false);
  assert.throws(
    () => services.listEvents({ cursor: "evt_missing" as EventId }),
    (error: unknown) => error instanceof ReadServiceError && error.code === "cursor",
  );
}));

test("follow advances across filtered events without duplicates and aborts cleanly", async () => {
  const store = SqliteEventStore.open(":memory:");
  try {
    store.append(request);
    const services = createReadServices({
      reader: store,
      pollIntervalMs: 0,
      sleep: async (_milliseconds, signal) => {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
    });
    const controller = new AbortController();
    const iterator = services.followEvents({ eventType: "file.read" }, controller.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.events.length, 0);
    store.append(request);
    store.append(read);
    const second = await iterator.next();
    assert.deepEqual(second.value?.events.map((event) => event.eventId), [read.eventId]);
    store.append(nextRead);
    const third = await iterator.next();
    assert.deepEqual(third.value?.events.map((event) => event.eventId), [nextRead.eventId]);
    controller.abort();
    assert.equal((await iterator.next()).done, true);
  } finally {
    store.close();
  }
});
