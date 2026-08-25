import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ObservedFileChange } from "patchmesh-observation";
import { parseEvent, validateEventSet, type ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";
import { bindChange, type EffectAttributionCall } from "../src/effects.js";
import { ingestJournal, recordTurnEffects } from "../src/index.js";
import { JOURNAL_VERSION } from "../src/journal.js";

const SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-binding-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".patchmesh"), { recursive: true });
  return root;
}

function paths(root: string): { journalPath: string; ledgerPath: string; snapshotPath: string } {
  return {
    journalPath: join(root, ".patchmesh", "journal.ndjson"),
    ledgerPath: join(root, ".patchmesh", "ledger.db"),
    snapshotPath: join(root, ".patchmesh", "snapshot.json"),
  };
}

function line(payload: Record<string, unknown>, at: string): string {
  return JSON.stringify({ v: JOURNAL_VERSION, at, payload });
}

/** A start/completion pair for one shell call, which is the traffic that carries no path. */
function shellCall(callId: string, startedAt: string, completedAt: string): string[] {
  const base = {
    session_id: SESSION,
    tool_name: "Bash",
    tool_use_id: callId,
    tool_input: { command: "printf hi > touched.md" },
  };
  return [
    line({ ...base, hook_event_name: "PreToolUse" }, startedAt),
    line({ ...base, hook_event_name: "PostToolUse", tool_response: {} }, completedAt),
  ];
}

