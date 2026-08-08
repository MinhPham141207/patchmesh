# M1 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the strict TypeScript/pnpm workspace, runtime-agnostic V1 protocol boundary, and in-memory normalized-event collector required by M1.

**Architecture:** The Phase 0 JSON Schemas remain the structural authority. `@patchmesh/protocol` exposes strict TypeScript event unions, Ajv-backed structural validation, and event-set semantic validation; `@patchmesh/collector` depends only on that package and stores validated immutable events in memory. The implementation exercises `tool.requested` followed by `tool.completed` and does not implement adapters, storage, replay, effects, projections, daemon services, or CLI commands.

**Tech Stack:** TypeScript with strict mode, pnpm workspaces, Ajv plus `ajv-formats`, Node's built-in test runner through `tsx`, and the existing Phase 0 JSON Schemas and validator.

## Global Constraints

- Keep `packages/protocol` runtime-agnostic; it must not import collector, adapters, gateway, storage, CLI, or runtime-specific code.
- Keep `packages/collector` dependent only on `@patchmesh/protocol`.
- Preserve the Phase 0 closed V1 envelope and payload contracts; do not invent `tool.failed` or mutate event fields.
- Every event must retain `agentId` and `taskId` fields, and each may be `null`.
- Failed and interrupted operations are `tool.completed` events with `outcome: "failed"` or `outcome: "interrupted"`.
- Validate unknown external values before collection and do not include raw values, secrets, credentials, or environment data in diagnostics.
- Do not add SQLite, migrations, idempotency, out-of-order buffering, replay, MCP integration, effect observation, graph projections, findings, decisions, daemon services, or CLI commands.
- Use strict TypeScript and avoid `any`.
- Store immutable events and return defensive copies from the in-memory collector.
- Run strict typecheck, workspace build, protocol/collector tests, the Phase 0 validator, and `git diff --check` before declaring M1 complete.

---

## File Map

Create the workspace and package files:

- `package.json` - private root workspace metadata and verification scripts.
- `pnpm-workspace.yaml` - includes `packages/*`.
- `tsconfig.base.json` - shared strict compiler settings.
- `packages/protocol/package.json` - protocol package metadata and Ajv dependencies.
- `packages/protocol/tsconfig.json` - protocol build configuration.
- `packages/collector/package.json` - collector metadata and protocol workspace dependency.
- `packages/collector/tsconfig.json` - collector build configuration.

Create protocol implementation files:

- `packages/protocol/src/identities.ts` - shared identity and version-domain types.
- `packages/protocol/src/events.ts` - closed V1 envelope and payload discriminated unions.
- `packages/protocol/src/diagnostics.ts` - safe validation diagnostic and result/error types.
- `packages/protocol/src/validation.ts` - Ajv schema loading, structural validation, and event-set semantic validation.
- `packages/protocol/src/index.ts` - public protocol exports.
- `packages/protocol/test/fixtures.ts` - deterministic valid event builders used by protocol and collector tests.
- `packages/protocol/test/protocol.test.ts` - protocol acceptance, rejection, and semantic tests.

Create collector implementation files:

- `packages/collector/src/collector.ts` - collector interface and in-memory implementation.
- `packages/collector/src/index.ts` - public collector exports.
- `packages/collector/test/collector.test.ts` - round-trip, immutability, and atomic rejection tests.

Update documentation:

- `docs/PHASE_1_M1_EVIDENCE.md` - commands, results, and explicit M1 boundaries.
- `docs/PHASE_1_MILESTONES.md` - mark only M1 complete and link evidence.
- `docs/ROADMAP.md` - show M1 as the implemented Phase 1 milestone while keeping M2-M7 planned.
- `README.md` - replace the documentation-only status with the verified M1 status while preserving the planned status of later capabilities.

## Interfaces Defined Across Tasks

The following names and signatures are fixed for the plan:

```ts
export type ProtocolEvent = Phase1InputEvent | ProjectionEvent;

export type Phase1InputEvent =
  | ToolRequestedEvent
  | ToolCompletedEvent
  | FileReadEvent
  | FileChangedEvent
  | SymbolReadEvent
  | SymbolChangedEvent
  | TaskCompletedEvent
  | DependencyChangedEvent
  | AttributionCorrectedEvent;

export type ProjectionEvent =
  | FindingCreatedEvent
  | DecisionCreatedEvent
  | ValidityChangedEvent
  | DecisionDeliveryChangedEvent;

export interface ValidationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly value: T; readonly diagnostics: readonly [] }
  | { readonly value: null; readonly diagnostics: readonly ValidationDiagnostic[] };

export function parseEvent(input: unknown): ValidationResult<ProtocolEvent>;
export function validateEventSet(events: readonly ProtocolEvent[]): readonly ValidationDiagnostic[];

export interface EventCollector {
  collect(input: unknown): ProtocolEvent;
  read(): readonly ProtocolEvent[];
}

export class InMemoryEventCollector implements EventCollector {
  collect(input: unknown): ProtocolEvent;
  read(): readonly ProtocolEvent[];
}
```

