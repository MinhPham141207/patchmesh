# PatchMesh Agent Rules

## 1. Purpose

This file defines the rules coding agents must follow when modifying the PatchMesh repository.

PatchMesh is a runtime consistency layer for parallel coding agents.

Its purpose is to detect when concurrent agent work overlaps, conflicts, or becomes stale because code, dependencies, or assumptions changed.

Do not turn PatchMesh into a general-purpose orchestrator, coding agent, project manager, or Git replacement.

## 2. Required Reading

Before making changes:

1. Read `docs/VISION.md`.
2. Read `docs/ARCHITECTURE.md`.
3. Read `docs/ROADMAP.md` when requested work may affect scope or phase order.
4. Read `docs/TERMINOLOGY.md` before changing public protocol vocabulary.
5. Inspect existing code and tests before proposing a new abstraction.

Do not implement a major architectural change without checking whether it conflicts with these documents.

The architecture and lifecycle documents describe planned target behavior unless a
section explicitly says it is implemented. Never present roadmap work as current
capability.

## 3. Architecture Boundaries

Follow these module responsibilities.

### `packages/protocol`

Contains:

- Shared event types
- Commands
- Entities
- Validation schemas

Rules:

- Must remain runtime-agnostic.
- Must not import adapters, gateway, storage, or UI code.
- Breaking event changes require migration or compatibility handling.

### `packages/gateway`

Contains:

- Tool interception
- Pre-tool hooks
- Post-tool hooks
- Tool routing
- Enforcement of decisions

Rules:

- Record intent before execution.
- Record actual effects after execution.
- Do not implement conflict policy here.
- Enforce decisions produced by the core.

### `packages/core`

Contains:

- Work graph
- Detectors
- Policies
- Coordination decisions
- Evidence generation

Rules:

- Must not depend on one agent runtime.
- Every decision must contain evidence.
- Prefer deterministic rules before semantic reasoning.

### `packages/analyzers`

Contains:

- Git diff analysis
- Filesystem analysis
- AST and symbol extraction
- Import and test relationships
- Semantic classifiers

Rules:

- Analyzers produce facts or findings.
- They do not directly pause or redirect agents.
- Semantic analyzers must return confidence and evidence.

### `packages/storage`

Contains:

- Database access
- Migrations
- Event repositories
- Graph projections

Rules:

- Events are append-only.
- Derived state must be rebuildable.
- Storage code must not decide coordination policy.

### `packages/adapters`

Contains:

- Claude Code adapter
- MCP adapter
- Codex adapter
- Other runtime integrations

Rules:

- Adapters translate runtime events into PatchMesh events.
- Do not duplicate core detection logic.
- Runtime-specific code must stay inside its adapter.

### `apps/daemon`

Contains:

- Process lifecycle
- Dependency wiring
- Local API
- Event processing startup
- Health checks

Rules:

- Keep business logic in packages.
- The daemon should compose modules, not redefine them.

### `apps/cli`

Contains:

- User-facing commands
- Status views
- Explanations
- Local control operations

Rules:

- CLI commands call public services.
- Do not query internal storage tables directly when a domain service exists.

## 4. Implementation Rules

### Event rules

Every event must include:

- `schemaVersion`
- `eventId`
- `eventType`
- `source`
- `timestamp`
- `repositoryId`
- `workspaceId`
- `agentId`
- `taskId: string | null`
- `correlationId`
- `causationId` when applicable
- `sourceSequence` when provided

Events must be immutable after storage.

Do not store hidden model reasoning.

Do not store secrets, tokens, credentials, or full environment values.

### Observation rules

Track both:

```text
Intent before execution
Actual effect after execution
```

Do not assume a tool succeeded because it was requested.

Do not assume a shell command affects only files visible in its command string.

Verify actual effects through:

- Filesystem observation
- Git diff
- Content hashes
- Process results

### Detection rules

Prefer deterministic evidence:

- Same file
- Same symbol
- Changed signature
- Changed schema
- Import relationship
- Stale content hash
- Associated test failure

Use semantic analysis only when deterministic evidence is insufficient.

A semantic prediction alone must not automatically cancel or restart an agent.

### Decision rules

Supported coordination actions should remain limited to:

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

Gateway directives are a separate vocabulary:

```text
allow
allow_with_notice
delay
reject
```

Phase 0 through Phase 3 code may not emit `delay` or `reject`.

Use the least disruptive action.

Every decision must include:

- Target agent or task
- Reason
- Evidence
- Confidence
- Source finding
- Expected next action

### Confidence rules

#### High confidence

Automatic intervention may be allowed.

Examples:

- Same symbol changed concurrently
- Explicit dependency version changed
- Stale read before write
- Schema migration affects a declared dependent

#### Medium confidence

Notify or request recheck.

Do not hard-stop work unless policy explicitly allows it.

#### Low confidence

Record only.

## 5. Scope Rules

Keep changes limited to the assigned task.

Before editing a new area:

1. Confirm it is required.
2. Check whether another task owns it.
3. Record scope expansion when appropriate.
4. Avoid unrelated refactors.

Do not combine feature work with broad cleanup unless required by the task.

Do not silently change public APIs, schemas, event formats, or persistence models.

