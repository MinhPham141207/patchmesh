import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  McpProxy,
  McpProxyStorageError,
  type EventAppender,
  type McpCallContext,
  type McpProxyOptions,
  type McpToolCall,
} from "../src/index.js";
import {
  fileResourceId,
  type ObservationBoundary,
  type ObservationCapture,
  type ObservedFileChange,
  type ObservationSnapshot,
} from "@patchmesh/observation";
import { projectWorkGraph, SqliteEventStore } from "@patchmesh/storage";
import { ProtocolValidationError, validateEventSet, type EventId } from "@patchmesh/protocol";

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

const observerSource = {
  kind: "watcher" as const,
  sourceId: "source_observation",
  instanceId: "22222222-2222-4222-8222-222222222222",
};

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function snapshot(files: ReadonlyMap<string, { readonly contentHash: string }>): ObservationSnapshot {
  return {
    repository: { commonDirectory: "C:/repo/.git", revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    worktree: { administrativeDirectory: "C:/repo/.git" },
    files: new Map([...files].map(([path, state]) => [path, {
      contentHash: state.contentHash,
      gitBlob: null,
      fileKind: "file" as const,
    }])),
  };
}

function capture(
  current: ObservationSnapshot,
  outOfBandChanges: readonly ObservedFileChange[] = [],
): ObservationCapture {
  return { snapshot: current, gaps: [], outOfBandChanges };
}

function changedObserver(options: {
  readonly before?: ObservationCapture;
  readonly after?: ObservationCapture;
  readonly beforeError?: boolean;
  readonly afterError?: boolean;
} = {}): ObservationBoundary {
  const before = options.before ?? capture(snapshot(new Map()));
  const after = options.after ?? capture(snapshot(new Map([["changed.txt", { contentHash: "b".repeat(64) }]])));
  return {
    source: observerSource,
    async captureBefore() {
      if (options.beforeError) throw new Error("secret observer detail");
      return before;
    },
    async captureAfter() {
      if (options.afterError) throw new Error("secret observer detail");
      return after;
    },
  };
}

function createProxy(eventStore: EventAppender, ids: EventId[] = [
  "evt_00000000000000000000000000000001",
  "evt_00000000000000000000000000000002",
], options: Pick<McpProxyOptions, "observer" | "createCorrelationId" | "phase2SourceAnalysis"> = {}): McpProxy {
  return new McpProxy({
    eventStore,
    createEventId: () => ids.shift() ?? "evt_00000000000000000000000000000003",
    now: () => "2026-08-08T00:00:00.000Z",
    ...options,
  });
}

test("persists verified effects and links them from completion", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const proxy = createProxy(store, [
        "evt_00000000000000000000000000000001",
        "evt_00000000000000000000000000000002",
        "evt_00000000000000000000000000000003",
      ], { observer: changedObserver() });
      const result = await proxy.execute(
        { ...call, operation: "edit_file", toolName: "edit_file" },
        { ...context, workspaceRoot: tmpdir() },
        async () => ({
          outcome: "succeeded",
          value: true,
          exitCode: 0,
          effectResourceIds: [fileResourceId(context.repositoryId, "changed.txt")],
        }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), [
        "tool.requested",
        "file.changed",
        "tool.completed",
      ]);
      const effect = events[1];
      const completion = events[2];
      if (effect?.eventType !== "file.changed" || completion?.eventType !== "tool.completed") {
        throw new Error("expected file effect and tool completion");
      }
      assert.deepEqual(completion.payload.effectEventIds, [effect.eventId]);
      assert.deepEqual(completion.payload.deterministicallyAttributedEffectEventIds, [effect.eventId]);
      assert.equal(effect.causationId, events[0]?.eventId);
      assert.deepEqual(result.coverage?.modes, ["intercepted", "verified"]);
      assert.equal(result.coverage?.presentation, "sufficient");
    } finally {
      store.close();
    }
  });
});

