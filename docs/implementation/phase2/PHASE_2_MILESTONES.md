# PatchMesh Phase 2 Milestones: Deterministic Detection

> **Status:** In progress. Phase 2 depends on the completed Phase 1 observe-and-replay
> gates. These milestones decompose deterministic findings and report-only policy into
> independently testable vertical slices.

## Purpose

Phase 2 turns the replayable Phase 1 work graph into the first coordination findings.
It detects high-value risks using deterministic evidence while allowing work to
continue. Every finding must be explainable, reproducible from stored events, and
explicit about supporting coverage.

Phase 2 remains report-only. Coordination actions may include `record`, `notify`,
`request_recheck`, `mark_possibly_stale`, and `request_revalidation`, but gateway
directives remain `allow` or `allow_with_notice`. A request for revalidation is a
durable recommendation; Phase 2 does not execute checks, pause, reject, redirect, or
automatically revalidate work.

## Implementation Status

| Milestone | Current evidence | Status |
| --- | --- | --- |
| M0 budget | Versioned M0 v1 contract and strict evidence schema; deterministic local-Git/SQLite fixture generator; paired direct-vs-`McpProxy` raw benchmark; fail-closed raw-evidence verifier | Deferred — implementation and reduced smoke coverage pass, but no independent clean-revision controlled artifact has been generated or verified |
| M1 contracts | Immutable V2 feedback; replayed finding/decision/delivery/feedback views; deterministic feedback/delivery writes; replay-time V2 reference checks | Partial — append-time out-of-order buffering and a complete compatibility audit remain |
| M2 evidence | Hash-bound TypeScript/JavaScript source facts, durable V2 analyzer provenance, symbol events, resolver-confirmed dependency events, degraded unsupported/opaque handling | Partial — broader analyzer history, supported-language coverage, and real adapter emission of the new relationship proofs remain |
| M3 overlap | Deterministic same-symbol detector requiring sufficient derived metadata, matching target, and explicit adapter/gateway concurrency proof across worktrees | Partial — production concurrency observation and a reviewed labeled corpus remain |
| M4 stale read | Explicit `write.dependent` comparison reference, integration target, durable-reference guard, replay reconstruction, and report-only path | Partial — production comparison capture, corrected-attribution corpus cases, and labeled acceptance remain |
| M5 contracts | Cross-worktree resolver, strict sufficient/exported target metadata, multiple-consumer retention, deterministic supported-function compatibility classification, durable history | Partial — complete contract history, broader signatures, and reviewed corpus remain |
| M6 report-only | Policy, explanation, append-only feedback CLI, and daemon delivery/feedback writers | Partial — delivery command UX and full CLI scenario coverage remain |
| M7 quality | Deterministic metrics/gate functions; versioned synthetic corpus; fail-closed field corpus/evaluator that recomputes trace and artifact digests; internal-ready [`patchmesh-site` transparent MCP gateway](M7_HOST_ADAPTER_BOUNDARY.md) | Blocked externally — the gateway is tested and capability-detectable, but no actual `patchmesh-site` runtime has yet owned a tool execution through it or produced reviewed detector-quality holdouts |

## Milestone Order

Milestones are ordered by dependency. Each milestone must end with executable tests or
recorded measurement evidence; detector scaffolding alone does not complete a
milestone.

### M0: Phase 1 Exit Gate (Deferred)

This is a prerequisite gate, not a detector milestone.

**Scope:**

- Confirm Phase 1 replay, projection, coverage, CLI, golden-slice, and performance
  evidence is complete.
- Accept the Phase 1 interception-overhead baseline and record the operational budget
  that Phase 2 must preserve.
- Confirm the event store and graph projection are stable inputs for detector replay.
- Confirm the observation-only golden scenario emits no Phase 2 findings or decisions.
- Resolve any protocol, attribution, coverage, or projection ambiguity before detector
  logic is added.

**Exit evidence:**

