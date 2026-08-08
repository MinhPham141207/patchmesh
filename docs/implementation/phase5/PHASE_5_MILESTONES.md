# PatchMesh Phase 5 Milestones: Expansion

> **Status:** Planned and conditional. Phase 5 candidates begin only after the first
> vertical slice demonstrates useful avoided rework and a candidate has measured
> justification. These milestones are compatibility and capability slices, not a
> commitment to implement every candidate.

## Purpose

Phase 5 broadens PatchMesh only after the earlier phases establish replayability,
deterministic detection, targeted proof, and safe authority boundaries. Each candidate
must preserve the modular-monolith architecture, agent-agnostic core, evidence chain,
and explicit coverage model.

No candidate is pulled forward solely because it is technically convenient. A
candidate requires an approved design, a measured user or compatibility need, and
phase-appropriate security and exit evidence.

## Candidate Order

Candidates are listed in the roadmap's current measured-need priority, not as a
dependency chain. M1-M5 are independent candidate tracks after M0 and may be
re-sequenced only through an explicit roadmap update that records the reason and
prerequisites.

### M0: Phase 4 Safety Exit Gate (Planned)

**Scope:**

- Confirm measured enforcement is opt-in, bounded, auditable, recoverable, and
  overridable.
- Confirm the first vertical slice demonstrates useful avoided rework.
- Record the user, compatibility, security, and performance evidence that justifies
  any Phase 5 candidate.

**Exit evidence:**

- Phase 4 safety and authority metrics are documented.
- Candidate selection criteria and unresolved risks are explicit.
- No expansion candidate is treated as committed before its design is approved.

### M1: Second Runtime Adapter and Capability Parity (Conditional)

**Goal:** Add one additional runtime integration without moving runtime logic into the
core.

**Scope:**

- Select the second runtime from measured user need and adapter feasibility.
- Translate runtime activity into the existing event and attribution contracts.
- Report capability parity and observation gaps against the MCP boundary.
- Test unsupported events, identity mapping, failure outcomes, redaction, and bypasses.

**Exit evidence:**

- The adapter passes shared protocol, replay, observation, and security fixtures.
- Capability differences are visible rather than silently treated as parity.
- Core detectors, policy, and storage remain runtime-agnostic.
- Cross-adapter golden scenarios produce equivalent findings where capabilities match.

### M2: Schema, Migration, Import, and Test-Impact Analyzers (Conditional)

**Goal:** Extend deterministic dependency evidence to high-value resource classes.

**Scope:**

- Add analyzers for schemas, database migrations, imports, and test relationships.
- Emit facts and dependency paths with provenance, confidence, and coverage.
- Connect analyzer outputs to existing detectors and targeted check selection.
- Keep unsupported languages and opaque artifacts explicitly degraded.

**Exit evidence:**

- Labeled corpora demonstrate useful precision and recall per analyzer.
- Dependency paths are replayable and do not create duplicate findings.
- Existing Phase 2 and Phase 3 behavior remains equivalent for prior resource classes.
- Analyzer failures do not create false claims of complete coverage.

### M3: Semantic Advisory Findings (Conditional)

**Goal:** Explore duplicate-investigation and architectural-conflict findings without
granting semantic analysis authority.

**Scope:**

- Define bounded semantic inputs, output schemas, confidence, evidence, and redaction.
- Store the immutable semantic input, analyzer/model/version identity, configuration,
  normalized output or content-addressed output digest, and provenance needed to replay
  the declared scope.
- Emit advisory findings for duplicate investigations or architectural conflicts.
- Require deterministic corroboration or human review before any policy action.
- Measure usefulness, calibration, dismissal, and false-positive behavior.

**Exit evidence:**

- Semantic outputs are replayable for their declared scope: replay uses the stored
  input and analyzer/model metadata, and any output mismatch is recorded rather than
  silently treated as equivalent.
- Low-confidence findings record only; they do not pause, reject, or mark work stale.
- Users can dismiss findings and record usefulness.
- No semantic output alone changes gateway authority.

### M4: Multi-Repository and Remote Execution Models (Conditional)

**Goal:** Extend identity, dependency, event, and coverage models beyond one local
repository and execution host.

**Scope:**

- Define repository, workspace, worktree, remote execution, integration-target, and
  transport identity boundaries.
- Preserve event ordering, causal links, redaction, and replay across boundaries.
- Define disconnected, delayed, duplicate, and partially observed remote behavior.
- Keep local-first operation and explicit degraded coverage where connectivity fails.

**Exit evidence:**

- Cross-repository and remote golden scenarios replay deterministically.
- Identity collisions and cross-boundary attribution are rejected or corrected safely.
- Security review covers transport, credentials, redaction, and least privilege.
- Remote failure cannot be reported as complete observation or enforcement.

### M5: Dashboard and Organization-Level Policy (Conditional)

**Goal:** Add higher-level visibility and policy controls only after CLI and core
behavior are stable.

**Scope:**

- Define dashboard views over public services rather than internal tables.
- Expose coverage, findings, validity, decisions, overrides, and measured metrics.
- Add organization-level policy configuration with scoped ownership and audit history.
- Preserve per-repository and per-operation authority boundaries.

**Exit evidence:**

- Dashboard data matches deterministic CLI/API queries under replay.
- Policy changes are validated, versioned, auditable, and reversible.
- Access control and redaction fixtures pass.
- UI or organization controls do not introduce unmeasured enforcement.

### M6: Candidate Review and Expansion Gate (Planned)

**Goal:** Decide whether each candidate earned inclusion based on measured evidence.

**Scope:**

- Compare candidate benefits, compatibility coverage, operational cost, security
  risk, and maintenance burden.
- Record acceptance, deferral, or rejection for each candidate.
- Update the roadmap explicitly when sequencing or scope changes.
- Require a separate design and implementation plan for accepted candidates.

**Exit evidence:**

- Each accepted candidate has measured justification and a documented design.
- Candidate-specific tests cover replay, duplication, out-of-order input, failure,
  redaction, degraded coverage, and user override where applicable.
- Deferred candidates remain clearly labeled and do not leak into current capability.
- Expansion does not weaken earlier phase exit gates.

## Dependency Graph

```text
M0 Phase 4 safety exit gate

M0
  -> M1 Second runtime adapter
  -> M2 Extended deterministic analyzers
  -> M3 Semantic advisory findings
  -> M4 Multi-repository and remote execution
  -> M5 Dashboard and organization policy

M1/M2/M3/M4/M5 (approved candidate tracks)
  -> M6 Candidate review and exit evidence
```

M1-M5 each depend only on M0 and their own candidate design, evidence, and security
constraints; they are not mandatory or sequential. M6 evaluates the evidence from
whichever candidates were approved.

## Explicitly Deferred

The following remain outside Phase 5 unless separately approved and justified:

- replacing the modular monolith with microservices;
- distributed queues or a graph database;
- semantic findings as automatic enforcement authority;
- broad autonomous orchestration or project-management features;
- unbounded multi-tenant cloud control-plane behavior.
