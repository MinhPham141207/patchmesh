import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, recordTurnEffects } from "patchmesh-recorder";
import { findOverlappingWork, renderOverlap } from "patchmesh-query";

const FIRST_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const SECOND_SESSION = "9c2d4e6a-1b3f-4d78-8e05-2a7c1f9b3d64";
const NOW = () => new Date("2026-08-21T12:30:00.000Z");

interface Repo {
  readonly root: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
}

function repository(): Repo {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-overlap-"));
  mkdirSync(join(root, ".git"));
  return {
    root,
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
    snapshotPath: join(root, ".patchmesh", "snapshot.json"),
  };
}

/**
 * A worktree with a working git in it.
 *
 * `repository()` only makes a `.git` directory, which is enough for identity but not for
 * `git check-ignore` - it fails, the filter fails open, and every ignored file is reported as
 * work. That is precisely the production defect being fixed, so the test that covers it cannot
 * use a fixture that reproduces the failure for an unrelated reason.
 */
function initializedRepository(): Repo {
  const repo = repository();
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-q"], { cwd: repo.root, stdio: "ignore" });
  return repo;
}

/**
 * Establish the baseline the first observation of a checkout always is.
 *
 * Without it the first turn's edits are folded into the baseline itself and read as no change
 * at all - correct behaviour, and exactly why a repository has to start from a known state
 * before any turn can be attributed.
 */
async function baseline(repo: Repo): Promise<void> {
  await recordTurnEffects({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    snapshotPath: repo.snapshotPath,
    turn: null,
  });
}

/**
 * Run one turn: a marker, a shell call that names no path, and the observation that follows.
 * `write` performs the edit the shell command stands for, so the change is real rather than
 * asserted.
 */
