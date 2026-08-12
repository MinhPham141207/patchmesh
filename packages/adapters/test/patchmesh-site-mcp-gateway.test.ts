import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  detectPatchMeshSiteCapabilities,
  PatchMeshSiteCapabilityError,
  PatchMeshSiteIdentityMismatchError,
  PatchMeshSiteMcpGateway,
  PatchMeshSitePersistedEvidenceError,
  PatchMeshSiteRuntimeIdentityError,
  readPatchMeshSitePersistedToolEvidence,
  type PatchMeshSiteHostContract,
  type PatchMeshSiteRuntimeIdentity,
} from "../src/index.js";
import { fileResourceId, NodeObservationBoundary } from "@patchmesh/observation";
import { SqliteEventStore } from "@patchmesh/storage";

const execFile = promisify(execFileCallback);

const hostContract: PatchMeshSiteHostContract = {
  runtimeVersion: "2026.08.12",
  adapterVersion: "0.1.0",
  synchronousGateway: true,
  authoritativeIdentity: true,
  taskLifecycle: true,
  exactReportedEffects: true,
  integrationTargetSnapshot: false,
  concurrentWorktreeObservation: false,
  observedReadVersion: false,
  dependentWriteToken: false,
};

function runtimeIdentity(workspaceRoot: string): PatchMeshSiteRuntimeIdentity {
  return {
    source: { kind: "adapter", sourceId: "source_patchmesh_site", instanceId: "11111111-1111-4111-8111-111111111111" },
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    workspaceRoot,
    agentId: "agent_patchmesh_site",
    taskId: "task_patchmesh_site",
    causationId: null,
  };
}

function nextCorrelation(): () => `corr_${string}` {
  let value = 0;
  return () => `corr_${(++value).toString(16).padStart(32, "0")}`;
}

async function git(directory: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd: directory, encoding: "utf8", windowsHide: true });
}

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-site-gateway-"));
  try {
    await run(join(root, "events.sqlite"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("detects the synchronous patchmesh-site gateway capability and changes digest with capability content", () => {
  const ready = detectPatchMeshSiteCapabilities(hostContract);
  assert.equal(ready.status, "internal_ready");
  assert.equal(ready.capabilities.runtime, "patchmesh-site");
  assert.equal(ready.capabilities.wrapsToolExecution, true);

  const changed = detectPatchMeshSiteCapabilities({ ...hostContract, exactReportedEffects: false });
  assert.notEqual(changed.capabilityDigest, ready.capabilityDigest);
  const blocked = detectPatchMeshSiteCapabilities({ ...hostContract, synchronousGateway: false });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.code, "PATCHMESH_SITE_SYNCHRONOUS_GATEWAY_UNAVAILABLE");
  const invalid = detectPatchMeshSiteCapabilities({ ...hostContract, runtimeVersion: "" });
  assert.equal(invalid.status, "blocked");
  assert.equal(invalid.code, "PATCHMESH_SITE_CAPABILITY_INVALID");
  const blockedStore = SqliteEventStore.open(":memory:");
  try {
    assert.throws(
      () => new PatchMeshSiteMcpGateway({
        eventStore: blockedStore,
        hostContract: { ...hostContract, synchronousGateway: false },
      }),
      (error: unknown) => error instanceof PatchMeshSiteCapabilityError
        && error.code === "PATCHMESH_SITE_SYNCHRONOUS_GATEWAY_UNAVAILABLE",
    );
  } finally {
    blockedStore.close();
  }
});

test("gateway rejects payload identity that attempts to override authoritative runtime context", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    const gateway = new PatchMeshSiteMcpGateway({ eventStore: store, hostContract, createCorrelationId: nextCorrelation() });
    try {
      await assert.rejects(
        gateway.dispatch(runtimeIdentity(tmpdir()), {
          call: { toolName: "read_file", operation: "read", targetResourceId: null, opaque: false },
          execute: async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
          payloadIdentity: { repositoryId: "repo_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        }),
        PatchMeshSiteIdentityMismatchError,
      );
      assert.deepEqual(store.read(), []);
    } finally {
      await gateway.dispose();
      store.close();
    }
  });
});

test("gateway rejects a non-adapter runtime source before execution or persistence", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    const gateway = new PatchMeshSiteMcpGateway({ eventStore: store, hostContract, createCorrelationId: nextCorrelation() });
    try {
      await assert.rejects(
        gateway.dispatch({
          ...runtimeIdentity(tmpdir()),
          source: { kind: "watcher", sourceId: "source_patchmesh_site_wrong", instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        }, {
          call: { toolName: "read_file", operation: "read", targetResourceId: null, opaque: false },
          execute: async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
        }),
        PatchMeshSiteRuntimeIdentityError,
      );
      assert.deepEqual(store.read(), []);
    } finally {
      await gateway.dispose();
      store.close();
    }
  });
});

