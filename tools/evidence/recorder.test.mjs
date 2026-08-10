import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { recordHookPayload } from "./lib/recorder.mjs";

const recordScript = fileURLToPath(new URL("./record.mjs", import.meta.url));

async function withEvidence(run) {
  const root = await mkdtemp(join(tmpdir(), "patchmesh-evidence-recorder-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("records one hook payload with environment attribution", async () => {
  await withEvidence(async (evidenceRoot) => {
    const result = await recordHookPayload({
      payload: { action: "tool.requested", toolCallId: "tool-a", paths: ["src/a.ts"] },
      env: { PATCHMESH_EVIDENCE_ROOT: evidenceRoot, PATCHMESH_RUN_ID: "run-a", PATCHMESH_AGENT_ID: "agent-a" },
      now: "2026-08-10T00:00:00.000Z",
    });

    assert.equal(result.accepted, true);
    const lines = (await readFile(result.tracePath, "utf8")).trim().split("\n");
    assert.equal(JSON.parse(lines[0]).agentId, "agent-a");
  });
});

test("malformed input returns a diagnostic without throwing", async () => {
  await withEvidence(async (evidenceRoot) => {
    const result = await recordHookPayload({
      payload: { result: { status: "not-a-status" } },
      env: { PATCHMESH_EVIDENCE_ROOT: evidenceRoot, PATCHMESH_RUN_ID: "run-a" },
      now: "2026-08-10T00:00:00.000Z",
    });

    assert.equal(result.accepted, false);
    assert.equal(result.diagnostic.code, "TRACE_INPUT_INVALID");
  });
});

test("CLI records a JSON hook payload and exits successfully", async () => {
  await withEvidence(async (evidenceRoot) => {
    const child = spawn(process.execPath, [recordScript], {
      cwd: dirname(recordScript),
      env: {
        ...process.env,
        PATCHMESH_EVIDENCE_ROOT: evidenceRoot,
        PATCHMESH_RUN_ID: "run-cli",
        PATCHMESH_AGENT_ID: "agent-cli",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify({ action: "session.start" }));
    let stdout = "";
    for await (const chunk of child.stdout) stdout += chunk;
    const stderr = [];
    for await (const chunk of child.stderr) stderr.push(chunk);
    const exitCode = await new Promise((resolve) => child.once("close", resolve));

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(JSON.parse(stdout).accepted, true);
  });
});
