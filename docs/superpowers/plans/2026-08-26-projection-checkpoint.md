# Projection Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI/MCP graph projections cost O(new events since last read) instead of O(entire ledger), via a persisted projection checkpoint in the ledger database.

**Architecture:** A single-row SQLite table stores the projector's derived state (nodes, edges, findings, decisions, coverage inputs, sequence gaps) plus a watermark (`events.insertion_position`). Reads hydrate the checkpoint, apply only newer events through a new batch `extendProjection`, and best-effort persist the advanced state. Every failure mode falls back to today's full replay. Spec: `docs/superpowers/specs/2026-08-26-projection-checkpoint-design.md`.

**Tech Stack:** TypeScript (strict), `node:sqlite` `DatabaseSync` (Node >=24), `node:test` via `tsx --test`, pnpm workspace. No new dependencies.

## Global Constraints

- Node >=24; `DatabaseSync` from `node:sqlite`; WAL mode already set by `openDatabase` (`packages/storage/src/database.ts:73`) with `busy_timeout = 5000`.
- No new npm dependencies. Hashing uses `node:crypto`.
- Architectural boundary (root `AGENTS.md` §3): all checkpoint code lives in `packages/storage`; query consumes it through storage's public exports; storage never imports query/gateway/core.
- Correctness bar from the spec: snapshots produced incrementally must be **byte-for-byte identical** to `projectWorkGraph(fullLedger).snapshot` serialized with `JSON.stringify`.
- Fail-open rule: no checkpoint read/write failure may change a command's answer or make it throw; worst case is today's full-replay cost.
- Events are append-only and derived state must stay rebuildable (AGENTS.md §10) — deleting the checkpoint row must always leave a correct system.
- Run package checks from repo root: `corepack pnpm --filter patchmesh-storage test`, `corepack pnpm --filter patchmesh-storage typecheck` (same pattern for `patchmesh-query`, `patchmesh-cli`). Root `corepack pnpm check` before the final commit.
- Deviations from spec, recorded here once: (a) the spec's "read only rows past the watermark" applies to *projection input*; query services still read all events for counts/attribution because their views need them — the checkpoint removes the projection cost, which measurement (PM-19) shows is dominant. (b) `freshenLedger` needs no special integration: every cached projection read persists the advanced checkpoint itself, achieving the same zero-delta common case.

## Background the implementer needs

- `WorkGraphState` (`packages/storage/src/work-graph-types.ts`): `{ eventsById: Map<EventId, ProtocolEvent>, correctionsByTarget: Map<EventId, AttributionOverride>, nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>, findings: Map<string, FindingView>, decisions: Map<string, DecisionView>, coverageInputs: WorkGraphState["coverageInputs"] }`. `AttributionOverride` is `{ eventId: EventId; correction: ProtocolEvent }` where `eventId` equals the corrected event's id (the map key).
- `buildProjection` (`work-graph.ts:430`) maps events in two passes: collect `attribution.corrected` into `correctionsByTarget` first, then `mapEvent` every non-correction event through `effectiveEvent`, then `deriveFindingAndDecisionViews` once, then `deriveProjectionCoverage` once. `extendProjection` must mirror exactly this shape over a suffix of events, starting from a checkpointed base state.
- Why byte-identity holds despite insertion-order vs causal-order divergence: `mergeEvidence` appends unsorted but `snapshotFromState` (`work-graph.ts:372`) sorts every evidence array on output; finding/decision views re-sort all events by `eventId`; coverage is re-derived wholesale. No observable value depends on processing order.
- Why a late correction breaks it: a suffix correction targeting a **prefix** event invalidates prefix mappings made under old attribution. `buildProjection` handles this by collecting all corrections before mapping anything; an incremental path cannot retroactively unmap, so it must detect the case and fall back to full rebuild. This is the `null` return of `extendProjection` in Task 2.
- Gaps: `projectWorkGraph` gets `sourceSequenceGaps` from `replayEvents`. When gaps exist, `snapshotFromState(state, gaps)` re-derives coverage from `eventsById` instead of serving `state.coverageInputs` (`work-graph.ts:383-385`). The zero-delta serve path has no `eventsById`, so the checkpoint persists the **already-gap-applied** coverage array and serves it with `gaps = []` internally while reporting the stored gaps to callers.

---

### Task 1: Checkpoint table and persistence I/O

