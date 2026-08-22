# M3 MCP Runtime Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process MCP adapter that durably records `tool.requested` before execution and `tool.completed` after execution through the existing protocol and SQLite store.

**Architecture:** Create a new `patchmesh-adapters` package containing the MCP-specific `McpProxy`. It accepts per-call metadata, an injected executor, and an event appender satisfied by `SqliteEventStore`; it has no detector, policy, transport, effect-observation, or graph responsibilities. Request persistence is fail-closed, while post-execution persistence failures identify that execution already occurred.

**Tech Stack:** Strict TypeScript, pnpm workspace, Node `node:test` through `tsx`, `patchmesh-protocol`, `patchmesh-storage`, Node `crypto.randomUUID`, and temporary SQLite databases.

## Global Constraints

- Use the closed Phase 1 `ToolName` union; represent an arbitrary MCP operation in the `operation` string and do not widen the protocol schema.
- Supply repository, workspace, worktree, attribution, source, correlation, causation, and source-sequence metadata per call; do not hide mutable attribution in the proxy instance.
- Persist `tool.requested` before invoking the executor and `tool.completed` after it returns or is interrupted.
- If request persistence fails, do not invoke the executor.
- Preserve the same correlation ID for request and completion; set completion `causationId` and `requestEventId` to the persisted request event ID.
- Represent failure and interruption as `tool.completed` outcomes; do not invent `tool.failed` or `tool.interrupted` event types.
- Use an empty `effectEventIds` array in M3; filesystem, Git, process, and content effects belong to M4.
- Do not persist tool output, raw error messages, credentials, environment values, or hidden model reasoning.
- Treat completion persistence failure as post-execution storage failure; never claim execution was rolled back or skipped.
- Keep the adapter report-only and allow-only; do not emit findings, decisions, directives, graph projections, or detector output.
- Keep `patchmesh-adapters` dependent only on `patchmesh-protocol` and `patchmesh-storage`; do not add transport or runtime-framework dependencies.
- Use strict TypeScript with no `any`; preserve `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` compatibility.
- Run focused adapter tests, adapter typecheck/build, the full workspace test/typecheck/build suites, the Phase 0 validator and suite, and `git diff --check` before declaring M3 complete.

---

## File Map

Create the adapter package:

- `packages/adapters/package.json` - package metadata, scripts, and workspace dependencies.
- `packages/adapters/tsconfig.json` - strict package compiler configuration.
- `packages/adapters/src/types.ts` - MCP call, context, executor, result, appender, and option contracts.
- `packages/adapters/src/errors.ts` - typed request/completion persistence errors.
- `packages/adapters/src/mcp-proxy.ts` - event construction, validation, execution wrapping, and persistence lifecycle.
- `packages/adapters/src/index.ts` - public adapter exports.
- `packages/adapters/test/mcp-proxy.test.ts` - unit and temporary-SQLite integration scenarios.

Update current-behavior documentation:

- `docs/implementation/phase1/evidence/PHASE_1_M3_EVIDENCE.md` - M3 commands, scenarios, results, and exclusions.
- `docs/implementation/phase1/PHASE_1_MILESTONES.md` - mark only M3 complete and link its evidence.
- `docs/ROADMAP.md` - identify M3 as implemented while leaving M4-M7 planned.
- `README.md` - include the in-process MCP boundary in the current M1-M3 slice and keep transport/effects/projections planned.
- `docs/ARCHITECTURE.md` - describe the implemented M3 adapter boundary without marking later target components implemented.

## Interfaces Defined Across Tasks

The following names and signatures are fixed for the plan:

