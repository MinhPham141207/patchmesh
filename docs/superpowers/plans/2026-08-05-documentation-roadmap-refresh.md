# PatchMesh Documentation and Roadmap Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn PatchMesh's concept documents into a coherent, honest, and implementable documentation set with a gated roadmap for a deterministic report-only MVP.

**Architecture:** Keep the existing vision/architecture/lifecycle/terminology split, add a useful README and delivery roadmap, and reconcile only the cross-document contracts needed for the first vertical slice. Treat `docs/TERMINOLOGY.md` as the vocabulary authority, `docs/ROADMAP.md` as the sequencing authority, and label all unimplemented behavior as planned target behavior.

**Tech Stack:** Markdown, Git, PowerShell verification commands

---

## File Responsibility Map

- `README.md`: five-minute project entry point and current-state disclosure.
- `docs/ROADMAP.md`: phase order, deliverables, exit gates, metrics, and deferred scope.
- `docs/VISION.md`: stable problem, user, promise, boundaries, and success outcomes.
- `docs/TERMINOLOGY.md`: canonical version, coverage, confidence, action, and validity vocabulary.
- `docs/ARCHITECTURE.md`: planned component contracts and MVP technical boundaries.
- `docs/LIFECYCLE.md`: planned state transitions and pre/post-tool event flow.
- `docs/AGENTS.md`: repository implementation rules aligned to the roadmap and terminology.
- `AGENTS.md`, `KNOWL.md`, `.gitignore`: user-owned files outside this change; do not modify or stage them.

## Canonical Contracts Used by Every Task

Use these definitions consistently:

- `taskId` is a required event-envelope field whose value is `string | null` until attribution is known.
- A resource version is scoped to a repository plus workspace/worktree version domain.
- Cross-worktree changes are candidate versions until applied to an explicit integration target.
- Dependency provenance is `declared`, `statically_observed`, `dynamically_observed`, or `semantically_inferred`.
- Observability coverage is `intercepted`, `verified`, `inferred`, or `unknown`.
- Confidence is a numeric score in `[0, 1]`; `low`, `medium`, and `high` are recorded policy-derived bands.
- Coordination actions and gateway directives are separate vocabularies.
- MVP coordination actions may produce only `allow` or `allow_with_notice` gateway directives.
- `delay` and `reject` are unavailable until the measured-enforcement roadmap phase.

### Task 1: Create the project entry point and delivery roadmap

**Files:**
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/VISION.md`
- Reference: `docs/superpowers/specs/2026-08-05-documentation-roadmap-refresh-design.md`

- [ ] **Step 1: Replace the placeholder README with a truthful project entry point**

Replace the complete contents of `README.md` with:

````markdown
# PatchMesh

PatchMesh is a planned runtime consistency layer for parallel coding agents. It
detects when one agent's change may invalidate another agent's running or completed
work, explains the dependency path, and requests the smallest reliable response
before integration.

> **Project status:** Documentation-first concept stage. There is no released
> implementation yet. The initial implementation sequence is defined in the
> [roadmap](docs/ROADMAP.md).

## The problem

Git can detect textual merge conflicts, worktrees can isolate changes, orchestrators
can assign tasks, and tests can validate integrated results. They do not reliably
detect when agents edit different files but one change invalidates another agent's
assumptions.

Example:

```text
Agent B reads authenticate() signature v12 and modifies a caller.
Agent A proposes authenticate() signature v13 in another worktree.
PatchMesh links the candidate change to Agent B's observed dependency.
Agent B is notified and asked to run the cheapest relevant validation.
```

PatchMesh focuses on this question:

> When has concurrent work stopped being independent?

## First working slice

The first version targets two coding agents in separate Git worktrees and remains
report-only. It will provide:

- one MCP/runtime adapter;
- pre-tool intent and post-tool effect events;
- append-only SQLite storage and deterministic replay;
- repository-, worktree-, task-, file-, symbol-, and version-aware graph state;
- same-symbol overlap detection;
- stale-read-before-write detection;
- exported-contract invalidation;
- evidence-backed `notify` and `request_revalidation` decisions;
- CLI commands for status, stale work, events, and explanations.

Automatic pause, rejection, semantic duplicate-work detection, multiple adapters,
and a dashboard are deliberately deferred.

## Planned architecture

```text
Coding agents
    -> adapter / gateway / observers
    -> normalized immutable events
    -> SQLite event store
    -> live work graph projection
    -> deterministic detectors
    -> policy decisions
    -> targeted coordination and revalidation
