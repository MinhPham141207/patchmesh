import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { AgentId, TaskId } from "patchmesh-protocol";
import {
  appendJournalEntry,
  ingestJournal,
  journalPathFor,
  recordTurnEffects,
} from "patchmesh-recorder";
import { findOverlappingWork, renderOverlap } from "patchmesh-query";

const OTHER_SESSION = "9c2d4e6a-1b3f-4d78-8e05-2a7c1f9b3d64";

interface Repo {
  readonly root: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
}

function repository(): Repo {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-overlap-opaque-"));
  mkdirSync(join(root, ".git"));
  return {
    root,
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
    snapshotPath: join(root, ".patchmesh", "snapshot.json"),
  };
}

/**
 * Establish the baseline the first observation of a checkout always is.
 *
 * Without it the first planted write folds into the baseline itself and reads as no change at
 * all - correct behaviour, and why a fixture starts from a known state. Same shape as the
 * gateway overlap tests' helper, which faces the identical fixture problem.
 */
async function baseline(repo: Repo): Promise<void> {
  await recordTurnEffects({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    snapshotPath: repo.snapshotPath,
    turn: null,
  });
}

/** The session id whose derived agent id is `agentId`: `agent_<slug>` minus its prefix. */
function sessionOf(agentId: string): string {
  return agentId.slice("agent_".length);
}

/**
 * Plant one observed file change by a known worker.
 *
 * Writes the file for real and records the turn effects over it, exactly how the gateway
 * tests produce `file.changed` events - so the fixture carries whatever attribution real
 * recordings carry, including a null task.
 */
async function plantFileChanged(
  repo: Repo,
  change: { readonly agentId: string; readonly taskId: TaskId | null; readonly at: string; readonly path: string },
): Promise<void> {
  const absolute = join(repo.root, change.path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${change.agentId} wrote ${change.path} at ${change.at}\n`, "utf8");
  await recordTurnEffects({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    snapshotPath: repo.snapshotPath,
    turn: { agentId: change.agentId as AgentId, taskId: change.taskId },
    now: () => change.at,
  });
}

/**
 * Plant one completed tool call after the write, so that worker was still going later.
 *
 * Contention means the earlier worker was still active when the later one wrote; without an
 * event after the second write the pair reads as sequence. Journalled and ingested like any
 * recorded call; with no turn marker for the session, ingest attributes no task to it.
 */
function plantToolCompleted(
  repo: Repo,
  call: { readonly agentId: string; readonly taskId: TaskId | null; readonly at: string },
): void {
  const journalPath = journalPathFor(repo.root, ".patchmesh");
  appendJournalEntry(
    journalPath,
    {
      session_id: sessionOf(call.agentId),
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "src/shared.ts" },
      tool_response: {},
    },
    call.at,
  );
  ingestJournal({ worktreeRoot: repo.root, journalPath, ledgerPath: repo.ledgerPath });
}

test("opaque in-flight calls are counted, not path-guessed", () => {
  const repo = repository();
  try {
    const journalPath = journalPathFor(repo.root, ".patchmesh");
    // Recent enough to still be live: an unfinished call older than ABANDONED_AFTER_MS is
    // treated as lost rather than running, so the fixture cannot seed fixed timestamps.
    const at = new Date(Date.now() - 5_000).toISOString();

    // One Edit in flight on shared.ts, and two Bash calls in flight whose command text merely
    // mentions paths. Existing helper style: append PreToolUse entries with no PostToolUse.
    appendJournalEntry(
      journalPath,
      {
        session_id: OTHER_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_edit",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
      },
      at,
    );
    appendJournalEntry(
      journalPath,
      {
        session_id: OTHER_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_bash_one",
        tool_name: "Bash",
        tool_input: { command: "sed -i 's/a/b/' src/shared.ts" },
      },
      at,
    );
    appendJournalEntry(
      journalPath,
      {
        session_id: OTHER_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_bash_two",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
      at,
    );

    appendJournalEntry(
      journalPath,
      {
        session_id: OTHER_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_read",
        tool_name: "Read",
        tool_input: { file_path: "src/shared.ts" },
      },
      at,
    );

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath });
    assert.equal(result.live.length, 1, "only the pathed Edit is reported as holding a file");
    assert.equal(result.liveOpaqueCalls, 2, "the Bash calls are counted even though no path is claimed");

    // A Read in flight names its file but cannot write it: not a contention, and not opaque
    // either -- counting it here would read as shell activity whose files are unknown.
    assert.ok(
      result.live.every((item) => item.hostToolName !== "Read"),
      "an in-flight Read is never reported as holding a file",
    );

    const rendered = renderOverlap(result, undefined);
    assert.match(rendered, /\(2 call\(s\) in flight nearby name no file - which files they touch is unknown\.\)/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("two agents with no task still contend on one file", async () => {
  const repo = repository();
  try {
    await baseline(repo);
    const base = Date.parse("2026-08-26T10:00:00Z");
    const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
    // Agent A writes at T+0 and stays active until T+40s (a later tool.completed).
    // Agent B writes the same file at T+20s. Distinct agentIds, both taskId null - the shape
    // an OpenCode session records, which the null-task guard used to hide from contention.
    await plantFileChanged(repo, { agentId: "agent_aaaa", taskId: null, at: at(0), path: "src/shared.ts" });
    plantToolCompleted(repo, { agentId: "agent_aaaa", taskId: null, at: at(40_000) });
    await plantFileChanged(repo, { agentId: "agent_bbbb", taskId: null, at: at(20_000), path: "src/shared.ts" });

    const result = findOverlappingWork({
      worktreeRoot: repo.root,
      ledgerPath: repo.ledgerPath,
      withinMinutes: 30,
      now: () => new Date(base + 60_000),
    });

    assert.equal(result.overlaps.length, 1);
    assert.ok(result.overlaps[0]!.tasks.every((task) => task.taskId === null));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
