# M6 Daemon Services and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 read-only query services, daemon composition layer, and deterministic `status`, `agents`, `events`, and `graph` CLI commands.

**Architecture:** Add `@patchmesh/query` as the public domain read-service boundary over the existing protocol, event store, and M5 projector. Add `apps/daemon` for in-process composition and `apps/cli` for parsing/rendering; do not add network transport, lifecycle commands, or direct SQLite access from the CLI.

**Tech Stack:** Strict TypeScript, pnpm workspace, Node.js >=22.5.0, `@patchmesh/protocol`, `@patchmesh/storage`, existing Node standard-library APIs, and `node:test`.

## Global Constraints

- M6 remains read-only, replayable, and report-only.
- Implement only `patchmesh status`, `patchmesh agents`, `patchmesh events`, and `patchmesh graph`.
- Do not add `init`, `start`, `stop`, `watch`, `follow`, `inspect`, `doctor`, HTTP, WebSocket, RPC, or other daemon transport.
- Do not create databases, files, migrations, events, decisions, findings, validity records, or policy output.
- The CLI must invoke public query services and must not query internal SQLite tables directly.
- Status must expose only health, store/replay state, observed event counts, attribution counts, and coverage state/gaps.
- Do not infer agent lifecycle states such as running, paused, waiting, or completed.
- All human, JSON, NDJSON, and `--raw` output passes the same recursive redaction boundary.
- Reporting-only degraded coverage warnings exit `0`; usage errors use exit `2`, unavailable stores use exit `3`, replay/corruption/cursor failures use exit `4`, and follow SIGINT exits `0`.
- Keep event order durable insertion order; timestamps filter but never establish causality.
- Preserve the M5 graph snapshot ordering, attribution, coverage, and Phase 2 exclusions.
- Do not modify protocol schemas, storage migrations, adapters, or unrelated untracked Phase 2-5 documentation.
- Do not commit implementation changes unless the user explicitly requests a commit.

---

## File Map

Create:

- `packages/query/package.json`: workspace package metadata and protocol/storage dependencies.
- `packages/query/tsconfig.json`: strict package compiler configuration.
- `packages/query/src/types.ts`: read ports, DTOs, filters, errors, cursor, follow, and renderer-neutral contracts.
- `packages/query/src/redaction.ts`: recursive secret redaction for all output DTOs.
- `packages/query/src/time.ts`: deterministic ISO/duration bound parsing.
- `packages/query/src/services.ts`: status, agents, graph, event-page, and follow service implementations.
- `packages/query/src/index.ts`: public query exports.
- `packages/query/test/query.test.ts`: service and DTO tests against fixture event stores.
- `apps/daemon/package.json`: daemon package metadata and scripts.
- `apps/daemon/tsconfig.json`: strict daemon compiler configuration.
- `apps/daemon/src/index.ts`: `createDaemon`, health, store ownership, and query-service composition.
- `apps/daemon/test/daemon.test.ts`: composition, health, close, and dependency-injection tests.
- `apps/cli/package.json`: CLI package metadata, executable bin, and scripts.
- `apps/cli/tsconfig.json`: strict CLI compiler configuration.
- `apps/cli/src/args.ts`: pure argument parser and command/option validation.
- `apps/cli/src/render.ts`: deterministic human, JSON, and NDJSON renderers.
- `apps/cli/src/main.ts`: dependency wiring, command dispatch, exit-code mapping, and SIGINT handling.
- `apps/cli/test/cli.test.ts`: command integration and output/exit tests.
- `docs/implementation/phase1/evidence/PHASE_1_M6_EVIDENCE.md`: M6 verification and behavior evidence.

Modify:

- `pnpm-workspace.yaml`: include `apps/*` alongside `packages/*`.
- `docs/CLI.md`: mark the four M6 commands available and remove Phase 2-only fields from M6 examples.
- `docs/implementation/phase1/PHASE_1_MILESTONES.md`: mark M6 complete and link evidence.
- `docs/ROADMAP.md`: add M6 complete status and evidence link while preserving unrelated Phase 2-5 changes.
- `docs/ARCHITECTURE.md`: update current implementation notes to include read services and in-process CLI composition.

