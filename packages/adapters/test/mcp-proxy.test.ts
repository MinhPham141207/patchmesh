import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  McpProxy,
  McpProxyStorageError,
  type EventAppender,
  type McpCallContext,
  type McpToolCall,
} from "../src/index.js";
import { SqliteEventStore } from "@patchmesh/storage";
import type { EventId } from "@patchmesh/protocol";

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m3-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const call: McpToolCall = {
  toolName: "read_file",
  operation: "read_file",
  targetResourceId: null,
  opaque: false,
};

const context: McpCallContext = {
  source: {
    kind: "adapter",
    sourceId: "source_mcp",
    instanceId: "11111111-1111-4111-8111-111111111111",
  },
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_22222222-2222-4222-8222-222222222222",
  worktreeId: "wt_33333333-3333-4333-8333-333333333333",
  agentId: null,
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  requestSourceSequence: 1,
  completionSourceSequence: 2,
};

function createProxy(eventStore: EventAppender, ids: EventId[] = [
  "evt_00000000000000000000000000000001",
  "evt_00000000000000000000000000000002",
]): McpProxy {
  return new McpProxy({
    eventStore,
    createEventId: () => ids.shift() ?? "evt_00000000000000000000000000000003",
    now: () => "2026-08-08T00:00:00.000Z",
  });
}

test("persists a request before a successful completion", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const proxy = createProxy(store);

      const executionOrder: string[] = [];
      const result = await proxy.execute(call, context, async (signal) => {
        executionOrder.push("executor");
        assert.equal(signal.aborted, false);
        return { outcome: "succeeded", value: { ok: true }, exitCode: 0 };
      });

      assert.deepEqual(result.requestEventId, "evt_00000000000000000000000000000001");
      assert.deepEqual(result.completedEventId, "evt_00000000000000000000000000000002");
      assert.deepEqual(executionOrder, ["executor"]);

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), ["tool.requested", "tool.completed"]);
      const request = events[0];
      const completion = events[1];
      assert.equal(request?.eventType, "tool.requested");
      assert.equal(completion?.eventType, "tool.completed");
      if (request?.eventType !== "tool.requested" || completion?.eventType !== "tool.completed") {
        throw new Error("expected request and completion events");
      }

      assert.deepEqual(request.payload, {
        toolName: "read_file",
        operation: "read_file",
        targetResourceId: null,
        opaque: false,
      });
      assert.deepEqual(completion.payload, {
        requestEventId: "evt_00000000000000000000000000000001",
        outcome: "succeeded",
        exitCode: 0,
        effectEventIds: [],
      });
      assert.equal(request.causationId, null);
      assert.equal(completion.causationId, "evt_00000000000000000000000000000001");
      assert.equal(request.correlationId, "corr_00000000000000000000000000000001");
      assert.equal(completion.correlationId, "corr_00000000000000000000000000000001");
      assert.equal(request.sourceSequence, 1);
      assert.equal(completion.sourceSequence, 2);
    } finally {
      store.close();
    }
  });
});

test("persists an explicit failed result without storing its error", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const proxy = createProxy(store);
      const result = await proxy.execute(call, context, async () => ({
        outcome: "failed",
        error: new Error("secret failure detail"),
        exitCode: 7,
      }));

      assert.equal(result.execution.outcome, "failed");
      const events = store.read();
      assert.equal(events[1]?.eventType, "tool.completed");
      if (events[1]?.eventType !== "tool.completed") throw new Error("expected completion event");
      assert.equal(events[1].payload.outcome, "failed");
      assert.equal(events[1].payload.exitCode, 7);
      assert.equal(JSON.stringify(events).includes("secret failure detail"), false);
    } finally {
      store.close();
    }
  });
});

test("persists an interrupted result and propagates an aborted signal", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await createProxy(store).execute(
        call,
        context,
        async (signal) => {
          assert.equal(signal.aborted, true);
          return { outcome: "interrupted", reason: "cancelled", exitCode: null };
        },
        controller.signal,
      );

      assert.equal(result.execution.outcome, "interrupted");
      const events = store.read();
      assert.equal(events[1]?.eventType, "tool.completed");
      if (events[1]?.eventType !== "tool.completed") throw new Error("expected completion event");
      assert.equal(events[1].payload.outcome, "interrupted");
    } finally {
      store.close();
    }
  });
});

test("converts an unexpected executor throw into a failed result", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const result = await createProxy(store).execute(call, context, async () => {
        throw new Error("secret thrown detail");
      });

      assert.equal(result.execution.outcome, "failed");
      const events = store.read();
      assert.equal(events[1]?.eventType, "tool.completed");
      assert.equal(JSON.stringify(events).includes("secret thrown detail"), false);
    } finally {
      store.close();
    }
  });
});

test("does not execute when request persistence fails", async () => {
  let called = false;
  const eventStore: EventAppender = {
    append() {
      throw new Error("request storage detail");
    },
  };

  await assert.rejects(
    () => createProxy(eventStore).execute(call, context, async () => {
      called = true;
      return { outcome: "succeeded", value: true, exitCode: 0 };
    }),
    (error: unknown) => error instanceof McpProxyStorageError && error.phase === "request",
  );
  assert.equal(called, false);
});

test("reports completion persistence failure after execution", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    let appendCount = 0;
    const eventStore: EventAppender = {
      append(input) {
        appendCount += 1;
        if (appendCount === 2) throw new Error("completion storage detail");
        return store.append(input);
      },
    };

    try {
      await assert.rejects(
        () => createProxy(eventStore).execute(call, context, async () => ({
          outcome: "succeeded",
          value: true,
          exitCode: 0,
        })),
        (error: unknown) => {
          if (!(error instanceof McpProxyStorageError)) return false;
          assert.equal(error.phase, "completion");
          assert.equal(error.requestEventId, "evt_00000000000000000000000000000001");
          assert.equal(error.executionOutcome, "succeeded");
          return true;
        },
      );
    } finally {
      store.close();
    }
  });
});
