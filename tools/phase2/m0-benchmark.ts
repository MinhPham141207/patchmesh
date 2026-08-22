import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpProxy, type McpCallContext, type McpToolCall } from "patchmesh-adapters";
import { fileResourceId, NodeObservationBoundary, OBSERVATION_IGNORE_POLICY_VERSION, type NodeObservationOptions } from "patchmesh-observation";
import { SqliteEventStore } from "patchmesh-storage";
import { loadM0GateDefinition, type M0GateDefinition, type Sha256Digest } from "./gate-definitions.js";
import { verifyM0Evidence } from "./m0-evidence.js";
import { DEFAULT_M0_ARTIFACT_PATH } from "./m0-paths.js";

const execFile = promisify(execFileCallback);

export interface M0RawSample {
  readonly baselineNs: number | null;
  readonly instrumentedNs: number | null;
  readonly overheadNs: number | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface M0BenchmarkArtifact {
  readonly schemaVersion: 1;
  readonly evidenceKind: "m0_interception_budget";
  readonly definitionVersion: string;
  readonly definitionDigest: Sha256Digest;
  readonly generatedAt: string;
  readonly commit: string;
  readonly gitDirty: boolean;
  readonly environment: Readonly<Record<string, string | number | boolean>>;
  readonly workloads: readonly {
    readonly workloadId: string;
    readonly fileCount: number;
    readonly budgetMs: number;
    readonly coldInitializationMs: number;
    readonly coldInitializationRunsMs: readonly number[];
    readonly runs: readonly { readonly runId: string; readonly warmupSamples: readonly M0RawSample[]; readonly samples: readonly M0RawSample[]; readonly p50Ms: number | null; readonly p95Ms: number | null }[];
    readonly gateP95Ms: number | null;
    readonly failures: number;
    readonly accepted: boolean;
  }[];
  /** Deliberately non-authoritative metadata. The verifier recomputes its decision. */
  readonly decision: "accepted" | "deferred" | "rejected";
  readonly reason: string;
  readonly owner: string | null;
  readonly dueGate: string | null;
}

export interface M0BenchmarkOptions {
  readonly root?: string;
  readonly outputPath?: string;
  /** Test-only reduced contract. Canonical CLI always loads the versioned definition. */
  readonly definition?: M0GateDefinition;
  readonly definitionDigest?: Sha256Digest;
  /** Test-only deterministic watcher backend. Canonical CLI uses the platform watcher. */
  readonly watcherFactory?: NodeObservationOptions["watcherFactory"];
  /** Test-only event injection paired with fixture mutations. */
  readonly notifyCandidate?: (workspaceRoot: string, logicalPath: string) => void;
}

function eventId(value: number): `evt_${string}` { return `evt_${value.toString(16).padStart(32, "0")}`; }
function correlationId(value: number): `corr_${string}` { return `corr_${value.toString(16).padStart(32, "0")}`; }
function nowNs(): bigint { return process.hrtime.bigint(); }
function content(index: number, sequence: number, bytes: number, seed: string): string {
  const prefix = `${seed}:${index}:${sequence}:`;
  return prefix + "x".repeat(Math.max(0, bytes - Buffer.byteLength(prefix)));
}

/**
 * The largest tier stages 50,000 files, and Git's default output prints one line per
 * added path. That exceeds Node's 1 MB default `maxBuffer` and rejects the whole run,
 * so every invocation here is given headroom well beyond the largest tier's output.
 */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  return result.stdout.trim();
}

async function deterministicFixtureCommit(root: string): Promise<void> {
  await mkdir(join(root, ".git", "benchmark-empty-hooks"), { recursive: true });
  await execFile("git", [
    "-c", "commit.gpgSign=false",
    "-c", "core.hooksPath=.git/benchmark-empty-hooks",
    // --quiet suppresses the per-path summary. The benchmark never reads this
    // output, and at 50,000 paths printing it is pure overhead.
    "commit", "--quiet", "--no-gpg-sign", "-m", "M0 deterministic fixture",
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
}

/** Creates the canonical deterministic, network-free repository fixture for one tier. */
export async function createM0Fixture(root: string, fileCount: number, bytesPerFile: number, seed: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "m0-benchmark@example.invalid");
  await git(root, "config", "user.name", "PatchMesh M0 Benchmark");
  const sourceRoot = join(root, "src");
  await mkdir(sourceRoot, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(sourceRoot, `fixture-${index.toString().padStart(6, "0")}.txt`), content(index, 0, bytesPerFile, seed), "utf8");
  }
  await git(root, "add", ".");
  await deterministicFixtureCommit(root);
}