test("gateway serializes overlapping dispatches so adapter source sequences remain append-ordered", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    const gateway = new PatchMeshSiteMcpGateway({ eventStore: store, hostContract, createCorrelationId: nextCorrelation() });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondExecutions = 0;
    try {
      const identity = runtimeIdentity(tmpdir());
      const first = gateway.dispatch(identity, {
        call: { toolName: "read_file", operation: "first", targetResourceId: null, opaque: false },
        execute: async () => {
          enteredFirst();
          await firstReleased;
          return { outcome: "succeeded", value: "first", exitCode: 0 } as const;
        },
      });
      await firstEntered;
      const second = gateway.dispatch(identity, {
        call: { toolName: "read_file", operation: "second", targetResourceId: null, opaque: false },
        execute: async () => {
          secondExecutions += 1;
          return { outcome: "succeeded", value: "second", exitCode: 0 } as const;
        },
      });
      await Promise.resolve();
      assert.equal(secondExecutions, 0, "second executor waits for first completion");
      releaseFirst();
      await Promise.all([first, second]);
      const adapterEvents = store.read().filter((event) => event.source.kind === "adapter");
      assert.deepEqual(adapterEvents.map((event) => event.eventType), [
        "tool.requested", "tool.completed", "tool.requested", "tool.completed",
      ]);
      assert.deepEqual(adapterEvents.map((event) => event.sourceSequence), [0, 1, 2, 3]);
    } finally {
      await gateway.dispose();
      store.close();
    }
  });
});

