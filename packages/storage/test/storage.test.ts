import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
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

const independentRequest: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000003",
  correlationId: "corr_00000000000000000000000000000003",
  sourceSequence: 2,
  payload: {
    ...request.payload,
    operation: "read src/independent.ts",
  },
};

type ContentionWorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "locked" }
  | { readonly type: "released" };

function createContentionWorker(databasePath: string): Worker {
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";

    if (parentPort === null) throw new Error("contention worker requires a parent port");
    const database = new DatabaseSync(workerData.databasePath);
    database.exec("PRAGMA busy_timeout = 5000");
    parentPort.postMessage({ type: "ready" });
    parentPort.once("message", () => {
      database.exec("BEGIN IMMEDIATE");
      parentPort.postMessage({ type: "locked" });
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
        parentPort.postMessage({ type: "released" });
      }, 100);
    });
  `;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { databasePath },
  });
}

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

test("atomic append commits a causally bound batch in input order", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  const results = store.appendAtomic([request, completion]);

  assert.deepEqual(results.map((result) => result.status), ["inserted", "inserted"]);
  assert.deepEqual(results.map((result) => result.event.eventId), [request.eventId, completion.eventId]);
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId, completion.eventId]);
  store.close();
}));

test("atomic append rejects malformed input before committing any candidate", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.throws(() => store.appendAtomic([request, {}]), ProtocolValidationError);
  assert.deepEqual(store.read(), []);
  store.close();
}));

test("atomic append rolls back earlier candidates when a stored ID conflicts", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.append(request);

  assert.throws(
    () => store.appendAtomic([
      independentRequest,
      { ...request, timestamp: "2026-08-08T00:00:01.000Z" },
    ]),
    (error: unknown) => error instanceof StorageError && error.code === "PHASE0_ID_CONFLICT",
  );
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId]);
  store.close();
}));

test("atomic append reports a replayed batch as duplicates without inserting rows", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.appendAtomic([request, completion]);

  const replayed = store.appendAtomic([structuredClone(request), structuredClone(completion)]);

  assert.deepEqual(replayed.map((result) => result.status), ["duplicate", "duplicate"]);
  assert.equal(store.read().length, 2);
  store.close();
}));

test("atomic append inserts only new candidates from a mixed batch", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.append(request);

  const results = store.appendAtomic([structuredClone(request), completion]);

  assert.deepEqual(results.map((result) => result.status), ["duplicate", "inserted"]);
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId, completion.eventId]);
  store.close();
}));

test("atomic append collapses identical IDs within one batch", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  const results = store.appendAtomic([request, structuredClone(request)]);

  assert.deepEqual(results.map((result) => result.status), ["inserted", "duplicate"]);
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId]);
  store.close();
}));

test("atomic append rejects conflicting content within one batch", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.throws(
    () => store.appendAtomic([request, { ...request, timestamp: "2026-08-08T00:00:01.000Z" }]),
    (error: unknown) => error instanceof StorageError && error.code === "PHASE0_ID_CONFLICT",
  );
  assert.deepEqual(store.read(), []);
  store.close();
}));

test("atomic event-set validation rejects a missing causal reference", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.throws(
    () => store.appendAtomic([completion], { requireValidEventSet: true }),
    ProtocolValidationError,
  );
  assert.deepEqual(store.read(), []);
  store.close();
}));

test("atomic event-set validation accepts a causal parent from the same batch", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  const results = store.appendAtomic([request, completion], { requireValidEventSet: true });

  assert.deepEqual(results.map((result) => result.status), ["inserted", "inserted"]);
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId, completion.eventId]);
  store.close();
}));

test("append-time buffering holds a child whose causal parent is not durable", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  const [result] = store.appendAtomic([completion], { bufferUnresolvedCausalParents: true });

  assert.equal(result?.status, "buffered");
  assert.deepEqual(store.read(), []);
  assert.deepEqual(store.readPending().map((event) => event.eventId), [completion.eventId]);
  store.close();
}));

test("append-time buffering promotes a buffered child once its parent arrives", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  assert.equal(store.appendAtomic([completion], { bufferUnresolvedCausalParents: true })[0]?.status, "buffered");
  assert.equal(store.appendAtomic([request], { bufferUnresolvedCausalParents: true })[0]?.status, "inserted");

  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId, completion.eventId]);
  assert.deepEqual(store.readPending(), []);
  store.close();
}));

test("append-time buffering admits a reverse-ordered chain supplied in one batch", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  const results = store.appendAtomic([completion, request], { bufferUnresolvedCausalParents: true });

  assert.deepEqual(results.map((result) => result.status), ["inserted", "inserted"]);
  assert.deepEqual(store.readPending(), []);
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId, completion.eventId]);
  store.close();
}));

test("a buffered child resubmitted with its parent does not roll the batch back", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  // The child arrives first and is buffered, then a retry resends BOTH events. The child is
  // now admissible from the input (its parent is in the same batch) while its pending row is
  // also promotable - two paths to one event_id inside a single transaction.
  assert.equal(store.appendAtomic([completion], { bufferUnresolvedCausalParents: true })[0]?.status, "buffered");

  const results = store.appendAtomic([request, completion], { bufferUnresolvedCausalParents: true });

  assert.deepEqual(results.map((result) => result.status), ["inserted", "inserted"]);
  assert.deepEqual(store.read().map((event) => event.eventId), [request.eventId, completion.eventId]);
  assert.deepEqual(store.readPending(), [], "the pending row must be reconciled, not left behind");
  store.close();
}));

test("a buffered event stays quarantined and never makes replay unresolvable", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  store.appendAtomic([completion], { bufferUnresolvedCausalParents: true });

  // The dangling child is invisible to the log, so replay stays resolvable.
  assert.deepEqual(store.replay().orderedEvents, []);
  assert.equal(store.readPending().length, 1);
  store.close();
}));

test("buffering is opt-in and does not change direct append semantics", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);

  // Invariant 4: append still tolerates an out-of-order child directly.
  assert.equal(store.append(completion).status, "inserted");
  assert.deepEqual(store.read().map((event) => event.eventId), [completion.eventId]);
  assert.deepEqual(store.readPending(), []);
  store.close();
}));

test("re-appending a buffered event is idempotent and rejects conflicting content", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.appendAtomic([completion], { bufferUnresolvedCausalParents: true });

  assert.equal(store.appendAtomic([completion], { bufferUnresolvedCausalParents: true })[0]?.status, "buffered");
  assert.equal(store.readPending().length, 1);

  const conflicting = { ...completion, payload: { ...completion.payload, exitCode: 9 } };
  assert.throws(
    () => store.appendAtomic([conflicting], { bufferUnresolvedCausalParents: true }),
    (error: unknown) => error instanceof StorageError && error.code === "PHASE0_ID_CONFLICT",
  );
  assert.equal(store.readPending().length, 1);
  store.close();
}));

test("promotion cascades through a buffered chain when the root finally lands", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  const grandchild = {
    ...completion,
    eventId: "evt_00000000000000000000000000000009",
    causationId: completion.eventId,
    sourceSequence: 2,
    payload: { ...completion.payload, requestEventId: request.eventId },
  };

  // Both arrive before the root, deepest first.
  assert.equal(store.appendAtomic([grandchild], { bufferUnresolvedCausalParents: true })[0]?.status, "buffered");
  assert.equal(store.appendAtomic([completion], { bufferUnresolvedCausalParents: true })[0]?.status, "buffered");
  assert.equal(store.readPending().length, 2);

  assert.equal(store.appendAtomic([request], { bufferUnresolvedCausalParents: true })[0]?.status, "inserted");

  assert.deepEqual(store.readPending(), []);
  assert.deepEqual(
    store.read().map((event) => event.eventId),
    [request.eventId, completion.eventId, grandchild.eventId],
  );
  store.close();
}));

test("a self-rolling-back failure preserves its originating error instead of a rollback error", () => withTemporaryDatabase((databasePath) => {
  const schemaStore = SqliteEventStore.open(databasePath);
  schemaStore.close();

  // RAISE(ROLLBACK) unwinds the transaction itself, so appendAtomic's explicit ROLLBACK
  // fails. The originating failure must still be the error the caller receives.
  const triggerDatabase = new DatabaseSync(databasePath);
  try {
    triggerDatabase.exec(`
      CREATE TRIGGER rollback_completion
      BEFORE INSERT ON events
      WHEN NEW.event_type = 'tool.completed'
      BEGIN
        SELECT RAISE(ROLLBACK, 'completion trigger rolled back');
      END
    `);
  } finally {
    triggerDatabase.close();
  }

  const store = SqliteEventStore.open(databasePath);
  assert.throws(
    () => store.appendAtomic([request, completion]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /completion trigger rolled back/);
      assert.doesNotMatch(error.message, /no transaction is active/);
      return true;
    },
  );
  assert.deepEqual(store.read(), []);
  store.close();
}));

test("a contending connection waits for the configured busy timeout instead of failing immediately", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    const worker = createContentionWorker(databasePath);
    try {
      const [ready] = await once(worker, "message") as [ContentionWorkerMessage];
      assert.deepEqual(ready, { type: "ready" });

      worker.postMessage({ type: "append" });
      const [locked] = await once(worker, "message") as [ContentionWorkerMessage];
      assert.deepEqual(locked, { type: "locked" });

      const startedAt = Date.now();
      const result = store.append(independentRequest);
      const elapsedMilliseconds = Date.now() - startedAt;
      assert.equal(result.status, "inserted");
      assert.ok(elapsedMilliseconds >= 50, `append waited only ${elapsedMilliseconds}ms`);

      const [released] = await once(worker, "message") as [ContentionWorkerMessage];
      assert.deepEqual(released, { type: "released" });
      assert.deepEqual(store.read().map((event) => event.eventId), [independentRequest.eventId]);
    } finally {
      store.close();
      await worker.terminate();
    }
  });
});

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
