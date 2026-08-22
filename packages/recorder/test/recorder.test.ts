import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEvent, validateEventSet } from "patchmesh-protocol";
import { SqliteEventStore } from "patchmesh-storage";
import {
  buildHookEvents,
  findWorktreeRoot,
  logicalPathFor,
  normalizeOperation,
  normalizeTool,
  recordHook,
  resolveRepositoryIdentity,
} from "../src/index.js";

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
      root.split("/").join("\\"),
      root.split("\\").join("/"),
      `${root}${root.includes("\\") ? "\\" : "/"}`,
      join(root, "packages", ".."),
    ];
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
  } finally {
    rmSync(main, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
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