```

PatchMesh is not a coding agent, task planner, general orchestrator, Git replacement,
test replacement, or project-management platform.

## Principles

- Observe intended operations and verify actual effects.
- Prefer deterministic evidence before semantic reasoning.
- Distinguish events, findings, decisions, and enforcement.
- Never claim stronger consistency than observation coverage supports.
- Choose the least disruptive safe response.
- Explain every decision with reproducible evidence.
- Treat completed work as potentially invalidatable until revalidated.

## Documentation

- [Vision](docs/VISION.md) — problem, promise, boundaries, and long-term direction
- [Roadmap](docs/ROADMAP.md) — implementation phases and evidence gates
- [Architecture](docs/ARCHITECTURE.md) — planned components and technical contracts
- [Lifecycle](docs/LIFECYCLE.md) — agent, task, event, decision, and revalidation flows
- [Terminology](docs/TERMINOLOGY.md) — canonical vocabulary
- [Agent rules](docs/AGENTS.md) — implementation constraints for repository changes

## Contributing

Read `docs/VISION.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and
`docs/AGENTS.md` before proposing implementation work. Do not describe planned
behavior as implemented behavior.
````

- [ ] **Step 2: Populate the roadmap with evidence-gated phases**

Replace the complete contents of `docs/ROADMAP.md` with the following structure and
content:

```markdown
# PatchMesh Roadmap

> **Status:** Planned. PatchMesh is currently documentation-first and has no released
> implementation.

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
an exported function, another proposes a signature change, and PatchMesh explains
the prospective impact and requests targeted revalidation before integration.

## Phase 0 — Foundation

**Status:** Current

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

## Phase 1 — Observe and Replay

**Goal:** Capture one runtime's activity and reproduce derived state without making coordination decisions that interrupt work.

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

## Phase 2 — Deterministic Detection

**Goal:** Detect the first coordination risks in report-only mode.

**Deliverables:**

- same-symbol overlap detector;
- stale-read-before-write detector;
- exported-function or API-contract invalidation detector;
- dependency paths with evidence and provenance;
- `record`, `notify`, `request_recheck`, `mark_possibly_stale`, and
  `request_revalidation` policy actions;
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

- task validity records containing base revision, work product, observed dependencies,
  validation results, coverage, and integration target;
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
```

- [ ] **Step 3: Align the vision with the selected user and MVP**

In `docs/VISION.md`, insert this block after the title:

```markdown
> **Status:** Product vision and planned behavior. PatchMesh is currently at the
> documentation-first concept stage; see [ROADMAP.md](ROADMAP.md) for delivery status.
```

Insert this section after `## Overview` and its opening paragraphs:

```markdown
## Initial User and Promise

The initial user is a developer or small platform team running two or more coding
agents in separate Git worktrees for one repository.

PatchMesh's first promise is:

> Detect when one agent's candidate change threatens the validity of another task,
> explain the dependency path, and request the cheapest reliable revalidation before
> integration.
```

Replace `## Initial Product Scope` through the line before `## Success Criteria` with:

