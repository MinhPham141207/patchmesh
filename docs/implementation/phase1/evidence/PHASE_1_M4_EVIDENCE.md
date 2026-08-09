# Phase 1 M4 Evidence: Effect Observation and Coverage

**Status:** Verified

**Verification date:** 2026-08-08

**Base revision:** `6760124` (M4 implementation and focused verification)

## Scope Verified

M4 adds `@patchmesh/observation` and integrates it with the existing in-process
`@patchmesh/adapters` MCP proxy. The observer captures Git repository/worktree and
revision metadata, filesystem state, Git blob values, and SHA-256 content hashes around
one tool call. Snapshot differences become normalized `file.changed` events. The proxy
stores those effects before `tool.completed` and links successfully stored effect IDs in
the completion payload.

Coverage is derived in the proxy result and is not persisted as a new event. Directly
observed effects can report `intercepted` and `verified`; snapshot-observed effects retain
their links but add an explicit unverified origin gap because the snapshot cannot establish
that each change came from the intercepted operation. Opaque calls retain observed actual
effects but add a degraded `opaque` gap. Observer failures, effect persistence failures,
and out-of-band changes produce explicit degraded gaps. M4 remains report-only and emits
no findings, decisions, directives, detectors, projections, or AST facts.

## Focused Commands and Results

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @patchmesh/observation test` | Passed: 16 observation tests |
| `corepack pnpm --filter @patchmesh/observation typecheck` | Passed |
| `corepack pnpm --filter @patchmesh/observation build` | Passed |
| `corepack pnpm --filter @patchmesh/adapters test` | Passed: 14 adapter tests |
| `corepack pnpm --filter @patchmesh/adapters typecheck` | Passed |
| `corepack pnpm --filter @patchmesh/adapters build` | Passed |
| `corepack pnpm --recursive test` | Passed: 70 workspace tests |
| `corepack pnpm --recursive typecheck` | Passed for all 5 workspace packages |
| `corepack pnpm --recursive build` | Passed for all 5 workspace packages |
| `node tools/phase0/validate.mjs` | `Phase 0 corpus valid` |
| `node --test tools/phase0/*.test.mjs` | Passed: 47 tests |
| `git diff --check` | Passed; no whitespace errors |

The workspace test count includes 18 protocol, 3 collector, 19 storage, 16 observation,
and 14 adapter tests.

## Behavior Evidence

- Created, modified, deleted, unchanged, and same-content rename cases produce stable
  deterministic effect facts. Deleted effects use a `deleted` after-version; existing
  content uses a SHA-256 `content_hash` version.
- File resources use the repository-scoped SHA-256 identity formula and full 64-hex
  resource IDs required by the Phase 0 schema.
- Git metadata is captured without deriving opaque repository or worktree IDs from
  paths, branches, remotes, or commits. A temporary linked-worktree test confirms a
  shared Git common directory and distinct administrative directories.
- Successful and failed executions persist post-call effects, and completion records
  only effect IDs that were actually stored.
- A snapshot-derived effect link is evidence of observed post-state, not proof of effect
  origin; it therefore carries explicit unverified coverage rather than a sufficient
  coverage claim.
- Opaque operations report an explicit degraded `opaque` coverage gap rather than
  claiming prospective effect enumeration.
- Observer failures do not prevent executor invocation or completion persistence.
- Effect persistence failures do not create false verified effect IDs or verified-only
  coverage claims.
- Observer-provided out-of-band effects are stored as watcher-rooted events with null
  agent/task attribution and a separate correlation ID; they are not linked to the MCP
  completion effect list.
- Synthetic bearer-token diagnostics are redacted, and raw executor errors are not
  stored in events.
- Invalid logical paths are rejected, and non-Git workspaces report degraded
  unverified coverage rather than fabricated Git identity.
- The stored event set remains within the closed Phase 1 observation vocabulary. No
  coverage event, detector finding, coordination decision, gateway directive, or AST
  output is emitted.

## Residual Risk and Degraded Coverage

- Snapshot polling cannot prove that every filesystem mutation in its observation window
  originated from the intercepted tool. That limitation remains an explicit unverified
  or bypassed coverage gap.
- Opaque shell commands are intercepted but their prospective effects are not
  enumerable; only observed post-state changes can be represented.
- Filesystem races, unreadable paths, ignored/external paths, unavailable Git metadata,
  and out-of-band changes reduce coverage rather than being treated as complete
  observation.
- Coverage is derived at M4. Durable coverage projection remains M5 work.
- M4 does not provide sandboxing, kernel-level interception, transport handling, or
  enforcement behavior.

## Final Gate Results

The final gate passed with these commands:

```bash
corepack pnpm --recursive test
corepack pnpm --recursive typecheck
corepack pnpm --recursive build
node tools/phase0/validate.mjs
node --test tools/phase0/*.test.mjs
```
