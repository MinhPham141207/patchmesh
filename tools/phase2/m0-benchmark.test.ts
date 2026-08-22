import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { type FSWatcher } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { diffSnapshots, NodeObservationBoundary, type ObservationContext } from "patchmesh-observation";
import type { M0GateDefinition, Sha256Digest } from "./gate-definitions.js";
import { createM0Fixture, generateM0Benchmark } from "./m0-benchmark.js";

const execFile = promisify(execFileCallback);

const digest = `sha256:${"a".repeat(64)}` as Sha256Digest;
const smokeDefinition = {
  schemaVersion: 1, definitionVersion: "phase2-m0-v1", metric: "incremental_interception_overhead_ms", percentile: 0.95,
  warmupSamples: 1, measuredSamples: 2, independentRuns: 3,
  fixtureGenerator: { version: "phase2-m0-fixture-v1", contentSeed: "patchmesh-phase2-m0-v1", fileSizeDistribution: { kind: "fixed", bytesPerFile: 256 }, changedHotFilesPerOperation: 1 },
  ignorePolicyVersion: "phase2-observation-ignore-v1", requiresNetworkAccess: false, requiresTemporaryLocalGitRepository: true, requiresSqliteStore: true,
  requiredEnvironmentFields: ["timestamp", "commit", "dirty", "os", "osRelease", "architecture", "cpu", "memoryBytes", "nodeVersion", "pnpmVersion", "workloadDefinitionDigest"],
  workloads: [{ workloadId: "small", fileCount: 3, budgetMs: 250 }],
} as unknown as M0GateDefinition;

test("deterministic fixture generator writes reproducible canonical content", async () => {
  const first = await mkdtemp(join(tmpdir(), "patchmesh-m0-fixture-a-"));
  const second = await mkdtemp(join(tmpdir(), "patchmesh-m0-fixture-b-"));
  try {
    await createM0Fixture(first, 2, 256, "seed");
    await createM0Fixture(second, 2, 256, "seed");
    assert.equal(await readFile(join(first, "src", "fixture-000001.txt"), "utf8"), await readFile(join(second, "src", "fixture-000001.txt"), "utf8"));
    const firstRevision = (await execFile("git", ["rev-parse", "HEAD"], { cwd: first, encoding: "utf8" })).stdout.trim();
    const secondRevision = (await execFile("git", ["rev-parse", "HEAD"], { cwd: second, encoding: "utf8" })).stdout.trim();
    assert.equal(firstRevision, secondRevision);
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test("reduced benchmark emits raw paired samples for every independent run", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "patchmesh-m0-output-"));
  const output = join(outputRoot, "nested", "artifact.json");
  const listeners = new Map<string, (eventType: string, filename: string | Buffer | null) => void>();
  try {
    const artifact = await generateM0Benchmark({
      root: process.cwd(),
      outputPath: output,
      definition: smokeDefinition,
      definitionDigest: digest,
      watcherFactory: (root, listener) => {
        listeners.set(root, listener);
        return Object.assign(new EventEmitter(), { close() { listeners.delete(root); return this; } }) as unknown as FSWatcher;
      },
      notifyCandidate: (root, logicalPath) => listeners.get(root)?.("change", logicalPath),
    });
    assert.equal(artifact.workloads[0]?.runs.length, 3);
    assert.equal(artifact.workloads[0]?.runs.every((run) => run.warmupSamples.length === 1 && run.samples.length === 2), true);
    const rawSamples = artifact.workloads.flatMap((workload) => workload.runs.flatMap((run) => [...run.warmupSamples, ...run.samples]));
    assert.equal(rawSamples.every((sample) => sample.failure === null), true, JSON.stringify(rawSamples.map((sample) => sample.failure)));
    assert.equal(rawSamples.every((sample) => sample.baselineNs !== null && sample.instrumentedNs !== null && sample.overheadNs !== null), true);
    assert.equal(artifact.decision, "deferred");
    assert.match(artifact.reason, /controlled environment/i);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), artifact);
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test("M0 fixture incremental effects are logically equivalent to a full snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-m0-equivalence-"));
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = Object.assign(new EventEmitter(), { close() { return this; } }) as unknown as FSWatcher;
  const boundary = new NodeObservationBoundary({
    source: { kind: "watcher", sourceId: "source_m0_equivalence", instanceId: "44444444-4444-4444-8444-444444444444" },
    watcherFactory: (_root, value) => { listener = value; return watcher; },
    quiescenceMs: 0,
  });
  const context: ObservationContext = {
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    workspaceRoot: root,
  };
  try {
    await createM0Fixture(root, 3, 256, "seed");
    const window = await boundary.beginWindow(context);
    await writeFile(join(root, "src", "fixture-000000.txt"), "changed M0 fixture\n", "utf8");
    listener?.("change", "src/fixture-000000.txt");
    const incremental = await boundary.endWindow(window);
    const full = await boundary.captureAfter(context);
    assert.equal(incremental.completeness, "complete", JSON.stringify(incremental.capture.gaps));
    assert.deepEqual(
      diffSnapshots(window.before.snapshot, incremental.capture.snapshot, false).changes.map((change) => [change.path, change.changeKind]),
      diffSnapshots(window.before.snapshot, full.snapshot, false).changes.map((change) => [change.path, change.changeKind]),
    );
  } finally {
    await boundary.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
