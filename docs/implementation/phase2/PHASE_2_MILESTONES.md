# PatchMesh Phase 2 Milestones: Deterministic Detection

> **Status:** In progress. Phase 2 depends on the completed Phase 1 observe-and-replay
> gates. These milestones decompose deterministic findings and report-only policy into
> independently testable vertical slices.
>
> **Phase 2 is not complete.** M1 and M6 are code-complete with their exit evidence met.
> M2's language coverage is code-complete; its analyzer-history item remains. M3, M4, and
> M5 are implemented but each awaits a reviewed labeled corpus. M0 and M7 are not blocked
> on code at all:
>
> - **M0** needs a benchmark artifact generated from a clean revision on a controlled
>   stable environment, bound to an independent revision and environment file. No
>   qualifying artifact exists. See §7.1 of the atomic-persistence design: set validation
>   now also runs on the synchronous interception path, so the budget must be re-measured
>   before this change can be called M0-neutral.
> - **M7** needs an external `patchmesh-site` runtime to own real tool executions through
>   the gateway, plus independently reviewed holdout labels (minimum 30 positive and 150
>   negative real cases per detector). Neither can be produced from inside this repository.
>   The checked-in corpus is `synthetic_engineering` and `advisoryOnly` by construction and
>   cannot substitute.
>
> A milestone marked *code-complete* means every named implementation item has landed with
> passing regressions. It does not mean the milestone's evidence gate has been cleared where
> that gate requires external runs or human review.

> **Sequencing under review.** The M0 and M7 blockers above are the subject of a proposed
> redesign in [`../DELIVERY_PLAN.md`](../DELIVERY_PLAN.md), which removes their blocking
> position and re-attaches the quality gates to the slices that claim authority. The
> milestone definitions in this document remain the authoritative description of *what*
> each capability must do.

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
| M1 contracts | Immutable V2 feedback; replayed finding/decision/delivery/feedback views; deterministic feedback/delivery writes; replay-time V2 reference checks; opt-in append-time out-of-order buffering with cascading promotion; full V2 dependent-write branch coverage and a V1-reader forward-compatibility regression | Code-complete — every named implementation item has landed with passing regressions. Exit evidence is met (see §M1). No unmet gap remains for this milestone. |
| M2 evidence | Hash-bound TypeScript/JavaScript/Python source facts, centralized extension-to-language mapping, durable V2/V3 analyzer provenance, symbol events, resolver-confirmed dependency events, immutable target binding, degraded unsupported/opaque handling | Partial — language coverage is code-complete (see §M2); broader analyzer history remains |
| M3 overlap | Deterministic same-symbol detector requiring sufficient derived metadata, matching target, and explicit adapter/gateway lifecycle proof across worktrees | Partial — PR5 captures authoritative task-lifetime proofs; a reviewed labeled corpus and external-host evidence remain |
| M4 stale read | Canonical observed-read token, completion-linked `write.dependent` proof, immutable target, durable-reference guard, replay reconstruction, and report-only path | Partial — PR5 captures supported host proofs; corrected-attribution corpus cases and labeled acceptance remain |
| M5 contracts | Cross-worktree resolver, strict sufficient/exported target metadata, explicit source-version predecessor history, deterministic supported-function compatibility classification, durable history | Partial — PR5 validates supported breaking transitions; broader signatures and reviewed corpus remain |
| M6 report-only | Policy, explanation, append-only feedback CLI, daemon delivery/feedback writers, `contracts` command, `help`/`--help` usage, and write-command outcome reporting | Code-complete — every named implementation item has landed with passing regressions. Exit evidence is met (see §M6). |
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

### M1: Finding, Decision, and Feedback Contracts (Code-complete)

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

**Status of exit evidence:** all met.

Append-time out-of-order buffering is implemented as the opt-in
`bufferUnresolvedCausalParents` option on `SqliteEventStore.appendAtomic`, backed by the
`pending_events` table (migration `002_pending_events`). A candidate whose causal parent
is not durable is buffered rather than committed; buffered events are promoted when
their parent lands, and promotion cascades to their own buffered children. Buffered
events are excluded from `read` and `replay`, so the durable log is causally closed at
all times and an orphan is quarantined instead of making replay unresolvable. Buffering
is opt-in precisely so direct `append` keeps its existing tolerance for an out-of-order
child. Seven regressions in `packages/storage/test/storage.test.ts` cover buffering,
promotion, in-batch reverse-ordered chains, cascade, idempotent re-append, conflicting
content, and the unchanged direct-append path.