**Files:**
- Create: `packages/storage/src/migrations/004_projection_checkpoint.sql`
- Create: `packages/storage/src/projection-checkpoint.ts`
- Modify: `packages/storage/src/database.ts` (register migration)
- Modify: `packages/storage/src/index.ts` (exports)
- Test: `packages/storage/test/projection-checkpoint.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–3): `PROJECTOR_VERSION: string`; `interface ProjectionCheckpointRecord { projectorVersion: string; lastInsertionPosition: number; gaps: SourceSequenceGap[]; coverageForSnapshot: WorkGraphState["coverageInputs"]; correctionsByTarget: Array<[EventId, AttributionOverride]>; nodes: GraphNode[]; edges: GraphEdge[]; findings: FindingView[]; decisions: DecisionView[] }`; `loadProjectionCheckpoint(database: DatabaseSync): ProjectionCheckpointRecord | null`; `saveProjectionCheckpoint(database: DatabaseSync, record: ProjectionCheckpointRecord): void`; `clearProjectionCheckpoint(database: DatabaseSync): void`; `checkpointRecordHash(record): string`.

- [ ] **Step 1: Write the migration**

`packages/storage/src/migrations/004_projection_checkpoint.sql`:

```sql
CREATE TABLE IF NOT EXISTS projection_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 0),
  projector_version TEXT NOT NULL,
  last_insertion_position INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  state_blob TEXT NOT NULL
);
```

Register it in `packages/storage/src/database.ts` by appending to the `migrations` array, copying the existing entry shape:

```ts
{
  id: "004_projection_checkpoint",
  path: new URL("./migrations/004_projection_checkpoint.sql", import.meta.url),
},
```

- [ ] **Step 2: Write the failing round-trip test**

Create `packages/storage/test/projection-checkpoint.test.ts`. Reuse the fixture-event builders from `packages/storage/test/work-graph.test.ts` (copy the smallest helpers; do not import test files). The test writes an in-memory-shaped record through a real temp-file database:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { openDatabase } from "../src/database.js";
import {
  PROJECTOR_VERSION,
  checkpointRecordHash,
  clearProjectionCheckpoint,
  loadProjectionCheckpoint,
  saveProjectionCheckpoint,
  type ProjectionCheckpointRecord,
} from "../src/projection-checkpoint.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "patchmesh-checkpoint-"));
  dirs.push(dir);
  return openDatabase(join(dir, "ledger.db"));
}

function sampleRecord(): ProjectionCheckpointRecord {
  return {
    projectorVersion: PROJECTOR_VERSION,
    lastInsertionPosition: 42,
    gaps: [],
    coverageForSnapshot: [],
    correctionsByTarget: [],
    nodes: [{
      kind: "agent",
      nodeId: "agent:a",
      agentId: "agent_a",
      evidenceEventIds: ["evt_1", "evt_2"],
    }],
    edges: [],
    findings: [],
    decisions: [],
  };
}

test("checkpoint round-trips through SQLite", () => {
  const database = tempDatabase();
  const record = sampleRecord();
  saveProjectionCheckpoint(database, record);
  assert.deepEqual(loadProjectionCheckpoint(database), record);
});

test("loading with no checkpoint row returns null", () => {
  const database = tempDatabase();
  assert.equal(loadProjectionCheckpoint(database), null);
});

test("saving twice replaces the single row", () => {
  const database = tempDatabase();
  saveProjectionCheckpoint(database, sampleRecord());
  const updated = { ...sampleRecord(), lastInsertionPosition: 43 };
  saveProjectionCheckpoint(database, updated);
  assert.equal(loadProjectionCheckpoint(database)?.lastInsertionPosition, 43);
});

test("clearing removes the checkpoint", () => {
  const database = tempDatabase();
  saveProjectionCheckpoint(database, sampleRecord());
  clearProjectionCheckpoint(database);
  assert.equal(loadProjectionCheckpoint(database), null);
});

test("a tampered blob fails hash verification", () => {
  const database = tempDatabase();
  const record = sampleRecord();
  saveProjectionCheckpoint(database, record);
  database.exec("UPDATE projection_checkpoint SET state_blob = replace(state_blob, '42', '43')");
  const loaded = loadProjectionCheckpoint(database);
  assert.equal(loaded, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `corepack pnpm --filter patchmesh-storage test`
Expected: FAIL — `Cannot find module '../src/projection-checkpoint.js'`.

- [ ] **Step 4: Implement `projection-checkpoint.ts`**

```ts
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventId, ProtocolEvent } from "patchmesh-protocol";
import type { SourceSequenceGap } from "./replay.js";
import type {
  AttributionOverride,
  DecisionView,
  FindingView,
  GraphEdge,
  GraphNode,
  WorkGraphState,
} from "./work-graph-types.js";

/**
 * Bump whenever projection output could change for identical input: detector logic,
 * coverage derivation, evidence merging, view shapes. A stored version that differs from
 * this constant is treated as no checkpoint at all, never as an error.
 */
export const PROJECTOR_VERSION = "1";

export interface ProjectionCheckpointRecord {
  readonly projectorVersion: string;
  readonly lastInsertionPosition: number;
  readonly gaps: SourceSequenceGap[];
  readonly coverageForSnapshot: WorkGraphState["coverageInputs"];
  readonly correctionsByTarget: Array<[EventId, AttributionOverride]>;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly findings: FindingView[];
  readonly decisions: DecisionView[];
}

interface StoredRow {
  readonly projector_version: string;
  readonly last_insertion_position: number;
  readonly state_hash: string;
  readonly state_blob: string;
}

function canonicalStable(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Map) return [...nested.entries()];
    return nested;
  });
}

export function checkpointRecordHash(record: ProjectionCheckpointRecord): string {
  return createHash("sha256").update(canonicalStable(record)).digest("hex");
}

export function loadProjectionCheckpoint(database: DatabaseSync): ProjectionCheckpointRecord | null {
  const rows = database
    .prepare(
      "SELECT projector_version, last_insertion_position, state_hash, state_blob FROM projection_checkpoint WHERE id = 0",
    )
    .all() as unknown as StoredRow[];
  const row = rows[0];
  if (row === undefined) return null;
  let parsed: ProjectionCheckpointRecord;
  try {
    parsed = JSON.parse(row.state_blob) as ProjectionCheckpointRecord;
  } catch {
    return null;
  }
  if (checkpointRecordHash(parsed) !== row.state_hash) return null;
  return parsed;
}

