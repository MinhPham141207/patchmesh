# M5 Work-Graph Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a typed, in-memory, replayable Phase 1 work-graph projection over the existing immutable event stream.

**Architecture:** Add a focused projector to `patchmesh-storage` that implements the existing `ReplayReducer` contract and exposes `projectWorkGraph`, incremental `process`, and frozen `snapshot` APIs. The event store remains authoritative and graph state remains rebuildable in memory; no graph tables, coverage event, detector output, or policy output is added.

**Tech Stack:** Strict TypeScript, pnpm workspace, Node.js >=22.5.0, existing `patchmesh-protocol`, existing `patchmesh-storage` replay/canonical JSON helpers, and `node:test`.

## Global Constraints

- Keep the Phase 1 event set closed: use `tool.requested`, `tool.completed`, `file.read`, `file.changed`, `symbol.read`, `symbol.changed`, `task.completed`, `dependency.changed`, and `attribution.corrected`; do not add a coverage event.
- Keep SQLite append-only and authoritative; do not add graph tables or modify applied migrations.
- Projection state must be rebuildable from events and must not call external services, run tools, deliver decisions, or write events.
- Phase 1 remains observation-only and report-only; do not emit findings, decisions, validity transitions, coordination actions, `delay`, or `reject` directives.
- Use repository/workspace/worktree-scoped resource versions; never derive a global current version across worktrees.
- Preserve nullable attribution and represent later attribution through immutable correction events without mutating original event values or bytes.
- Use explicit assertions rather than snapshots and keep all projection ordering deterministic.
- Do not add a dependency; use the existing canonical JSON and SHA-256 helpers.
- Do not commit changes unless the user explicitly requests a commit.

---

## File Map

Create:

- `packages/storage/src/work-graph-types.ts`: public graph node, edge, coverage, snapshot, replay-result, and projector-state types.
- `packages/storage/src/work-graph-ids.ts`: stable node, version, edge, and coverage identity helpers.
- `packages/storage/src/work-graph-coverage.ts`: conservative coverage derivation from stored tool/effect events and replay gaps.
- `packages/storage/src/work-graph.ts`: reducer, incremental projector, event mapping, correction handling, and canonical snapshot generation.
- `packages/storage/test/work-graph.test.ts`: deterministic unit and integration tests for all M5 behavior.
- `docs/implementation/phase1/evidence/PHASE_1_M5_EVIDENCE.md`: verified scope, commands, behavior evidence, and residual limitations.

Modify:

- `packages/storage/src/index.ts`: export the public M5 graph types and projector API.
- `docs/implementation/phase1/PHASE_1_MILESTONES.md`: mark M5 complete and link its evidence.
- `docs/ROADMAP.md`: mark the Phase 1 M5 status complete and link its evidence if the current document has an M5 status line.
- `docs/ARCHITECTURE.md`: update the current implementation note so graph projections are described as implemented derived state rather than only planned graph tables.

Do not modify:

- `packages/protocol` event schemas or event types.
- `packages/storage/src/migrations/001_events.sql`.
- `packages/observation` or `packages/adapters` behavior.

## Public Interfaces

Use these names and signatures so later M6 work can consume a stable storage boundary:

```ts
export type GraphNodeKind = "agent" | "task" | "resource" | "version";

export type GraphEdgeKind =
  | "performs"
  | "reads"
  | "changes"
  | "depends_on"
  | "references_version";

export interface WorkGraphSnapshot {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly coverage: readonly ProjectionCoverage[];
}

export interface WorkGraphReplayResult {
  readonly orderedEvents: readonly ProtocolEvent[];
  readonly sourceSequenceGaps: readonly SourceSequenceGap[];
  readonly snapshot: WorkGraphSnapshot;
}

export class WorkGraphProjector implements ReplayReducer<WorkGraphState> {
  initialState(): WorkGraphState;
  apply(state: WorkGraphState, event: ProtocolEvent): WorkGraphState;
  process(event: ProtocolEvent): WorkGraphSnapshot;
  snapshot(): WorkGraphSnapshot;
}

export function projectWorkGraph(
  events: readonly ProtocolEvent[],
): WorkGraphReplayResult;
```

