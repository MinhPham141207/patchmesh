# M5 Replayable Work-Graph Projections Design

**Date:** 2026-08-08
**Status:** Approved design

## Goal

Implement Phase 1 milestone M5, `Replayable Work-Graph Projections`, on top of the
existing `patchmesh-storage` event store and replay core.

The implementation will build a live work graph as rebuildable derived state from
validated events. The event log remains the source of truth. The projection is
observation-only and report-only: it must not emit detector findings, policy
decisions, validity transitions, gateway directives, or coordination actions.

## Scope

M5 includes:

- A typed in-memory work-graph projection in `patchmesh-storage`.
- Incremental processing for causally ordered events.
- Clean projection rebuild through the existing replay reducer interface.
- Agent and task projection from nullable event-envelope attribution.
- Resource and version projection from resource observation and change events.
- Dependency edges from `dependency.changed` events.
- Conservative coverage derived from persisted observation evidence.
- Immutable attribution correction in projected state.
- Canonical, stable-order graph snapshots.
- Deterministic projection tests and M5 evidence documentation.

M5 does not include:

- SQLite graph tables or graph-specific migrations.
- A graph database or external projection service.
- AST, import, API, schema, or test analyzers.
- Same-symbol, stale-read, or exported-contract detectors.
- Findings, decisions, validity state, policy, notification, or enforcement.
- A daemon, CLI, HTTP API, or second runtime adapter.
- A new coverage event type.

## Architecture

Add a focused projection module to `packages/storage`. It will implement the existing
`ReplayReducer<State>` contract so M2's validated causal replay remains the boundary
for clean rebuilds.

The public surface will include:

```ts
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

export function projectWorkGraph(
  events: readonly ProtocolEvent[],
): WorkGraphReplayResult;
```

`WorkGraphProjector` will additionally expose `process(event)` for incrementally
processing already validated, causally ordered events and `snapshot()` for a frozen
current snapshot. Both paths will use the same event-to-state mapping. Corrections may
rebuild affected derived facts from retained event facts so that no stale attribution
edge remains.

The SQLite event store remains append-only and authoritative. No graph state is
persisted in SQLite. Projection state is held in memory and is always recoverable by
replaying events.

## Graph Model

The graph contains four node kinds:

- `agent`: every non-null effective `agentId` referenced by an event envelope.
- `task`: every non-null effective `taskId` referenced by an event envelope.
- `resource`: every logical resource referenced by a resource or dependency event.
- `version`: every resource version referenced by a resource observation, change, or
  dependency event.

Nodes contain their canonical identity and sorted evidence event IDs. Resource nodes
retain the logical resource fields. Version nodes retain the complete resource version
including its repository/workspace/worktree version domain, version kind, value, and
sorted evidence IDs. A version is not marked globally current: event inputs do not
provide a valid cross-worktree current-version role.

Edges are typed and carry sorted, deduplicated evidence event IDs. The required edge
types are:

- `performs`: agent to task when both envelope identities are present.
- `reads`: attributed task, agent, or no source to a resource for `file.read` and
  `symbol.read`.
- `changes`: attributed task, agent, or no source to a resource for `file.changed` and
  `symbol.changed`; the edge retains the change kind and before/after version IDs.
- `depends_on`: dependent resource to dependency resource from `dependency.changed`;
  the edge retains dependency ID, both versions, provenance observations, and evidence.
- `references_version`: resource to each observed version used by a resource event.

An activity edge with no source preserves missing attribution without inventing an
agent or task node. Effective attribution is stored on activity edges so a correction
can replace the projected relationship without changing the source event.

`task.completed` adds completion evidence and work-product identity to the effective
task node. It does not create a validity record or imply that the work product is
valid.

Tool lifecycle events provide activity and coverage evidence but do not create
detector graph state. Projection event types (`finding.created`, `decision.created`,
`validity.changed`, and `decision.delivery.changed`) are accepted by protocol replay
but ignored by this Phase 1 projector.

## Version and Identity Rules

Resource identity comes from the protocol's repository-scoped logical resource ID.
Version identity is derived from:

- resource ID;
- repository, workspace, and worktree version domain;
- version kind; and
- version value, including null for `deleted`.

Repeated observations of the same version merge evidence IDs. They do not create
duplicate version nodes. Version and resource records are retained across worktrees;
the projector must not compare them as one unscoped global current value.

## Event Mapping

The projector applies events in the causal order supplied by `replayEvents`.

### Envelope attribution

For every event, non-null envelope agent and task identities create corresponding
nodes. When both are present, the effective attribution creates the `performs` edge.
The event ID is evidence for any node or edge created from the envelope.

### Resource observations

`file.read` and `symbol.read` create or merge the logical resource and observed version,
then add a `reads` activity edge and a `references_version` edge. The activity edge
retains the event attribution, including null values.

