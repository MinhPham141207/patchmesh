# PatchMesh Terminology

> **Status:** Canonical vocabulary for planned PatchMesh behavior. Terms describing
> unimplemented capabilities do not imply that those capabilities exist today.

## 1. Purpose

This document defines the canonical vocabulary used across PatchMesh documentation, code, events, APIs, tests, and user interfaces.

Terms should not be used interchangeably when they represent different concepts.

The most important distinction is:

```text
Event ≠ Finding ≠ Decision ≠ Action
```

## 2. Core System Terms

### PatchMesh

The runtime coordination and consistency layer for parallel coding agents.

PatchMesh observes agent activity, models dependencies, detects when work is no longer independent, and coordinates a response.

### Runtime

The environment in which a coding agent operates.

Examples:

- Claude Code
- Codex
- OpenCode
- Custom agent SDK
- MCP-compatible agent

### Adapter

A runtime-specific integration that converts external activity into PatchMesh events and delivers decisions back to the runtime.

Adapters observe and translate. They do not decide policy.

### Gateway

The component through which agent tool calls pass.

The gateway records intent before execution, records effects afterward, and enforces PatchMesh decisions.

### Orchestrator

A system that assigns, schedules, or manages tasks across agents.

PatchMesh complements an orchestrator but does not replace it.

## 3. Work Terms

### Agent

A running coding-agent session.

An agent is the worker.

### Task

A defined unit of work assigned to an agent.

A task is the work.

Do not use `agent` and `task` interchangeably.

### Scope

The expected area of responsibility for a task.

Scope may include:

- Files
- Modules
- Symbols
- APIs
- Tests
- Components
- Responsibilities

### Scope Expansion

When an agent begins working outside its original task scope.

Scope expansion may be valid, but it should be visible and evaluated.

### Work Footprint

The current observable area of an agent's activity.

It may include:

- Files read
- Files modified
- Symbols touched
- Commands executed
- Tests run
- Claims held
- Dependencies used
- Current investigation

### Work Convergence

When agents with different assigned tasks begin investigating or modifying the same underlying problem.

Example:

```text
Agent A: Fix login timeout
Agent B: Fix session refresh

Both converge on:
Database connection leak
```

### Work Divergence

When agents expected to produce compatible results begin making incompatible assumptions or implementations.

### Work Product

The output produced by a task.

Examples:

- Patch
- Commit
- Branch
- Test
- Migration
- Design document
- Generated artifact

## 4. Resource Terms

### Resource

Any entity an agent can read, modify, claim, depend on, or produce.

Resource types may include:

- File
- Symbol
- API
- Schema
- Database table
- Test
- Package
- Configuration
- Architectural decision

### File

A filesystem resource.

### Symbol

A named code-level resource.

Examples:

- Function
- Method
- Class
- Interface
- Type
- Constant

### API Contract

The expected interface between components.

It may define:

- Inputs
- Outputs
- Errors
- Side effects
- Version
- Compatibility rules

### Schema

A structured definition of data.

Examples:

- Database schema
- JSON schema
- Event schema
- API schema

### Test Resource

A test or test group associated with a resource, task, behavior, or dependency.

## 5. Observation Terms

### Tool

An external capability used by an agent.

Examples:

- File reader
- File editor
- Shell
- Git
- Test runner
- Browser
- MCP server

### Tool Call

A single request by an agent to use a tool.

### Intent

What the agent requests or plans to do before execution.

Example:

```text
Agent B intends to modify authenticate().
```

### Effect

What actually happened after the tool executed.

The effect may differ from intent.

### Observation

Raw activity detected by an adapter, gateway, watcher, or runtime.

### Event

An immutable normalized fact recorded by PatchMesh.

Examples:

```text
file.read
file.changed
test.failed
task.completed
```

Events describe what happened, not what it means.

### Event Source

The component that produced the event.

Examples:

- Gateway
- Adapter
- Filesystem watcher
- Git analyzer
- Test runner
- Agent report

### Event Projection

Derived state built from stored events.

The live work graph is a projection.

## 6. Graph Terms

### Live Work Graph

The current graph of relationships between agents, tasks, resources, dependencies, events, claims, findings, and decisions.

### Node

An entity in the graph.

Examples:

- Agent
- Task
- File
- Symbol
- API
- Test

### Edge

A typed relationship between graph nodes.

Examples:

