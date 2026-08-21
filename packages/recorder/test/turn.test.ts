import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEvent, type ProtocolEvent } from "@patchmesh/protocol";
import { SqliteEventStore } from "@patchmesh/storage";
import { ingestJournal, isTurnMarker, resolveAttribution, taskIdForTurn } from "../src/index.js";
import { JOURNAL_VERSION } from "../src/journal.js";

const SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";
const OTHER_SESSION = "9c2d4e6a-1b3f-4d78-8e05-2a7c1f9b3d64";

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-turn-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function line(payload: Record<string, unknown>, at: string): string {
  return JSON.stringify({ v: JOURNAL_VERSION, at, payload });
}

function turnMarker(sessionId = SESSION, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: sessionId, hook_event_name: "UserPromptSubmit", ...extra };
}

function toolCall(sessionId = SESSION, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    tool_response: {},
    ...extra,
  };
}

/** Ingest a journal built from the given lines and return every recorded event, oldest first. */
function ingestLines(lines: string[]): ProtocolEvent[] {
  const root = temporaryWorktree();
  try {
    const journalPath = join(root, ".patchmesh", "journal.ndjson");
    mkdirSync(join(root, ".patchmesh"), { recursive: true });
    writeFileSync(journalPath, `${lines.join("\n")}\n`, "utf8");
    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    const result = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    assert.equal(result.skipped, 0, "no entry should be unrepresentable");
    const store = SqliteEventStore.open(ledgerPath);
    try {
      return store.read().map((event) => {
        // Validate on the way out: a turn task that the protocol rejects is worse than none.
        const parsed = parseEvent(event);
        assert.deepEqual(parsed.diagnostics, [], "every recorded event must pass validation");
        assert.notEqual(parsed.value, null);
        return parsed.value as ProtocolEvent;
      });
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a turn marker is state, not a recorded call", () => {
  assert.equal(isTurnMarker(turnMarker()), true);
  assert.equal(isTurnMarker(toolCall()), false);

  const events = ingestLines([
    line(turnMarker(), "2026-08-21T10:00:00.000Z"),
    line(toolCall(), "2026-08-21T10:00:01.000Z"),
  ]);
  // One call, so one request and one completion. The marker itself records nothing.
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.eventType.startsWith("tool.")));
});

test("calls after a marker carry that turn's task, and calls before it carry none", () => {
  const events = ingestLines([
    line(toolCall(), "2026-08-21T10:00:00.000Z"),
    line(turnMarker(), "2026-08-21T10:00:01.000Z"),
    line(toolCall(), "2026-08-21T10:00:02.000Z"),
    line(toolCall(), "2026-08-21T10:00:03.000Z"),
  ]);

  const tasks = events.filter((event) => event.eventType === "tool.requested").map((event) => event.taskId);
  assert.equal(tasks.length, 3);
  // A session already running when this build arrived has no marker yet; that is honest.
  assert.equal(tasks[0], null);
  assert.notEqual(tasks[1], null);
  // Every call in one turn shares one task - that is what makes it a unit of work.
  assert.equal(tasks[1], tasks[2]);
});

test("a second marker opens a new task", () => {
  const events = ingestLines([
    line(turnMarker(), "2026-08-21T10:00:00.000Z"),
    line(toolCall(), "2026-08-21T10:00:01.000Z"),
    line(turnMarker(), "2026-08-21T10:00:02.000Z"),
    line(toolCall(), "2026-08-21T10:00:03.000Z"),
  ]);
  const tasks = events.filter((event) => event.eventType === "tool.requested").map((event) => event.taskId);
  assert.notEqual(tasks[0], tasks[1]);
});

test("one session's turn never claims another session's calls", () => {
  const events = ingestLines([
    line(turnMarker(SESSION), "2026-08-21T10:00:00.000Z"),
    line(toolCall(OTHER_SESSION), "2026-08-21T10:00:01.000Z"),
    line(toolCall(SESSION), "2026-08-21T10:00:02.000Z"),
  ]);
  const requested = events.filter((event) => event.eventType === "tool.requested");
  const byAgent = new Map(requested.map((event) => [event.agentId, event.taskId]));
  // Two sessions recording into one repository interleave in the journal.
  assert.equal(byAgent.size, 2);
  const other = [...byAgent.entries()].find(([agentId]) => agentId?.includes("9c2d4e6a"));
  assert.equal(other?.[1], null, "a session with no marker of its own has no task");
});

test("a delegated task wins over the turn task", () => {
  // A subagent's calls are the more specific claim: losing the delegate id would collapse
  // the subagent back into its parent, which is the whole point of attribution.
  const withDelegate = resolveAttribution({
    sessionId: SESSION,
    hostToolName: "Read",
    agentId: "a79bd1f2dafad824a",
    spawnedAgentId: null,
    turnTaskId: taskIdForTurn(SESSION, null, "2026-08-21T10:00:00.000Z"),
  });
  assert.equal(withDelegate.taskId, "task_a79bd1f2dafad824a");
});

test("the host's prompt id names the turn when it declares one", () => {
  assert.equal(taskIdForTurn(SESSION, "prompt-42", "2026-08-21T10:00:00.000Z"), "task_prompt-42");
});

test("a turn task is stable for one turn and distinct across turns", () => {
  const first = taskIdForTurn(SESSION, null, "2026-08-21T10:00:00.000Z");
  const again = taskIdForTurn(SESSION, null, "2026-08-21T10:00:00.000Z");
  const later = taskIdForTurn(SESSION, null, "2026-08-21T10:00:05.000Z");
  assert.equal(first, again);
  assert.notEqual(first, later);
  assert.match(String(first), /^task_[a-z0-9][a-z0-9._-]{0,63}$/u);
});