`collect` throws a typed `ProtocolValidationError` containing sanitized diagnostics
when `parseEvent` or event-set validation fails. `read` returns defensive copies, so
callers cannot mutate collector state through a returned object.

---

### Task 1: Bootstrap Strict Workspace

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/collector/package.json`
- Create: `packages/collector/tsconfig.json`

**Interfaces:**

- Produces the workspace commands used by every later task: `pnpm typecheck`, `pnpm build`, and `pnpm test`.
- Produces package names `@patchmesh/protocol` and `@patchmesh/collector`.

- [ ] **Step 1: Write the workspace configuration**

Create a private root package with scripts that compile all packages, typecheck all
packages without emitting, and run compiled TypeScript tests through `tsx` during the
initial implementation. Configure `pnpm-workspace.yaml` with `packages/*`.

Use strict compiler settings in `tsconfig.base.json`, including `strict: true`,
`noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`,
`noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`, `module: "NodeNext"`,
`moduleResolution: "NodeNext"`, `target: "ES2022"`, and declaration output.

Use package scripts with these exact responsibilities:

```json
{
  "scripts": {
    "build": "pnpm --recursive build",
    "typecheck": "pnpm --recursive typecheck",
    "test": "pnpm --recursive test"
  }
}
```

Add `ajv`, `ajv-formats`, and `@types/node` where needed, `typescript` and `tsx` as
root development dependencies, and use a workspace dependency from collector to
protocol. Do not add a test framework beyond Node's built-in `node:test`.

- [ ] **Step 2: Add package compiler configurations**

Configure each package to extend `../../tsconfig.base.json`, use `src` as `rootDir`,
emit to `dist`, include `src/**/*.ts`, and exclude `dist` and test files from the
production build. Add package scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  }
}
```

Make the protocol package export `./dist/index.js` and its declarations. Make the
collector package export `./dist/index.js` and its declarations.

- [ ] **Step 3: Install and verify the empty workspace**

Run:

```text
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Expected: installation succeeds; typecheck and build report no source errors; tests
report zero test files or the equivalent successful no-test result. If the installed
pnpm version emits a lockfile, retain the generated `pnpm-lock.yaml` as workspace
dependency state.

---

### Task 2: Define Protocol Types and Diagnostics

**Files:**

- Create: `packages/protocol/src/identities.ts`
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/src/diagnostics.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/protocol.test.ts`

**Interfaces:**

- Consumes: strict workspace configuration from Task 1.
- Produces: `ProtocolEvent`, `Phase1InputEvent`, all closed V1 payload types, `ValidationDiagnostic`, `ValidationResult`, and `ProtocolValidationError` for Task 3 and Task 4.

- [ ] **Step 1: Write compile-time and fixture tests for the event union**

Create `packages/protocol/test/protocol.test.ts` with deterministic valid envelope
builders. Start with a helper that returns the common envelope fields and explicit
payloads rather than casting arbitrary objects:

```ts
const common = {
  schemaVersion: 1 as const,
  source: {
    kind: "gateway" as const,
    sourceId: "source_gateway",
    instanceId: "11111111-1111-4111-8111-111111111111"
  },
  timestamp: "2026-08-08T00:00:00.000Z",
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_22222222-2222-4222-8222-222222222222",
  worktreeId: "wt_33333333-3333-4333-8333-333333333333",
  agentId: "agent_a",
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0
};
```

Add tests that construct `tool.requested`, `tool.completed`, `file.read`,
`file.changed`, `symbol.read`, `symbol.changed`, `task.completed`,
`dependency.changed`, and `attribution.corrected` as typed values. Add a compile-time
assertion helper that accepts `ProtocolEvent` and call it for each event. Add typed
fixtures for all four remaining V1 projection event types so the closed union covers
the full Phase 0 envelope without adding projection behavior.

Run:

```text
pnpm --filter @patchmesh/protocol typecheck
```

Expected: FAIL before the types exist with missing-module or missing-export errors.

- [ ] **Step 2: Define identity and version-domain aliases**