The implementation may keep `WorkGraphState` internal if it is not needed by M6, but
the reducer methods must remain structurally compatible with the existing
`ReplayReducer` interface. `projectWorkGraph` must call `replayEvents` so causality,
event-set validation, source-sequence gaps, and no-partial-result behavior remain owned
by M2.

### Task 1: Define Graph Types and Stable IDs

**Files:**
- Create: `packages/storage/src/work-graph-types.ts`
- Create: `packages/storage/src/work-graph-ids.ts`
- Test: `packages/storage/test/work-graph.test.ts`

**Interfaces:**
- Consumes: `ProtocolEvent`, `LogicalResource`, `ResourceVersion`, `SourceSequenceGap`, and `canonicalDigest` from existing packages.
- Produces: `GraphNode`, `GraphEdge`, `ProjectionCoverage`, `WorkGraphSnapshot`, `WorkGraphReplayResult`, `WorkGraphState`, `GraphNodeKind`, and stable ID helpers for Tasks 2-5.

- [ ] **Step 1: Write failing identity and freeze-shape tests**

Add tests that assert stable IDs are unchanged when object key insertion order changes, versions with different domains do not collide, and the public snapshot shape has only `nodes`, `edges`, and `coverage`.

```ts
// The test file defines this helper with fixed valid protocol IDs and only varies
// the worktree field needed to prove domain separation.
function versionForWorktree(worktreeId: WorktreeId): ResourceVersion;

test("version identity includes its version domain", () => {
  const left = versionNodeId(versionForWorktree("wt_a"));
  const right = versionNodeId(versionForWorktree("wt_b"));
  assert.notEqual(left, right);
});

test("coverage identity is independent of input ordering", () => {
  assert.equal(
    coverageId({ scope: "tool:evt_a", modes: ["verified", "intercepted"], gaps: [], evidenceEventIds: ["evt_b", "evt_a"] }),
    coverageId({ scope: "tool:evt_a", modes: ["intercepted", "verified"], gaps: [], evidenceEventIds: ["evt_a", "evt_b"] }),
  );
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts`

Expected: FAIL because the graph types and identity helpers do not exist.

- [ ] **Step 3: Define graph node and edge unions**

Implement discriminated node records with stable IDs and evidence IDs:

```ts
export interface AgentNode {
  readonly kind: "agent";
  readonly nodeId: string;
  readonly agentId: AgentId;
  readonly evidenceEventIds: readonly EventId[];
}

export interface TaskNode {
  readonly kind: "task";
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly evidenceEventIds: readonly EventId[];
  readonly completionEventIds: readonly EventId[];
  readonly workProductIds: readonly WorkProductId[];
}

export interface ResourceNode {
  readonly kind: "resource";
  readonly nodeId: string;
  readonly resource: LogicalResource;
  readonly evidenceEventIds: readonly EventId[];
}

export interface VersionNode {
  readonly kind: "version";
  readonly nodeId: string;
  readonly version: ResourceVersion;
  readonly evidenceEventIds: readonly EventId[];
}
```

Define `GraphEdge` with `fromNodeId: string | null`, `toNodeId: string`, stable edge ID, evidence IDs, `attribution: { agentId: NullableAgentId; taskId: NullableTaskId }`, and kind-specific optional data for change and dependency edges. Define `ProjectionCoverage` with `coverageId`, `scope`, canonical modes, typed gaps, evidence IDs, and presentation. Define internal `WorkGraphState` with retained event facts, correction overrides, nodes, edges, and coverage inputs.

- [ ] **Step 4: Implement canonical identity helpers**

Use canonicalized, sorted inputs before hashing or composing IDs. Provide helpers for:

