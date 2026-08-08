# PatchMesh Roadmap

> **Status:** Planned roadmap. M1 through M4 are implemented; the remaining Phase 1 and
> later capabilities are not implemented.

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
- p50 and p95 interception overhead are measured and recorded.

**Implementation milestones:** [`docs/implementation/phase1/PHASE_1_MILESTONES.md`](implementation/phase1/PHASE_1_MILESTONES.md).

## Phase 2 — Deterministic Detection

**Goal:** Detect the first coordination risks in report-only mode.

**Deliverables:**

- same-symbol overlap detector;
- stale-read-before-write detector;
- exported-function or API-contract invalidation detector;
- dependency paths with evidence and provenance;
- `record`, `notify`, `request_recheck`, `mark_possibly_stale`, and `request_revalidation` policy actions;
- `patchmesh overlaps`, `stale`, and `explain <decision-id>` CLI commands.

**Exit gates:**

- a labeled scenario corpus reports precision and recall per detector;
- accepted quality thresholds are recorded from measured baseline data;
- every finding is reproducible from stored events;
- irrelevant concurrent changes do not trigger disruptive directives;
- all gateway directives remain `allow` or `allow_with_notice`;
- users can dismiss findings and record whether a notification was useful.

## Phase 3 — Targeted Revalidation

**Goal:** Turn detection into the cheapest reliable proof that work remains valid.

**Deliverables:**

- task validity records containing base revision, work product, observed dependencies, validation results, coverage, and integration target;
- mappings from changed resources to targeted type checks, contract checks, and tests;
- `completed -> possibly_stale -> revalidating -> valid | stale` transitions;
- revalidation results stored as events and linked to their decisions;
- CLI views for validity history and recommended checks.

**Exit gates:**

- relevant checks are selected deterministically for every golden invalidation scenario;
- validation results update task state reproducibly under replay;
- targeted revalidation costs less than the documented broad-check baseline for the corpus;
- confirmed stale work requires failed validation or explicit deterministic proof;
- false-positive, override, rework-avoided, and time-to-detect metrics are recorded during dogfooding.

## Phase 4 — Measured Enforcement

**Goal:** Permit narrowly scoped, opt-in intervention only where measured evidence supports it.

**Deliverables:**

- fenced claims or equivalent atomic arbitration for enforceable resources;
- `delay` and `reject` gateway directives behind explicit configuration;
- per-operation fail-open/fail-closed policy;
- decision acknowledgment, retry, expiry, override, and audit behavior;
- crash and partial-execution reconciliation;
- human or orchestrator approval for ambiguous intervention.

**Exit gates:**

- simultaneous pre-check races have deterministic scenario coverage;
- gateway restarts and partial execution reconcile without duplicate tool execution;
- every intervention can be overridden and audited;
- the accepted false-interruption rate and latency budget are documented and met;
- semantic evidence alone cannot delay or reject an operation.

## Phase 5 — Expansion

**Goal:** Broaden compatibility only after the first slice demonstrates useful avoided rework.

**Candidate work, ordered by measured need:**

1. a second runtime adapter and adapter-capability parity reporting;
2. schema, migration, import, and test-impact analyzers;
3. semantic duplicate-investigation or architectural-conflict findings;
4. multi-repository and remote execution models;
5. dashboard and organization-level policy controls.

Each candidate requires its own design and measured justification. Semantic findings
remain advisory until independently corroborated.

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
- p50 and p95 interception latency plus CPU, memory, and storage growth;
- secret-redaction failures.

## Explicitly deferred from the MVP

- automatic pause or rejection;
- LLM-based duplicate-work or architectural-conflict enforcement;
- claims and leases not required by the first report-only slice;
- multiple runtime adapters;
- distributed queues, microservices, or a graph database;
- a dashboard, cloud control plane, or multi-tenant policy system.
