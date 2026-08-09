# PatchMesh Phase 3 Milestones: Targeted Revalidation

> **Status:** Planned. Phase 3 depends on measured Phase 2 detection quality. These
> milestones decompose task validity and targeted proof into independently testable
> vertical slices.

## Purpose

Phase 3 turns a credible detection into the cheapest reliable proof that work remains
valid. It records what a task depended on, selects checks deterministically, executes
or observes those checks, and updates validity through replayable events.

Phase 3 remains non-disruptive. It may request revalidation and mark work possibly
stale or stale according to deterministic evidence, but gateway directives remain
`allow` or `allow_with_notice`. A finding or semantic prediction alone cannot declare
work stale.

## Milestone Order

Each milestone must end with executable tests or recorded measurement evidence. A
validity model without deterministic replay and failure semantics does not complete a
milestone.

### M0: Phase 2 Detection Exit Gate (Planned)

**Scope:**

- Confirm detector precision, recall, calibration, replay, coverage, and report-only
  evidence is recorded.
- Confirm every detector used for Phase 3 meets its Phase 2 threshold or has an
  approved advisory-only exception with an owner and expiry.
- Confirm findings identify affected tasks and dependency paths sufficiently to select
  checks.
- Confirm no Phase 2 policy output depends on unmeasured enforcement behavior.

**Exit evidence:**

- Phase 2 quality thresholds and unresolved limitations are documented.
- Thresholds are met, or every exception is explicit about its scope and prevents the
  affected detector from being used as the sole basis for stale status or enforcement.
- The labeled invalidation corpus is reproducible from stored events.
- Findings and public explanations remain deterministic and redacted.

### M1: Task Validity Model and Events (Planned)

**Goal:** Represent the evidence needed to decide whether a work product remains
valid after task execution has completed.

**Scope:**

- Define validity records containing base revision, work product, observed dependencies,
  validation results, coverage, and integration target.
- Define immutable `validity.changed` events and state-transition invariants.
- Preserve task attribution correction and candidate-version identity.
- Keep execution state separate from validity state. Validity states are exactly
  `unassessed`, `valid`, `possibly_stale`, `revalidating`, and `stale`; execution
  completion neither implies nor transitions validity.
- Represent `started`, `passed`, `failed`, `inconclusive`, and `interrupted` as
  validation outcomes with their command, target, and result evidence. They are not
  validity states.

**Exit evidence:**

- Validity records validate at the protocol boundary.
- Invalid transitions fail deterministically without partial success.
- Incremental processing and replay produce equivalent validity state.
- Original events remain immutable when attribution or validity changes.
- Fixtures distinguish execution completion, validity state, and validation outcome.

### M2: Dependency-to-Check Mapping (Planned)

**Goal:** Select the smallest deterministic set of checks for an affected task.

**Scope:**

- Map the supported Phase 2 evidence classes—files, symbols, exported contracts, and
  explicit dependency paths—to type checks, contract checks, and tests. Schema,
  migration, import, and test-impact analyzers remain Phase 5 work unless Phase 2 has
  already persisted an explicit deterministic dependency fact for the resource.
- Include the dependency path and mapping provenance in each recommendation.
- Represent missing or inferred mappings as coverage limitations.
- Keep analyzers focused on facts and recommendations; they do not decide policy.

**Exit evidence:**

- Every golden invalidation scenario selects a deterministic check set.
- Unrelated changes do not expand the check set without evidence.
- Mappings are reproducible after clean rebuild and replay.
- Fixtures cover missing dependencies, changed integration targets, and degraded
  observation.

### M3: Validity State Transitions (Planned)

**Goal:** Apply detector and validation evidence to task validity consistently.

**Scope:**

- Implement only the normative validity transitions: `unassessed -> valid` after a
  successful current-target validation; `unassessed | valid -> possibly_stale` after
  evidence-backed dependency impact; `possibly_stale -> revalidating` for a named
  work product, command, and target; and `revalidating -> valid | stale |
  possibly_stale` for successful, failed/deterministic, or
  inconclusive/interrupted/superseded validation results.
- Keep `completed`, `failed`, and `cancelled` as execution state. A completed work
  product may be unassessed, valid, possibly stale, revalidating, or stale.
