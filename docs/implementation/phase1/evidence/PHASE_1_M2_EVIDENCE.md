# Phase 1 M2 Evidence: Event Store and Replay

**Status:** Verified

**Verification date:** 2026-08-08

**Base revision:** `598d6f1` (M2 changes were uncommitted in the working tree at verification time)

## Scope Verified

M2 adds `patchmesh-storage` with Node's built-in `node:sqlite` on Node
`v24.15.0`. The package provides transactional migrations, append-only canonical
event storage, SHA-256 digests, duplicate and conflicting-ID handling, raw reads,
and deterministic causal replay. It does not add a runtime adapter, effect
observation, graph projection, detector, policy, daemon, or CLI behavior.

## Commands and Results

| Command | Result |
| --- | --- |
| `corepack pnpm install` | Passed; all 4 workspace projects resolved and up to date |
| `corepack pnpm typecheck` | Passed for protocol, collector, and storage |
| `corepack pnpm build` | Passed for protocol, collector, and storage; migration assets copied to `dist` |
| `corepack pnpm test` | Passed: 18 protocol, 3 collector, and 19 storage tests |
| Phase 0 test suite | Passed: 47 tests |
| `node tools/phase0/validate.mjs` | `Phase 0 corpus valid` |
| `git diff --check` | Passed; no whitespace errors |

## Behavior Evidence

- Migrations create `schema_migrations` and the append-only `events` table and can be
  applied again when the same database is reopened.
- Canonical JSON sorts object keys recursively, preserves array order, and produces
  stable SHA-256 digests.
- Identical event IDs and content are no-ops; an event ID with different content
  raises `PHASE0_ID_CONFLICT` and leaves the stored row unchanged.
- Event bytes survive process restart and raw reads preserve durable insertion order.
- Valid events can be appended before their causal parents without synthesizing or
  repairing references.
- Canonical and causally out-of-order event arrival forms converge to the same replay
  order and default replay state.
- Newly unblocked events participate in the same global event-ID tie-break as initially
  ready events.
- Missing causal parents raise `PHASE0_REFERENCE_MISSING`; causal cycles raise
  `M2_REPLAY_CAUSALITY_UNRESOLVED`.
- Impossible event-set transitions fail before reducer invocation and return no partial
  replay state.
- Source-sequence gaps are returned as explicit degraded-coverage ranges and do not
  become causal edges or synthetic events.
- Replay only reads the immutable event log and applies an in-memory reducer; it does
  not write events, run tools, deliver decisions, or call external services.
- Stored events and replay results are returned as frozen defensive values.
- Operations after store close return the typed `STORAGE_CLOSED` error.

## Deferred Scope

M3 runtime adapters, M4 effect observation and coverage, M5 graph projections, M6
read-only daemon and CLI services, and M7 golden-slice and performance evidence remain
unimplemented and planned.