```text
agent performs task
task reads file
symbol calls symbol
task depends on API
test validates component
```

### Dependency

A relationship where one entity relies on another.

### Dependency Type

A label describing the relationship.

Common dependency types:

```text
reads
writes
imports
calls
implements
tests
blocks
assumes
produces
owns
```

### Causal Dependency

A dependency where changing one entity may affect the validity of another entity's work.

### Dependency Invalidation

The process of identifying work that may no longer be valid because one of its dependencies changed.

## 7. Version and Validity Terms

### Version

The state of a resource at a specific point in time.

A version may be represented by:

- Content hash
- Git commit
- Schema version
- API version
- Symbol revision

### Read Version

A prose alias for **Observed Version**. Protocol schemas use `observed` and do not
define a separate read-version field.

### Repository

The Git repository whose work is being observed.

Repository identity must be stable across its worktrees.

The machine identity is an opaque `repositoryId` persisted in PatchMesh-owned Git
common-directory metadata. It is not derived from a remote URL, path, branch, or
commit. See [Identity and Resource-Version Protocol](protocol/identities.md).

### Workspace

The filesystem and execution context observed for an agent. A workspace may be a Git
worktree, checkout, container mount, or another isolated view of a repository.

`workspaceId` identifies the filesystem and execution context. It is distinct from the
worktree identity; multiple workspaces may refer to one worktree.

### Worktree

A Git-backed workspace with its own checked-out revision and uncommitted changes.

`worktreeId` is path-independent. Linked worktrees share a repository ID and retain
distinct worktree IDs.

### Integration Target

The branch, revision, or candidate aggregate against which prospective compatibility
and task validity are evaluated.

Validity uses an immutable `targetSnapshotId`, never only a moving branch name.

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

### Current Version

The latest known resource version inside an explicitly named version domain.

Do not compare worktrees using an unscoped global current version. Cross-worktree
impact compares an observed version and a candidate version against an integration
target.

### Stale Read

A read that refers to an older resource version than the current version.

A stale read does not always imply stale work.

### Possibly Stale

Work that may be affected by a dependency change but has not yet been verified.

### Stale

Work confirmed to be invalid because of a dependency or assumption change.

### Valid

Work verified against the current state of its dependencies.

### Revalidation

The process of checking whether possibly stale work remains correct.

### Invalidation

The act of marking work as requiring revalidation or as confirmed stale.

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

Coverage records are scoped evidence. `intercepted` and `verified` are orthogonal. A
relevant gap derives `degraded` presentation, and `inferred` evidence cannot silently
substitute for direct observation. See [Dependency Evidence and Observability Coverage](protocol/evidence-and-coverage.md).

### Task Validity Record

A durable explanation of why a completed work product is believed to be valid,
possibly stale, or stale against an integration target.

It records task and work-product identity, base revision, observed dependencies and
versions, dependency provenance, validation commands and results, observability
coverage, validation time, integration target, and the evidence behind state changes.

Task execution state and work-product validity are separate projections. `completed`
is an execution state; `valid`, `possibly_stale`, `revalidating`, and `stale` are
validity states for a named work product and target snapshot.

## 8. Assumption and Discovery Terms

### Assumption

A fact an agent believes to be true while working.

Examples:

```text
User IDs are integers.
The login API returns one token.
The schema will remain unchanged.
```

### Explicit Assumption

An assumption directly declared by an agent, task, or specification.

### Inferred Assumption

An assumption inferred from tool activity, code, or context.

### Assumption Change

A change that may affect work relying on the previous assumption.

### Discovery

New information found during execution.

Examples:

- New blocker
- Missing migration
- Root cause
- Invalid assumption
- Unexpected dependency
- New task

### Blocker

A condition preventing a task from continuing.

### Follow-Up Task

A newly created task resulting from a discovery, dependency change, or coordination decision.

## 9. Overlap Terms

### Overlap

Any relationship where two agents interact with related resources, responsibilities, or problems.

Overlap does not automatically mean conflict.

### Harmless Overlap

Shared activity that does not interfere.

Example:

```text
Two agents read the same file.
```

### Complementary Overlap

Agents work in the same area through compatible roles.

Example:

```text
One agent implements.
One agent writes tests.
```

### Duplicate Overlap

Agents perform substantially the same work.

### Conflicting Overlap

Agents make incompatible changes or decisions.

### Dependency Overlap

