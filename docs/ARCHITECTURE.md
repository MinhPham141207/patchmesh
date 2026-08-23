# PatchMesh Architecture

> **Status:** Planned target architecture. M1 through M7 currently implement the protocol
> boundary, in-memory collector, append-only SQLite event store, replay core, an
> in-process MCP runtime boundary, effect observation, rebuildable in-memory graph
> projections, read-only query/CLI composition, and golden-slice resilience and
> performance evidence; see [DELIVERY_PLAN.md](implementation/DELIVERY_PLAN.md) for slice status.

## 1. Purpose

PatchMesh is a runtime consistency layer for parallel coding agents.

It observes agent activity, builds a live model of their work, detects overlap and stale dependencies, and coordinates the minimum necessary response.

PatchMesh does not replace coding agents, orchestrators, Git, or tests. It connects them.

```text
Orchestrator assigns work
        ↓
Agents execute tasks
        ↓
PatchMesh observes and coordinates
        ↓
Git and tests validate results
```

## 2. Architectural Style

PatchMesh should begin as a **modular monolith**.

Reasons:

- Faster iteration
- Easier debugging
- Simple local deployment
- Replayable event processing
- Clear module boundaries without distributed-system overhead

Do not start with microservices, distributed queues, or a graph database.

## 3. High-Level System

```text
Coding Agents
      ↓
Adapters / Gateway
      ↓
Normalized Events
      ↓
Event Store
      ↓
Live Work Graph
      ↓
Detectors
      ↓
Policy Engine
      ↓
Coordination Actions
```

## 4. Main Components

### 4.1 Adapters

Adapters translate runtime-specific activity into the PatchMesh event format.

Examples:

- MCP
- Claude Code
- Codex
- OpenCode
- Custom agent SDKs

Adapters must remain thin.

They may:

- Identify the agent and task
- Translate runtime events
- Deliver PatchMesh decisions back to the runtime

They must not contain conflict or coordination logic.

### 4.2 Gateway

The gateway sits between agents and tools.

```text
Agent
  ↓
PatchMesh Gateway
  ↓
Filesystem / Shell / Git / Tests / MCP Tools
```

Before a tool runs, the gateway records intent.

After the tool runs, the gateway records the result.

The gateway enforces one directive from the core:

```text
allow
allow_with_notice
delay
reject
```

The gateway does not select coordination policy. The MVP produces only `allow` and
`allow_with_notice`; `delay` and `reject` remain disabled until the Phase 4 M6 safety
gate, including its approved authority decision and recovery evidence, supports opt-in
enforcement.

The gateway must not decide policy by itself. It enforces decisions from the core.

### 4.3 Event Collector

The event collector normalizes all observed activity.

The closed V1 event contract currently represented by the protocol includes:

```text
tool.requested
tool.completed
file.read
file.changed
symbol.read
symbol.changed
task.completed
dependency.changed
attribution.corrected
finding.created
decision.created
validity.changed
decision.delivery.changed
```

M1 accepts and validates the nine observation inputs and represents the four
projection-event shapes for protocol compatibility. M2 persists validated events as
immutable canonical bytes and replays them without emitting projection facts.

M3 adds the in-process MCP adapter boundary. It validates and stores `tool.requested`
before injected execution and `tool.completed` afterward, preserving per-call source,
attribution, correlation, causation, and source-sequence metadata. M3 does not add a
transport, effect observer, detector, policy, or projection.

M4 adds the `patchmesh-observation` boundary. It captures Git repository/worktree and
revision metadata, filesystem state, content hashes, and normalized process outcomes
around the MCP call. Snapshot-observed file effects are stored as `file.changed` events
and linked from `tool.completed.payload.effectEventIds`; because a before/after snapshot
cannot prove that each effect originated in the intercepted operation, derived coverage
records an explicit unverified gap. Coverage also reports opaque, bypassed, and
unattributed gaps without adding a coverage event. M4 does not add AST analysis,
detectors, projections, policy, or enforcement.

Every stored event will follow [Event Protocol V1](protocol/events.md) and its
versioned JSON Schema. The closed envelope includes explicit worktree identity,
required nullable agent/task attribution, source-instance sequencing, correlation,
causation, and one event-type-selected payload. M2 durable ingestion will be idempotent
by event ID and canonical content digest; timestamp, source, and causal order remain
distinct.

The protocol is the source of truth for event field names and nullability. Later
attribution is represented by a new event rather than mutation.

Events are append-only.

### 4.4 Event Store