```markdown
## Initial Product Scope

The first version focuses on one deterministic, report-only vertical slice for two
or more coding agents working in separate Git worktrees.

It tracks:

- agent, task, repository, worktree, and integration-target identity;
- pre-tool intent and post-tool effects;
- file and symbol reads and changes with scoped versions;
- Git diffs and exported function or API-contract changes;
- tests and validation commands associated with affected resources;
- dependency provenance and observability coverage;
- completed work products and their task validity records.

It detects:

- same-symbol overlap;
- stale reads followed by dependent writes;
- exported-contract changes affecting known consumers;
- completed work whose observed dependencies have candidate changes.

It initially supports:

- record;
- notify;
- request recheck;
- mark possibly stale;
- request revalidation;
- escalate to a human or orchestrator.

All MVP gateway directives are `allow` or `allow_with_notice`. Automatic pause,
rejection, redirect, semantic duplicate detection, inferred architectural conflict,
multiple runtime adapters, and dashboard work are deferred until roadmap evidence
gates justify them.
```

- [ ] **Step 4: Verify and commit the product-facing documents**

Run:

```powershell
rg -n "documentation-first|Initial User and Promise|report-only|Phase 0|Phase 5|Explicitly deferred" README.md docs/VISION.md docs/ROADMAP.md
```

Expected: matches in all three files that disclose current status, identify the first
user, and delimit the MVP.

Stage only these files, verify the staged patch, and commit:

```powershell
git add -- README.md docs/VISION.md docs/ROADMAP.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: define PatchMesh MVP roadmap"
```

Expected: the check exits 0, the staged name list contains only these three files,
and the commit succeeds.

### Task 2: Make terminology canonical

**Files:**
- Modify: `docs/TERMINOLOGY.md`
- Reference: `docs/ROADMAP.md`

- [ ] **Step 1: Correct the document title and disclose status**

Replace the malformed first line with:

```markdown
# PatchMesh Terminology

> **Status:** Canonical vocabulary for planned PatchMesh behavior. Terms describing
> unimplemented capabilities do not imply that those capabilities exist today.
```

- [ ] **Step 2: Add identity and version-domain terms**

Add these definitions to the appropriate core/work/version sections:

````markdown
### Repository

The Git repository whose work is being observed.

Repository identity must be stable across its worktrees.

### Workspace

The filesystem and execution context observed for an agent. A workspace may be a Git
worktree, checkout, container mount, or another isolated view of a repository.

### Worktree

A Git-backed workspace with its own checked-out revision and uncommitted changes.

### Integration Target

The branch, revision, or candidate aggregate against which prospective compatibility
and task validity are evaluated.

### Version Domain

The repository plus workspace/worktree context in which a resource version exists.
A version is not globally current without naming its domain.

### Observed Version

The resource version an agent actually read or used in its version domain.

### Candidate Version

A proposed resource version produced in another worktree or patch that has not yet
been applied to the integration target.

### Target Version

The resource version currently present in the integration target.

### Integrated Version

A candidate version after it has been applied to the integration target.
````

Replace `Current Version` with:

```markdown
### Current Version

The latest known resource version inside an explicitly named version domain.

Do not compare worktrees using an unscoped global current version. Cross-worktree
impact compares an observed version and a candidate version against an integration
target.
```

- [ ] **Step 3: Add dependency provenance, coverage, and validity records**

Add:

````markdown
### Dependency Provenance

How PatchMesh learned that one entity depends on another.

Canonical values:

```text
declared
statically_observed
dynamically_observed
semantically_inferred
```

Provenance is recorded on every dependency edge and contributes to confidence.

### Observability Coverage

The strength of evidence that PatchMesh has about an operation or effect.

Canonical values:

```text
intercepted
verified
inferred
unknown
```

`intercepted` means PatchMesh observed the request before execution. `verified` means
it confirmed an effect through filesystem, Git, process, test, or equivalent evidence.
`inferred` means the relationship is derived without direct observation. `unknown`
marks an explicit gap. Coverage may contain more than one value for one operation.

### Task Validity Record

A durable explanation of why a completed work product is believed to be valid,
possibly stale, or stale against an integration target.

It records task and work-product identity, base revision, observed dependencies and
versions, dependency provenance, validation commands and results, observability
coverage, validation time, integration target, and the evidence behind state changes.
````

- [ ] **Step 4: Reconcile confidence, actions, and gateway directives**

Replace the confidence definition with:

````markdown
### Confidence