```ts
import type {
  AppendResult,
} from "patchmesh-storage";
import type {
  CorrelationId,
  EventId,
  NullableAgentId,
  NullableTaskId,
  RepositoryId,
  ResourceId,
  Source,
  ToolName,
  WorkspaceId,
  WorktreeId,
} from "patchmesh-protocol";

export interface McpToolCall {
  readonly toolName: ToolName;
  readonly operation: string;
  readonly targetResourceId: ResourceId | null;
  readonly opaque: boolean;
}

export interface McpCallContext {
  readonly source: Source;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly agentId: NullableAgentId;
  readonly taskId: NullableTaskId;
  readonly correlationId: CorrelationId;
  readonly causationId: EventId | null;
  readonly requestSourceSequence: number | null;
  readonly completionSourceSequence: number | null;
}

export type ToolExecutionResult<T> =
  | { readonly outcome: "succeeded"; readonly value: T; readonly exitCode: number | null }
  | { readonly outcome: "failed"; readonly error?: unknown; readonly exitCode: number | null }
  | { readonly outcome: "interrupted"; readonly reason?: unknown; readonly exitCode: number | null };

export type ToolExecutor<T> = (signal: AbortSignal) => Promise<ToolExecutionResult<T>>;

export interface EventAppender {
  append(input: unknown): AppendResult;
}

export interface McpProxyOptions {
  readonly eventStore: EventAppender;
  readonly createEventId?: () => EventId;
  readonly now?: () => string;
}

export interface McpProxyResult<T> {
  readonly execution: ToolExecutionResult<T>;
  readonly requestEventId: EventId;
  readonly completedEventId: EventId;
}

export class McpProxy {
  constructor(options: McpProxyOptions);
  execute<T>(
    call: McpToolCall,
    context: McpCallContext,
    executor: ToolExecutor<T>,
    signal?: AbortSignal,
  ): Promise<McpProxyResult<T>>;
}
```

`SqliteEventStore` satisfies `EventAppender` structurally. The optional signal lets a
caller cancel an in-flight operation; when omitted, `McpProxy` passes a fresh
non-aborted signal to the executor. `createEventId` defaults to `evt_${randomUUID()}`
and `now` defaults to `new Date().toISOString()`.

`McpProxyStorageError` is also public:

```ts
export class McpProxyStorageError extends Error {
  readonly code: "MCP_REQUEST_PERSIST_FAILED" | "MCP_COMPLETION_PERSIST_FAILED";
  readonly phase: "request" | "completion";
  readonly requestEventId: EventId | null;
  readonly executionOutcome: "succeeded" | "failed" | "interrupted" | null;
  constructor(
    code: "MCP_REQUEST_PERSIST_FAILED" | "MCP_COMPLETION_PERSIST_FAILED",
    phase: "request" | "completion",
    requestEventId: EventId | null,
    executionOutcome: "succeeded" | "failed" | "interrupted" | null,
    options?: ErrorOptions,
  );
}
```

For request failure, `phase` is `"request"`, `requestEventId` and
`executionOutcome` are `null`, and the executor has not run. For completion failure,
`phase` is `"completion"`, `requestEventId` is populated, and `executionOutcome`
identifies the already-observed result.

---

### Task 1: Bootstrap Adapter Package and Public Contracts

**Files:**

- Create: `packages/adapters/package.json`
- Create: `packages/adapters/tsconfig.json`
- Create: `packages/adapters/src/types.ts`
- Create: `packages/adapters/src/errors.ts`
- Create: `packages/adapters/src/mcp-proxy.ts`
- Create: `packages/adapters/src/index.ts`
- Create: `packages/adapters/test/mcp-proxy.test.ts`

**Interfaces:**

- Consumes: existing workspace compiler settings, `patchmesh-protocol` identities/types, and `patchmesh-storage` append types.
- Produces: the fixed public contracts above and a constructible `McpProxy` shell for Tasks 2 and 3.

- [ ] **Step 1: Write the public-contract compile test**

Create `packages/adapters/test/mcp-proxy.test.ts` with typed metadata and a typed
executor. The test should import the future exports and assert the return shape in a
small helper, so incorrect public names fail typecheck rather than being hidden by
structural inference:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpProxy, type EventAppender, type McpCallContext, type McpToolCall } from "../src/index.js";

