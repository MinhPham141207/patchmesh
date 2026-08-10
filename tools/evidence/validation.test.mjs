import assert from "node:assert/strict";
import { test } from "node:test";
import { validateTraceEvent, validateRunManifest } from "./lib/validate.mjs";

function validEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "trace_event_a",
    runId: "run_a",
    sequence: 1,
    timestamp: "2026-08-10T00:00:00.000Z",
    agentId: "agent_a",
    taskId: "task_a",
    worktreeId: "worktree_a",
    toolCallId: "tool_a",
    parentRunId: null,
    parentTaskId: null,
    action: "tool.completed",
    paths: [],
    resources: [],
    result: {
      status: "succeeded",
      durationMs: 1,
      exitCode: 0,
      errorClass: null,
      outputDigest: null,
    },
    derivedEffect: {
      status: "unknown",
      changedPaths: [],
      resourceChanges: [],
      confidence: 0,
      gaps: ["unavailable"],
    },
    ...overrides,
  };
}

test("accepts a complete trace event", () => {
  assert.deepEqual(validateTraceEvent(validEvent()), []);
});

test("reports invalid event fields deterministically", () => {
  const diagnostics = validateTraceEvent(validEvent({
    sequence: -1,
    timestamp: "not-a-timestamp",
    result: { status: "invalid" },
    derivedEffect: { status: "invalid", confidence: 2 },
  }));

  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.code), [
    "TRACE_SEQUENCE_INVALID",
    "TRACE_TIMESTAMP_INVALID",
    "TRACE_RESULT_STATUS_INVALID",
    "TRACE_EFFECT_STATUS_INVALID",
    "TRACE_CONFIDENCE_INVALID",
  ]);
});

test("validates a complete run manifest", () => {
  assert.deepEqual(validateRunManifest({
    schemaVersion: 1,
    recorderVersion: "0.1.0",
    runId: "run_a",
    parentRunId: null,
    parentTaskId: null,
    agentId: "agent_a",
    taskId: "task_a",
    worktreeId: "worktree_a",
    startedAt: "2026-08-10T00:00:00.000Z",
    endedAt: null,
    status: "running",
    eventCount: 1,
    firstSequence: 1,
    lastSequence: 1,
    traceDigest: "sha256:abc",
    errors: [],
    gaps: [],
  }), []);
});