- Require a failed targeted check or explicit deterministic proof before `stale`.
- Preserve prior validity history and link transitions to source findings and events.
- Handle duplicate, out-of-order, failed, interrupted, and superseded validation
  results without inventing success. Results against obsolete targets remain evidence
  and cannot transition current validity.

**Exit evidence:**

- Transition fixtures cover every permitted and rejected state change.
- Replay of duplicate and valid out-of-order events converges.
- A task cannot become valid without the required evidence.
- Stale status is explainable through an immutable evidence chain.

### M4: Revalidation Execution and Result Storage (Planned)

**Goal:** Run approved targeted checks through the gateway or adapter, or ingest
results from an external executor, and connect them to validity decisions.

**Scope:**

- Define the public revalidation service and typed check execution/result contracts.
- The core selects checks but never shells out directly. Execution requires explicit
  task-scoped approval and is translated by the gateway or adapter; externally
  executed results use the same typed result contract.
- Record command intent, process outcome, coverage, and result evidence.
- Link validation results to findings, validity transitions, and integration targets.
- Distinguish check failure, execution failure, observation failure, timeout, and
  interruption.
- Keep execution permissions and runtime-specific translation inside the gateway or
  adapter boundary.

**Exit evidence:**

- Temporary-repository integration tests persist successful, failed, and interrupted
  validation outcomes.
- Restart and replay preserve the same validity result.
- Secrets are redacted and bypassed checks reduce coverage.
- No execution failure is silently converted into a valid state.

### M5: Validity History and Recommended Checks (Planned)

**Goal:** Make revalidation decisions understandable and usable through public APIs.

**Scope:**

- Add read services for current validity, transition history, recommended checks, and
  evidence paths.
- Add deterministic CLI views for validity history and recommended checks.
- Support human and JSON output, filters, redaction, coverage warnings, and stable
  ordering.
- Keep CLI behavior read-only and avoid direct internal storage access.

**Exit evidence:**

- CLI integration tests cover `unassessed`, `valid`, `possibly_stale`,
  `revalidating`, and `stale` validity states, plus completed/failed/cancelled
  execution and passed/failed/inconclusive/interrupted validation outcomes as
  separate fields.
- Every displayed recommendation has a source dependency path and confidence.
- Output remains stable under replay and clean projection rebuild.

### M6: Targeted Proof and Phase Exit Gate (Planned)

**Goal:** Demonstrate that targeted revalidation is cheaper and reliable enough for
  the first golden slice.

**Scope:**

- Run the cross-worktree exported-contract invalidation scenarios through detection,
  recommendation, validation, and validity update.
- Compare targeted checks with the documented broad-check baseline.
- Define the acceptable targeted-to-broad cost ratio before the corpus run.
- Record false positives, overrides, rework avoided, time to detect, and time to
  revalidate during a reproducible scenario corpus. Count an override only when a
  human or orchestrator explicitly dismisses a recommendation, accepts affected work,
  or substitutes a broader check, recording the actor, reason, and outcome.

**Exit evidence:**

- Every Phase 3 roadmap exit gate has passing tests or recorded measurements.
- Relevant checks are selected deterministically for every golden invalidation case.
- Confirmed stale work requires failed validation or deterministic proof.
- The targeted-to-broad cost ratio meets the accepted threshold, or an explicit
  exception records the reason, affected scope, owner, and expiry.
- Metrics and limitations are recorded before any enforcement scope is considered.

## Dependency Graph

```text
M0 Phase 2 exit gate
  -> M1 Task validity model
  -> M2 Dependency-to-check mapping
  -> M3 Validity state transitions
  -> M4 Revalidation execution and storage
  -> M5 Validity history and CLI
  -> M6 Targeted proof and exit evidence
```

M2 depends on M1 and supported Phase 2 evidence production. M3 depends on M1 and M2.
M4 and M5 depend on M3. M6 depends on all preceding milestones.

## Explicitly Deferred

The following work is not part of Phase 3:

- `delay`, `reject`, automatic pause, claims, leases, or other enforcement;
- semantic evidence as the sole basis for stale status;
- a second runtime adapter, dashboard, graph database, distributed queue, or
  microservice split.

These items require the later scope and exit evidence defined by `docs/ROADMAP.md`.