In `identities.ts`, define named string aliases for the schema identities and explicit
interfaces for `Source`, `VersionDomain`, `LogicalResource`, and `ResourceVersion`.
Use unions for the schema enums:

```ts
export type AgentId = `agent_${string}`;
export type TaskId = `task_${string}`;
export type NullableAgentId = AgentId | null;
export type NullableTaskId = TaskId | null;
export type VersionKind =
  | "git_commit"
  | "git_blob"
  | "content_hash"
  | "symbol_signature"
  | "schema_version"
  | "api_version"
  | "deleted";
```

Keep aliases readable rather than attempting to encode every regular-expression
constraint in a template-literal type. Runtime Ajv validation remains authoritative.

- [ ] **Step 3: Define the common envelope and all payload unions**

In `events.ts`, define a `BaseEvent` interface with every required envelope property,
including `agentId: AgentId | null` and `taskId: TaskId | null`. Define one interface
per event type with a literal `eventType` and its matching payload. Use a discriminated
union so this code narrows without casts:

```ts
export interface ToolRequestedEvent extends BaseEvent {
  readonly eventType: "tool.requested";
  readonly payload: ToolRequestedPayload;
}

export interface ToolCompletedEvent extends BaseEvent {
  readonly eventType: "tool.completed";
  readonly payload: ToolCompletedPayload;
}

export type ProtocolEvent =
  | ToolRequestedEvent
  | ToolCompletedEvent
  | FileReadEvent
  | FileChangedEvent
  | SymbolReadEvent
  | SymbolChangedEvent
  | TaskCompletedEvent
  | DependencyChangedEvent
  | AttributionCorrectedEvent
  | FindingCreatedEvent
  | DecisionCreatedEvent
  | ValidityChangedEvent
  | DecisionDeliveryChangedEvent
  ;
```

The completed payload must use exactly `outcome: "succeeded" | "failed" |
"interrupted"`, nullable `exitCode`, a request event ID, and unique effect event IDs.
Do not define a `ToolFailedEvent`.

- [ ] **Step 4: Define diagnostics and validation result/error types**

In `diagnostics.ts`, define immutable diagnostics and a typed error:

```ts
export interface ValidationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class ProtocolValidationError extends Error {
  readonly diagnostics: readonly ValidationDiagnostic[];

  constructor(diagnostics: readonly ValidationDiagnostic[]) {
    super("PatchMesh protocol validation failed");
    this.name = "ProtocolValidationError";
    this.diagnostics = diagnostics;
  }
}
```

Add the `ValidationResult<T>` discriminated union from the interface section and
export all public types through `index.ts`.

- [ ] **Step 5: Run the typecheck and fixture tests**

Run:

```text
pnpm --filter @patchmesh/protocol typecheck
pnpm --filter @patchmesh/protocol test
```

Expected: typecheck passes; tests still fail only where `parseEvent` and
`validateEventSet` are not implemented. No test should rely on `as any` or suppress a
type error.

---

### Task 3: Implement Schema and Semantic Validation

**Files:**

- Create: `packages/protocol/src/validation.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/protocol.test.ts`

**Interfaces:**

- Consumes: event types and diagnostic types from Task 2; Phase 0 schemas under `schemas/phase0/v1/`.
- Produces: `parseEvent(input: unknown): ValidationResult<ProtocolEvent>` and `validateEventSet(events: readonly ProtocolEvent[]): readonly ValidationDiagnostic[]`.

- [ ] **Step 1: Add failing structural-validation tests**

Add tests for these exact behaviors:

```ts
test("accepts a valid tool request", () => {
  const result = parseEvent(makeToolRequested());
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.value?.eventType, "tool.requested");
});

test("rejects a payload for the wrong event type", () => {
  const result = parseEvent({
    ...makeToolRequested(),
    eventType: "tool.completed",
  });
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.code, "PHASE0_SCHEMA_INVALID");
});

test("rejects an unsupported schema version", () => {
  const result = parseEvent({ ...makeToolRequested(), schemaVersion: 2 });
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.code, "PHASE0_SCHEMA_UNSUPPORTED");
});

test("requires nullable attribution fields to be present", () => {
  const event = { ...makeToolRequested() } as Record<string, unknown>;
  delete event.taskId;
  const result = parseEvent(event);
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0]?.path, "/taskId");
});
```

Run:

```text
pnpm --filter @patchmesh/protocol test
```

Expected: FAIL because schema loading and `parseEvent` are not implemented.

- [ ] **Step 2: Load the existing Phase 0 schemas through Ajv**

In `validation.ts`, load the JSON documents from `schemas/phase0/v1/` relative to
`import.meta.url`, adding all referenced documents before compiling the event envelope:

```ts
const schemaNames = [
  "identities",
  "event-payloads",
  "event-envelope",
  "dependency",
  "coverage",
  "finding",
  "decision",
  "task-validity",
];
```

Include every schema referenced by the envelope's payload definitions. Configure Ajv
with `allErrors: true`, `strict: true`, and `allowUnionTypes: true`, then register
`ajv-formats` for `date-time` and `uuid`. Do not copy or modify the normative schema
documents. Keep schema-loading details private to the protocol package.

- [ ] **Step 3: Implement safe structural parsing**

Implement `parseEvent` with the following order:

1. Reject non-object, `null`, and array input with `PHASE0_SCHEMA_INVALID`.
2. Reject an object with `schemaVersion` other than `1` with
   `PHASE0_SCHEMA_UNSUPPORTED`.
3. Run the compiled event-envelope validator.
4. Convert Ajv errors into `{ code, path, message }` diagnostics without embedding
   invalid values.
5. Return a deep-cloned, deeply frozen `ProtocolEvent` on success.

The returned success result must have an empty diagnostics tuple. The failure result
must have `value: null` and at least one deterministic diagnostic.

- [ ] **Step 4: Add failing semantic event-set tests**

Add tests for the Phase 0 semantic invariants needed by M1:

- a completion must reference an existing `tool.requested` event;
- the completion request must share repository, workspace, worktree, and correlation;
- a non-null causal parent must exist and share correlation;
- a same-producer causal child must advance source sequence;
- an attribution correction target must exist in the same repository and correlation;
- an attribution correction cannot leave both corrected agent and task IDs null;
- source identity, source sequence, correlation, and causation values are preserved;
- failed and interrupted completion outcomes are accepted as `tool.completed`.

Use the existing fixture IDs and create a request/completion pair with completion
`causationId` equal to the request event ID. Assert exact diagnostic codes and paths,
not only that an exception occurred.

- [ ] **Step 5: Implement `validateEventSet`**

Build an event-ID map and apply deterministic checks without changing any event. Use
the Phase 0 diagnostic codes and paths. For `tool.completed`, require the referenced
event to be `tool.requested`, require matching repository/workspace/worktree and
correlation IDs, and require causation to be the request or a declared effect event.
For `attribution.corrected`, require a target in the same repository and correlation
and at least one non-null corrected identity. Check causal cycles, multiple roots for
one correlation, and duplicate source sequence values within one source instance.

Do not infer ordering from timestamps. Do not buffer or repair missing references.

- [ ] **Step 6: Run protocol tests and typecheck**

Run:

```text
pnpm --filter @patchmesh/protocol typecheck
pnpm --filter @patchmesh/protocol test
```

Expected: all protocol structural and semantic tests pass with no emitted diagnostics
for valid fixtures and deterministic diagnostics for invalid fixtures.

---

### Task 4: Implement the In-Memory Collector

**Files:**

- Create: `packages/collector/src/collector.ts`
- Create: `packages/collector/src/index.ts`
- Create: `packages/collector/test/collector.test.ts`

**Interfaces:**

- Consumes: `ProtocolEvent`, `parseEvent`, `validateEventSet`, and `ProtocolValidationError` from `@patchmesh/protocol`.
- Produces: `EventCollector` and `InMemoryEventCollector` for the M1 round trip.

- [ ] **Step 1: Write failing collector tests**

Add tests with the shared fixture builders:

```ts
test("round-trips a tool request and completion", () => {
  const collector = new InMemoryEventCollector();
  const request = makeToolRequested();
  const completion = makeToolCompleted(request);

  collector.collect(request);
  collector.collect(completion);

  assert.deepEqual(collector.read(), [request, completion]);
});

test("rejected input leaves state unchanged", () => {
  const collector = new InMemoryEventCollector();
  const request = makeToolRequested();
  collector.collect(request);

  assert.throws(
    () => collector.collect({ ...request, eventType: "tool.completed" }),
    ProtocolValidationError,
  );
  assert.deepEqual(collector.read(), [request]);
});

test("read results cannot mutate collector state", () => {
  const collector = new InMemoryEventCollector();
  collector.collect(makeToolRequested());
  const [event] = collector.read();
  assert.ok(event);
  assert.throws(() => {
    (event as { timestamp: string }).timestamp = "2026-08-09T00:00:00.000Z";
  }, TypeError);
  assert.equal(collector.read()[0]?.timestamp, "2026-08-08T00:00:00.000Z");
});
```

Run:

