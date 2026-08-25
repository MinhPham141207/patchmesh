import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, journalPathFor } from "patchmesh-recorder";
import { findOverlappingWork, renderOverlap } from "patchmesh-query";

const OTHER_SESSION = "9c2d4e6a-1b3f-4d78-8e05-2a7c1f9b3d64";

interface Repo {
  readonly root: string;
  readonly ledgerPath: string;
}

function repository(): Repo {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-overlap-opaque-"));
  mkdirSync(join(root, ".git"));
  return {
    root,
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
  };
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
    assert.match(rendered, /\(2 shell call\(s\) in flight nearby - which files they touch is unknown\.\)/u);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
