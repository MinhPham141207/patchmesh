import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, journalPathFor, readInFlightCalls } from "patchmesh-recorder";

const OTHER_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";
const OTHER_AGENT = "agent_7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_AGENT = "agent_3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-contention-check-"));
  mkdirSync(join(root, ".patchmesh"));
  mkdirSync(join(root, ".git"));
  return root;
}

const NOW = () => new Date("2026-08-31T12:00:00.000Z");

test("readInFlightCalls returns in-flight calls from other agents", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_other_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    }, "2026-08-31T11:59:50.000Z");

    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(inFlight.length, 1);
    assert.equal(inFlight[0]!.filePath, "src/auth.ts");
    assert.equal(inFlight[0]!.hostToolName, "Edit");
    assert.ok(inFlight[0]!.runningForMs > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls returns empty for a path with no activity", () => {
  const root = tmpDir();
  try {
    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(inFlight.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls excludes own agent's calls when excludeAgentId is set", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OWN_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_own_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/self.ts" },
    }, "2026-08-31T11:59:50.000Z");

    const all = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(all.length, 1, "own call is visible without excludeAgentId");

    const filtered = readInFlightCalls({ worktreeRoot: root, now: NOW, excludeAgentId: OWN_AGENT });
    assert.equal(filtered.length, 0, "own call is excluded with excludeAgentId");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls matches by operation (command) when file_path is absent", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_cmd_1",
      tool_name: "Bash",
      tool_input: { command: "pnpm check" },
    }, "2026-08-31T11:59:50.000Z");

    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(inFlight.length, 1);
    assert.equal(inFlight[0]!.operation, "pnpm check");
    assert.equal(inFlight[0]!.filePath, null, "Bash commands have no filePath");
    assert.equal(inFlight[0]!.hostToolName, "Bash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls excludes abandoned calls after 15 minutes", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_old_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/stale.ts" },
    }, "2026-08-31T11:40:00.000Z");

    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(inFlight.length, 0, "calls older than 15 minutes are abandoned");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls excludes finished calls (PreToolUse + PostToolUse)", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_done_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/done.ts" },
    }, "2026-08-31T11:59:50.000Z");
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PostToolUse",
      tool_use_id: "call_done_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/done.ts" },
    }, "2026-08-31T11:59:55.000Z");

    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(inFlight.length, 0, "finished calls are not in-flight");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls sorts by longest-running first", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_short",
      tool_name: "Edit",
      tool_input: { file_path: "src/short.ts" },
    }, "2026-08-31T11:59:55.000Z");
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_long",
      tool_name: "Edit",
      tool_input: { file_path: "src/long.ts" },
    }, "2026-08-31T11:59:30.000Z");

    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(inFlight.length, 2);
    assert.equal(inFlight[0]!.filePath, "src/long.ts", "longest-running comes first");
    assert.equal(inFlight[1]!.filePath, "src/short.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInFlightCalls filters by path when tool_input has file_path", () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_a",
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    }, "2026-08-31T11:59:50.000Z");
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_b",
      tool_name: "Edit",
      tool_input: { file_path: "src/clean.ts" },
    }, "2026-08-31T11:59:50.000Z");

    const inFlight = readInFlightCalls({ worktreeRoot: root, now: NOW });
    const authCalls = inFlight.filter((c) => c.filePath === "src/auth.ts");
    assert.equal(authCalls.length, 1, "only src/auth.ts matches");
    assert.equal(authCalls[0]!.filePath, "src/auth.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
