import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main as runBenchmarkCommand, runEvidenceBenchmark } from "./benchmark.mjs";

function event() {
  return {
    schemaVersion: 1,
    eventId: "trace_event_1",
    runId: "run-a",
    sequence: 1,
    timestamp: "2026-08-10T00:00:00.000Z",
    agentId: "agent-a",
    taskId: "task-a",
    worktreeId: "worktree-a",
    toolCallId: "tool-a",
    parentRunId: null,
    parentTaskId: null,
    action: "tool.completed",
    paths: [],
    resources: [],
    result: { status: "succeeded", durationMs: 1, exitCode: 0, errorClass: null, outputDigest: null, redactionCount: 0 },
    derivedEffect: { status: "unknown", changedPaths: [], resourceChanges: [], confidence: 0, gaps: ["unavailable"] },
  };
}

test("benchmark report retains raw samples and deterministic percentiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchmesh-evidence-benchmark-"));
  try {
    const fixtureTrace = join(directory, "small.jsonl");
    await writeFile(fixtureTrace, `${JSON.stringify(event())}\n`, "utf8");
    const report = await runEvidenceBenchmark({ fixtureTrace, iterations: 3, warmup: 1 });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.samples.length, 3);
    assert.equal(report.failures, 0);
    assert.equal(report.p50Ms <= report.p95Ms, true);
    assert.equal(report.environment.nodeVersion.startsWith("v"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("benchmark command creates a missing output directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchmesh-evidence-benchmark-output-"));
  try {
    const fixtureTrace = join(directory, "small.jsonl");
    const outputPath = join(directory, "reports", "small.benchmark.json");
    await writeFile(fixtureTrace, `${JSON.stringify(event())}\n`, "utf8");
    await runBenchmarkCommand(["--trace", fixtureTrace, "--output", outputPath]);
    await access(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