How strongly the recorded evidence supports a finding.

Use a normalized numeric score from `0` to `1` when a calibrated score is available.
Policies derive and record one band from that score:

```text
low
medium
high
```

Band thresholds are policy configuration and must be stored with the decision. A band
without its policy version is not sufficient evidence for automatic intervention.
````

Replace the canonical coordination-action block with:

````markdown
### Coordination Action

The response selected by policy for an agent, task, finding, or orchestrator.

Canonical actions:

```text
record
notify
request_recheck
assign_owner
redirect
pause
mark_possibly_stale
mark_stale
request_revalidation
create_follow_up_task
escalate
```

### Gateway Directive

The execution instruction enforced by a gateway for one tool request.

Canonical directives:

```text
allow
allow_with_notice
delay
reject
```

Coordination actions and gateway directives are not interchangeable. During the MVP,
policy may emit only `allow` or `allow_with_notice`; `delay` and `reject` require the
measured-enforcement roadmap phase.
````

Update the canonical distinction section with:

````markdown
### Coordination Action vs Gateway Directive

```text
Coordination action = policy response for affected work
Gateway directive = execution instruction for a specific tool call
```
````

- [ ] **Step 5: Verify and commit terminology**

Run:

```powershell
rg -n "^# PatchMesh Terminology|Version Domain|Candidate Version|Integration Target|Dependency Provenance|Observability Coverage|Task Validity Record|Gateway Directive|normalized numeric score" docs/TERMINOLOGY.md
```

Expected: one canonical definition for every listed concept.

Stage, verify, and commit:

```powershell
git add -- docs/TERMINOLOGY.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: define PatchMesh consistency vocabulary"
```

Expected: the diff check exits 0, the staged name list contains only
`docs/TERMINOLOGY.md`, and the commit succeeds.

### Task 3: Reconcile the planned architecture

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Reference: `docs/TERMINOLOGY.md`
- Reference: `docs/ROADMAP.md`

- [ ] **Step 1: Label the architecture as planned and define version domains**

Insert after the title:

```markdown
> **Status:** Planned target architecture. See [ROADMAP.md](ROADMAP.md) for what is
> currently in scope and which phase gates have been met.
```

Add after the live-work-graph description:

```markdown
#### Version domains and integration targets

Every resource version belongs to a repository and workspace/worktree version domain.
An unmerged change in another worktree is a candidate version, not a global current
version. Detectors evaluate prospective impact by comparing an agent's observed
version and the candidate version against an explicit integration target.

Resource identity must include enough information to distinguish repositories,
worktrees, revisions, paths, and symbols without treating equivalent Git objects as
unrelated solely because their filesystem roots differ.
```

- [ ] **Step 2: Replace the minimum event envelope**

Replace the existing required-event-field list with:

```markdown
Every event must include:

- `schemaVersion`
- `eventId`
- `eventType`
- `source`
- `timestamp`
- `repositoryId`
- `workspaceId`
- `agentId`
- `taskId`, as `string | null` until attributed
- `correlationId` for one tool call or operation
- `causationId`, when another event caused this event
- `sourceSequence`, when the source provides ordered delivery
- relevant payload

Event ingestion must be idempotent by `eventId`. Source ordering, timestamp ordering,
and causal ordering are distinct; replay must not infer causality from wall-clock time
alone. Later attribution is represented by a new event rather than mutation.
```

- [ ] **Step 3: Separate actions, directives, and MVP authority**

In the gateway section, replace the mixed enforcement list with:

````markdown
The gateway enforces one directive from the core:

```text
allow
allow_with_notice
delay
reject
````

The gateway does not select coordination policy. The MVP produces only `allow` and
`allow_with_notice`; `delay` and `reject` remain disabled until Phase 4 exit evidence
supports opt-in enforcement.
```

Replace the policy action list with the canonical coordination actions from
`docs/TERMINOLOGY.md`, excluding gateway directives. Add this mapping:

