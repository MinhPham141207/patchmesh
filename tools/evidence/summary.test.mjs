import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { summarizeTrace, validateTrace } from "./lib/summary.mjs";

const validateScript = fileURLToPath(new URL("./validate-trace.mjs", import.meta.url));

function event(sequence, overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: `trace_event_${sequence}`,
    runId: "run-a",
    sequence,
    timestamp: "2026-08-10T00:00:00.000Z",
    agentId: "agent-a",
    taskId: "task-a",
    worktreeId: "worktree-a",
    toolCallId: `tool-${sequence}`,
    parentRunId: null,
    parentTaskId: null,
    action: "tool.completed",
    paths: [],
    resources: [],
    result: { status: "succeeded", durationMs: 1, exitCode: 0, errorClass: null, outputDigest: null, redactionCount: 0 },
    derivedEffect: { status: "unknown", changedPaths: [], resourceChanges: [], confidence: 0, gaps: ["unavailable"] },
    ...overrides,
  };
}

function manifestFor(runId = "run-a", overrides = {}) {
  return {
    schemaVersion: 1,
    recorderVersion: "0.1.0",
    runId,
    parentRunId: null,
    parentTaskId: null,
    agentId: "agent-a",
    taskId: "task-a",
    worktreeId: "worktree-a",
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: null,
    status: "running",
    eventCount: 1,
    firstSequence: 1,
    lastSequence: 1,
    traceDigest: null,
    errors: [],
    gaps: [],
    ...overrides,
  };
}

test("summary counts outcomes and explicit effect gaps", () => {
  const summary = summarizeTrace([
    event(1, { action: "tool.requested", result: { status: "started", durationMs: null, exitCode: null, errorClass: null, outputDigest: null, redactionCount: 0 } }),
    event(2),
  ], manifestFor());

  assert.equal(summary.eventCount, 2);
  assert.equal(summary.completedToolCount, 1);
  assert.equal(summary.unknownEffectCount, 2);
  assert.equal(summary.effectCoverage, 0);
  assert.equal(summary.traceDigest.startsWith("sha256:"), true);
});

test("validator rejects sequence gaps and manifest count mismatches", () => {
  const result = validateTrace([event(2)], manifestFor("run-a", { eventCount: 2 }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ["TRACE_SEQUENCE_INVALID", "TRACE_MANIFEST_MISMATCH"]);
});

test("validation CLI emits a machine-readable result on Windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchmesh-evidence-cli-"));
  try {
    const tracePath = join(directory, "trace.jsonl");
    await writeFile(tracePath, `${JSON.stringify(event(1))}\n`, "utf8");
    const child = spawn(process.execPath, [validateScript, tracePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    for await (const chunk of child.stdout) stdout += chunk;
    for await (const chunk of child.stderr) stderr += chunk;
    const exitCode = await new Promise((resolve) => child.once("close", resolve));

    assert.equal(exitCode, 0, `${stderr}${stdout}`);
    assert.equal(JSON.parse(stdout).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
