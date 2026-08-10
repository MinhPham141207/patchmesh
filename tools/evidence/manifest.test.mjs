import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendTraceEvent } from "./lib/trace-store.mjs";
import { updateRunManifest } from "./lib/manifest.mjs";

async function withEvidence(run) {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-evidence-manifest-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function event(action, result = "succeeded") {
  return {
    schemaVersion: 1,
    eventId: `trace_${action.replaceAll(".", "_")}`,
    runId: "run-a",
    sequence: null,
    timestamp: "2026-08-10T00:00:00.000Z",
    agentId: "agent-a",
    taskId: "task-a",
    worktreeId: "worktree-a",
    toolCallId: null,
    parentRunId: null,
    parentTaskId: null,
    action,
    paths: [],
    resources: [],
    result: { status: result, durationMs: 1, exitCode: result === "succeeded" ? 0 : 1, errorClass: null, outputDigest: null, redactionCount: 0 },
    derivedEffect: { status: "unknown", changedPaths: [], resourceChanges: [], confidence: 0, gaps: ["unavailable"] },
  };
}

test("updates a manifest from the complete trace", async () => {
  await withEvidence(async (evidenceRoot) => {
    await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event("session.start", "started") });
    await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event("session.stop", "succeeded") });

    const manifest = await updateRunManifest({ evidenceRoot, runId: "run-a" });
    assert.equal(manifest.eventCount, 2);
    assert.equal(manifest.firstSequence, 1);
    assert.equal(manifest.lastSequence, 2);
    assert.equal(manifest.status, "succeeded");
    assert.equal(manifest.traceDigest.startsWith("sha256:"), true);
    assert.deepEqual(JSON.parse(await readFile(join(evidenceRoot, "runs", "run-a.manifest.json"), "utf8")), manifest);
  });
});