```markdown
Policy returns both a coordination action and a gateway directive. For example,
`notify`, `request_recheck`, `mark_possibly_stale`, and `request_revalidation`
normally map to `allow_with_notice` in report-only mode. A future `pause` may map to
`delay`; `reject` requires an explicit high-confidence enforcement policy.
```

- [ ] **Step 4: Define coverage and opaque-operation behavior**

Add to failure handling:

```markdown
### Observability coverage

Every finding and decision reports whether its supporting operations were intercepted,
verified, inferred, or unknown. Coverage is evidence, not a global boolean. PatchMesh
must not claim complete coordination when relevant effects may have bypassed observation.

Opaque shell commands are observational in the MVP. The gateway may observe the
request, while filesystem, Git, process, and test evidence verify effects afterward.
Pre-write rejection for arbitrary commands requires an explicitly configured sandbox
or lower-level mediator and belongs to the measured-enforcement phase.
```

- [ ] **Step 5: Narrow the MVP technical direction**

Keep the existing stack and add:

```markdown
The first vertical slice implements one scenario end to end: a candidate exported-
contract change in one worktree affects a consumer observed in another worktree.

Initial detectors are limited to same-symbol overlap, stale-read-before-write, and
exported-contract invalidation. Initial coordination remains report-only. Claims,
semantic classifiers, multiple adapters, a dashboard, and hard enforcement are not
MVP dependencies.
```

- [ ] **Step 6: Verify and commit architecture changes**

Run:

```powershell
rg -n "Planned target architecture|Version domains and integration targets|schemaVersion|taskId.*null|sourceSequence|Gateway Directive|Observability coverage|report-only" docs/ARCHITECTURE.md
```

Expected: the planned-status notice and every canonical contract appear.

Stage, verify, and commit:

```powershell
git add -- docs/ARCHITECTURE.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: make PatchMesh architecture implementable"
```

Expected: the check exits 0, only `docs/ARCHITECTURE.md` is staged, and the commit
succeeds.

### Task 4: Align lifecycle semantics

**Files:**
- Modify: `docs/LIFECYCLE.md`
- Reference: `docs/TERMINOLOGY.md`
- Reference: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Label planned behavior and clarify tool-event timing**

Insert after the title:

```markdown
> **Status:** Planned lifecycle semantics. See [ROADMAP.md](ROADMAP.md) for the active
> delivery phase; listed states and transitions are not claims of implementation.
```

Replace the tool-call overview with:

```text
Requested
-> tool.requested stored
-> pre-check
-> gateway directive
-> executed or interrupted
-> effect observed
-> outcome and effect events stored
-> graph updated
```

State explicitly that `tool.requested` is durably recorded before pre-check and that
post-execution events do not replace it.

- [ ] **Step 2: Align attribution and gateway directives**

Change registration and event requirements so that an event always contains
`taskId`, but the value may be `null` when an adapter or watcher cannot attribute the
activity. Later attribution is a new immutable event.

Replace the gateway-decision values with exactly:

```text
allow
allow_with_notice
delay
reject
```

Explain that the policy decision separately carries a coordination action.

- [ ] **Step 3: Add task validity transition invariants**

Add after the task-state definitions:

````markdown
### Task validity transition invariants

```text
completed -> possibly_stale
possibly_stale -> revalidating
revalidating -> valid
revalidating -> stale
valid -> possibly_stale
```

- `completed` means implementation ended; it is not proof against future candidates.
- `possibly_stale` requires an evidence-backed dependency impact.
- `stale` requires failed validation or explicit deterministic proof of invalidity.
- `valid` requires recorded validation against a named integration target.
- A new relevant candidate change may move `valid` work back to `possibly_stale`.
- State corrections are new events and never mutate the event history.
````

- [ ] **Step 4: Link revalidation to task validity records**

Add to the revalidation lifecycle:

```markdown
Revalidation creates or updates the projection of a task validity record. The record
links the work product, base revision, observed dependency versions, integration
target, validation commands and results, coverage, and the decision that requested
the check. Replay must rebuild the same validity state from these events.
```

