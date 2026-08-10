# Phase 2 Golden Scenario: Deterministic Watcher Attribution

## Goal

Make the Phase 2 golden path executable end to end:

```text
MCP tool call -> real file mutation -> watcher snapshots -> deterministic attribution
-> sufficient projected coverage -> same-symbol finding
```

The implementation must not remove or weaken degraded-coverage guards for snapshot-only,
opaque, failed, bypassed, or out-of-band effects.

## Design

Successful tool execution results gain optional structured effect metadata containing the
resource IDs the adapter directly observed the operation changing. `McpProxy` will persist
the matched changed-event IDs in an optional `deterministicallyAttributedEffectEventIds`
field on `tool.completed`. The storage projection will use only those durable IDs to treat
a watcher-observed change as deterministically attributed, and only when:

- the execution succeeded;
- the operation is not opaque;
- the execution reports one or more changed resource IDs;
- the reported IDs exactly match the intercepted watcher changes; and
- after excluding the known snapshot-origin gap, the watcher captures contain no other
  observation gaps or out-of-band changes.

The proxy will retain the existing watcher-origin `file.changed` events and causal
`tool.completed.effectEventIds`. It will resolve the existing snapshot-origin gap only for
this exact structured match. All other paths remain degraded. No source kind is relabeled,
and no synthetic protocol event is injected.

## Integration Scenario

Add a real integration test to the existing `tools/phase1` harness:

- create a temporary Git repository with an initial exported TypeScript symbol;
- create two detached linked worktrees from the repository;
- execute real file mutations inside each worktree through `McpProxy`;
- use `NodeObservationBoundary` with `source.kind: "watcher"` for before/after captures;
- enable the existing TypeScript source analysis;
- return structured changed-resource metadata from each executor;
- append only events emitted by the proxy to SQLite;
- run `createPhase2RuntimeRecords` over the stored events;
- assert projected coverage is `sufficient`, the symbol changes are durable, and a
  `same_symbol_overlap` finding and report-only decision are produced.

The test must fail before the production change because watcher coverage is currently
degraded, and must continue to prove that the real filesystem and Git worktree paths are
used rather than injected protocol fixtures.

## Compatibility and Safety

The new execution metadata is optional, so existing callers retain current behavior and
snapshot-only effects remain degraded. Failed and interrupted executions cannot promote
coverage. A mismatch between reported and observed effects remains an explicit degraded
coverage result. Existing unit and integration tests remain unchanged except for the new
success-path metadata where needed.

## Rejected Alternatives

- Relabeling watcher events as adapter or analyzer events would hide provenance and weaken
  the existing source-origin guard.
- Treating `targetResourceId` or a free-form operation string as proof would verify intent,
  not actual effect.
- Adding a new attribution event would provide explicit durability but expands the protocol
  and projection surface unnecessarily for this existing causal relationship.
