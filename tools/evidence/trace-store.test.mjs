import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendTraceEvent } from "./lib/trace-store.mjs";

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

async function withEvidence(run) {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-evidence-store-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("appends events in sequence order and ignores identical delivery", async () => {
  await withEvidence(async (evidenceRoot) => {
    const first = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(1) });
    const duplicate = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(1) });
    const second = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(2) });

    assert.equal(first.accepted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(second.event.sequence, 2);
    assert.equal((await readFile(first.tracePath, "utf8")).trim().split("\n").length, 2);
  });
});

test("rejects an event ID reused with different canonical content", async () => {
  await withEvidence(async (evidenceRoot) => {
    await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(1) });
    const result = await appendTraceEvent({
      evidenceRoot,
      runId: "run-a",
      event: event(1, { action: "tool.failed" }),
    });

    assert.equal(result.accepted, false);
    assert.match(result.diagnostic.message, /event ID conflict/);
  });
});
