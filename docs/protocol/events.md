# PatchMesh Event Protocol V1 and Phase 2 V2 Extensions

> **Status:** V1 is the Phase 0 normative contract. Phase 2 adds two backward-
> compatible schema-version-2 event types; V1 readers continue to replay V1 streams.

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

V2 references are validated when replaying an event set. Feedback must reference a
finding (and, when supplied, its decision) in the same domain and correlation.
Dependent writes require a task-attributed read, matching durable dependency, and
matching changed-resource causation. Producers must leave evidence degraded rather
than emit an unresolved V2 reference.
