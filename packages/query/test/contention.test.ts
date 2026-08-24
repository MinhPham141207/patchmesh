import assert from "node:assert/strict";
import { test } from "node:test";
import { contentionAmong, workerKey, type OverlappingTask, type WorkerActivity } from "../src/index.js";

const WT = "wt_test";
const EARLIER = "agent_earlier";
const LATER = "agent_later";

function task(agentId: string | null, at: string, worktreeId: string | null = WT): OverlappingTask {
  return { taskId: `task_${agentId ?? "none"}_${at}`, agentId, at, changeKind: "modified", worktreeId };
}

function activity(entries: readonly (readonly [string, readonly string[]])[]): ReadonlyMap<string, WorkerActivity> {
  return new Map(entries.map(([agentId, at]) => [workerKey(agentId, WT), [...at].sort()] as const));
}

test("a worker still at the keyboard when another writes is contention", () => {
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T10:00:00.000Z"), task(LATER, "2026-08-22T10:30:00.000Z")],
    activity([
      [EARLIER, ["2026-08-22T10:00:00.000Z", "2026-08-22T10:29:00.000Z", "2026-08-22T11:00:00.000Z"]],
      [LATER, ["2026-08-22T10:30:00.000Z"]],
    ]),
  );
  assert.notEqual(found, null);
  // The evidence names the gap the claim rests on, not merely when the session ended.
  assert.equal(found!.earlierWorkerIdleGapMs, 60_000);
  assert.equal(found!.earlierWorkerActiveAt, "2026-08-22T10:29:00.000Z");
});

test("a session that spans the other write but was idle across it is NOT contention", () => {
  // The shape the superseded rule got wrong, and the reason its corpus proved nothing: the
  // earlier worker's session ends at 14:00, well after the 12:00 write, but it was last seen
  // at 10:00 -- two hours before. A session that has not ended is not a worker at the keyboard.
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T09:00:00.000Z"), task(LATER, "2026-08-22T12:00:00.000Z")],
    activity([
      [EARLIER, ["2026-08-22T09:00:00.000Z", "2026-08-22T10:00:00.000Z", "2026-08-22T14:00:00.000Z"]],
      [LATER, ["2026-08-22T12:00:00.000Z"]],
    ]),
  );
  assert.equal(found, null);
});

test("a worker whose last act precedes the other write has finished, however long its session", () => {
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T10:00:00.000Z"), task(LATER, "2026-08-22T10:10:00.000Z")],
    activity([
      // Active right up to the write, but never again after it: a hand-off, not a collision.
      [EARLIER, ["2026-08-22T09:00:00.000Z", "2026-08-22T10:09:00.000Z"]],
      [LATER, ["2026-08-22T10:10:00.000Z"]],
    ]),
  );
  assert.equal(found, null);
});

test("the boundary is exclusive, so one session ending as another begins is sequence", () => {
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T10:00:00.000Z"), task(LATER, "2026-08-22T10:10:00.000Z")],
    activity([
      [EARLIER, ["2026-08-22T10:00:00.000Z", "2026-08-22T10:10:00.000Z"]],
      [LATER, ["2026-08-22T10:10:00.000Z"]],
    ]),
  );
  assert.equal(found, null);
});

test("one worker's own consecutive turns are sequence by construction", () => {
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T10:00:00.000Z"), task(EARLIER, "2026-08-22T10:05:00.000Z")],
    activity([[EARLIER, ["2026-08-22T10:00:00.000Z", "2026-08-22T11:00:00.000Z"]]]),
  );
  assert.equal(found, null);
});

test("an unattributed change cannot play the second party", () => {
  // With no agent and no worktree it could equally be either side, so counting it would invent
  // the participant the finding is about.
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T10:00:00.000Z"), task(null, "2026-08-22T10:30:00.000Z", null)],
    activity([[EARLIER, ["2026-08-22T10:00:00.000Z", "2026-08-22T11:00:00.000Z"]]]),
  );
  assert.equal(found, null);
});

test("a worker with no observed activity contends with nothing", () => {
  const found = contentionAmong(
    [task(EARLIER, "2026-08-22T10:00:00.000Z"), task(LATER, "2026-08-22T10:30:00.000Z")],
    activity([[LATER, ["2026-08-22T10:30:00.000Z"]]]),
  );
  assert.equal(found, null);
});
