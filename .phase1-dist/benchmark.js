import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpProxy } from "@patchmesh/adapters";
import { replayEvents, SqliteEventStore } from "@patchmesh/storage";
import { consumerAgentId, consumerTaskId, consumerWorktreeId, producerAgentId, producerTaskId, producerWorktreeId, repositoryId, workspaceId, buildReplayCorpus, duplicateVariant, outOfOrderVariant, } from "./fixtures.js";
import { overheadNs, percentile, requireMatchingDigests, } from "./benchmarking.js";
import { stableDigest, withTemporaryDatabase, withTemporaryDirectory } from "./test-support.js";
const execFile = promisify(execFileCallback);
const ROOT = resolve(process.cwd());
const DEFAULT_OUTPUT = resolve(ROOT, "docs/implementation/phase1/evidence/PHASE_1_M7_BENCHMARKS.json");
function eventId(number) {
    return `evt_${number.toString(16).padStart(32, "0")}`;
}
function correlationId(number) {
    return `corr_${number.toString(16).padStart(32, "0")}`;
}
function failure(error) {
    return { message: error instanceof Error ? error.message : String(error) };
}
function nowNs() {
    return process.hrtime.bigint();
}
async function runGit(cwd, ...args) {
    const result = await execFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return result.stdout.trim();
}
async function createBenchmarkRepository(root) {
    await runGit(root, "init", "-b", "main");
    await runGit(root, "config", "user.email", "m7-benchmark@example.invalid");
    await runGit(root, "config", "user.name", "PatchMesh M7 Benchmark");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "small.txt"), "patchmesh m7 benchmark\n");
    await runGit(root, "add", ".");
    await runGit(root, "commit", "-m", "initial M7 benchmark fixture");
}
function benchmarkObserver() {
    const capture = () => ({
        snapshot: {
            repository: { commonDirectory: null, revision: null },
            worktree: { administrativeDirectory: null },
            files: new Map(),
        },
        gaps: [],
        outOfBandChanges: [],
    });
    return {
        source: {
            kind: "watcher",
            sourceId: "source_m7_benchmark_observer",
            instanceId: "99999999-9999-4999-8999-999999999999",
        },
        captureBefore: async () => capture(),
        captureAfter: async () => capture(),
    };
}
async function environment() {
    let commit = "unknown";
    try {
        commit = await runGit(ROOT, "rev-parse", "HEAD");
    }
    catch {
        commit = "unavailable";
    }
    return {
        timestamp: new Date().toISOString(),
        commit,
        os: `${platform()} ${release()}`,
        architecture: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        memoryBytes: totalmem(),
        nodeVersion: process.version,
    };
}
function context(workspaceRoot, callNumber) {
    const producer = callNumber % 2 === 0;
    return {
        source: {
            kind: "adapter",
            sourceId: "source_m7_benchmark",
            instanceId: "88888888-8888-4888-8888-888888888888",
        },
        repositoryId,
        workspaceId,
        worktreeId: producer ? producerWorktreeId : consumerWorktreeId,
        workspaceRoot,
        agentId: producer ? producerAgentId : consumerAgentId,
        taskId: producer ? producerTaskId : consumerTaskId,
        correlationId: correlationId(callNumber + 1),
        causationId: null,
        requestSourceSequence: callNumber * 2,
        completionSourceSequence: callNumber * 2 + 1,
    };
}
function callFor(operation) {
    if (operation === "small_file_read") {
        return { toolName: "read_file", operation, targetResourceId: null, opaque: false };
    }
    if (operation === "opaque_shell") {
        return { toolName: "run_shell", operation, targetResourceId: null, opaque: true };
    }
    return { toolName: "run_shell", operation, targetResourceId: null, opaque: false };
}
async function executeOperation(operation, workspaceRoot) {
    if (operation === "small_file_read") {
        await readFile(join(workspaceRoot, "src", "small.txt"));
        return;
    }
    if (operation === "opaque_shell") {
        await execFile(process.execPath, ["-e", "void 0"], { windowsHide: true });
    }
}
async function runInterceptionWorkload(definition, runEnvironment) {
    if (definition.operation === undefined || definition.warmupSamples === undefined || definition.measuredSamples === undefined) {
        throw new Error(`interception workload ${definition.workloadId} is missing required fields`);
    }
    const { operation, warmupSamples, measuredSamples } = definition;
    return withTemporaryDirectory(`patchmesh-m7-benchmark-${operation}-`, async (workspaceRoot) => {
        await createBenchmarkRepository(workspaceRoot);
        return withTemporaryDatabase(async (databasePath) => {
            const store = SqliteEventStore.open(databasePath);
            let nextEventId = 1;
            const proxy = new McpProxy({
                eventStore: store,
                observer: benchmarkObserver(),
                createEventId: () => eventId(nextEventId++),
                createCorrelationId: () => correlationId(nextEventId++),
                now: () => new Date().toISOString(),
            });
            const call = callFor(operation);
            const samples = [];
            const measure = async (callNumber, retain) => {
                let baselineNs = null;
                let instrumentedNs = null;
                let sampleFailure = null;
                try {
                    const baselineStart = nowNs();
                    await executeOperation(operation, workspaceRoot);
                    baselineNs = Number(nowNs() - baselineStart);
                    const observedStart = nowNs();
                    await proxy.execute(call, context(workspaceRoot, callNumber), async () => {
                        await executeOperation(operation, workspaceRoot);
                        return { outcome: "succeeded", value: true, exitCode: 0 };
                    });
                    instrumentedNs = Number(nowNs() - observedStart);
                }
                catch (error) {
                    sampleFailure = failure(error);
                }
                if (retain) {
                    samples.push({
                        baselineNs,
                        instrumentedNs,
                        overheadNs: baselineNs === null || instrumentedNs === null
                            ? null
                            : overheadNs(baselineNs, instrumentedNs),
                        failure: sampleFailure,
                    });
                }
            };
            try {
                for (let index = 0; index < warmupSamples; index += 1)
                    await measure(index, false);
                for (let index = 0; index < measuredSamples; index += 1)
                    await measure(index + warmupSamples, true);
            }
            finally {
                store.close();
            }
            const overheads = samples.flatMap((sample) => sample.overheadNs === null ? [] : [sample.overheadNs]);
            return {
                workloadId: definition.workloadId,
                definitionVersion: definition.definitionVersion,
                kind: "interception_latency",
                operation,
                warmupSamples,
                measuredSamples,
                samples,
                p50Ns: overheads.length === 0 ? null : percentile(overheads, 0.5),
                p95Ns: overheads.length === 0 ? null : percentile(overheads, 0.95),
                failures: samples.filter((sample) => sample.failure !== null).length,
                environment: runEnvironment,
            };
        });
    });
}
async function measureReplayVariant(variant, events, definition) {
    if (definition.warmupRuns === undefined || definition.measuredRuns === undefined || definition.eventCount === undefined) {
        throw new Error(`replay workload ${definition.workloadId} is missing required fields`);
    }
    const { warmupRuns, measuredRuns, eventCount } = definition;
    const variantEvents = variant === "canonical"
        ? events
        : variant === "duplicates"
            ? [...new Map(duplicateVariant(events).map((event) => [event.eventId, event])).values()]
            : outOfOrderVariant(events);
    const samples = [];
    const measure = () => {
        const beforeMemory = process.memoryUsage().rss;
        const started = nowNs();
        try {
            const replay = replayEvents(variantEvents);
            const elapsedNs = Number(nowNs() - started);
            const afterMemory = process.memoryUsage().rss;
            return {
                variant,
                elapsedNs,
                eventsPerSecond: eventCount / (elapsedNs / 1_000_000_000),
                peakMemoryBytes: Math.max(beforeMemory, afterMemory),
                snapshotDigest: stableDigest(replay.orderedEvents),
                failure: null,
            };
        }
        catch (error) {
            return {
                variant,
                elapsedNs: null,
                eventsPerSecond: null,
                peakMemoryBytes: null,
                snapshotDigest: null,
                failure: failure(error),
            };
        }
    };
    for (let index = 0; index < warmupRuns; index += 1)
        measure();
    for (let index = 0; index < measuredRuns; index += 1)
        samples.push(measure());
    return samples;
}
async function runReplayWorkload(definition, runEnvironment) {
    if (definition.eventCount === undefined)
        throw new Error(`replay workload ${definition.workloadId} has no event count`);
    const events = buildReplayCorpus(definition.eventCount);
    const samples = [
        ...(await measureReplayVariant("canonical", events, definition)),
        ...(await measureReplayVariant("duplicates", events, definition)),
        ...(await measureReplayVariant("out_of_order", events, definition)),
    ];
    const successful = samples.filter((sample) => sample.snapshotDigest !== null);
    requireMatchingDigests(successful.map((sample) => sample.snapshotDigest));
    const elapsed = successful.flatMap((sample) => sample.elapsedNs === null ? [] : [sample.elapsedNs]);
    return {
        workloadId: definition.workloadId,
        definitionVersion: definition.definitionVersion,
        kind: "replay",
        eventCount: definition.eventCount,
        warmupRuns: definition.warmupRuns,
        measuredRuns: definition.measuredRuns,
        samples,
        p50Ns: elapsed.length === 0 ? null : percentile(elapsed, 0.5),
        p95Ns: elapsed.length === 0 ? null : percentile(elapsed, 0.95),
        failures: samples.filter((sample) => sample.failure !== null).length,
        environment: runEnvironment,
    };
}
async function loadWorkloads() {
    const file = await readFile(resolve(ROOT, "benchmarks/phase0/workloads.json"), "utf8");
    return JSON.parse(file);
}
function outputPath(argv) {
    const index = argv.indexOf("--output");
    return index === -1 ? DEFAULT_OUTPUT : resolve(ROOT, argv[index + 1] ?? DEFAULT_OUTPUT);
}
function selectedWorkload(argv) {
    const index = argv.indexOf("--workload");
    return index === -1 ? null : argv[index + 1] ?? null;
}
export async function runBenchmarks(argv = process.argv.slice(2)) {
    const definitions = await loadWorkloads();
    const workloadId = selectedWorkload(argv);
    const runEnvironment = await environment();
    const interception = [];
    const replay = [];
    for (const definition of definitions.workloads) {
        if (workloadId !== null && definition.workloadId !== workloadId)
            continue;
        if (definition.kind === "interception_latency")
            interception.push(await runInterceptionWorkload(definition, runEnvironment));
        if (definition.kind === "replay")
            replay.push(await runReplayWorkload(definition, runEnvironment));
    }
    const report = {
        schemaVersion: 1,
        definitionVersion: definitions.definitionVersion,
        generatedAt: new Date().toISOString(),
        environment: runEnvironment,
        interception,
        replay,
    };
    const destination = outputPath(argv);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
}
if (process.argv[1] !== undefined && process.argv[1].endsWith("benchmark.ts")) {
    await runBenchmarks();
}
//# sourceMappingURL=benchmark.js.map