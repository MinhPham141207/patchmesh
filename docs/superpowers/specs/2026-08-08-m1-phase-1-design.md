# M1 Phase 1 Workspace and Protocol Design

## Status

Approved design for implementation. M1 is limited to the TypeScript/pnpm workspace,
the runtime-agnostic protocol package, and an in-memory normalized-event collector.

## Goal

Establish the first executable PatchMesh boundary without pulling later Phase 1
milestones forward. The implementation will accept and validate normalized event
records, preserve the Phase 0 event contract, and demonstrate a request/outcome
round trip for one tool operation.

## Scope

The implementation includes:

- a strict TypeScript/pnpm workspace;
- `packages/protocol` with typed identities, event envelopes, discriminated payloads,
  and Phase 0 boundary validation;
- `packages/collector` with the smallest in-memory service surface needed to accept
  normalized events and read them back;
- executable tests for protocol validation and the `tool.requested`/
  `tool.completed` round trip;
- M1 evidence and current-status documentation.

The protocol types cover the full closed V1 envelope and payload union. The Phase 1
observation input subset is:

- `tool.requested`;
- `tool.completed`;
- `file.read`;
- `file.changed`;
- `symbol.read`;
- `symbol.changed`;
- `task.completed`;
- `dependency.changed`;
- `attribution.corrected`.

The remaining V1 projection event types remain structurally representable for protocol
compatibility, but M1 does not emit, derive, or interpret them. The event contract
remains closed: unsupported schema versions, event types, and payload shapes are
rejected.

## Non-Goals

This milestone does not implement:

- MCP or any other runtime adapter;
- filesystem, Git, process, or effect observation;
- SQLite, migrations, event persistence, idempotency, or replay buffering;
- work-graph projections, detectors, findings, or policy decisions;
- daemon services or CLI commands;
- Phase 2 behavior or enforcement directives.

Duplicate handling, out-of-order buffering, and durable replay are M2 concerns. M1
does not infer causality from timestamps or repair missing causal references.

## Architecture

The workspace has two real packages and no empty future-package shells:

```text
Phase 0 JSON Schemas
        |
        v
@patchmesh/protocol
        |
        v
@patchmesh/collector
```

The root workspace provides the package manager configuration, strict shared
TypeScript configuration, build/typecheck scripts, and test scripts. The protocol
package must not import the collector, adapters, gateway, storage, CLI, or any
runtime-specific integration. The collector depends only on the protocol package.

## Protocol Package

`packages/protocol` exposes:

- identity and envelope types;
- a discriminated union for the closed V1 event types, including all Phase 1 input
  events;
- payload types matching the Phase 0 event schemas;
- structural validation for unknown external values;
- event-set semantic validation for cross-event references and invariants;
- typed, sanitized validation diagnostics and errors.

The Phase 0 JSON Schemas remain the structural authority. Ajv and its format support
are used to load the existing schemas rather than duplicating their rules in a second
hand-written schema implementation. TypeScript unions provide compile-time usability,
while runtime validation remains mandatory at the external boundary.

Semantic validation covers the M1 requirements that structural JSON Schema cannot
express alone:

- event type and payload discrimination;
- required nullable `agentId` and `taskId` fields;
- causal-parent correlation and producer-sequence rules;
- `tool.completed` request identity and repository/workspace/worktree matching;
- attribution-correction target existence and repository/correlation matching;
- attribution corrections must supply an agent or task identity.

The protocol does not normalize away supplied identity, correlation, causation, or
sequence values. Accepted events preserve those values exactly.

## Collector Package

`packages/collector` exposes a small collector interface and an in-memory
implementation. Collection accepts unknown input, validates it through the protocol
boundary, and only then stores it. The implementation:

- keeps insertion order;
- stores immutable event values;
- returns defensive copies for reads;
- performs no runtime-specific routing or policy evaluation;
- does not claim durable storage or idempotent duplicate handling.

For M1, a valid `tool.requested` event is collected before its matching
`tool.completed` event. The completion preserves the request event ID and uses the
closed `outcome` vocabulary: `succeeded`, `failed`, or `interrupted`. A failed or
interrupted outcome is never converted into success.

Validation occurs before mutation. If an event is rejected, the collector state is
unchanged and the caller receives deterministic diagnostics without an echo of the
untrusted input.

## Data Flow

1. A caller passes an unknown value to the collector.
2. The protocol performs structural schema validation.
3. The protocol applies the applicable M1 event-set semantic checks.
4. The value is cloned and made immutable as a normalized event.
5. The collector appends the event in memory.
6. A read returns an equivalent defensive copy.

The round trip is demonstrated with `tool.requested` followed by `tool.completed`.
The fixture includes nullable task attribution and verifies that correlation,
causation, source identity, and source sequence survive the round trip.

## Error Handling

Validation failures use typed diagnostics with the existing Phase 0 contract codes,
including `PHASE0_SCHEMA_INVALID`, `PHASE0_SCHEMA_UNSUPPORTED`, and
`PHASE0_REFERENCE_MISSING` where applicable. Diagnostics contain safe paths and
messages only; they do not include raw event values, secrets, credentials, or full
environment data.

The collector is transaction-like for each append: validation completes before the
in-memory collection changes. M1 does not add recovery or persistence behavior.

## Testing and Verification

Protocol tests cover:

- acceptance of every Phase 1 input event type;
- structural representation of the remaining closed V1 projection event types;
- valid request and completion payloads;
- succeeded, failed, and interrupted outcomes;
- nullable agent and task attribution;
- event/payload mismatch and unsupported schema/type rejection;
- correlation, causation, source sequence, and domain preservation;
- missing or invalid attribution-correction targets;
- deterministic, sanitized diagnostics.

Collector tests cover:

- request/completion in-memory round trip with deep equality;
- immutable stored and returned events;
- rejected input leaving state unchanged;
- absence of runtime-specific behavior or imports.

The M1 verification set is:

- strict TypeScript typecheck;
- workspace build;
- protocol and collector tests;
- existing Phase 0 validator;
- `git diff --check`.

## Documentation and Evidence

Implementation will add an M1 evidence record containing the verification commands,
results, and explicit deferred-scope statement. `docs/PHASE_1_MILESTONES.md`,
`docs/ROADMAP.md`, and the relevant project status text will distinguish implemented
M1 behavior from planned M2-M7 behavior. No documentation will claim SQLite, MCP,
effect observation, replay, projections, daemon, or CLI support until those
milestones are implemented and verified.

## Acceptance Criteria

M1 is complete when:

- the strict pnpm workspace installs and typechecks;
- protocol types cover all nine Phase 1 input event types;
- valid events pass and malformed, unsupported, or mismatched events fail;
- `agentId` and `taskId` are always present and may be `null`;
- correlation, causation, source sequencing, and event payload discrimination are
  preserved;
- failed and interrupted tool outcomes use `tool.completed`;
- attribution corrections validate their target without mutating the target event;
- the in-memory request/completion round trip passes;
- rejected collection does not mutate state;
- Phase 0 validation remains passing;
- evidence and status documentation accurately describe M1 as implemented and later
  milestones as planned.
