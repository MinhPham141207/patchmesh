# Coordination Realness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PatchMesh's coordination real — a contention advisory that actually fires on recent cross-agent writes, attribution that survives concurrency, and honest task liveness — while never blocking a tool call.

**Architecture:** All live state stays in the per-worktree journal (already written by every hook invocation). A new recent-write reader plus a per-session delivery cursor replaces the dead in-flight-window advisory predicate. Attribution gains a declared-path fast path before the mtime-window fallback, and labels its basis. Spec: `docs/superpowers/specs/2026-08-25-coordination-realness-design.md`.

**Tech Stack:** TypeScript 5.7, Node >= 24 builtins only on the hook path (`node:fs`, `node:path`), `tsx --test` per package, pnpm workspaces.

## Global Constraints

- The hook binary (`packages/recorder/src/bin.ts`) and everything it imports must stay free of `patchmesh-protocol` and `patchmesh-storage` imports — only Node builtins and sibling recorder modules (`identity.js`, `journal.js`, `redact.js`, `inflight.js`, and new `recent-writes.js`). `packages/recorder/test/journal.test.ts` has an import-graph guard test that enforces this; it must keep passing.
- Every hook path always exits 0. An advisory failure may cost only the advisory.
- Warn, never block: `PreToolUse` output is `permissionDecision: "allow"` + reason only; model-reaching text goes via `additionalContext` on PostToolUse/UserPromptSubmit.
- Never parse a path out of shell command text (M7 ban). Opaque calls are reported as unknown counts, never guessed paths.
- Answers are bounded and say what they withheld.
- Default behavior on a Claude-only install is byte-identical to today unless a slice says otherwise.
- Run package tests with `corepack pnpm --filter <pkg> test`; the whole gate is `corepack pnpm check` and must exit 0 at the end of every task.

---

### Task 1: Recap task liveness (P5)

**Files:**
- Modify: `packages/query/src/recap.ts`
- Test: `packages/query/test/recap.test.ts`

**Interfaces:**
- Consumes: existing `RecappedTask`, `recapRecentWork(options)` (unchanged signatures).
- Produces: `RecappedTask.active: boolean` — later tasks and any renderer rely on this field being present.

- [ ] **Step 1: Write the failing tests**