async function repositoryIdentity(root: string): Promise<{ readonly commit: string; readonly gitDirty: boolean }> {
  try {
    const [commit, status] = await Promise.all([git(root, "rev-parse", "HEAD"), git(root, "status", "--porcelain")]);
    return { commit, gitDirty: status.length > 0 };
  } catch {
    return { commit: "0".repeat(40), gitDirty: true };
  }
}

async function benchmarkEnvironment(root: string, definitionDigest: Sha256Digest): Promise<Record<string, string | number | boolean>> {
  const identity = await repositoryIdentity(root);
  let pnpmVersion = "unavailable";
  try { pnpmVersion = (await execFile("corepack", ["pnpm", "--version"], { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim(); } catch { /* recorded as unavailable */ }
  return {
    timestamp: new Date().toISOString(), commit: identity.commit, dirty: identity.gitDirty,
    os: platform(), osRelease: release(), architecture: arch(), cpu: cpus()[0]?.model ?? "unknown",
    memoryBytes: totalmem(), nodeVersion: process.version, pnpmVersion, workloadDefinitionDigest: definitionDigest,
  };
}

function context(workspaceRoot: string, sequence: number): McpCallContext {
  return {
    source: { kind: "adapter", sourceId: "source_m0_benchmark", instanceId: "00000000-0000-4000-8000-000000000001" },
    repositoryId: "repo_00000000-0000-4000-8000-000000000001", workspaceId: "ws_00000000-0000-4000-8000-000000000001",
    worktreeId: "wt_00000000-0000-4000-8000-000000000001", workspaceRoot, agentId: null, taskId: null,
    correlationId: correlationId(sequence), causationId: null, requestSourceSequence: sequence * 2, completionSourceSequence: sequence * 2 + 1,
  };
}

const benchmarkRepositoryId = "repo_00000000-0000-4000-8000-000000000001";
const benchmarkTargetLocator = "src/fixture-000000.txt";
const benchmarkTargetResourceId = fileResourceId(benchmarkRepositoryId, benchmarkTargetLocator);
const call: McpToolCall = { toolName: "edit_file", operation: "m0_fixture_mutation", targetResourceId: benchmarkTargetResourceId, opaque: false };

async function runTier(
  storageRoot: string,
  definition: M0GateDefinition,
  workload: M0GateDefinition["workloads"][number],
  bytesPerFile: number,
  watcherFactory?: NodeObservationOptions["watcherFactory"],
  notifyCandidate?: (workspaceRoot: string, logicalPath: string) => void,
): Promise<M0BenchmarkArtifact["workloads"][number]> {
  const runs: M0BenchmarkArtifact["workloads"][number]["runs"][number][] = [];
  const coldInitializationRunsMs: number[] = [];
  for (let run = 0; run < definition.independentRuns; run += 1) {
    const workspaceRoot = join(storageRoot, `run-${run + 1}-repository`);
    await mkdir(workspaceRoot, { recursive: true });
    await createM0Fixture(workspaceRoot, workload.fileCount, bytesPerFile, definition.fixtureGenerator.contentSeed);
    const target = join(workspaceRoot, "src", "fixture-000000.txt");
    const original = content(0, 0, bytesPerFile, definition.fixtureGenerator.contentSeed);
    const writeTarget = async (value: string): Promise<void> => {
      await writeFile(target, value, "utf8");
      notifyCandidate?.(workspaceRoot, benchmarkTargetLocator);
    };
    const mutate = (sequence: number) => writeTarget(content(0, sequence, bytesPerFile, definition.fixtureGenerator.contentSeed));
    const restore = () => writeTarget(original);
    const databasePath = join(storageRoot, `events-${run}.sqlite`);
    const scheduledReconciliations: Array<() => Promise<void>> = [];
    const flushReconciliations = async (): Promise<void> => {
      while (scheduledReconciliations.length > 0) await scheduledReconciliations.shift()!();
    };
    const observer = new NodeObservationBoundary({
      source: { kind: "watcher", sourceId: "source_m0_observer", instanceId: "00000000-0000-4000-8000-000000000002" },
      reconciliationScheduler: (work) => { scheduledReconciliations.push(work); },
      ...(watcherFactory === undefined ? {} : { watcherFactory }),
    });
    const initialized = nowNs();
    const initialContext = { ...context(workspaceRoot, 10_000 + run), workspaceRoot };
    const initialWindow = await observer.beginWindow(initialContext);
    await observer.endWindow(initialWindow);
    coldInitializationRunsMs.push(Number(nowNs() - initialized) / 1_000_000);
    const store = SqliteEventStore.open(databasePath);
    let nextId = (run + 1) * 10_000;
    const proxy = new McpProxy({ eventStore: store, observer, createEventId: () => eventId(nextId++), now: () => new Date().toISOString() });
    const reconcileOutsideTimedRegion = async (sequence: number): Promise<void> => {
      await flushReconciliations();
      const reconcileWindow = await observer.beginWindow({ ...context(workspaceRoot, sequence), workspaceRoot });
      await observer.endWindow(reconcileWindow);
      await flushReconciliations();
    };
    const measure = async (sampleIndex: number): Promise<M0RawSample> => {
      let baselineNs: number | null = null;
      let instrumentedNs: number | null = null;
      let sampleFailure: M0RawSample["failure"] = null;
      try {
        const mutationSequence = (run + 1) * 1_000 + sampleIndex + 1;
        const beforeBaseline = nowNs(); await mutate(mutationSequence); baselineNs = Number(nowNs() - beforeBaseline);
        await restore();
        await reconcileOutsideTimedRegion(nextId + 100_000);
        const beforeInstrumented = nowNs();
        const result = await proxy.execute(call, context(workspaceRoot, nextId), async () => {
          await mutate(mutationSequence);
          return { outcome: "succeeded", value: true, exitCode: 0, effectResourceIds: [benchmarkTargetResourceId] };
        });
        instrumentedNs = Number(nowNs() - beforeInstrumented);
        if (result.execution.outcome !== "succeeded") sampleFailure = { code: `PROXY_EXECUTION_${result.execution.outcome.toUpperCase()}`, message: `Instrumented execution ${result.execution.outcome}.` };
        else if (result.coverage?.presentation !== "sufficient") sampleFailure = { code: "OBSERVATION_COVERAGE_DEGRADED", message: "Instrumented execution did not produce sufficient observation coverage." };
      } catch (error) {
        sampleFailure = { code: error instanceof Error ? error.name : "UnknownFailure", message: "The paired mutation could not be measured." };
      }
      finally {
        try {
          await restore();
          await reconcileOutsideTimedRegion(nextId + 200_000);
        } catch (error) {
          sampleFailure ??= { code: error instanceof Error ? `Restoration${error.name}` : "RestorationFailure", message: "The fixture pre-state could not be restored." };
        }
      }
      return { baselineNs, instrumentedNs, overheadNs: baselineNs === null || instrumentedNs === null ? null : Math.max(0, instrumentedNs - baselineNs), failure: sampleFailure };
    };
    try {
      const warmupSamples: M0RawSample[] = [];
      const samples: M0RawSample[] = [];
      for (let index = 0; index < definition.warmupSamples; index += 1) warmupSamples.push(await measure(index));
      for (let index = 0; index < definition.measuredSamples; index += 1) samples.push(await measure(definition.warmupSamples + index));
      runs.push({ runId: `run-${run + 1}`, warmupSamples, samples, p50Ms: null, p95Ms: null });
    } finally { await flushReconciliations(); store.close(); await observer.dispose(); }
  }
  return { workloadId: workload.workloadId, fileCount: workload.fileCount, budgetMs: workload.budgetMs, coldInitializationMs: coldInitializationRunsMs.reduce((sum, value) => sum + value, 0) / definition.independentRuns, coldInitializationRunsMs, runs, gateP95Ms: null, failures: 0, accepted: false };
}

export async function generateM0Benchmark(options: M0BenchmarkOptions = {}): Promise<M0BenchmarkArtifact> {
  const root = resolve(options.root ?? process.cwd());
  const loaded = options.definition === undefined ? await loadM0GateDefinition(root) : [options.definition, options.definitionDigest] as const;
  const [definition, definitionDigest] = loaded;
  if (definitionDigest === undefined) throw new Error("a reduced benchmark definition requires its canonical digest");
  if (definition.ignorePolicyVersion !== OBSERVATION_IGNORE_POLICY_VERSION) throw new Error("M0 fixture ignore policy does not match the observation runtime");
  const identity = await repositoryIdentity(root);
  const environment = await benchmarkEnvironment(root, definitionDigest);
  const bytesPerFile = definition.fixtureGenerator.fileSizeDistribution.bytesPerFile;
  const workloads: Array<M0BenchmarkArtifact["workloads"][number]> = [];
  for (const workload of definition.workloads) {
    const temporary = await mkdtemp(join(tmpdir(), `patchmesh-m0-${workload.workloadId}-`));
    try { workloads.push(await runTier(temporary, definition, workload, bytesPerFile, options.watcherFactory, options.notifyCandidate)); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const unverified: M0BenchmarkArtifact = { schemaVersion: 1, evidenceKind: "m0_interception_budget", definitionVersion: definition.definitionVersion, definitionDigest, generatedAt: new Date().toISOString(), commit: identity.commit, gitDirty: identity.gitDirty, environment, workloads, decision: "deferred", reason: "Generated evidence requires independent verification.", owner: "phase2-runtime", dueGate: "M0 controlled benchmark" };
  const generatedVerification = verifyM0Evidence(unverified, definition, definitionDigest, identity.commit);
  const verifiedByWorkload = new Map(generatedVerification.workloads.map((workload) => [workload.workloadId, workload] as const));
  const summarizedWorkloads = unverified.workloads.map((workload) => {
    const verified = verifiedByWorkload.get(workload.workloadId);
    const verifiedRuns = new Map(verified?.runs.map((run) => [run.runId, run] as const) ?? []);
    return {
      ...workload,
      runs: workload.runs.map((run) => ({ ...run, p50Ms: verifiedRuns.get(run.runId)?.p50Ms ?? null, p95Ms: verifiedRuns.get(run.runId)?.p95Ms ?? null })),
      gateP95Ms: verified?.gateP95Ms ?? null,
      failures: verified?.failures ?? workload.runs.flatMap((run) => [...run.warmupSamples, ...run.samples]).filter((sample) => sample.failure !== null).length,
      accepted: verified?.accepted ?? false,
    };
  });
  const artifact: M0BenchmarkArtifact = {
    ...unverified,
    workloads: summarizedWorkloads,
    decision: generatedVerification.outcome,
    reason: generatedVerification.diagnostics.length === 0
      ? "Raw evidence passes the loaded M0 contract; independent verification is still required."
      : generatedVerification.diagnostics.join("; "),
    owner: generatedVerification.outcome === "accepted" ? null : "phase2-runtime",
    dueGate: generatedVerification.outcome === "accepted" ? null : "M0 controlled benchmark",
  };
  if (options.outputPath !== undefined) {
    const outputPath = resolve(root, options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
  return artifact;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  const root = resolve(import.meta.dirname, "../..");
  const outputFlag = process.argv.indexOf("--output");
  const outputPath = outputFlag >= 0 ? process.argv[outputFlag + 1] : DEFAULT_M0_ARTIFACT_PATH;
  if (outputPath === undefined) throw new Error(`usage: m0-benchmark.ts [--output <artifact=${DEFAULT_M0_ARTIFACT_PATH}>]`);
  const artifact = await generateM0Benchmark({ root, outputPath });
  console.log(JSON.stringify({ outputPath: resolve(root, outputPath), workloads: artifact.workloads.map((workload) => workload.workloadId), gitDirty: artifact.gitDirty, decision: artifact.decision }, null, 2));
}