async function runTurn(repo: Repo, sessionId: string, at: string, write: () => void): Promise<string | null> {
  const journalPath = journalPathFor(repo.root, ".patchmesh");
  appendJournalEntry(journalPath, { session_id: sessionId, hook_event_name: "UserPromptSubmit" }, at);
  appendJournalEntry(
    journalPath,
    { session_id: sessionId, tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ shared.ts" }, tool_response: {} },
    at,
  );
  const drained = ingestJournal({ worktreeRoot: repo.root, journalPath, ledgerPath: repo.ledgerPath });
  write();
  await recordTurnEffects({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    snapshotPath: repo.snapshotPath,
    turn: drained.closedTurn,
    // One clock for the whole fixture. Without this the calls carry the fixture's timestamps
    // and the observed changes carry the wall clock, so "was this worker still active when
    // that one wrote" compared two dates years apart and answered by accident.
    now: () => at,
  });
  return drained.closedTurn?.taskId ?? null;
}

/**
 * Leave a session still working after somebody else has written.
 *
 * Contention means both workers were in flight, so a fixture that runs one session to
 * completion and only then starts another is *sequence* and must not be reported. Every test
 * below that wants a real overlap has to keep the first session making calls past the second
 * session's write, because that is the thing being detected.
 */
async function keepWorking(repo: Repo, sessionId: string, at: string): Promise<void> {
  const journalPath = journalPathFor(repo.root, ".patchmesh");
  appendJournalEntry(journalPath, { session_id: sessionId, hook_event_name: "UserPromptSubmit" }, at);
  appendJournalEntry(
    journalPath,
    { session_id: sessionId, tool_name: "Read", tool_input: { file_path: "shared.ts" }, tool_response: {} },
    at,
  );
  ingestJournal({ worktreeRoot: repo.root, journalPath, ledgerPath: repo.ledgerPath });
}

test("two workers in flight over one file are reported as an overlap", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "shared.ts"), "original\n", "utf8");
    await baseline(repo);
    const first = await runTurn(repo, FIRST_SESSION, "2026-08-21T12:00:00.000Z", () => {
      writeFileSync(join(repo.root, "shared.ts"), "first task edit\n", "utf8");
    });
    const second = await runTurn(repo, SECOND_SESSION, "2026-08-21T12:10:00.000Z", () => {
      writeFileSync(join(repo.root, "shared.ts"), "second task edit\n", "utf8");
    });
    // The first session had not finished when the second wrote, which is what makes this
    // contention rather than one session picking up where another left off.
    await keepWorking(repo, FIRST_SESSION, "2026-08-21T12:15:00.000Z");
    assert.notEqual(first, second);

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.overlaps.length, 1);
    const overlap = result.overlaps[0]!;
    assert.equal(overlap.logicalPath, "shared.ts");
    assert.deepEqual(new Set(overlap.tasks.map((task) => task.taskId)), new Set([first, second]));
    // The evidence for the claim, carried on the finding so a reader can check it.
    assert.equal(overlap.contention.earlierWorkerLastActiveAt > overlap.contention.laterWriteAt, true);

    const rendered = renderOverlap(result, undefined);
    assert.match(rendered, /changed by two workers at once/u);
    // The evidence now names how recently the earlier worker was seen, which is the number
    // the claim rests on rather than merely when its session ended.
    assert.match(rendered, /why: .* was still working when .* \(last seen .* before that write\)/u);
    assert.match(rendered, /the ledger holds paths and hashes, not intent/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("two workers writing one file in sequence is not contention", async () => {
  // The distinction the command could not make until now. It reported every file two workers
  // had touched inside whatever window the caller chose, so the answer was a function of the
  // knob: against this repository's own ledger `--within 30` gave nothing, `--within 120` gave
  // nine, and anything from eight hours out gave twenty and never moved again. Of those twenty,
  // thirteen were workers who had each stopped before the next began.
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "shared.ts"), "original\n", "utf8");
    await baseline(repo);
    await runTurn(repo, FIRST_SESSION, "2026-08-21T12:00:00.000Z", () => {
      writeFileSync(join(repo.root, "shared.ts"), "first task edit\n", "utf8");
    });
    // The first session never acts again: it had finished, and the second built on its work.
    await runTurn(repo, SECOND_SESSION, "2026-08-21T12:10:00.000Z", () => {
      writeFileSync(join(repo.root, "shared.ts"), "second task edit\n", "utf8");
    });

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.overlaps.length, 0, "sequence is not contention");
    // Counted and declared, not silently dropped: a reader who remembers this being reported
    // needs to know it was reclassified rather than lost.
    assert.equal(result.sequential, 1);
    assert.equal(result.filesObserved, 1);
    assert.match(renderOverlap(result, undefined), /in sequence, each finishing before the next began/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("one session's consecutive turns are not an overlap", async () => {
  // This reverses the rule this test asserted when it was written ("two separate requests
  // touching one file is a real overlap"). Live evidence overturned it: run against this
  // repository's own ledger, that rule produced eight findings and all eight were one agent's
  // own consecutive turns. A session runs one task at a time, so it cannot contend with
  // itself - it finished the first turn before it began the second.
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "solo.ts"), "original\n", "utf8");
    await baseline(repo);
    await runTurn(repo, FIRST_SESSION, "2026-08-21T12:00:00.000Z", () => {
      writeFileSync(join(repo.root, "solo.ts"), "one edit\n", "utf8");
    });
    await runTurn(repo, FIRST_SESSION, "2026-08-21T12:05:00.000Z", () => {
      writeFileSync(join(repo.root, "solo.ts"), "another edit by the same session\n", "utf8");
    });

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.overlaps.length, 0, "sequence is not overlap");
    // The change was still seen. Reporting nothing here is a judgement about what the evidence
    // means, not a gap in what was observed.
    assert.equal(result.filesObserved, 1);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a file the repository ignores is not reported as contested work", async () => {
  // The ledger is append-only, so filtering at write time never repairs what is already in it.
  // Every live overlap this tool reported before this existed was a sibling tool's cache.
  // A real repository, not the bare `.git` directory the other tests get: the ignore policy is
  // git's own answer, so there has to be a git here to answer it.
  const repo = initializedRepository();
  try {
    writeFileSync(join(repo.root, ".gitignore"), "cache/\n", "utf8");
    mkdirSync(join(repo.root, "cache"));
    writeFileSync(join(repo.root, "cache", "state.db"), "original\n", "utf8");
    writeFileSync(join(repo.root, "real.ts"), "original\n", "utf8");
    await baseline(repo);
    await runTurn(repo, FIRST_SESSION, "2026-08-21T12:00:00.000Z", () => {
      writeFileSync(join(repo.root, "cache", "state.db"), "churn\n", "utf8");
      writeFileSync(join(repo.root, "real.ts"), "first\n", "utf8");
    });
    await runTurn(repo, SECOND_SESSION, "2026-08-21T12:10:00.000Z", () => {
      writeFileSync(join(repo.root, "cache", "state.db"), "more churn\n", "utf8");
      writeFileSync(join(repo.root, "real.ts"), "second\n", "utf8");
    });
    // Real contention on both files, so the ignore filter is what decides the outcome rather
    // than the contention rule quietly doing it first.
    await keepWorking(repo, FIRST_SESSION, "2026-08-21T12:15:00.000Z");

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.deepEqual(
      result.overlaps.map((overlap) => overlap.logicalPath),
      ["real.ts"],
      "only work product can be contested",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("no observed changes is reported as absent evidence, not as independence", () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "untouched.ts"), "nothing happens\n", "utf8");
    const journalPath = journalPathFor(repo.root, ".patchmesh");
    appendJournalEntry(journalPath, { session_id: FIRST_SESSION, hook_event_name: "UserPromptSubmit" }, "2026-08-21T12:00:00.000Z");
    ingestJournal({ worktreeRoot: repo.root, journalPath, ledgerPath: repo.ledgerPath });

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.filesObserved, 0);
    const rendered = renderOverlap(result, undefined);
    assert.match(rendered, /absence of evidence, not evidence of independence/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a caller can ask only about overlaps its own task is part of", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "shared.ts"), "original\n", "utf8");
    await baseline(repo);
    const first = await runTurn(repo, FIRST_SESSION, "2026-08-21T12:00:00.000Z", () => {
      writeFileSync(join(repo.root, "shared.ts"), "first\n", "utf8");
    });
    await runTurn(repo, SECOND_SESSION, "2026-08-21T12:10:00.000Z", () => {
      writeFileSync(join(repo.root, "shared.ts"), "second\n", "utf8");
    });
    await keepWorking(repo, FIRST_SESSION, "2026-08-21T12:15:00.000Z");

    const mine = findOverlappingWork({
      worktreeRoot: repo.root,
      ledgerPath: repo.ledgerPath,
      taskId: first ?? undefined,
      now: NOW,
    });
    assert.equal(mine.overlaps.length, 1);

    const stranger = findOverlappingWork({
      worktreeRoot: repo.root,
      ledgerPath: repo.ledgerPath,
      taskId: "task_someone-else",
      now: NOW,
    });
    assert.equal(stranger.overlaps.length, 0, "an overlap the caller is not part of is not its business");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a file another worker has open right now is reported, and leads the answer", () => {
  const repo = repository();
  try {
    const journalPath = journalPathFor(repo.root, ".patchmesh");

    // A call that started and has not reported back. Read from the journal, which is the only
    // live source: ingest runs on Stop, so the ledger cannot know about it yet.
    appendJournalEntry(
      journalPath,
      {
        session_id: SECOND_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_open",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
      },
      "2026-08-21T12:29:30.000Z",
    );

    const result = findOverlappingWork({
      worktreeRoot: repo.root,
      ledgerPath: repo.ledgerPath,
      now: NOW,
    });

    assert.equal(result.live.length, 1);
    assert.equal(result.live[0]!.logicalPath, "src/shared.ts");
    assert.equal(result.live[0]!.hostToolName, "Edit");
    assert.equal(result.live[0]!.runningForMs, 30_000);

    const rendered = renderOverlap(result, undefined);
    assert.match(rendered, /^1 file\(s\) are open right now/u, "live leads: it is the only part that can still change an outcome");
    assert.match(rendered, /src\/shared\.ts/u);
    assert.match(rendered, /running 30s/u);
    assert.match(rendered, /A call in flight is not a write/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("an opaque Bash call is not reported as holding a file", () => {
  const repo = repository();
  try {
    appendJournalEntry(
      journalPathFor(repo.root, ".patchmesh"),
      {
        session_id: SECOND_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_bash",
        tool_name: "Bash",
        tool_input: { command: "sed -i 's/a/b/' src/shared.ts" },
      },
      "2026-08-21T12:29:30.000Z",
    );

    const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.live.length, 0, "the path is in the command text, and recovering it is the banned inference");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
