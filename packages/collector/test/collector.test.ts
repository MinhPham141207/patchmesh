import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryEventCollector,
  ProtocolValidationError,
} from "../src/index.js";
import type {
  ToolCompletedEvent,
  ToolRequestedEvent,
} from "@patchmesh/protocol";

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

test("round-trips a tool request and completion", () => {
  const collector = new InMemoryEventCollector();
  collector.collect(request);
  collector.collect(completion);

  assert.deepEqual(collector.read(), [request, completion]);
});

test("rejected input leaves state unchanged", () => {
  const collector = new InMemoryEventCollector();
  collector.collect(request);

  assert.throws(
    () => collector.collect({ ...request, eventType: "tool.completed" }),
    ProtocolValidationError,
  );
  assert.deepEqual(collector.read(), [request]);
});

test("read results cannot mutate collector state", () => {
  const collector = new InMemoryEventCollector();
  collector.collect(request);
  const [event] = collector.read();
  assert.ok(event);
  assert.throws(() => {
    (event as { timestamp: string }).timestamp = "2026-08-09T00:00:00.000Z";
  }, TypeError);
  assert.equal(collector.read()[0]?.timestamp, request.timestamp);
});