test("exposes the M3 proxy contract", async () => {
  const events: unknown[] = [];
  const eventStore: EventAppender = {
    append(input) {
      events.push(input);
      return { status: "inserted", event: input as never };
    },
  };
  const call: McpToolCall = {
    toolName: "read_file",
    operation: "read_file",
    targetResourceId: null,
    opaque: false,
  };
  const context: McpCallContext = {
    source: { kind: "adapter", sourceId: "mcp", instanceId: "instance-1" },
    repositoryId: "repo_demo",
    workspaceId: "ws_demo",
    worktreeId: "wt_demo",
    agentId: null,
    taskId: null,
    correlationId: "corr_call",
    causationId: null,
    requestSourceSequence: 1,
    completionSourceSequence: 2,
  };

  const result = await new McpProxy({ eventStore }).execute(
    call,
    context,
    async () => ({ outcome: "succeeded", value: "ok", exitCode: 0 }),
  );

  assert.equal(result.execution.outcome, "succeeded");
  assert.equal(events.length, 2);
});
```

The temporary `as never` is only a compile-test stub for the appender's event return;
replace it with a real typed fake as soon as the implementation exists. Do not use
`any`.

- [ ] **Step 2: Add package metadata and compiler configuration**

Create `packages/adapters/package.json` with package name `patchmesh-adapters`,
version `0.1.0`, private package metadata, ESM mode, `dist` exports, and these
scripts:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsx --test test/**/*.test.ts"
  }
}
```

Declare `patchmesh-protocol` and `patchmesh-storage` as `workspace:*` dependencies.
Extend `../../tsconfig.base.json`, use `src` as `rootDir`, emit declarations and source
maps to `dist`, and exclude `dist` and tests from production output.

- [ ] **Step 3: Define the public types and storage error**

Implement `src/types.ts` with the exact interfaces in the cross-task contract. Import
identity types with `import type`; do not duplicate branded ID aliases. Define
`EventAppender` against the storage package's exported `AppendResult` so
`SqliteEventStore` is assignable without an adapter wrapper.

Implement `McpProxyStorageError` in `src/errors.ts` with a stable message that names
only the phase and request ID, not the underlying error text. Pass the original storage
error through `ErrorOptions.cause`; it is diagnostic-only and must not be enumerable
event data.

- [ ] **Step 4: Add the minimal proxy shell and exports**

Create `src/mcp-proxy.ts` with the constructor and `execute` signature. Store the
options privately, create default ID/time functions, and throw a short internal error
from `execute` until Task 2 replaces it. Export all public types, `McpProxy`, and
`McpProxyStorageError` from `src/index.ts`.

- [ ] **Step 5: Run the package typecheck**

Build the dependency packages first, then run:

```text
corepack pnpm --filter patchmesh-protocol build
corepack pnpm --filter patchmesh-storage build
corepack pnpm --filter patchmesh-adapters typecheck
```

Expected: the new package typechecks; the contract test is still expected to fail at
runtime because the proxy shell has no event lifecycle yet.

- [ ] **Step 6: Commit the package contract**

```text
git add packages/adapters
git commit -m "feat: bootstrap MCP adapter package"
```

---

### Task 2: Persist Request and Successful Completion Events

**Files:**

- Modify: `packages/adapters/src/mcp-proxy.ts`
- Modify: `packages/adapters/test/mcp-proxy.test.ts`

**Interfaces:**

- Consumes: `McpToolCall`, `McpCallContext`, `ToolExecutor`, `EventAppender`, and `McpProxyOptions` from Task 1; `parseEvent` and event types from `patchmesh-protocol`.
- Produces: a working `McpProxy.execute` happy path that appends validated request and completion events and returns both event IDs.

- [ ] **Step 1: Replace the compile stub with a successful SQLite integration test**

Add a `withTemporaryDatabase` helper using `mkdtempSync`, `join`, `tmpdir`, and
`rmSync` in `finally`. Open `SqliteEventStore` and pass it to `McpProxy`. Inject a
deterministic ID queue and clock:

```ts
const ids = ["evt_request", "evt_completed"];
const proxy = new McpProxy({
  eventStore: store,
  createEventId: () => ids.shift() ?? "evt_unexpected",
  now: () => "2026-08-08T00:00:00.000Z",
});
const result = await proxy.execute(call, context, async (signal) => {
  assert.equal(signal.aborted, false);
  return { outcome: "succeeded", value: { ok: true }, exitCode: 0 };
});

assert.deepEqual(result.requestEventId, "evt_request");
assert.deepEqual(result.completedEventId, "evt_completed");
const events = store.read();
assert.deepEqual(events.map((event) => event.eventType), ["tool.requested", "tool.completed"]);
```

Assert the request payload exactly contains the normalized tool fields, the request
uses the context metadata and request source sequence, and the completion contains
`requestEventId: "evt_request"`, `causationId: "evt_request"`, outcome `succeeded`,
exit code `0`, and `effectEventIds: []`.

Run:

```text
corepack pnpm --filter patchmesh-adapters test
```

Expected: FAIL because `execute` still throws its shell error.

- [ ] **Step 2: Implement deterministic event construction**

In `mcp-proxy.ts`, add focused helpers that construct `ToolRequestedEvent` and
`ToolCompletedEvent` from the call, context, and injected ID/time functions. Use
`schemaVersion: 1`, the exact event types, the same source/domain/correlation values,
the request source sequence for the request event, and the completion source sequence
for the completion event. Set request `causationId` to `context.causationId`; set
completion `causationId` to the request event ID.

Do not put executor values into event payloads. Always set completion
`effectEventIds` to an empty array.

- [ ] **Step 3: Validate before appending**

Add an `appendValidated` helper that passes the constructed event to `parseEvent` and
throws `ProtocolValidationError` when parsing returns no value, then calls the
injected `EventAppender.append`. Use the event returned by `AppendResult` as the
canonical stored event, because duplicate appends return the already-stored bytes.

The request must be validated and appended before `executor` is invoked. The
completion must be validated and appended after the executor result is available.

- [ ] **Step 4: Implement the successful execution path**

Create an `AbortController` only when the optional caller signal is omitted; otherwise
pass the supplied signal directly to the executor. Append the request, call the
executor, construct a successful completion, append it, and return:

```ts
{
  execution,
  requestEventId: requestEvent.eventId,
  completedEventId: completedEvent.eventId,
}
```

Use the returned stored request event ID when constructing completion causation. Do not
introduce policy checks or directives between append and execution.

- [ ] **Step 5: Run the happy-path test and typecheck**

```text
corepack pnpm --filter patchmesh-adapters test
corepack pnpm --filter patchmesh-adapters typecheck
```

Expected: the temporary-SQLite happy-path test passes and the package typecheck passes.

- [ ] **Step 6: Commit the request/completion lifecycle**

```text
git add packages/adapters/src/mcp-proxy.ts packages/adapters/test/mcp-proxy.test.ts
git commit -m "feat: persist MCP tool lifecycle events"
```

---

### Task 3: Normalize Failures, Interruptions, and Storage Errors

**Files:**

- Modify: `packages/adapters/src/mcp-proxy.ts`
- Modify: `packages/adapters/src/errors.ts`
- Modify: `packages/adapters/test/mcp-proxy.test.ts`

**Interfaces:**

- Consumes: the successful lifecycle from Task 2 and `McpProxyStorageError` from Task 1.
- Produces: persisted failed/interrupted outcomes, fail-closed request handling, and typed completion-storage diagnostics.

- [ ] **Step 1: Add failing outcome tests**

Add tests using the temporary SQLite helper for:

```ts
test("persists an explicit failed result", async () => {
  const result = await proxy.execute(call, context, async () => ({
    outcome: "failed",
    error: new Error("must not be persisted"),
    exitCode: 7,
  }));

  assert.equal(result.execution.outcome, "failed");
  assert.equal(store.read()[1]?.payload.outcome, "failed");
  assert.equal(store.read()[1]?.payload.exitCode, 7);
});

test("persists an interrupted result and propagates an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await proxy.execute(
    call,
    context,
    async (signal) => {
      assert.equal(signal.aborted, true);
      return { outcome: "interrupted", reason: "cancelled", exitCode: null };
    },
    controller.signal,
  );

  assert.equal(result.execution.outcome, "interrupted");
  assert.equal(store.read()[1]?.payload.outcome, "interrupted");
});
```

