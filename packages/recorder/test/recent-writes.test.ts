import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { appendJournalEntry, JOURNAL_FILENAME } from "../src/journal.js";
import {
  advanceWatermark,
  readRecentWrites,
  readWatermark,
  RECENT_WRITE_MINUTES,
  watermarkPathFor,
} from "../src/recent-writes.js";

function root() {
  const dir = mkdirSync(join(tmpdir(), `pw-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true });
  mkdirSync(join(dir, ".git"));
  return dir;
}

function entry(dir: string, payload: object, at: string) {
  appendJournalEntry(join(dir, ".patchmesh", JOURNAL_FILENAME), payload, at);
}

const postWrite = (session: string, path: string) => ({
  hook_event_name: "PostToolUse", session_id: session,
  tool_name: "Edit", tool_use_id: `t-${Math.random()}`, tool_input: { file_path: path }, tool_response: {},
});

test("returns other sessions' completed writes inside the window", () => {
  const dir = root();
  entry(dir, postWrite("sess-a", "src/auth.ts"), "2026-08-25T12:00:00.000Z");
  const writes = readRecentWrites({
    worktreeRoot: dir, excludeSessionId: "sess-b",
    now: () => new Date("2026-08-25T12:20:00.000Z"),
  });
  assert.deepEqual(writes.map((w) => w.path), ["src/auth.ts"]);
});

test("own writes and entries older than the window are excluded", () => {
  const dir = root();
  entry(dir, postWrite("sess-a", "mine.ts"), "2026-08-25T12:00:00.000Z");
  entry(dir, postWrite("sess-a", "old.ts"), "2026-08-25T11:00:00.000Z");
  const writes = readRecentWrites({
    worktreeRoot: dir, excludeSessionId: "sess-a",
    now: () => new Date("2026-08-25T12:20:00.000Z"),
  });
  assert.deepEqual(writes, []);
});

test("a missing journal answers empty, never throws", () => {
  const dir = root();
  const writes = readRecentWrites({ worktreeRoot: dir, now: () => new Date("2026-08-25T12:00:00.000Z") });
  assert.deepEqual(writes, []);
});

test("first contact arms the watermark without delivering history", () => {
  const dir = root();
  entry(dir, postWrite("sess-a", "src/auth.ts"), "2026-08-25T11:59:00.000Z");
  const path = watermarkPathFor(dir, ".patchmesh", "sess-b");
  const watermark = readWatermark(path, "2026-08-25T12:00:00.000Z");
  assert.equal(watermark, "2026-08-25T12:00:00.000Z"); // armed at now
  const unreported = readRecentWrites({
    worktreeRoot: dir, excludeSessionId: "sess-b", sinceIso: watermark,
    now: () => new Date("2026-08-25T12:00:30.000Z"),
  }).filter((w) => w.at > watermark);
  assert.deepEqual(unreported, []); // history not dumped
});

test("advanceWatermark persists and readWatermark returns it", () => {
  const dir = root();
  const path = watermarkPathFor(dir, ".patchmesh", "sess-b");
  readWatermark(path, "2026-08-25T12:00:00.000Z");
  advanceWatermark(path, "2026-08-25T12:05:00.000Z");
  assert.equal(readWatermark(path, "2026-08-25T13:00:00.000Z"), "2026-08-25T12:05:00.000Z");
});

test("a corrupt cursor recovers instead of throwing", () => {
  const dir = root();
  const path = watermarkPathFor(dir, ".patchmesh", "sess-b");
  readWatermark(path, "2026-08-25T11:00:00.000Z"); // create the cursor so the directory exists
  writeFileSync(path, "{not json", "utf8");
  assert.equal(readWatermark(path, "2026-08-25T12:00:00.000Z"), "2026-08-25T12:00:00.000Z");
});
