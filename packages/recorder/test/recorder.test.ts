import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEvent, validateEventSet, type EventId } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";
import {
  appendJournalEntry,
  buildHookEvents,
  deriveAnalysisEvents,
  findWorktreeRoot,
  ingestJournal,
  journalPathFor,
  ledgerPathFor,
  ledgerRootFor,
  logicalPathFor,
  normalizeOperation,
  normalizeTool,
  recordHook,
  recordTurnEffects,
  resolveRepositoryIdentity,
  resolveSourceHost,
} from "../src/index.js";
import type { HookPayload } from "../src/index.js";

function withPatchMeshHost<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.PATCHMESH_HOST;
  try {
    if (value === undefined) delete process.env.PATCHMESH_HOST;
    else process.env.PATCHMESH_HOST = value;
    return run();
  } finally {
    if (previous === undefined) delete process.env.PATCHMESH_HOST;
    else process.env.PATCHMESH_HOST = previous;
  }
}

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-recorder-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function hookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: "src/index.ts" },
    tool_response: {},
    ...overrides,
  };
}

test("records a completed tool call as a valid causally linked event pair", () => {
  const root = temporaryWorktree();
  try {
    const result = recordHook({ payload: hookPayload(), worktreeRoot: root });
    assert.equal(result.recorded, true);

    const store = SqliteEventStore.open(result.ledgerPath!);
    try {
      const events = store.read();
      assert.equal(events.length, 2);
      const [requested, completed] = events;
      assert.equal(requested!.eventType, "tool.requested");
      assert.equal(completed!.eventType, "tool.completed");
      assert.equal(completed!.causationId, requested!.eventId);
      assert.equal(completed!.correlationId, requested!.correlationId);
      // The whole point of the slice: a real host tool name survives normalization.
      assert.equal((requested!.payload as { hostToolName: string }).hostToolName, "Read");
      assert.equal((requested!.payload as { toolName: string }).toolName, "read_file");
      assert.deepEqual(validateEventSet(events), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every recorded event passes protocol validation for each supported host tool", () => {
  const root = temporaryWorktree();
  try {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["Read", { file_path: "src/a.ts" }],
      ["Write", { file_path: "src/b.ts" }],
      ["Edit", { file_path: "src/c.ts" }],
      ["Bash", { command: "pnpm test" }],
      ["Bash", { command: "git commit -m 'x'" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Task", { prompt: "investigate" }],
      ["mcp__knowl__knowl_query", { query: "anything" }],
    ];
    for (const [toolName, toolInput] of cases) {
      const { requested, completed } = buildHookEvents({
        payload: hookPayload({ tool_name: toolName, tool_input: toolInput }),
        worktreeRoot: root,
      });
      for (const event of [requested, completed]) {
        const parsed = parseEvent(event);
        assert.equal(parsed.value !== null, true, `${toolName} produced invalid event: ${JSON.stringify(parsed.diagnostics)}`);
      }
      assert.deepEqual(validateEventSet([requested, completed]), [], `${toolName} failed set validation`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance follows PATCHMESH_HOST, defaults to claude-code", () => {
  withPatchMeshHost("opencode", () => assert.equal(resolveSourceHost(), "opencode"));
  withPatchMeshHost(undefined, () => assert.equal(resolveSourceHost(), "claude-code"));
});

test("an invalid PATCHMESH_HOST falls back rather than minting a malformed source id", () => {
  withPatchMeshHost("Open Code!", () => assert.equal(resolveSourceHost(), "claude-code"));
  withPatchMeshHost("-leading", () => assert.equal(resolveSourceHost(), "claude-code"));
  withPatchMeshHost("a".repeat(33), () => assert.equal(resolveSourceHost(), "claude-code"));
});

test("buildHookEvents stamps source_<host>_hook", () => {
  const root = temporaryWorktree();
  try {
    const pair = withPatchMeshHost("opencode", () =>
      buildHookEvents({ payload: hookPayload({ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }), worktreeRoot: root }),
    );
    // The default must stay byte-identical to what every existing ledger already carries.
    assert.equal(pair.requested.source.sourceId, "source_opencode_hook");
    assert.equal(
      withPatchMeshHost(undefined, () =>
        buildHookEvents({ payload: hookPayload({ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }), worktreeRoot: root }),
      ).requested.source.sourceId,
      "source_claude_code_hook",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown host tools normalize to an opaque other rather than a guessed read or write", () => {
  assert.deepEqual(normalizeTool("TotallyNewTool", null), {
    toolName: "other",
    pathProperty: null,
    opaque: true,
  });
  assert.equal(normalizeTool("Bash", "git commit -m 'msg'").toolName, "git_commit");
  assert.equal(normalizeTool("Bash", "git commits-are-not-this").toolName, "run_shell");
  assert.equal(normalizeTool("Bash", "pnpm test").toolName, "run_shell");
});

test("multi-line and secret-bearing commands are recorded within the operation pattern", () => {
  const operation = normalizeOperation("run\n  deploy --token=abc123secret\n", "Bash");
  assert.match(operation, /^\S(?:.*\S)?$/u);
  assert.equal(operation.includes("\n"), false);
  assert.equal(operation.includes("abc123secret"), false);
});

test("a path outside the worktree degrades to no resource instead of escaping the repository", () => {
  const root = temporaryWorktree();
  try {
    const { requested } = buildHookEvents({
      payload: hookPayload({ tool_input: { file_path: join(root, "..", "outside.ts") } }),
      worktreeRoot: root,
    });
    const payload = requested.payload as { targetResourceId: string | null; opaque: boolean };
    assert.equal(payload.targetResourceId, null);
    assert.equal(payload.opaque, true);
    assert.equal(logicalPathFor(root, "../outside.ts"), null);
    assert.equal(logicalPathFor(root, "src/ok.ts"), "src/ok.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit failure signal is recorded as a failed completion", () => {
  const root = temporaryWorktree();
  try {
    const failed = buildHookEvents({
      payload: hookPayload({ tool_name: "Bash", tool_input: { command: "false" }, tool_response: { exit_code: 1 } }),
      worktreeRoot: root,
    });
    assert.equal((failed.completed.payload as { outcome: string }).outcome, "failed");
    assert.equal((failed.completed.payload as { exitCode: number | null }).exitCode, 1);

    const succeeded = buildHookEvents({ payload: hookPayload(), worktreeRoot: root });
    assert.equal((succeeded.completed.payload as { outcome: string }).outcome, "succeeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository identity is stable across invocations and distinct per worktree", () => {
  const first = temporaryWorktree();
  const second = temporaryWorktree();
  try {
    const a = resolveRepositoryIdentity(first);
    const b = resolveRepositoryIdentity(first);
    const c = resolveRepositoryIdentity(second);
    assert.deepEqual(a, b);
    assert.notEqual(a.worktreeId, c.worktreeId);
    assert.match(a.repositoryId, /^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("one directory keeps one identity across path spellings", () => {
  // Regression: real recorded data contained two worktree identities for one checkout,
  // because hook invocations reported `D:\patchmesh` and `d:\patchmesh`. A single agent
  // appearing as two agents in two worktrees would corrupt cross-worktree comparison.
  const root = temporaryWorktree();
  try {
    const canonical = resolveRepositoryIdentity(root);
    const spellings = [
      root.split("\\").join("/"),
      `${root}${root.includes("\\") ? "\\" : "/"}`,
      join(root, "packages", ".."),
    ];
    // A backslash separates directories on Windows and is a legal *filename character* on
    // POSIX, so `\tmp\x` is the same directory as `/tmp/x` on one platform and a different
    // path entirely on the other. Asserting it everywhere made this test assert something
    // false on Linux, which is where CI runs: the suite was green on the developer's machine
    // and red on every push. Platform-shaped spellings belong behind a platform check.
    if (process.platform === "win32") {
      spellings.push(root.split("/").join("\\"));
    }
    if (/^[A-Za-z]:/u.test(root)) {
      spellings.push(root[0]!.toLowerCase() + root.slice(1), root[0]!.toUpperCase() + root.slice(1));
    }
    for (const spelling of spellings) {
      assert.deepEqual(
        resolveRepositoryIdentity(spelling),
        canonical,
        `spelling ${JSON.stringify(spelling)} produced a different identity`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktrees of one repository share a repository identity", () => {
  const main = temporaryWorktree();
  const linked = mkdtempSync(join(tmpdir(), "patchmesh-linked-"));
  try {
    writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
    assert.equal(
      resolveRepositoryIdentity(linked).repositoryId,
      resolveRepositoryIdentity(main).repositoryId,
    );
    assert.notEqual(
      resolveRepositoryIdentity(linked).worktreeId,
      resolveRepositoryIdentity(main).worktreeId,
    );
    // The workspace is the set of checkouts sharing a ledger, so two linked worktrees are one
    // workspace. Giving them separate ids put their events in one database wearing labels that
    // could never be compared, and every detector that pairs events on workspace equality was
    // blind across worktrees as a result. See docs/problems/PM-03.
    assert.equal(
      resolveRepositoryIdentity(linked).workspaceId,
      resolveRepositoryIdentity(main).workspaceId,
    );
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("linked worktrees of one repository record into one ledger", () => {
  const main = temporaryWorktree();
  const linked = mkdtempSync(join(tmpdir(), "patchmesh-linked-"));
  try {
    writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
    // The whole point: two roots, one database, so cross-worktree overlap has somewhere to
    // look. `overlaps` already treats two worktrees as two workers; before this it had two
    // separate files and could never see both.
    assert.equal(ledgerPathFor(linked), ledgerPathFor(main));
    assert.equal(ledgerRootFor(linked), main);
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("a primary worktree keeps the ledger it already has", () => {
  const main = temporaryWorktree();
  try {
    // Existing installs must not have their ledger moved out from under them, so the
    // ordinary single-worktree path has to resolve exactly as it did before.
    assert.equal(ledgerRootFor(main), main);
    assert.equal(ledgerPathFor(main), join(main, ".patchmesh", "ledger.db"));
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
});

test("a submodule keeps its own ledger rather than the superproject's", () => {
  const superproject = temporaryWorktree();
  const submodule = mkdtempSync(join(tmpdir(), "patchmesh-submodule-"));
  try {
    // A submodule's pointer resolves under `.git/modules`, not `.git/worktrees`. It is a
    // different repository, so folding its ledger into the superproject's would merge the
    // work of two repositories into one history.
    writeFileSync(
      join(submodule, ".git"),
      `gitdir: ${join(superproject, ".git", "modules", "vendor")}\n`,
    );
    assert.equal(ledgerRootFor(submodule), submodule);
  } finally {
    rmSync(superproject, { recursive: true, force: true });
    rmSync(submodule, { recursive: true, force: true });
  }
});

test("an unreadable git pointer falls back to the worktree rather than guessing", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-badgit-"));
  try {
    writeFileSync(join(root, ".git"), "this is not a gitdir pointer\n");
    assert.equal(ledgerRootFor(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree discovery walks up from a nested directory", () => {
  const root = temporaryWorktree();
  try {
    const nested = join(root, "packages", "deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(findWorktreeRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recording is skipped rather than thrown when no worktree contains the hook cwd", () => {
  const outside = mkdtempSync(join(tmpdir(), "patchmesh-nogit-"));
  try {
    const result = recordHook({ payload: hookPayload({ cwd: outside }) });
    assert.equal(result.recorded, false);
    assert.equal(typeof result.reason, "string");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("two linked worktrees drain into the shared ledger without losing either one's events", async () => {
  const main = temporaryWorktree();
  const linked = mkdtempSync(join(tmpdir(), "patchmesh-linked-"));
  try {
    writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
    const ledgerPath = ledgerPathFor(main);
    assert.equal(ledgerPathFor(linked), ledgerPath, "the premise: one database, two checkouts");

    // Sharing the ledger introduced genuine multi-writer contention on one SQLite file, which
    // PM-03 flagged as the part that needed a test rather than an assumption. Each worktree
    // keeps its own journal (the snapshot is a diff baseline of one checkout's files), so the
    // contention is exactly at the append.
    const sessions = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const roots = [main, linked];
    const drains = roots.map((root, index) => async () => {
      const journalPath = journalPathFor(root, ".patchmesh");
      for (let call = 0; call < 12; call += 1) {
        appendJournalEntry(
          journalPath,
          { ...hookPayload({ tool_input: { file_path: `src/file-${index}-${call}.ts` } }), session_id: sessions[index] },
          new Date(Date.UTC(2026, 7, 23, 12, index, call)).toISOString(),
        );
      }
      return ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    });

    const results = await Promise.all(drains.map((drain) => drain()));
    for (const result of results) assert.equal(result.ingested > 0, true, "each worktree ingested its own calls");

    const store = SqliteEventStore.open(ledgerPath);
    try {
      const events = store.read();
      // The set validator, not per-event parsing: an interleaved append is exactly the shape
      // that produces a valid-looking event which is invalid as a member of the set.
      assert.deepEqual(validateEventSet(events), []);

      const worktreeIds = new Set(events.map((event) => event.worktreeId));
      assert.equal(worktreeIds.size, 2, "both checkouts are present in one ledger");
      const workspaceIds = new Set(events.map((event) => event.workspaceId));
      assert.equal(workspaceIds.size, 1, "and they share one workspace, so they can be compared");

      const requested = events.filter((event) => event.eventType === "tool.requested");
      assert.equal(requested.length, 24, "no writer's events were dropped under contention");
    } finally {
      store.close();
    }
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("an observed change to a supported source file also records its symbols", async () => {
  const root = temporaryWorktree();
  try {
    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    const snapshotPath = join(root, ".patchmesh", "snapshot.json");
    const journalPath = journalPathFor(root, ".patchmesh");

    writeFileSync(join(root, "seed.ts"), "export const seed = 1;\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: null });

    const at = "2026-08-23T12:00:00.000Z";
    appendJournalEntry(journalPath, { session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17", hook_event_name: "UserPromptSubmit" }, at);
    appendJournalEntry(journalPath, hookPayload({ tool_name: "Edit", tool_input: { file_path: "api.ts" } }), at);
    const drained = ingestJournal({ worktreeRoot: root, journalPath, ledgerPath });
    writeFileSync(join(root, "api.ts"), "export function greet(name: string): string { return name; }\n", "utf8");
    await recordTurnEffects({ worktreeRoot: root, ledgerPath, snapshotPath, turn: drained.closedTurn, now: () => at });

    const store = SqliteEventStore.open(ledgerPath);
    try {
      const events = store.read();
      const symbols = events.filter((event) => event.eventType === "symbol.changed");
      assert.equal(symbols.length > 0, "at least one exported symbol is recorded" && symbols.length > 0);

      const greet = symbols.find((event) => event.payload.resource.locator.includes("greet"));
      assert.ok(greet, `expected a symbol for greet, got ${symbols.map((s) => s.payload.resource.locator).join(", ")}`);
      // The causal parent must be the file change that proved the file moved, or the symbol is
      // a claim with nothing behind it.
      const parent = events.find((event) => event.eventId === greet.causationId);
      assert.equal(parent?.eventType, "file.changed");
      assert.equal(greet.correlationId, parent.correlationId, "a child shares its parent's correlation");
      assert.equal(greet.taskId, parent.taskId, "and its attribution");

      // The rule that matters and that per-event parsing cannot see: the whole set has to
      // replay. A correlation may hold only one root, and adding children to an existing
      // correlation is exactly where that invariant gets broken silently.
      assert.deepEqual(validateEventSet(events), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a file that no longer matches the version observed is not analyzed as that version", () => {
  // Tested directly rather than by racing a drain against a second write: when the snapshot
  // happens to catch the newer content, analyzing that content is correct, so a race would be
  // asserting a coin flip. The rule is about the guard, so the guard is what gets the test.
  const root = temporaryWorktree();
  try {
    writeFileSync(join(root, "api.ts"), "export function present(): void {}\n", "utf8");
    const identity = resolveRepositoryIdentity(root);
    const source = { kind: "watcher" as const, sourceId: "source_patchmesh_observer", instanceId: identity.worktreeId.slice(3) };
    const resource = { resourceId: `res_${"a".repeat(64)}`, repositoryId: identity.repositoryId, kind: "file" as const, locator: "api.ts" };
    const version = {
      resourceId: resource.resourceId,
      domain: { repositoryId: identity.repositoryId, workspaceId: identity.workspaceId, worktreeId: identity.worktreeId },
      kind: "content_hash" as const,
      // A hash the file on disk does not have: the content moved on after it was observed.
      value: "0".repeat(64),
      evidenceEventIds: ["evt_00000000000000000000000000000001"],
    };
    const change = {
      schemaVersion: 1 as const,
      eventId: "evt_00000000000000000000000000000001",
      eventType: "file.changed" as const,
      source,
      timestamp: "2026-08-23T12:00:00.000Z",
      repositoryId: identity.repositoryId,
      workspaceId: identity.workspaceId,
      worktreeId: identity.worktreeId,
      agentId: null,
      taskId: null,
      correlationId: "corr_00000000000000000000000000000001",
      causationId: null,
      sourceSequence: null,
      payload: { resource, beforeVersion: null, afterVersion: version, changeKind: "modified" as const },
    };

    const derived = deriveAnalysisEvents({
      identity,
      source,
      changes: [change as never],
      priorSymbolVersions: new Map(),
      now: () => "2026-08-23T12:00:01.000Z",
      nextEventId: () => "evt_00000000000000000000000000000002",
    });

    // A signature that never existed at the observed version is a fabricated fact, which is
    // worse than a missing one.
    assert.deepEqual(derived, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The committed envelopes below are real-shaped Claude Code `PostToolUse` payloads (secret-free,
// reduced to the fields the recorder reads) covering a shell call, an edit, a read, a notebook
// edit, a subagent's own call, the spawn that created it, an unmapped tool, and a failure. They
// are replayed through `buildHookEvents` and compared field-for-field against events captured
// from the pre-adapter implementation, so the HostRecord refactor is proven not to move a byte.
const FROZEN_ENVELOPES = JSON.parse(
  readFileSync(new URL("./fixtures/claude-frozen-envelopes.json", import.meta.url), "utf8"),
) as readonly Record<string, unknown>[];
const FROZEN_EVENTS = JSON.parse(
  readFileSync(new URL("./fixtures/claude-frozen-events.json", import.meta.url), "utf8"),
) as readonly unknown[];

// Path-hashed identities differ per checkout and correlation ids are random per call, so those
// alone are frozen to tokens; every other field must match the capture exactly.
const UUID_LIKE = /^(?:repo|ws|wt)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function frozenView(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^corr_[0-9a-f]{32}$/u.test(value)) return "corr_FROZEN";
    if (/^res_[0-9a-f]{64}$/u.test(value)) return "res_FROZEN";
    if (UUID_LIKE.test(value)) return `${value.slice(0, value.indexOf("_"))}_FROZEN`;
    return value;
  }
  if (Array.isArray(value)) return value.map(frozenView);
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = frozenView((value as Record<string, unknown>)[key]);
    return copy;
  }
  return value;
}

test("the host-record refactor leaves event construction identical on frozen envelopes", () => {
  withPatchMeshHost(undefined, () => {
    const root = temporaryWorktree();
    try {
      const now = (): string => "2026-08-26T00:00:00.000Z";
      let counter = 0;
      const nextEventId = (): EventId => `evt_${(++counter).toString(16).padStart(32, "0")}`;
      FROZEN_ENVELOPES.forEach((envelope, index) => {
        const actual = buildHookEvents({
          payload: envelope as HookPayload,
          worktreeRoot: root,
          now,
          nextEventId,
        });
        assert.match(actual.requested.correlationId, /^corr_[0-9a-f]{32}$/u);
        assert.equal(actual.completed.correlationId, actual.requested.correlationId);
        assert.deepEqual(frozenView(JSON.parse(JSON.stringify(actual))), FROZEN_EVENTS[index]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