test("derives persisted symbol changes from an observed TypeScript source file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-phase2-"));
  const databasePath = join(directory, "events.sqlite");
  const sourceDirectory = join(directory, "src");
  try {
    mkdirSync(sourceDirectory);
    const source = "export function api(): void {}\n";
    writeFileSync(join(sourceDirectory, "api.ts"), source, "utf8");
    const store = SqliteEventStore.open(databasePath);
    try {
      const observer = changedObserver({
        after: capture(snapshot(new Map([["src/api.ts", { contentHash: contentHash(source) }]]))),
      });
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000020",
        "evt_00000000000000000000000000000021",
        "evt_00000000000000000000000000000022",
        "evt_00000000000000000000000000000023",
        "evt_00000000000000000000000000000024",
      ], {
        observer,
        phase2SourceAnalysis: {
          source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "33333333-3333-4333-8333-333333333333" },
          analyzer: { analyzerId: "analyzer_typescript", version: "1" },
          configuration: { parser: "typescript" },
          integrationTarget: "main",
        },
      }).execute(
        { ...call, toolName: "edit_file", operation: "edit src/api.ts" },
        { ...context, workspaceRoot: directory },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), [
        "tool.requested", "file.changed", "symbol.changed", "evidence.derived", "tool.completed",
      ]);
      assert.deepEqual(result.analysisDiagnostics, []);
      assert.equal(projectWorkGraph(events).snapshot.nodes.some((node) => node.kind === "resource" && node.resource.kind === "symbol"), true);
       const derived = events[3];
       if (derived?.eventType !== "evidence.derived") throw new Error("expected durable analyzer evidence");
       assert.equal(derived.payload.evidence.factKind, "symbol");
       assert.equal(derived.payload.evidence.integrationTarget, "main");
       assert.equal(derived.payload.evidence.configurationDigest.startsWith("sha256:"), true);
       assert.deepEqual(derived.payload.evidence.sourceEventIds, [events[1]?.eventId]);
       const completion = events[4];
      if (completion?.eventType !== "tool.completed") throw new Error("expected tool completion");
      assert.deepEqual(completion.payload.effectEventIds, [events[1]?.eventId, events[2]?.eventId]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("derives a persisted dependency from real changed local TypeScript sources", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-phase2-"));
  const databasePath = join(directory, "events.sqlite");
  const sourceDirectory = join(directory, "src");
  try {
    mkdirSync(sourceDirectory);
    const apiSource = "export interface Account { id: string }\n";
    const consumerSource = 'import { Account } from "./api";\nfunction consume(value: Account) {}\n';
    writeFileSync(join(sourceDirectory, "api.ts"), apiSource, "utf8");
    writeFileSync(join(sourceDirectory, "consumer.ts"), consumerSource, "utf8");
    const store = SqliteEventStore.open(databasePath);
    try {
      const observer = changedObserver({
        after: capture(snapshot(new Map([
          ["src/api.ts", { contentHash: contentHash(apiSource) }],
          ["src/consumer.ts", { contentHash: contentHash(consumerSource) }],
        ]))),
      });
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000030",
        "evt_00000000000000000000000000000031",
        "evt_00000000000000000000000000000032",
        "evt_00000000000000000000000000000033",
        "evt_00000000000000000000000000000034",
        "evt_00000000000000000000000000000035",
        "evt_00000000000000000000000000000036",
        "evt_00000000000000000000000000000037",
        "evt_00000000000000000000000000000038",
        "evt_00000000000000000000000000000039",
      ], {
        observer,
        phase2SourceAnalysis: {
          source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "33333333-3333-4333-8333-333333333333" },
          analyzer: { analyzerId: "analyzer_typescript", version: "1" },
          configuration: { parser: "typescript" },
          integrationTarget: "main",
        },
      }).execute(
        { ...call, toolName: "edit_file", operation: "edit src" },
        { ...context, workspaceRoot: directory },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), [
        "tool.requested", "file.changed", "symbol.changed", "evidence.derived", "file.changed", "symbol.changed", "evidence.derived", "dependency.changed", "evidence.derived", "tool.completed",
      ]);
      const dependency = events[7];
      if (dependency?.eventType !== "dependency.changed") throw new Error("expected a resolved dependency event");
      assert.equal(dependency.payload.dependency.dependentResourceId, events[4]?.eventType === "file.changed" ? events[4].payload.resource.resourceId : null);
      assert.equal(dependency.causationId, "evt_00000000000000000000000000000034");
      const dependencyEvidence = events[8];
      if (dependencyEvidence?.eventType !== "evidence.derived") throw new Error("expected durable dependency evidence");
      assert.equal(dependencyEvidence.payload.evidence.factKind, "dependency");
      assert.equal(dependencyEvidence.payload.evidence.stableFactId, dependency.payload.dependency.dependencyId);
      assert.deepEqual(result.analysisDiagnostics, []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("marks unsupported observed source as degraded without inventing symbols", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-phase2-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    const source = "not TypeScript";
    writeFileSync(join(directory, "notes.txt"), source, "utf8");
    const store = SqliteEventStore.open(databasePath);
    try {
      const observer = changedObserver({
        after: capture(snapshot(new Map([["notes.txt", { contentHash: contentHash(source) }]]))),
      });
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000024",
        "evt_00000000000000000000000000000025",
        "evt_00000000000000000000000000000026",
      ], {
        observer,
        phase2SourceAnalysis: {
          source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "33333333-3333-4333-8333-333333333333" },
          analyzer: { analyzerId: "analyzer_typescript", version: "1" },
          configuration: { parser: "typescript" },
          integrationTarget: "main",
        },
      }).execute(
        { ...call, toolName: "edit_file", operation: "edit notes.txt" },
        { ...context, workspaceRoot: directory },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      assert.deepEqual(store.read().map((event) => event.eventType), ["tool.requested", "file.changed", "tool.completed"]);
      assert.equal(result.coverage?.presentation, "degraded");
      assert.deepEqual(result.analysisDiagnostics, [{ path: "notes.txt", reason: "unsupported_language" }]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("degrades source analysis when the file changes after observation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-phase2-"));
  const databasePath = join(directory, "events.sqlite");
  const sourceDirectory = join(directory, "src");
  const observedSource = "export function observed(): void {}\n";
  try {
    mkdirSync(sourceDirectory);
    writeFileSync(join(sourceDirectory, "api.ts"), observedSource, "utf8");
    const store = SqliteEventStore.open(databasePath);
    const eventStore: EventAppender = {
      append(event) {
        const persisted = store.append(event);
        if (persisted.event.eventType === "file.changed") {
          writeFileSync(join(sourceDirectory, "api.ts"), "export function replacement(): void {}\n", "utf8");
        }
        return persisted;
      },
      read: () => store.read(),
    };
    try {
      const result = await createProxy(eventStore, [
        "evt_00000000000000000000000000000050",
        "evt_00000000000000000000000000000051",
        "evt_00000000000000000000000000000052",
      ], {
        observer: changedObserver({
          after: capture(snapshot(new Map([["src/api.ts", { contentHash: contentHash(observedSource) }]]))),
        }),
        phase2SourceAnalysis: {
          source: { kind: "analyzer", sourceId: "source_typescript", instanceId: "33333333-3333-4333-8333-333333333333" },
          analyzer: { analyzerId: "analyzer_typescript", version: "1" },
          configuration: { parser: "typescript" },
          integrationTarget: "main",
        },
      }).execute(
        { ...call, toolName: "edit_file", operation: "edit src/api.ts" },
        { ...context, workspaceRoot: directory },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      assert.deepEqual(store.read().map((event) => event.eventType), ["tool.requested", "file.changed", "tool.completed"]);
      assert.equal(result.coverage?.presentation, "degraded");
      assert.deepEqual(result.analysisDiagnostics, [{
        path: "src/api.ts",
        reason: "changed source no longer matches observed version",
      }]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists post-call effects for a failed execution", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000004",
        "evt_00000000000000000000000000000005",
        "evt_00000000000000000000000000000006",
      ], { observer: changedObserver() }).execute(
        call,
        { ...context, workspaceRoot: tmpdir() },
        async () => ({ outcome: "failed", error: new Error("secret failure"), exitCode: 9 }),
      );

      assert.equal(result.execution.outcome, "failed");
      const events = store.read();
      assert.equal(events[1]?.eventType, "file.changed");
      assert.equal(events[2]?.eventType, "tool.completed");
      if (events[2]?.eventType !== "tool.completed") throw new Error("expected completion");
      assert.equal(events[2].payload.outcome, "failed");
      assert.deepEqual(events[2].payload.effectEventIds, ["evt_00000000000000000000000000000005"]);
    } finally {
      store.close();
    }
  });
});

