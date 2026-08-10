# Phase 2 Completion Design

## Status

Design for the ordered Phase 2 completion increments. The existing stale-read
false-positive fix and unrelated working-tree changes remain outside this design.

## Goal

Complete Phase 2 as a report-only, replayable detection phase without weakening
degraded-observability guards. The implementation must turn real, reviewed agent
evidence into auditable detector inputs, while keeping unknown effects unknown.

## Evidence Baseline

The committed `.evidence` parent and child traces are structurally valid and
preserve local ordering, parent linkage, attribution, and one real tool failure.
They contain only explicit unknown-effect gaps and zero verified effect coverage.
They are valid evidence-journal data, but are not detector-quality labels and do
not prove filesystem changes. The recorder benchmark is also not the Phase 1
`NodeObservationBoundary` interception benchmark and cannot by itself accept M0.

## Increment Order

Each increment has its own regression tests, focused verification, and checkpoint.

1. M5 cross-worktree contract dependencies, multiple consumers, and compatibility.
2. M2 durable analyzer metadata, configuration, integration-target provenance, and history.
3. M4 evidence cases plus M6 report-only CLI and delivery coverage.
4. M7 field corpus from real agent traces with human-reviewed labels.
5. M0 interception-budget acceptance and normative V2 protocol documentation.

No increment enables enforcement. Gateway directives remain `allow` or
`allow_with_notice`; unsupported, opaque, bypassed, mismatched, failed, and
unobserved operations remain degraded.

## M5 Contract Dependencies

### Durable contract history

Derived symbol and dependency facts will carry a versioned analysis provenance
record containing:

- analyzer ID and version;
- canonical configuration digest and configuration fields required for replay;
- source event IDs;
- repository, workspace, worktree, and integration-target identity;
- coverage status and explicit degradation reason;
- stable symbol/contract identity and normalized signature data where supported.

The provenance will be represented by a backward-compatible Phase 2 V2 event
extension rather than silently changing the meaning of existing V1 payloads.
V1 event streams remain replayable. V2 validation rejects incomplete provenance
or cross-domain references.

### Cross-worktree and multiple-consumer matching

Dependency resolution will match producer contracts and consumer imports by
repository, workspace, integration target, resource identity, and exported name.
Worktree identity will distinguish versions, not prevent a producer in one
worktree from serving a consumer in another. Unsupported, ambiguous, bare, or
cross-target imports remain unresolved and degraded.

All matching consumers will be retained. Projection and detector input will use
one contract-to-many-consumers representation, not a map that overwrites earlier
consumers.

### Compatibility classification

The supported TypeScript/JavaScript classifier will compare normalized exported
signatures and classify changes as compatible, breaking, or unknown. Unknown and
unsupported changes remain lower-confidence or produce no high-authority finding.
Deletion is breaking only when the prior contract and its provenance are durable.
The classifier is pure, versioned, deterministic, and covered by compatible,
breaking, unrelated, ambiguous, and missing-history fixtures.

## M2 Durable Evidence

The adapter remains responsible only for bounded source observation and appending
fact events. Analyzer functions remain pure. Replay reconstructs analyzer facts
from stored events without reading the current filesystem or relying on transient
adapter memory.

Every detector input must be traceable through source event IDs to the observed
file/read/change event and must retain the analyzer/configuration/integration
target metadata needed to explain the result. A source hash mismatch, unavailable
file, parser failure, unsupported language, opaque operation, or missing metadata
produces degraded coverage and no guessed symbol or dependency fact.

Incremental, duplicate, restart, and valid out-of-order processing must converge
to byte-equivalent facts and projections.

## M4 and M6

M4 tests will cover current reads, stale reads, pre-read versions, irrelevant
changes, out-of-order input, corrected attribution, bypassed operations, changed
integration targets, and failed or incomplete observation. The existing causal
replay-order guard remains in place.

M6 will add public-service CLI tests for JSON and human output, filters, missing
attribution, degraded coverage, delivery transitions, dismissal, usefulness
feedback, and complete decision explanations. Delivery and feedback remain
append-only and deterministic under duplicates and valid reordering.

## M7 Field Corpus

The synthetic corpus remains an advisory engineering gate. A separate versioned
field corpus will be built from committed `.evidence` traces and corresponding
PatchMesh event streams only when post-tool effects are actually observed.

Each case requires:

- anonymized trace/event references;
- detector type and scenario metadata;
- human-reviewed expected finding label;
- reviewer identity and review timestamp;
- coverage classification and unresolved limitations;
- replay digest and detector output digest.

The current parent/child traces may contribute trace-integrity and failure-path
cases, but cannot be labeled as detector positives or negatives because their
effect coverage is zero. Precision, recall, false-positive rate, calibration,
and replay determinism are calculated per detector. No threshold is accepted
without the raw cases, review record, and declared holdout separation.

## M0 and Protocol Documentation

M0 will measure the actual `NodeObservationBoundary` interception path over the
declared repository-size tiers, retaining raw samples, environment metadata,
p50/p95 calculations, failures, and workload definition. The decision record
will explicitly accept, defer with owner and due gate, or reject the proposed
budget. Recorder-only benchmark results remain separate evidence.

Normative protocol documentation will describe all Phase 2 V2 event types,
version selection, backward replay behavior, provenance fields, reference rules,
degraded coverage requirements, and report-only directive limits. Schemas,
TypeScript types, validators, fixtures, and documentation change together.

## Safety and Non-Goals

- No delay, reject, pause, redirect, automatic revalidation, or enforcement.
- No inferred effect becomes verified without durable observation evidence.
- No semantic compatibility result becomes high-authority without supported,
  versioned evidence and sufficient coverage.
- No raw prompts, hidden reasoning, credentials, full environment values, or
  unreviewed agent output is stored.
- No changes to the unrelated `.evidence` implementation or existing stale-read
  working-tree changes outside the scoped increment.

## Acceptance

Phase 2 is accepted only when M0 through M6 have executable evidence, the field
M7 corpus meets approved per-detector thresholds or has an explicit advisory-only
exception, all findings replay from stored events, degraded paths remain visible,
and all gateway directives remain non-disruptive.