Clarify that the MVP may request revalidation but cannot automatically `delay` or
`reject` the agent operation that triggered it.

- [ ] **Step 5: Verify and commit lifecycle changes**

Run:

```powershell
rg -n "Planned lifecycle semantics|tool.requested stored|taskId.*null|Task validity transition invariants|failed validation|Task Validity Record|allow_with_notice" docs/LIFECYCLE.md
```

Expected: the pre-tool event, nullable attribution, validity guards, record, and
directive vocabulary all appear.

Stage, verify, and commit:

```powershell
git add -- docs/LIFECYCLE.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: align PatchMesh lifecycle semantics"
```

Expected: the check exits 0, only `docs/LIFECYCLE.md` is staged, and the commit
succeeds.

### Task 5: Align implementation rules with the roadmap

**Files:**
- Modify: `docs/AGENTS.md`
- Reference: `docs/ROADMAP.md`
- Reference: `docs/TERMINOLOGY.md`

- [ ] **Step 1: Correct required-reading paths and planned/current language**

Use repository-relative paths:

```markdown
1. Read `docs/VISION.md`.
2. Read `docs/ARCHITECTURE.md`.
3. Read `docs/ROADMAP.md` when requested work may affect scope or phase order.
4. Read `docs/TERMINOLOGY.md` before changing public protocol vocabulary.
5. Inspect existing code and tests before proposing a new abstraction.
```

Add:

```markdown
The architecture and lifecycle documents describe planned target behavior unless a
section explicitly says it is implemented. Never present roadmap work as current
capability.
```

- [ ] **Step 2: Align event and decision rules**

Replace the event fields with the minimum envelope from `docs/ARCHITECTURE.md`,
including `taskId: string | null`, correlation, causation, source sequence, repository,
workspace, and schema version.

Replace the decision list with the canonical coordination actions. Add a separate
gateway-directive list containing `allow`, `allow_with_notice`, `delay`, and `reject`.
State that Phase 0 through Phase 3 code may not emit `delay` or `reject`.

- [ ] **Step 3: Add roadmap and documentation consistency rules**

Add to scope/documentation rules:

```markdown
- Do not implement a later roadmap phase without updating `docs/ROADMAP.md` and
  recording why its prerequisites are satisfied or intentionally changed.
- When changing a canonical term, update terminology, architecture, lifecycle,
  protocol types, tests, and user-facing documentation together.
- Every document describing unimplemented behavior must label it as planned or target.
- Root `AGENTS.md` and `KNOWL.md` are project-memory policy and must not be rewritten
  as PatchMesh product documentation.
```

Add to testing rules:

```markdown
Before enabling a new coordination authority level, add scenarios for false positives,
bypassed operations, event duplication and reordering, crash recovery, and user
override. Enforcement requires the exit evidence defined in `docs/ROADMAP.md`.
```

- [ ] **Step 4: Verify and commit agent rules**

Run:

```powershell
rg -n "docs/VISION.md|docs/TERMINOLOGY.md|planned target behavior|taskId.*null|Gateway Directive|later roadmap phase|Root `AGENTS.md`" docs/AGENTS.md
```

Expected: correct paths, status language, canonical fields, roadmap constraints, and
memory-policy exclusions appear.

Stage, verify, and commit:

```powershell
git add -- docs/AGENTS.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: align PatchMesh implementation rules"
```

Expected: the check exits 0, only `docs/AGENTS.md` is staged, and the commit succeeds.

### Task 6: Cross-document verification and final reconciliation

**Files:**
- Verify: `README.md`
- Verify: `docs/VISION.md`
- Verify: `docs/ROADMAP.md`
- Verify: `docs/ARCHITECTURE.md`
- Verify: `docs/LIFECYCLE.md`
- Verify: `docs/TERMINOLOGY.md`
- Verify: `docs/AGENTS.md`
- Do not modify: `AGENTS.md`, `KNOWL.md`, `.gitignore`

- [ ] **Step 1: Verify local Markdown links**

Run:

```powershell
$docs = @(
    'README.md',
    'docs/VISION.md',
    'docs/ROADMAP.md',
    'docs/ARCHITECTURE.md',
    'docs/LIFECYCLE.md',
    'docs/TERMINOLOGY.md',
    'docs/AGENTS.md'
)
$broken = @()
foreach ($doc in $docs) {
    $path = if ($doc -is [string]) { $doc } else { $doc.FullName }
    $base = Split-Path -Parent (Resolve-Path -LiteralPath $path)
    $text = Get-Content -Raw -LiteralPath $path
    foreach ($match in [regex]::Matches($text, '\[[^\]]+\]\(([^)]+)\)')) {
        $target = $match.Groups[1].Value.Split('#')[0]
        if (!$target -or $target -match '^(https?|skill):') { continue }
        $resolved = Join-Path $base $target
        if (!(Test-Path -LiteralPath $resolved)) { $broken += "$path -> $target" }
    }
}
if ($broken.Count) { $broken; exit 1 }
'All local Markdown links resolve.'
```

Expected: `All local Markdown links resolve.` and exit code 0.

- [ ] **Step 2: Verify status and scope language**

Run:

```powershell
rg -n "Status:.*(Planned|planned|concept)|documentation-first|report-only|Explicitly deferred" README.md docs/*.md
```

If PowerShell does not expand `docs/*.md` for `rg`, use:

```powershell
rg -n "Status:.*(Planned|planned|concept)|documentation-first|report-only|Explicitly deferred" README.md docs -g '*.md'
```

Expected: status labels in README, vision, architecture, lifecycle, terminology, and
roadmap; report-only and deferred-scope declarations in product and roadmap docs.

- [ ] **Step 3: Verify canonical vocabulary**

Run:

```powershell
rg -n "Version Domain|Integration Target|Candidate Version|Dependency Provenance|Observability Coverage|Task Validity Record|Gateway Directive" docs -g '*.md'
```

Expected: definitions in terminology and consistent uses in architecture, lifecycle,
roadmap, and agent rules.

Run:

```powershell
rg -n "^1#|latest known version of a resource$|Every event must include:$|Supported decisions should remain limited to:" docs -g '*.md'
```

Expected: no malformed title, no unscoped old `Current Version` sentence, and no old
event/action block left without the new canonical clarification.

- [ ] **Step 4: Scan for placeholders and whitespace errors**

Run:

```powershell
$matches = rg -n "T[B]D|T[O]DO|PLACEH[O]LDER|implement l[a]ter|fill in deta[i]ls" README.md docs -g '*.md'
if ($LASTEXITCODE -eq 1) { 'No placeholders found.'; exit 0 }
$matches
exit 1
```

Expected: `No placeholders found.` and exit code 0.

Run:

```powershell
git diff --check
```

Expected: exit code 0 with no whitespace errors.

- [ ] **Step 5: Review repository scope and history**

Run:

```powershell
git status --short
git log --oneline -8
```

Expected: the documentation commits are present. Root `AGENTS.md`, `KNOWL.md`, and
`.gitignore` remain untracked and unmodified unless they were already changed by the
user outside this plan.

Run:

```powershell
git diff f7f72db..HEAD -- README.md docs/VISION.md docs/ROADMAP.md docs/ARCHITECTURE.md docs/LIFECYCLE.md docs/TERMINOLOGY.md docs/AGENTS.md
```

Expected: only the approved documentation refresh, with no changes to project-memory
policy.

- [ ] **Step 6: Commit reconciliation fixes only if verification required edits**

If and only if Steps 1–5 exposed a cross-document defect that required a correction,
stage only the corrected canonical documents and commit:

```powershell
git add -- README.md docs/VISION.md docs/ROADMAP.md docs/ARCHITECTURE.md docs/LIFECYCLE.md docs/TERMINOLOGY.md docs/AGENTS.md
git commit -m "docs: reconcile PatchMesh documentation contracts"
```

If no files changed during verification, do not create an empty commit.
