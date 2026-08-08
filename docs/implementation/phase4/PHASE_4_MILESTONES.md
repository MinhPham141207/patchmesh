# PatchMesh Phase 4 Milestones: Measured Enforcement

> **Status:** Planned. Phase 4 depends on measured Phase 3 revalidation outcomes and
> an explicit authority decision. These milestones decompose narrowly scoped,
> opt-in enforcement into independently testable vertical slices.

## Purpose

Phase 4 permits intervention only where deterministic evidence, recovery behavior,
latency, and user override have been measured. Enforcement is an authority increase,
not a default gateway behavior change.

Every intervention must be explainable, auditable, reversible where practical, and
bound to an explicit policy. Semantic evidence alone cannot delay or reject an
operation.

## Milestone Order

Each milestone must end with executable tests or recorded measurement evidence. No
milestone enables enforcement implicitly through scaffolding.

### M0: Phase 3 Revalidation Exit Gate (Planned)

**Scope:**

- Confirm targeted checks, validity transitions, failure handling, and cost evidence
  are complete.
- Confirm stale status requires failed validation or deterministic proof.
- Record the authority level and operation classes proposed for opt-in enforcement.
- Create an authority decision record naming the approver, exact operation and resource
  classes, confidence requirements, fail-open/fail-closed policy, expiry, rollback,
  and emergency override rules.

**Exit evidence:**

- Phase 3 metrics and limitations are documented.
- The enforcement candidate set is narrow, explicit, and backed by high-confidence
  scenarios.
- The authority decision record is approved and versioned; no directive is enabled by
  this gate alone.
- Report-only behavior remains the default.

### M1: Enforceable Resource Arbitration (Planned)

**Goal:** Prevent simultaneous unsafe operations on explicitly enforceable resources.

**Scope:**

- Define fenced claims or an equivalent atomic arbitration mechanism for selected
  resources and integration targets.
- Bind ownership, expiry, revision, and evidence to immutable events.
- Handle claim acquisition, renewal, release, expiration, and conflicting attempts.
- Keep claims out of resources that lack the required deterministic identity.

**Exit evidence:**

- Simultaneous pre-check races resolve deterministically.
- Duplicate and out-of-order claim events converge under replay.
- Expired or crashed claims do not grant silent ownership.
- Unenforceable resources continue through the report-only path.

### M2: Opt-In Delay and Reject Directives (Planned)

**Goal:** Define and test narrowly scoped `delay` and `reject` behavior behind explicit
policy without enabling enforcement before the final safety gate.

**Scope:**

- Define per-operation fail-open or fail-closed policy.
- Permit `delay` only while an approved, high-confidence decision is resolved.
- Permit `reject` only for an explicit deterministic violation and configured resource.
- Keep all directives disabled unless the user or orchestrator opts in.
- M2 is implementation-only: configuration and tests cannot activate `delay` or
  `reject` before M6 completes.
- Return the evidence, expected next action, and override path with every directive.

**Exit evidence:**

- Directive selection is deterministic and replayable.
- Low- and medium-confidence findings cannot reject work.
- Policy configuration is explicit, validated, and auditable.
- Gateway tests cover allow, allow-with-notice, delay, reject, timeout, and fail-open
  or fail-closed behavior.

### M3: Decision Delivery Lifecycle (Planned)

**Goal:** Make intervention reliable, acknowledged, and reviewable.

**Scope:**

- Record decision acknowledgment, retry, expiry, override, and audit events.
- Preserve decision-to-finding-to-event evidence links.
- Handle disconnected runtimes, duplicate deliveries, stale decisions, and rejected
  acknowledgments.
- Keep user and orchestrator overrides explicit and durable.
- Delivery remains disabled for enforcement until the M6 activation gate passes.

**Exit evidence:**

- Delivery state converges under duplicate, delayed, and out-of-order inputs.
- Every intervention can be explained from immutable events.
- Overrides are visible in history and cannot be mistaken for successful enforcement.

### M4: Crash and Partial-Execution Reconciliation (Planned)

**Goal:** Recover safely when the gateway or tool fails around an enforced operation.

**Scope:**

- Reconcile gateway restarts, agent crashes, process interruption, and partial tool
  execution.
- Distinguish an operation that did not start from one whose effect is unknown.
- Verify actual effects through filesystem, Git, process, and content evidence.
- Prevent duplicate tool execution when the original outcome is uncertain.

**Exit evidence:**

- Crash and restart scenarios produce deterministic final states.
- Partial execution is recorded as uncertain or completed only with evidence.
- Recovery never silently duplicates an external side effect.
- Bypassed operations reduce coverage and cannot be reported as fully enforced.

### M5: Approval and Safety Controls (Planned)

**Goal:** Keep ambiguous intervention under human or orchestrator control.

**Scope:**

- Define approval requirements for ambiguous or high-cost interventions.
- Provide safe fail-open or fail-closed behavior per operation class.
- Add configuration validation, audit logging, emergency override, and policy rollback.
- Measure interruption cost, false-interruption rate, and enforcement latency.
- Bind the validated configuration to the approved authority decision record and reject
  activation when the record is missing, expired, or out of scope.

**Exit evidence:**

- Ambiguous intervention requests require the configured approver.
- Emergency override is tested, audited, and bounded.
- Policy changes cannot retroactively alter stored decisions.
- Security and redaction fixtures pass for enforcement diagnostics.

### M6: Enforcement Safety and Phase Exit Gate (Planned)

**Goal:** Prove that the selected enforcement scope is safer and more useful than
report-only behavior.

**Scope:**

- Run a labeled race, crash, recovery, bypass, override, and false-interruption
  corpus.
- Measure accepted false-interruption rate, p50/p95 latency, duplicate execution,
  recovery success, and override behavior.
- Record the exact operation classes, policies, and environments supported.

**Exit evidence:**

- Every Phase 4 roadmap exit gate has passing tests or recorded measurements.
- Gateway restarts and partial execution reconcile without duplicate execution.
- Every intervention is overridable and auditable.
- Activation requires the approved authority decision record plus completed M4 and M5
  evidence. Until then, the gateway may emit only `allow` or `allow_with_notice`.
- The accepted false-interruption rate and latency budget are documented and met.
- Semantic evidence alone never delays or rejects an operation.

## Dependency Graph

```text
M0 Phase 3 exit gate
  -> M1 Enforceable resource arbitration
  -> M2 Opt-in delay and reject
  -> M3 Decision delivery lifecycle

M3
  -> M4 Crash and partial-execution reconciliation
  -> M5 Approval and safety controls

M4 + M5
  -> M6 Enforcement safety and exit evidence
```

M2 depends on M1 and remains disabled. M3 depends on M2 and remains disabled. M4 and
M5 depend on M3 and may proceed in parallel. M6 depends on all preceding milestones,
the selected enforcement policy, and the approved authority decision record; M6 is the
only milestone that can activate enforcement.

## Explicitly Deferred

The following work is not part of Phase 4:

- broad or mandatory enforcement across all operations;
- semantic-only intervention;
- automatic agent cancellation or restart;
- a second runtime adapter, dashboard, graph database, distributed queue, or
  microservice split unless separately justified by the roadmap.
