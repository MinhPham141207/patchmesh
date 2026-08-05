# PatchMesh Lifecycle

> **Status:** Planned lifecycle semantics. See [ROADMAP.md](ROADMAP.md) for the active
> delivery phase; listed states and transitions are not claims of implementation.

## 1. Purpose

This document defines how work moves through PatchMesh.

PatchMesh observes coding agents while they execute tasks, converts their activity into events, updates the live work graph, detects coordination risks, and produces actions for agents or orchestrators.

```text
Register
→ Observe
→ Record
→ Analyze
→ Detect
→ Decide
→ Coordinate
→ Revalidate
→ Resolve
```

## 2. Agent Lifecycle

An agent can move through these states:

```text
registered
ready
running
waiting
paused
blocked
completed
failed
disconnected
```

### `registered`

The runtime has introduced the agent to PatchMesh.

Required information:

- `agentId`
- Runtime type
- Session identifier
- Capabilities
- Workspace or worktree
- Current task, when available

### `ready`

The agent is connected and able to receive work.

### `running`

The agent is actively processing a task or using tools.

### `waiting`

The agent is waiting for a tool, dependency, or response.

### `paused`

PatchMesh or the orchestrator has temporarily stopped the agent.

Typical reasons:

- Conflicting work
- Dependency change
- Ownership dispute
- Required revalidation

### `blocked`

The agent cannot continue until another task or condition is resolved.

### `completed`

The agent has finished its assigned task.

Completion does not guarantee permanent validity. Later changes may mark the task as possibly stale.

### `failed`

The agent stopped because of an unrecoverable error.

### `disconnected`

PatchMesh can no longer observe or communicate with the agent.

Active claims should eventually expire.

## 3. Task Lifecycle

A task can move through these states:

```text
queued
assigned
running
waiting
blocked
paused
completed
possibly_stale
stale
revalidating
valid
failed
cancelled
```

### `queued`

The task exists but has no active owner.

### `assigned`

The task has been assigned to an agent.

### `running`

The agent is actively working on it.

### `waiting`

The task is temporarily waiting but is not blocked by an unresolved issue.

### `blocked`

The task depends on unresolved work or a missing requirement.

### `paused`

Execution has been deliberately stopped.

### `completed`

The implementation is finished.

### `possibly_stale`

A dependency changed and the task may no longer be valid.

### `stale`

PatchMesh confirmed that the task output is invalid.

### `revalidating`

The task is being checked against current dependencies.

### `valid`

The task is complete and verified against current dependencies.

### `failed`

The task could not be completed.

### `cancelled`

The user or orchestrator intentionally ended the task.

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

## 4. Tool Call Lifecycle

Every observable tool call follows this flow:

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

`tool.requested` is durably recorded before pre-check. Post-execution events provide
the outcome and effects; they do not replace the request event.

### Step 1: Requested

The agent requests an operation such as:

```text
read_file
edit_file
run_shell
run_test
git_commit
```

PatchMesh records the agent's intent. Every event contains `taskId`, whose value may
be `null` when an adapter or watcher cannot attribute the activity. Later attribution
is represented by a new immutable event.

### Step 2: Pre-check

PatchMesh checks:

- Is another agent modifying the same resource?
- Is the resource covered by an active claim?
- Is the requesting agent using a stale version?
- Does the operation enter another task's scope?
- Is a blocking decision already active?

### Step 3: Gateway decision

The gateway receives one of:

```text
allow
allow_with_notice
delay
reject
```

The gateway enforces the directive but does not define policy. `delay` and `reject`
remain unavailable to MVP report-only coordination. The policy decision separately
carries a coordination action.

### Step 4: Execution

The real tool runs.

### Step 5: Effect observation

PatchMesh verifies what actually happened using:

- Tool output
- Filesystem events
- Git diff
- Content hashes
- Process exit status
- Test results
- AST or symbol analysis

### Step 6: Event emission

Normalized events are recorded:

```text
tool.completed
file.changed
symbol.changed
test.failed
dependency.changed
```

### Step 7: Graph update

The live work graph updates the agent's footprint, resource versions, dependencies, and task state.

## 5. Event Lifecycle

Events are immutable facts.

```text
Observed
→ Normalized
→ Validated
→ Stored
→ Projected
→ Processed
```

### Observed

An adapter, gateway, watcher, or runtime produces raw activity.

### Normalized

Runtime-specific data is converted into the PatchMesh protocol.

### Validated

Required fields and payloads are checked.

### Stored

The event is appended to the event store.

### Projected

The event updates derived state such as the live work graph.

### Processed

Relevant detectors evaluate the new state.

Stored events must never be rewritten. Corrections are represented by new events.

## 6. Work Footprint Lifecycle

A work footprint represents what an agent is currently doing.

It is built from:

- Active task
- Recent reads
- Write intentions
- Actual modifications
- Symbols touched
- Commands executed
- Tests run
- Claims
- Discoveries
- Dependencies

```text
Empty
→ Initial scope
→ Active reads and writes
→ Expanded or converged scope
→ Completed footprint
```

