# PatchMesh Dependency Evidence and Observability Coverage

> **Status:** Phase 0 normative contract. Coverage is evidence, not a global boolean.

Every dependency edge records logical endpoints, applicable resource versions, event
evidence, and one or more provenance observations. Provenance is `declared`,
`statically_observed`, `dynamically_observed`, or `semantically_inferred`. Each
observation names its producer and analyzer or rule version when applicable; a
non-declared observation without a rule version is invalid.

Coverage is scoped to an operation or relationship. Modes are `intercepted`, `verified`,
`inferred`, and `unknown`; interception and effect verification are orthogonal. A
coverage record lists evidence and explicit gaps. A relevant unknown gap derives
`degraded` presentation, and inferred evidence cannot silently replace required direct
observation. Findings and decisions may reference only related coverage evidence.

Opaque shell requests may be intercepted while effects are verified afterward. Any
unverified effect class remains an explicit gap; pre-write completeness is never
claimed.
