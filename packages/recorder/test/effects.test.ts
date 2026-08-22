import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEvent, type ProtocolEvent } from "@patchmesh/protocol";
import { replayEvents, SqliteEventStore } from "@patchmesh/storage";
import { recordTurnEffects } from "../src/index.js";

const TURN = { agentId: "agent_live-session" as const, taskId: "task_turn.live.abc123" as const };

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-effects-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function paths(root: string): { ledgerPath: string; snapshotPath: string } {
  return {
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
    snapshotPath: join(root, ".patchmesh", "snapshot.json"),
  };
}

function readEvents(ledgerPath: string): ProtocolEvent[] {
  const store = SqliteEventStore.open(ledgerPath);
  try {
    return store.read().map((event) => {
      const parsed = parseEvent(event);
      assert.deepEqual(parsed.diagnostics, [], "every observed effect must pass validation");
      return parsed.value as ProtocolEvent;
    });
  } finally {
    store.close();
  }
}

test("the first run establishes a baseline and reports nothing", async () => {
  const root = temporaryWorktree();
  try {
    writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
    const result = await recordTurnEffects({ worktreeRoot: root, ...paths(root), turn: TURN });
    // Without a baseline every tracked file would look created, attributing the whole
    // checkout to one turn - a wrong answer that looks like evidence.
    assert.equal(result.baselineOnly, true);
    assert.equal(result.changed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file written between drains is recorded as a change under the closed turn", async () => {
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });

    // The kind of write the ledger was blind to: no tool argument names this path.
    writeFileSync(join(root, "notes.md"), "written by a shell command\n", "utf8");
    const result = await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });
    assert.equal(result.baselineOnly, false);
    assert.equal(result.changed, 1);

    const changes = readEvents(where.ledgerPath).filter((event) => event.eventType === "file.changed");
    assert.equal(changes.length, 1);
    const change = changes[0]!;
    assert.equal(change.taskId, TURN.taskId);
    assert.equal(change.agentId, TURN.agentId);
    // A watcher's claim about the filesystem, not a gateway's claim about a proxied call.
    assert.equal(change.source.kind, "watcher");
    assert.equal((change as { payload: { resource: { locator: string } } }).payload.resource.locator, "notes.md");
    assert.equal((change as { payload: { changeKind: string } }).payload.changeKind, "created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unattributable window records the change with no task rather than guessing", async () => {
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ...where, turn: null });
    writeFileSync(join(root, "existing.md"), "changed by someone\n", "utf8");
    const result = await recordTurnEffects({ worktreeRoot: root, ...where, turn: null });

    assert.equal(result.changed, 1);
    const change = readEvents(where.ledgerPath).find((event) => event.eventType === "file.changed");
    assert.equal(change?.taskId, null);
    assert.equal(change?.agentId, null);
    assert.equal((change as { payload: { changeKind: string } }).payload.changeKind, "modified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deletion is a change, and an unchanged repository reports none", async () => {
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    writeFileSync(join(root, "doomed.md"), "here for now\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });

    const quiet = await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });
    assert.equal(quiet.changed, 0, "an untouched repository must report nothing");

    rmSync(join(root, "doomed.md"));
    const result = await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });
    assert.equal(result.changed, 1);
    const change = readEvents(where.ledgerPath).find((event) => event.eventType === "file.changed");
    assert.equal((change as { payload: { changeKind: string } }).payload.changeKind, "deleted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch of observed changes replays as a valid event set", async () => {
  // Per-event validation cannot catch this class of bug: sharing one correlation across a
  // batch makes each change a second root of it, which is only invalid as a property of the
  // set. It broke every graph-backed CLI command - status, agents, graph, overlaps - while
  // each individual event still parsed cleanly.
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });

    writeFileSync(join(root, "one.md"), "first\n", "utf8");
    writeFileSync(join(root, "two.md"), "second\n", "utf8");
    writeFileSync(join(root, "three.md"), "third\n", "utf8");
    const result = await recordTurnEffects({ worktreeRoot: root, ...where, turn: TURN });
    assert.equal(result.changed, 3);

    const store = SqliteEventStore.open(where.ledgerPath);
    try {
      // Throws StorageError("replay event-set validation failed") if the set is inconsistent.
      const replayed = replayEvents(store.read());
      assert.equal(replayed.orderedEvents.length, store.read().length);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
