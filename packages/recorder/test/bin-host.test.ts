import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateEventSet } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";
import {
  buildHookEvents,
  ingestJournal,
  journalPathFor,
  LEDGER_DIRECTORY,
  ledgerPathFor,
} from "../src/index.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-bin-host-"));
  mkdirSync(join(root, ".git"));
  return root;
}

/**
 * What the installed OpenCode plugin sends: a translation of a `tool.execute.after` call into
 * the Claude hook field names, keeping the host's own lowercase tool name and argument keys
 * (`edit`, `filePath`) - renaming those is the recorder's job, per host, at ingest.
 */
function translatedPayload(cwd: string): Record<string, unknown> {
  return {
    session_id: "ses_translated00000000000000000",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "edit",
    tool_input: { filePath: "src/a.ts" },
    tool_response: {},
  };
}

function nativeEnvelope(status: string): Record<string, unknown> {
  return {
    type: "tool.execute.after",
    tool: "edit",
    sessionID: "ses_native00000000000000000001",
    callID: "call_native000000000000000001",
    status,
    input: { filePath: "src/b.ts" },
    output: "ok",
  };
}

function runBinary(root: string, args: readonly string[], input: unknown): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

function ingestInto(root: string) {
  return ingestJournal({
    worktreeRoot: root,
    journalPath: journalPathFor(root, LEDGER_DIRECTORY),
    ledgerPath: ledgerPathFor(root),
  });
}

function eventsOf(root: string) {
  const store = SqliteEventStore.open(ledgerPathFor(root));
  try {
    return store.read();
  } finally {
    store.close();
  }
}

/** The draining process's own environment must not decide provenance in these tests. */
function withoutHostEnv<T>(run: () => T): T {
  const saved = process.env["PATCHMESH_HOST"];
  delete process.env["PATCHMESH_HOST"];
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env["PATCHMESH_HOST"];
    else process.env["PATCHMESH_HOST"] = saved;
  }
}

test("--host opencode journals a translated payload under source_opencode_hook with the opencode tool table", () => {
  const root = temporaryWorktree();
  try {
    const result = withoutHostEnv(() => runBinary(root, ["--host", "opencode"], translatedPayload(root)));
    assert.equal(result.status, 0);
    assert.equal(existsSync(journalPathFor(root, LEDGER_DIRECTORY)), true);

    const ingest = withoutHostEnv(() => ingestInto(root));
    assert.equal(ingest.ingested, 1);
    const events = eventsOf(root);
    assert.deepEqual(withoutHostEnv(() => validateEventSet(events)), []);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.source.sourceId, "source_opencode_hook");
    }
    // Provenance decides the tool table too: the native lowercase name maps through the
    // OpenCode adapter, and its `filePath` argument resolves to a real resource.
    const requested = events.find((event) => event.eventType === "tool.requested")!;
    assert.equal(requested.payload.toolName, "edit_file");
    assert.notEqual(requested.payload.targetResourceId, null);
    assert.equal(events.find((event) => event.eventType === "tool.completed")!.payload.outcome, "succeeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a native OpenCode envelope journals under source_opencode_hook without --host", () => {
  const root = temporaryWorktree();
  try {
    const result = withoutHostEnv(() => runBinary(root, [], nativeEnvelope("completed")));
    assert.equal(result.status, 0);
    assert.equal(existsSync(journalPathFor(root, LEDGER_DIRECTORY)), true);

    const ingest = withoutHostEnv(() => ingestInto(root));
    assert.equal(ingest.ingested, 1);
    const events = eventsOf(root);
    for (const event of events) {
      assert.equal(event.source.sourceId, "source_opencode_hook");
    }
    const requested = events.find((event) => event.eventType === "tool.requested")!;
    assert.equal(requested.payload.toolName, "edit_file");
    assert.notEqual(requested.payload.targetResourceId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same translated payload without --host still routes claude-code", () => {
  const root = temporaryWorktree();
  try {
    const result = withoutHostEnv(() => runBinary(root, [], translatedPayload(root)));
    assert.equal(result.status, 0);
    withoutHostEnv(() => ingestInto(root));
    const events = eventsOf(root);
    for (const event of events) {
      assert.equal(event.source.sourceId, "source_claude_code_hook");
    }
    // Claude's table has no `edit`: the name stays opaque rather than being guessed.
    const requested = events.find((event) => event.eventType === "tool.requested")!;
    assert.equal(requested.payload.toolName, "other");
    assert.equal(requested.payload.opaque, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown --host records nothing and still exits zero", () => {
  const root = temporaryWorktree();
  try {
    const result = withoutHostEnv(() => runBinary(root, ["--host", "nope"], translatedPayload(root)));
    assert.equal(result.status, 0);
    assert.equal(existsSync(journalPathFor(root, LEDGER_DIRECTORY)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an OpenCode record with status error completes as failed", () => {
  const root = temporaryWorktree();
  try {
    const result = withoutHostEnv(() => runBinary(root, [], nativeEnvelope("error")));
    assert.equal(result.status, 0);
    withoutHostEnv(() => ingestInto(root));
    const completed = eventsOf(root).find((event) => event.eventType === "tool.completed")!;
    assert.equal(completed.payload.outcome, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildHookEvents derives failed from an adapter's explicit error signal alone", () => {
  const root = temporaryWorktree();
  try {
    // No `--host` and no stamp: parsing follows shape (the claude adapter declines, the
    // observed-tier fallback finds OpenCode), and the adapter's error signal must survive.
    const pair = withoutHostEnv(() => buildHookEvents({ payload: nativeEnvelope("error"), worktreeRoot: root }));
    assert.equal(pair.completed.payload.outcome, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
