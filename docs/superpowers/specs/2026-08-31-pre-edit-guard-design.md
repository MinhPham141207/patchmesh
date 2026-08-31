# Pre-Edit Guard Design

> **Status:** Design spec. Bridges existing PreToolUse contention detection to PostToolUse additionalContext so agent models see warnings about concurrent file edits.

## Problem

PatchMesh already detects file contention on `PreToolUse` for `Edit`/`Write` calls (`advisory.ts:214`). But the output goes to `permissionDecisionReason`, which is shown to the user — not to the agent model. The agent never learns that another agent is simultaneously modifying the same file.

With 2-4 agents working concurrently in one repo, file conflicts and stale assumptions are the dominant failure mode. Agents stomp on each other's edits because they have no visibility into concurrent work.

## Goal

When Agent A is about to edit a file that Agent B is currently modifying, Agent A's model receives a warning in its context. The warning names the other agent, the tool in flight, and how long it has been running.

## Non-Goals

- Conflict prevention (remains advisory — `allow`, never `reject`)
- Read tracking (future work)
- Cross-worktree live contention (journal is per-worktree)
- Shell command path extraction (future work)

## Design

### Core Mechanism: Filesystem Sidecar

The hook binary runs as a separate process for each `PreToolUse` and `PostToolUse` invocation. They share no in-memory state. To bridge detection (PreToolUse) to injection (PostToolUse), use a transient sidecar file.

**Sidecar location:** `.patchmesh/pending-advisories/<tool_use_id>.json`

**Sidecar format:**
```json
{
  "path": "src/auth.ts",
  "agentId": "agent_abc",
  "hostToolName": "Edit",
  "runningForMs": 45000,
  "detectedAt": "2026-08-31T12:00:00.000Z"
}
```

### Flow

```
PreToolUse(Edit, file_path=src/auth.ts)
  1. Hook reads journal → finds in-flight calls from other agents
  2. computeContentionAdvisory detects collision on src/auth.ts
  3. Writes sidecar: .patchmesh/pending-advisories/<tool_use_id>.json
  4. Emits permissionDecision: "allow" + reason (for user)

Agent edits the file (tool executes)

PostToolUse(Edit, file_path=src/auth.ts)
  1. Hook reads sidecar: .patchmesh/pending-advisories/<tool_use_id>.json
  2. If sidecar exists:
     a. Reads content
     b. Deletes sidecar
     c. Renders warning message
     d. Emits additionalContext: warning message
  3. If no sidecar: emits no additionalContext (normal behavior)
  4. Agent model receives the warning in its context
```

### Message Format

```
⚠ Contention: {agentId} is currently modifying {path} ({hostToolName}, {seconds}s ago).
Your edit may conflict. Consider re-reading the file after your edit completes.
```

Truncated to 512 chars. Same trust-boundary treatment as mailbox messages (untrusted, data not instructions).

### New MCP Tool: `patchmesh_contention_check`

A voluntary tool so agents can proactively check before editing:

**Input:**
```json
{
  "path": "src/auth.ts",
  "excludeAgentId": "agent_abc"  // optional
}
```

**Output:**
```json
{
  "path": "src/auth.ts",
  "contentions": [
    {
      "agentId": "agent_def",
      "hostToolName": "Edit",
      "runningForMs": 45000,
      "filePath": "src/auth.ts"
    }
  ],
  "recentWrites": [
    {
      "agentId": "agent_ghi",
      "at": "2026-08-31T11:55:00.000Z",
      "filePath": "src/auth.ts"
    }
  ]
}
```

This is the same data the hook already reads, exposed as a queryable tool.

## Implementation Plan

### Step 1: Sidecar writer (PreToolUse path)

**File:** `packages/recorder/src/sidecar.ts` (new)

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

### Concurrency Safety

- **Atomic writes:** `writePendingAdvisory` writes to a temporary file (`<path>.<pid>.<timestamp>.tmp`) then renames to the final path. This ensures readers never see partial JSON.
- **Lockfile:** `readAndDeletePendingAdvisory` acquires an exclusive lock via `open(lockPath, 'wx')`. If lock exists, checks staleness (>5 minutes) and removes stale lock. If lock cannot be acquired, returns `null` (another process is reading).
- **Cleanup:** `cleanupPendingAdvisories` iterates directory and deletes `.json` files without locking (best-effort). Missing directory is a no-op.

### Step 2: Wire into bin.ts PreToolUse

**File:** `packages/recorder/src/bin.ts`

In the PreToolUse path (around line 265), after `computeContentionAdvisory` returns non-null:

```ts
if (advisory !== null) {
  const pendingDir = join(worktreeRoot, ".patchmesh", "pending-advisories");
  writePendingAdvisory(pendingDir, payload["tool_use_id"], advisory);
}
```

### Step 3: Wire into bin.ts PostToolUse

**File:** `packages/recorder/src/bin.ts`

In the PostToolUse path (around line 140), before emitting `additionalContext`:

```ts
const pendingDir = join(worktreeRoot, ".patchmesh", "pending-advisories");
const pending = readAndDeletePendingAdvisory(pendingDir, payload["tool_use_id"]);
if (pending !== null) {
  const message = renderContentionWarning(pending);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: message,
      },
    }) + "\n"
  );
}
```

### Step 4: MCP tool implementation

**File:** `packages/gateway/src/server.ts`

Add `patchmesh_contention_check` tool:

```ts
{
  name: "patchmesh_contention_check",
  description: "Check if another agent is currently modifying a file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repository-relative or absolute file path" },
      excludeAgentId: { type: "string", description: "Omit this agent's own calls" },
    },
    required: ["path"],
  },
}
```

Handler reads in-flight calls from journal, filters by path, returns matches.

### Step 5: Cleanup on session end

**File:** `packages/recorder/src/bin.ts`

On `SessionEnd` hook, delete all remaining sidecars in `.patchmesh/pending-advisories/`. Prevents stale sidecars from accumulating if a session crashes between PreToolUse and PostToolUse.

### Step 6: Tests

- Unit tests for `writePendingAdvisory` / `readAndDeletePendingAdvisory` in `sidecar.ts`
- Integration test: two scripted sessions, Session A in-flight on file, Session B edits same file, verify additionalContext is emitted
- Edge cases: tool_use_id mismatch, missing sidecar (normal — no contention), crash between Pre/Post (sidecar cleaned up on session end)
- Performance: verify overhead stays under 5ms per call (one file write + one file read)

## Files Changed

| File | Change |
|------|--------|
| `packages/recorder/src/sidecar.ts` | New — sidecar read/write/delete |
| `packages/recorder/src/bin.ts` | Wire sidecar write on PreToolUse, read on PostToolUse, cleanup on SessionEnd |
| `packages/gateway/src/server.ts` | Add `patchmesh_contention_check` tool |
| `packages/gateway/src/` | Handler for contention check |
| `packages/recorder/test/sidecar.test.ts` | New — unit tests |
| `packages/gateway/test/contention-check.test.ts` | New — MCP tool tests |

## Exit Criteria

1. Agent A edits a file while Agent B is in-flight on the same file → Agent A's model receives a warning in `additionalContext`
2. No contention → no warning emitted (zero overhead in the common case)
3. Sidecar cleanup on session end — no stale files
4. `patchmesh_contention_check` returns accurate in-flight data
5. All existing tests pass
6. Per-call overhead under 5ms (measured on a normal machine)
