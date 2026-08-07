# PatchMesh Event Protocol V1

> **Status:** Phase 0 normative contract. No collector or event store exists yet.

## Envelope

Every event contains the closed envelope defined by
[`event-envelope.schema.json`](../../schemas/phase0/v1/event-envelope.schema.json):
exactly schema version `1`, stable event ID, event type, source kind/producer/instance,
UTC timestamp, repository/workspace/worktree IDs, nullable agent/task attribution,
correlation ID, nullable causation ID, nullable source sequence, and one selected
payload. Unknown versions are rejected as `PHASE0_SCHEMA_UNSUPPORTED`.

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