- Every Phase 1 exit gate has passing tests or recorded measurements.
- The Phase 1 overhead budget is explicitly accepted, deferred with an owner and due
  gate, or rejected with a documented reason; detector work cannot silently inherit
  an unreviewed performance baseline.
- Current decision: deferred to `phase2-runtime` at the `M0 observation benchmark
  remediation` gate. `corepack pnpm phase2:m0:benchmark` writes the canonical default
  `benchmarks/phase2/m0-evidence.generated.json`; `-- --output <artifact.json>` may select
  another path. Independent verification is
  `corepack pnpm phase2:m0:verify -- [artifact.json] --commit <revision> --environment
  <expected-environment.json>`. The expected-environment file is established independently
  for the controlled runner and has exactly `os`, `osRelease`, `architecture`, `cpu`,
  `memoryBytes`, `nodeVersion`, and `pnpmVersion`. Omitting either independent revision or
  environment binding is valid structural verification but remains deferred. A qualifying
  artifact must be generated from the exact clean revision on that controlled stable
  environment; ordinary CI runs only the reduced smoke and verifier regressions. No
  qualifying clean-revision artifact exists yet. The legacy single-run evaluator is
  diagnostic-only and cannot accept M0. Legacy measurements remain recorded in
  [`benchmarks/phase2-m0-budget.json`](../../benchmarks/phase2-m0-budget.json); the
  small and large tiers exceed the provisional p95 budgets.
- Incremental and cold replay produce equivalent graph state.
- Security and degraded-observability fixtures pass.
- The Phase 1 boundary remains report-only and replayable.

### M1: Finding, Decision, and Feedback Contracts (Partial)

**Goal:** Establish deterministic, replayable contracts for findings, policy output,
delivery, and user feedback.

**Scope:**

- Define typed finding kinds, stable finding identities, source event references,
  affected agents/tasks, confidence, evidence, and coverage.
- Persist each finding as an immutable `finding.created` event. Finding projections
  and reports are rebuildable views; they are never authoritative over the event log.
- Persist every policy result as an immutable `decision.created` event and every
  delivery change as `decision.delivery.changed`; decision views are rebuildable and
  never authoritative over the event log.
- Define a versioned, backward-compatible protocol extension for immutable finding
  feedback. It must record a stable feedback ID, finding and optional decision
  reference, actor, disposition, usefulness, reason, and source evidence. Existing V1
  readers must remain able to replay V1 event streams without interpreting the new
  feedback event.
- Define deduplication, supersession, and replay behavior for repeated graph inputs.
- Define the command/API surface for dismissing a finding and recording notification
  usefulness. Acknowledgment alone is not dismissal or usefulness feedback.
- Keep detector packages independent of any runtime adapter and keep policy separate
  from detection.

**Exit evidence:**

- Valid findings are accepted and malformed findings are rejected at the boundary.
- Identical replay produces byte-equivalent findings.
- Every finding identifies its causal evidence and observation coverage.
- Duplicate and valid out-of-order input variants converge deterministically.
- Decision creation, delivery state, dismissal, and usefulness feedback converge under
  duplicate and valid out-of-order inputs, with a stable replayed history.

### M2: Deterministic Evidence Production (Partial)

**Goal:** Produce the production evidence required by the Phase 2 detectors rather
than relying on synthetic fixture events.

**Scope:**

- Add a bounded, deterministic evidence pipeline for supported languages and tool
  operations. It must emit `file.read` only when the adapter or gateway can identify
  the read resource and observed version; file-level access must not invent a
  symbol-level read.
- Derive `symbol.changed`, exported-contract versions, and known consumer/import
  relationships from versioned source analysis and observed file changes. Record the
  parser/analyzer version, configuration, source event IDs, integration target, and
  coverage with every derived fact.
- Accept `symbol.read` only from a symbol-scoped runtime observation or explicit
  structured tool metadata. If an operation supplies only a file read, retain it as a
  file read and report the missing symbol coverage.
- Emit `dependency.changed` facts for supported exported-contract and consumer paths.
  Unsupported languages, opaque artifacts, ambiguous parses, and unavailable reads
  must produce degraded coverage rather than guessed dependencies.
