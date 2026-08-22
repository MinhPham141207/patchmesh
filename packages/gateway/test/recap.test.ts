import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, recordTurnEffects } from "@patchmesh/recorder";
import { recapRecentWork, renderRecap } from "../src/index.js";

const SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const NOW = () => new Date("2026-08-21T13:00:00.000Z");

interface Repo {
  readonly root: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
}

function repository(): Repo {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-recap-"));
  mkdirSync(join(root, ".git"));
  return {
    root,
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
    snapshotPath: join(root, ".patchmesh", "snapshot.json"),
  };
}

async function baseline(repo: Repo): Promise<void> {
  await recordTurnEffects({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, snapshotPath: repo.snapshotPath, turn: null });
}

/** One turn: a marker, some calls, and the observation that closes it. */
async function runTurn(repo: Repo, at: string, calls: Record<string, unknown>[], write: () => void): Promise<string | null> {
  const journalPath = journalPathFor(repo.root, ".patchmesh");
  appendJournalEntry(journalPath, { session_id: SESSION, hook_event_name: "UserPromptSubmit" }, at);
  for (const call of calls) appendJournalEntry(journalPath, { session_id: SESSION, ...call }, at);
  const drained = ingestJournal({ worktreeRoot: repo.root, journalPath, ledgerPath: repo.ledgerPath, now: NOW });
  write();
  await recordTurnEffects({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    snapshotPath: repo.snapshotPath,
    turn: drained.closedTurn,
  });
  return drained.closedTurn?.taskId ?? null;
}

test("a recap summarizes each task by who worked and what changed", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "seed.ts"), "seed\n", "utf8");
    await baseline(repo);

    const first = await runTurn(
      repo,
      "2026-08-21T12:00:00.000Z",
      [
        { tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ one.ts" }, tool_response: {} },
        { tool_name: "Bash", tool_input: { command: "pnpm test" }, tool_response: { exit_code: 1 } },
      ],
      () => {
        writeFileSync(join(repo.root, "one.ts"), "first task\n", "utf8");
        writeFileSync(join(repo.root, "two.ts"), "first task too\n", "utf8");
      },
    );

    const result = recapRecentWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.tasks.length, 1);
    const task = result.tasks[0]!;
    assert.equal(task.taskId, first);
    assert.equal(task.calls, 2);
    // A failed call is the part of a recap a resuming agent most needs.
    assert.equal(task.failed, 1);
    assert.deepEqual(task.changedPaths, ["one.ts", "two.ts"]);

    const rendered = renderRecap(result, undefined);
    assert.match(rendered, /1 recent task\(s\)/u);
    assert.match(rendered, /2 call\(s\), 1 failed/u);
    assert.match(rendered, /changed: one\.ts, two\.ts/u);
    assert.match(rendered, /not what it means/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("tasks are listed newest first and the count is bounded", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "seed.ts"), "seed\n", "utf8");
    await baseline(repo);
    for (const [index, at] of ["12:00", "12:10", "12:20"].entries()) {
      await runTurn(repo, `2026-08-21T${at}:00.000Z`, [{ tool_name: "Read", tool_input: { file_path: "seed.ts" }, tool_response: {} }], () => {
        writeFileSync(join(repo.root, `file${index}.ts`), `turn ${index}\n`, "utf8");
      });
    }

    const all = recapRecentWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(all.tasks.length, 3);
    assert.ok(all.tasks[0]!.endedAt > all.tasks[2]!.endedAt, "newest first");

    const bounded = recapRecentWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, limit: 2, now: NOW });
    assert.equal(bounded.tasks.length, 2);
    // A summary that hides how much it withheld is not a summary, it is a claim.
    assert.equal(bounded.truncated, 1);
    assert.match(renderRecap(bounded, undefined), /1 older task\(s\) not shown/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("work with no task is counted and declared, never folded into someone else's", async () => {
  const repo = repository();
  try {
    const journalPath = journalPathFor(repo.root, ".patchmesh");
    // No UserPromptSubmit marker, so these calls belong to no turn.
    appendJournalEntry(journalPath, { session_id: SESSION, tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: {} }, "2026-08-21T12:00:00.000Z");
    ingestJournal({ worktreeRoot: repo.root, journalPath, ledgerPath: repo.ledgerPath, now: NOW });

    const result = recapRecentWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.tasks.length, 0);
    assert.equal(result.unattributedCalls, 1);
    assert.match(renderRecap(result, undefined), /belong to no task/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
