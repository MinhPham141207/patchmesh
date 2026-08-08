# Phase 1 M3 Evidence: First Runtime Boundary

**Status:** Implemented; final workspace verification recorded after M3 test completion

**Verification date:** 2026-08-08

## Scope Verified

M3 adds `@patchmesh/adapters` with an in-process `McpProxy`. The proxy accepts
per-call runtime and attribution metadata, validates and persists `tool.requested`
before invoking an injected executor, and persists a causally linked
`tool.completed` outcome afterward through `@patchmesh/storage`.

The boundary remains report-only and allow-only. It does not implement an MCP
transport, filesystem/Git/process effect observation, coverage projection, graph
projection, detector, policy, decision, daemon, or CLI behavior.

## Commands and Results

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @patchmesh/adapters test` | Passed: 8 adapter tests |
| `corepack pnpm --filter @patchmesh/adapters typecheck` | Passed |
| `corepack pnpm --filter @patchmesh/protocol build` | Passed |
| `corepack pnpm --filter @patchmesh/storage build` | Passed |

The full workspace and Phase 0 verification commands are run and recorded by the
M3 completion gate after this evidence file is created.

## Behavior Evidence

- A temporary SQLite integration call persisted exactly one `tool.requested` event
  before execution and one `tool.completed` event after execution.
- Request and completion preserved source identity, repository/workspace/worktree
  identity, attribution, correlation, source sequences, and causation.
- Completion `requestEventId` and `causationId` point to the persisted request event;
  M3 completion events use an empty `effectEventIds` list.
- Explicit `failed` and `interrupted` executor results persisted their outcomes and
  exit codes without persisting error or reason details.
- An unexpected executor throw became a persisted `failed` outcome without storing its
  error object or message.
- Nullable agent/task attribution was accepted, and non-null attribution remained
  isolated to its per-call context.
- Malformed runtime input failed protocol validation before appending or executing.
- Request persistence failure prevented executor invocation.
- Completion persistence failure reported the request event ID and observed execution
  outcome after the real executor had run.
- The stored event set contained only request and completion observations; no findings,
  decisions, directives, or effect events were emitted.

## Deferred Scope and Residual Risk

MCP transport handling, M4 effect observation and degraded coverage, M5 graph
projections, M6 read-only daemon and CLI services, and M7 golden-slice and performance
evidence remain planned. An in-process proxy cannot observe operations that bypass it;
M4 must add verified effect observation and explicit coverage gaps rather than claiming
complete runtime tracking.