test("reports degraded coverage for opaque effects", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000007",
        "evt_00000000000000000000000000000008",
        "evt_00000000000000000000000000000009",
      ], { observer: changedObserver() }).execute(
        { ...call, toolName: "run_shell", operation: "run_shell", opaque: true },
        { ...context, workspaceRoot: tmpdir() },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      assert.equal(result.coverage?.presentation, "degraded");
      assert.equal(result.coverage?.gaps.some((gap) => gap.kind === "opaque"), true);
    } finally {
      store.close();
    }
  });
});

test("keeps execution and completion persistence alive when observation fails", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    let executed = false;
    try {
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000010",
        "evt_00000000000000000000000000000011",
      ], { observer: changedObserver({ beforeError: true, afterError: true }) }).execute(
        call,
        { ...context, workspaceRoot: tmpdir() },
        async () => {
          executed = true;
          return { outcome: "succeeded", value: true, exitCode: 0 };
        },
      );

      assert.equal(executed, true);
      assert.equal(result.coverage?.presentation, "degraded");
      assert.deepEqual(store.read().map((event) => event.eventType), ["tool.requested", "tool.completed"]);
    } finally {
      store.close();
    }
  });
});

test("does not claim verified coverage when effect persistence fails", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const eventStore: EventAppender = {
        append(input) {
          if (typeof input === "object" && input !== null && "eventType" in input && input.eventType === "file.changed") {
            throw new Error("secret effect persistence detail");
          }
          return store.append(input);
        },
      };
      const result = await createProxy(eventStore, [
        "evt_00000000000000000000000000000012",
        "evt_00000000000000000000000000000013",
      ], { observer: changedObserver() }).execute(
        call,
        { ...context, workspaceRoot: tmpdir() },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), ["tool.requested", "tool.completed"]);
      if (events[1]?.eventType !== "tool.completed") throw new Error("expected completion");
      assert.deepEqual(events[1].payload.effectEventIds, []);
      assert.equal(result.coverage?.presentation, "degraded");
      assert.equal(result.coverage?.modes.includes("unknown"), true);
    } finally {
      store.close();
    }
  });
});

