# PatchMesh Roadmap

> **Status:** Phase 1 is complete through M7. Phase 2 deterministic detection is in
> progress and remains report-only; its exit gates are not met. Later capabilities remain
> planned.

## Purpose

This roadmap defines build order, scope boundaries, and the evidence required before
PatchMesh gains more authority over running agents. It intentionally avoids calendar
dates until implementation velocity is known.

## Delivery rules

1. Build one end-to-end vertical slice before broadening the resource graph.
2. Prefer deterministic evidence before semantic analysis.
3. Begin in report-only mode.
4. Measure detector quality and runtime overhead before enabling enforcement.
5. Every phase must remain replayable, explainable, and usable on its own.
6. Later-phase work requires an explicit roadmap update when pulled forward.

## Initial user and scenario

The initial user is a developer or small platform team running at least two coding
agents in separate Git worktrees for one repository.

The golden scenario is cross-worktree exported-contract invalidation: one agent uses
an exported function, another proposes a signature change, and PatchMesh explains the
prospective impact and requests targeted revalidation before integration.

## Phase 0 — Foundation

**Status:** Complete — contract corpus and exit evidence verified.

**Goal:** Make the first implementation slice unambiguous and measurable.

**Deliverables:**

- canonical repository, workspace/worktree, integration-target, and resource-version identities;
- a versioned event envelope with correlation, causation, attribution, and idempotency rules;
- separate coordination-action and gateway-directive vocabularies;
- state-transition invariants for task validity and decision delivery;
- dependency-provenance and observability-coverage models;
- a threat model covering local identity, event integrity, path handling, and redaction;
- golden event-log scenarios for relevant and irrelevant concurrent changes;
- benchmark definitions for interception latency, replay, and detector quality.

**Exit gates:**

- every scenario has expected events, graph state, findings, decisions, and coverage;
- event and state schemas contain no unresolved identity or nullability conflicts;
- replay and projection-equivalence tests can be implemented without inventing behavior;
- opaque shell and adapter limitations have explicit degraded-mode behavior;
- planned behavior is labeled consistently throughout the documentation.

**Evidence implementation:**

- identity and version rules: [`docs/protocol/identities.md`](protocol/identities.md);
- event envelope and ordering: [`docs/protocol/events.md`](protocol/events.md);
- action, directive, and delivery rules: [`docs/protocol/coordination.md`](protocol/coordination.md);
- validity invariants: [`docs/protocol/validity.md`](protocol/validity.md);
- provenance and coverage: [`docs/protocol/evidence-and-coverage.md`](protocol/evidence-and-coverage.md);
- replay equivalence: [`docs/protocol/replay-equivalence.md`](protocol/replay-equivalence.md);
- threat model: [`docs/THREAT_MODEL.md`](THREAT_MODEL.md);
- schemas, golden scenarios, benchmark definitions, and validator:
  `schemas/phase0/`, `fixtures/`, `benchmarks/phase0/`, and
  `tools/phase0/validate.mjs`.

These artifacts define and validate Phase 0 behavior. They do not implement Phase 1
runtime observation, storage, projections, or CLI commands.

## Phase 1 — Observe and Replay

**Goal:** Capture one runtime's activity and reproduce derived state without making coordination decisions that interrupt work.

**M0 prerequisite:** Complete. See [`docs/implementation/phase0/PHASE_0_M0_EVIDENCE.md`](implementation/phase0/PHASE_0_M0_EVIDENCE.md).

**M1 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M1_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M1_EVIDENCE.md).

**M2 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M2_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M2_EVIDENCE.md).

**M3 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M3_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M3_EVIDENCE.md).

**M4 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M4_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M4_EVIDENCE.md).

**M5 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M5_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M5_EVIDENCE.md).

**M6 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M6_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M6_EVIDENCE.md).

**M7 status:** Complete. See [`docs/implementation/phase1/evidence/PHASE_1_M7_EVIDENCE.md`](implementation/phase1/evidence/PHASE_1_M7_EVIDENCE.md).

**Deliverables:**

- TypeScript/pnpm modular-monolith workspace;
- shared protocol package and boundary validation;
- one MCP proxy or runtime adapter;
- pre-tool request and post-tool outcome events;
- Git/worktree, filesystem, content-hash, and process-result observation;
- append-only SQLite event storage with migrations;
- rebuildable work-graph projections;
- observability-coverage reporting;
- `patchmesh status`, `agents`, `events`, and `graph` CLI commands.

**Exit gates:**

- golden event logs replay deterministically;
- clean rebuilds produce equivalent projections;
- duplicate and out-of-order event fixtures are handled idempotently;
- missing task attribution is accepted and can later be corrected;
- security fixtures persist no unredacted secrets;
- bypassed or opaque operations reduce reported coverage rather than appearing fully observed;
- p50 and p95 interception overhead are measured and recorded;
- a proposed Phase 2 interception-overhead budget is recorded for acceptance at the
  Phase 2 M0 gate.

**Implementation milestones:** [`docs/implementation/phase1/PHASE_1_MILESTONES.md`](implementation/phase1/PHASE_1_MILESTONES.md).

## Phase 2 - Deterministic Detection

**Goal:** Detect the first coordination risks in report-only mode.

**Implementation milestones:** [`docs/implementation/phase2/PHASE_2_MILESTONES.md`](implementation/phase2/PHASE_2_MILESTONES.md).

**Deliverables:**

- a bounded deterministic evidence pipeline for observed file reads, source-derived
  symbol and exported-contract changes, known consumers, and dependency paths;
