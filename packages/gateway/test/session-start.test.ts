import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, recordTurnEffects } from "patchmesh-recorder";
import { asAdditionalContext, withinBudget } from "../src/session-start-bin.js";

const SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const BINARY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "session-start-bin.js");

/** Run the hook exactly as the host would: JSON on stdin, JSON on stdout, exit code observed. */
function runHook(payload: unknown): { readonly stdout: string; readonly status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BINARY], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { stdout: failure.stdout ?? "", status: failure.status ?? 1 };
  }
}

async function recordedRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-session-start-"));
  mkdirSync(join(root, ".git"));
  const journalPath = journalPathFor(root, ".patchmesh");
  const ledgerPath = join(root, ".patchmesh", "ledger.db");
  const snapshotPath = join(root, ".patchmesh", "snapshot.json");

  writeFileSync(join(root, "seed.ts"), "seed\n", "utf8");
  await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: null });

  const at = new Date(Date.now() - 60_000).toISOString();
  appendJournalEntry(journalPath, { session_id: SESSION, hook_event_name: "UserPromptSubmit" }, at);
  appendJournalEntry(journalPath, { session_id: SESSION, tool_name: "Edit", tool_input: { file_path: "src/auth.ts" }, tool_response: {} }, at);
  const drained = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
  writeFileSync(join(root, "src-auth.ts"), "changed\n", "utf8");
  await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: drained.closedTurn });
  return root;
}

const OTHER_SESSION = "2478f630-4707-4f79-a9b9-448c934ddadb";

/**
 * A repository where two workers were genuinely in flight over one file.
 *
 * Timestamps are relative to now because the contention window is four hours from the moment
 * the hook runs, not a fixture constant. The clock is pinned into `recordTurnEffects` so the
 * observed changes share it with the calls; without that the calls carry these timestamps and
 * the changes carry the wall clock, and "was this worker still active" compares two clocks.
 */
async function contendedRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-session-start-contended-"));
  mkdirSync(join(root, ".git"));
  const journalPath = journalPathFor(root, ".patchmesh");
  const ledgerPath = join(root, ".patchmesh", "ledger.db");
  const snapshotPath = join(root, ".patchmesh", "snapshot.json");
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  writeFileSync(join(root, "shared.ts"), "original\n", "utf8");
  await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: null });

  const turn = async (sessionId: string, at: string, write: () => void): Promise<void> => {
    appendJournalEntry(journalPath, { session_id: sessionId, hook_event_name: "UserPromptSubmit" }, at);
    appendJournalEntry(
      journalPath,
      { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: "shared.ts" }, tool_response: {} },
      at,
    );
    const drained = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    write();
    await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: drained.closedTurn, now: () => at });
  };

  await turn(SESSION, ago(30), () => writeFileSync(join(root, "shared.ts"), "first worker\n", "utf8"));
  await turn(OTHER_SESSION, ago(20), () => writeFileSync(join(root, "shared.ts"), "second worker\n", "utf8"));
  // The first worker had not finished when the second wrote, which is what makes this
  // contention rather than a hand-off.
  await turn(SESSION, ago(10), () => writeFileSync(join(root, "other.ts"), "still going\n", "utf8"));
  return root;
}

test("contention leads the injected context, because it is the part that changes what happens next", async () => {
  const root = await contendedRepository();
  try {
    const result = runHook({ cwd: root, hook_event_name: "SessionStart" });

    assert.equal(result.status, 0);
    const context = (JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }).hookSpecificOutput.additionalContext;

    assert.match(context, /Another worker was recently in flight over these files/u);
    assert.match(context, /shared\.ts/u);
    // The claim carries its evidence, so a reader can check it rather than trust it.
    assert.match(context, /why: .* was still working at/u);
    // Ordering is the point: a warning buried under five paragraphs of history gets skimmed.
    assert.equal(
      context.indexOf("in flight over these files") < context.indexOf("recent task(s)"),
      true,
      "contention must come before the recap",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no contention says nothing about contention at all", async () => {
  const root = await recordedRepository();
  try {
    const result = runHook({ cwd: root, hook_event_name: "SessionStart" });
    const context = (JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }).hookSpecificOutput.additionalContext;

    // "No collisions" in every session is the permanent-`degraded` mistake in a new costume:
    // a line that is always there carries no information by the time it matters.
    assert.equal(context.includes("in flight over these files"), false);
    assert.match(context, /recent task\(s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session start hands back recorded work as additional context", async () => {
  const root = await recordedRepository();
  try {
    const result = runHook({ cwd: root, hook_event_name: "SessionStart", session_id: SESSION });

    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /what previous sessions did here/u);
    assert.match(parsed.hookSpecificOutput.additionalContext, /recent task\(s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the answer is measured, so answers-per-session stops being an assumption", async () => {
  const root = await recordedRepository();
  try {
    runHook({ cwd: root, hook_event_name: "SessionStart" });

    const lines = readFileSync(join(root, ".patchmesh", "answers.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { tool: string; answerBytes: number; items: number });
    const answer = lines.find((line) => line.tool === "session_start_recap");
    assert.ok(answer, "the injected recap is recorded on the same terms as every other answer");
    assert.equal(answer.answerBytes > 0, true);
    assert.equal(answer.items > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository with nothing recorded injects nothing rather than injecting an apology", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-session-start-empty-"));
  mkdirSync(join(root, ".git"));
  try {
    const result = runHook({ cwd: root, hook_event_name: "SessionStart" });

    assert.equal(result.status, 0);
    // "No recent work recorded" in every session is pure cost for no answer.
    assert.equal(result.stdout.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a read-side hook can never fail a session start", () => {
  // Every one of these is a real way a hook gets invoked wrongly, and not one of them may
  // produce a non-zero exit: a hook that can break session start gets uninstalled after one
  // incident. Same contract as the recorder's always-exit-0 design.
  //
  // Only the exit code is asserted. A payload carrying no usable `cwd` falls back to the
  // process working directory, which is deliberate -- a hook invoked without one should still
  // answer for wherever it is standing -- so whether anything is written depends on whether
  // that directory happens to be a recorded repository, and the test run's own cwd is.
  for (const payload of ["", "not json at all", "{\"cwd\":", JSON.stringify({ cwd: 42 })]) {
    assert.equal(runHook(payload).status, 0, `payload ${JSON.stringify(payload)} must fail open`);
  }
});

test("a directory that is not a repository is answered with silence", () => {
  const outside = mkdtempSync(join(tmpdir(), "patchmesh-not-a-repo-"));
  try {
    const result = runHook({ cwd: outside, hook_event_name: "SessionStart" });

    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("injected context is bounded, and says so when it truncates", () => {
  const long = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
  const bounded = withinBudget(long, 200);

  assert.equal(Buffer.byteLength(bounded, "utf8") < 400, true);
  assert.match(bounded, /further line\(s\) withheld/u);
  // Truncating mid-line would hand back half a task with no way to tell that happened.
  assert.equal(bounded.split("\n").some((line) => /^line \d+$/u.test(line)), true);

  const short = asAdditionalContext("nothing much");
  assert.equal(withinBudget(short, 10_000), short, "content within budget is returned untouched");
});