The event store is the source of truth. M2 implements the append-only SQLite event log
and deterministic causal replay. M5 adds rebuildable in-memory graph projections; graph
tables are not authoritative and are not required by the Phase 1 implementation.

Suggested tables:

```text
events
agents
tasks
resources
dependencies
claims
findings
decisions
```

Derived state must be rebuildable from events.

The first version should not require a graph database.

### 4.5 Live Work Graph

The live work graph represents the current relationships between:

```text
Agents
Tasks
Files
Symbols
APIs
Schemas
Tests
Dependencies
Assumptions
Patches
```

Example:

```text
user-schema.ts
      ↓
User schema
      ↓
POST /login
      ↓
login-client.ts
      ↓
Login frontend task
      ↓
login-ui tests
```

The graph is a projection of the event stream, not the original source of truth.

#### Version domains and integration targets

Every resource version belongs to a repository and workspace/worktree version domain.
An unmerged change in another worktree is a candidate version, not a global current
version. Detectors evaluate prospective impact by comparing an agent's observed
version and the candidate version against an explicit integration target.

Resource identity follows [the identity contract](protocol/identities.md), and
evaluations pin immutable target snapshots. It must include enough information to distinguish repositories,
worktrees, revisions, paths, and symbols without treating equivalent Git objects as
unrelated solely because their filesystem roots differ.

### 4.6 Analyzers

Analyzers turn raw activity into structured relationships.

#### Deterministic analyzers

Use these first:

- Filesystem changes
- Git diffs
- Content hashes
- AST parsing
- Import graphs
- Function signatures
- API schemas
- Database migrations
- Test relationships

#### Semantic analyzers

Use an LLM only for uncertain questions such as:

- Are two agents investigating the same root cause?
- Does this discovery affect another task indirectly?
- Are two architectural decisions incompatible?

Semantic analysis must return:

- Confidence
- Evidence
- Explanation

It must not directly stop agents.

### 4.7 Detectors

Detectors evaluate graph changes.

Initial detectors:

- Same-file overlap
- Same-symbol overlap
- Stale file read
- Changed dependency
- Scope expansion
- Duplicate investigation
- Conflicting implementation
- Stale completed task
- Downstream test impact

Each detector returns a finding, not an action.

Example:

```json
{
  "type": "stale_dependency",
  "sourceAgentId": "agent-a",
  "affectedAgentId": "agent-b",
  "confidence": 0.98,
  "evidence": [
    "Agent B read authenticate() at version 12",
    "Agent A changed authenticate() to version 13",
    "Agent B is modifying a caller of authenticate()"
  ]
}
```

### 4.8 Policy Engine

The policy engine converts findings into coordination decisions.

Supported actions:

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

Policy returns both a coordination action and a gateway directive. For example,
`notify`, `request_recheck`, `mark_possibly_stale`, and `request_revalidation`
normally map to `allow_with_notice` in report-only mode. A future `pause` may map to
`delay`; `reject` requires an explicit high-confidence enforcement policy.

Policy must consider:

- Confidence
- Severity
- Current task state
- Cost of interruption
- Whether the dependency is explicit
- Whether work is running or completed
- Whether a human or orchestrator must decide

### 4.9 Coordination Service

The coordination service delivers decisions to agents and orchestrators.

A targeted update should include:

```text
What changed
Who changed it
Why the target is affected
Evidence
Required action
```

Avoid broadcasting full histories or unrelated events.

### 4.10 CLI and API

Initial CLI commands:

```text
patchmesh init
patchmesh start
patchmesh status
patchmesh agents
patchmesh graph
patchmesh overlaps
patchmesh stale
patchmesh events
patchmesh explain <decision-id>
```

The local API may expose:

- Agent registration
- Task registration
- Event ingestion
- Decision retrieval
- Graph queries
- Health status

A dashboard should come after the CLI and core detection are stable.

## 5. Recommended Repository Structure

```text
patchmesh/
├─ apps/
│  ├─ daemon/
│  ├─ cli/
│  └─ dashboard/
│
├─ packages/
│  ├─ protocol/
│  ├─ gateway/
│  ├─ core/
│  ├─ analyzers/
│  ├─ storage/
│  ├─ adapters/
│  └─ sdk/
│
├─ tests/
│  ├─ fixtures/
│  ├─ scenarios/
│  └─ e2e/
│
├─ examples/
├─ docs/
├─ README.md
├─ VISION.md
├─ ARCHITECTURE.md
├─ implementation/DELIVERY_PLAN.md
└─ AGENTS.md
```

