# PatchMesh Phase 0 Threat Model

> **Status:** Phase 0 normative security contract for planned local-first behavior.

## Scope and assets

Assets are repository/workspace/worktree identity, event integrity, logical paths,
resource versions, dependency evidence, decisions, coverage claims, fixtures, and
validator diagnostics. Runtime sandboxing, signatures, authentication, and remote
multi-tenant security are outside Phase 0.

## Trust boundaries and mitigations

Adapters, gateways, watchers, analyzers, filesystem/Git metadata, process output, and
fixture data are untrusted. Opaque IDs, exact domain associations, canonical duplicate
digests, unsupported-version rejection, causal/reference checks, source-instance
sequences, path confinement, NFC/collision rejection, secret scans, and non-echoing
diagnostics mitigate the required local identity, event integrity, path, and redaction
threats. The validator performs no network access or tool execution.

Unknown or bypassed activity is a coverage limitation, not proof of safety. Opaque
effects remain degraded. Valid fixtures use `<redacted>` and negative fixtures use
synthetic sentinels only.

## Residual risks

Phase 0 defines contracts and evidence, not OS sandboxing, event signing, durable
storage, runtime authentication, or enforcement. Those risks remain explicit.

## Threat-to-fixture traceability

| Threat | Fixture | Expected result |
| --- | --- | --- |
| Conflicting event retry | `conflicting-duplicate-id` | `PHASE0_ID_CONFLICT` |
| Unsupported envelope | `unsupported-schema` | `PHASE0_SCHEMA_UNSUPPORTED` |
| Missing causal parent | `missing-reference` | `PHASE0_REFERENCE_MISSING` |
| Repository escape | `path-traversal` | `PHASE0_SCHEMA_INVALID` |
| Cross-domain identity | `cross-domain-reference` | `PHASE0_SCHEMA_INVALID` |
| Invalid validity proof | `invalid-transition` | `PHASE0_TRANSITION_INVALID` |
| Coverage overclaim | `coverage-overclaim` | `PHASE0_COVERAGE_OVERCLAIMED` |
| Secret-shaped value | `synthetic-secret` | `PHASE0_SECRET_PATTERN` |
| Opaque effects | `opaque-shell-degraded` | valid degraded coverage |
| Missing attribution | `late-attribution` | valid immutable correction |
