import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateEventSet } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";
import { main, translateCodexPayload } from "../src/codex-relay.js";

const payload = {
  conversation_id: "conversation-codex-1",
  generation_id: "generation-codex-1",
  tool_name: "apply_patch",
  tool_input: { patch: "*** Begin Patch" },
  tool_response: { exit_code: 0 },
  cwd: "D:/patchmesh",
};

test("Codex relay translates a completed tool payload into the recorder envelope", () => {
  assert.deepEqual(translateCodexPayload(payload, "PostToolUse"), {
    session_id: "conversation-codex-1",
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    tool_input: { patch: "*** Begin Patch" },
    tool_response: { exit_code: 0 },
    cwd: "D:/patchmesh",
    patchmesh_host: "codex",
    generation_id: "generation-codex-1",
  });
});

test("Codex relay rejects unsupported lifecycle and incomplete payloads", () => {
  assert.equal(translateCodexPayload(payload, "SessionStart"), null);
  assert.equal(translateCodexPayload({ conversation_id: "s1" }, "PostToolUse"), null);
  assert.equal(translateCodexPayload("not-an-object", "PostToolUse"), null);
});

test("Codex relay is fail-open and invokes the recorder without forwarding stdout", async () => {
  const calls: Record<string, unknown>[] = [];
  assert.equal(
    await main(["PostToolUse"], async () => JSON.stringify(payload), (translated) => {
      calls.push(translated);
      return 1;
    }),
    0,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.patchmesh_host, "codex");
  assert.equal(await main(["PostToolUse"], async () => "{bad", () => { throw new Error("must not run"); }), 0);
  assert.equal(await main(["SessionStart"], async () => JSON.stringify(payload), () => { throw new Error("must not run"); }), 0);
});

test("built Codex relay reaches the ledger with Codex provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-codex-live-"));
  mkdirSync(join(root, ".git"));
  try {
    const relay = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/codex-relay.js", import.meta.url)), "PostToolUse"], {
      cwd: root,
      input: JSON.stringify({
        conversation_id: "live-codex-session",
        tool_name: "read_file",
        tool_input: { path: "src/index.ts" },
        tool_response: { exit_code: 0 },
        cwd: root,
      }),
      encoding: "utf8",
    });
    assert.equal(relay.status, 0);
    assert.equal(relay.stdout, "");

    const ingest = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/ingest-bin.js", import.meta.url)), root], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(ingest.status, 0);

    const store = SqliteEventStore.open(join(root, ".patchmesh", "ledger.db"));
    try {
      const events = store.read();
      assert.equal(events.length, 2);
      assert.deepEqual(validateEventSet(events), []);
      assert.deepEqual([...new Set(events.map((event) => event.source.sourceId))], ["source_codex_hook"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