- Keep analyzers fact-producing and side-effect free. This milestone emits no finding,
  decision, or gateway directive.

**Exit evidence:**

- Temporary-repository integration tests produce file-read, symbol-change,
  exported-contract, consumer, and dependency facts from real supported source files.
- Facts are stable across incremental processing, clean replay, duplicates, and valid
  out-of-order source events.
- File-only reads, opaque operations, unsupported languages, and parse failures are
  explicitly degraded and cannot masquerade as symbol or dependency evidence.
- Analyzer metadata and source-event provenance make every detector input auditable.

### M3: Same-Symbol Overlap (Partial)

**Goal:** Detect concurrent changes to the same symbol without treating all shared
access as a conflict.

**Scope:**

- Compare symbol reads and changes across agents, worktrees, revisions, and explicit
  integration targets.
- Distinguish harmless shared reads, complementary work, and concurrent symbol changes.
- Include the observed and candidate symbol versions in finding evidence.
- Avoid emitting a finding when attribution, version identity, or coverage is
  insufficient; record the limitation instead.

**Exit evidence:**

- Labeled fixtures cover same-symbol overlap, shared reads, complementary changes,
  unrelated symbols, duplicate events, and missing attribution.
- Findings contain a stable dependency path and source event IDs.
- Replay and projection rebuild produce the same finding set.
- No detector emits a gateway directive or coordination action directly.

### M4: Stale Read Before Write (Partial)

**Goal:** Detect a write based on a resource version that changed after it was read.

**Scope:**

- Compare each dependent write with the immutable version observed by the task.
- Distinguish stale reads from current reads, unrelated changes, and unverified effects.
- Report the read version, candidate version, dependent write, and integration target.
- Treat bypassed or incomplete observation as degraded evidence rather than proof of
  freshness.

**Exit evidence:**

- Fixtures cover stale and current reads, irrelevant changes, out-of-order events,
  corrected attribution, and bypassed operations.
- A stale finding is reproducible from stored events without wall-clock assumptions.
- Coverage gaps reduce confidence or suppress a finding according to the contract.
- Detector results remain observation-only.

### M5: Exported Contract Invalidation (Partial)

**Goal:** Detect when a candidate exported-function or API-contract change affects a
known consumer.

**Scope:**

- Represent exported symbols or contracts, consumers, versions, and dependency paths.
- Detect signature or contract changes that invalidate a consumer's observed version.
- Preserve provenance from the changed contract through the dependency path to the
  affected task.
- Keep unsupported or inferred relationships explicit and lower-confidence.

**Exit evidence:**

- The cross-worktree exported-contract golden scenario produces a reproducible finding.
- Fixtures cover compatible changes, breaking changes, unrelated exports, missing
  dependency evidence, and changed integration targets.
- Each finding includes the changed contract, affected consumer, evidence path,
  confidence, and coverage.
- Semantic inference alone cannot produce a high-authority finding.

### M6: Report-Only Policy, Delivery, Feedback, and CLI Explanation (Partial)

**Goal:** Convert findings into targeted, non-disruptive coordination output.

**Scope:**

- Map findings to `record`, `notify`, `request_recheck`, `mark_possibly_stale`, or
  `request_revalidation` according to confidence and task state. The last action is a
  request only; targeted execution remains Phase 3 work.
- Produce targeted explanations containing what changed, who changed it, why the
  target is affected, evidence, and the expected next action.
- Persist policy decisions, notification deliveries, dismissal, and usefulness
  feedback through the M1 contracts. Show the current decision state and immutable
  response history without mutating earlier events.
- Add `patchmesh overlaps`, `patchmesh stale`, and `patchmesh explain <decision-id>`
  through public services rather than direct table queries.
- Support deterministic human and JSON output with redaction and coverage warnings.

**Exit evidence:**

- Policy decisions and gateway directives are reproducible from findings and graph
  state.
- All Phase 2 gateway directives are `allow` or `allow_with_notice`.
- CLI integration tests cover filters, JSON output, missing attribution, degraded
  coverage, decision delivery, dismissal, usefulness feedback, and explanation
  details.
