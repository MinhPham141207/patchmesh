# M2 Event Store and Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an append-only SQLite event store and deterministic causal replay core for the normalized Phase 1 event stream.

**Architecture:** A new `@patchmesh/storage` package depends only on `@patchmesh/protocol`. `SqliteEventStore` validates and stores canonical UTF-8 event bytes with SHA-256 digests; `ReplayDriver` resolves causal order in memory and returns no snapshot on failure. M2 stops before adapters, effects, graph projections, detectors, policies, daemon services, and CLI commands.

**Tech Stack:** TypeScript strict mode, pnpm workspace, Node's built-in `node:sqlite` `DatabaseSync`, SQLite migrations, Node's built-in `node:test` runner through `tsx`, and the existing Phase 0 protocol validator.

## Global Constraints

- Use Node's built-in `node:sqlite` `DatabaseSync` API and document a minimum Node version that supports it; use Node `>=22.5.0` for the package.
- Do not introduce an ORM or an additional SQLite wrapper dependency.
- Keep `packages/storage` dependent on `@patchmesh/protocol` only; do not depend on the collector, adapters, gateway, projections, daemon, or CLI.
- Store canonical event JSON as UTF-8 bytes and hash it with SHA-256; recursively sort object keys and preserve array order.
- Events are append-only. Do not expose update or delete operations, and never repair stored event bytes or metadata.
- Allow an event to be appended before its causal parent; causal references remain application-level rather than SQLite foreign keys.
- Treat an identical event ID and digest as a no-op; treat an identical event ID with a different digest as `PHASE0_ID_CONFLICT`.
- Never use timestamps or insertion order to establish causality; deterministic ready-event ordering uses event ID.
- Buffer valid out-of-order events during replay and fail deterministically on missing parents, causal cycles, or impossible transitions.
- Return no replay snapshot when replay fails; do not expose partial reducer state.
- Report source-sequence gaps as degraded coverage without synthesizing events or causal edges.
- Replay must not write events, rerun tools, send decisions, execute directives, or call external services.
- Validate unknown input at the storage boundary and do not echo secrets, credentials, arbitrary payload values, or full environment data in diagnostics.
- Keep M2 report-only and observation/replay-only; do not implement M3 runtime integration or M5 projections.
- Use strict TypeScript and avoid `any`.
- Run package tests, strict typecheck, build, the full workspace test suite, the Phase 0 validator, and `git diff --check` before declaring M2 complete.

---

## File Map

Create the storage package:

- `packages/storage/package.json` - package metadata, Node engine floor, scripts, and protocol workspace dependency.
- `packages/storage/tsconfig.json` - strict package compiler configuration.
- `packages/storage/src/database.ts` - SQLite opening, migration execution, and connection lifecycle.
- `packages/storage/src/migrations/001_events.sql` - immutable initial schema for migrations and events.
- `packages/storage/src/canonical-json.ts` - recursive JSON canonicalization and SHA-256 digest calculation.
- `packages/storage/src/errors.ts` - typed storage and replay errors with stable codes and safe diagnostics.
- `packages/storage/src/replay.ts` - deterministic causal scheduler, source-sequence gap calculation, and reducer execution.
- `packages/storage/src/event-store.ts` - append-only persistence, duplicate handling, raw reads, and replay composition.
- `packages/storage/src/index.ts` - public storage exports.
- `packages/storage/test/storage.test.ts` - migration, restart, canonicalization, append, duplicate, conflict, and raw-read tests.
- `packages/storage/test/replay.test.ts` - out-of-order, missing-reference, cycle, transition, source-gap, convergence, and reducer-isolation tests.

Update status documentation after verification:

- `docs/implementation/phase1/evidence/PHASE_1_M2_EVIDENCE.md` - observed M2 commands, results, and coverage.
- `docs/implementation/phase1/PHASE_1_MILESTONES.md` - mark only M2 complete and link its evidence.
- `docs/ROADMAP.md` - identify M2 as implemented while leaving M3-M7 planned.
- `README.md` - state that SQLite storage and deterministic replay are verified while adapters, effects, projections, daemon, CLI, and detection remain planned.

## Interfaces Defined Across Tasks