```ts
agentNodeId(agentId: AgentId): string;
taskNodeId(taskId: TaskId): string;
resourceNodeId(resource: LogicalResource): string;
versionNodeId(version: ResourceVersion): string;
edgeId(kind: GraphEdgeKind, fromNodeId: string | null, toNodeId: string, discriminator: string): string;
coverageId(input: CoverageIdentityInput): CoverageId;
```

The version discriminator must include resource ID, all version-domain IDs, kind, and nullable value. Coverage identity must sort modes, gaps, and evidence IDs before using `canonicalDigest`.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts` and `corepack pnpm --filter patchmesh-storage typecheck`

Expected: PASS for identity tests and strict typechecking.

### Task 2: Implement Resource, Version, Attribution, and Dependency Mapping

**Files:**
- Modify: `packages/storage/src/work-graph.ts`
- Test: `packages/storage/test/work-graph.test.ts`

**Interfaces:**
- Consumes: graph types and ID helpers from Task 1, `ProtocolEvent` unions, and `ReplayReducer`.
- Produces: `WorkGraphProjector.initialState`, `WorkGraphProjector.apply`, and deterministic node/edge state for Tasks 3-5.

- [ ] **Step 1: Add failing mapping tests**

Create typed fixtures for `file.read`, `symbol.read`, `file.changed`, `symbol.changed`, `task.completed`, and `dependency.changed`. Assert that projection contains:

- agent and task nodes for non-null envelope identities;
- resource and version nodes for each referenced resource/version;
- `performs`, `reads`, `changes`, `references_version`, and `depends_on` edges;
- change kind and before/after version IDs on change edges;
- dependency ID, both versions, provenance, and evidence on dependency edges;
- completion and work-product evidence on the task node; and
- null source attribution on activity edges when agent/task IDs are null.

```ts
test("projects resource observations and dependency evidence", () => {
  const snapshot = projectOrdered([fileRead, fileChanged, dependencyChanged]).snapshot;
  assert.equal(snapshot.nodes.filter((node) => node.kind === "resource").length >= 1, true);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "version").length >= 1, true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "reads"), true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "changes"), true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "depends_on"), true);
});
```

- [ ] **Step 2: Run focused tests to verify the mapping is red**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts`

Expected: FAIL because the projector returns no mapped graph facts.

- [ ] **Step 3: Implement immutable state helpers**

Implement helpers that clone only the affected maps/records and return a new state from every `apply` call. Merge repeated node/version/evidence IDs with sorted deduplication. Never mutate a prior state or a protocol event.

- [ ] **Step 4: Implement envelope and resource event mapping**

For every event with non-null envelope identities, upsert agent/task nodes and a `performs` edge when both exist. For read events, upsert the resource and observed version, then add `reads` and `references_version`. For change events, upsert the resource and non-null before/after versions, then add `changes` and `references_version` edges with the change kind and effective nullable attribution.

- [ ] **Step 5: Implement completion and dependency mapping**