`file.changed` and `symbol.changed` create or merge the logical resource and both
versions when present. They add a `changes` activity edge and `references_version`
edges for the before and after versions. The edge retains `created`, `modified`,
`deleted`, or `renamed` change kind.

### Dependencies

`dependency.changed` creates or replaces the projection for its dependency ID. The
resulting `depends_on` edge is bound to the event's dependency ID and retains the
dependent and dependency versions, provenance observations, and all declared evidence
event IDs. Repeated equivalent facts merge evidence; a conflicting dependency ID is
handled by the protocol/event-store identity rules rather than silently merged.

### Completion

`task.completed` records completion event IDs and work-product IDs on the effective task
node. It does not emit a validity or detector record.

### Attribution correction

`attribution.corrected` records an override for its target event. The target's
activity edges and attribution-dependent coverage are rebuilt using the corrected agent
and task IDs. If multiple valid corrections target one event, the last correction in
deterministic replay order is effective. Original event objects and stored canonical
bytes are never changed.

## Coverage Projection

The Phase 1 event set is closed and has no coverage event. M5 therefore derives
conservative `ProjectionCoverage` records only from persisted event evidence.

Coverage records contain:

- stable coverage ID;
- scope, normally `tool:<request-event-id>` or `event-stream`;
- canonical modes from `intercepted`, `verified`, `inferred`, and `unknown`;
- explicit gaps with kind, scope, reason, and evidence IDs;
- sorted evidence event IDs; and
- presentation of `sufficient`, `degraded`, or `unknown`.

The derivation rules are:

- `tool.requested` contributes `intercepted`.
- A `tool.completed` event contributes completion evidence.
- An effect ID resolves to `verified` only when it identifies a stored resource-change
  event linked to that completion.
- Opaque requests produce an unknown/degraded gap because their prospective effects
  are not enumerable.
- Unresolved effect IDs produce an unverified gap.
- Out-of-band resource changes with no causal request and no attribution produce an
  unattributed/unknown gap.
- Replay source-sequence gaps produce a missing-sequence degraded coverage record.
- A tool with no persisted effect evidence is interception-only/unknown, not fully
  observed. The projector cannot infer that no effect occurred.

M4 coverage diagnostics returned to a caller but not persisted as events cannot be
reconstructed during replay. The projector will not invent those diagnostics or claim
that they were stored. This limitation is part of the M5 evidence and remains a
constraint for later daemon/CLI work.

Coverage IDs are derived from the canonical scope, modes, gaps, and evidence IDs, so
equivalent event sets produce equivalent coverage records. Coverage records are sorted
by stable ID in snapshots.

## Canonical Snapshot Rules

Snapshots are deep-frozen and JSON-safe. Arrays are sorted by stable identity:

- nodes by node kind and node ID;
- edges by edge type, source identity, target identity, and edge ID;
- versions and evidence IDs lexicographically by their canonical IDs;
- coverage by coverage ID.

Object keys use the existing canonical JSON serializer when byte equivalence is tested.
Duplicate IDs and repeated evidence are deduplicated. Canonical and valid causally
out-of-order inputs must produce byte-equivalent snapshots after replay. Incremental
processing and clean replay of the same causal sequence must also produce byte-equivalent
snapshots.

## Error and Boundary Behavior

`projectWorkGraph` delegates event ordering and event-set validation to
`replayEvents`. Missing causal references, causal cycles, impossible transitions,
schema errors, and conflicting event IDs fail before a snapshot is returned. The
projector must not return a partial success state.

The incremental API accepts only validated, causally ordered events. It does not write
to SQLite, run tools, deliver decisions, or call external services. Unsupported
projection meaning is ignored only for the four existing projection event types; an
invalid event is still rejected by the protocol/replay boundary.

## Verification

M5 tests will use explicit assertions and deterministic protocol fixtures. They will
cover:

- all Phase 1 observation event mappings;
- agents, tasks, resources, versions, reads, changes, dependencies, and missing
  attribution;
- opaque, out-of-band, unresolved-effect, and source-sequence coverage gaps;
- canonical, duplicate, and valid causally out-of-order event sets;
- incremental versus clean replay byte equivalence;
- attribution correction changing projected state while original event data remains
  unchanged;
- ignored projection-event types and absence of findings, decisions, validity, or
  directives;
- frozen snapshots and deterministic ordering; and
- no graph-specific SQLite tables or migrations.

Completion verification will run the focused storage tests, the complete workspace
test suite, recursive typechecks and builds, the Phase 0 validator and test suite, and
`git diff --check`. M5 evidence will record the commands, results, projection mapping,
coverage limitation, and deferred Phase 2 behavior.
