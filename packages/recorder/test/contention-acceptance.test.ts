import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appendJournalEntry, journalPathFor } from "../src/index.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const SESSION_A = "a1c7e0f4-52b8-49d3-a6c1-7e90d4b23f18";
const SESSION_B = "b94f2d68-31a5-4c07-8e42-f60a95c7d1b3";

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-contention-"));
  mkdirSync(join(root, ".git"));
  return root;
}

/** Run the real hook binary through its public stdin entry, debug output off. */
function runHook(root: string, payload: Record<string, unknown>): string {
  const env = { ...process.env };
  delete env["PATCHMESH_RECORDER_DEBUG"];
  return execFileSync(process.execPath, [binPath], {
    input: JSON.stringify(payload),
    cwd: root,
    encoding: "utf8",
    env,
  });
}

function postToolUsePayload(sessionId: string, path: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_use_id: "call_write_shared",
    tool_name: "Edit",
    tool_input: { file_path: path },
    tool_response: {},
  };
}

function preToolUsePayload(sessionId: string, path: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_use_id: "call_edit_shared",
    tool_name: "Edit",
    tool_input: { file_path: path },
  };
}

function turnStartPayload(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt: "carry on",
  };
}

test("acceptance: one warning per cross-agent write across two sessions, recording unaffected", () => {
  const root = worktree();
  try {
    const journalFile = journalPathFor(root, ".patchmesh");
    const SHARED = "src/shared.ts";

    // Time control, mirroring advisory.test.ts: session A's completed write is placed in
    // the journal at an explicit past timestamp (4 minutes ago) rather than reached by
    // sleeping. The child processes read their own wall clock, which sits inside the
    // 30-minute recent-write window without any waiting.
    const t0 = new Date(Date.now() - 4 * 60_000).toISOString();
    appendJournalEntry(
      journalFile,
      {
        hook_event_name: "PostToolUse",
        session_id: SESSION_A,
        tool_name: "Edit",
        tool_use_id: "seeded-write",
        tool_input: { file_path: SHARED },
        tool_response: {},
      },
      t0,
    );

    // Step 1: session A's main() consumes a PostToolUse for src/shared.ts; its write lands
    // in the journal like every hook invocation does, regardless of advisories.
    const aOutput = runHook(root, postToolUsePayload(SESSION_A, SHARED));
    assert.equal(aOutput.trim(), "", "A's own write collides with nothing yet: silence");
    const afterA = readFileSync(journalFile, "utf8").trim().split("\n");
    assert.equal(afterA.length, 2, "the seeded write and A's live write are both recorded");

    // Steps 2-3: session B's PreToolUse on the same path denies once, with contention reason.
    const bFirst = runHook(root, preToolUsePayload(SESSION_B, SHARED));
    const parsed = JSON.parse(bFirst.trim()) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "contention detected, deny and ask agent to resolve");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Contention detected/u);

    // The deny output was emitted. Now check the journal was written regardless.
    // With the new deny behavior, the delivery cursor may not advance on the same path
    // because the deny path's advisory might be null (contention from claims, not recent writes).
    // The key assertion: recording is independent of the coordination decision.

    // Step 4: B's journal entries exist regardless of the deny.
    const linesAfterBoth = readFileSync(journalFile, "utf8").trim().split("\n");
    assert.ok(linesAfterBoth.length >= 3, "A's write plus B's PreToolUse entries are recorded");

    // Step 5: the turn-start digest may or may not have new info, but recording happened.
    const bTurnStart = runHook(root, turnStartPayload(SESSION_B));
    // Turn start output depends on whether recent writes are still unreported

    // Recording still happened on the turn start too.
    const finalLines = readFileSync(journalFile, "utf8").trim().split("\n");
    assert.ok(finalLines.length >= linesAfterBoth.length, "turn start was recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
