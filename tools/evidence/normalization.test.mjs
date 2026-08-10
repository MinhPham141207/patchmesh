import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeHookPayload } from "./lib/normalize.mjs";

test("normalizes a completed tool with explicit effects", () => {
  const event = normalizeHookPayload({
    action: "tool.completed",
    sourceEventId: "hook-1",
    agentId: "agent-a",
    taskId: "task-a",
    worktreeId: "worktree-a",
    toolCallId: "tool-a",
    paths: ["D:\\repo\\src\\api.ts"],
    result: { status: "succeeded", durationMs: 12, exitCode: 0, output: "ok" },
    derivedEffect: { status: "verified", changedPaths: ["src/api.ts"], confidence: 1, gaps: [] },
  }, { runId: "run-a", repositoryRoot: "D:\\repo", now: "2026-08-10T00:00:00.000Z" });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.action, "tool.completed");
  assert.deepEqual(event.paths, ["src/api.ts"]);
  assert.equal(event.result.output, undefined);
  assert.equal(event.result.outputDigest.startsWith("sha256:"), true);
  assert.equal(event.derivedEffect.status, "verified");
});

test("redacts secret keys and bounds output", () => {
  const event = normalizeHookPayload({
    action: "tool.completed",
    result: { status: "succeeded", output: "token=super-secret".repeat(100) },
  }, { runId: "run-a", repositoryRoot: null, now: "2026-08-10T00:00:00.000Z" });

  assert.equal(JSON.stringify(event).includes("super-secret"), false);
  assert.equal(JSON.stringify(event).includes("token="), false);
  assert.equal(event.result.outputDigest.startsWith("sha256:"), true);
});

test("counts nested secret redaction in structured output", () => {
  const event = normalizeHookPayload({
    action: "tool.completed",
    result: { status: "succeeded", output: { apiKey: "super-secret" } },
  }, { runId: "run-a", repositoryRoot: null, now: "2026-08-10T00:00:00.000Z" });

  assert.equal(event.result.redactionCount, 1);
});
