# Phase 1 M5 Evidence: Replayable Work-Graph Projections

**Status:** Verified

**Verification date:** 2026-08-08

**Base revision:** `1983fbc` (M5 implementation and evidence were uncommitted in the working tree at verification time)

## Scope Verified

M5 adds a typed in-memory work-graph projector to `patchmesh-storage`. The projector
implements the existing replay reducer boundary and exposes `projectWorkGraph`,
incremental `WorkGraphProjector.process`, and frozen `snapshot` APIs. It projects
agents, tasks, resources, versions, reads, changes, dependencies, task completion
evidence, immutable attribution corrections, and conservative coverage derived from
persisted event evidence.

SQLite remains append-only event storage and the source of truth. No graph tables,
graph migration, coverage event, detector, finding, decision, validity transition,
coordination action, gateway directive, daemon, or CLI behavior was added.

## Commands and Results

| Command | Result |
| --- | --- |
| `corepack pnpm --filter patchmesh-storage test -- work-graph.test.ts` | Passed: 31 storage tests |
| `corepack pnpm --filter patchmesh-storage typecheck` | Passed |
| `corepack pnpm --filter patchmesh-storage build` | Passed |
| `corepack pnpm --recursive test` | Passed: 82 workspace tests |
| `corepack pnpm --recursive typecheck` | Passed for all 5 workspace packages |
| `corepack pnpm --recursive build` | Passed for all 5 workspace packages |
| `node tools/phase0/validate.mjs` | `Phase 0 corpus valid` |
| `node --test tools/phase0/*.test.mjs` | Passed: 47 tests |
| `git diff --check` | Passed; no whitespace errors |

## Behavior Evidence

- Agent and task nodes are projected from nullable event-envelope attribution, with
  `performs` edges when both identities are present.
- Resource and version nodes are projected from file and symbol observations and
  changes. Version identity includes repository, workspace, worktree, kind, value, and
  resource identity; no version is treated as globally current.
- Read, change, reference, and dependency edges retain stable evidence IDs. Dependency
  edges retain dependency identity, versions, provenance observations, and evidence.
- `task.completed` records work-product and completion evidence without creating
  validity state.
- Missing attribution remains on activity edges. `attribution.corrected` changes the
  projected attribution while the original event object and stored event bytes remain
  unchanged.
- Canonical and causally valid out-of-order inputs produce byte-equivalent snapshots.
  Incremental processing and clean replay produce byte-equivalent snapshots.
- Snapshots are deeply frozen and stable-order. Invalid causal input fails before a
  projection snapshot is returned.
- Opaque requests, unresolved effects, out-of-band changes, and source-sequence gaps
  produce degraded coverage. A request with completion but no persisted effect evidence
  remains interception-only and has unknown presentation.
- Projection event types are replay-compatible but do not produce Phase 2 graph state.

## Coverage Limitation

The Phase 1 event set remains closed and has no coverage event. M4 diagnostics returned
to a caller but not persisted as events cannot be reconstructed during replay. M5
therefore derives only conservative coverage from stored requests, completions, linked
resource effects, out-of-band resource events, and replay source-sequence gaps. It does
not claim complete effect observation when persisted evidence is absent.

## Deferred Scope

M6 read-only daemon and CLI services, M7 golden-slice/resilience/performance evidence,
Phase 2 detectors, findings, policy decisions, validity transitions, disruptive
directives, graph persistence, and additional runtime adapters remain unimplemented.
