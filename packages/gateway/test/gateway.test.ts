import assert from "node:assert/strict";
import { commitsWithin, readCommitsSince } from "patchmesh-query";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, ingestJournal, journalPathFor, recordTurnEffects } from "patchmesh-recorder";
import { recallRecentActivity, renderRecall, renderRecap } from "../src/index.js";

const SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const DELEGATE = "a79bd1f2dafad824a";

interface Fixture {
  readonly root: string;
  readonly ledgerPath: string;
}

/** A repository whose ledger holds a parent read, a subagent edit, and the spawn between them. */
function recordedRepository(at = "2026-08-21T12:00:00.000Z"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-gateway-"));
  mkdirSync(join(root, ".git"));
  const journalPath = journalPathFor(root, ".patchmesh");
  const calls: Record<string, unknown>[] = [
    { tool_name: "Read", tool_input: { file_path: "src/server.ts" }, tool_response: {} },
    {
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
      tool_response: {},
      agent_id: DELEGATE,
      agent_type: "Explore",
    },
    { tool_name: "Agent", tool_input: { description: "probe" }, tool_response: { agentId: DELEGATE } },
  ];
  for (const call of calls) {
    appendJournalEntry(journalPath, { session_id: SESSION, ...call }, at);
  }
  const ledgerPath = join(root, ".patchmesh", "ledger.db");
  ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
  return { root, ledgerPath };
}

const NOW = () => new Date("2026-08-21T12:05:00.000Z");

