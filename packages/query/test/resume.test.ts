import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, recordTurnEffects } from "patchmesh-recorder";
import { measureTimeToResume, renderResumeMetrics } from "../src/index.js";

const SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const NOW = () => new Date("2026-08-21T13:00:00.000Z");

interface Repo {
  readonly root: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
}

function repository(): Repo {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-resume-"));
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

async function runTurn(repo: Repo, at: string, calls: Record<string, unknown>[], write: () => void): Promise<void> {
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
}

const read = (path: string) => ({ tool_name: "Read", tool_input: { file_path: path }, tool_response: {} });

test("time to resume counts the calls made before the first observed change", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "seed.ts"), "seed\n", "utf8");
    await baseline(repo);

    // Three orientation calls, then a turn whose calls precede the first change.
    await runTurn(repo, "2026-08-21T12:00:00.000Z", [read("seed.ts"), read("seed.ts"), read("seed.ts")], () => {});
    await runTurn(repo, "2026-08-21T12:10:00.000Z", [read("seed.ts")], () => {
      writeFileSync(join(repo.root, "one.ts"), "changed\n", "utf8");
    });

    const metrics = measureTimeToResume({ ledgerPath: repo.ledgerPath });
    assert.equal(metrics.agents.length, 1);
    const agent = metrics.agents[0]!;
    // Four calls were made before the change was observed; the change itself is not a call.
    assert.equal(agent.callsBeforeFirstChange, 4);
    assert.equal(metrics.medianCalls, 4);
    assert.equal(metrics.measuredAgents, 1);
    assert.equal(metrics.agentsWithoutChange, 0);

    const rendered = renderResumeMetrics(metrics);
    assert.match(rendered, /Median:\s+4 call\(s\)/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("later changes do not move the resume point, and calls after it are not counted", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "seed.ts"), "seed\n", "utf8");
    await baseline(repo);

    await runTurn(repo, "2026-08-21T12:00:00.000Z", [read("seed.ts"), read("seed.ts")], () => {
      writeFileSync(join(repo.root, "one.ts"), "first\n", "utf8");
    });
    // A second change much later must not overwrite the first resume point.
    await runTurn(repo, "2026-08-21T12:30:00.000Z", [read("seed.ts"), read("seed.ts"), read("seed.ts")], () => {
      writeFileSync(join(repo.root, "two.ts"), "second\n", "utf8");
    });

    const metrics = measureTimeToResume({ ledgerPath: repo.ledgerPath });
    const agent = metrics.agents[0]!;
    assert.equal(agent.callsBeforeFirstChange, 2);
    assert.equal(agent.totalCalls, 5, "every call is still counted in the total");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("an agent that never changed anything is reported apart from the median, not as zero", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, "seed.ts"), "seed\n", "utf8");
    await baseline(repo);
    await runTurn(repo, "2026-08-21T12:00:00.000Z", [read("seed.ts"), read("seed.ts")], () => {});

    const metrics = measureTimeToResume({ ledgerPath: repo.ledgerPath });
    assert.equal(metrics.measuredAgents, 0);
    assert.equal(metrics.agentsWithoutChange, 1);
    // Zero would read as "resumed instantly", which is the opposite of what happened.
    assert.equal(metrics.medianCalls, null);
    assert.equal(metrics.agents[0]!.callsBeforeFirstChange, null);
    assert.match(renderResumeMetrics(metrics), /never changed a file \(2 call\(s\)\)/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("nothing recorded is said plainly rather than reported as a median of nothing", () => {
  const repo = repository();
  try {
    mkdirSync(join(repo.root, ".patchmesh"), { recursive: true });
    // An empty ledger still opens; the command must not invent a number for it.
    appendJournalEntry(journalPathFor(repo.root, ".patchmesh"), { session_id: SESSION, hook_event_name: "SessionStart" }, "2026-08-21T12:00:00.000Z");
    ingestJournal({ worktreeRoot: repo.root, journalPath: journalPathFor(repo.root, ".patchmesh"), ledgerPath: repo.ledgerPath, now: NOW });

    const metrics = measureTimeToResume({ ledgerPath: repo.ledgerPath });
    assert.equal(metrics.medianCalls, null);
    assert.match(renderResumeMetrics(metrics), /no time-to-resume to measure/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