The following names and signatures are fixed for the plan:

```ts
import type {
  CorrelationId,
  EventId,
  EventType,
  Source,
} from "@patchmesh/protocol";
import type { ProtocolEvent } from "@patchmesh/protocol";

export interface EventQuery {
  readonly eventId?: EventId;
  readonly eventType?: EventType;
  readonly correlationId?: CorrelationId;
  readonly causationId?: EventId | null;
}

export type AppendResult =
  | { readonly status: "inserted"; readonly event: ProtocolEvent }
  | { readonly status: "duplicate"; readonly event: ProtocolEvent };

export interface SourceSequenceGap {
  readonly source: Source;
  readonly missingRanges: readonly {
    readonly from: number;
    readonly to: number;
  }[];
}

export interface ReplayReducer<State> {
  initialState(): State;
  apply(state: State, event: ProtocolEvent): State;
}

export interface ReplayResult<State> {
  readonly orderedEvents: readonly ProtocolEvent[];
  readonly sourceSequenceGaps: readonly SourceSequenceGap[];
  readonly state: State;
}

export class SqliteEventStore {
  static open(filename: string): SqliteEventStore;
  append(input: unknown): AppendResult;
  read(query?: EventQuery): readonly ProtocolEvent[];
  replay(): ReplayResult<readonly ProtocolEvent[]>;
  replay<State>(reducer: ReplayReducer<State>): ReplayResult<State>;
  close(): void;
}
```

`SqliteEventStore.open` applies all pending migrations before returning. `append`
parses individual events with `parseEvent`; it does not require causal parents to have
already been appended. `read` returns defensive copies in durable insertion order.
`replay` returns an immutable causal event input and a default event-accumulator state,
or applies the supplied pure reducer after causal and semantic validation succeed.

`StorageError` exposes `code: string`, `message: string`, and sanitized diagnostic
metadata. The stable replay codes are `PHASE0_ID_CONFLICT`,
`PHASE0_REFERENCE_MISSING`, `M2_REPLAY_CAUSALITY_UNRESOLVED`, and
`PHASE0_TRANSITION_INVALID`; protocol boundary diagnostics retain their existing
codes.

---

### Task 1: Bootstrap Storage Package and Migrations

**Files:**

- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/migrations/001_events.sql`
- Create: `packages/storage/src/index.ts`
- Create: `packages/storage/test/storage.test.ts`

**Interfaces:**

- Consumes: the existing strict workspace and `@patchmesh/protocol` package metadata.
- Produces: `SqliteEventStore.open(filename)` plumbing and an initialized SQLite schema for Tasks 2 and 3.

- [ ] **Step 1: Write failing migration and restart tests**

Create a synchronous `withTemporaryDatabase` helper in
`packages/storage/test/storage.test.ts` using `mkdtempSync`, `rmSync`, `tmpdir`, and
`join`. It must remove the temporary directory in a `finally` block. Start with tests
that require an exported `SqliteEventStore`:

```ts
function withTemporaryDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m2-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    run(databasePath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("creates the migration and events tables", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  store.close();

  const database = new DatabaseSync(databasePath);
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as Array<{ readonly name: string }>;
  assert.deepEqual(tables.map((table) => table.name), ["events", "schema_migrations"]);
  database.close();
}));

test("reopens the same database after migration", () => withTemporaryDatabase((databasePath) => {
  const first = SqliteEventStore.open(databasePath);
  first.close();

  const second = SqliteEventStore.open(databasePath);
  assert.deepEqual(second.read(), []);
  second.close();
}));
```

Import `DatabaseSync` from `node:sqlite` only in this test so the schema assertion
does not become part of the storage public API.

Run:

```text
corepack pnpm --filter @patchmesh/storage test
```

Expected: FAIL because the storage package and export do not exist.

- [ ] **Step 2: Add the package and compiler configuration**

Create `packages/storage/package.json` with package name `@patchmesh/storage`,
`"type": "module"`, `"engines": { "node": ">=22.5.0" }`, and these scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  }
}
```

