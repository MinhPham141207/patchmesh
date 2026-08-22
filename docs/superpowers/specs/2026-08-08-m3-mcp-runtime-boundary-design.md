# M3 MCP Runtime Boundary Design

**Status:** Approved design
**Date:** 2026-08-08

## Goal

Implement the first Phase 1 runtime boundary as an in-process MCP proxy. The proxy
captures one normalized tool call's intent before execution and its actual outcome
after execution, then persists both events through the existing protocol validator and
SQLite event store.

M3 remains report-only. The proxy always allows execution after a request event has
been persisted and does not emit findings, decisions, or disruptive directives.

## Scope

In scope:

- A new `patchmesh-adapters` package containing an in-process `McpProxy`.
- Per-call runtime, repository, workspace, worktree, attribution, correlation, and
  source-sequence metadata.
- An injected tool executor with explicit success, failure, and interruption results.
- Durable `tool.requested` before execution and `tool.completed` after execution.
- Protocol validation and append-only SQLite persistence through public package APIs.
- Deterministic unit and temporary-database integration tests.
- M3 evidence documentation.

Out of scope:

- stdio, HTTP, WebSocket, or other MCP transport handling;
- filesystem, Git, content-hash, or process-effect observation, which is M4;
- graph projections, findings, policies, decisions, or CLI/daemon services;
- a second runtime adapter or generic gateway extraction;
- persistence of tool output, error text, credentials, or hidden model reasoning.

## Architecture

MCP-specific code belongs in `packages/adapters`, consistent with the repository rule
that runtime-specific behavior remains inside an adapter. The proxy depends on the
runtime-agnostic protocol types and the public `SqliteEventStore` interface. It does
not import detector, policy, graph, CLI, or transport code.

The proxy receives an executor and event-store dependency through its constructor.
Production callers may use the real SQLite store; tests can use a controlled store or
a temporary SQLite database. Event IDs and timestamps use injectable seams with
production defaults so causal relationships and ordering can be asserted exactly in
tests.

The chosen shape is intentionally adapter-only for M3. A generic gateway package may
be extracted when a second adapter or shared enforcement behavior justifies it; M3
does not add that abstraction prematurely.

## Public API Shape

The API is conceptually:

```ts
interface McpToolCall {
  toolName: ToolName;
  operation: string;
  targetResourceId: ResourceId | null;
  opaque: boolean;
}

interface McpCallContext {
  source: Source;
  repositoryId: RepositoryId;
  workspaceId: WorkspaceId;
  worktreeId: WorktreeId;
  agentId: NullableAgentId;
  taskId: NullableTaskId;
  correlationId: CorrelationId;
  causationId: EventId | null;
  requestSourceSequence: number | null;
  completionSourceSequence: number | null;
}

type ToolExecutionResult<T> =
  | { outcome: "succeeded"; value: T; exitCode: number | null }
  | { outcome: "failed"; error?: unknown; exitCode: number | null }
  | { outcome: "interrupted"; reason?: unknown; exitCode: number | null };

type ToolExecutor<T> = (signal: AbortSignal) => Promise<ToolExecutionResult<T>>;

interface McpProxyResult<T> {
  execution: ToolExecutionResult<T>;
  requestEventId: EventId;
  completedEventId: EventId;
}
```

The implementation will expose these names and preserve this behavior and type
information. The event context is supplied per call so one proxy instance can serve
multiple runtime contexts without hidden mutable attribution.

The protocol's closed `ToolName` union remains the source of truth. Arbitrary MCP
method names are represented by `operation`; M3 does not widen the protocol event
schema.

## Event Lifecycle

For each call:

1. Normalize and validate the call and context.
2. Create a `tool.requested` event using the supplied domain metadata, correlation ID,
   root or supplied causation ID, and request source sequence.
3. Append the request event. If this fails, do not invoke the executor.
4. Invoke the executor with an `AbortSignal`.
5. Classify an explicit result as `succeeded`, `failed`, or `interrupted`. An
   unexpected executor throw is converted to `failed`; an abort-related interruption
   is converted to `interrupted`.
6. Create a `tool.completed` event using the same domain and correlation metadata,
   `requestEventId` set to the request event ID, `causationId` set to the request event
   ID, and the completion source sequence.
7. Persist the completion event and return the execution result with both event IDs.

M3 completion events use an empty `effectEventIds` array. Effects are not inferred
from tool names or executor return values; verified effect events are an M4 concern.
The proxy does not retry persistence automatically.

## Error Handling

- Request persistence failure is fail-closed: execution does not start and the store
  error is returned to the caller.
- Executor failure is represented by a persisted failed completion event. Raw error
  objects and messages are returned only to the caller as appropriate and are never
  placed in event payloads.
- Executor interruption is represented by a persisted interrupted completion event.
- Completion persistence failure occurs after the real tool has run. The proxy throws
  a typed completion-storage error containing the request event ID and observed
  execution outcome, allowing callers to distinguish it from a pre-execution failure.
  The proxy does not claim that execution was rolled back or unexecuted.
- Protocol-invalid input is rejected before any event is appended or execution occurs.
- No event contains tool output, environment values, credentials, or hidden reasoning.

## Testing and Evidence

Tests will verify:

- successful execution persists exactly one request and one causally linked outcome;
- failed results and unexpected executor throws persist `failed` outcomes;
- explicit interruption and aborted signals persist `interrupted` outcomes;
- nullable agent and task attribution is accepted and preserved;
- source identity, correlation, causation, and both source sequences are preserved;
- request persistence failure prevents executor invocation;
- completion persistence failure reports that execution already occurred;
- malformed calls are rejected by the protocol boundary;
- events survive through a temporary SQLite database and remain readable after the
  proxy call completes.

The implementation will run package and workspace typechecking, builds, focused tests,
the existing Phase 0 validator and suite, and `git diff --check`. M3 evidence will
record the integration scenarios and explicitly state that transport handling, effect
observation, graph projection, and coordination policy remain unimplemented.

## Alternatives Considered

### Generic gateway package

A runtime-neutral gateway would be reusable, but M3 has only one adapter and no shared
policy or enforcement behavior. It adds an abstraction without a second consumer.

### Adapter plus gateway packages

Separating MCP normalization from a generic gateway best matches the eventual target
architecture, but creates two new public surfaces and wiring layers for this first
vertical slice. The split can be introduced when another adapter demonstrates the
shared contract.

### Selected approach

Use one MCP-specific in-process adapter package with injected executor and store. This
is the smallest coherent implementation that preserves the documented architectural
boundary and the M3 exit gates.