test("gateway owns one real file-changing MCP execution and forwards only its persisted linked evidence", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "patchmesh-site-real-host-"));
  const databasePath = join(workspaceRoot, "events.sqlite");
  let gateway: PatchMeshSiteMcpGateway | undefined;
  let store: SqliteEventStore | undefined;
  try {
    await git(workspaceRoot, "init", "-b", "main");
    await git(workspaceRoot, "config", "user.email", "gateway@example.invalid");
    await git(workspaceRoot, "config", "user.name", "PatchMesh Site Gateway");
    mkdirSync(join(workspaceRoot, "src"));
    writeFileSync(join(workspaceRoot, "src", "note.ts"), "export const note = 'before';\n");
    await git(workspaceRoot, "add", ".");
    await git(workspaceRoot, "commit", "-m", "initial");

    const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const observer = new NodeObservationBoundary({
      source: { kind: "watcher", sourceId: "source_patchmesh_site_observer", instanceId: "22222222-2222-4222-8222-222222222222" },
      quiescenceMs: 0,
      watcherFactory: (_root, callback) => { listener = callback; return watcher; },
    });
    store = SqliteEventStore.open(databasePath);
    const recorderPayloads: unknown[] = [];
    gateway = new PatchMeshSiteMcpGateway({
      eventStore: store,
      hostContract,
      proxyOptions: {
        observer,
        phase2SourceAnalysis: {
          source: { kind: "analyzer", sourceId: "source_patchmesh_site_typescript", instanceId: "44444444-4444-4444-8444-444444444444" },
          analyzer: { analyzerId: "analyzer_typescript", version: "1" },
          configuration: { parser: "typescript" },
          integrationTarget: "main",
        },
      },
      createCorrelationId: nextCorrelation(),
      evidenceRecorder: { record(payload) { recorderPayloads.push(payload); } },
    });
    const resourceId = fileResourceId(runtimeIdentity(workspaceRoot).repositoryId, "src/note.ts");
    let executions = 0;
    const result = await gateway.dispatch(runtimeIdentity(workspaceRoot), {
      call: { toolName: "edit_file", operation: "replace note", targetResourceId: resourceId, opaque: false },
      execute: async () => {
        executions += 1;
        writeFileSync(join(workspaceRoot, "src", "note.ts"), "export const note = 'after';\n");
        listener!("change", "src/note.ts");
        return { outcome: "succeeded", value: "host-result", exitCode: 0, effectResourceIds: [resourceId] };
      },
    });

    assert.equal(executions, 1);
    assert.deepEqual(result.execution, { outcome: "succeeded", value: "host-result", exitCode: 0, effectResourceIds: [resourceId] });
    assert.equal(result.recorderDiagnostic, null);
    assert.equal(result.proxyResult.coverage?.presentation, "sufficient");
    assert.equal(result.evidence?.effects.length, 1);
    assert.equal(result.evidence?.effects[0]?.eventType, "file.changed");
    assert.equal(result.evidence?.effects[0]?.payload.resource.resourceId, resourceId);
    assert.deepEqual(result.evidence?.events.map((event) => event.eventId), [
      result.proxyResult.requestEventId,
      result.evidence?.effects[0]?.eventId,
      result.proxyResult.completedEventId,
    ]);
    assert.equal(recorderPayloads.length, 1);
    const persisted = store.read();
    assert.ok(persisted.some((event) => event.eventType === "symbol.changed"));
    assert.equal(result.evidence?.events.length, 3, "recorder slice excludes derived completion-linked events");
    assert.equal(persisted.filter((event) => event.eventType === "tool.requested").length, 1);
    assert.equal(persisted.filter((event) => event.eventType === "tool.completed").length, 1);
  } finally {
    await gateway?.dispose();
    store?.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("gateway preserves failed, interrupted, aborted, and non-zero execution results exactly once", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    const gateway = new PatchMeshSiteMcpGateway({ eventStore: store, hostContract, createCorrelationId: nextCorrelation() });
    try {
      let invocations = 0;
      const identity = runtimeIdentity(tmpdir());
      const failed = await gateway.dispatch(identity, {
        call: { toolName: "run_shell", operation: "fail", targetResourceId: null, opaque: true },
        execute: async () => { invocations += 1; return { outcome: "failed", error: new Error("private failure"), exitCode: 13 }; },
      });
      const abort = new AbortController();
      abort.abort();
      const interrupted = await gateway.dispatch(identity, {
        call: { toolName: "run_test", operation: "abort", targetResourceId: null, opaque: true },
        execute: async (signal) => { invocations += 1; assert.equal(signal.aborted, true); return { outcome: "interrupted", reason: "aborted", exitCode: null }; },
      }, abort.signal);
      const nonZero = await gateway.dispatch(identity, {
        call: { toolName: "run_shell", operation: "non-zero", targetResourceId: null, opaque: true },
        execute: async () => { invocations += 1; return { outcome: "succeeded", value: "tool output", exitCode: 7 }; },
      });
      assert.equal(invocations, 3);
      assert.deepEqual(failed.execution, { outcome: "failed", error: failed.execution.outcome === "failed" ? failed.execution.error : undefined, exitCode: 13 });
      assert.equal(interrupted.execution.outcome, "interrupted");
      assert.equal(nonZero.execution.outcome, "succeeded");
      assert.equal(nonZero.execution.exitCode, 7);
      assert.equal(store.read().filter((event) => event.eventType === "tool.requested").length, 3);
      assert.equal(store.read().filter((event) => event.eventType === "tool.completed").length, 3);
    } finally {
      await gateway.dispose();
      store.close();
    }
  });
});