For `task.completed`, add completion event and work-product IDs to the effective task node without adding validity state. For `dependency.changed`, create a deterministic `depends_on` edge keyed by dependency ID, retain both versions and provenance observations, and merge equivalent repeated evidence.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts` and `corepack pnpm --filter patchmesh-storage typecheck`

Expected: PASS for all resource, version, task, and dependency mapping tests.

### Task 3: Implement Attribution Corrections and Coverage Derivation

**Files:**
- Create: `packages/storage/src/work-graph-coverage.ts`
- Modify: `packages/storage/src/work-graph.ts`
- Test: `packages/storage/test/work-graph.test.ts`

**Interfaces:**
- Consumes: `WorkGraphState`, `ProjectionCoverage`, event payloads, and `SourceSequenceGap`.
- Produces: correction-aware activity edges, coverage records, and stable coverage helpers for Task 4.

- [ ] **Step 1: Add failing correction and coverage tests**

Add tests for:

- a null-attributed read/change becoming attributed after `attribution.corrected`;
- original event objects retaining null attribution;
- a second correction winning in causal replay order;
- normal request/completion with linked change evidence producing `intercepted` and `verified`;
- opaque requests producing an opaque degraded gap;
- unresolved effect IDs producing an unverified gap;
- out-of-band changes producing an unattributed gap;
- request/completion with no effects remaining interception-only/unknown; and
- source-sequence gaps producing event-stream degraded coverage.

```ts
test("correction changes projected attribution but not the source event", () => {
  const result = projectOrdered([unattributedRead, attributionCorrection]);
  const read = result.orderedEvents.find((event) => event.eventId === unattributedRead.eventId);
  assert.equal(read?.agentId, null);
  assert.equal(result.snapshot.edges.find((edge) => edge.kind === "reads")?.agentId, attributedAgentId);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts`

Expected: FAIL because corrections and coverage are not yet projected.

- [ ] **Step 3: Implement retained attribution overrides**

Store correction target IDs and effective agent/task values in `WorkGraphState`. When a correction is applied, rebuild attribution-dependent activity edges and envelope-derived relationships from retained event facts. Use the last correction in deterministic replay order for one target. Do not rewrite or clone protocol events with changed attribution.

- [ ] **Step 4: Implement persisted-evidence coverage derivation**

Track tool requests, completions, and resource-change events by ID. Derive per-tool coverage as follows:

```text
tool.requested                         -> intercepted
completion.effectEventIds resolving   -> verified
opaque request                         -> opaque unknown/degraded gap
missing effect event                   -> unverified gap
out-of-band change with null causation and attribution -> unattributed gap
source sequence gap                    -> event-stream missing_sequence gap
no effect evidence                     -> intercepted-only unknown
```

Keep the coverage module independent of `patchmesh-observation`; duplicate only the small persisted coverage shape needed by storage. Sort modes, gaps, and evidence before deriving `CoverageId` with the existing canonical digest helper. Recompute coverage when attribution corrections affect evidence.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts` and `corepack pnpm --filter patchmesh-storage typecheck`

Expected: PASS for correction, immutable-source, and coverage behavior.

### Task 4: Add Canonical Snapshots, Replay Integration, and Public Exports

**Files:**
- Modify: `packages/storage/src/work-graph.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/work-graph.test.ts`

**Interfaces:**
- Consumes: reducer and coverage state from Tasks 1-3, `replayEvents`, `canonicalBytes`, and `SqliteEventStore`.
- Produces: `WorkGraphProjector.process`, `WorkGraphProjector.snapshot`, `projectWorkGraph`, and public package exports.

- [ ] **Step 1: Add failing replay-equivalence and immutability tests**

Add tests that:

- project canonical and causally valid out-of-order event variants into equal canonical bytes;
- append duplicates and confirm the projection is unchanged;
- compare incremental `process` output with `projectWorkGraph` output for the same causal sequence;
- confirm snapshots and nested arrays reject mutation in strict mode;
- confirm missing causal parents, cycles, and impossible transitions fail before projection output; and
- pass a valid `finding.created`, `decision.created`, `validity.changed`, and `decision.delivery.changed` event set through replay without adding findings, decisions, validity, or delivery state.

```ts
test("incremental and clean replay produce byte-equivalent snapshots", () => {
  const incremental = new WorkGraphProjector();
  for (const event of orderedObservationEvents) incremental.process(event);
  const rebuilt = projectWorkGraph(orderedObservationEvents);
  assert.deepEqual(canonicalBytes(incremental.snapshot()), canonicalBytes(rebuilt.snapshot));
});
```

- [ ] **Step 2: Run focused tests to verify missing integration behavior**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts`

Expected: FAIL for public APIs, canonical ordering, or incremental/rebuild equivalence until integration is complete.

- [ ] **Step 3: Implement canonical snapshot generation**

Build snapshots from state maps, sort nodes by kind and node ID, sort edges by kind/source/target/edge ID, sort nested evidence arrays, sort coverage by coverage ID, and deep-freeze the complete result. Use `canonicalBytes` in tests rather than relying on object insertion order.

- [ ] **Step 4: Implement reducer and incremental APIs**

Implement `initialState` and `apply` as the `ReplayReducer` boundary. Implement `process` for validated, causally ordered events by applying one event to the projector’s incremental state and returning a frozen snapshot. Implement `projectWorkGraph` by calling `replayEvents(events, new WorkGraphProjector())`, converting the resulting state into a snapshot, adding an `event-stream` coverage record for the returned source-sequence gaps, and returning ordered events and source-sequence gaps unchanged. Incremental `process` does not invent source-sequence gaps because it receives no complete stream boundary; clean replay is the authoritative gap-reporting path.

- [ ] **Step 5: Export only the public M5 surface**

Update `packages/storage/src/index.ts` to export graph types, `WorkGraphProjector`, and `projectWorkGraph`. Keep mutable state helpers and internal identity maps unexported. Do not change package dependencies or migrations.

- [ ] **Step 6: Run focused tests, typecheck, and build**

Run: `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts`, `corepack pnpm --filter patchmesh-storage typecheck`, and `corepack pnpm --filter patchmesh-storage build`

Expected: PASS with generated declarations exposing only the intended public API.

### Task 5: Record M5 Evidence and Update Current Documentation

**Files:**
- Create: `docs/implementation/phase1/evidence/PHASE_1_M5_EVIDENCE.md`
- Modify: `docs/implementation/phase1/PHASE_1_MILESTONES.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: verified projector behavior and command output from Tasks 1-4.
- Produces: current documentation that distinguishes implemented M5 projection behavior from deferred Phase 2 behavior.

- [ ] **Step 1: Add M5 evidence with exact verification commands**

Document:

- status and verification date;
- base revision if available;
- focused storage test/typecheck/build results;
- full workspace test/typecheck/build results;
- Phase 0 validator and test results;
- `git diff --check` result;
- graph node and edge mappings;
- canonical replay and incremental equivalence evidence;
- correction immutability evidence;
- conservative persisted-evidence coverage limitation; and
- explicit absence of findings, decisions, validity, directives, migrations, and graph tables.

- [ ] **Step 2: Update milestone and roadmap status**

Change M5 from planned to complete only after all verification commands pass. Link `PHASE_1_M5_EVIDENCE.md` from the M5 milestone and roadmap status. Keep M6 and M7 marked planned.

- [ ] **Step 3: Update architecture implementation notes**

Revise the current-status and event-store/live-work-graph notes so they state that M5 provides in-memory rebuildable graph projections while SQLite remains event-only. Do not rewrite planned detector, policy, daemon, or CLI sections as implemented.

- [ ] **Step 4: Run documentation checks**

Run: `node tools/phase0/validate.mjs` and `git diff --check`.

Expected: Phase 0 corpus remains valid and no whitespace errors are reported.

### Task 6: Full Verification and Review

**Files:**
- Review: all files changed by Tasks 1-5.

- [ ] **Step 1: Run the complete workspace test suite**

Run: `corepack pnpm --recursive test`

Expected: all protocol, collector, storage, observation, and adapter tests pass, including the new M5 projection tests.

- [ ] **Step 2: Run recursive typechecks and builds**

Run: `corepack pnpm --recursive typecheck` and `corepack pnpm --recursive build`

Expected: every workspace package typechecks and builds successfully, including copied storage migration assets.

- [ ] **Step 3: Run Phase 0 validation and tests**

Run: `node tools/phase0/validate.mjs` and `node --test tools/phase0/*.test.mjs`

Expected: validator prints `Phase 0 corpus valid` and all Phase 0 tests pass without fixture or schema changes.

- [ ] **Step 4: Review the diff for scope and behavior**

Run: `git diff --check` and inspect `git status --short` plus `git diff --stat`.

Confirm that only the storage projector, its tests, M5 evidence, and required current documentation changed; no protocol schema, migration, adapter, detector, policy, daemon, or CLI behavior was added.

- [ ] **Step 5: Record the final verified state**

Update the M5 evidence document with the final command results and residual risks. Store the verified M5 implementation state in project memory with affected paths before reporting completion.