function readEvents(ledgerPath: string): ProtocolEvent[] {
  const store = SqliteEventStore.open(ledgerPath);
  try {
    return store.read().map((event) => {
      const parsed = parseEvent(event);
      assert.deepEqual(parsed.diagnostics, [], "each recorded event must validate on its own");
      return parsed.value as ProtocolEvent;
    });
  } finally {
    store.close();
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One candidate owner with a window in the far past (epoch ms), which no real mtime lands in. */
function attributionCall(fields: Partial<EffectAttributionCall>): EffectAttributionCall {
  return {
    completionEventId: "evt_binding_candidate",
    correlationId: "corr_binding_candidate",
    agentId: null,
    taskId: null,
    startedAtMs: 0,
    completedAtMs: 100,
    declaredPath: null,
    ...fields,
  };
}

function observedChange(path: string, after: ObservedFileChange["after"]): ObservedFileChange {
  return {
    path,
    before: null,
    after,
    changeKind: after === null ? "deleted" : "created",
    outOfBand: false,
  };
}

test("a change binds to the one call that declared its path even outside every window", () => {
  const root = temporaryWorktree();
  try {
    // A real file, so the fallback rule had something to stat. Its mtime is modern and both
    // windows ended decades ago, so the mtime join alone would return null; the single call
    // that declared the path must win regardless.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "auth.ts"), "declared\n", "utf8");
    const change = observedChange("src/auth.ts", { contentHash: "hash", gitBlob: null, fileKind: "file" });

    const owner = bindChange(root, change, [
      attributionCall({ declaredPath: "src/auth.ts" }),
      attributionCall({}),
    ]);
    assert.equal(owner?.declaredPath, "src/auth.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two calls declaring the same path stay ambiguous and fall back to the mtime rule", () => {
  const root = temporaryWorktree();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "auth.ts"), "contested\n", "utf8");
    const change = observedChange("src/auth.ts", { contentHash: "hash", gitBlob: null, fileKind: "file" });

    const owner = bindChange(root, change, [
      attributionCall({ declaredPath: "src/auth.ts", completedAtMs: 50 }),
      attributionCall({ declaredPath: "src/auth.ts" }),
    ]);
    // Neither window contains the file's real mtime, so the fallback returns null. Picking
    // one declarer would be inference dressed as evidence.
    assert.equal(owner, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted file binds when exactly one call declared its path", () => {
  const root = temporaryWorktree();
  try {
    // Nothing left to stat, so the mtime rule could never answer; the declaration does.
    const change = observedChange("doomed.md", null);
    const owner = bindChange(root, change, [attributionCall({ declaredPath: "doomed.md" })]);
    assert.equal(owner?.declaredPath, "doomed.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Establish a baseline, then write a file inside a recorded call's window and drain.
 *
 * Timestamps are taken from the real clock around the real write, because the join is against
 * the file's own mtime; fixed strings would test arithmetic rather than the mechanism.
 */
async function writeInsideCall(root: string, callId: string): Promise<void> {
  const where = paths(root);
  writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
  await recordTurnEffects({ worktreeRoot: root, ledgerPath: where.ledgerPath, snapshotPath: where.snapshotPath, turn: null });

  const startedAt = new Date().toISOString();
  await wait(5);
  writeFileSync(join(root, "touched.md"), "written by a shell command\n", "utf8");
  await wait(5);
  const completedAt = new Date().toISOString();

  writeFileSync(where.journalPath, `${shellCall(callId, startedAt, completedAt).join("\n")}\n`, "utf8");
}

test("a shell-written file binds to the call whose window contained the write", async () => {
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    await writeInsideCall(root, "toolu_bind_one");

    const drained = ingestJournal({ worktreeRoot: root, journalPath: where.journalPath, ledgerPath: where.ledgerPath });
    assert.equal(drained.calls.length, 1, "the drain must expose the call's window");

    const effects = await recordTurnEffects({
      worktreeRoot: root,
      ledgerPath: where.ledgerPath,
      snapshotPath: where.snapshotPath,
      turn: null,
      calls: drained.calls,
    });
    assert.equal(effects.changed, 1);

    const events = readEvents(where.ledgerPath);
    const changed = events.find((event) => event.eventType === "file.changed");
    const completion = events.find((event) => event.eventType === "tool.completed");
    assert.ok(changed && completion);

    // The point of the whole exercise: a file mutated through the shell, which no tool argument
    // names, is now bound to the call that ran while it changed.
    assert.equal(changed.causationId, completion.eventId);
    assert.equal(changed.correlationId, completion.correlationId);
    assert.equal(changed.taskId, completion.taskId);
    // The basis of the claim travels with the change, so rendering cannot overstate it.
    assert.equal((changed.payload as { attribution?: string }).attribution, "call");

    // The trap this project has hit before: per-event validation cannot see correlation and
    // causation rules, which are properties of the set. Binding introduces exactly those.
    assert.deepEqual(validateEventSet(events), [], "the bound set must replay as valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a change no single call's window contains stays attributed to the turn", async () => {
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ledgerPath: where.ledgerPath, snapshotPath: where.snapshotPath, turn: null });

    // Two calls covering the same instant. A subagent inside its parent's span looks like this,
    // and so do two sessions in one repository; the owner is genuinely unknowable.
    const startedAt = new Date().toISOString();
    await wait(5);
    writeFileSync(join(root, "touched.md"), "written by something\n", "utf8");
    await wait(5);
    const completedAt = new Date().toISOString();
    writeFileSync(
      where.journalPath,
      `${[...shellCall("toolu_outer", startedAt, completedAt), ...shellCall("toolu_inner", startedAt, completedAt)].join("\n")}\n`,
      "utf8",
    );

    const drained = ingestJournal({ worktreeRoot: root, journalPath: where.journalPath, ledgerPath: where.ledgerPath });
    assert.equal(drained.calls.length, 2);

    const effects = await recordTurnEffects({
      worktreeRoot: root,
      ledgerPath: where.ledgerPath,
      snapshotPath: where.snapshotPath,
      turn: null,
      calls: drained.calls,
    });
    assert.equal(effects.changed, 1);

    const events = readEvents(where.ledgerPath);
    const changed = events.find((event) => event.eventType === "file.changed");
    assert.ok(changed);
    // Ambiguity must not be resolved by picking one. Guessing here would be inference dressed
    // as evidence, which is the thing the evidence rules exist to forbid.
    assert.equal(changed.causationId, null);
    assert.equal((changed.payload as { attribution?: string }).attribution, "turn");
    assert.deepEqual(validateEventSet(events), [], "an unbound change must still replay as valid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without call windows the recorder behaves exactly as it did before binding", async () => {
  const root = temporaryWorktree();
  try {
    const where = paths(root);
    await writeInsideCall(root, "toolu_no_windows");
    ingestJournal({ worktreeRoot: root, journalPath: where.journalPath, ledgerPath: where.ledgerPath });

    // `calls` omitted: this is a host with no PreToolUse hook installed.
    const effects = await recordTurnEffects({
      worktreeRoot: root,
      ledgerPath: where.ledgerPath,
      snapshotPath: where.snapshotPath,
      turn: null,
    });
    assert.equal(effects.changed, 1);

    const events = readEvents(where.ledgerPath);
    const changed = events.find((event) => event.eventType === "file.changed");
    assert.ok(changed);
    assert.equal(changed.causationId, null);
    assert.deepEqual(validateEventSet(events), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