export function saveProjectionCheckpoint(database: DatabaseSync, record: ProjectionCheckpointRecord): void {
  const blob = JSON.stringify(record);
  const hash = createHash("sha256").update(blob).digest("hex");
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projection_checkpoint (id, projector_version, last_insertion_position, state_hash, state_blob)
         VALUES (0, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           projector_version = excluded.projector_version,
           last_insertion_position = excluded.last_insertion_position,
           state_hash = excluded.state_hash,
           state_blob = excluded.state_blob`,
      )
      .run(record.projectorVersion, record.lastInsertionPosition, hash, blob);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function clearProjectionCheckpoint(database: DatabaseSync): void {
  database.prepare("DELETE FROM projection_checkpoint WHERE id = 0").run();
}
```

Note: `canonicalStable` is intentionally unused by the hash (which hashes the exact stored blob) — delete it if the linter complains, keeping `checkpointRecordHash` hashing the exact `JSON.stringify(record)` string that `saveProjectionCheckpoint` stores. The two must be the same serialization or the tamper test lies. Final shape: one `serializeRecord(record): string` helper used by both save and hash.

Add to `packages/storage/src/index.ts`:

```ts
export {
  PROJECTOR_VERSION,
  checkpointRecordHash,
  clearProjectionCheckpoint,
  loadProjectionCheckpoint,
  saveProjectionCheckpoint,
  type ProjectionCheckpointRecord,
} from "./projection-checkpoint.js";
```

- [ ] **Step 5: Run tests until green**

Run: `corepack pnpm --filter patchmesh-storage test`
Expected: PASS (new file green, existing suite unaffected).

- [ ] **Step 6: Typecheck and commit**

Run: `corepack pnpm --filter patchmesh-storage typecheck`

```bash
git add packages/storage/src/migrations/004_projection_checkpoint.sql packages/storage/src/projection-checkpoint.ts packages/storage/src/database.ts packages/storage/src/index.ts packages/storage/test/projection-checkpoint.test.ts
git commit -m "Persist a projection checkpoint beside the ledger"
```

---

### Task 2: Batch delta application (`extendProjection`) and exported helpers

**Files:**
- Modify: `packages/storage/src/work-graph.ts`
- Modify: `packages/storage/src/replay.ts` (export `causalOrder`, `sourceSequenceGaps`)
- Test: `packages/storage/test/work-graph.test.ts` (append cases)

**Interfaces:**
- Consumes: existing internals of `work-graph.ts` (`initialState`, `mapEvent`, `effectiveEvent`, `addEnvelopeNodes`, `deriveFindingAndDecisionViews`, `deriveProjectionCoverage`).
- Produces: `extendProjection(base: WorkGraphState, suffixEvents: readonly ProtocolEvent[]): WorkGraphState | null` — `null` means "a suffix correction targets an event outside the suffix; rebuild fully"; `export function snapshotFromState(...)` (drop `function` privacy); from `replay.ts`: `export { causalOrder, sourceSequenceGaps }` with signatures `(events: readonly ProtocolEvent[]) => readonly ProtocolEvent[]` and `(events: readonly ProtocolEvent[]) => readonly SourceSequenceGap[]`; and `WorkGraphReplayResult` gains `readonly state: WorkGraphState` (`work-graph-types.ts:126`, populated by `projectWorkGraph` at `work-graph.ts:457` from the state it already builds — needed by Task 3's checkpoint persistence).

- [ ] **Step 1: Write the failing byte-identity tests**

Append to `packages/storage/test/work-graph.test.ts` (reuse that file's existing event-builder helpers; the builders below reference whatever helpers the file already defines for `tool.requested`, `tool.completed`, `file.changed`, and `attribution.corrected` — if a kind of builder is missing, copy the smallest one from `fixtures/scenarios/v1` usage elsewhere in the file):

```ts
import { extendProjection, initialState } from "../src/work-graph.js";

test("extending a prefix projection equals projecting the whole ledger", () => {
  const all = buildScenarioEvents(60); // deterministic mixed request/completion/change events
  const cut = 45;
  const prefixState = buildProjectionForTest(all.slice(0, cut)); // see helper below
  const extended = extendProjection(prefixState, all.slice(cut));
  assert.notEqual(extended, null);
  assert.equal(
    JSON.stringify(snapshotFromStateForTest(extended!, [])),
    JSON.stringify(projectWorkGraph(all).snapshot),
  );
});

test("a suffix correction targeting a prefix event reports rebuild", () => {
  const all = buildScenarioEvents(10);
  const correction = buildAttributionCorrection(all[0].eventId); // targets the very first event
  const prefixState = buildProjectionForTest(all);
  assert.equal(extendProjection(prefixState, [correction]), null);
});

test("a suffix correction targeting another suffix event still matches full replay", () => {
  const pair = buildRequestWithCompletion(); // [requested, completed] sharing correlation
  const correction = buildAttributionCorrection(pair[1].eventId);
  const prefixState = buildProjectionForTest([]);
  const extended = extendProjection(prefixState, [...pair, correction]);
  assert.notEqual(extended, null);
  assert.equal(
    JSON.stringify(snapshotFromStateForTest(extended!, [])),
    JSON.stringify(projectWorkGraph([...pair, correction]).snapshot),
  );
});
```

Add local helpers at the bottom of the test file (they wrap non-exported pieces through the new public surface):

```ts
function buildProjectionForTest(events: readonly ProtocolEvent[]): WorkGraphState {
  let state = initialState();
  for (const event of events) state = applyReducerForTest(state, event);
  return state;
}
```

If `applyEvent` is not reachable, export a minimal `reduceEvents(events: readonly ProtocolEvent[]): WorkGraphState` from `work-graph.ts` that folds `applyEvent` (used ONLY by tests and the Task 3 fallback-free path — it is O(k·n log n) and must not be used for large k):

```ts
export function reduceEvents(orderedEvents: readonly ProtocolEvent[]): WorkGraphState {
  const reducer = new WorkGraphProjector();
  let state = reducer.initialState();
  for (const event of orderedEvents) state = reducer.apply(state, event);
  return state;
}
```

and export `snapshotFromState` directly (change `function snapshotFromState(` to `export function snapshotFromState(`). Then `buildProjectionForTest = (events) => reduceEvents(events)` and `snapshotFromStateForTest = snapshotFromState`.

Also add the `state` field Task 3 depends on — in `packages/storage/src/work-graph-types.ts`:

```ts
export interface WorkGraphReplayResult {
  readonly orderedEvents: readonly ProtocolEvent[];
  readonly sourceSequenceGaps: readonly SourceSequenceGap[];
  readonly snapshot: WorkGraphSnapshot;
  readonly state: WorkGraphState;
}
```

and in `projectWorkGraph` (`work-graph.ts:457`) return it from the state already in hand:

```ts
return {
  orderedEvents: replay.orderedEvents,
  sourceSequenceGaps: replay.sourceSequenceGaps,
  state,
  snapshot: snapshotFromState(state, replay.sourceSequenceGaps),
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter patchmesh-storage test -- test/work-graph.test.ts`
Expected: FAIL — `extendProjection` not exported.

- [ ] **Step 3: Implement `extendProjection` in `work-graph.ts`**

Place it directly after `buildProjection`, reusing the same private helpers:

```ts
/**
 * Apply a suffix of events to an already-projected base state, deferring every whole-ledger
 * derivation to once after the batch — the same discipline that makes `buildProjection` linear.
 *
 * Returns null when a suffix `attribution.corrected` targets an event outside the suffix: the
 * prefix was mapped under the old attribution and cannot be unmapped incrementally, so the
 * caller must discard its checkpoint and rebuild with `projectWorkGraph`. A correction inside
 * the suffix is fine — corrections are collected before any suffix event is mapped, matching
 * `buildProjection`'s two-pass shape.
 *
 * Byte-identity with `buildProjection(prefix ++ suffix)` rests on three facts: evidence arrays
 * accumulate in processing order but `snapshotFromState` sorts them on output; finding and
 * decision views re-sort every event by id; coverage is re-derived wholesale. Nothing else
 * observes processing order.
 */
export function extendProjection(
  base: WorkGraphState,
  suffixEvents: readonly ProtocolEvent[],
): WorkGraphState | null {
  const suffixIds = new Set(suffixEvents.map((event) => event.eventId));
  for (const event of suffixEvents) {
    if (event.eventType === "attribution.corrected" && !suffixIds.has(event.payload.targetEventId)) {
      return null;
    }
  }

  const next: WorkGraphState = {
    eventsById: new Map(base.eventsById),
    correctionsByTarget: new Map(base.correctionsByTarget),
    nodes: new Map(base.nodes),
    edges: new Map(base.edges),
    findings: new Map(base.findings),
    decisions: new Map(base.decisions),
    coverageInputs: [...base.coverageInputs],
  };

  for (const event of suffixEvents) {
    next.eventsById.set(event.eventId, event);
    if (event.eventType === "attribution.corrected") {
      next.correctionsByTarget.set(event.payload.targetEventId, {
        eventId: event.payload.targetEventId,
        correction: event,
      });
    }
  }
  for (const event of suffixEvents) {
    if (event.eventType === "attribution.corrected") {
      addEnvelopeNodes(next, event);
      continue;
    }
    mapEvent(next, effectiveEvent(event, next.correctionsByTarget));
  }
  deriveFindingAndDecisionViews(next);

  return {
    ...next,
    coverageInputs: deriveProjectionCoverage([...next.eventsById.values()], [], next.correctionsByTarget),
  };
}
```

In `replay.ts`, change `function causalOrder(` and `function sourceSequenceGaps(` to exported functions.

Export from `packages/storage/src/index.ts`: `extendProjection`, `reduceEvents` (if added), and re-export nothing else new.

- [ ] **Step 4: Run the storage suite**

Run: `corepack pnpm --filter patchmesh-storage test && corepack pnpm --filter patchmesh-storage typecheck`
Expected: PASS — including the existing scaling guard (`projection cost stays near-linear...`), which must keep passing unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/work-graph.ts packages/storage/src/replay.ts packages/storage/src/index.ts packages/storage/test/work-graph.test.ts
git commit -m "Extend a projected graph state with a suffix of events"
```

---

### Task 3: The cached projection (`projectWorkGraphCached`)

**Files:**
- Modify: `packages/storage/src/event-store.ts` (`EventQuery.afterPosition`, `latestPosition()`, database handle getter)
- Create: `packages/storage/src/projection-cache.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/projection-cache.test.ts`

**Interfaces:**
- Consumes: Task 1's `loadProjectionCheckpoint`/`saveProjectionCheckpoint`/`ProjectionCheckpointRecord`/`PROJECTOR_VERSION`; Task 2's `extendProjection`/`reduceEvents`/`snapshotFromState`/`causalOrder`/`sourceSequenceGaps`; existing `SqliteEventStore.open/read`, `projectWorkGraph`, `openDatabase`.
- Produces: `projectWorkGraphCached(ledgerPath: string, options?: { readonly verify?: boolean }): WorkGraphReplayResult` — same shape as `projectWorkGraph` (`{ orderedEvents, sourceSequenceGaps, snapshot }`); `projectionCacheStats(): { fullRebuilds: number; deltaApplications: number; zeroDeltaServes: number; lastAppliedCount: number }`; `clearProjectionCacheStats(): void`.

- [ ] **Step 1: Write the failing tests**

Create `packages/storage/test/projection-cache.test.ts`. Build a real ledger with `SqliteEventStore` (append the scenario events from Task 2's builders via `store.append(event)`; copy the append-error handling from `event-store.test.ts` if duplicates matter — they do not here):

```ts
import { SqliteEventStore, projectWorkGraph, projectWorkGraphCached, projectionCacheStats, clearProjectionCacheStats } from "../src/index.js";

function buildLedger(events: readonly ProtocolEvent[]): string {
  const path = join(tempDir(), "ledger.db");
  const store = SqliteEventStore.open(path);
  try {
    for (const event of events) store.append(event);
  } finally {
    store.close();
  }
  return path;
}

test("first read rebuilds fully; second read of an unchanged ledger applies zero events", () => {
  clearProjectionCacheStats();
  const path = buildLedger(buildScenarioEvents(30));
  const first = projectWorkGraphCached(path);
  assert.equal(projectionCacheStats().lastAppliedCount > 0, true);
  const second = projectWorkGraphCached(path);
  assert.equal(JSON.stringify(second.snapshot), JSON.stringify(first.snapshot));
  const stats = projectionCacheStats();
  assert.equal(stats.zeroDeltaServes, 1);
  assert.equal(stats.lastAppliedCount, 0);
});

test("an appended suffix is applied incrementally and stays byte-identical to full replay", () => {
  clearProjectionCacheStats();
  const early = buildScenarioEvents(25);
  const path = buildLedger(early);
  projectWorkGraphCached(path);

  const later = buildScenarioEvents(40); // superset generator: first 25 identical ids
  const store = SqliteEventStore.open(path);
  try {
    for (const event of later.slice(25)) store.append(event);
  } finally {
    store.close();
  }

  const incremental = projectWorkGraphCached(path);
  const full = projectWorkGraph(later);
  assert.equal(JSON.stringify(incremental.snapshot), JSON.stringify(full.snapshot));
  assert.deepEqual(incremental.sourceSequenceGaps, full.sourceSequenceGaps);
  assert.equal(projectionCacheStats().lastAppliedCount, 15);
});

test("pruning the watermarked row invalidates the checkpoint", () => {
  clearProjectionCacheStats();
  const events = buildScenarioEvents(20);
  const path = buildLedger(events);
  projectWorkGraphCached(path);
  const database = openDatabase(path);
  database.exec("DELETE FROM events"); // brutal prune: the watermarked row cannot survive
  database.close();
  projectWorkGraphCached(path); // must not throw, must serve a correct empty snapshot
  const served = projectWorkGraphCached(path);
  assert.equal(served.snapshot.nodes.length, 0);
});

test("a corrupt checkpoint degrades to full rebuild", () => {
  clearProjectionCacheStats();
  const path = buildLedger(buildScenarioEvents(20));
  projectWorkGraphCached(path);
  const database = openDatabase(path);
  database.exec("UPDATE projection_checkpoint SET state_blob = '{not json'");
  database.close();
  const served = projectWorkGraphCached(path);
  assert.equal(
    JSON.stringify(served.snapshot),
    JSON.stringify(projectWorkGraph(buildScenarioEvents(20)).snapshot),
  );
});

test("verify forces a full validated replay", () => {
  clearProjectionCacheStats();
  const path = buildLedger(buildScenarioEvents(20));
  projectWorkGraphCached(path);
  const verified = projectWorkGraphCached(path, { verify: true });
  assert.equal(
    JSON.stringify(verified.snapshot),
    JSON.stringify(projectWorkGraph(buildScenarioEvents(20)).snapshot),
  );
  // The verified run rewrote the checkpoint, so the next plain read serves zero delta.
  projectWorkGraphCached(path);
  assert.equal(projectionCacheStats().zeroDeltaServes, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter patchmesh-storage test -- test/projection-cache.test.ts`
Expected: FAIL — `projectWorkGraphCached` not exported.

- [ ] **Step 3: Extend the event store**

In `packages/storage/src/event-store.ts`:

(a) `EventQuery` gains one field: `readonly afterPosition?: number;`. In `read()`, alongside the other predicates:

```ts
if (query.afterPosition !== undefined) {
  predicates.push("insertion_position > ?");
  parameters.push(query.afterPosition);
}
```

(b) Public methods on `SqliteEventStore`:

```ts
latestPosition(): number {
  this.assertOpen();
  const rows = this.database.prepare("SELECT MAX(insertion_position) AS position FROM events").all() as unknown as Array<{ readonly position: number | null }>;
  return rows[0]?.position ?? 0;
}

get handle(): DatabaseSync {
  this.assertOpen();
  return this.database;
}
```

(`handle` is documented as storage-internal: checkpoint I/O in this package uses it; nothing outside `packages/storage` may.)

(c) Export `DatabaseSync`-typing import if not already imported.

- [ ] **Step 4: Implement `projection-cache.ts`**

```ts
import type { ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore } from "./event-store.js";
import {
  loadProjectionCheckpoint,
  saveProjectionCheckpoint,
  PROJECTOR_VERSION,
  type ProjectionCheckpointRecord,
} from "./projection-checkpoint.js";
import { causalOrder, sourceSequenceGaps, type SourceSequenceGap } from "./replay.js";
import { extendProjection, projectWorkGraph, reduceEvents, snapshotFromState } from "./work-graph.js";
import { deriveProjectionCoverage } from "./work-graph-coverage.js";
import type { WorkGraphReplayResult, WorkGraphState } from "./work-graph-types.js";

const stats = { fullRebuilds: 0, deltaApplications: 0, zeroDeltaServes: 0, lastAppliedCount: 0 };

export function projectionCacheStats() {
  return { ...stats };
}

export function clearProjectionCacheStats(): void {
  stats.fullRebuilds = 0;
  stats.deltaApplications = 0;
  stats.zeroDeltaServes = 0;
  stats.lastAppliedCount = 0;
}

function recordFromState(state: WorkGraphState, lastInsertionPosition: number, gaps: readonly SourceSequenceGap[]): ProjectionCheckpointRecord {
  return {
    projectorVersion: PROJECTOR_VERSION,
    lastInsertionPosition,
    gaps: structuredClone(gaps) as SourceSequenceGap[],
    // Coverage already gap-applied, so the zero-delta serve can use it with gaps = []:
    coverageForSnapshot: structuredClone(
      gaps.length === 0
        ? state.coverageInputs
        : deriveProjectionCoverage([...state.eventsById.values()], gaps, state.correctionsByTarget),
    ),
    correctionsByTarget: [...state.correctionsByTarget.entries()],
    nodes: [...state.nodes.values()],
    edges: [...state.edges.values()],
    findings: [...state.findings.values()],
    decisions: [...state.decisions.values()],
  };
}

function stateFromRecord(record: ProjectionCheckpointRecord): WorkGraphState {
  return {
    eventsById: new Map(),
    correctionsByTarget: new Map(record.correctionsByTarget),
    nodes: new Map(record.nodes.map((node) => [node.nodeId, node])),
    edges: new Map(record.edges.map((edge) => [edge.edgeId, edge])),
    findings: new Map(record.findings.map((view) => [view.finding.findingId, view])),
    decisions: new Map(record.decisions.map((view) => [view.decision.decisionId, view])),
    coverageInputs: record.coverageForSnapshot,
  };
}

function persistQuietly(store: SqliteEventStore, record: ProjectionCheckpointRecord): void {
  try {
    saveProjectionCheckpoint(store.handle, record);
  } catch {
    // A reader that could not write the checkpoint still answered correctly; the next
    // reader pays the delta again. Never let checkpoint maintenance break a read.
  }
}

export function projectWorkGraphCached(
  ledgerPath: string,
  options: { readonly verify?: boolean } = {},
): WorkGraphReplayResult {
  const store = SqliteEventStore.open(ledgerPath);
  try {
    if (options.verify === true) {
      const events = store.read();
      const result = projectWorkGraph(events);
      persistQuietly(store, recordFromState(result.state, store.latestPosition(), result.sourceSequenceGaps));
      return result;
    }

    const checkpoint = loadProjectionCheckpoint(store.handle);
    const valid =
      checkpoint !== null &&
      checkpoint.projectorVersion === PROJECTOR_VERSION &&
      checkpoint.lastInsertionPosition <= store.latestPosition() &&
      databaseHasPosition(store.handle, checkpoint.lastInsertionPosition);
    if (!valid || checkpoint === null) {
      stats.fullRebuilds += 1;
      const events = store.read();
      const result = projectWorkGraph(events);
      persistQuietly(store, recordFromState(result.state, store.latestPosition(), result.sourceSequenceGaps));
      return result;
    }

    const fresh = store.read({ afterPosition: checkpoint.lastInsertionPosition });
    if (fresh.length === 0) {
      stats.zeroDeltaServes += 1;
      stats.lastAppliedCount = 0;
      const state = stateFromRecord(checkpoint);
      return {
        orderedEvents: Object.freeze([]),
        sourceSequenceGaps: checkpoint.gaps,
        snapshot: snapshotFromState(state, []),
      };
    }

    stats.deltaApplications += 1;
    stats.lastAppliedCount = fresh.length;
    // History is trusted (hash-checked checkpoint); the delta is validated exactly as a
    // full read would validate it.
    const reconstructed = store.read({}, { validate: false });
    const ordered = causalOrder(reconstructed);
    const gaps = sourceSequenceGaps(ordered);
    const base = stateFromRecord(checkpoint);
    base.eventsById = new Map(ordered.map((event) => [event.eventId, event]));
    const extended = extendProjection(base, fresh);
    if (extended === null) {
      // A late correction reached back into history; rebuild rather than serve stale mapping.
      stats.fullRebuilds += 1;
      const events = store.read();
      const result = projectWorkGraph(events);
      persistQuietly(store, recordFromState(result.state, store.latestPosition(), result.sourceSequenceGaps));
      return result;
    }
    const maxPosition = Math.max(
      checkpoint.lastInsertionPosition,
      ...reconstructed.map((event) => (event as PositionalEvent).insertionPosition ?? 0),
    );
    persistQuietly(store, recordFromState(extended, maxPosition, gaps));
    return {
      orderedEvents: ordered,
      sourceSequenceGaps: gaps,
      snapshot: snapshotFromState(extended, gaps),
    };
  } finally {
    store.close();
  }
}
```

Two details to resolve while implementing (both mechanical, both must land):

1. `PositionalEvent` / `insertionPosition`: `read()` returns envelope objects without the row position, but the watermark must advance past the newest inserted row. Simplest correct source: `store.latestPosition()` **after** the read reflects the same newest row in the absence of concurrent writers, and a concurrent writer that lands mid-read merely makes the next read re-apply an overlap — which is harmless because `extendProjection` is idempotent per event id (`eventsById` keyed by `eventId`). So drop the `maxPosition` computation entirely and use `store.latestPosition()` called once after `fresh` is read. Remove `PositionalEvent`.
2. `base.eventsById` assignment: `WorkGraphState` fields are `readonly` — construct `stateFromRecord` to take an optional `eventsById: Map<EventId, ProtocolEvent>` parameter (default `new Map()`) instead of mutating.

Zero-delta `snapshotFromState(state, [])` serves `coverageForSnapshot` because gaps are `[]` internally — this is why `recordFromState` pre-applies gaps. `orderedEvents` is genuinely empty on the zero-delta path; no current consumer iterates it (verified: `services.ts` uses `.snapshot` and `.sourceSequenceGaps` only).

Add to `packages/storage/src/index.ts`:

```ts
export {
  clearProjectionCacheStats,
  projectWorkGraphCached,
  projectionCacheStats,
} from "./projection-cache.js";
```

- [ ] **Step 5: Run the storage suite**

Run: `corepack pnpm --filter patchmesh-storage test && corepack pnpm --filter patchmesh-storage typecheck`
Expected: PASS. If the byte-identity test fails, debug with the frozen-input method from PM-19: compare node/edge/coverage counts first, then diff serialized arrays; the usual culprit is coverage gap-application asymmetry between `recordFromState` and `snapshotFromState`.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/event-store.ts packages/storage/src/projection-cache.ts packages/storage/src/index.ts packages/storage/test/projection-cache.test.ts
git commit -m "Serve graph projections from a persisted checkpoint"
```

---

### Task 4: Wire the cached projection into query services

**Files:**
- Modify: `packages/query/src/types.ts:153` (`ReadServiceOptions`)
- Modify: `packages/query/src/services.ts`
- Test: `packages/query/test/` (new file `services-checkpoint.test.ts`, mirroring existing service-test setup)

**Interfaces:**
- Consumes: `projectWorkGraphCached` from `patchmesh-storage`.
- Produces: `ReadServiceOptions` gains `readonly ledgerPath?: string;` and `readonly verifyReplay?: boolean;`. Behavior contract: when `ledgerPath` is set and `verifyReplay` is falsy, graph projections go through the checkpoint; otherwise behavior is byte-identical to today. Callers who never set the fields see zero change.

- [ ] **Step 1: Write the failing equivalence test**

Following the existing setup in `packages/query/test/services.test.ts` (copy how it builds a store and constructs `createReadServices`), add:

```ts
test("status via checkpoint matches status via direct replay", () => {
  const ledgerPath = buildFixtureLedger(); // same helper shape as the existing suite
  const direct = createReadServices({ reader: fileReader(ledgerPath) }).getStatus();
  const cached = createReadServices({ reader: fileReader(ledgerPath), ledgerPath }).getStatus();
  assert.deepEqual(cached, direct);
});

test("verifyReplay routes around the checkpoint", () => {
  const ledgerPath = buildFixtureLedger();
  const verified = createReadServices({ reader: fileReader(ledgerPath), ledgerPath, verifyReplay: true }).getStatus();
  const direct = createReadServices({ reader: fileReader(ledgerPath) }).getStatus();
  assert.deepEqual(verified, direct);
});
```

Use whatever reader constructor the existing tests use for `reader:` — the plan deliberately does not invent one; mirror the neighboring test file exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `corepack pnpm --filter patchmesh-query test`
Expected: FAIL — `ledgerPath` is not a known option / results differ.

- [ ] **Step 3: Implement the wiring**

`packages/query/src/types.ts` — extend `ReadServiceOptions`:

```ts
export interface ReadServiceOptions {
  readonly reader: EventReader;
  /** Set by hosts reading a real ledger file, enabling the persisted projection checkpoint. */
  readonly ledgerPath?: string;
  /** Force full validated replay even when a checkpoint is available. */
  readonly verifyReplay?: boolean;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly pollIntervalMs?: number;
}
```

`packages/query/src/services.ts` — one helper plus call-site swaps:

```ts
import { projectWorkGraphCached } from "patchmesh-storage";

function projectGraph(options: ReadServiceOptions): WorkGraphReplayResult {
  if (options.ledgerPath !== undefined && options.verifyReplay !== true) {
    return projectWorkGraphCached(options.ledgerPath);
  }
  return projectWorkGraph(readEvents(options));
}
```

Swap these six sites from `projectWorkGraph(readEvents(options))` / `projectWorkGraph(events)` to `projectGraph(options)`:
- `aggregateCoverage(events)` at line ~102 becomes `aggregateCoverage(events, options)` with signature `(events, options: ReadServiceOptions)` and body `const snapshot = projectGraph(options).snapshot;` — this removes a **second** full projection from `status`, which today projects twice.
- `getStatus` line ~194: `const replay = projectGraph(options);`
- `listAgents` line ~250: `const graph = projectGraph(options).snapshot;`
- `getGraph` line ~270: `const snapshot = projectGraph(options).snapshot;`
- `listFindings` line ~280: `const snapshot = projectGraph(options).snapshot;`
- `explainDecision` line ~292: `const snapshot = projectGraph(options).snapshot;`

Import `type WorkGraphReplayResult` from `patchmesh-storage`. `readEvents(options)` stays everywhere events themselves are needed (counts, attribution, listing) — the checkpoint replaces only the projection.

- [ ] **Step 4: Run query tests and typecheck**

Run: `corepack pnpm --filter patchmesh-query test && corepack pnpm --filter patchmesh-query typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/query/src/types.ts packages/query/src/services.ts packages/query/test/services-checkpoint.test.ts
git commit -m "Route read-service projections through the checkpoint"
```

---

### Task 5: CLI `--verify`, doctor replay check, documentation

**Files:**
- Modify: `apps/cli/src/args.ts` (flag parsing + help text)
- Modify: `apps/cli/src/main.ts` (status branch ~line 241; find where `createReadServices` is called and pass the new options)
- Modify: `apps/cli/src/doctor.ts` (new `replay` check)
- Modify: `docs/problems/README.md` (shipped table)
- Test: `apps/cli/test/` (arg parsing test, following the existing parsing tests' pattern)

**Interfaces:**
- Consumes: Task 4's `verifyReplay` option; `projectWorkGraphCached(_, { verify: true })` from storage.

- [ ] **Step 1: Parse `--verify` for status**

In `apps/cli/src/args.ts`, follow the exact pattern of the existing option loop (the `--database` case at line 267 shows the house style: match the literal token, consume its value if any, set a field on the parsed result). `--verify` takes **no value**:

```ts
if (option === "--verify" && commandName === "status") { parsed.verify = true; index += 1; continue; }
```

Add `verify?: boolean` to the parsed-command type, and a help line under `status`:

```ts
"  status [--verify]          Store health, counts, and observation coverage (--verify replays and validates every event)",
```

Reject `--verify` on other commands with the same usage-error mechanism other misplaced flags use.

- [ ] **Step 2: Pass it through `main.ts`**

In the `parsed.command === "status"` branch (~line 241), locate the `createReadServices({...})` construction and add `ledgerPath: <the resolved database path already in scope>` and `verifyReplay: parsed.verify === true`. The resolved path variable is the same one the `--database` defaulting logic produces (see `main.ts:509-556`).

- [ ] **Step 3: Doctor replay check**

In `apps/cli/src/doctor.ts`, add one check to the array in `diagnose()`, placed after the ledger-size check. Update the stale comment near line 223 that says loading the ledger was removed: the size check still avoids loading events, but the new replay check loads them deliberately.

```ts
import { projectWorkGraphCached } from "patchmesh-storage";

function replayCheck(ledgerPath: string): Check {
  try {
    projectWorkGraphCached(ledgerPath, { verify: true });
    return { name: "replay", status: "ok", detail: "every event validated and replayed" };
  } catch (error) {
    return {
      name: "replay",
      status: "fail",
      detail: `replay failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
```

Only push it when the existing ledger-existence check passed (reuse the same guard the size check uses). `doctor` therefore costs a full replay (~1.5s at 10k events) — accepted by spec: corruption discovery is routine, speed is not doctor's job.

- [ ] **Step 4: Test the parsing**

In `apps/cli/test/`, mirror the existing args-parsing test file:

```ts
test("--verify parses for status only", () => {
  assert.equal(parse(["status", "--verify"]).verify, true);
  assert.equal(parse(["status"]).verify, undefined);
  assert.throws(() => parse(["agents", "--verify"]));
});
```

(`parse` = whatever the existing tests call the args parser; mirror the file's imports.)

- [ ] **Step 5: Documentation**

`docs/problems/README.md` — add a "Shipped 2026-08-26" section after the 2026-08-25 one:

```markdown
### Shipped 2026-08-26

| Item | What landed |
| --- | --- |
| [Projection checkpoint](../superpowers/specs/2026-08-26-projection-checkpoint-design.md) | Read commands serve graph projections from a persisted, hash-checked checkpoint and apply only new events. Full replay remains available via `patchmesh status --verify` and runs on every `doctor`. |
```

- [ ] **Step 6: Full verification and commit**

Run: `corepack pnpm check` (build + recursive typecheck + recursive tests + phase0 validation + trace validation)
Expected: PASS throughout.

```bash
git add apps/cli/src/args.ts apps/cli/src/main.ts apps/cli/src/doctor.ts apps/cli/test/ docs/problems/README.md
git commit -m "Expose status --verify and teach doctor to replay the ledger"
```

---

## Measurement acceptance (run before calling the work done)

Against this repository's own live ledger (`.patchmesh/ledger.db`, ~32MB):

```bash
node tools/phase2/../..//apps/cli/dist/main.js status            # warm, 3 runs, take median
node apps/cli/dist/main.js status                                # after: expect a large drop
```

Record before/after medians in the commit message body of the final commit. Success bar: warm `status` median improves by at least the projection share measured in PM-19 (~1.3s at 9k events scaled to current size). If it does not, profile before touching code again — the checkpoint must not have become the new hot spot (blob parse time is the suspect; report, do not silently tune).
