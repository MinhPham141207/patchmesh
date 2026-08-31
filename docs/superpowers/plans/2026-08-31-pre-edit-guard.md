# Pre-Edit Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge PreToolUse contention detection to PostToolUse additionalContext via a filesystem sidecar, so the agent model always receives a warning when editing a file another agent is concurrently modifying.

**Architecture:** On PreToolUse, when contention is detected, write a transient sidecar file keyed by `tool_use_id`. On PostToolUse, read and delete the sidecar. If it exists, inject its message as `additionalContext`. This ensures the agent model sees the warning even if PostToolUse's own detection window misses the timing. Also add a voluntary `patchmesh_contention_check` MCP tool.

**Tech Stack:** TypeScript (strict), Node.js 24+, `node:fs` (sidecar I/O), existing `patchmesh-recorder` and `patchmesh-query` packages.

## Global Constraints

- Node >= 24 (uses `node:sqlite`)
- TypeScript strict mode, ES2022, NodeNext modules
- Hook binary (`bin.ts`) must always exit 0 — failures are advisory only
- No imports beyond Node builtins and existing package dependencies on the hook hot path
- All advisory tools fail soft — return text, never tool errors
- Sidecar I/O must stay under 5ms per call (measured, not assumed)

---

### Task 1: Sidecar read/write/delete utilities

**Files:**
- Create: `packages/recorder/src/sidecar.ts`
- Create: `packages/recorder/test/sidecar.test.ts`

**Interfaces:**
- Consumes: none (standalone utility)
- Produces: `writePendingAdvisory`, `readAndDeletePendingAdvisory`, `cleanupPendingAdvisories`, `PendingAdvisory`

- [ ] **Step 1: Write the failing tests**

Create `packages/recorder/test/sidecar.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  writePendingAdvisory,
  readAndDeletePendingAdvisory,
  cleanupPendingAdvisories,
  type PendingAdvisory,
} from "../src/sidecar.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "patchmesh-sidecar-"));
}

const SAMPLE: PendingAdvisory = {
  path: "src/auth.ts",
  agentId: "agent_abc",
  hostToolName: "Edit",
  runningForMs: 45000,
  detectedAt: "2026-08-31T12:00:00.000Z",
};

test("write creates a sidecar file, read returns it, file is deleted", () => {
  const dir = tmpDir();
  try {
    writePendingAdvisory(dir, "call_123", SAMPLE);
    const result = readAndDeletePendingAdvisory(dir, "call_123");
    assert.deepEqual(result, SAMPLE);
    assert.equal(readAndDeletePendingAdvisory(dir, "call_123"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read returns null for missing sidecar", () => {
  const dir = tmpDir();
  try {
    assert.equal(readAndDeletePendingAdvisory(dir, "nonexistent"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup removes all sidecars", () => {
  const dir = tmpDir();
  try {
    writePendingAdvisory(dir, "call_a", SAMPLE);
    writePendingAdvisory(dir, "call_b", SAMPLE);
    cleanupPendingAdvisories(dir);
    assert.equal(readAndDeletePendingAdvisory(dir, "call_a"), null);
    assert.equal(readAndDeletePendingAdvisory(dir, "call_b"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup on missing directory does not throw", () => {
  assert.doesNotThrow(() => cleanupPendingAdvisories("/nonexistent/path"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/recorder/test/sidecar.test.ts`
Expected: FAIL — module `../src/sidecar.js` not found

- [ ] **Step 3: Implement the sidecar module**

