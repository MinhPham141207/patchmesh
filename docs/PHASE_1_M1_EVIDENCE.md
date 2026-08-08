# PatchMesh M1 Evidence: Workspace and Protocol Round Trip

> **Status:** Complete. This record covers M1 only; M2-M7 remain planned.

## Verification Context

- Verification date: 2026-08-08
- Base repository revision: `67ee92b`
- Verification ran against the working tree containing the M1 implementation.
- Package manager: Corepack-provided pnpm `11.20.0` (the `pnpm` command is not
  installed as a standalone PATH shim on this machine).

## Commands and Results

| Command | Result |
| --- | --- |
| `corepack pnpm install` | Passed; workspace dependencies installed and lockfile was current. |
| `corepack pnpm typecheck` | Passed for `@patchmesh/protocol` and `@patchmesh/collector`. |
| `corepack pnpm build` | Passed for both workspace packages. |
| `corepack pnpm test` | Passed: 18 protocol tests and 3 collector tests, 21 total. |
| `node tools/phase0/validate.mjs` | Passed: `Phase 0 corpus valid`. |
| `node --test tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/diagnostics.test.mjs tools/phase0/corpus.test.mjs` | Passed: 47/47 Phase 0 tests. |
| `git diff --check` | Passed with no whitespace diagnostics. |

The Phase 0 suite remained green after the M1 implementation and documentation updates.

## M1 Coverage

The protocol package provides typed and boundary-validated representations for all
nine Phase 1 input events:

- `tool.requested`
- `tool.completed`
- `file.read`
- `file.changed`
- `symbol.read`
- `symbol.changed`
- `task.completed`
- `dependency.changed`
- `attribution.corrected`

The full closed V1 union also represents `finding.created`, `decision.created`,
`validity.changed`, and `decision.delivery.changed` structurally. M1 does not emit,
derive, or interpret those projection events.

The verified behavior includes:

- Ajv validation against the Phase 0 JSON Schemas;
- event/payload discrimination and unsupported schema-version rejection;
- required nullable `agentId` and `taskId` envelope fields;
- correlation, causation, source sequencing, and request/completion domain checks;
- succeeded, failed, and interrupted `tool.completed` outcomes;
- immutable attribution correction target validation;
- in-memory request/completion collection and defensive reads;
- atomic rejection without collector-state mutation.

## Deferred Scope

M1 does not implement MCP or another runtime adapter, filesystem/Git/process effect
observation, SQLite or migrations, idempotent storage, out-of-order buffering, replay,
graph projections, coverage reporting, detectors, findings or decisions, daemon
services, or CLI commands. Those remain M2-M7 work described by the Phase 1 milestones.
