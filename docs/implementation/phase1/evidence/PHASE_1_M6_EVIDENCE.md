# Phase 1 M6 Evidence: Read-Only Daemon Services and CLI

**Status:** Historical verification snapshot

**Verification date:** 2026-08-08

**Verification base revision:** `65ee902` (the M6 changes were uncommitted when this
focused verification ran)

**Subsequent Phase 1 completion revision:**
`644a9e6f983bb7601e35e8f7ab3c1c26474b8adf` (`644a9e6`, M7 gate)

## Scope Implemented

M6 adds `@patchmesh/query` as the public read-service boundary, `apps/daemon` as an
in-process composition layer, and `apps/cli` with the four scheduled read-only
commands: `status`, `agents`, `events`, and `graph`.

The implementation includes deterministic human, JSON, and events NDJSON output,
recursive redaction, filters, cursor pages, `events --follow`, abort handling, typed
errors, coverage warnings, and Phase 1-only status fields. It does not add network
transport, lifecycle commands, database creation, writes, migrations, findings,
decisions, validity, overlaps, stale state, or Phase 2 output.

## Focused Results

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @patchmesh/query test` | Passed: 7 tests |
| `corepack pnpm --filter @patchmesh/daemon test` | Passed: 2 tests |
| `corepack pnpm --filter @patchmesh/cli test` | Passed: 4 tests |
| `corepack pnpm --recursive test` | Passed: 95 workspace tests |
| `corepack pnpm --recursive typecheck` | Passed for 8 workspace packages |
| `corepack pnpm --recursive build` | Passed for 8 workspace packages |
| `node tools/phase0/validate.mjs` | `Phase 0 corpus valid` |
| `node --test tools/phase0/*.test.mjs` | Passed: 47 tests |
| `git diff --check` | Passed; no whitespace errors |

## Behavior Evidence

- Query services aggregate observed event counts, unique attribution counts, replayable
  health, M5 coverage, and explicit gaps without lifecycle or Phase 2 state.
- Agents preserve nullable task attribution and deterministic ordering.
- Graph queries reuse M5 projections and preserve stable filtered node/edge ordering.
- Events use durable insertion order, type/agent/task/time/limit filters, explicit
  cursors, and redacted normalized records.
- `events --follow` advances over filtered events, suppresses duplicates, supports
  abort shutdown, and reports cursor failures.
- CLI output is deterministic across human and JSON modes. `events --json` emits
  redacted page records as newline-delimited JSON.
- Unscheduled commands are rejected with usage exit code `2`; degraded reporting exits
  `0`; unavailable stores use `3`; replay/cursor failures use `4`.
- Missing database paths are rejected without creating files, migrations, or stores.
- The daemon composes public services without network listeners or lifecycle behavior.

## Residual Coverage Limitations

Coverage remains conservative and is derived from persisted events. Non-persisted M4
diagnostics cannot be reconstructed by replay. Follow polling is local-process only and
does not provide network transport or cross-process subscription guarantees.

## Deferred Scope

Phase 2 findings and policy; overlap, stale, explain, validity, enforcement, dashboard,
lifecycle commands, and network daemon transport remain deferred. M7 subsequently
provided golden-slice, resilience, and performance evidence at the recorded completion
revision above.
