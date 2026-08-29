import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, LEDGER_DIRECTORY, ledgerPathFor } from "patchmesh-recorder";
import { diagnose } from "../src/doctor.js";

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-doctor-attr-"));
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  return root;
}

function makeJournalEntry(overrides: { taskId?: string | null } = {}): Record<string, unknown> {
  return {
    session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
    cwd: "/tmp/test",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/test/a.ts" },
    tool_response: {},
    task_id: overrides.taskId ?? undefined,
  };
}

test("doctor reports attribution rate when ledger exists", () => {
  const root = temporaryRepository();
  try {
    const journalPath = journalPathFor(root, LEDGER_DIRECTORY);
    mkdirSync(join(root, LEDGER_DIRECTORY), { recursive: true });

    appendJournalEntry(journalPath, makeJournalEntry({ taskId: "task_a" }), new Date().toISOString());
    appendJournalEntry(journalPath, makeJournalEntry({ taskId: "task_a" }), new Date().toISOString());
    appendJournalEntry(journalPath, makeJournalEntry({ taskId: null }), new Date().toISOString());

    ingestJournal({
      worktreeRoot: root,
      journalPath,
      ledgerPath: ledgerPathFor(root),
    });

    const report = diagnose({ worktreeRoot: root });
    const attrCheck = report.checks.find((c) => c.name === "attribution");
    assert.ok(attrCheck, "attribution check should exist");
    assert.match(attrCheck.detail, /\d+%/);
    assert.match(attrCheck.detail, /events carry a task/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor attribution check degrades gracefully with no ledger", () => {
  const root = temporaryRepository();
  try {
    const report = diagnose({ worktreeRoot: root });
    const attrCheck = report.checks.find((c) => c.name === "attribution");
    assert.ok(attrCheck, "attribution check should exist even without ledger");
    assert.equal(attrCheck.status, "warn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
