import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, readInFlightCalls } from "../src/index.js";
import { SqliteEventStore } from "patchmesh-storage";

const SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const NOW = () => new Date("2026-08-22T12:00:30.000Z");

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-inflight-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function entry(root: string, payload: Record<string, unknown>, at: string): void {
  appendJournalEntry(journalPathFor(root, ".patchmesh"), { session_id: SESSION, ...payload }, at);
}

test("a start with no completion is running; one with a completion is not", () => {
  const root = worktree();
  try {
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_done", tool_name: "Read", tool_input: { file_path: "a.ts" } }, "2026-08-22T12:00:00.000Z");
    entry(root, { hook_event_name: "PostToolUse", tool_use_id: "call_done", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: {} }, "2026-08-22T12:00:05.000Z");
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_running", tool_name: "Bash", tool_input: { command: "pnpm check" } }, "2026-08-22T12:00:10.000Z");

    const live = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(live.length, 1);
    assert.equal(live[0]!.hostToolName, "Bash");
    assert.equal(live[0]!.operation, "pnpm check");
    // The host's own tool_use_id pairs them; nothing is inferred from ordering or timing.
    assert.equal(live[0]!.runningForMs, 20_000);
    assert.ok(live[0]!.agentId?.startsWith("agent_"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call abandoned by a crashed session stops being reported as running", () => {
  const root = worktree();
  try {
    // Reporting these forever would turn the in-flight view into a graveyard.
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_lost", tool_name: "Bash", tool_input: { command: "sleep forever" } }, "2026-08-22T11:00:00.000Z");
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_fresh", tool_name: "Bash", tool_input: { command: "recent" } }, "2026-08-22T12:00:00.000Z");

    const live = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.deepEqual(live.map((call) => call.operation), ["recent"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a caller can exclude itself so it does not see its own work as a collision", () => {
  const root = worktree();
  try {
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_mine", tool_name: "Bash", tool_input: { command: "mine" } }, "2026-08-22T12:00:00.000Z");
    const all = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.equal(all.length, 1);
    const others = readInFlightCalls({ worktreeRoot: root, now: NOW, excludeAgentId: all[0]!.agentId ?? undefined });
    assert.equal(others.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("starts are not ingested, so a call is recorded once and not twice", () => {
  const root = worktree();
  try {
    const journalPath = journalPathFor(root, ".patchmesh");
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_1", tool_name: "Read", tool_input: { file_path: "a.ts" } }, "2026-08-22T12:00:00.000Z");
    entry(root, { hook_event_name: "PostToolUse", tool_use_id: "call_1", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: {} }, "2026-08-22T12:00:05.000Z");

    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    const result = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath, now: NOW });
    assert.equal(result.ingested, 1, "one call, ingested once");
    assert.equal(result.skipped, 0, "a start is skipped deliberately, not as a failure");

    const store = SqliteEventStore.open(ledgerPath);
    try {
      assert.equal(store.read().filter((event) => event.eventType === "tool.requested").length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no journal at all is an empty answer, not a failure", () => {
  const root = worktree();
  try {
    assert.deepEqual(readInFlightCalls({ worktreeRoot: root, now: NOW }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call still running survives another session draining the journal", () => {
  // The case a collision guard exists for: one agent's Stop must not erase the in-flight work
  // a second agent needs to see.
  const root = worktree();
  try {
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_running", tool_name: "Bash", tool_input: { command: "long build" } }, "2026-08-22T12:00:00.000Z");
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_done", tool_name: "Read", tool_input: { file_path: "a.ts" } }, "2026-08-22T12:00:01.000Z");
    entry(root, { hook_event_name: "PostToolUse", tool_use_id: "call_done", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: {} }, "2026-08-22T12:00:02.000Z");

    ingestJournal({
      worktreeRoot: root,
      journalPath: journalPathFor(root, ".patchmesh"),
      ledgerPath: join(root, ".patchmesh", "ledger.db"),
      now: NOW,
    });

    const live = readInFlightCalls({ worktreeRoot: root, now: NOW });
    assert.deepEqual(live.map((call) => call.operation), ["long build"], "the unfinished call is carried forward");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a finished call is not carried forward, so it is recorded once", () => {
  const root = worktree();
  try {
    const journalPath = journalPathFor(root, ".patchmesh");
    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    entry(root, { hook_event_name: "PreToolUse", tool_use_id: "call_1", tool_name: "Read", tool_input: { file_path: "a.ts" } }, "2026-08-22T12:00:00.000Z");
    entry(root, { hook_event_name: "PostToolUse", tool_use_id: "call_1", tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: {} }, "2026-08-22T12:00:01.000Z");
    ingestJournal({ worktreeRoot: root, journalPath, ledgerPath, now: NOW });
    // A second drain must find nothing left over from the first.
    const second = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath, now: NOW });
    assert.equal(second.ingested, 0);
    assert.deepEqual(readInFlightCalls({ worktreeRoot: root, now: NOW }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