The compatibility audit is closed by two regressions in
`packages/protocol/test/protocol.test.ts`: every V2 dependent-write binding branch is
now rejected by its specific diagnostic (wrong referenced type, cross-domain read,
cross-task read, dependency-resource mismatch, changed-resource mismatch, changed-event
correlation/task crossing, and non-changed causation), and a V1 reader is shown to
replay a V1 stream unchanged when V2 events share the log.

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

**Status of exit evidence: supported-language coverage is code-complete; analyzer
history is not.**

Language classification moved out of `McpProxy` into `languageForExtension` in
`patchmesh-analyzers`, so every caller classifies a file identically and the supported
set is testable in one place. That closed a real gap: `.mts` and `.cts` were previously
classified `unsupported` and silently produced degraded coverage for ordinary
TypeScript. Python (`.py`, `.pyi`) is now analyzed by `analyzePythonSource`, at the same
fidelity and with the same fail-closed posture as the existing analyzer — module-level
`def`/`class`/assignment symbols only, `__all__` authoritative over the underscore
convention, literals and comments stripped before structure is read, and
`ambiguous_parse` degradation for unbalanced brackets or mixed tab/space indentation.
Five regressions in `packages/analyzers/test/python.test.ts` cover these.

**Remaining gap — broader analyzer history.** Each analysis still sees exactly one
source revision. There is no retained history of prior analyzer versions or
configurations against which an older derived fact can be re-audited, so a fact derived
under one analyzer version cannot be distinguished from one derived under another
except by the provenance stamped on it. Closing this needs its own design (what is
retained, for how long, and how a re-analysis supersedes without rewriting immutable
events) and is not implied by the language work above.

**Adjacent determinism hazard (pre-existing, not introduced here).** Both analyzers sort
symbols and imports with `String.prototype.localeCompare`, which is locale-sensitive.
Analyzer output feeds content digests on derived events, so in principle two runs under
different locales could produce different digests for identical source. The Python
regressions deliberately assert on content rather than order to avoid depending on it.
Switching to code-unit ordering (as `packages/storage/src/replay.ts` already does) would
change existing derived digests, so it needs its own decision rather than a silent fix.

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

### M6: Report-Only Policy, Delivery, Feedback, and CLI Explanation (Code-complete)

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

**Status of exit evidence:** all met.

The delivery-command UX gap is closed. Both write commands now report what was
recorded — the subject, the requested state or disposition, the outcome, and the
resulting event ID — instead of printing a bare append status. An idempotent replay is
named as `already recorded (identical response, no new event)` rather than shown as the
raw word `duplicate`, which read as a failure. `--json` output is deliberately
unchanged, so machine consumers are unaffected.

A functional gap was found and closed while completing this milestone: PatchMesh has
three detectors, but the CLI exposed only two finding types. `exported_contract_invalidation`
findings — M5's entire output — were unreachable from any command. The `contracts`
command surfaces them, and a regression asserts that every member of `FindingType` has a
command, so a future detector cannot be added without a way to read its findings.

`patchmesh help`, `--help`, and `-h` now print the full command surface, and an
unsupported command lists the available commands rather than dead-ending on the name it
rejected. The usage text states the report-only boundary explicitly.

CLI scenario coverage grew from 10 to 16 regressions in `apps/cli/test/cli.test.ts`,
adding: usage discoverability, help as a successful command, detector-command
completeness, write-command outcome reporting, idempotent-replay presentation,
unchanged `--json` output, and coverage warnings surfaced alongside an empty result.

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
`patchmesh-adapters`. When a host contract declares synchronous gateway capability,
it provides a transparent MCP dispatch path that calls `McpProxy.execute` exactly
once, uses authoritative runtime/session identity, rejects payload identity conflicts,
and forwards only same-store persisted completion-linked events to the recorder with a
versioned capability digest. This is not evidence of a real production host run: the
external `patchmesh-site` runtime must still wire the gateway around actual execution
before the production-host checkpoint becomes unblocked. PR5 relationship-proof capture
is implemented for host-authoritative task lifetimes, immutable targets, observed reads,
and completion-linked writes. Field export/dispatcher and holdout collection remain PR6–PR7
work and are not implied by this adapter.

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
