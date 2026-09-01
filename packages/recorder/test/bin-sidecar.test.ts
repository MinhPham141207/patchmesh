import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appendJournalEntry, journalPathFor } from "../src/index.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const OTHER_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-bin-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function seedInFlight(root: string, sessionId: string, toolName: string, toolInput: Record<string, unknown>, at: string): void {
  appendJournalEntry(
    journalPathFor(root, ".patchmesh"),
    {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_use_id: `call_${sessionId}_${at}`,
      tool_name: toolName,
      tool_input: toolInput,
    },
    at,
  );
}

test("PreToolUse denies and writes a sidecar when contention is detected", () => {
  const root = worktree();
  try {
    const recentAt = new Date(Date.now() - 5_000).toISOString();
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, recentAt);

    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_test_pre",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
      }),
      cwd: root,
      encoding: "utf8",
    });

    // Should deny on contention
    const lines = output.trim().split("\n").filter((l) => l !== "");
    assert.ok(lines.length >= 1, "PreToolUse emits output");
    const parsed = JSON.parse(lines[0]!) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Contention detected/u);

    // Sidecar should exist for this tool_use_id
    const sidecarPath = join(root, ".patchmesh", "pending-advisories", "call_test_pre.json");
    const content = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(content.path, "src/shared.ts");
    assert.equal(content.hostToolName, "Edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse reads and deletes the sidecar, emitting additionalContext", () => {
  const root = worktree();
  try {
    // Seed contention + write sidecar via PreToolUse deny
    const recentAt = new Date(Date.now() - 5_000).toISOString();
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, recentAt);
    execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_test_post",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
      }),
      cwd: root,
      encoding: "utf8",
    });

    // Delete the journal entries from OTHER_SESSION so computePostWriteAdvisory
    // won't find a recent write and will fall through to the sidecar path.
    const journalPath = join(root, ".patchmesh", "journal.ndjson");
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    const filtered = lines.filter((line) => {
      try {
        const parsed = JSON.parse(line) as { payload?: { session_id?: string } };
        return parsed.payload?.session_id !== OTHER_SESSION;
      } catch {
        return true;
      }
    });
    writeFileSync(journalPath, filtered.join("\n") + "\n");

    // Now PostToolUse for the same tool_use_id — should use the sidecar
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PostToolUse",
        tool_use_id: "call_test_post",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
        tool_response: {},
      }),
      cwd: root,
      encoding: "utf8",
    });

    // Should emit additionalContext with the sidecar's message
    const outLines = output.trim().split("\n").filter((l) => l !== "");
    assert.ok(outLines.length >= 1, "PostToolUse emits output");
    const parsed = JSON.parse(outLines[0]!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext?: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext ?? "", /has a call in flight/u);

    // Sidecar should be deleted
    const sidecarPath = join(root, ".patchmesh", "pending-advisories", "call_test_post.json");
    assert.throws(() => readFileSync(sidecarPath), /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse without a sidecar still works normally (no additionalContext from sidecar)", () => {
  const root = worktree();
  try {
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PostToolUse",
        tool_use_id: "call_no_sidecar",
        tool_name: "Edit",
        tool_input: { file_path: "src/solo.ts" },
        tool_response: {},
      }),
      cwd: root,
      encoding: "utf8",
    });
    // No contention, no sidecar → output may be empty or just the post-write advisory
    // The key assertion: no crash
    assert.doesNotThrow(() => JSON.parse(output.trim() || "{}"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