```text
pnpm --filter @patchmesh/collector test
```

Expected: FAIL because the collector package has no implementation.

- [ ] **Step 2: Implement the collector interface and atomic append**

Implement `InMemoryEventCollector` with a private `ProtocolEvent[]`. `collect` must:

1. call `parseEvent(input)`;
2. throw `ProtocolValidationError` when parsing fails;
3. validate the candidate event together with the current event list using
   `validateEventSet`;
4. throw `ProtocolValidationError` before changing the list if semantic validation
   fails;
5. append the already immutable normalized event and return it.

`read` must return a new array containing deep clones of the stored events. Keep
duplicate and out-of-order policy out of this class; M2 defines those semantics.

- [ ] **Step 3: Export the collector API**

Export `EventCollector` and `InMemoryEventCollector` from `packages/collector/src/index.ts`.
Use a package dependency on `@patchmesh/protocol`, not a relative import into the
protocol source directory.

- [ ] **Step 4: Run collector and workspace checks**

Run:

```text
pnpm --filter @patchmesh/collector typecheck
pnpm --filter @patchmesh/collector test
pnpm typecheck
pnpm build
pnpm test
```

Expected: all collector, protocol, and workspace checks pass. The invalid append
test must prove that collection is unchanged after a failed validation.

---

### Task 5: Record M1 Evidence and Update Status Documentation

**Files:**

- Create: `docs/PHASE_1_M1_EVIDENCE.md`
- Modify: `docs/PHASE_1_MILESTONES.md`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: verified workspace, protocol, collector, and Phase 0 commands from Tasks 1-4.
- Produces: an accurate current-status record distinguishing M1 implementation from planned M2-M7 behavior.

- [ ] **Step 1: Run the complete verification set before editing status text**

Run:

```text
pnpm install
pnpm typecheck
pnpm build
pnpm test
node tools/phase0/validate.mjs
git diff --check
```

Record the actual command output counts and validator result. Do not write claims based
on expected output.

- [ ] **Step 2: Write M1 evidence**

Create `docs/PHASE_1_M1_EVIDENCE.md` with:

- verification date and repository revision;
- exact commands run and observed results;
- protocol coverage for the nine Phase 1 input events and the full closed V1 union;
- request/completion round-trip evidence, including failed/interrupted outcomes;
- rejection and immutability evidence;
- explicit statement that M2+ behavior is not implemented;
- no performance or runtime-adapter claims.

Keep the evidence factual and avoid including machine-specific secrets, full paths, or
unbounded environment data.

- [ ] **Step 3: Mark M1 complete without marking Phase 1 complete**

In `docs/PHASE_1_MILESTONES.md`, change only the milestone status needed to identify
M1 as complete, link the M1 evidence, and retain M2-M7 as planned. Preserve the existing
closed event set and deferred-scope language.

In `docs/ROADMAP.md`, identify M1 as the completed first implementation slice while
leaving the overall Phase 1 exit gates and later milestones unmet/planned.

- [ ] **Step 4: Update README current status**

Change the README status so it no longer says the repository has no implementation.
State that the verified M1 workspace/protocol/in-memory collector exists, while SQLite,
MCP, effect observation, replay, graph projections, CLI, and detection remain planned.
Do not rewrite the product vision or claim the first working slice is complete.

- [ ] **Step 5: Run documentation and final verification checks**

Run:

```text
node tools/phase0/validate.mjs
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

Expected: Phase 0 prints `Phase 0 corpus valid`; all TypeScript checks and tests pass;
the final diff has no whitespace errors; documentation accurately distinguishes M1
from M2-M7.

---

## Final Review Checklist

- [ ] `packages/protocol` has no runtime-specific imports.
- [ ] `packages/collector` imports protocol through its package name only.
- [ ] All nine Phase 1 input event types and all remaining closed V1 projection event types are represented.
- [ ] `tool.failed` does not exist.
- [ ] `tool.completed` accepts `succeeded`, `failed`, and `interrupted` outcomes.
- [ ] `agentId` and `taskId` are present on every envelope type and nullable.
- [ ] Payload/event mismatches fail at the boundary.
- [ ] Attribution correction validates its target and never mutates the target event.
- [ ] Invalid collection leaves the in-memory state unchanged.
- [ ] Stored events are immutable and reads are defensive copies.
- [ ] No SQLite, MCP, observation, replay, projection, detector, decision, daemon, or CLI implementation entered the M1 diff.
- [ ] Phase 0 validator, strict typecheck, build, tests, and `git diff --check` pass.
- [ ] Evidence and status documentation contain observed results rather than planned claims.