- same-symbol overlap detector;
- stale-read-before-write detector;
- exported-function or API-contract invalidation detector;
- dependency paths with evidence and provenance;
- `record`, `notify`, `request_recheck`, `mark_possibly_stale`, and `request_revalidation` policy actions;
- immutable findings, decisions, delivery state, dismissal, and notification-usefulness
  feedback with rebuildable views and versioned protocol compatibility;
- `patchmesh overlaps`, `stale`, and `explain <decision-id>` CLI commands.

**Exit gates:**

- a labeled scenario corpus reports precision and recall per detector;
- numeric quality thresholds are defined per detector before the final corpus run, and
  each detector meets its threshold or has an approved advisory-only exception;
- every finding is reproducible from stored events;
- decision creation, delivery, dismissal, and usefulness feedback replay
  deterministically under duplicate and valid out-of-order inputs;
- unsupported or incomplete resource evidence reports degraded coverage rather than
  guessed symbol, consumer, or dependency facts;
- irrelevant concurrent changes do not trigger disruptive directives;
- all gateway directives remain `allow` or `allow_with_notice`;
- users can dismiss findings and record whether a notification was useful.

## Phase 3 - Targeted Revalidation

**Goal:** Turn detection into the cheapest reliable proof that work remains valid.

**Implementation milestones:** [`docs/implementation/phase3/PHASE_3_MILESTONES.md`](implementation/phase3/PHASE_3_MILESTONES.md).

**Deliverables:**

- task validity records containing base revision, work product, observed dependencies, validation results, coverage, and integration target;
- mappings from supported deterministic evidence to targeted type checks, contract
  checks, and tests;
- separate execution state, validity state, and validation outcome, with
  `unassessed -> valid`, `unassessed | valid -> possibly_stale`,
  `possibly_stale -> revalidating`, and
  `revalidating -> valid | stale | possibly_stale` validity transitions;
- revalidation results stored as events and linked to their decisions;
- gateway- or adapter-mediated check execution, plus ingestion of externally executed
  typed results;
- CLI views for validity history and recommended checks.

**Exit gates:**

- relevant checks are selected deterministically for every golden invalidation scenario;
- validation results update task state reproducibly under replay;
- targeted revalidation costs less than the documented broad-check baseline for the corpus;
- the targeted-to-broad cost ratio meets an accepted threshold, or an explicit scoped
  exception is approved;
- confirmed stale work requires failed validation or explicit deterministic proof;
- false-positive, override, rework-avoided, and time-to-detect metrics are recorded during dogfooding.

## Phase 4 - Measured Enforcement

**Goal:** Permit narrowly scoped, opt-in intervention only where measured evidence supports it.

**Implementation milestones:** [`docs/implementation/phase4/PHASE_4_MILESTONES.md`](implementation/phase4/PHASE_4_MILESTONES.md).

**Deliverables:**

- versioned claim lifecycle facts plus fenced, transactional atomic arbitration for
  enforceable resources and integration targets;
- `delay` and `reject` gateway directives behind explicit configuration;
- per-operation fail-open/fail-closed policy;
- decision acknowledgment, retry, expiry, override, and audit behavior;
- crash and partial-execution reconciliation;
- an approved authority decision record bound to the exact enforcement scope and
  validated configuration digest, with superseding re-approval for material changes;
- human or orchestrator approval for ambiguous intervention.

**Exit gates:**

- simultaneous pre-check races have deterministic scenario coverage;
- concurrent gateways cannot obtain two current fencing tokens for the same
  enforceable scope;
- gateway restarts and partial execution reconcile without duplicate tool execution;
- every intervention can be overridden and audited;
- the accepted false-interruption rate and latency budget are documented and met;
- semantic evidence alone cannot delay or reject an operation;
- enforcement activation requires every Phase 4 M6 exit gate and corpus to pass, plus
  the approved non-expired authority record, exact validated configuration digest, and
  completed reconciliation and safety evidence; otherwise directives remain `allow`
  or `allow_with_notice`.

## Phase 5 - Expansion

**Goal:** Broaden compatibility only after the first slice meets a predeclared,
measured avoided-rework admission threshold.

**Implementation milestones:** [`docs/implementation/phase5/PHASE_5_MILESTONES.md`](implementation/phase5/PHASE_5_MILESTONES.md).

**Candidate work, ordered by measured need:**

1. a second runtime adapter and adapter-capability parity reporting;
2. schema, migration, import, and test-impact analyzers;
3. semantic duplicate-investigation or architectural-conflict findings;
4. staged local multi-repository, then remote execution models;
5. dashboard and organization-level policy controls.

Each candidate requires its own design, predeclared numeric admission threshold,
baseline, measurement window, approver, and measured justification. Semantic findings
remain advisory until independently corroborated; canonical replay uses recorded
semantic outputs, while any model reproduction audit reports mismatches explicitly.

## Metrics

Track at least:
- observation coverage and bypass rate;
- unknown agent and task attribution rate;
- detector precision, recall, and confidence calibration by class;
- time to detect and time to revalidate;
- notification usefulness, dismissal, override, and reversal rates;
- stale work caught before write, commit, or integration;
- estimated rework and unnecessary restarts avoided;
- duplicate, lost, and out-of-order event rates;
- replay determinism and projection rebuild equivalence;
- semantic reproduction-audit mismatch rate and declared tolerance exceptions;
- p50 and p95 interception latency plus CPU, memory, and storage growth;
- secret-redaction failures.

## Explicitly deferred from the MVP

- automatic pause or rejection;
- LLM-based duplicate-work or architectural-conflict enforcement;
- claims and leases not required by the first report-only slice;
- multiple runtime adapters;
- distributed queues, microservices, or a graph database;
- a dashboard, cloud control plane, or multi-tenant policy system.
