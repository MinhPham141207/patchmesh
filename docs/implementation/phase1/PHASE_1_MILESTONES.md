# PatchMesh Phase 1 Milestones: Observe and Replay

> **Status:** M0, M1, M2, and M3 complete; M4-M7 planned. These milestones break the Phase 1
> roadmap scope into independently testable vertical slices. M1 provides the strict
> workspace, protocol boundary, and in-memory collector; later runtime capabilities
> are not implemented yet.

## Purpose

Phase 1 captures one runtime's activity and reproduces derived state without making
coordination decisions that interrupt work. The implementation should establish one
usable observation path before broadening the resource graph.

Phase 1 uses one MCP proxy as its only runtime boundary. Other runtime adapters are
deferred; choosing a different adapter is not an alternative implementation of these
milestones.

Phase 1 remains report-only. Stored coordination output is limited to `record`, and
gateway behavior remains `allow`. Observation gaps must be reported as degraded
coverage rather than treated as complete observation.

The Phase 0 event contract is closed for this phase. The observation path uses
`tool.requested`, `tool.completed`, `file.read`, `file.changed`, `symbol.read`,
`symbol.changed`, `task.completed`, `dependency.changed`, and
`attribution.corrected`. A failed or interrupted operation is a `tool.completed`
event whose outcome is `failed` or `interrupted`; Phase 1 does not invent a separate
`tool.failed` event type. Attribution is always represented by nullable envelope
fields, and a later correction is a new immutable event.

Phase 1 may accept protocol records needed for replay and compatibility, but it does
not emit detector findings, policy decisions, disruptive directives, or Phase 2
detector output.

## Milestone Order

Milestones are ordered by dependency. Each milestone must end with executable tests or
recorded measurement evidence; scaffolding alone does not complete a milestone.

### M0: Phase 0 Completion Gate (Complete)

This is a prerequisite gate, not a Phase 1 runtime milestone.

**Scope:**

- Run the Phase 0 validator and complete Phase 0 test, fixture, redaction, and
  placeholder checks.
- Confirm every positive fixture declares graph, findings, decisions, validity, and
  coverage outputs, and every negative fixture declares its expected error.
- Confirm the contract corpus, schemas, fixtures, and validator evidence are committed
  and reproducible from a clean checkout.
- Resolve any remaining contract ambiguity before adding TypeScript runtime code.

**Exit evidence:**

- [M0 completion evidence](../phase0/PHASE_0_M0_EVIDENCE.md)

- The Phase 0 corpus validates successfully.
- Positive and negative fixtures produce their declared outcomes.
- The Phase 0 test, redaction, placeholder, and reproducibility checks pass from the
  committed corpus.
- Phase 0 evidence is recorded without introducing runtime, storage, adapter, daemon,
  or CLI implementation.

### M1: Workspace and Protocol Round Trip (Complete)

**Goal:** Establish the TypeScript/pnpm modular-monolith boundary and validate a
minimal event path.

**Scope:**

- Create the strict TypeScript/pnpm workspace and initial package boundaries.
- Create `packages/protocol` with typed identities, event envelopes, payload
  discrimination, and boundary validation derived from the Phase 0 contracts. The
  types must cover every Phase 1 input event listed above, including
  `attribution.corrected`.
- Create the smallest collector/service surface needed to accept normalized events.
- Support `tool.requested` and `tool.completed` through an in-memory round trip.
- Keep protocol code runtime-agnostic; it must not import the MCP proxy, storage, or
  CLI packages.

**Exit evidence:**

- [M1 completion evidence](evidence/PHASE_1_M1_EVIDENCE.md)

- Valid events are accepted and malformed or unsupported events are rejected.
- `agentId` and `taskId` are always present and may be `null`.
- Correlation, causation, source sequencing, and event-type payload matching are
  preserved by the protocol boundary.
- Failed and interrupted tool outcomes use the closed `tool.completed` payload
  contract, and immutable attribution corrections validate their target event.
