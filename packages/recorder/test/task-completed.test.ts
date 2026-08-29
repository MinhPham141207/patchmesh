import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { SqliteEventStore } from "patchmesh-storage";
import { main } from "../src/ingest-bin.js";

const execFile = promisify(execFileCallback);

async function git(directory: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: directory, encoding: "utf8" });
  return result.stdout.trim();
}

function setupRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-task-completed-"));
  return directory;
}

function journalLine(payload: object, at = "2026-08-29T12:00:00.000Z"): string {
  return JSON.stringify({ v: 1, at, payload });
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeSnapshot(snapshotPath: string, files: ReadonlyArray<[string, { contentHash: string; gitBlob: string | null; fileKind: string }]>, at: string): void {
  const snapshot = {
    v: 1,
    at,
    repository: { commonDirectory: null, revision: null },
    worktree: { administrativeDirectory: ".patchmesh" },
    files,
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf8");
}

test("task.completed is emitted when a turn closes with file changes", async () => {
  const directory = setupRepo();
  try {
    await git(directory, "init", "-b", "main");
    await git(directory, "config", "user.email", "patchmesh-tests@example.invalid");
    await git(directory, "config", "user.name", "PatchMesh Tests");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "example.txt"), "v1\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "initial");

    const journalDir = join(directory, ".patchmesh");
    mkdirSync(journalDir, { recursive: true });

    // Pre-populate snapshot with old content so recordTurnEffects detects the change
    const snapshotPath = join(journalDir, "snapshot.json");
    writeSnapshot(snapshotPath, [
      ["src/example.txt", { contentHash: sha256hex("v1\n"), gitBlob: null, fileKind: "file" }],
    ], "2026-08-29T00:00:00.000Z");

    const journalPath = join(journalDir, "journal.ndjson");
    const lines = [
      journalLine({
        hook_event_name: "UserPromptSubmit",
        session_id: "sess_test_001",
        prompt_id: "prompt_001",
      }),
      journalLine({
        hook_event_name: "PostToolUse",
        session_id: "sess_test_001",
        tool_name: "Write",
        tool_input: { file_path: join(directory, "src", "example.txt").replace(/\\/g, "/") },
        status: "success",
        duration_ms: 10,
      }, "2026-08-29T12:00:01.000Z"),
    ];
    writeFileSync(journalPath, `${lines.join("\n")}\n`);

    writeFileSync(join(directory, "src", "example.txt"), "v2\n");

    assert.equal(await main([directory]), 0);

    const ledgerPath = join(journalDir, "ledger.db");
    assert.ok(existsSync(ledgerPath), "ledger should exist");
    const store = SqliteEventStore.open(ledgerPath);
    try {
      const events = store.read({ eventTypes: ["task.completed"] });
      assert.equal(events.length, 1, "should have exactly one task.completed event");
      const event = events[0]!;
      assert.equal(event.eventType, "task.completed");
      assert.ok(event.taskId !== null, "task.completed should carry a taskId");
      assert.ok(event.agentId !== null, "task.completed should carry an agentId");
      const payload = event.payload as {
        workProductId: string;
        baseRevision: string;
        targetSnapshotId: string;
        resourceIds: readonly string[];
      };
      assert.ok(payload.workProductId.startsWith("work_"), "workProductId should be branded");
      assert.ok(payload.baseRevision.length > 0, "baseRevision should not be empty");
      assert.ok(payload.targetSnapshotId.startsWith("snapshot_"), "targetSnapshotId should be branded");
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("no task.completed is emitted when no turn marker was seen", async () => {
  const directory = setupRepo();
  try {
    await git(directory, "init", "-b", "main");
    await git(directory, "config", "user.email", "patchmesh-tests@example.invalid");
    await git(directory, "config", "user.name", "PatchMesh Tests");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "example.txt"), "v1\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "initial");

    assert.equal(await main([directory]), 0);

    const ledgerPath = join(directory, ".patchmesh", "ledger.db");
    if (existsSync(ledgerPath)) {
      const store = SqliteEventStore.open(ledgerPath);
      try {
        const events = store.read({ eventTypes: ["task.completed"] });
        assert.equal(events.length, 0, "should have no task.completed events");
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task.completed carries resourceIds from file.changed events in the same turn", async () => {
  const directory = setupRepo();
  try {
    await git(directory, "init", "-b", "main");
    await git(directory, "config", "user.email", "patchmesh-tests@example.invalid");
    await git(directory, "config", "user.name", "PatchMesh Tests");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src", "a.txt"), "v1\n");
    await git(directory, "add", ".");
    await git(directory, "commit", "-m", "initial");

    const journalDir = join(directory, ".patchmesh");
    mkdirSync(journalDir, { recursive: true });

    // Pre-populate snapshot with old content so recordTurnEffects detects the change
    const snapshotPath = join(journalDir, "snapshot.json");
    writeSnapshot(snapshotPath, [
      ["src/a.txt", { contentHash: sha256hex("v1\n"), gitBlob: null, fileKind: "file" }],
    ], "2026-08-29T00:00:00.000Z");

    const journalPath = join(journalDir, "journal.ndjson");
    const lines = [
      journalLine({
        hook_event_name: "UserPromptSubmit",
        session_id: "sess_test_002",
        prompt_id: "prompt_002",
      }),
      journalLine({
        hook_event_name: "PostToolUse",
        session_id: "sess_test_002",
        tool_name: "Write",
        tool_input: { file_path: join(directory, "src", "a.txt").replace(/\\/g, "/") },
        status: "success",
        duration_ms: 10,
      }, "2026-08-29T12:00:01.000Z"),
    ];
    writeFileSync(journalPath, `${lines.join("\n")}\n`);

    writeFileSync(join(directory, "src", "a.txt"), "v2\n");

    assert.equal(await main([directory]), 0);

    const ledgerPath = join(journalDir, "ledger.db");
    const store = SqliteEventStore.open(ledgerPath);
    try {
      const completed = store.read({ eventTypes: ["task.completed"] });
      assert.equal(completed.length, 1);
      const payload = completed[0]!.payload as { resourceIds: readonly string[] };
      assert.ok(Array.isArray(payload.resourceIds), "resourceIds should be an array");
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