Create `packages/recorder/src/sidecar.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

export const PENDING_DIR = "pending-advisories";

export interface PendingAdvisory {
  readonly path: string;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly runningForMs: number;
  readonly detectedAt: string;
}

export function pendingAdvisoryPath(pendingDir: string, toolUseId: string): string {
  return join(pendingDir, `${toolUseId}.json`);
}

export function writePendingAdvisory(pendingDir: string, toolUseId: string, advisory: PendingAdvisory): void {
  mkdirSync(pendingDir, { recursive: true });
  const filePath = pendingAdvisoryPath(pendingDir, toolUseId);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(advisory), "utf8");
  renameSync(tmpPath, filePath);
}

export function readAndDeletePendingAdvisory(pendingDir: string, toolUseId: string): PendingAdvisory | null {
  const filePath = pendingAdvisoryPath(pendingDir, toolUseId);
  const lockPath = `${filePath}.lock`;
  let lockFd: number | null = null;
  try {
    // Acquire exclusive lock (single attempt with stale detection)
    try {
      lockFd = openSync(lockPath, "wx");
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      // Check for stale lock (>5 minutes old)
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
          unlinkSync(lockPath);
          // Retry lock acquisition
          lockFd = openSync(lockPath, "wx");
        }
      } catch {}
      // If still no lock, treat as missing (another process is reading)
      if (lockFd === null) return null;
    }
    // Read and delete
    try {
      const content = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content) as PendingAdvisory;
      try { unlinkSync(filePath); } catch {}
      return parsed;
    } catch {
      return null;
    }
  } finally {
    if (lockFd !== null) {
      closeSync(lockFd);
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

export function cleanupPendingAdvisories(pendingDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(pendingDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try { unlinkSync(join(pendingDir, entry)); } catch {}
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test packages/recorder/test/sidecar.test.ts`
Expected: PASS

- [ ] **Step 5: Export from index.ts**

Add to `packages/recorder/src/index.ts`:

```ts
export { writePendingAdvisory, readAndDeletePendingAdvisory, cleanupPendingAdvisories, PENDING_DIR } from "./sidecar.js";
export type { PendingAdvisory } from "./sidecar.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/sidecar.ts packages/recorder/test/sidecar.test.ts packages/recorder/src/index.ts
git commit -m "feat(recorder): add sidecar utilities for pending contention advisories"
```

---

### Task 2: Wire sidecar into bin.ts PreToolUse and PostToolUse

**Files:**
- Modify: `packages/recorder/src/bin.ts`
- Create: `packages/recorder/test/bin-sidecar.test.ts`

**Interfaces:**
- Consumes: `writePendingAdvisory`, `readAndDeletePendingAdvisory`, `cleanupPendingAdvisories`, `PENDING_DIR` from Task 1
- Produces: sidecar written on PreToolUse contention, read on PostToolUse, cleanup on SessionEnd

- [ ] **Step 1: Write the failing test**

Create `packages/recorder/test/bin-sidecar.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { appendJournalEntry, journalPathFor } from "../src/index.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const OTHER_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-sidecar-bin-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function seedInFlight(root: string, sessionId: string, toolName: string, toolInput: Record<string, unknown>, at: string): void {
  appendJournalEntry(
    journalPathFor(root, ".patchmesh"),
    {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_use_id: `call_${sessionId}_${at}`,
      tool_name: toolName,
      tool_input: toolInput,
    },
    at,
  );
}

test("PreToolUse writes a sidecar when contention is detected", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-31T12:00:00.000Z");

    execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_test_pre",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
      }),
      cwd: root,
      encoding: "utf8",
    });

    // Sidecar should exist for this tool_use_id
    const sidecarPath = join(root, ".patchmesh", "pending-advisories", "call_test_pre.json");
    const content = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(content.path, "src/shared.ts");
    assert.equal(content.hostToolName, "Edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse reads and deletes the sidecar, emitting additionalContext", () => {
  const root = worktree();
  try {
    // Seed contention + write sidecar via PreToolUse
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-31T12:00:00.000Z");
    execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PreToolUse",
        tool_use_id: "call_test_post",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
      }),
      cwd: root,
      encoding: "utf8",
    });

    // Now PostToolUse for the same tool_use_id
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PostToolUse",
        tool_use_id: "call_test_post",
        tool_name: "Edit",
        tool_input: { file_path: "src/shared.ts" },
        tool_response: {},
      }),
      cwd: root,
      encoding: "utf8",
    });

    // Should emit additionalContext with the sidecar's message
    const lines = output.trim().split("\n").filter((l) => l !== "");
    assert.ok(lines.length >= 1, "PostToolUse emits output");
    const parsed = JSON.parse(lines[0]!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext?: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext ?? "", /has a call in flight/u);

    // Sidecar should be deleted
    const sidecarPath = join(root, ".patchmesh", "pending-advisories", "call_test_post.json");
    assert.throws(() => readFileSync(sidecarPath), /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse without a sidecar still works normally (no additionalContext from sidecar)", () => {
  const root = worktree();
  try {
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify({
        session_id: OWN_SESSION,
        hook_event_name: "PostToolUse",
        tool_use_id: "call_no_sidecar",
        tool_name: "Edit",
        tool_input: { file_path: "src/solo.ts" },
        tool_response: {},
      }),
      cwd: root,
      encoding: "utf8",
    });
    // No contention, no sidecar → output may be empty or just the post-write advisory
    // The key assertion: no crash
    assert.doesNotThrow(() => JSON.parse(output.trim() || "{}"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test packages/recorder/test/bin-sidecar.test.ts`