test("recall narrowed to a file reports who touched it and under which task", () => {
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, path: "src/auth.ts", now: NOW });

    assert.equal(result.calls.length, 1);
    assert.equal(result.logicalPath, "src/auth.ts");
    const call = result.calls[0]!;
    assert.equal(call.toolName, "edit_file");
    // The whole reason attribution was built: the answer names the subagent, not the session.
    assert.ok(call.agentId.includes(".sub."), `expected a subagent, got ${call.agentId}`);
    assert.equal(call.taskId, `task_${DELEGATE}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recall without a path covers the repository and names every agent", () => {
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, now: NOW });
    assert.equal(result.calls.length, 3);
    assert.equal(result.agents.length, 2, "the session and its subagent are different agents");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a caller can exclude its own calls so it does not rediscover its own work", () => {
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({
      worktreeRoot: root,
      ledgerPath,
      excludeAgentId: `agent_${SESSION}`,
      now: NOW,
    });
    assert.equal(result.agents.length, 1);
    assert.ok(result.agents[0]!.includes(".sub."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the time window excludes work that is no longer relevant", () => {
  const { root, ledgerPath } = recordedRepository("2026-08-20T00:00:00.000Z");
  try {
    assert.equal(recallRecentActivity({ worktreeRoot: root, ledgerPath, now: NOW }).calls.length, 0);
    const wide = recallRecentActivity({ worktreeRoot: root, ledgerPath, withinMinutes: 60 * 48, now: NOW });
    assert.equal(wide.calls.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recall answer is bounded and says how much it withheld", () => {
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, limit: 1, now: NOW });
    assert.equal(result.calls.length, 1);
    assert.equal(result.truncated, 2, "a page must not read as the whole truth");
    // An unnarrowed answer states the whole rather than listing a page of it, so the count is
    // complete and there is no page to mistake for everything. The tool histogram that used to
    // follow it was dropped: 79% of calls are opaque shell strings, so it reported the shape of
    // the recorder rather than anything about this window.
    assert.ok(renderRecall(result, undefined).includes("3 call(s) recorded"));
    assert.ok(!renderRecall(result, undefined).includes("Of the 1 most recent"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path outside the repository returns nothing and says why", () => {
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, path: "../elsewhere.ts", now: NOW });
    assert.equal(result.calls.length, 0);
    assert.equal(result.logicalPath, null);
    assert.ok(renderRecall(result, "../elsewhere.ts").includes("outside this repository"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rendered answer states that same file does not mean same work", () => {
  const { root, ledgerPath } = recordedRepository();
  try {
    const rendered = renderRecall(
      recallRecentActivity({ worktreeRoot: root, ledgerPath, path: "src/auth.ts", now: NOW }),
      "src/auth.ts",
    );
    // The ledger records paths, not diffs. An answer that let a reader forget that would
    // invite exactly the false duplicate-work conclusion the detector design already rejected.
    // The standing half of this caveat now lives in the MCP tool description, paid once per
    // session rather than once per answer; the row-specific half stays here.
    assert.ok(rendered.includes("Same file does not mean same work"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the server answers over stdio as a real MCP client sees it", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { root } = recordedRepository();
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: [join(process.cwd(), "dist", "bin.js"), root],
    });
    const client = new Client({ name: "gateway-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      // Pinned deliberately: the surface stays small on purpose, so adding a tool is a
      // decision this assertion forces someone to make rather than a drift nobody notices.
      assert.deepEqual(tools.tools.map((tool) => tool.name), [
        "patchmesh_recent_activity",
        "patchmesh_active_work",
        "patchmesh_overlapping_work",
        "patchmesh_recap",
        "patchmesh_send",
        "patchmesh_inbox",
        "patchmesh_ack",
      ]);

      const called = await client.callTool({
        name: "patchmesh_recent_activity",
        arguments: { path: "src/auth.ts", withinMinutes: 60 * 24 * 365 * 100 },
      });
      const text = (called.content as { type: string; text: string }[])[0]!.text;
      assert.ok(text.includes("src/auth.ts"));
      assert.ok(text.includes(".sub."), "the answer must name the subagent that made the edit");
    } finally {
      await client.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file written by a shell command is answerable from observed changes", async () => {
  // The gap dogfooding found: 90% of recorded calls are shell commands that name no path, so
  // a file-scoped query returned "no activity" for work that had plainly happened.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-gateway-effects-"));
  try {
    mkdirSync(join(root, ".git"));
    const journalPath = journalPathFor(root, ".patchmesh");
    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    const snapshotPath = join(root, ".patchmesh", "snapshot.json");
    const at = "2026-08-21T12:00:00.000Z";

    writeFileSync(join(root, "existing.md"), "already here\n", "utf8");
    appendJournalEntry(journalPath, { session_id: SESSION, hook_event_name: "UserPromptSubmit" }, at);
    appendJournalEntry(
      journalPath,
      { session_id: SESSION, tool_name: "Bash", tool_input: { command: "cat > notes.md" }, tool_response: {} },
      at,
    );
    const drained = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    assert.notEqual(drained.closedTurn, null, "one session with one marker names one turn");
    await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: drained.closedTurn });

    // The shell command actually writes the file; the next drain is what observes it.
    writeFileSync(join(root, "notes.md"), "written by a shell command\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: drained.closedTurn });

    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, path: "notes.md", now: NOW });
    // No call named this path - that is exactly the condition that used to answer nothing.
    assert.equal(result.calls.length, 0);
    assert.equal(result.changes.length, 1);
    const change = result.changes[0]!;
    assert.equal(change.logicalPath, "notes.md");
    assert.equal(change.changeKind, "created");
    assert.equal(change.taskId, drained.closedTurn?.taskId);

    const rendered = renderRecall(result, "notes.md");
    assert.match(rendered, /the filesystem shows it changed/u);
    assert.match(rendered, /Same file does not mean same work/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recall reports work still running, which the ledger can never hold", async () => {
  // Ingest runs on Stop, so anything in the ledger has finished. In-flight state exists only
  // in the journal, and this is the collision guard the ledger could not provide.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-gateway-inflight-"));
  try {
    mkdirSync(join(root, ".git"));
    const journalPath = journalPathFor(root, ".patchmesh");
    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    const at = "2026-08-21T12:00:00.000Z";

    appendJournalEntry(journalPath, { session_id: SESSION, hook_event_name: "UserPromptSubmit" }, at);
    appendJournalEntry(
      journalPath,
      { session_id: SESSION, hook_event_name: "PreToolUse", tool_use_id: "call_live", tool_name: "Bash", tool_input: { command: "pnpm check" } },
      "2026-08-21T12:04:30.000Z",
    );
    ingestJournal({ worktreeRoot: root, journalPath, ledgerPath, now: NOW });

    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, now: NOW });
    assert.equal(result.inFlight.length, 1, "the running call survives the drain");
    assert.equal(result.inFlight[0]!.operation, "pnpm check");
    assert.equal(result.inFlight[0]!.runningForMs, 30_000);

    const rendered = renderRecall(result, undefined);
    // Deliberately first: work still in flight decides more than work already finished.
    assert.match(rendered, /^1 call\(s\) running right now:/u);
    assert.match(rendered, /pnpm check \(running 30s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit that landed during a task is reported, and one outside it is not", () => {
  // Attribution is by committer time inside the task's observed window - the same basis as
  // turn-scoped effects. The timezone case is the one that matters: `git log --format=%cI`
  // emits a real UTC offset while task windows are stamped `Z`, so comparing the two as
  // strings would order them by the text of the timezone rather than by the instant.
  const commits = [
    { at: "2026-08-22T14:45:57+07:00", subject: "inside the window" },
    { at: "2026-08-22T20:45:57+07:00", subject: "hours later" },
    { at: "2026-08-21T14:45:57+07:00", subject: "the day before" },
  ];

  assert.deepEqual(
    commitsWithin(commits, "2026-08-22T07:39:35.579Z", "2026-08-22T07:46:13.891Z"),
    ["inside the window"],
  );
});

test("a task boundary is inclusive, because a commit is usually the last thing a turn does", () => {
  const commits = [{ at: "2026-08-22T07:46:13.891Z", subject: "on the boundary" }];
  assert.deepEqual(
    commitsWithin(commits, "2026-08-22T07:39:35.579Z", "2026-08-22T07:46:13.891Z"),
    ["on the boundary"],
  );
});

test("reading commits from somewhere without git yields no labels rather than failing", () => {
  // Labels enrich an answer that is already correct without them; losing git must cost the
  // labels and never the recap.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-nogit-"));
  try {
    assert.deepEqual(readCommitsSince(root, new Date("2020-01-01T00:00:00.000Z")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unnarrowed answer summarizes shell noise instead of quoting it", () => {
  // 79% of recorded calls are shell commands stored as a redacted command string that names
  // no resource. Listing twenty of them spends the caller's context on `git status` and
  // returns nothing it can act on.
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, now: NOW });
    const rendered = renderRecall(result, undefined);

    assert.match(rendered, /call\(s\) recorded across \d+ agent\(s\)/);
    assert.match(rendered, /Ask about a specific path to see the calls that named it\./);
    // The histogram replaces the per-call lines, so no operation string survives.
    assert.equal(rendered.includes("read_file: "), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("narrowing to a path still lists every call that named it", () => {
  // Detail follows the question: a caller that narrowed asked for exactly these calls, so
  // summarizing them would answer a question nobody asked.
  const { root, ledgerPath } = recordedRepository();
  try {
    const result = recallRecentActivity({ worktreeRoot: root, ledgerPath, path: "src/auth.ts", now: NOW });
    const rendered = renderRecall(result, "src/auth.ts");

    assert.ok(result.calls.length > 0, "the fixture must record a call naming this path");
    assert.match(rendered, /recorded call\(s\) for `src\/auth\.ts`/);
    assert.match(rendered, /edit_file: Edit src\/auth\.ts/);
    assert.equal(rendered.includes("Ask about a specific path"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task that only committed says so, instead of contradicting itself", () => {
  // Observed on this repository's ledger: task_d2a6d60d made 24 calls, landed 6 commits, and
  // had zero file.changed events, because the turn that runs `git add` and `git commit` changes
  // no tracked content itself. Rendering that as "changed no files" beside six commit subjects
  // reads as a contradiction rather than as the timing claim commit labels actually are.
  const result = {
    tasks: [{
      taskId: "task_commit_only",
      agentIds: ["agent_1"],
      startedAt: "2026-08-22T15:10:35.164Z",
      endedAt: "2026-08-22T15:18:04.471Z",
      calls: 24,
      failed: 0,
      changedPaths: [],
      moreChanged: 0,
      commits: ["Label recap tasks with the commits they landed"],
    }],
    truncated: 0,
    unattributedCalls: 0,
    scopeAgent: null,
  } as unknown as Parameters<typeof renderRecap>[0];

  const rendered = renderRecap(result);
  assert.match(rendered, /changed no files itself; the commits below carry work observed under earlier tasks/);
  assert.equal(rendered.includes("  changed no files\n"), false);
});