test("stores out-of-band effects without MCP attribution", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const outOfBandChange: ObservedFileChange = {
        path: "external.txt",
        before: null,
        after: { contentHash: "c".repeat(64), gitBlob: null, fileKind: "file" },
        changeKind: "created",
        outOfBand: true,
      };
      const observer = changedObserver({
        after: capture(snapshot(new Map()), [outOfBandChange]),
      });
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000014",
        "evt_00000000000000000000000000000015",
        "evt_00000000000000000000000000000016",
      ], {
        observer,
        createCorrelationId: () => "corr_00000000000000000000000000000002",
      }).execute(
        call,
        { ...context, workspaceRoot: tmpdir() },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), [
        "tool.requested",
        "file.changed",
        "tool.completed",
      ]);
      const outOfBand = events[1];
      if (outOfBand?.eventType !== "file.changed") throw new Error("expected out-of-band effect");
      assert.equal(outOfBand.agentId, null);
      assert.equal(outOfBand.taskId, null);
      assert.equal(outOfBand.correlationId, "corr_00000000000000000000000000000002");
      assert.equal(outOfBand.source.kind, "watcher");
      assert.equal(result.coverage?.presentation, "degraded");
      assert.equal(result.coverage?.gaps.some((gap) => gap.kind === "unattributed"), true);
    } finally {
      store.close();
    }
  });
});