One agent changes a resource another agent depends on.

### Direct Overlap

Agents interact with the same resource.

### Indirect Overlap

Agents interact with different resources connected by dependencies.

## 10. Ownership Terms

### Claim

A temporary declaration of ownership or responsibility.

### Lease

A claim that expires unless renewed.

### Owner

The agent currently responsible for a resource, decision, or shared fix.

### Claim Granularity

The level at which ownership applies.

Examples:

- Repository
- Module
- File
- Symbol
- API
- Task
- Architectural decision

### Heartbeat

A periodic signal showing that an agent is still active and may renew leases.

### Claim Conflict

A situation where multiple agents request incompatible ownership.

## 11. Analysis Terms

### Analyzer

A component that converts raw activity into structured facts or relationships.

Examples:

- Git diff analyzer
- AST analyzer
- Import analyzer
- Semantic analyzer

### Detector

A component that evaluates graph state and produces findings.

### Deterministic Detector

A detector based on explicit, reproducible evidence.

Examples:

- Same symbol
- Changed hash
- Import edge
- Changed schema

### Semantic Detector

A detector using semantic similarity or model-based reasoning.

### Finding

An interpreted coordination issue produced by a detector.

A finding describes what PatchMesh believes may be happening.

### Evidence

The concrete facts supporting a finding or decision.

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

### Severity

The expected impact if a finding is not addressed.

Suggested levels:

```text
informational
low
medium
high
critical
```

### False Positive

A finding that predicts an issue that does not actually affect the work.

### False Negative

A real coordination issue that PatchMesh fails to detect.

## 12. Decision Terms

### Policy

A rule that converts findings into decisions.

### Policy Engine

The component that evaluates findings and chooses coordination decisions.

### Decision

The result of applying policy to a finding.

A decision must include:

- Source finding
- Target agent or task
- Coordination action
- Gateway directive
- Reason
- Evidence
- Confidence and policy version
- Expected response
- Coverage evidence and gaps

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

### Enforcement

The act of applying a decision through the gateway, adapter, orchestrator, or user.

### Escalation

Passing a decision to an orchestrator or human because automatic handling is unsafe or ambiguous.

### Resolution

The final outcome of a finding or decision.

Examples:

- Confirmed
- Dismissed
- Revalidated
- Redirected
- Escalated
- Resolved manually

## 13. Testing and Recovery Terms

### Targeted Revalidation

Running only the checks most closely related to an affected dependency.

### Replay

Reprocessing stored events to rebuild graph state and decisions.

### Projection Rebuild

Recreating derived state from the event log.

### Degraded Observability

A state where PatchMesh cannot observe all relevant agent actions.

### Tool Bypass

An action that avoids the normal gateway or adapter path.

Examples:

- Direct shell access
- External file process
- Unmonitored container
- Separate machine

### Recovery

Restoring PatchMesh state after failure through event replay and lease cleanup.

## 14. Canonical Distinctions

### Agent vs Task

```text
Agent = worker
Task = assigned work
```

### Intent vs Effect

```text
Intent = requested action
Effect = actual result
```

### Event vs Finding

```text
Event = recorded fact
Finding = interpretation of facts
```

### Finding vs Decision

```text
Finding = detected issue
Decision = chosen response
```

### Decision vs Action

```text
Decision = policy result
Action = operation to perform
```

### Coordination Action vs Gateway Directive

```text
Coordination action = policy response for affected work
Gateway directive = execution instruction for a specific tool call
```

### Overlap vs Conflict

```text
Overlap = related work
Conflict = incompatible work
```

### Stale Read vs Stale Work

```text
Stale read = old resource version observed
Stale work = output invalidated by changed dependency
```

### Completed vs Valid

```text
Completed = implementation finished
Valid = implementation verified against current dependencies
```

## 15. Essential PatchMesh Vocabulary

These terms should appear consistently across documentation and code:

```text
Live work graph
Work footprint
Resource
Dependency
Causal dependency
Assumption
Discovery
Overlap
Work convergence
Stale read
Possibly stale
Stale work
Invalidation
Revalidation
Claim
Lease
Finding
Evidence
Confidence
Decision
Coordination action
Scope expansion
```

## 16. Terminology Principle

PatchMesh should always reason in this order:

```text
What happened?
What changed?
What depends on it?
Who is affected?
How certain are we?
What is the smallest safe response?
```