- Findings cannot silently pause, reject, or redirect an agent.

### M7: Detector Quality and Phase Exit Gate (Blocked)

**Goal:** Measure detector quality before broadening authority or scope.

**Scope:**

- Build a labeled corpus for same-symbol, stale-read, and contract-invalidation cases.
- Measure precision, recall, confidence calibration, false positives, and replay
  determinism per detector.
- Verify irrelevant concurrent changes do not create disruptive output.
- Define numeric acceptance thresholds per detector before the final corpus run, and
  record unresolved coverage limitations.

The checked-in synthetic engineering corpus under `tools/phase2/` uses the following
unchanged provisional engineering thresholds: precision >= 0.95, recall >= 0.90,
Brier score <= 0.10, and false-positive rate <= 0.02. Its evaluator reports one
true positive, four true negatives, zero false positives, and zero false negatives
for each detector. This result is explicitly `synthetic_engineering` and
`advisoryOnly`; it is not field validation and cannot authorize broader detector
authority. Reviewed production feedback must be added as a holdout corpus before
the final M7 exit decision.

The field-v2 contract foundation is checked in under `.evidence/schema/` with separate
case-index, production-input, reviewer-label, and generated-output schemas. The matching
`tools/phase2/field-v2-contracts.ts` loaders enforce canonical digests, approved-root and
symlink confinement, protocol-event validation, adapter-capability binding, and independent
reviewer identity. These contracts do not constitute a production adapter, field exporter,
promoted holdout corpus, generated detector output, or M7 evidence; those remain blocked by
the production-host capability checkpoint.

PR4 internal readiness is implemented as `PatchMeshSiteMcpGateway` in
`@patchmesh/adapters`. When a host contract declares synchronous gateway capability,
it provides a transparent MCP dispatch path that calls `McpProxy.execute` exactly
once, uses authoritative runtime/session identity, rejects payload identity conflicts,
and forwards only same-store persisted completion-linked events to the recorder with a
versioned capability digest. This is not evidence of a real production host run: the
external `patchmesh-site` runtime must still wire the gateway around actual execution
before the production-host checkpoint becomes unblocked. Relationship-proof capture,
field export/dispatcher, and holdout collection remain PR5–PR7 work and are not
implied by this adapter.

**Exit evidence:**

- Every Phase 2 roadmap exit gate has passing tests or recorded measurements.
- Every finding is reproducible from stored events.
- Each detector meets its approved precision, recall, calibration, and false-positive
  thresholds, or has an explicit approved exception naming the detector, scope,
  reason, owner, and expiry. An exception keeps that detector advisory and prevents
  it from being the sole basis for stale status or enforcement.
- The golden scenario remains report-only and all gateway directives remain non-
  disruptive.

## Dependency Graph

```text
M0 Phase 1 exit gate
  -> M1 Finding, decision, and feedback contracts
  -> M2 Deterministic evidence production

M1 + M2
  -> M3 Same-symbol overlap
  -> M4 Stale read before write
  -> M5 Exported contract invalidation

M3 or M4 or M5 (at least one stable detector)
  -> M6 Report-only policy, delivery, feedback, and CLI

M3 + M4 + M5 + M6
  -> M7 Detector quality and exit evidence
```

M2 depends on M1 and the Phase 1 graph. M3-M5 depend on M1, M2, and their respective
evidence classes; they may proceed independently. M6 depends on at least one stable
detector and the Phase 1 public query services. M7 depends on all detectors, policy,
delivery, feedback, and the shared exit evidence.

## Explicitly Deferred

The following work is not part of Phase 2:

- `delay`, `reject`, pause, claims, leases, or other enforcement behavior;
- targeted revalidation execution or validity transitions;
- semantic duplicate-investigation or architectural-conflict authority;
- a second runtime adapter, dashboard, graph database, distributed queue, or
  microservice split.

These items require the later scope and exit evidence defined by `docs/ROADMAP.md`.