test("uses schema-valid default IDs and redacts operations before persistence", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const outOfBandChange: ObservedFileChange = {
        path: "external.txt",
        before: null,
        after: { contentHash: "d".repeat(64), gitBlob: null, fileKind: "file" },
        changeKind: "created",
        outOfBand: true,
      };
      const proxy = new McpProxy({
        eventStore: store,
        now: () => "2026-08-08T00:00:00.000Z",
        observer: changedObserver({
          after: capture(snapshot(new Map()), [outOfBandChange]),
        }),
      });

      await proxy.execute(
        {
          ...call,
          operation: "Authorization: Bearer synthetic-secret",
          toolName: "run_shell",
          opaque: true,
        },
        { ...context, workspaceRoot: tmpdir() },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.equal(events.length, 3);
      for (const event of events) assert.match(event.eventId, /^evt_[0-9a-f]{32}$/u);
      const request = events[0];
      const outOfBand = events[1];
      if (request?.eventType !== "tool.requested" || outOfBand?.eventType !== "file.changed") {
        throw new Error("expected request and out-of-band effect");
      }
      assert.equal(request.payload.operation.includes("synthetic-secret"), false);
      assert.match(request.payload.operation, /<redacted>/u);
      assert.match(outOfBand.correlationId, /^corr_[0-9a-f]{32}$/u);
    } finally {
      store.close();
    }
  });
});

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

test("persists a file read only from explicit runtime resource and version metadata", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const resourceId = `res_${"a".repeat(64)}`;
      const result = await createProxy(store, [
        "evt_00000000000000000000000000000030",
        "evt_00000000000000000000000000000031",
        "evt_00000000000000000000000000000032",
      ]).execute(
        {
          ...call,
          targetResourceId: resourceId,
          observedRead: {
            resource: { resourceId, repositoryId: context.repositoryId, kind: "file", locator: "src/api.ts" },
            version: { kind: "content_hash", value: "a".repeat(64) },
          },
        },
        context,
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), ["tool.requested", "file.read", "tool.completed"]);
      assert.deepEqual(result.readEventIds, ["evt_00000000000000000000000000000031"]);
      const read = events[1];
      if (read?.eventType !== "file.read") throw new Error("expected file read event");
      assert.equal(read.payload.version.value, "a".repeat(64));
      assert.equal(read.causationId, events[0]?.eventId);
    } finally {
      store.close();
    }
  });
});