Do not modify:

- `packages/protocol` schemas or event types.
- `packages/storage/src/migrations/001_events.sql`.
- `packages/adapters` runtime behavior.
- `docs/implementation/phase2/`, `phase3/`, `phase4/`, or `phase5/`.

## Public Interfaces

Define these contracts in `packages/query/src/types.ts` before implementing services:

```ts
export interface EventReader {
  read(query?: EventQuery): readonly ProtocolEvent[];
  replay<State>(reducer: ReplayReducer<State>): ReplayResult<State>;
}

export interface ReadServices {
  getStatus(): StatusView;
  listAgents(filters?: AgentFilters): AgentsView;
  listEvents(query?: EventListQuery): EventPage;
  getGraph(filters?: GraphFilters): GraphView;
  followEvents(options: FollowOptions, signal?: AbortSignal): AsyncIterable<EventPage>;
}

export interface ReadServiceOptions {
  readonly reader: EventReader;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly pollIntervalMs?: number;
}
```

`EventReader` must be structurally compatible with `SqliteEventStore`. DTOs must be
deeply defensive and contain no mutable maps, database handles, or internal state.

### Task 1: Scaffold Workspace and Query Contracts

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/query/package.json`
- Create: `packages/query/tsconfig.json`
- Create: `packages/query/src/types.ts`
- Create: `packages/query/src/index.ts`
- Create: `packages/query/test/query.test.ts`

**Interfaces:**
- Consumes: `@patchmesh/protocol` event/identity types, `@patchmesh/storage` `EventQuery`, `ReplayReducer`, `ReplayResult`, `SourceSequenceGap`, and M5 `WorkGraphSnapshot`.
- Produces: public `ReadServices`, DTO, filter, cursor, follow, error, and `EventReader` types for Tasks 2-5.

- [ ] **Step 1: Add the workspace/package skeleton and failing contract tests**

Add a query package with NodeNext strict TypeScript settings and dependencies on workspace protocol/storage. Add tests that import the intended contracts and assert DTOs preserve nullable task IDs and explicit coverage fields.

```ts
test("event DTO preserves null attribution and cursor fields", () => {
  const fixtureEvent = makeFixtureEvent({ agentId: null, taskId: null });
  const page: EventPage = {
    events: [fixtureEvent],
    nextCursor: fixtureEvent.eventId,
    hasMore: false,
  };
  assert.equal(page.events[0]?.taskId, null);
  assert.equal(page.nextCursor, fixtureEvent.eventId);
});
```

`makeFixtureEvent` is a test-only helper that returns a complete valid `ProtocolEvent`;
production code must not accept partial event objects.

- [ ] **Step 2: Run the focused package test to verify the contract is red**

Run: `corepack pnpm --filter @patchmesh/query test`

Expected: FAIL because the package and public contracts do not exist.

- [ ] **Step 3: Define stable DTOs and filters**

Define `StatusView`, `AgentsView`, `AgentView`, `EventPage`, `EventListQuery`, `AgentFilters`, `GraphFilters`, `GraphView`, `FollowOptions`, `DaemonHealth`, `ReadServiceError`, and the exit-category error codes. Include only the fields approved in the M6 spec.

Use these exact shapes for the key service outputs:

```ts
export interface StatusView {
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly store: { readonly state: "open" | "closed"; readonly replayable: boolean };
  readonly eventCount: number;
  readonly eventTypeCounts: Readonly<Record<EventType, number>>;
  readonly agentCount: number;
  readonly taskCount: number;
  readonly nullAttributionEventCount: number;
  readonly coverage: { readonly presentation: ProjectionCoverage["presentation"]; readonly modes: readonly ProjectionCoverageMode[]; readonly gaps: readonly ProjectionCoverageGap[] };
  readonly errorCategory: string | null;
}

