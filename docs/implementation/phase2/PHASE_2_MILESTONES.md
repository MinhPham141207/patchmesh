# PatchMesh Phase 2 Milestones: Deterministic Detection

> **Status:** Planned. Phase 2 depends on the completed Phase 1 observe-and-replay
> gates. These milestones decompose deterministic findings and report-only policy into
> independently testable vertical slices.

## Purpose

Phase 2 turns the replayable Phase 1 work graph into the first coordination findings.
It detects high-value risks using deterministic evidence while allowing work to
continue. Every finding must be explainable, reproducible from stored events, and
explicit about supporting coverage.

Phase 2 remains report-only. Coordination actions may include `record`, `notify`,
`request_recheck`, and `mark_possibly_stale`, but gateway directives remain `allow` or
`allow_with_notice`. Phase 2 does not pause, reject, redirect, or automatically
revalidate work.

## Milestone Order

Milestones are ordered by dependency. Each milestone must end with executable tests or
recorded measurement evidence; detector scaffolding alone does not complete a
milestone.

### M0: Phase 1 Exit Gate (Planned)

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
- Incremental and cold replay produce equivalent graph state.
- Security and degraded-observability fixtures pass.
- The Phase 1 boundary remains report-only and replayable.

### M1: Finding Contracts and Persistence (Planned)

**Goal:** Establish one deterministic, replayable interface for detector findings.

**Scope:**

- Define typed finding kinds, stable finding identities, source event references,
  affected agents/tasks, confidence, evidence, and coverage.
- Persist each finding as an immutable `finding.created` event. Finding projections
  and reports are rebuildable views; they are never authoritative over the event log.
- Define deduplication, supersession, and replay behavior for repeated graph inputs.
- Keep detector packages independent of any runtime adapter and keep policy separate
  from detection.

**Exit evidence:**

- Valid findings are accepted and malformed findings are rejected at the boundary.
- Identical replay produces byte-equivalent findings.
- Every finding identifies its causal evidence and observation coverage.
- Duplicate and valid out-of-order input variants converge deterministically.

### M2: Same-Symbol Overlap (Planned)

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

### M3: Stale Read Before Write (Planned)

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

### M4: Exported Contract Invalidation (Planned)

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

### M5: Report-Only Policy and CLI Explanation (Planned)

**Goal:** Convert findings into targeted, non-disruptive coordination output.

**Scope:**

- Map findings to `record`, `notify`, `request_recheck`, or
  `mark_possibly_stale` according to confidence and task state.
- Produce targeted explanations containing what changed, who changed it, why the
  target is affected, evidence, and the expected next action.
- Add `patchmesh overlaps`, `patchmesh stale`, and `patchmesh explain <decision-id>`
  through public services rather than direct table queries.
- Support deterministic human and JSON output with redaction and coverage warnings.

**Exit evidence:**

- Policy decisions and gateway directives are reproducible from findings and graph
  state.
- All Phase 2 gateway directives are `allow` or `allow_with_notice`.
- CLI integration tests cover filters, JSON output, missing attribution, degraded
  coverage, dismissal, and explanation details.
- Findings cannot silently pause, reject, or redirect an agent.

### M6: Detector Quality and Phase Exit Gate (Planned)

**Goal:** Measure detector quality before broadening authority or scope.

**Scope:**

- Build a labeled corpus for same-symbol, stale-read, and contract-invalidation cases.
- Measure precision, recall, confidence calibration, false positives, and replay
  determinism per detector.
- Verify irrelevant concurrent changes do not create disruptive output.
- Define numeric acceptance thresholds per detector before the final corpus run, and
  record unresolved coverage limitations.

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
  -> M1 Finding contracts and persistence

M1
  -> M2 Same-symbol overlap
  -> M3 Stale read before write
  -> M4 Exported contract invalidation

M2 or M3 or M4 (at least one stable detector)
  -> M5 Report-only policy and CLI

M2 + M3 + M4 + M5
  -> M6 Detector quality and exit evidence
```

M2-M4 depend on M1 and the Phase 1 graph and may proceed independently. M5 depends on
at least one stable detector and the Phase 1 public query services. M6 depends on all
detectors, policy, and the shared exit evidence.

## Explicitly Deferred

The following work is not part of Phase 2:

- `delay`, `reject`, pause, claims, leases, or other enforcement behavior;
- targeted revalidation execution or validity transitions;
- semantic duplicate-investigation or architectural-conflict authority;
- a second runtime adapter, dashboard, graph database, distributed queue, or
  microservice split.

These items require the later scope and exit evidence defined by `docs/ROADMAP.md`.