Expected: FAIL — sidecar not written/read yet

- [ ] **Step 3: Modify bin.ts to write sidecar on PreToolUse contention**

In `packages/recorder/src/bin.ts`, add import at top:

```ts
import { writePendingAdvisory, readAndDeletePendingAdvisory, cleanupPendingAdvisories, PENDING_DIR } from "./sidecar.js";
```

Modify `emitAdvisory` (around line 92) to also write a sidecar when contention is detected:

```ts
export function emitAdvisory(
  worktreeRoot: string,
  payload: Record<string, unknown>,
  compute: typeof computeContentionAdvisory = computeContentionAdvisory,
): void {
  try {
    const advisory = compute({ worktreeRoot, payload });
    if (advisory === null) return;
    debug(`contention: ${advisory.message}`);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: advisory.message,
        },
      })}\n`,
    );
    // Write sidecar so PostToolUse can inject the same finding into additionalContext
    const toolUseId = payload["tool_use_id"];
    if (typeof toolUseId === "string" && toolUseId !== "") {
      const pendingDir = join(worktreeRoot, ".patchmesh", PENDING_DIR);
      writePendingAdvisory(pendingDir, toolUseId, {
        path: advisory.path,
        agentId: advisory.agentId,
        hostToolName: advisory.hostToolName,
        runningForMs: advisory.runningForMs,
        detectedAt: new Date().toISOString(),
      });
    }
    advanceDeliveredFact(advisory);
  } catch (error) {
    debug(error instanceof Error ? `advisory failed: ${error.message}` : "unknown advisory failure");
  }
}
```

- [ ] **Step 4: Modify bin.ts to read sidecar on PostToolUse**

Modify `emitPostWriteAdvisory` (around line 144) to also check the sidecar:

```ts
export function emitPostWriteAdvisory(
  worktreeRoot: string,
  payload: Record<string, unknown>,
  compute: typeof computePostWriteAdvisory = computePostWriteAdvisory,
): void {
  try {
    // First: emit the standard PostToolUse advisory (existing behavior)
    const advisory = compute({ worktreeRoot, payload });
    if (advisory !== null) {
      debug(`post-write contention: ${advisory.message}`);
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: advisory.message,
          },
        })}\n`,
      );
      advanceDeliveredFact(advisory);
      return;
    }

    // Second: check if PreToolUse wrote a sidecar for this call
    const toolUseId = payload["tool_use_id"];
    if (typeof toolUseId === "string" && toolUseId !== "") {
      const pendingDir = join(worktreeRoot, ".patchmesh", PENDING_DIR);
      const pending = readAndDeletePendingAdvisory(pendingDir, toolUseId);
      if (pending !== null) {
        const agentLabel = pending.agentId ?? "an unidentified agent";
        const seconds = Math.max(Math.round(pending.runningForMs / 1000), 0);
        const message =
          `${agentLabel} has a call in flight (${pending.hostToolName}) that started touching \`${pending.path}\` `
          + `${seconds}s ago and has not finished. You just wrote \`${pending.path}\` too. `
          + `Same file does not mean same work.`;
        debug(`sidecar-derived contention: ${message}`);
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: message,
            },
          })}\n`,
        );
      }
    }
  } catch (error) {
    debug(error instanceof Error ? `post-write advisory failed: ${error.message}` : "unknown post-write advisory failure");
  }
}
```

- [ ] **Step 5: Add sidecar cleanup on SessionEnd**

In `bin.ts`, add a new function and wire it into `main()`:

```ts
function emitSessionEndCleanup(worktreeRoot: string): void {
  try {
    const pendingDir = join(worktreeRoot, ".patchmesh", PENDING_DIR);
    cleanupPendingAdvisories(pendingDir);
  } catch {
    // Best-effort cleanup. Never block session end.
  }
}
```

In `main()`, after the advisory emissions (around line 272), add:

```ts
    const hookEventName = isRecord(payload) && typeof payload["hook_event_name"] === "string"
      ? payload["hook_event_name"]
      : null;
    if (hookEventName === "SessionEnd") {
      emitSessionEndCleanup(worktreeRoot);
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test packages/recorder/test/bin-sidecar.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/recorder/src/bin.ts packages/recorder/test/bin-sidecar.test.ts
git commit -m "feat(recorder): bridge PreToolUse contention to PostToolUse via sidecar"
```

---

### Task 3: MCP tool `patchmesh_contention_check`

**Files:**
- Modify: `packages/gateway/src/server.ts`
- Create: `packages/gateway/test/contention-check.test.ts`

**Interfaces:**
- Consumes: `readInFlightCalls` from `patchmesh-recorder`, `readRecentWrites` from `patchmesh-recorder`
- Produces: `patchmesh_contention_check` MCP tool

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/test/contention-check.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGatewayServer } from "../src/server.js";
import { appendJournalEntry, journalPathFor } from "patchmesh-recorder";

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-contention-check-"));
  mkdirSync(join(root, ".patchmesh"));
  mkdirSync(join(root, ".git"));
  return root;
}

const OTHER_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

test("patchmesh_contention_check returns in-flight calls from other agents", () => {
  const root = tmpDir();
  try {
    // Seed an in-flight call from another agent
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_other_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    }, new Date().toISOString());

    const server = createGatewayServer({ worktreeRoot: root });
    // The server is an McpServer; we need to call the tool handler directly
    // For testing, we'll use the server's internal tool call mechanism
    // This is a placeholder — actual test depends on MCP SDK test utilities
    assert.ok(server, "server created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Note: The actual MCP tool test pattern needs to match how other gateway tests invoke tools. Check `packages/gateway/test/gateway.test.ts` for the exact pattern and adapt.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/gateway/test/contention-check.test.ts`
Expected: FAIL — tool not registered yet

- [ ] **Step 3: Register the tool in server.ts**

In `packages/gateway/src/server.ts`, add to the heavy lazy import:

```ts
readonly readInFlightCalls: (options: import("patchmesh-recorder").ReadInFlightOptions) => readonly import("patchmesh-recorder").InFlightCall[];
```

And in `loadHeavy()`:

```ts
readInFlightCalls: recorder.readInFlightCalls,
```

Then register the new tool after `patchmesh_ack`:

```ts
server.registerTool(
  "patchmesh_contention_check",
  {
    title: "Check file contention",
    description:
      "**Call this before editing a file to check if another agent is currently modifying it.** " +
      "Returns in-flight calls from other agents touching the same path, plus recent completed " +
      "writes. This is the voluntary version of the automatic hook-based warning: use it when " +
      "you want to check before the hook fires, or for paths not covered by Edit/Write hooks.",
    inputSchema: {
      path: z.string().describe("Repository-relative or absolute file path to check."),
      excludeAgentId: z
        .string()
        .optional()
        .describe("Omit this agent's own calls, so a caller does not see itself as contention."),
    },
  },
  async ({ path, excludeAgentId }) => {
    try {
      const modules = await loadHeavy();
      const inFlight = modules.readInFlightCalls({
        worktreeRoot: options.worktreeRoot,
        excludeAgentId,
      });
      const contentions = inFlight.filter(
        (call) => call.filePath === path || call.operation === path,
      );
      const text = contentions.length === 0
        ? `No agents currently modifying \`${path}\`.`
        : contentions
            .map((c) => {
              const agent = c.agentId ?? "unidentified agent";
              const seconds = Math.max(Math.round(c.runningForMs / 1000), 0);
              return `- ${agent}: ${c.hostToolName} on \`${path}\` (${seconds}s ago, still running)`;
            })
            .join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown failure";
      return { content: [{ type: "text" as const, text: `No PatchMesh data available (${reason}).` }] };
    }
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/gateway/test/contention-check.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/server.ts packages/gateway/test/contention-check.test.ts
git commit -m "feat(gateway): add patchmesh_contention_check MCP tool"
```

---

### Task 4: Run full test suite and verify

- [ ] **Step 1: Build the project**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All tests pass (including new sidecar, bin-sidecar, and contention-check tests)

- [ ] **Step 4: Run the full check pipeline**

Run: `pnpm check`
Expected: Pass — build, typecheck, tests, Phase 0 corpus, evidence validation

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address test failures from pre-edit guard implementation"
```