- Strict type checking and protocol tests pass.

### M2: Append-Only Event Store and Replay Core (Complete)

**Goal:** Make the normalized event stream durable and replayable.

**Scope:**

- Add SQLite migrations and an append-only event repository.
- Store canonical event digests for idempotency and conflicting duplicate detection.
- Add event reads and a replay driver without external side effects.
- Preserve causal ordering rules when events arrive out of order; buffer valid events
  until their parents are available or report a deterministic bounded-replay failure.
  Never repair causality using wall-clock order or synthesize missing events.

**Exit evidence:**

- [M2 completion evidence](evidence/PHASE_1_M2_EVIDENCE.md)

- Events survive process restart and stored event bytes are never mutated.
- An identical duplicate event is a no-op.
- A duplicate event ID with different content fails deterministically.
- Valid duplicate and out-of-order inputs produce the same replay input state as the
  canonical event stream.
- Missing causal references and impossible transitions fail without producing a partial
  success snapshot, while source-sequence gaps remain explicit degraded coverage.
- Migration and repository tests pass against a temporary SQLite database.

### M3: First Runtime Boundary (Complete)

**Goal:** Capture actual tool intent and outcome through one runtime integration.

**Scope:**

- Implement the MCP proxy as the single Phase 1 runtime boundary. Do not add a second
  adapter or a runtime-specific alternative in this milestone.
- Record `tool.requested` before execution and `tool.completed` after execution.
- Preserve source identity, source sequence, correlation, causation, attribution,
  failure, and interruption information.
- Connect the runtime boundary to the protocol validator and event store.

**Exit evidence:**

- [M3 completion evidence](evidence/PHASE_1_M3_EVIDENCE.md)

- An integration-tested tool call produces persisted request and outcome events.
- A failed or interrupted tool call is represented as an outcome, not inferred as a
  success.
- Missing task attribution is accepted as `null`.
- The runtime boundary does not contain detector or coordination policy logic.
- Gateway behavior remains `allow`.

### M4: Effect Observation and Coverage

**Goal:** Record what actually happened after a tool call and expose observation gaps.

**Scope:**

- Observe Git repository, worktree, and revision identity at the observation boundary.
- Observe filesystem changes and content hashes after an operation.
- Represent process results through the completed outcome and link verified effects to
  the originating tool outcome with effect event IDs.
- Observe opaque shell requests without claiming to enumerate their prospective
  effects. Bypassed or unverified operations must produce explicit coverage gaps.
- Apply secret redaction before persistence and in diagnostic output.
- Do not add AST analysis, symbol detectors, or coordination policy to the observation
  path.

**Exit evidence:**

- File changes, Git changes, content versions, and process outcomes are represented
  as normalized evidence.
- Opaque or bypassed effects reduce reported coverage rather than appearing fully
  observed.
- Security fixtures persist no unredacted secrets.
- Cross-worktree identity remains stable and path handling follows the Phase 0
  identity contract.
- Every verified effect is linked to its originating tool outcome, or is explicitly
  recorded as unattributed/out-of-band observation with degraded coverage.
- Effect-observation tests cover a temporary repository, a separate worktree, a
  changed file, a failed process, and an opaque shell operation.

### M5: Replayable Work-Graph Projections

**Goal:** Build the live work graph as rebuildable derived state.

**Scope:**

- Project agents and attributed tasks from event envelopes, resources and versions from
  resource observation/change events, dependencies from `dependency.changed`, and
  coverage from stored observation evidence.
- Support nullable attribution followed by an immutable attribution correction.
- Produce canonical graph snapshots with stable ordering.
- Keep the event log as the source of truth; do not make graph tables authoritative.
- Define the event-to-node and event-to-edge mapping as part of the projector. A
  Phase 1 graph does not require detector findings or policy decisions.

**Exit evidence:**