## 6. Code Quality Rules

- Use strict TypeScript.
- Avoid `any` unless unavoidable and documented.
- Validate external input at boundaries.
- Keep functions focused.
- Prefer explicit types for events and decisions.
- Avoid hidden global state.
- Inject dependencies where practical.
- Keep pure detection logic separate from I/O.
- Use descriptive names over abbreviations.
- Add comments only when the reason is not obvious from the code.

## 7. Testing Rules

Every behavior change requires tests.

Add the most relevant level:

- Unit test for pure logic
- Integration test for module interaction
- Scenario test for coordination behavior
- End-to-end test for gateway and agent flow

Core coordination scenarios must be deterministic and replayable.

When fixing a bug:

1. Add a failing regression test.
2. Implement the fix.
3. Run related tests.
4. Run broader tests when shared protocol or core logic changed.

Do not weaken tests to make a change pass.

Do not replace behavioral assertions with snapshots when explicit assertions are clearer.

Before enabling a new coordination authority level, add scenarios for false positives,
bypassed operations, event duplication and reordering, crash recovery, and user
override. Enforcement requires the exit evidence defined in `docs/ROADMAP.md`.

## 8. Documentation Rules

Update documentation when changing:

- Public behavior
- Event schemas
- Architecture boundaries
- CLI commands
- Adapter requirements
- Decision policy
- Storage model
- Roadmap scope

Documentation must describe current behavior, not planned behavior, unless clearly labeled.

- Do not implement a later roadmap phase without updating `docs/ROADMAP.md` and
  recording why its prerequisites are satisfied or intentionally changed.
- When changing a canonical term, update terminology, architecture, lifecycle,
  protocol types, tests, and user-facing documentation together.
- Every document describing unimplemented behavior must label it as planned or target.
- Root `AGENTS.md` and `KNOWL.md` are project-memory policy and must not be rewritten
  as PatchMesh product documentation.

Keep `VISION.md` focused on why and what.

Keep `ARCHITECTURE.md` focused on how.

Keep `ROADMAP.md` focused on build order.

Keep `AGENTS.md` focused on implementation rules.

## 9. Dependency Rules

Before adding a dependency:

- Confirm the project cannot reasonably implement the need itself.
- Prefer mature and maintained packages.
- Avoid large frameworks for small utilities.
- Check license compatibility.
- Avoid adding multiple libraries for the same purpose.
- Document why the dependency is needed.

Do not introduce:

- Microservices
- Distributed queues
- Graph databases
- Cloud-only infrastructure

unless the roadmap explicitly requires them.

## 10. Database and Migration Rules

- Use migrations for schema changes.
- Never modify an applied migration.
- Preserve append-only event semantics.
- Keep projections rebuildable.
- Add indexes only when justified by query behavior.
- Do not store derived state without documenting how it is rebuilt.

## 11. Adapter Rules

Every adapter must:

- Identify the agent
- Identify the task when available
- Normalize tool activity
- Preserve source metadata
- Handle unsupported events safely
- Avoid runtime-specific logic leaking into the core

Adapters must degrade transparently.

If an adapter cannot observe a class of actions, document that limitation.

## 12. Security Rules

- Never log secrets.
- Redact credentials from command output.
- Avoid arbitrary remote execution in tests.
- Use temporary repositories and worktrees for scenarios.
- Do not grant agents more permissions than required.
- Keep destructive enforcement disabled by default in early versions.

## 13. Error Handling Rules

- Return typed errors where possible.
- Include enough context to debug failures.
- Do not swallow failed tool executions.
- Distinguish observation failure from tool failure.
- Record degraded observability explicitly.
- Do not claim complete tracking when bypass paths exist.

## 14. Performance Rules

Optimize only after measuring.

Prioritize:

- Incremental graph updates
- Incremental parsing
- Batched event writes
- Targeted analysis
- Replayable processing

Avoid reparsing the entire repository after every event.

Avoid calling an LLM for deterministic cases.

## 15. Agent Workflow

When implementing a task:

```text
1. Read relevant docs.
2. Inspect current code and tests.
3. Identify affected modules.
4. Make the smallest coherent change.
5. Add or update tests.
6. Run relevant checks.
7. Review the diff.
8. Update documentation if required.
9. Report assumptions, limitations, and unresolved risks.
```

## 16. Completion Requirements

A task is complete only when:

- The requested behavior is implemented.
- Relevant tests pass.
- The diff contains no unrelated changes.
- Public behavior is documented.
- Architectural boundaries are preserved.
- New assumptions or limitations are stated.
- No known failing checks are hidden.

## 17. Prohibited Changes

Do not:

- Add orchestration features unrelated to consistency tracking.
- Put business logic inside adapters or the CLI.
- Let semantic predictions silently stop agents.
- Store chain-of-thought.
- Mutate stored events.
- Couple the core to one coding-agent runtime.
- Introduce infrastructure not justified by the roadmap.
- Claim shell-level observability when it is not actually enforced.
- Mark work valid without evidence or revalidation.

## 18. Guiding Principle

```text
Adapters observe.
Analyzers understand.
Detectors identify.
Policies decide.
Gateway enforces.
Storage remembers.
```

Preserve this separation in every change.
