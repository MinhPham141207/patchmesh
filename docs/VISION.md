# PatchMesh Vision

> **Status:** Product vision and planned behavior. PatchMesh is currently at the
> documentation-first concept stage; see [ROADMAP.md](ROADMAP.md) for delivery status.

## Overview

PatchMesh is a runtime consistency layer for parallel coding agents.

Modern agent systems can divide a project into tasks, run multiple agents in separate worktrees, and merge their results. However, they are still weak at handling what happens while those agents are working.

One agent may change an API, schema, function, dependency, or architectural assumption while another agent continues working from an outdated understanding of the project. The agents may edit different files, so Git detects no direct conflict. Each task may appear successful in isolation, yet the combined system can still fail.

PatchMesh exists to detect and manage these situations before stale or conflicting work spreads.

## Vision

PatchMesh should become a dependency and invalidation engine for concurrent agent work.

A build system understands:

```text
File A changed
→ File B depends on File A
→ File B must be rebuilt
```

PatchMesh should understand:

```text
Agent A changed an API or assumption
→ Agent B's work depends on the previous version
→ Agent B must be notified, paused, or revalidated
```

The long-term goal is to let multiple coding agents work concurrently while maintaining a continuously consistent understanding of the project.

## Initial User and Promise

The initial user is a developer or small platform team running two or more coding
agents in separate Git worktrees for one repository.

PatchMesh's first promise is:

> Detect when one agent's candidate change threatens the validity of another task,
> explain the dependency path, and request the cheapest reliable revalidation before
> integration.

## Core Problem

Parallel coding agents commonly face several coordination failures:

- Two agents unknowingly implement the same fix.
- Agents make incompatible decisions in different files.
- One agent changes a dependency another agent already used.
- A completed task becomes stale after a later change.
- Agents expand into one another's scope.
- New blockers or required tasks are discovered too late.
- Integration failures are detected only after merging or testing.

Existing orchestrators mainly decide who should do the work. Git worktrees isolate code changes. Tests verify some results afterward.

PatchMesh focuses on the missing layer:

> Determining when concurrent work is no longer independent.

## Core Responsibility

PatchMesh should:

1. Observe agent tool activity.
2. Record both intended actions and actual effects.
3. Build a live causal graph of agent work.
4. Detect overlap, dependency changes, and stale work.
5. Explain which agents or tasks are affected and why.
6. Trigger the least disruptive coordination response.
7. Revalidate affected work when necessary.

## How PatchMesh Works

Agent tool calls pass through a PatchMesh gateway.

```text
Coding agent
    ↓
PatchMesh gateway
    ↓
Filesystem, shell, Git, tests, MCP tools
```

PatchMesh records activity such as:

- Files read and modified
- Symbols and APIs inspected or changed
- Commands executed
- Tests run
- Dependencies introduced
- Task scope changes
- New blockers or discoveries
- Branch, patch, and commit state

This information forms a live work graph connecting:

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

When the graph changes, PatchMesh evaluates whether other running or completed tasks are affected.

## Coordination Model

PatchMesh should classify relationships between agents instead of treating all overlap as a conflict.

### Harmless

Agents access the same resource without interfering.

**Action:** Record only.

### Complementary

Agents approach the same area through compatible roles.

Example:

- Agent A implements a fix.
- Agent B writes reproduction tests.

**Action:** Clarify ownership and allow both to continue.

### Duplicate

Agents with different assigned tasks begin implementing the same underlying fix.

**Action:** Assign one owner and redirect the other agent.

### Conflicting

Agents make incompatible changes or decisions.

**Action:** Pause or escalate the affected work.

### Dependency-affecting

One agent changes something another agent depends on.

**Action:** Notify, pause, mark stale, or request revalidation.

## Product Principles

### Observe behavior, not only plans

Task descriptions are incomplete. PatchMesh must track what agents actually read, modify, run, and depend on.

### Track intent and reality separately

Tool hooks reveal what an agent intends to do. Filesystem and Git observation verify what actually happened.

### Prefer deterministic evidence

Explicit relationships such as shared symbols, changed signatures, imports, schemas, and stale content hashes should be evaluated before using semantic model judgment.

### Use semantic reasoning carefully

LLMs may help detect duplicate investigations or indirect architectural impact, but low-confidence predictions must not automatically stop work.

### Choose the least disruptive action

PatchMesh should prefer:

```text
allow
record
notify
request recheck
assign ownership
redirect
pause
mark stale
request revalidation
escalate
```

It should not cancel or restart agents unnecessarily.

### Explain every decision

Every warning, pause, ownership decision, or stale-work finding must include evidence.

Example:

```text
Agent B read authenticate() at version 12.
Agent A changed authenticate() to version 13.
Agent B is currently modifying a caller of authenticate().
Therefore Agent B may be working from stale behavior.
```

### Remain agent-agnostic

Agent-specific behavior belongs in adapters. The core event model, graph, detectors, and policies must not depend on one coding-agent runtime.

## Product Boundaries

PatchMesh is not:

- A coding agent
- A general-purpose agent orchestrator
- A task planner
- A replacement for Git
- A replacement for tests
- A project-management platform
- A general agent group-chat system

PatchMesh should integrate with existing orchestrators and coding agents rather than replacing them.

```text
Orchestrators assign the work.
Worktrees isolate the work.
Tests verify the work.
PatchMesh keeps the work consistent while it changes.
```

## Differentiation

Existing systems already address parts of the problem:

- Task orchestration
- Worktree isolation
- File locking
- Same-file collision detection
- Same-symbol collision detection
- Stale file writes
- Agent messaging

PatchMesh should focus on the broader unsolved gap:

> Detecting when one agent's change invalidates another agent's running or completed work, even when they modify different files.

Its strongest differentiation should be causal dependency tracking across:

- Files
- Symbols
- APIs
- Schemas
- Tests
- Tasks
- Assumptions
- Agent discoveries

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

## Success Criteria

PatchMesh succeeds when it measurably reduces:

- Duplicate agent work
- Conflicting implementations
- Work completed from stale context
- Integration failures
- Unnecessary agent restarts
- Wasted tool calls, tokens, and execution time
- Human effort required to supervise parallel agents

It should also improve:

- Time to detect coordination problems
- Accuracy of impact analysis
- Clarity of agent ownership
- Reproducibility of coordination decisions
- Confidence in running more agents concurrently

## Long-Term Vision

PatchMesh should become the runtime control plane that allows large groups of coding agents to work on one evolving codebase safely.

Agents should be able to work independently when their tasks are truly independent and coordinate only when evidence shows that their work has converged, conflicted, or become stale.

The final vision is:

> Parallel coding agents that can move quickly without silently diverging from one another or from the current state of the project.