test("recorder failure is bounded and the evidence reader cannot mix stores", async () => {
  await withTemporaryDatabase(async (databasePath) => {
    const store = SqliteEventStore.open(databasePath);
    const otherStore = SqliteEventStore.open(":memory:");
    const gateway = new PatchMeshSiteMcpGateway({
      eventStore: store,
      hostContract,
      createCorrelationId: nextCorrelation(),
      evidenceRecorder: { record() { throw new Error("Authorization: Bearer sensitive-value"); } },
    });
    try {
      const result = await gateway.dispatch(runtimeIdentity(tmpdir()), {
        call: { toolName: "read_file", operation: "read", targetResourceId: null, opaque: false },
        execute: async () => ({ outcome: "succeeded", value: "original-result", exitCode: 0 }),
      });
      assert.deepEqual(result.execution, { outcome: "succeeded", value: "original-result", exitCode: 0 });
      assert.equal(result.evidence, null);
      assert.ok(result.recorderDiagnostic);
      assert.doesNotMatch(result.recorderDiagnostic!, /sensitive-value/);
      assert.throws(
        () => readPatchMeshSitePersistedToolEvidence(otherStore, result.proxyResult.completedEventId),
        PatchMeshSitePersistedEvidenceError,
      );
    } finally {
      await gateway.dispose();
      store.close();
      otherStore.close();
    }
  });
});

test("a bypassed file change remains out-of-band and cannot become verified gateway evidence", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "patchmesh-site-bypass-"));
  const databasePath = join(workspaceRoot, "events.sqlite");
  let gateway: PatchMeshSiteMcpGateway | undefined;
  let store: SqliteEventStore | undefined;
  try {
    await git(workspaceRoot, "init", "-b", "main");
    await git(workspaceRoot, "config", "user.email", "gateway@example.invalid");
    await git(workspaceRoot, "config", "user.name", "PatchMesh Site Gateway");
    writeFileSync(join(workspaceRoot, "note.txt"), "before\n");
    await git(workspaceRoot, "add", ".");
    await git(workspaceRoot, "commit", "-m", "initial");

    const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    const observer = new NodeObservationBoundary({
      source: { kind: "watcher", sourceId: "source_patchmesh_site_bypass", instanceId: "33333333-3333-4333-8333-333333333333" },
      quiescenceMs: 0,
      watcherFactory: (_root, callback) => { listener = callback; return watcher; },
    });
    store = SqliteEventStore.open(databasePath);
    gateway = new PatchMeshSiteMcpGateway({ eventStore: store, hostContract, proxyOptions: { observer }, createCorrelationId: nextCorrelation() });
    const identity = runtimeIdentity(workspaceRoot);
    await gateway.dispatch(identity, {
      call: { toolName: "read_file", operation: "initialize observation", targetResourceId: null, opaque: false },
      execute: async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
    });

    writeFileSync(join(workspaceRoot, "note.txt"), "bypassed\n");
    listener!("change", "note.txt");
    const result = await gateway.dispatch(identity, {
      call: { toolName: "read_file", operation: "unrelated read", targetResourceId: null, opaque: false },
      execute: async () => ({ outcome: "succeeded", value: true, exitCode: 0 }),
    });
    assert.equal(result.proxyResult.coverage?.presentation, "degraded");
    assert.equal(result.evidence?.effects.length, 0);
    assert.ok(result.proxyResult.observationDiagnostics.some((diagnostic) => diagnostic.kind === "unattributed"));
  } finally {
    await gateway?.dispose();
    store?.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
