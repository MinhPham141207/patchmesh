import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  FileReadEvent,
  ProtocolEvent,
  ToolCompletedEvent,
  ToolRequestedEvent,
} from "@patchmesh/protocol";
import { SqliteEventStore, StorageError } from "../src/index.js";

async function withTemporaryDatabase(run: (databasePath: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m2-replay-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    await run(databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

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

const missingParentCompletion: ToolCompletedEvent = {
  ...completion,
  eventId: "evt_00000000000000000000000000000003",
  causationId: "evt_00000000000000000000000000000099",
  payload: {
    ...completion.payload,
    requestEventId: "evt_00000000000000000000000000000099",
  },
};

const cycleA: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000004",
  correlationId: "corr_00000000000000000000000000000002",
  causationId: "evt_00000000000000000000000000000005",
};

const cycleB: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000005",
  correlationId: cycleA.correlationId,
  causationId: cycleA.eventId,
  sourceSequence: 1,
};

const impossibleCompletion: ToolCompletedEvent = {
  ...completion,
  eventId: "evt_00000000000000000000000000000006",
  causationId: null,
  payload: {
    ...completion.payload,
    requestEventId: "evt_00000000000000000000000000000006",
  },
};

const gapCompletion: ToolCompletedEvent = {
  ...completion,
  eventId: "evt_00000000000000000000000000000007",
  sourceSequence: 2,
};

const rootA: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000010",
  correlationId: "corr_00000000000000000000000000000003",
  sourceSequence: 0,
};

const rootB: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000020",
  correlationId: "corr_00000000000000000000000000000004",
  sourceSequence: 1,
};

const childWithEarlierId: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000005",
  correlationId: rootA.correlationId,
  causationId: rootA.eventId,
  sourceSequence: 2,
};

const invalidFileRead: FileReadEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000030",
  eventType: "file.read",
  correlationId: "corr_00000000000000000000000000000005",
  payload: {
    resource: {
      resourceId: "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repositoryId: "repo_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "file",
      locator: "src/example.ts",
    },
    version: {
      resourceId: "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      domain: {
        repositoryId: request.repositoryId,
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
      },
      kind: "content_hash",
      value: "hash",
      evidenceEventIds: [request.eventId],
    },
    access: "read",
  },
};

test("canonical and causally out-of-order input converge", () => withTemporaryDatabase(async (canonicalPath) => {
  await withTemporaryDatabase((outOfOrderPath) => {
    const canonical = SqliteEventStore.open(canonicalPath);
    const outOfOrder = SqliteEventStore.open(outOfOrderPath);
    try {
      canonical.append(request);
      canonical.append(completion);
      outOfOrder.append(completion);
      outOfOrder.append(request);

      const canonicalReplay = canonical.replay();
      const outOfOrderReplay = outOfOrder.replay();
      assert.deepEqual(
        canonicalReplay.orderedEvents.map((event) => event.eventId),
        outOfOrderReplay.orderedEvents.map((event) => event.eventId),
      );
      assert.deepEqual(canonicalReplay.state, outOfOrderReplay.state);
    } finally {
      canonical.close();
      outOfOrder.close();
    }
  });
}));

test("newly unblocked events participate in the global ready-event tie-break", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(rootB);
    store.append(childWithEarlierId);
    store.append(rootA);

    assert.deepEqual(
      store.replay().orderedEvents.map((event) => event.eventId),
      [rootA.eventId, childWithEarlierId.eventId, rootB.eventId],
    );
  } finally {
    store.close();
  }
}));

test("missing causal parent fails replay without a result", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(missingParentCompletion);

    assert.throws(
      () => store.replay(),
      (error: unknown) => error instanceof StorageError && error.code === "PHASE0_REFERENCE_MISSING",
    );
  } finally {
    store.close();
  }
}));

test("causal cycle fails with a bounded replay error", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(cycleA);
    store.append(cycleB);

    assert.throws(
      () => store.replay(),
      (error: unknown) => error instanceof StorageError && error.code === "M2_REPLAY_CAUSALITY_UNRESOLVED",
    );
  } finally {
    store.close();
  }
}));

test("impossible transition fails without invoking the reducer", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(impossibleCompletion);
    let applied = 0;

    assert.throws(
      () => store.replay({
        initialState: () => 0,
        apply: (state: number, _event: ProtocolEvent) => {
          applied += 1;
          return state + 1;
        },
      }),
      (error: unknown) => error instanceof StorageError && error.code === "PHASE0_TRANSITION_INVALID",
    );
    assert.equal(applied, 0);
  } finally {
    store.close();
  }
}));

test("schema-invalid resource relationships retain their schema error", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(invalidFileRead);

    assert.throws(
      () => store.replay(),
      (error: unknown) => error instanceof StorageError && error.code === "PHASE0_SCHEMA_INVALID",
    );
  } finally {
    store.close();
  }
}));

test("source-sequence gaps are reported as degraded coverage", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(request);
    store.append(gapCompletion);

    const replay = store.replay();
    assert.deepEqual(replay.sourceSequenceGaps, [{
      source: request.source,
      missingRanges: [{ from: 1, to: 1 }],
    }]);
  } finally {
    store.close();
  }
}));

test("a reducer receives validated events in causal order", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(completion);
    store.append(request);
    const seen: string[] = [];

    const replay = store.replay({
      initialState: () => seen,
      apply: (state: string[], event: ProtocolEvent) => {
        state.push(event.eventType);
        return state;
      },
    });

    assert.deepEqual(replay.state, ["tool.requested", "tool.completed"]);
  } finally {
    store.close();
  }
}));