- Incremental processing and clean replay produce byte-equivalent graph snapshots.
- Duplicate and valid out-of-order event variants converge to the same projection.
- Attribution correction changes projected state without changing original event
  bytes.
- Projection fixtures cover agents, tasks, resources, reads, changes, dependencies,
  versions, coverage, missing attribution, and correction.
- No Phase 2 detector finding or policy decision is emitted or required to build the
  Phase 1 graph.

### M6: Read-Only Daemon Services and CLI

**Goal:** Make observed and projected state usable through stable public queries.

**Scope:**

- Compose storage, protocol, observation, and projection packages in the daemon.
- Expose public read services for current status, agents, events, and graph state.
- Implement `patchmesh status`, `patchmesh agents`, `patchmesh events`, and
  `patchmesh graph`.
- Support deterministic human output, JSON output, redaction, coverage warnings,
  filters, and `patchmesh events --follow`. The follow stream has a documented stable
  ordering, cursor, disconnect, and shutdown behavior.
- Keep Phase 1 status limited to daemon/store health, observed event counts, agent and
  task attribution counts, and coverage state/gaps. Do not expose overlaps, paused or
  stale states, findings, or later-phase validity claims.

**Exit evidence:**

- CLI integration tests exercise the public services against a fixture database.
- Output and exit behavior are deterministic and documented.
- CLI commands do not query internal SQLite tables directly when a domain service
  exists.
- Fixture-database tests verify redaction, null attribution, degraded coverage,
  filters, JSON output, and `events --follow` behavior.
- The commands remain read-only and do not introduce unscheduled commands such as
  `init`, `start`, `watch`, `overlaps`, `stale`, or `explain`.

### M7: Golden Slice, Resilience, and Performance Gate

**Goal:** Verify the complete Phase 1 observation path and record exit evidence.

**Scope:**

- Exercise an observation-only version of the cross-worktree exported-contract event
  stream as input. The Phase 1 variant expects graph and coverage state only; it does
  not reuse Phase 2 findings or decisions as Phase 1 output.
- Verify canonical replay, clean projection rebuilds, duplicate and out-of-order
  handling, missing attribution and correction, restart recovery, redaction, and
  bypassed-operation coverage.
- Measure and record p50 and p95 interception overhead using the Phase 0 benchmark
  definitions and reproducible environment metadata.
- Confirm the golden scenario remains observation and replay only. Exported-contract
  impact detection is Phase 2 work.

**Exit evidence:**

- Every Phase 1 roadmap exit gate has a passing test or recorded measurement.
- Replay is deterministic and projection rebuilds are equivalent.
- Security and degraded-observability fixtures pass.
- Interception overhead results include warm-up, sample count, failures, raw
  observations, environment metadata, and p50/p95 calculations. This is a
  reproducible baseline gate; Phase 1 does not require a performance threshold that
  Phase 0 did not define.
- The observation-only golden slice produces no Phase 2 findings, decisions, or
  disruptive directives.
- The implementation emits no Phase 2 detector findings or disruptive directives.

## Dependency Graph

```text
M0 Phase 0 gate
  -> M1 Workspace and protocol
  -> M2 Event store and replay
  -> M3 Runtime boundary
  -> M4 Effect observation and coverage
  -> M5 Work-graph projections
  -> M6 Read-only daemon and CLI
  -> M7 Golden slice and exit evidence
```

M5 depends on M2 and M4. M6 depends on M5. M7 depends on all preceding milestones.

## Explicitly Deferred

The following work is not part of Phase 1:

- Same-symbol, stale-read, and exported-contract detectors
- `patchmesh overlaps`, `patchmesh stale`, and `patchmesh explain`
- Notification, recheck, stale, or revalidation policy decisions
- `delay`, `reject`, pause, claims, leases, or other enforcement behavior
- A second runtime adapter
- A dashboard, graph database, distributed queue, or microservice split

These items require the Phase 2 or later scope and exit evidence defined by
`docs/ROADMAP.md`.