Historical footprint data remains available after the active footprint changes.

## 7. Claim and Lease Lifecycle

A claim represents temporary ownership or responsibility.

```text
Requested
→ Granted
→ Active
→ Renewed
→ Released or Expired
```

Claims should be:

- Temporary
- Granular
- Explainable
- Recoverable after agent failure

Prefer symbol- or component-level claims over whole-file claims where practical.

## 8. Discovery Lifecycle

A discovery is new information found during execution.

```text
Reported or inferred
→ Classified
→ Linked
→ Evaluated
→ Converted into tasks or findings
```

Examples:

- New blocker
- Missing migration
- Unexpected dependency
- Root cause
- Invalid assumption
- New required task

Discovery classes:

```text
local
independent
blocking
dependency_affecting
architecture_affecting
informational
```

A discovery does not directly trigger a disruptive action. It first becomes evidence for a finding.

## 9. Finding Lifecycle

A finding is an interpretation produced by a detector.

```text
Created
→ Enriched with evidence
→ Scored
→ Reviewed by policy
→ Resolved or dismissed
```

A finding should include:

- Type
- Source events
- Affected agents or tasks
- Evidence
- Confidence
- Severity
- Suggested response

Typical findings:

```text
same_symbol_overlap
duplicate_work
conflicting_work
stale_dependency
scope_expansion
stale_completed_task
downstream_test_impact
```

## 10. Decision Lifecycle

A decision is the result of applying policy to a finding.

```text
Proposed
→ Approved automatically or escalated
→ Delivered
→ Acknowledged
→ Enforced
→ Resolved
```

A decision must include:

- Action
- Target
- Reason
- Evidence
- Confidence
- Expected response
- Source finding

Core actions:

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

Revalidation creates or updates the projection of a task validity record. The record
links the work product, base revision, observed dependency versions, integration
target, validation commands and results, coverage, and the decision that requested
the check. Replay must rebuild the same validity state from these events.

The MVP may request revalidation but cannot automatically `delay` or `reject` the
agent operation that triggered it.

## 11. Coordination Lifecycle

After a decision is created:

```text
Decision
→ Targeted update
→ Agent or orchestrator response
→ State transition
→ Follow-up observation
```

The update should explain:

- What changed
- Who changed it
- Why the target is affected
- Evidence
- Required next action

An affected agent may reply:

```text
affected
not_affected
already_handled
needs_more_information
```

## 12. Stale Work Lifecycle

```text
Dependency read
→ Work produced
→ Dependency changes
→ Impact detected
→ Possibly stale
→ Revalidation
→ Valid or stale
```

Example:

```text
Agent B reads API v3.
Agent B implements a client.
Agent A changes the API to v4.
PatchMesh links the change to Agent B.
Agent B's task becomes possibly_stale.
Targeted checks run.
The task becomes valid or stale.
```

Use:

- `possibly_stale` when impact is uncertain
- `stale` when invalidation is confirmed
- `valid` after successful revalidation

## 13. Revalidation Lifecycle

```text
Requested
→ Planned
→ Executed
→ Evaluated
→ Resolved
```

Possible methods:

- Targeted tests
- Compilation
- Type checking
- Contract validation
- Schema validation
- Agent review
- Diff comparison
- Orchestrator review

Use the cheapest reliable method first.

## 14. Duplicate Work Lifecycle

```text
Different tasks begin
→ Work footprints converge
→ Duplicate-work finding
→ Ownership decision
→ One agent continues
→ Other agent redirects
```

The redirected agent may:

- Continue task-specific work
- Write tests
- Review the shared fix
- Wait for the owner
- Take a newly discovered task

PatchMesh should preserve useful work instead of cancelling the entire task.

## 15. Conflict Lifecycle

```text
Potential conflict
→ Evidence collected
→ Severity classified
→ Coordination or pause
→ Resolution
→ Revalidation
```

Conflict types:

- Textual
- Symbol-level
- Semantic
- Architectural
- Dependency-level
- Ownership-related

Only high-confidence conflicts should automatically block execution.

## 16. Recovery Lifecycle

PatchMesh must recover from:

- Agent crash
- Gateway restart
- Adapter disconnection
- Partial tool execution
- Event-processing failure
- Expired claims

```text
Restart
→ Replay stored events
→ Rebuild projections
→ Restore active decisions
→ Expire invalid leases
→ Resume observation
```

The event store remains the source of truth.

## 17. End-to-End Example

```text
1. Agent A and Agent B register.
2. Tasks are assigned.
3. Both agents begin using tools.
4. Tool requests pass through the gateway.
5. PatchMesh records intent and effects.
6. The live work graph updates.
7. Agent A changes a shared API.
8. A detector finds that Agent B depends on the old API.
9. Policy marks Agent B's task possibly stale.
10. Agent B receives a targeted update.
11. Agent B revalidates its implementation.
12. The task becomes valid or stale.
13. All events and decisions remain available for replay.
```

## 18. Lifecycle Principle

```text
Observe facts.
Build relationships.
Detect impact.
Choose the smallest safe response.
Verify the result.
```