Also add a test where the executor throws an `Error`; assert that `execute` resolves
with a `failed` execution result, persists the completion, and places neither the error
object nor its message in either stored event.

Run:

```text
corepack pnpm --filter patchmesh-adapters test
```

Expected: FAIL until result normalization and exception handling are implemented.

- [ ] **Step 2: Normalize explicit results and unexpected throws**

Wrap executor invocation in `try/catch`. Return explicit `ToolExecutionResult` values
unchanged. If the executor throws while the supplied signal is aborted or the thrown
value has `name === "AbortError"`, create an interrupted result with `exitCode: null`.
Otherwise create a failed result with `error` set only on the returned in-memory result
and `exitCode: null`.

The completion event builder must read only `outcome` and `exitCode`; it must never
serialize `error` or `reason`.

- [ ] **Step 3: Implement typed request-store failure**

Catch append failure for the request, wrap it as:

```ts
new McpProxyStorageError("MCP_REQUEST_PERSIST_FAILED", "request", null, null, { cause: error })
```

and rethrow before invoking the executor. Use the class fields from the cross-task
contract rather than exposing arbitrary storage diagnostics in the public message.

- [ ] **Step 4: Implement typed completion-store failure**

Catch append failure for the completion and throw:

```ts
new McpProxyStorageError(
  "MCP_COMPLETION_PERSIST_FAILED",
  "completion",
  requestEvent.eventId,
  execution.outcome,
  { cause: error },
)
```

The error must make clear that execution already occurred. Do not retry, append a
second completion, or convert a persistence failure into a successful proxy result.

- [ ] **Step 5: Add fail-closed and completion-failure tests with a fake appender**

Use a typed `EventAppender` fake that throws on the first append and assert the
executor's `called` flag remains false. Use another fake that delegates the first
append to a real event fixture or returns the request event, then throws on the second
append. Assert the second error is `McpProxyStorageError` with:

```ts
assert.equal(error.phase, "completion");
assert.equal(error.requestEventId, "evt_request");
assert.equal(error.executionOutcome, "succeeded");
```

Do not assert or log raw error messages from the fake store.

- [ ] **Step 6: Run focused tests and typecheck**

```text
corepack pnpm --filter patchmesh-adapters test
corepack pnpm --filter patchmesh-adapters typecheck
```

Expected: all success, failure, interruption, request-failure, completion-failure,
and no-secret-persistence tests pass.

- [ ] **Step 7: Commit outcome and error handling**

```text
git add packages/adapters/src packages/adapters/test/mcp-proxy.test.ts
git commit -m "feat: handle MCP proxy outcomes and persistence errors"
```

---

### Task 4: Complete Boundary Coverage and M3 Evidence

**Files:**

