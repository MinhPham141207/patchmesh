import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { NodeObservationBoundary, ObservationSidecar, ObservationSidecarServerClient, connectObservationSidecar, deterministicObservationDrainId, startObservationSidecarServer, type ObservationContext, type ObservationCapture } from "../src/index.js";

const context = (root: string): ObservationContext => ({
  workspaceRoot: root,
  repositoryId: "repo_test" as ObservationContext["repositoryId"],
  workspaceId: "ws_test" as ObservationContext["workspaceId"],
  worktreeId: "wt_test" as ObservationContext["worktreeId"],
});

const capture = (): ObservationCapture => ({
  snapshot: {
    repository: { commonDirectory: null, revision: null },
    worktree: { administrativeDirectory: null },
    files: new Map(),
  },
  gaps: [],
  outOfBandChanges: [],
});

function realBoundary(listener?: { current: ((eventType: string, filename: string | Buffer | null) => void) | undefined }): NodeObservationBoundary {
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } });
  return new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_test_sidecar", instanceId: "11111111-1111-4111-8111-111111111111" },
    quiescenceMs: 0,
    reconciliationScheduler: () => undefined,
    watcherFactory: (_root, callback) => {
      if (listener) listener.current = callback;
      return watcher as never;
    },
  });
}

function fakeBoundary() {
  const value = capture();
  return {
    async beginWindow() { return { workspaceId: "ws_test", cursor: 0, before: value }; },
    async endWindow(window: { before: ObservationCapture }) { return { capture: window.before, completeness: "complete" as const, reconciliationRequired: false }; },
    async dispose() {},
    async restoreSnapshot() {},
  };
}

test("sidecar serializes duplicate drains and retries pending transactions", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-"));
  try {
    const stateDirectory = join(root, "state");
    const first = new ObservationSidecar(root, { stateDirectory, boundary: fakeBoundary() as never });
    await first.start();
    const [left, right] = await Promise.all([first.drain("request-1", context(root)), first.drain("request-1", context(root))]);
    assert.equal(left.transactionId, right.transactionId);
    assert.equal(left.baselineOnly, true);
    await first.ack("request-1", left.transactionId);
    const restarted = new ObservationSidecar(root, { stateDirectory, boundary: fakeBoundary() as never });
    await restarted.start();
    const replay = await restarted.drain("request-1", context(root));
    assert.equal(replay.transactionId, left.transactionId);
    assert.equal(replay.preparedAt, left.preparedAt);
    assert.equal(replay.baselineOnly, false);
    assert.match(readFileSync(join(stateDirectory, "sidecar.json"), "utf8"), /request-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observation drain IDs are deterministic", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-id-"));
  try {
    const value = context(root);
    assert.equal(deterministicObservationDrainId(value, "stop"), deterministicObservationDrainId(value, "stop"));
    assert.notEqual(deterministicObservationDrainId(value, "stop"), deterministicObservationDrainId(value, "session-end"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar serves drain and ack over local IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-ipc-"));
  let server: Awaited<ReturnType<typeof startObservationSidecarServer>> | undefined;
  try {
    server = await startObservationSidecarServer(root, { boundary: fakeBoundary() as never });
    const client = await connectObservationSidecar(root);
    const result = await client.drain("ipc-request", context(root));
    await client.ack(result.requestId, result.transactionId);
    assert.equal(result.requestId, "ipc-request");
  } finally {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar reconciles files changed while the watcher was down", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-restart-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-state-"));
  try {
    const target = join(root, "changed.txt");
    writeFileSync(target, "before\n");
    const firstBoundary = realBoundary();
    const first = new ObservationSidecar(root, { stateDirectory, boundary: firstBoundary });
    await first.start();
    const baseline = await first.drain("restart-baseline", context(root));
    await first.ack(baseline.requestId, baseline.transactionId);
    await first.stop();

    writeFileSync(target, "after\n");
    const restarted = new ObservationSidecar(root, { stateDirectory, boundary: realBoundary() });
    await restarted.start();
    const result = await restarted.drain("restart-after-downtime", context(root));
    assert.equal(result.before.snapshot.files.get("changed.txt")?.contentHash, baseline.capture.snapshot.files.get("changed.txt")?.contentHash);
    assert.notEqual(result.capture.snapshot.files.get("changed.txt")?.contentHash, baseline.capture.snapshot.files.get("changed.txt")?.contentHash);
    await restarted.ack(result.requestId, result.transactionId);
    await restarted.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("incremental capture applies a newly added Git ignore rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-ignore-"));
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "candidate.txt"), "candidate\n");
    const boundary = realBoundary({ get current() { return listener; }, set current(value) { listener = value; } });
    const observationContext = context(root);
    const baseline = await boundary.beginWindow(observationContext);
    await boundary.endWindow(baseline);

    writeFileSync(join(root, ".gitignore"), "candidate.txt\n");
    listener?.("change", ".gitignore");
    const next = await boundary.beginWindow(observationContext);
    const result = await boundary.endWindow(next);
    assert.equal(result.capture.snapshot.files.has("candidate.txt"), false);
    assert.equal(result.completeness, "degraded");
    assert.ok(result.capture.gaps.some((item) => item.scope === "tool.effects"));
    await boundary.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar IPC requests fail when the server stalls", async () => {
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\patchmesh-sidecar-timeout-${randomUUID()}`
    : join(tmpdir(), `patchmesh-sidecar-timeout-${randomUUID()}.sock`);
  const server = createServer((socket) => socket.setTimeout(500, () => socket.destroy()));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => { server.removeListener("error", reject); resolve(); });
  });
  try {
    const client = new ObservationSidecarServerClient(address, undefined, 25);
    const outcome = await Promise.race([
      client.drain("stalled", context(tmpdir())).then(() => "resolved", (error: Error) => `error:${error.message}`),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    assert.equal(outcome, "error:observation request timed out");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
