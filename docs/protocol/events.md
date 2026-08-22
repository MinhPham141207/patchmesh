# PatchMesh Event Protocol V1 and Phase 2 Extensions

> **Status:** V1 is the Phase 0 normative contract. Phase 2 adds four backward-
> compatible schema-version-2 event types; V1 readers continue to replay V1 streams.
> Schema version 3 adds proof-bearing forms of three existing Phase 2 event families.

## Envelope

Every event contains the closed envelope defined by
[`event-envelope.schema.json`](../../schemas/phase0/v1/event-envelope.schema.json):
a supported schema version, stable event ID, event type, source kind/producer/instance,
UTC timestamp, repository/workspace/worktree IDs, nullable agent/task attribution,
correlation ID, nullable causation ID, nullable source sequence, and one selected
payload. V1 events use schema version `1`; the Phase 2 extension uses version `2`.
Unknown versions are rejected as `PHASE0_SCHEMA_UNSUPPORTED`.

Source sequence is ordered only within `(source.kind, source.sourceId,
source.instanceId)`. Gaps are degraded coverage, not invented events or causal edges.
Timestamps never establish causality.

## Correlation, causation, and integrity

Correlation groups an originating operation and its derived facts. Root events have a
null causation ID; derived events name exactly one direct parent. Fan-in uses explicit
evidence event IDs. Missing parents are reference errors at bounded replay end.

A writer that receives events from an unordered transport may enable append-time
buffering. An event whose causal parent is not yet durable is then held in a pending
buffer instead of being committed, and is promoted into the log once its parent
arrives; promotion cascades to that event's own buffered children. Buffered events are
excluded from reads and replay, so the durable log stays causally closed and a parent
that never arrives leaves its children quarantined rather than making replay
unresolvable. Buffering is opt-in: a direct append still accepts an out-of-order child.

Event equality is SHA-256 over canonical JSON. Repeated ID plus equal digest is a
no-op; repeated ID plus different digest is `PHASE0_ID_CONFLICT`. Stored events are
append-only. Attribution correction is a new `attribution.corrected` event and never
rewrites original bytes.

## V1 event types

Observation types are `tool.requested`, `tool.completed`, `file.read`, `file.changed`,
`symbol.read`, `symbol.changed`, `task.completed`, `dependency.changed`, and
`attribution.corrected`. Projection facts are `finding.created`, `decision.created`,
`validity.changed`, and `decision.delivery.changed`. The event type-to-payload map is
closed in the envelope validator.

`tool.completed` may include `deterministicallyAttributedEffectEventIds` for watcher
`file.changed` events whose resource identities were explicitly reported by the successful
tool adapter and exactly confirmed by the intercepted observation. These IDs must also be
listed in `effectEventIds`; replay rejects missing, non-watcher, mismatched, or
cross-attribution references. Their absence preserves degraded snapshot-origin coverage.

## Phase 2 V2 event types

[`schemas/phase2/v1/event-envelope.schema.json`](../../schemas/phase2/v1/event-envelope.schema.json)
adds the following immutable extension events without changing V1 payloads:

- `finding.feedback.created` records a feedback ID, finding and optional decision
  reference, actor, disposition, usefulness, reason, and evidence references.
- `write.dependent` records that a task write depends on a previously observed read,
  a durable dependency edge, its causally linked changed resource, and a coverage ID.
  Its optional `comparison` is explicit proof of the candidate dependency version that
  was compared; a legacy write without it remains replayable but cannot prove staleness.
- `evidence.derived` records analyzer/configuration identity, source-event references,
  integration target, coverage, stable fact identity, and normalized signature data
  for a durable symbol or dependency fact.
- `task.concurrency.observed` records an adapter- or gateway-observed overlap between
  two distinct task changes in distinct worktrees. It carries the integration target and
  coverage ID; independent roots alone never establish concurrency.

V2 references are validated when replaying an event set. Feedback must reference a
finding (and, when supplied, its decision) in the same domain and correlation.
Dependent writes require a task-attributed read, matching durable dependency, and
matching changed-resource causation. A supplied comparison must target the read resource
in the same repository and workspace. Concurrency observations require two distinct
task-attributed symbol changes in distinct worktrees from an adapter or gateway. Derived evidence must target its matching
symbol/dependency event, use an analyzer source, and reference existing source events
in the same repository/workspace. Producers must leave evidence degraded rather than
emit an unresolved V2 reference.

## Phase 2 V3 proof-bearing event forms

[`schemas/phase2/v2/event-envelope.schema.json`](../../schemas/phase2/v2/event-envelope.schema.json)
keeps the existing `write.dependent`, `task.concurrency.observed`, and
`evidence.derived` names while requiring replayable proof fields. V2 remains closed
and replayable without those fields; V3 events are selected only by schema version `3`.

Every V3 proof carries the canonical immutable `TargetSnapshot` from the identity
contract. Its digest is the plain hexadecimal SHA-256 of the closed canonical object
`{ integrationTargetId, repositoryId, kind, locator, baseCommit, candidateIds }`, and
its ID is `snapshot_` plus that digest. A branch name alone is never a target proof.

- A V3 `write.dependent` carries a digest-validated observed-read token binding the
  repository, workspace, worktree, task, resource, complete observed version, read
  event, and target snapshot. It also names a candidate comparison, persisted write
  effect, and succeeded completion that deterministically attributes that effect. Its
  comparison target must equal `targetSnapshot.integrationTargetId`.
- A V3 `task.concurrency.observed` carries both agents, tasks, worktrees, same-symbol
  changes, one target snapshot, and either authoritative task-lifetime identities or
  executor-owned tool-window references. References may be from distinct workspace
  contexts but must share the repository; its integration target must equal the snapshot
  target. Timestamps and ordering are not proof.
- A V3 `evidence.derived` carries exactly one proof basis: hash-bound source analysis
  or a resolver-confirmed consumer dependency. Source event/version, input digest,
  target binding, and coverage are validated. Symbol facts require the symbol-contract
  basis; dependency facts require the resolver basis, whose resources must match the
  target dependency. Duplicate sufficient proof records for
  one target event and snapshot are rejected as ambiguous.

An exported-contract signature transition is causal only when a `symbol.changed`
event is explicitly `modified` and its complete `beforeVersion` identifies exactly
one persisted target-bound prior symbol version. Replay never derives prior/current
history from timestamps, source sequence, event IDs, or input order.

V3 validation is fail-closed: incomplete or degraded observations cannot satisfy a
sufficient relationship proof.