Add to `packages/query/test/recap.test.ts` (reuse the file's existing helpers for seeding a repo + journal; the file already has `runTurn(repo, at, calls, fn)` and journal seeding used at line 97/121):

```ts
test("a task whose last activity is inside the idle gap is active, not finished", () => {
  // Seed one turn ending 10 minutes before `now`. Existing helpers write events at fixed
  // timestamps; pass a `now` that is 10 minutes later.
  const tenMinutes = 10 * 60_000;
  const result = recapRecentWork({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    now: () => new Date(Date.parse("2026-08-21T12:40:00.000Z")),
  });
  const task = result.tasks[0]!;
  assert.equal(task.active, true);
  assert.ok(task.endedAt !== undefined);
});

test("a task idle longer than IDLE_GAP_MINUTES renders closed", () => {
  const result = recapRecentWork({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    now: () => new Date(Date.parse("2026-08-22T18:00:00.000Z")), // > 30 min after seed
  });
  assert.equal(result.tasks.every((task) => task.active === false), true);
});
```

Adapt timestamps to whatever the existing seeds write; the invariant under test is `active === (now - endedAt) <= IDLE_GAP_MINUTES * 60_000`. Import `IDLE_GAP_MINUTES` from `../src/overlap.js` rather than hard-coding 30.

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter patchmesh-query test -- --test-name-pattern "idle gap"`
Expected: FAIL — `active` does not exist on `RecappedTask`.

- [ ] **Step 3: Implement**

In `packages/query/src/recap.ts`:

```ts
import { IDLE_GAP_MINUTES } from "./overlap.js";

export interface RecappedTask {
  // ...existing fields unchanged...
  /** True while the task's last observed event is inside the idle gap. */
  readonly active: boolean;
}
```

In the `all` mapping (around line 151):

```ts
const activeMs = IDLE_GAP_MINUTES * 60_000;
const all: RecappedTask[] = [...tasks.entries()].map(([taskId, accumulator]) => {
  // ...
  return {
    // ...existing fields...
    active: now.getTime() - new Date(accumulator.endedAt).getTime() <= activeMs,
  };
});
```

In `renderRecap`, replace the range line:

```ts
const span = task.active
  ? `${task.startedAt} · last activity ${Math.max(1, Math.round((Date.parse(/* now */) - Date.parse(task.endedAt)) / 60_000))} min ago (may still be running)`
  : `${task.startedAt} to ${task.endedAt}`;
```

`renderRecap` has no `now`; thread it through by adding an optional `nowIso` to `RecapResult` set from `recapRecentWork`'s `now`, defaulting to render-time. Keep the line under one sentence.

- [ ] **Step 4: Run tests**

Run: `corepack pnpm --filter patchmesh-query test`
Expected: PASS (new tests green; no existing recap assertions break — if one asserted the literal `X to Y` string for a fresh task, update it to expect the active rendering).

- [ ] **Step 5: Gate and commit**

Run: `corepack pnpm check`
Expected: exit 0

```bash
git add packages/query/src/recap.ts packages/query/test/recap.test.ts
git commit -m "Recap reports task liveness instead of closing open tasks"
```

---

### Task 2: Recent-write reader and delivery cursor (P1 core)

**Files:**
- Create: `packages/recorder/src/recent-writes.ts`
- Modify: `packages/recorder/src/inflight.ts` (export `journalFilesFor`)
- Test: `packages/recorder/test/recent-writes.test.ts`

**Interfaces:**
- Produces:
  - `readRecentWrites(options): readonly RecentWrite[]`
  - `watermarkPathFor(worktreeRoot, directory, sessionId): string`
  - `readWatermark(path, nowIso): string` — absent/corrupt ⇒ `nowIso` (first contact arms, never dumps history)
  - `advanceWatermark(path, iso): void` — atomic replace-write
  - `RECENT_WRITE_MINUTES = 30`

- [ ] **Step 1: Export the shared journal-file lister**

In `packages/recorder/src/inflight.ts`, change `function journalFilesFor(` to `export function journalFilesFor(`. No other change.

- [ ] **Step 2: Write failing tests**

Create `packages/recorder/test/recent-writes.test.ts` following the seeding pattern in `inflight.test.ts` (an `entry(root, payload, at)` helper that appends via `appendJournalEntry`):

```ts
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
  writeFileSync(path, "{not json", "utf8");
  assert.equal(readWatermark(path, "2026-08-25T12:00:00.000Z"), "2026-08-25T12:00:00.000Z");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern "recent"`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `recent-writes.ts`**

Imports allowed: `node:fs`, `node:path`, `./journal.js`. No protocol, no storage.

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentIdForSession } from "./identity.js";
import { JOURNAL_FILENAME, parseJournalLine } from "./journal.js";
import { journalFilesFor } from "./inflight.js";

export const RECENT_WRITE_MINUTES = 30;

export interface RecentWrite {
  readonly at: string;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly path: string;
}

export interface ReadRecentWritesOptions {
  readonly worktreeRoot: string;
  readonly directory?: string | undefined;
  readonly now?: (() => Date) | undefined;
  /** Skip this session's own entries. */
  readonly excludeSessionId?: string | undefined;
  /** Only entries strictly after this ISO timestamp (the delivery watermark). */
  readonly sinceIso?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function readRecentWrites(options: ReadRecentWritesOptions): readonly RecentWrite[] {
  const journalPath = join(options.worktreeRoot, options.directory ?? ".patchmesh", JOURNAL_FILENAME);
  const now = (options.now ?? (() => new Date()))().getTime();
  const windowMs = RECENT_WRITE_MINUTES * 60_000;
  const writes: RecentWrite[] = [];
  for (const file of journalFilesFor(journalPath)) {
    let contents: string;
    try { contents = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of contents.split("\n")) {
      const entry = parseJournalLine(line);
      if (entry === null || !isRecord(entry.payload)) continue;
      const payload = entry.payload;
      if (payload["hook_event_name"] !== "PostToolUse") continue;
      if (options.excludeSessionId !== undefined && payload["session_id"] === options.excludeSessionId) continue;
      const toolInput = isRecord(payload["tool_input"]) ? payload["tool_input"] : {};
      const path = stringField(toolInput, "file_path");
      if (path === null) continue;
      const age = now - new Date(entry.at).getTime();
      if (age < 0 || age > windowMs) continue;
      if (options.sinceIso !== undefined && entry.at <= options.sinceIso) continue;
      const sessionId = stringField(payload, "session_id");
      writes.push({
        at: entry.at,
        sessionId,
        agentId: sessionId === null ? null : agentIdForSession(sessionId),
        hostToolName: stringField(payload, "tool_name") ?? "unknown",
        path,
      });
    }
  }
  writes.sort((left, right) => right.at.localeCompare(left.at)); // newest first
  return writes.slice(0, 50);
}

export function watermarkPathFor(worktreeRoot: string, directory: string, sessionId: string): string {
  return join(worktreeRoot, directory ?? ".patchmesh", "cursors", `${sessionId}.json`);
}

export function readWatermark(path: string, nowIso: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { watermark?: unknown };
    if (typeof parsed.watermark === "string" && !Number.isNaN(Date.parse(parsed.watermark))) {
      return parsed.watermark;
    }
  } catch {
    // Absent or corrupt: arm at now. History is never dumped on first contact.
  }
  advanceWatermark(path, nowIso);
  return nowIso;
}

/** Atomic replace so a concurrent reader never sees a torn cursor. */
export function advanceWatermark(path: string, at: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ watermark: at }), "utf8");
    renameSync(temporary, path);
  } catch {
    try { writeFileSync(path, JSON.stringify({ watermark: at }), "utf8"); } catch { /* advisory-only */ }
  }
}
```

Note: `readWatermark` arms on first contact as a side effect — that is deliberate and is what the "first contact" test asserts.

- [ ] **Step 5: Run tests**

Run: `corepack pnpm --filter patchmesh-recorder test`
Expected: PASS including the import-graph guard in `journal.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/inflight.ts packages/recorder/src/recent-writes.ts packages/recorder/test/recent-writes.test.ts
git commit -m "Add the recent-write reader and per-session delivery cursor"
```

---

### Task 3: Rewire all three advisory stages onto the new predicate (P1)

**Files:**
- Modify: `packages/recorder/src/advisory.ts`
- Modify: `packages/recorder/src/bin.ts`
- Test: `packages/recorder/test/advisory.test.ts`

**Interfaces:**
- Consumes: Task 2's `readRecentWrites`, `watermarkPathFor`, `readWatermark`, `advanceWatermark`.
- Produces: same exported function names (`computeContentionAdvisory`, `computePostWriteAdvisory`, `computeTurnStartAdvisory`); advisory objects gain optional internal fields `cursorPath?: string` and `advanceTo?: string` consumed by `bin.ts`.

- [ ] **Step 1: Write failing tests**

Append to `packages/recorder/test/advisory.test.ts` (it already has `seedInFlight`, `preToolUsePayload`, `postToolUsePayload`, `turnStartPayload`-style helpers — reuse them; add a `seedWrite` helper that appends a **PostToolUse** entry):

```ts
function seedWrite(root: string, session: string, path: string, at: string) {
  appendJournalEntry(
    join(root, ".patchmesh", "journal.ndjson"),
    { hook_event_name: "PostToolUse", session_id: session, tool_name: "Edit",
      tool_use_id: `done-${Math.random()}`, tool_input: { file_path: path }, tool_response: {} },
    at,
  );
}

test("PreToolUse fires when another session recently wrote the path", () => {
  const root = freshRoot();
  seedWrite(root, OTHER_SESSION, "src/shared.ts", "2026-08-24T11:56:00.000Z");
  const advisory = computeContentionAdvisory({
    worktreeRoot: root,
    payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });
  assert.match(advisory?.message ?? "", /wrote `src\/shared\.ts` 4 minutes ago/);
});

test("the same fact is delivered once — the second look is silent", () => {
  const root = freshRoot();
  seedWrite(root, OTHER_SESSION, "src/shared.ts", "2026-08-24T11:56:00.000Z");
  const options = {
    worktreeRoot: root,
    payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  };
  assert.ok(computeContentionAdvisory(options) !== null);
  assert.equal(computeContentionAdvisory(options), null);
});

test("PostToolUse framing adds the just-written clause", () => {
  const root = freshRoot();
  seedWrite(root, OTHER_SESSION, "src/shared.ts", "2026-08-24T11:58:30.000Z");
  const advisory = computePostWriteAdvisory({
    worktreeRoot: root,
    payload: postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });
  assert.match(advisory?.message ?? "", /You just wrote `src\/shared\.ts` too\./);
});

test("turn-start names recent cross-agent paths once each", () => {
  const root = freshRoot();
  seedWrite(root, OTHER_SESSION, "src/a.ts", "2026-08-24T11:50:00.000Z");
  seedWrite(root, "third", "src/b.ts", "2026-08-24T11:55:00.000Z");
  const advisory = computeTurnStartAdvisory({
    worktreeRoot: root,
    payload: { hook_event_name: "UserPromptSubmit", session_id: OWN_SESSION },
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });
  assert.deepEqual([...advisory?.paths ?? []].sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal(computeTurnStartAdvisory({
    worktreeRoot: root,
    payload: { hook_event_name: "UserPromptSubmit", session_id: OWN_SESSION },
    now: () => new Date("2026-08-24T12:00:05.000Z"),
  }), null);
});
```

Existing in-flight tests stay passing: keep the in-flight check running *before* the recent-write check, so `seedInFlight`-based tests still fire.

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern "recently wrote|delivered once|just-written|recent cross-agent"`
Expected: FAIL.

- [ ] **Step 3: Implement in `advisory.ts`**

Add import: `import { advanceWatermark, readRecentWrites, readWatermark, watermarkPathFor } from "./recent-writes.js";`

Extend both content-advisory interfaces privately:

```ts
interface DeliveredFact {
  readonly cursorPath: string;
  readonly advanceTo: string;
}

interface ContentAdvisory extends ContentionAdvisory {
  readonly delivery?: DeliveredFact | undefined;
}
```

Change `computeAdvisoryFor` so that after the existing in-flight lookup misses, it consults recent writes:

```ts
const collision = inFlight.find((call) => call.operation === path);
if (collision !== undefined) {
  return { /* existing construction, no delivery */ };
}

// Nothing in flight right now; the honest next question is who wrote here lately and whether
// this session was told. Facts are delivered once per session through the cursor.
const now = (options.now ?? (() => new Date()))();
const sessionId = stringField(payload, "session_id") ?? "";
if (sessionId === "") return null;
const cursorPath = watermarkPathFor(options.worktreeRoot, options.directory ?? ".patchmesh", sessionId);
const watermark = readWatermark(cursorPath, now.toISOString());
const write = readRecentWrites({
  worktreeRoot: options.worktreeRoot,
  directory: options.directory,
  now: options.now,
  excludeSessionId: sessionId,
  sinceIso: watermark,
}).find((candidate) => candidate.path === path);
if (write === undefined) return null;

return {
  path,
  agentId: write.agentId,
  hostToolName: write.hostToolName,
  runningForMs: now.getTime() - new Date(write.at).getTime(),
  message: renderRecentWriteMessage(stage, path, write.hostToolName, write.agentId, now.getTime() - new Date(write.at).getTime()),
  delivery: { cursorPath, advanceTo: write.at },
};
```

New renderer beside `renderMessage`:

```ts
function renderRecentWriteMessage(
  stage: AdvisoryStage, path: string, hostToolName: string,
  agentId: string | null, agoMs: number,
): string {
  const minutes = Math.max(Math.round(agoMs / 60_000), 1);
  const agentLabel = agentId ?? "an unidentified agent";
  const observation = `${agentLabel} wrote \`${path}\` (${hostToolName}) ${minutes} minute(s) ago.`;
  const afterTheFact = stage === "PostToolUse" ? ` You just wrote \`${path}\` too.` : "";
  return `${observation}${afterTheFact} Same file does not mean same work.`;
}
```

Update `computeTurnStartAdvisory`: after the existing in-flight loop, merge recent unreported writes (same cursor/watermark pattern, repository-wide — no path filter), dedupe paths, cap at `TURN_START_PATH_LIMIT`, and attach `delivery: { cursorPath, advanceTo: <newest delivered entry at> }` when anything came from the recent-write side. Return type gains the optional `delivery` field.

- [ ] **Step 4: Deliver-then-advance in `bin.ts`**

In all three emit functions, after the successful `process.stdout.write(...)` call:

```ts
if (advisory.delivery !== undefined) {
  try { advanceWatermark(advisory.delivery.cursorPath, advisory.delivery.advanceTo); } catch { /* advisory-only */ }
}
```

Import `advanceWatermark` and `type` nothing else new. The watermark advances **only after** the fact reached stdout, so a failed write loses the message but not the channel.

- [ ] **Step 5: Run tests**

Run: `corepack pnpm --filter patchmesh-recorder test`
Expected: PASS — all existing advisory tests plus the new ones.

- [ ] **Step 6: Gate and commit**

Run: `corepack pnpm check`

```bash
git add packages/recorder/src/advisory.ts packages/recorder/src/bin.ts packages/recorder/test/advisory.test.ts
git commit -m "Advisories fire on recent cross-agent writes, delivered once per session"
```

---

### Task 4: Count opaque in-flight calls in the overlap answer (P2/P4)

**Files:**
- Modify: `packages/query/src/overlap.ts`
- Test: `packages/query/test/overlap.test.ts`

**Interfaces:**
- Produces: `OverlapResult.liveOpaqueCalls: number` — count of in-flight calls whose host tool carries no path.

- [ ] **Step 1: Failing test**

```ts
test("opaque in-flight calls are counted, not path-guessed", () => {
  // Seed one Edit in flight on shared.ts and two Bash calls in flight (command text only).
  // Existing helper style: append PreToolUse entries with no matching PostToolUse.
  const result = findOverlappingWork({ worktreeRoot: repo.root, ledgerPath: repo.ledgerPath });
  assert.equal(result.live.length, 1);
  assert.equal(result.liveOpaqueCalls, 2);
});
```

- [ ] **Step 2: Verify failure** — run `corepack pnpm --filter patchmesh-query test -- --test-name-pattern opaque`. Expected FAIL (field missing).

- [ ] **Step 3: Implement**

In `liveContentionFrom`, also count and return opaque calls. Change its return to `{ live, opaque }` (internal shape), and in `findOverlappingWork` set `liveOpaqueCalls: opaque`. Add `readonly liveOpaqueCalls: number` to `OverlapResult` and to the early-return object (as `0`). In `renderOverlap`, where the live section renders, append when count > 0:

```ts
lines.push(`(${result.liveOpaqueCalls} shell call(s) in flight nearby - which files they touch is unknown.)`);
```

Every constructor of `OverlapResult` in the codebase must gain the field (grep `eventsObserved:` — the same places).

- [ ] **Step 4: Tests pass, gate, commit**

Run `corepack pnpm --filter patchmesh-query test`, then `corepack pnpm check`.

```bash
git add packages/query/src/overlap.ts packages/query/test/overlap.test.ts
git commit -m "Overlap answers count opaque in-flight calls instead of ignoring them"
```

---

### Task 5: Declared-path binding and labelled attribution basis (P3)

**Files:**
- Modify: `packages/recorder/src/effects.ts`
- Modify: `packages/recorder/src/ingest.ts` (where `EffectAttributionCall`s are pushed)
- Modify: `packages/protocol/src/events.ts` (`ResourceChangedPayload`)
- Modify: `schemas/phase0/v1/event-payloads.schema.json` (`resourceChanged`)
- Test: `packages/recorder/test/effects.test.ts` (or wherever `soleCallCovering` tests live — grep first), `packages/protocol/test/protocol.test.ts`

**Interfaces:**
- Produces:
  - `EffectAttributionCall` gains `readonly declaredPath: string | null`.
  - `ResourceChangedPayload` gains optional `attribution?: "call" | "turn"`.

- [ ] **Step 1: Failing tests**

In the effects/attribution test file (locate with `rg "soleCallCovering|EffectAttributionCall" packages/recorder/test`):

```ts
test("a change binds to the one call that declared its path even outside the mtime window", () => {
  // Two overlapping windows would previously return null (ambiguous). Now the single call
  // that declared the path binds regardless of mtimes.
  const change = observedChange("src/auth.ts"); // helper building ObservedFileChange; stat-independent
  const owner = bindChange(change, [
    call({ declaredPath: "src/auth.ts", startedAtMs: 0, completedAtMs: 100 }),
    call({ declaredPath: null, startedAtMs: 0, completedAtMs: 100 }),
  ]);
  assert.equal(owner?.declaredPath, "src/auth.ts");
});

test("two calls declaring the same path stay ambiguous and fall back to the mtime rule", () => {
  const change = observedChange("src/auth.ts");
  const owner = bindChange(change, [
    call({ declaredPath: "src/auth.ts", startedAtMs: 0, completedAtMs: 50 }),
    call({ declaredPath: "src/auth.ts", startedAtMs: 0, completedAtMs: 100 }),
  ]);
  // Neither window uniquely contains a plausible mtime here -> null, per the sole-containment rule.
  assert.equal(owner, null);
});

test("file.changed events carry their attribution basis", () => {
  const bound = fileChangedEventWith({ owner: someCall });
  assert.equal((bound.payload as { attribution?: string }).attribution, "call");
  const turnOwned = fileChangedEventWith({ owner: null });
  assert.equal((turnOwned.payload as { attribution?: string }).attribution, "turn");
});
```

Structure these against whatever helpers exist; the contract under test: exactly-one-declared-path wins over mtimes; ambiguity falls back; payload carries `attribution`.

- [ ] **Step 2: Verify failure**, then implement

`effects.ts`:

```ts
export interface EffectAttributionCall {
  // ...existing fields...
  /** Logical path the host declared for this call, or null (Bash et al.). */
  readonly declaredPath: string | null;
}

function bindChange(
  worktreeRoot: string,
  change: ObservedFileChange,
  calls: readonly EffectAttributionCall[],
): EffectAttributionCall | null {
  const declaring = calls.filter((call) => call.declaredPath !== null && call.declaredPath === change.path);
  if (declaring.length === 1) return declaring[0]!;
  // Zero or several declarers: the sole-window rule decides, exactly as before.
  return soleCallCovering(worktreeRoot, change, calls);
}
```

Replace the `soleCallCovering(...)` call site in `observeTurnEffects` with `bindChange(...)`. In `ingest.ts` where `calls.push({...})` happens (~line 333), add:

```ts
const declaredRaw = stringFieldOf(entry.payload, "tool_input", "file_path");
declaredPath: declaredRaw === null ? null : logicalPathFor(worktreeRoot, declaredRaw),
```

(matching how `hook.ts:138-139` normalizes; reuse `logicalPathFor` already imported there). Also normalize `change.path` comparisons — `ObservedFileChange.path` is already the normalized relative form.

Protocol: in `packages/protocol/src/events.ts`, `ResourceChangedPayload` gains `readonly attribution?: "call" | "turn"`. In `effects.ts` `fileChangedEvent`, payload gains `attribution: owner === null ? "turn" : "call"` — wait: `owner` there is the result of binding; use the actual variable holding the bind result. Schema: in `resourceChanged` add `"attribution": { "enum": ["call", "turn"] }` — NOT required, so old ledgers replay unchanged.

- [ ] **Step 3: Tests pass, gate, commit**

Run: `corepack pnpm --filter patchmesh-recorder test && corepack pnpm --filter patchmesh-protocol test && node tools/phase0/validate.mjs && corepack pnpm check`

```bash
git add packages/recorder/src/effects.ts packages/recorder/src/ingest.ts packages/protocol/src/events.ts schemas/phase0/v1/event-payloads.schema.json packages/protocol/schemas/phase0/v1/event-payloads.schema.json
git commit -m "Bind changes by declared path first, and label every change's attribution basis"
```

(Note: the protocol package keeps a copied schema tree — `git status` will show which copy changed; stage what actually changed.)

---

### Task 6: Host-resolved provenance (P6)

**Files:**
- Modify: `packages/recorder/src/hook.ts` (source construction, ~line 143)
- Modify: `apps/cli/src/doctor.ts` (report resolved host)
- Test: `packages/recorder/test/hook.test.ts` or `recorder.test.ts` (wherever `buildHookEvents` is tested), `apps/cli/test/doctor.test.ts` if present

**Interfaces:**
- Produces: `resolveSourceHost(): string` in `packages/recorder/src/record.ts` (or a new tiny `source.ts` if record.ts has heavy imports — check first; hook.ts must not gain imports beyond siblings/builtins).

- [ ] **Step 1: Failing test**

```ts
test("provenance follows PATCHMESH_HOST, defaults to claude-code", () => {
  process.env.PATCHMESH_HOST = "opencode";
  assert.equal(resolveSourceHost(), "opencode");
  delete process.env.PATCHMESH_HOST;
  assert.equal(resolveSourceHost(), "claude-code");
});

test("buildHookEvents stamps source_<host>_hook", () => {
  process.env.PATCHMESH_HOST = "opencode";
  const pair = buildHookEvents({ payload: validEditPayload, worktreeRoot: root });
  delete process.env.PATCHMESH_HOST;
  assert.equal(pair.requested.source.sourceId, "source_opencode_hook");
});
```

Plus: an invalid value (`"Open Code!"`) falls back to `claude-code` (pattern `/^[a-z0-9][a-z0-9._-]{0,31}$/`).

- [ ] **Step 2: Verify failure**, implement

```ts
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function resolveSourceHost(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env["PATCHMESH_HOST"];
  return requested !== undefined && SOURCE_ID_PATTERN.test(requested) ? requested : "claude-code";
}
```

In `hook.ts`, replace the hardcoded `"source_claude_code_hook"` with `` `source_${resolveSourceHost()}_hook` ``. Grep for other occurrences of the literal (`rg "source_claude_code_hook" --type ts`) and route them through the same helper. In `doctor.ts`, add one line to the report: `Host: <resolved>` using the same export.

- [ ] **Step 3: Tests pass, gate, commit**

Run: `corepack pnpm --filter patchmesh-recorder test && corepack pnpm check`

```bash
git add packages/recorder/src apps/cli/src/doctor.ts
git commit -m "Recorder provenance resolves its host instead of hardcoding Claude Code"
```

---

### Task 7: Acceptance — staged two-session contention, end to end

**Files:**
- Create: `packages/recorder/test/contention-acceptance.test.ts`

**Interfaces:**
- Consumes: everything above, through public entry points only (`main()`-level hook simulation like `advisory.test.ts`'s spawn-based tests at lines ~203/362).

- [ ] **Step 1: Write the acceptance test**

Two sessions, one repository, one file, driving the real `bin.ts` `main()` via child stdin (pattern exists at `advisory.test.ts:203`):

1. Session A's `main()` consumes a PostToolUse payload for `src/shared.ts` at T0 (its write lands in the journal).
2. Session B's `main()` consumes a PreToolUse payload for `src/shared.ts` at T0+1s with `PATCHMESH_RECORDER_DEBUG` unset.
3. Assert B's stdout parses as `hookSpecificOutput.permissionDecision === "allow"` and the reason matches /wrote `src\/shared\.ts`/.
4. Run B again with identical input. Assert stdout is empty (cursor suppressed the repeat).
5. Assert B's journal append still happened both times (recording independent of advising).
6. Session B's `main()` consumes a UserPromptSubmit payload; assert stdout is empty again (fact already delivered).

Timestamps are controlled by writing A's journal entry directly with `appendJournalEntry` at an explicit `at`, and B's process reading it within the window — mirror the time control used in `advisory.test.ts` (fixed dates) rather than sleeping.

- [ ] **Step 2: Run**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern "acceptance"`
Expected: PASS.

- [ ] **Step 3: Final gate and commit**

Run: `corepack pnpm check`
Expected: exit 0.

```bash
git add packages/recorder/test/contention-acceptance.test.ts
git commit -m "Acceptance: one warning per cross-agent write, recording unaffected"
```

---

### Task 8: Close P4 in the register and update problem statuses

**Files:**
- Modify: `docs/problems/PM-02-no-intervention-point.md` — status open → resolved-by-recent-write-predicate, link the spec, note the measured zero-firing evidence and the new acceptance test.
- Modify: `docs/problems/PM-08-bash-opacity.md` — record the accepted scope (counted-not-guessed) shipped in Task 4; note the fs.watch spike as named future work with its Windows-timing risk.
- Modify: `docs/problems/ORDER.md` — add a "Wave 2b: coordination realness" section listing the commits.

- [ ] **Step 1: Write the updates** (plain prose edits; statuses match what actually shipped).
- [ ] **Step 2: Gate and commit**

Run: `corepack pnpm check`

```bash
git add docs/problems/
git commit -m "Record the coordination wave in the problems register"
```

---

## Self-review notes

- **Spec coverage:** P5→Task 1, P1→Tasks 2+3+7, P2→Task 4, P3→Task 5, P6→Task 6, P4→Tasks 4+8, register hygiene→Task 8. Complete.
- **Type consistency:** `delivery`/`DeliveredFact` defined in Task 3, consumed in Task 3's bin step; `declaredPath` defined and consumed inside Task 5; `liveOpaqueCalls` defined and rendered in Task 4.
- **Known risk:** Task 5 touches the strictest schema in the repo — run `node tools/phase0/validate.mjs` locally before committing, and expect the corpus fixtures to need no change because the new payload key is optional.