Declare `@patchmesh/protocol` as a `workspace:*` dependency. Do not add a SQLite
package because the implementation uses `node:sqlite`. Configure `tsconfig.json` to
extend `../../tsconfig.base.json`, use `src` as `rootDir`, emit declarations and
source maps to `dist`, and exclude `dist` and tests from production output.

- [ ] **Step 3: Define the immutable initial migration**

Create `001_events.sql` with these exact tables and constraints:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  insertion_position INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL,
  canonical_event BLOB NOT NULL,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_sequence INTEGER,
  timestamp TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT
);

CREATE INDEX IF NOT EXISTS events_digest_idx ON events (content_digest);
CREATE INDEX IF NOT EXISTS events_causation_idx ON events (causation_id);
CREATE INDEX IF NOT EXISTS events_position_idx ON events (insertion_position);
```

Do not add a foreign key on `causation_id`. The schema must accept a child before its
parent so the event log can preserve arrival history.

- [ ] **Step 4: Implement migration execution and lifecycle**

In `database.ts`, import `DatabaseSync` from `node:sqlite`. Implement
`SqliteEventStore.open(filename)` through a private database initializer that:

1. Opens the filename with `DatabaseSync`.
2. Enables SQLite foreign keys.
3. Creates `schema_migrations` if absent.
4. Reads applied migration IDs.
5. Runs each missing migration in ascending filename order inside a transaction.
6. Inserts the migration ID and UTC application timestamp before committing.
7. Rolls back and closes the connection if migration fails.

Use `exec` for fixed migration SQL and prepared statements for values. Do not accept
SQL or migration text from callers. `close()` must be idempotent and must not delete
the database file.

- [ ] **Step 5: Export the package surface and run migration tests**

Add a temporary `SqliteEventStore` shell with `open`, `read`, and `close` methods so
the migration tests can execute. Export it from `src/index.ts`, then run:

```text
corepack pnpm --filter @patchmesh/storage typecheck
corepack pnpm --filter @patchmesh/storage test
```

Expected: package typecheck passes and both migration tests pass against temporary
SQLite files.

---

### Task 2: Implement Canonicalization, Append, and Raw Reads

**Files:**

- Create: `packages/storage/src/canonical-json.ts`
- Create: `packages/storage/src/errors.ts`
- Create: `packages/storage/src/event-store.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/test/storage.test.ts`

**Interfaces:**

- Consumes: the migration and database lifecycle from Task 1, plus `parseEvent` from `@patchmesh/protocol`.
- Produces: `AppendResult`, `EventQuery`, `StorageError`, and the append/read behavior required by Task 3.

- [ ] **Step 1: Write failing canonicalization and append tests**

Use the `withTemporaryDatabase` helper from Task 1 for every database-owning test.
Add typed event fixtures local to the storage test file. They must include a valid
`tool.requested` event and a child `tool.completed` event using the existing protocol
identities and envelope rules. Add these tests:

```ts
test("canonical digest ignores object key insertion order", () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };

  assert.equal(canonicalDigest(left), canonicalDigest(right));
});

test("identical duplicate is a no-op", () => {
  const store = SqliteEventStore.open(temporaryDatabasePath());
  const event = makeToolRequested();

  assert.equal(store.append(event).status, "inserted");
  const duplicate = store.append(structuredClone(event));

  assert.equal(duplicate.status, "duplicate");
  assert.equal(store.read().length, 1);
  store.close();
});

