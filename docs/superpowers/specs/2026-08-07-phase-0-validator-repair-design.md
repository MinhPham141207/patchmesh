# PatchMesh Phase 0 Validator Repair Design

**Date:** 2026-08-07
**Status:** Approved for implementation planning

## Context

The Phase 0 contract corpus is present and its supplied fixtures pass, but a
read-only review found validator paths that accept incomplete or contradictory
artifacts. The roadmap completion marker also predates the required final
verification and clean task boundary.

This repair strengthens the existing language-neutral validator without adding
Phase 1 runtime code, storage, adapters, packages, apps, or a product CLI.

## Goals

1. Reject positive scenarios without declared expected projections.
2. Bind graph dependency edges to the exact dependency event that supports them.
3. Enforce evidence-backed and current-target validity transition guards.
4. Represent decisions targeted to an agent, a task, or both, while rejecting an
   empty target.
5. Make event-type and payload discrimination enforceable by the envelope schema
   and repository validator.
6. Require the exact Phase 0 benchmark workload sets.
7. Convert malformed or missing corpus artifacts into deterministic contract
   diagnostics rather than raw tool failures.
8. Enforce canonical projection ordering and scan every loaded fixture artifact
   for prohibited secret patterns.
9. Add regression tests and negative fixtures for every repaired invariant.
10. Complete the Phase 0 verification process before retaining the roadmap
    completion marker.

## Non-Goals

- No Phase 1 TypeScript/pnpm workspace.
- No runtime adapter, gateway, daemon, SQLite store, projection engine, or CLI.
- No new coordination behavior or Phase 4 enforcement semantics.
- No broad rewrite of the existing validator architecture.

## Design

### Manifest and Corpus Contracts

Add semantic manifest validation after schema validation:

- positive manifests require non-null expected graph, findings, decisions,
  validity, and coverage paths;
- negative manifests require a declared expected error;
- negative fixtures may omit derived outputs only when validation stops before
  projection;
- loaded artifact failures carry repository-relative diagnostics and exit code
  `1`.

Handle `CorpusContractError` at the validator entry point and use the same
sanitized path/pointer diagnostic format for schema and benchmark JSON failures.

### Dependency Integrity

Index every `dependency.changed` event by `dependencyId` and canonical content.
For every graph `depends_on` edge:

- the nested dependency must be non-null;
- its canonical content must equal the corresponding dependency event payload;
- endpoint resource IDs and endpoint versions must agree;
- edge evidence must be present and related to the dependency record.

Non-dependency edges continue to require `dependency: null`.

### Validity Guards

For `dependency_impact` transitions, evidence must include a valid
`dependency.changed` event. For all transitions except an explicitly
`target_superseded` transition, the transition target must equal the current
record target. A `deterministic_proof` transition cannot make an obsolete target
current. Existing validation-result matching remains mandatory for validation
started, passed, failed, inconclusive, and interrupted outcomes.

### Decision Targets and Event Discrimination

Decision and delivery target schemas use nullable identity definitions. Domain
validation rejects a target where both `agentId` and `taskId` are null.

The event envelope schema will use discriminated branches so each event type
permits only its corresponding payload definition. The entry-point event map
remains as a defense-in-depth check and preserves the stable unsupported-version
diagnostic.

### Benchmarks and Canonical Snapshots

Benchmark validation requires the exact interception operation set:
`noop_route`, `small_file_read`, and `opaque_shell`, in addition to the existing
replay sizes and detector set.

Expected projection bundles and variant comparisons use `canonicalSnapshot`,
which recursively sorts stable-ID arrays and object keys. Variant expected
artifacts are schema-validated and secret-scanned as well as event-scanned.

### Verification and Completion Process

Add focused unit and corpus tests for each repaired rule, including mutation
regressions for the previously passing invalid cases. Run:

- the complete Node test command;
- the Phase 0 validator;
- direct negative-fixture assertions for every declared error;
- JSON parsing, local-link, placeholder, and Phase 1 boundary checks;
- `git diff --check` and final worktree review.

Only after all checks pass will the Phase 0 plan be reconciled, all completed
plan steps be recorded, and the roadmap status remain `Complete`. No commit is
created unless explicitly requested.

## Error Handling

Contract-invalid input produces sorted `PHASE0_*` diagnostics and exit code `1`.
Invocation, filesystem, or validator implementation failures that cannot be
represented as a contract diagnostic remain exit code `2`. Diagnostics never
echo rejected values or secret contents.

## Test Strategy

- Unit tests cover manifest semantics, validity guards, target nullability,
  benchmark operation sets, canonical snapshot ordering, and error mapping.
- Schema tests cover discriminated event payload branches and nullable targets.
- Corpus tests cover graph dependency/event mismatch, missing expected outputs,
  obsolete-target proofs, arbitrary dependency evidence, and variant redaction.
- Existing positive scenarios must remain valid and every negative fixture must
  continue to report its declared primary error.

## Scope Boundary

Changes are limited to Phase 0 schemas, validator libraries, tests, fixtures,
the repair design/implementation plan, and completion documentation. Empty local
`apps/` or `packages/` directories are not populated or converted into runtime
surfaces.