export interface EventPage {
  readonly events: readonly ProtocolEvent[];
  readonly nextCursor: EventId | null;
  readonly hasMore: boolean;
}

export interface GraphView {
  readonly snapshot: WorkGraphSnapshot;
  readonly filters: GraphFilters;
  readonly coverageWarnings: readonly ProjectionCoverageGap[];
}
```

Define `EventListQuery.taskId` so `null` explicitly filters null attribution; absence means no task filter. Define `since`/`until` as normalized ISO timestamps after Task 2 parsing. Define `FollowOptions` with the same event filters, optional cursor, and fixed poll interval supplied by service options.

- [ ] **Step 4: Export contracts and verify package typecheck**

Export the public types and `createReadServices(options: ReadServiceOptions): ReadServices` from `src/index.ts`; keep implementation types private. Run:

```bash
corepack pnpm --filter @patchmesh/query typecheck
```

Expected: PASS with strict declarations and no imports from CLI/daemon code.

### Task 2: Implement Redaction, Time Parsing, Status, Agents, and Graph Services

**Files:**
- Create: `packages/query/src/redaction.ts`
- Create: `packages/query/src/time.ts`
- Modify: `packages/query/src/services.ts`
- Modify: `packages/query/src/index.ts`
- Test: `packages/query/test/query.test.ts`

**Interfaces:**
- Consumes: Task 1 DTOs, `EventReader`, M5 `projectWorkGraph`, and protocol event types.
- Produces: `createReadServices(options): ReadServices`, `redactValue`, `parseTimeBound`, status/agents/graph behavior for Tasks 3-5.

- [ ] **Step 1: Add failing status/agents/graph/redaction tests**

Build a temporary SQLite fixture with attributed and null-attributed events, a linked effect, an opaque request, and an attribution correction. Assert:

- status counts unique agents/tasks and null attribution without lifecycle fields;
- degraded coverage is represented without findings or decisions;
- agents expose sorted observed task IDs including `null`;
- graph returns the M5 snapshot and stable filtered subsets; and
- redaction removes secret-shaped keys and values from nested event payloads.

```ts
test("status exposes observation counts but no Phase 2 state", () => {
  const status = services.getStatus();
  assert.equal(status.agentCount, 1);
  assert.equal(status.nullAttributionEventCount > 0, true);
  assert.equal(Object.hasOwn(status, "findings"), false);
  assert.equal(Object.hasOwn(status, "pausedTasks"), false);
});

