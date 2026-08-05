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