test("conflicting content for one event ID fails deterministically", () => {
  const store = SqliteEventStore.open(temporaryDatabasePath());
  const event = makeToolRequested();
  store.append(event);

  assert.throws(
    () => store.append({ ...event, timestamp: "2026-08-08T00:00:01.000Z" }),
    (error: unknown) => error instanceof StorageError && error.code === "PHASE0_ID_CONFLICT",
  );
  assert.equal(store.read().length, 1);
  store.close();
});
```

Also add tests that:

- reject malformed input before any row is inserted;
- accept a child whose causal parent is not yet stored;
- preserve raw arrival order in `read()`;
- return frozen defensive copies;
- preserve rows after closing and reopening the same database;
- return event-type, correlation, and causation filters.

Run:

```text
corepack pnpm --filter @patchmesh/storage test
```

Expected: FAIL because canonicalization and append/read behavior are not implemented.

- [ ] **Step 2: Implement recursive canonical JSON and digesting**

In `canonical-json.ts`, implement a JSON-only canonicalizer with these rules:

- primitive values use JSON encoding;
- arrays retain original order and canonicalize each element;
- plain objects sort own keys using lexical code-unit order and canonicalize each value;
- no whitespace is emitted between tokens;
- unsupported values produce a typed error rather than being silently converted;
- the canonical string is encoded with `TextEncoder` and hashed with
  `createHash("sha256")`.

Export:

```ts
export function canonicalJson(value: unknown): string;
export function canonicalBytes(value: unknown): Uint8Array;
export function canonicalDigest(value: unknown): string;
```

The canonicalizer must not mutate its input. Store the digest as lowercase hexadecimal
text and the canonical bytes as a SQLite BLOB.

- [ ] **Step 3: Implement typed storage errors**

In `errors.ts`, define:

```ts
export class StorageError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, string>>);
}
```

Use safe identifiers only in `details`, such as event ID and migration ID. Do not
include canonical payloads, SQL text, secret-shaped values, or arbitrary SQLite error
strings in public diagnostics.

- [ ] **Step 4: Implement append-only persistence**

In `event-store.ts`, prepare statements for event ID lookup, insert, and filtered
reads. `append(input)` must:

1. Call `parseEvent(input)` and throw `ProtocolValidationError` on failure.
2. Compute canonical bytes and digest from the normalized event.
3. Read the existing row by `event_id` inside a transaction.
4. Return `duplicate` with the stored event when the digest matches.
5. Throw `StorageError("PHASE0_ID_CONFLICT", ...)` when the digest differs.
6. Insert canonical bytes and every metadata column when the ID is new.
7. Return `inserted` with the normalized event.

Do not call `validateEventSet` during append. That would reject a valid child arriving
before its parent and would violate M2's durable out-of-order behavior. Replay performs
complete event-set validation once all stored rows are available.

- [ ] **Step 5: Implement raw reads and defensive reconstruction**

Implement `read(query?)` with parameterized SQL. Build predicates only for the defined
`EventQuery` fields and order results by `insertion_position ASC`. Decode each BLOB as
UTF-8 JSON and pass it through `parseEvent` so returned events are normalized and
deeply frozen. If a stored row cannot parse, throw a safe storage corruption error;
never return a partially reconstructed event list.

Implement `close()` so later operations fail with a typed closed-store error rather
than accessing a closed SQLite handle.

- [ ] **Step 6: Run append and storage tests**

Run:

```text
corepack pnpm --filter @patchmesh/storage typecheck
corepack pnpm --filter @patchmesh/storage test
```

Expected: canonicalization, validation, append, duplicate, conflict, restart,
immutability, filtering, and out-of-order append tests pass.

---

### Task 3: Implement Deterministic Causal Replay

**Files:**

- Create: `packages/storage/src/replay.ts`
- Create: `packages/storage/test/replay.test.ts`
- Modify: `packages/storage/src/errors.ts`
- Modify: `packages/storage/src/event-store.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**

- Consumes: immutable events returned by Task 2 and `validateEventSet` from `@patchmesh/protocol`.
- Produces: `ReplayReducer`, `ReplayResult`, `SourceSequenceGap`, replay errors, and both `replay()` overloads.

- [ ] **Step 1: Write failing replay convergence tests**

Create two temporary stores with the same complete event set. Append the canonical
root/child order to one and child/root order to the other. Assert that replay outputs
the same event IDs and state:

```ts
test("canonical and causally out-of-order input converge", () => {
  const canonical = SqliteEventStore.open(temporaryDatabasePath());
  const outOfOrder = SqliteEventStore.open(temporaryDatabasePath());
  const request = makeToolRequested();
  const completion = makeToolCompleted(request);

  canonical.append(request);
  canonical.append(completion);
  outOfOrder.append(completion);
  outOfOrder.append(request);

  assert.deepEqual(
    canonical.replay().orderedEvents.map((event) => event.eventId),
    outOfOrder.replay().orderedEvents.map((event) => event.eventId),
  );
  assert.deepEqual(canonical.replay().state, outOfOrder.replay().state);
  canonical.close();
  outOfOrder.close();
});
```