- Modify: `packages/adapters/test/mcp-proxy.test.ts`
- Create: `docs/implementation/phase1/evidence/PHASE_1_M3_EVIDENCE.md`
- Modify: `docs/implementation/phase1/PHASE_1_MILESTONES.md`
- Modify: `docs/ROADMAP.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**

- Consumes: the complete `McpProxy` implementation and test helpers from Tasks 1-3.
- Produces: recorded M3 exit evidence and documentation that distinguishes implemented adapter behavior from planned M4-M7 behavior.

- [ ] **Step 1: Add metadata and validation coverage**

Add tests that assert:

- `agentId: null` and `taskId: null` survive both events;
- non-null `agentId` and `taskId` survive both events;
- request and completion preserve `source`, repository/workspace/worktree IDs,
  correlation ID, request/completion source sequences, and supplied request causation;
- malformed runtime input is rejected before the appender or executor is called;
- completion causation points to the stored request event, not the caller's parent
  causation ID;
- one proxy can execute two calls with different per-call contexts without metadata
  leaking between calls;
- the stored event list contains only `tool.requested` and `tool.completed`, with no
  findings, decisions, directives, or effect events.

Use explicit assertions over snapshots. Run:

```text
corepack pnpm --filter patchmesh-adapters test
```

Expected: all M3 adapter tests pass.

- [ ] **Step 2: Record M3 evidence**

Create `PHASE_1_M3_EVIDENCE.md` with:

- status and date;
- implementation files and public surface;
- the exact test, typecheck, build, validator, and suite commands run;
- observed results and test counts;
- successful, failed, interrupted, nullable-attribution, request-failure, and
  completion-failure scenarios;
- confirmation that request persistence precedes execution and completion causation
  references the request;
- explicit exclusions for MCP transports, effect observation, graph projection,
  detectors, policies, decisions, and enforcement;
- residual risk that an in-process proxy does not intercept operations that bypass it.

Do not claim filesystem or shell observability in this evidence.

- [ ] **Step 3: Mark only M3 current in milestone documentation**

In `docs/implementation/phase1/PHASE_1_MILESTONES.md`, change the status line to list
M3 as complete, add an M3 status/link near M1 and M2, and preserve M4-M7 as planned.
Do not alter the M4 scope or exit gates.

- [ ] **Step 4: Reconcile roadmap and architecture status**

In `docs/ROADMAP.md`, add an M3 status line linking the evidence and retain M4-M7 as
planned. In `docs/ARCHITECTURE.md`, state that M3 now implements the in-process
MCP-specific adapter boundary and request/outcome persistence, while transport handling,
effect observers, projections, detectors, policies, daemon, and CLI remain planned.
Do not rewrite target architecture diagrams as if later components exist.

- [ ] **Step 5: Update the README current-slice language**

Change the status text from “M1 and M2 are implemented” to “M1 through M3 are
implemented and verified,” list the in-process MCP adapter and request/outcome event
round trip in the current slice, and keep transports, effect observation, projections,
daemon, CLI, and detection in the planned list.

- [ ] **Step 6: Commit M3 evidence and docs**

```text
git add packages/adapters/test/mcp-proxy.test.ts docs/implementation/phase1/evidence/PHASE_1_M3_EVIDENCE.md docs/implementation/phase1/PHASE_1_MILESTONES.md docs/ROADMAP.md README.md docs/ARCHITECTURE.md
git commit -m "docs: record M3 MCP boundary evidence"
```

---

### Task 5: Run Full Verification and Review the Diff

**Files:**

- Verify: all files created or modified by Tasks 1-4.

**Interfaces:**

- Consumes: the complete M3 adapter and evidence documentation.
- Produces: verified workspace state with no unrelated changes and a final implementation summary.

- [ ] **Step 1: Run focused adapter verification**

```text
corepack pnpm --filter patchmesh-adapters test
corepack pnpm --filter patchmesh-adapters typecheck
corepack pnpm --filter patchmesh-adapters build
```

Expected: all adapter tests pass and package typecheck/build complete without errors.

- [ ] **Step 2: Run the existing package suites**

```text
corepack pnpm --recursive test
corepack pnpm --recursive typecheck
corepack pnpm --recursive build
```

Expected: protocol, collector, storage, and adapters suites pass; every workspace
package typechecks and builds.

- [ ] **Step 3: Run Phase 0 validation and tests**

```text
node tools/phase0/validate.mjs
node --test tools/phase0/tests/*.test.mjs
```

Expected: the validator reports `Phase 0 corpus valid` and the Phase 0 suite passes
without any contract changes.

- [ ] **Step 4: Check the diff and repository status**

```text
git diff --check
git status --short
git diff --stat
```

Confirm there are no secrets, generated `dist` files, unrelated modifications, new
dependencies beyond the two workspace packages, transport implementations, policy
logic, or effect-observation claims.

- [ ] **Step 5: Record final verification**

Update the M3 evidence document with the actual command outputs and counts only after
the commands pass. If a command fails, fix the implementation or document the blocker;
do not mark M3 complete with a hidden failing check.

- [ ] **Step 6: Commit final verification evidence**

```text
git add docs/implementation/phase1/evidence/PHASE_1_M3_EVIDENCE.md
git commit -m "docs: finalize M3 verification evidence"
```
