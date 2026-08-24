import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentIdForSession, appendJournalEntry, ingestJournal, journalPathFor } from "patchmesh-recorder";
import { readActiveWork, renderActiveWork } from "patchmesh-query";

const OWN_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OTHER_SESSION = "9c2d4e6a-1b3f-4d78-8e05-2a7c1f9b3d64";
const NOW = () => new Date("2026-08-21T12:30:00.000Z");

function repository(): { root: string; ledgerPath: string; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-active-"));
  mkdirSync(join(root, ".git"));
  return {
    root,
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
    journalPath: journalPathFor(root, ".patchmesh"),
  };
}

function inFlight(journalPath: string, session: string, tool: string, input: Record<string, unknown>, at: string): void {
  appendJournalEntry(
    journalPath,
    { session_id: session, hook_event_name: "PreToolUse", tool_use_id: `call_${session}_${at}`, tool_name: tool, tool_input: input },
    at,
  );
}

test("a running call is reported, and the answer says silence can be trusted", () => {
  const repo = repository();
  try {
    // A ledger first: "no ledger at all" is its own verdict, and this test is about a working
    // repository in which somebody else happens to be mid-call.
    inFlight(repo.journalPath, OTHER_SESSION, "Edit", { file_path: "src/seed.ts" }, "2026-08-21T12:20:00.000Z");
    // Completed, so the seed does not itself count as a call still in flight.
    appendJournalEntry(
      repo.journalPath,
      {
        session_id: OTHER_SESSION,
        hook_event_name: "PostToolUse",
        tool_use_id: `call_${OTHER_SESSION}_2026-08-21T12:20:00.000Z`,
        tool_name: "Edit",
        tool_input: { file_path: "src/seed.ts" },
      },
      "2026-08-21T12:20:01.000Z",
    );
    ingestJournal({ worktreeRoot: repo.root, journalPath: repo.journalPath, ledgerPath: repo.ledgerPath, now: NOW });

    inFlight(repo.journalPath, OTHER_SESSION, "Edit", { file_path: "src/a.ts" }, "2026-08-21T12:29:30.000Z");

    const result = readActiveWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.inFlight.length, 1);
    assert.equal(result.recording.verdict, "recording");

    const rendered = renderActiveWork(result);
    assert.match(rendered, /1 call\(s\) are running right now/u);
    assert.match(rendered, /running 30s/u);
    assert.match(rendered, /Recording: recording/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the caller's own running calls are not reported back to it as company", () => {
  const repo = repository();
  try {
    inFlight(repo.journalPath, OWN_SESSION, "Edit", { file_path: "src/mine.ts" }, "2026-08-21T12:29:30.000Z");
    ingestJournal({ worktreeRoot: repo.root, journalPath: repo.journalPath, ledgerPath: repo.ledgerPath, now: NOW });
    inFlight(repo.journalPath, OWN_SESSION, "Edit", { file_path: "src/mine.ts" }, "2026-08-21T12:29:40.000Z");

    const result = readActiveWork({
      worktreeRoot: repo.root,
      ledgerPath: repo.ledgerPath,
      excludeAgentId: agentIdForSession(OWN_SESSION),
      now: NOW,
    });

    assert.equal(result.inFlight.length, 0);
    assert.match(renderActiveWork(result), /No other worker has a call in flight right now/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a repository with no ledger reports stale, so its emptiness is not read as a clean bill of health", () => {
  const repo = repository();
  try {
    const result = readActiveWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.recording.verdict, "stale");
    assert.match(renderActiveWork(result), /no ledger/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a journal that has been waiting to drain for half a day reports stale rather than quiet", () => {
  const repo = repository();
  try {
    // Written long ago and never ingested: the session that wrote it has certainly ended, so a
    // backlog this old means the drain is not running rather than that a session is mid-flight.
    inFlight(repo.journalPath, OTHER_SESSION, "Edit", { file_path: "src/a.ts" }, "2026-08-20T20:00:00.000Z");
    ingestJournal({ worktreeRoot: repo.root, journalPath: repo.journalPath, ledgerPath: repo.ledgerPath, now: NOW });
    inFlight(repo.journalPath, OTHER_SESSION, "Edit", { file_path: "src/b.ts" }, "2026-08-20T20:00:00.000Z");

    const stale = new Date("2026-08-20T20:00:00.000Z");
    utimesSync(repo.journalPath, stale, stale);

    const result = readActiveWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW });
    assert.equal(result.recording.verdict, "stale");
    assert.match(result.recording.reason, /drain is not running/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a running call's operation is bounded to one line rather than pasted whole", () => {
  const repo = repository();
  try {
    inFlight(
      repo.journalPath,
      OTHER_SESSION,
      "Bash",
      { command: `node <<'EOF'\n${"x".repeat(400)}\nEOF` },
      "2026-08-21T12:29:30.000Z",
    );

    const rendered = renderActiveWork(
      readActiveWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath, now: NOW }),
    );
    const presenceLine = rendered.split("\n").find((line) => line.startsWith("- "))!;
    assert.ok(presenceLine.length < 200, `presence line was ${presenceLine.length} chars`);
    assert.ok(!presenceLine.includes("x".repeat(200)), "the script body is not pasted into the answer");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
