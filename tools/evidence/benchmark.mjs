import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readTraceEvents } from "./lib/trace-store.mjs";
import { summarizeTrace } from "./lib/summary.mjs";

const execFile = promisify(execFileCallback);

function percentile(samples, probability) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

async function gitCommit() {
  try {
    const result = await execFile("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
    return result.stdout.trim();
  } catch {
    return "unavailable";
  }
}

async function environment() {
  return {
    timestamp: new Date().toISOString(),
    commit: await gitCommit(),
    os: `${platform()} ${release()}`,
    architecture: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    memoryBytes: totalmem(),
    nodeVersion: process.version,
  };
}

export async function loadEvidenceWorkloads(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runEvidenceBenchmark({ fixtureTrace, iterations = 10, warmup = 2, workloadId = "trace_summary" }) {
  const trace = await readTraceEvents(fixtureTrace);
  const traceSizeBytes = (await readFile(fixtureTrace)).byteLength;
  const measure = () => {
    const started = performance.now();
    try {
      const summary = summarizeTrace(trace, null);
      return {
        elapsedMs: performance.now() - started,
        eventCount: summary.eventCount,
        traceSizeBytes,
        redactionCount: summary.redactionCount,
        unknownEffectCount: summary.unknownEffectCount,
        failure: null,
      };
    } catch (error) {
      return {
        elapsedMs: null,
        eventCount: trace.length,
        traceSizeBytes,
        redactionCount: null,
        unknownEffectCount: null,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  };
  for (let index = 0; index < warmup; index += 1) measure();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) samples.push(measure());
  const durations = samples.flatMap((sample) => sample.elapsedMs === null ? [] : [sample.elapsedMs]);
  return {
    schemaVersion: 1,
    definitionVersion: "evidence-v1",
    workloadId,
    kind: "trace_summary",
    generatedAt: new Date().toISOString(),
    warmupRuns: warmup,
    measuredRuns: iterations,
    samples,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    failures: samples.filter((sample) => sample.failure !== null).length,
    eventCount: trace.length,
    environment: await environment(),
  };
}

async function writeReport(destination, report) {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return destination;
}

export async function main(argv = process.argv.slice(2)) {
  const traceIndex = argv.indexOf("--trace");
  const outputIndex = argv.indexOf("--output");
  const all = argv.includes("--all");
  const tracePath = traceIndex === -1 ? null : argv[traceIndex + 1];
  const output = outputIndex === -1 ? null : argv[outputIndex + 1];
  const traces = all
    ? (await readdir(".evidence/trace", { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(".evidence/trace", entry.name))
    : tracePath === undefined || tracePath === null ? [] : [tracePath];
  if (traces.length === 0) throw new Error("at least one trace is required; use --trace <path> or --all");
  const reports = [];
  for (const trace of traces) {
    const report = await runEvidenceBenchmark({ fixtureTrace: trace, workloadId: basename(trace, ".jsonl") });
    reports.push(report);
    if (output !== null) {
      const destination = all ? join(output, `${basename(trace, ".jsonl")}.benchmark.json`) : output;
      await writeReport(resolve(destination), report);
    }
  }
  process.stdout.write(`${JSON.stringify(all ? reports : reports[0], null, 2)}\n`);
  return reports;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
