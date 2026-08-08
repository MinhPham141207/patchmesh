# M7 Phase 1: Golden Slice, Resilience, and Performance Design

**Status:** Approved design

## Goal

Complete the Phase 1 M7 gate by verifying the existing observation and replay path
end to end. M7 will produce reproducible golden-slice, resilience, security,
degraded-observability, and performance evidence without adding Phase 2 detection,
coordination policy, or enforcement behavior.

## Scope

M7 covers the complete Phase 1 gate:

- an observation-only cross-worktree exported-contract scenario;
- canonical, duplicate, and valid out-of-order replay equivalence;
- clean projection rebuild equivalence;
- nullable attribution and immutable attribution correction;
- SQLite restart recovery and deterministic failure behavior;
- redaction and bypassed-operation coverage evidence;
- p50 and p95 interception baselines;
- replay baselines at 1,000, 10,000, and 100,000 events;
- a proposed Phase 2 interception-overhead budget;
- committed exit evidence and current-status documentation.

The scenario must not emit or require `finding.created`, `decision.created`,
`validity.changed`, `delay`, `reject`, overlap, stale, or revalidation output.

## Approach

Add a repository-level `tools/phase1` harness instead of a new runtime package.
The harness will use the public APIs from the existing protocol, storage,
observation, adapters, query, daemon, and CLI packages. It will create temporary
repositories, worktrees, and SQLite databases, and it will leave no persistent
runtime state outside the evidence artifacts.

The harness will provide separate golden-suite and benchmark entry points. This
keeps normal workspace tests fast while making the complete M7 gate executable by
explicit commands.

## Golden Scenario and Data Flow

1. Create a temporary repository with an exported contract and a consumer.
2. Create separate worktrees representing the producer and consumer agents.
3. Generate the observation-only event stream for the consumer read and producer
   contract change using the closed Phase 1 event set.
4. Persist the canonical stream through `SqliteEventStore`.
5. Replay it through `replayEvents` and `projectWorkGraph`.
6. Query the resulting status, agents, events, and graph through the daemon/read
   services where applicable.
7. Compare canonical, duplicate, and valid out-of-order variants by ordered-event
   and graph snapshot digests.
8. Reopen the database and repeat replay/projection checks to verify restart
   recovery.

The existing `McpProxy` and `NodeObservation` path will also be exercised against
temporary Git worktrees. The harness will verify request-before-execution,
completion-after-execution, actual file effects, and coverage derived from
observation gaps.

## Resilience and Safety Assertions

The suite will assert that:

- identical duplicate events are idempotent;
- conflicting duplicate IDs fail deterministically;
- valid out-of-order inputs converge to the canonical state;
- missing causal references fail without a partial-success snapshot;
- source-sequence gaps remain explicit degraded coverage;
- closing and reopening SQLite preserves immutable event bytes;
- nullable agent/task attribution is accepted;
- `attribution.corrected` changes projected attribution without mutating its target;
- failed and interrupted tool calls remain non-successful outcomes;
- opaque or bypassed effects reduce coverage rather than claiming full observation;
- redacted event data and diagnostics contain no credentials or secret values;
- the complete M7 output contains no Phase 2 findings, decisions, or disruptive
  directives.

## Performance Baselines

The benchmark runner will implement the workloads in
`benchmarks/phase0/workloads.json` without introducing new acceptance thresholds.

### Interception

Run paired direct and observed operations in one process and environment for:

- noop routing;
- deterministic small-file reads;
- opaque shell invocation.

Each workload will use its defined warm-up and measured sample counts. Every pair
will retain baseline duration, observed duration, overhead, and failure state.
Results will include raw observations, p50, p95, and environment metadata.

### Replay

Generate deterministic corpora of 1,000, 10,000, and 100,000 events. Measure
canonical, duplicate, and valid out-of-order variants using the defined warm-up and
sample counts. Before timing comparison, every successful variant must produce the
same snapshot digest. Results will include elapsed time, events per second, peak
memory, p50, p95, raw observations, failures, and snapshot digests.

The evidence will propose a Phase 2 interception-overhead budget and name the
measurement environment and owner responsible for accepting it. The budget is a
recorded recommendation, not a newly invented Phase 1 pass/fail gate.

## Evidence and Documentation

Add `docs/implementation/phase1/evidence/PHASE_1_M7_EVIDENCE.md` containing:

- verification date and base revision;
- exact commands;
- fixture and workload identifiers;
- expected and observed results;
- raw performance measurements and derived statistics;
- OS, architecture, CPU, memory, and Node metadata;
- proposed Phase 2 budget and owner;
- residual coverage limitations;
- explicit confirmation that Phase 2 behavior remains deferred.

After all checks pass, update the Phase 1 milestone and roadmap status from M7
planned to M7 complete, linking the evidence. Keep the overall architecture and
Phase 2 documentation accurate: Phase 1 remains observation-only and report-only.

## Verification

The implementation must run:

- the dedicated M7 golden and resilience suite;
- the M7 benchmark commands;
- all workspace tests;
- recursive typecheck and build;
- the Phase 0 validator and Phase 0 test suite;
- `git diff --check`.

M7 is complete only when the golden suite, all required evidence assertions, and
the reproducibility checks pass. Performance results are recorded even when they
do not satisfy an unapproved threshold.