test("persists a dependent write only when its declared resource was intercepted", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const readResourceId = `res_${"a".repeat(64)}`;
      const changedResourceId = fileResourceId(context.repositoryId, "changed.txt");
      store.append({
        schemaVersion: 1,
        eventId: "evt_00000000000000000000000000000034",
        eventType: "dependency.changed",
        source: context.source,
        timestamp: "2026-08-08T00:00:00.000Z",
        repositoryId: context.repositoryId,
        workspaceId: context.workspaceId,
        worktreeId: context.worktreeId,
        agentId: null,
        taskId: "task_44444444-4444-4444-8444-444444444444",
        correlationId: "corr_00000000000000000000000000000034",
        causationId: null,
        sourceSequence: null,
        payload: {
          dependency: {
            dependencyId: `dep_${"b".repeat(32)}`,
            dependentResourceId: changedResourceId,
            dependencyResourceId: readResourceId,
            dependentVersion: {
              resourceId: changedResourceId,
              domain: { repositoryId: context.repositoryId, workspaceId: context.workspaceId, worktreeId: context.worktreeId },
              kind: "content_hash",
              value: "b".repeat(64),
              evidenceEventIds: ["evt_00000000000000000000000000000034"],
            },
            dependencyVersion: {
              resourceId: readResourceId,
              domain: { repositoryId: context.repositoryId, workspaceId: context.workspaceId, worktreeId: context.worktreeId },
              kind: "content_hash",
              value: "a".repeat(64),
              evidenceEventIds: ["evt_00000000000000000000000000000034"],
            },
            observations: [{
              kind: "dynamically_observed",
              producer: { sourceId: context.source.sourceId, version: "1" },
              rule: null,
              evidenceEventIds: ["evt_00000000000000000000000000000034"],
            }],
            evidenceEventIds: ["evt_00000000000000000000000000000034"],
          },
        },
      });
      await createProxy(store, [
        "evt_00000000000000000000000000000035",
        "evt_00000000000000000000000000000036",
        "evt_00000000000000000000000000000037",
        "evt_00000000000000000000000000000038",
        "evt_00000000000000000000000000000039",
      ], { observer: changedObserver() }).execute(
        {
          ...call,
          toolName: "edit_file",
          operation: "edit changed.txt",
          observedRead: {
            resource: { resourceId: readResourceId, repositoryId: context.repositoryId, kind: "file", locator: "src/input.ts" },
            version: { kind: "content_hash", value: "a".repeat(64) },
          },
          dependentWrite: {
            dependencyId: `dep_${"b".repeat(32)}`,
            resourceId: changedResourceId,
            dependsOnReadEventId: "evt_00000000000000000000000000000036",
          },
        },
        { ...context, taskId: "task_44444444-4444-4444-8444-444444444444", workspaceRoot: tmpdir() },
        async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
      );

      const events = store.read();
      assert.deepEqual(events.map((event) => event.eventType), [
        "dependency.changed", "tool.requested", "file.read", "file.changed", "tool.completed", "write.dependent",
      ]);
      const dependentWrite = events[5];
      if (dependentWrite?.eventType !== "write.dependent") throw new Error("expected dependent write event");
      assert.equal(dependentWrite.causationId, events[3]?.eventId);
      assert.equal(dependentWrite.payload.write.dependsOnReadEventId, events[2]?.eventId);
      assert.equal(dependentWrite.payload.write.resourceId, changedResourceId);
      assert.match(dependentWrite.payload.write.coverageId, /^coverage_/);
      assert.deepEqual(validateEventSet(events), []);
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

test("preserves per-call attribution and runtime metadata", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    try {
      const secondContext: McpCallContext = {
        ...context,
        source: {
          kind: "adapter",
          sourceId: "source_mcp_other",
          instanceId: "22222222-2222-4222-8222-222222222222",
        },
        repositoryId: "repo_44444444-4444-4444-8444-444444444444",
        workspaceId: "ws_55555555-5555-4555-8555-555555555555",
        worktreeId: "wt_66666666-6666-4666-8666-666666666666",
        agentId: "agent_agent-b",
        taskId: "task_task-b",
        correlationId: "corr_00000000000000000000000000000002",
        causationId: "evt_00000000000000000000000000000009",
        requestSourceSequence: 3,
        completionSourceSequence: 4,
      };
      const proxy = createProxy(store, [
        "evt_00000000000000000000000000000004",
        "evt_00000000000000000000000000000005",
        "evt_00000000000000000000000000000006",
        "evt_00000000000000000000000000000007",
      ]);

      await proxy.execute(call, context, async () => ({ outcome: "succeeded", value: 1, exitCode: 0 }));
      await proxy.execute(
        { ...call, operation: "run_shell", toolName: "run_shell", opaque: true },
        secondContext,
        async () => ({ outcome: "succeeded", value: 2, exitCode: 0 }),
      );

      const events = store.read();
      assert.equal(events.length, 4);
      assert.equal(events[2]?.agentId, "agent_agent-b");
      assert.equal(events[2]?.taskId, "task_task-b");
      assert.equal(events[2]?.repositoryId, secondContext.repositoryId);
      assert.equal(events[2]?.correlationId, secondContext.correlationId);
      assert.equal(events[2]?.causationId, secondContext.causationId);
      assert.equal(events[2]?.sourceSequence, 3);
      assert.equal(events[3]?.sourceSequence, 4);
      assert.equal(events[3]?.causationId, "evt_00000000000000000000000000000006");
      assert.equal(events[2]?.eventType, "tool.requested");
      if (events[2]?.eventType !== "tool.requested") throw new Error("expected second request event");
      assert.equal(events[2].payload.opaque, true);
      assert.deepEqual(events.map((event) => event.eventType), [
        "tool.requested",
        "tool.completed",
        "tool.requested",
        "tool.completed",
      ]);
    } finally {
      store.close();
    }
  });
});

test("rejects malformed runtime input before appending or executing", async () => {
  let appendCalled = false;
  let executorCalled = false;
  const eventStore: EventAppender = {
    append() {
      appendCalled = true;
      throw new Error("append should not run");
    },
  };
  const invalidCall = { ...call, toolName: "unknown_tool" } as unknown as McpToolCall;

  await assert.rejects(
    () => createProxy(eventStore).execute(invalidCall, context, async () => {
      executorCalled = true;
      return { outcome: "succeeded", value: true, exitCode: 0 };
    }),
    (error: unknown) => error instanceof ProtocolValidationError,
  );
  assert.equal(appendCalled, false);
  assert.equal(executorCalled, false);
});
