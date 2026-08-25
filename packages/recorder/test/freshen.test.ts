import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteEventStore } from "patchmesh-storage";
import {
  appendJournalEntry,
  freshenLedger,
  journalPathFor,
  LEDGER_DIRECTORY,
  ledgerPathFor,
} from "../src/index.js";

/**
 * A real checkout, because freshening resolves repository identity and observes the filesystem.
 * `git init` rather than a bare `.git` directory: effects ask git which paths are ignored.
 */
function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-freshen-"));
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
  return root;
}

function journalOf(root: string): string {
  return journalPathFor(root, LEDGER_DIRECTORY);
}

function callInto(root: string, filePath: string, at: string): void {
  appendJournalEntry(
    journalOf(root),
    {
      session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: filePath },
      tool_response: {},
    },
    at,
  );
}

function eventCount(root: string): number {
  const path = ledgerPathFor(root);
  if (!existsSync(path)) return 0;
  const store = SqliteEventStore.open(path);
  try {
    return store.read().length;
  } finally {
    store.close();
  }
}

test("a journal with nothing in it costs nothing and reports so", async () => {
  const root = temporaryWorktree();
  try {
    const result = await freshenLedger({ worktreeRoot: root });
    assert.equal(result.outcome, "empty");
    assert.equal(result.pending, 0);
    assert.equal(result.ingested, 0);
    // The read path must not create a ledger just by looking. A repository nobody has worked
    // in still has no database after a report runs against it.
    assert.equal(existsSync(ledgerPathFor(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read drains what the hook journalled, so it answers about now rather than about the last Stop", async () => {
  const root = temporaryWorktree();
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    callInto(root, join(root, "a.ts"), new Date().toISOString());
    assert.equal(eventCount(root), 0, "precondition: the journal has not reached the ledger yet");

    const result = await freshenLedger({ worktreeRoot: root });

    assert.equal(result.outcome, "drained");
    assert.equal(result.pending, 1);
    assert.ok(result.ingested > 0, "the journalled call reached the ledger");
    assert.ok(eventCount(root) > 0);
    // Claimed and drained: nothing is left for a second reader to do.
    assert.equal(existsSync(journalOf(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freshening twice does the work once, and the second read is free", async () => {
  const root = temporaryWorktree();
  try {
    callInto(root, join(root, "a.ts"), new Date().toISOString());
    const first = await freshenLedger({ worktreeRoot: root });
    const after = eventCount(root);

    const second = await freshenLedger({ worktreeRoot: root });

    assert.equal(first.outcome, "drained");
    assert.equal(second.outcome, "empty");
    assert.equal(second.ingested, 0);
    assert.equal(eventCount(root), after, "a second freshen appended nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a backlog past the budget is declined rather than making a report wait for it", async () => {
  const root = temporaryWorktree();
  try {
    const at = new Date().toISOString();
    for (let index = 0; index < 6; index += 1) callInto(root, join(root, `f${index}.ts`), at);

    const result = await freshenLedger({ worktreeRoot: root, maxEntries: 5 });

    assert.equal(result.outcome, "over-budget");
    assert.equal(result.pending, 6);
    assert.equal(result.ingested, 0);
    assert.match(result.reason ?? "", /waiting to be ingested/u);
    // Declined, not consumed. The entries stay for the Stop hook, which has no deadline.
    assert.equal(existsSync(journalOf(root)), true);
    assert.equal(eventCount(root), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a freshen that cannot run costs the caller nothing, because a stale answer beats no answer", async () => {
  const root = temporaryWorktree();
  try {
    callInto(root, join(root, "a.ts"), new Date().toISOString());
    // A directory where the ledger file belongs: opening it throws, and the throw must not
    // escape into the report that asked for a freshen.
    const ledgerPath = ledgerPathFor(root);
    mkdirSync(ledgerPath, { recursive: true });

    const result = await freshenLedger({ worktreeRoot: root, ledgerPath });

    assert.equal(result.outcome, "failed");
    assert.ok(result.reason !== null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a journal of only blank lines is empty, not a drain", async () => {
  const root = temporaryWorktree();
  try {
    mkdirSync(join(root, LEDGER_DIRECTORY), { recursive: true });
    writeFileSync(journalOf(root), "\n\n   \n");

    const result = await freshenLedger({ worktreeRoot: root });

    assert.equal(result.outcome, "empty");
    assert.equal(result.pending, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the snapshot survives being written by two capturers at once", async () => {
  const root = temporaryWorktree();
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    callInto(root, join(root, "a.ts"), new Date().toISOString());
    await freshenLedger({ worktreeRoot: root, observeEffects: true });

    // Two freshens racing is the shape drain-on-read introduces: a report and the Stop hook
    // capturing at the same moment. A torn snapshot does not fail loudly -- it reads as no
    // baseline, which reports every file in the checkout as newly created -- so the only
    // evidence that the write is atomic is that the file still parses afterwards.
    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    callInto(root, join(root, "b.ts"), new Date().toISOString());
    await Promise.all([
      freshenLedger({ worktreeRoot: root, observeEffects: true }),
      freshenLedger({ worktreeRoot: root, observeEffects: true }),
    ]);

    const snapshot: unknown = JSON.parse(readFileSync(join(root, LEDGER_DIRECTORY, "snapshot.json"), "utf8"));
    assert.equal(typeof snapshot, "object");
    assert.ok(Array.isArray((snapshot as { files?: unknown }).files));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walking the filesystem is opt-in, because the walk costs far more than the drain", async () => {
  // Draining is 4-6ms warm; observing effects stats and content-hashes every tracked file and
  // shells out to git, measured at 681-949ms on the PatchMesh repository even when it finds
  // nothing. The MCP tools an agent calls before every edit must not pay that, so the default
  // is off and the CLI and SessionStart hook opt in. See `freshenLedger`.
  const root = temporaryWorktree();
  try {
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    callInto(root, join(root, "a.ts"), new Date().toISOString());

    const drainOnly = await freshenLedger({ worktreeRoot: root });

    assert.equal(drainOnly.outcome, "drained");
    assert.ok(drainOnly.ingested > 0, "calls are always drained");
    assert.equal(drainOnly.changed, 0, "and the filesystem is not walked");
    assert.equal(existsSync(join(root, LEDGER_DIRECTORY, "snapshot.json")), false);

    // Asking for it takes the baseline; there is nothing to compare against yet.
    callInto(root, join(root, "a.ts"), new Date().toISOString());
    await freshenLedger({ worktreeRoot: root, observeEffects: true });
    assert.equal(existsSync(join(root, LEDGER_DIRECTORY, "snapshot.json")), true);

    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    callInto(root, join(root, "b.ts"), new Date().toISOString());
    const withEffects = await freshenLedger({ worktreeRoot: root, observeEffects: true });

    assert.ok(withEffects.changed > 0, "the second walk sees what changed since the first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read with nothing new to record does not walk the filesystem even when asked", async () => {
  // The live journal always holds at least the in-flight call that is doing the asking, so
  // "pending > 0" is not enough of a gate on its own: without also requiring that the drain
  // ingested something, a repeated read would pay the walk forever. No new calls also means no
  // new call windows to bind changes to, so the walk could only produce unattributed
  // observations at full price.
  const root = temporaryWorktree();
  try {
    callInto(root, join(root, "a.ts"), new Date().toISOString());
    await freshenLedger({ worktreeRoot: root, observeEffects: true });

    const again = await freshenLedger({ worktreeRoot: root, observeEffects: true });

    assert.equal(again.ingested, 0);
    assert.equal(again.changed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