test("redaction applies to nested raw event values", () => {
  const value = redactValue({ authorization: "Bearer secret", nested: { apiKey: "key" }, safe: "x" });
  assert.deepEqual(value, { authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]" }, safe: "x" });
});
```

- [ ] **Step 2: Run focused tests to verify the services are red**

Run: `corepack pnpm --filter @patchmesh/query test`

Expected: FAIL because service construction, redaction, time parsing, and projections are not implemented.

- [ ] **Step 3: Implement recursive redaction and time-bound parsing**

Implement `redactValue(value: unknown): unknown` for arrays and objects. Replace secret-shaped keys case-insensitively when they contain `api`, `token`, `password`, `secret`, `authorization`, `credential`, or private-environment markers. Replace matching secret-shaped string values only when the key/value category is clearly sensitive; preserve ordinary event content. Never include raw caught errors in a DTO.

Implement `parseTimeBound(value, now)` for ISO timestamps plus `Ns`, `Nm`, `Nh`, and `Nd` duration strings. Reject empty, malformed, negative, and non-finite values with `ReadServiceError` category `usage`.

- [ ] **Step 4: Implement status aggregation**

Read the immutable event list, run `projectWorkGraph`, count events by the closed `EventType` union, count unique non-null agent/task IDs, count events where either attribution field is null, and aggregate M5 coverage modes/gaps. Return `healthy` when replay and coverage have no gaps, `degraded` when replay succeeds with source/coverage gaps, and `unavailable` with a sanitized category when the reader/replay fails. Do not expose lifecycle or Phase 2 fields.

- [ ] **Step 5: Implement agents and graph queries**

Build agent records from event envelopes, merge sorted task IDs including null, count event types, and associate coverage by evidence IDs. Sort agents by `agentId`. Build graph output from `projectWorkGraph` and apply filters without mutating the source snapshot. Preserve connected agent/task/resource/version edges and stable ordering; return only M5 nodes, edges, and coverage.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
corepack pnpm --filter @patchmesh/query test
corepack pnpm --filter @patchmesh/query typecheck
```

Expected: PASS for status, agents, graph, redaction, filters, and time parsing.

### Task 3: Implement Event Pages and Follow Cursors

**Files:**
- Modify: `packages/query/src/services.ts`
- Test: `packages/query/test/query.test.ts`

**Interfaces:**
- Consumes: Task 1 `EventListQuery`, `EventPage`, `FollowOptions`; Task 2 redaction/time helpers; `EventReader.read` insertion order.
- Produces: deterministic `listEvents` and `followEvents` implementations.

- [ ] **Step 1: Add failing paging/filter/follow tests**

Use a fake reader backed by an in-memory event array and injected `sleep`/`AbortSignal`. Test:

- event type, agent, task, since, until, and limit filters;
- cursor pages using the last scanned event ID;
- missing cursor failure;
- initial follow page plus appended events without duplicates;
- filtered-out events advancing the internal cursor;
- abort ending the iterator cleanly; and
- reader failure becoming a typed query error.

```ts
test("follow advances across filtered events without duplicates", async () => {
  const controller = new AbortController();
  const pages = services.followEvents({ eventType: "file.changed" }, controller.signal);
  const first = await nextPage(pages);
  append(nonMatchingEvent);
  append(matchingEvent);
  const second = await nextPage(pages);
  assert.deepEqual(second.value.events.map((event) => event.eventId), [matchingEvent.eventId]);
  controller.abort();
  assert.equal((await pages.next()).done, true);
});
```

- [ ] **Step 2: Run focused tests to verify paging/follow behavior is red**

Run: `corepack pnpm --filter @patchmesh/query test`

Expected: FAIL because event pages and follow iteration are not implemented.

- [ ] **Step 3: Implement deterministic event filtering and pages**

Read the store’s insertion-ordered events, validate cursor existence, scan after the cursor, apply normalized time/type/agent/task filters, redact returned events, enforce positive integer limits, and return `nextCursor` as the last scanned event ID. `hasMore` indicates unscanned source events remain.

- [ ] **Step 4: Implement follow polling and shutdown**

Implement an async generator with one initial page, an internal cursor, injected fixed sleep, and an `AbortSignal`. Each poll rereads source events, scans after the cursor, advances over matching and nonmatching events, yields only matching pages, and never emits an event ID twice. Abort returns `{ done: true }` without throwing. Missing cursor, reader failure, and store closure throw typed errors.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `corepack pnpm --filter @patchmesh/query test` and `corepack pnpm --filter @patchmesh/query typecheck`

Expected: PASS for all filters, cursor, follow, abort, and error tests.

### Task 4: Add Daemon Composition and Health

**Files:**
- Create: `apps/daemon/package.json`
- Create: `apps/daemon/tsconfig.json`
- Create: `apps/daemon/src/index.ts`
- Create: `apps/daemon/test/daemon.test.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: `SqliteEventStore`, `@patchmesh/query` `createReadServices`, `ReadServices`, and `EventReader`.
- Produces: `DaemonOptions`, `DaemonHealth`, `PatchMeshDaemon`, and `createDaemon` for the CLI.

- [ ] **Step 1: Add failing daemon composition tests**

Test injected reader composition without opening SQLite, real temporary database composition with `SqliteEventStore.open`, health state, service identity, and `close()` behavior. Assert createDaemon does not create a missing database path.

```ts
test("daemon composes the public services without creating storage", () => {
  const daemon = createDaemon({ reader: fixtureReader });
  assert.equal(typeof daemon.services.getStatus, "function");
  assert.equal(daemon.health().store.state, "open");
  daemon.close();
});
```

- [ ] **Step 2: Run daemon tests to verify they fail**

Run: `corepack pnpm --filter @patchmesh/daemon test`

Expected: FAIL because the package, composition factory, and health DTO do not exist.

- [ ] **Step 3: Add daemon package/workspace configuration**

Add `apps/*` to `pnpm-workspace.yaml`. Configure daemon scripts for `test`, `typecheck`, and `build`, and dependencies on `@patchmesh/query` and `@patchmesh/storage`.

- [ ] **Step 4: Implement `createDaemon` and health**

Support either an injected `EventReader` for tests or an explicit existing database path. Open the store only when a path is provided, return query services from `createReadServices`, expose sanitized health categories, and make `close` idempotent. Do not create parent directories, database files, migrations, listeners, or processes.

- [ ] **Step 5: Run daemon tests and typecheck**

Run: `corepack pnpm --filter @patchmesh/daemon test`, `corepack pnpm --filter @patchmesh/daemon typecheck`, and `corepack pnpm --filter @patchmesh/daemon build`

Expected: PASS with no lifecycle or transport behavior.

### Task 5: Implement CLI Parsing, Rendering, Commands, and Exit Codes

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/args.ts`
- Create: `apps/cli/src/render.ts`
- Create: `apps/cli/src/main.ts`
- Create: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: daemon `createDaemon`, query DTOs/services/errors, and process output callbacks.
- Produces: `parseArgs(argv)`, `renderStatus`, `renderAgents`, `renderEvents`, `renderGraph`, `runCli`, and an executable `patchmesh` bin.

- [ ] **Step 1: Add failing parser/renderer/exit tests**

Test valid command parsing, required values, unsupported options, deterministic human output, stable JSON output, NDJSON events, redaction in raw mode, degraded status exit `0`, usage exit `2`, unavailable store exit `3`, replay/cursor exit `4`, and SIGINT follow exit `0`.

```ts
test("rejects unscheduled commands with usage exit code", async () => {
  const result = await runCli(["watch"], testDependencies);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unsupported command/i);
});

test("graph JSON output is stable and contains no Phase 2 fields", async () => {
  const first = await runCli(["graph", "--json"], testDependencies);
  const second = await runCli(["graph", "--json"], testDependencies);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.includes("findings"), false);
  assert.equal(first.stdout.includes("validity"), false);
});
```

- [ ] **Step 2: Run CLI tests to verify they fail**

Run: `corepack pnpm --filter @patchmesh/cli test`

Expected: FAIL because parser, renderers, command dispatch, and package bin do not exist.

- [ ] **Step 3: Implement the pure argument parser**

Parse only `status`, `agents`, `events`, and `graph`; global `--database` and `--json`; command-specific options from the M6 spec; and `--raw`, `--follow`, `--cursor` for events. Reject unknown commands/options, missing values, invalid IDs, unsupported agent lifecycle filters, invalid event types, malformed times, and non-positive limits with a usage error.

- [ ] **Step 4: Implement deterministic renderers**

Render stable human labels/tables and JSON/NDJSON from already redacted DTOs. Human status must omit paused/overlap/stale/finding/validity fields. Human agents render null task as `-`. Events `--json` emits one redacted `EventPage` object per line, matching the documented NDJSON contract. Graph output sorts nodes/edges and prints coverage warnings after graph content.

- [ ] **Step 5: Implement `runCli` and executable wiring**

Create `runCli(argv, dependencies)` that parses, dispatches to daemon services, writes stdout/stderr through injected sinks, maps typed errors to exit codes, and returns without calling `process.exit` in tests. `main.ts` supplies process streams, resolves `--database`, installs SIGINT handling for follow, and invokes `runCli`. The package bin must point to the compiled main module; it must not expose lifecycle commands.

- [ ] **Step 6: Run CLI tests, typecheck, and build**

Run: `corepack pnpm --filter @patchmesh/cli test`, `corepack pnpm --filter @patchmesh/cli typecheck`, and `corepack pnpm --filter @patchmesh/cli build`

Expected: PASS for all four commands, output modes, filters, redaction, follow shutdown, and exit categories.

### Task 6: Update CLI/M6 Documentation and Evidence

**Files:**
- Modify: `docs/CLI.md`
- Modify: `docs/implementation/phase1/PHASE_1_MILESTONES.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/implementation/phase1/evidence/PHASE_1_M6_EVIDENCE.md`

**Interfaces:**
- Consumes: verified query, daemon, and CLI behavior from Tasks 1-5.
- Produces: current documentation that marks only the four M6 commands implemented and keeps all Phase 2/unscheduled commands planned or unavailable.

- [ ] **Step 1: Update CLI availability and M6 examples**

Change the top-level CLI status and command table to mark `status`, `agents`, `events`, and `graph` available. Update their roadmap labels, options, cursor/follow behavior, redaction language, and exit codes. Remove Phase 2-only fields such as paused tasks, open overlaps, possibly stale, findings, decisions, validity, and integration-target claims from M6 examples. Keep `overlaps`, `stale`, `explain`, and lifecycle/dashboard commands unavailable.

- [ ] **Step 2: Update Phase 1 status documentation**

Mark M6 complete in `docs/implementation/phase1/PHASE_1_MILESTONES.md`, link its evidence, add M6 complete status to `docs/ROADMAP.md`, and state in `docs/ARCHITECTURE.md` that read services and in-process CLI composition are implemented. Preserve unrelated Phase 2-5 roadmap edits.

- [ ] **Step 3: Add M6 evidence**

Record exact focused/full test, typecheck, build, Phase 0 validator/test, and diff-check commands. Document DTO limits, output modes, redaction, filters, cursor/follow semantics, no-write behavior, coverage limitations, and explicit M7/Phase 2 deferrals. Do not mark evidence verified until Task 7 passes.

- [ ] **Step 4: Run documentation validation**

Run: `node tools/phase0/validate.mjs` and `git diff --check`

Expected: `Phase 0 corpus valid` and no whitespace errors.

### Task 7: Full M6 Verification and Scope Review

**Files:**
- Review: all files changed by Tasks 1-6.

- [ ] **Step 1: Run focused package tests**

Run: `corepack pnpm --filter @patchmesh/query test`, `corepack pnpm --filter @patchmesh/daemon test`, and `corepack pnpm --filter @patchmesh/cli test`

Expected: all query, daemon, and CLI tests pass with explicit M6-only output.

- [ ] **Step 2: Run recursive workspace tests, typechecks, and builds**

Run: `corepack pnpm --recursive test`, `corepack pnpm --recursive typecheck`, and `corepack pnpm --recursive build`

Expected: all existing protocol/collector/storage/observation/adapter tests plus M6 tests pass; all workspace packages build.

- [ ] **Step 3: Run Phase 0 validation and tests**

Run: `node tools/phase0/validate.mjs` and `node --test tools/phase0/*.test.mjs`

Expected: `Phase 0 corpus valid` and 47 passing Phase 0 tests without schema or fixture changes.

- [ ] **Step 4: Review staged scope and output claims**

Run: `git status --short`, `git diff --check`, and inspect the changed-file list. Confirm no changes were made to protocol schemas, migrations, adapters, or unrelated Phase 2-5 documentation. Confirm CLI output contains no Phase 2 findings, decisions, validity, overlap, stale, or lifecycle claims.

- [ ] **Step 5: Finalize M6 evidence and record verified state**

Update `PHASE_1_M6_EVIDENCE.md` with final results, store the verified M6 state in project memory with affected paths, and report the exact worktree/commit state. Do not commit unless explicitly requested.