## 6. Data Flow

### Example: conflicting edit

```text
1. Agent B requests an edit.
2. Gateway records write intent.
3. Event collector stores the event.
4. Work graph updates Agent B's active footprint.
5. Detector finds Agent A already modifying the same symbol.
6. Policy engine classifies the overlap.
7. Coordination service assigns ownership or pauses the conflict.
8. Gateway enforces the decision.
9. Decision and evidence are stored.
```

### Example: stale dependency

```text
1. Agent B reads API contract v3.
2. Agent A changes the contract to v4.
3. PatchMesh records the dependency change.
4. Work graph finds tasks depending on v3.
5. Agent B is marked possibly stale.
6. Agent B receives a targeted update.
7. PatchMesh requests revalidation.
```

## 7. Consistency Model

PatchMesh should use optimistic coordination by default.

Agents may work independently until evidence shows that their work is no longer independent.

Use stronger enforcement only when confidence is high.

### High confidence

Examples:

- Same symbol is being changed
- Explicit API version changed
- Database schema changed
- An agent writes using a stale read

Possible response:

- Pause
- Reject write
- Mark stale
- Require revalidation

### Medium confidence

Examples:

- Similar investigation
- Possible semantic dependency
- Related architectural changes

Response:

- Notify
- Request recheck
- Escalate if unresolved

### Low confidence

Response:

- Record only

## 8. Failure Handling

PatchMesh must handle:

### Agent crash

- Expire resource claims
- Preserve recorded events
- Keep unfinished work marked as interrupted

### Gateway failure

- Fail safely
- Record degraded observability
- Avoid claiming complete coordination

### Tool bypass

Agents may modify files through shell commands or scripts.

Mitigation:

- Filesystem watcher
- Git diff verification
- Process monitoring
- Sandbox-level observation

### Observability coverage

Every finding and decision reports whether its supporting operations were intercepted,
verified, inferred, or unknown. Coverage is evidence, not a global boolean. PatchMesh
must not claim complete coordination when relevant effects may have bypassed observation.

Opaque shell commands are observational in the MVP. The gateway may observe the
request, while filesystem, Git, process, and test evidence verify effects afterward.
Pre-write rejection for arbitrary commands requires an explicitly configured sandbox
or lower-level mediator and belongs to the measured-enforcement phase.

### False positives

Every decision must be explainable and reviewable.

Agents should be able to respond:

```text
affected
not_affected
already_handled
needs_more_information
```

### Event replay

Replay follows [the replay-equivalence contract](protocol/replay-equivalence.md):
incremental, cold, duplicate, and valid out-of-order inputs must converge.

## 9. Security Principles

Phase 0 defines mitigations and residual risks but implements no sandbox or event
signing. See the [threat model](THREAT_MODEL.md).

- Give agents only the tools required for their task.
- Do not store hidden chain-of-thought.
- Avoid logging secrets or full environment values.
- Redact credentials from shell output and events.
- Keep local-first storage for the MVP.
- Separate observation permissions from execution permissions.
- Require explicit configuration for destructive enforcement.

## 10. Testing Strategy

PatchMesh must be tested with scenario-based simulations.

Core scenarios:

- Two agents edit the same symbol
- Two agents edit different files with one shared API
- One agent changes a schema another agent already read
- Two tasks converge on the same root cause
- Completed work becomes stale
- Agent crashes while holding ownership
- Shell command bypasses direct file tools
- False-positive semantic overlap

Each scenario should define:

- Initial tasks
- Event sequence
- Expected findings
- Expected decisions
- Expected graph state
- Expected validity
- Expected coverage

## 11. MVP Technical Direction

Recommended starting stack:

```text
Language: TypeScript
Architecture: Modular monolith
Workspace: pnpm monorepo
Integration: MCP proxy plus one runtime adapter
Storage: SQLite
Code analysis: Tree-sitter and Git diffs
Communication: Local HTTP or WebSocket
Interface: CLI first
```

The first vertical slice implements one scenario end to end: a candidate exported-
contract change in one worktree affects a consumer observed in another worktree.

Initial detectors are limited to same-symbol overlap, stale-read-before-write, and
exported-contract invalidation. Initial coordination remains report-only. Claims,
semantic classifiers, multiple adapters, a dashboard, and hard enforcement are not
MVP dependencies.

## 12. Architectural Principles

```text
Adapters observe.
Analyzers understand.
Detectors identify.
Policies decide.
Gateway enforces.
Storage remembers.
```

These boundaries should remain stable as PatchMesh grows.
