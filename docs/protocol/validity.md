# PatchMesh Work-Product Validity Contract

> **Status:** Phase 0 normative contract. Targeted revalidation is Phase 3 behavior.

Task execution state and work-product validity are independent projections. `completed`
means execution ended, not that the work is valid. Validity states are `unassessed`,
`valid`, `possibly_stale`, `revalidating`, and `stale`.

Allowed transitions are `unassessed -> valid` after a successful current-target
validation, `unassessed -> possibly_stale` or `valid -> possibly_stale` after an
evidence-backed dependency impact, `possibly_stale -> revalidating` with a named work
product, command, and target, and `revalidating -> valid|stale|possibly_stale` for
successful, failed/deterministic, or inconclusive/interrupted/superseded results.
Obsolete target results remain evidence and cannot transition current validity. Rework
creates a new validity record; corrections are new events.
