# PatchMesh Coordination Contract

> **Status:** Phase 0 normative contract. Coordination remains planned and report-only.

An event is an immutable fact, a finding is a detector interpretation, and a decision
is a policy result for one finding. Every finding and decision carries evidence,
coverage, stable identities, and confidence. A decision separately records a
coordination action and gateway directive.

Phase 0 has no runtime emission. Phase 1 permits `record` and `allow`; Phase 2 and 3
permit `record`, `notify`, `request_recheck`, `mark_possibly_stale`, and
`request_revalidation` with `allow` or `allow_with_notice`. `delay` and `reject` are
Phase 4 opt-in vocabulary only and are rejected in Phase 0-3 fixtures.

Decision state and delivery state are separate. Delivery states are `pending`,
`delivered`, `acknowledged`, and `failed`; delivery IDs are stable for a decision and
target. Duplicate delivery and acknowledgment events are idempotent. Replay rebuilds
delivery state and never sends a message or enforces a directive. Retry, expiry,
override, and crash-time redispatch are deferred.