Add tests for:

- identical duplicates not appearing twice in replay;
- a missing causal parent producing `PHASE0_REFERENCE_MISSING`;
- a closed causal cycle producing `M2_REPLAY_CAUSALITY_UNRESOLVED`;
- an impossible transition producing `PHASE0_TRANSITION_INVALID` and no result;
- internal source-sequence gaps returning a `SourceSequenceGap` without failure;
- no reducer state becoming observable when replay fails;
- a reducer receiving events only after causal ordering and semantic validation;
- a reducer that attempts no storage mutation because replay exposes no database handle.

Run:

```text
corepack pnpm --filter @patchmesh/storage test
```

Expected: FAIL because the replay driver and overloads are not implemented.

- [ ] **Step 2: Implement causal scheduling**

In `replay.ts`, implement a pure scheduler over `readonly ProtocolEvent[]`:

1. Build an event-ID map and reject duplicate IDs defensively with the conflict code.
2. Build a pending map and a resolved-ID set.
3. Treat events with `causationId === null` as ready.
4. Treat an event as ready only when its causation ID is resolved.
5. Sort ready events by `eventId` using a deterministic lexical comparator.
6. Remove and record each selected event, then mark its ID resolved.
7. Repeat until no events remain or a bounded pass makes no progress.

Before reporting an unresolved pass, inspect pending events for a causation ID absent
from the event-ID map. Report `PHASE0_REFERENCE_MISSING` with the child and parent IDs.
If every pending causation ID exists but no event is ready, report
`M2_REPLAY_CAUSALITY_UNRESOLVED` for the causal cycle or unresolved dependency.
Bound the loop by `events.length + 1` passes and never use a timeout or wall clock.

- [ ] **Step 3: Add semantic validation and atomic replay result creation**

After the deterministic ordered list is complete, call
`validateEventSet(orderedEvents)`. Convert its sanitized diagnostics into a typed
replay error while retaining stable protocol codes. Classify impossible transition
diagnostics as `PHASE0_TRANSITION_INVALID`; preserve `PHASE0_REFERENCE_MISSING` for
reference failures and `PHASE0_SCHEMA_INVALID` for boundary-invalid resource or payload
relationships.

Only after validation succeeds should the driver create the default accumulator state
or call a supplied reducer. Freeze the ordered event list, gap diagnostics, and final
state before returning. On every failure path, discard all local state and throw.

- [ ] **Step 4: Implement source-sequence gap reporting**

Group events by the exact producer key
`source.kind`, `source.sourceId`, and `source.instanceId`. For each group, sort its
non-null source sequence values numerically and emit contiguous missing ranges between
the observed minimum and maximum. Do not infer a prefix gap, create events, connect
causation, or fail replay because of a gap. Sort groups and ranges deterministically.

- [ ] **Step 5: Implement reducer overloads and store composition**

Define the pure reducer contract:

```ts
export interface ReplayReducer<State> {
  initialState(): State;
  apply(state: State, event: ProtocolEvent): State;
}
```

The default reducer state is a frozen copy of the ordered event list. The supplied
reducer starts from `initialState()` and receives each frozen event in causal order.
`SqliteEventStore.replay()` must not expose its `DatabaseSync` instance or call any
method other than raw event loading and in-memory replay. Export all replay types from
`src/index.ts`.

- [ ] **Step 6: Run replay and workspace checks**

Run:

```text
corepack pnpm --filter @patchmesh/storage typecheck
corepack pnpm --filter @patchmesh/storage test
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Expected: all storage replay tests pass; protocol and collector tests remain green;
the workspace typecheck and build complete without errors.

---

### Task 4: Record M2 Evidence and Update Current-Status Documentation

**Files:**

- Create: `docs/implementation/phase1/evidence/PHASE_1_M2_EVIDENCE.md`
- Modify: `docs/implementation/phase1/PHASE_1_MILESTONES.md`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: verified storage package, migration, append, duplicate, conflict, restart, and replay behavior from Tasks 1-3.
- Produces: factual M2 completion evidence and current-status documentation that keeps M3-M7 planned.

- [ ] **Step 1: Run the complete verification set before editing status text**

Run these commands from the repository root and retain observed counts and output:

```text
corepack pnpm install
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
node tools/phase0/validate.mjs
git diff --check
```

Expected: the Phase 0 validator prints `Phase 0 corpus valid`; all package tests,
typechecks, and builds pass; `git diff --check` reports no whitespace errors. If any
command fails, fix the implementation or documentation before updating milestone
status.

- [ ] **Step 2: Write M2 evidence from observed results**

Create `docs/implementation/phase1/evidence/PHASE_1_M2_EVIDENCE.md` with:

- verification date and repository revision;
- exact commands and observed test counts;
- migration application and process-restart persistence evidence;
- canonical digest, immutable bytes, duplicate no-op, and conflicting-ID evidence;
- canonical versus duplicate/out-of-order replay convergence evidence;
- missing-parent, causal-cycle, impossible-transition, and no-partial-snapshot evidence;
- source-sequence gap degraded-coverage evidence;
- explicit statement that replay has no external side effects;
- explicit statement that M3 adapters, M4 observation, M5 projections, M6 CLI, and M7 golden-slice evidence remain unimplemented.

Do not include full local paths, secrets, environment dumps, or claims not supported by
the recorded commands.

- [ ] **Step 3: Mark only M2 complete in milestone and roadmap documents**

In `docs/implementation/phase1/PHASE_1_MILESTONES.md`, change the status line to
identify M2 as complete, link `evidence/PHASE_1_M2_EVIDENCE.md` from the M2 milestone,
and retain M3-M7 as planned.
Preserve the existing rules that Phase 1 remains report-only and that projection facts,
detector findings, policy decisions, and disruptive directives are outside M2.

In `docs/ROADMAP.md`, identify append-only SQLite storage and deterministic replay as
verified M2 deliverables while leaving the overall Phase 1 exit gates unmet until M3-M7
are complete. Do not mark Phase 1 complete.

- [ ] **Step 4: Update README status without overclaiming**

Change the project status and planned-slice wording so it says M1 and M2 are
implemented and verified. Specifically state that the repository now has the strict
workspace, protocol boundary, in-memory collector, append-only SQLite event store,
and deterministic causal replay. Keep runtime adapters, effect observation, graph
projections, daemon services, CLI commands, detectors, and policies described as
planned.

- [ ] **Step 5: Run final documentation and verification checks**

Run:

```text
node tools/phase0/validate.mjs
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
git diff --check
```

Expected: Phase 0 remains valid, all TypeScript checks and tests pass, the build is
clean, and the final diff contains no whitespace errors. Read the changed status text
once more and verify it does not claim adapters, observation, projections, detectors,
policies, CLI behavior, or full Phase 1 completion.

---

## Final Review Checklist

- [ ] `@patchmesh/storage` depends only on `@patchmesh/protocol`.
- [ ] The storage package uses Node `>=22.5.0` and `node:sqlite` without an ORM or wrapper dependency.
- [ ] Migrations are versioned, transactional, rerunnable, and never edited after application.
- [ ] The `events` table stores canonical UTF-8 bytes, digest, all envelope metadata, and immutable insertion position.
- [ ] No causal foreign key prevents valid out-of-order append.
- [ ] Individual append validates protocol input but does not require an already stored parent.
- [ ] Identical duplicate IDs are no-ops and conflicting IDs return `PHASE0_ID_CONFLICT`.
- [ ] Raw reads preserve insertion order and return frozen defensive copies.
- [ ] Replay uses causal dependencies, deterministic event-ID tie-breaking, and no timestamp repair.
- [ ] Missing parents and cycles fail with stable errors and no partial replay result.
- [ ] Impossible transitions fail without partial state.
- [ ] Source-sequence gaps are explicit degraded coverage and never synthesized into events.
- [ ] Replay performs no database writes, tool calls, decision delivery, or external side effects.
- [ ] Canonical, duplicate, and valid out-of-order inputs converge to the same replay result.
- [ ] Existing protocol and collector behavior remains green.
- [ ] M2 evidence records observed output rather than planned claims.
- [ ] M3-M7 remain clearly planned and no later milestone behavior entered the diff.
