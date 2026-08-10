# M7 Production Host Adapter Boundary

## Status

The PatchMesh repository provides the MCP proxy, observation boundary, event
persistence, and evidence recorder bridge. It does not provide a production host
adapter that invokes the proxy for real agent tool calls. M7 real-agent
verification is blocked at that external boundary.

This document is a contract for an external adapter. It is not an implementation
of a new runtime, hook mechanism, or callsite.

## Existing PatchMesh Path

The adapter must use the existing public types and path:

```ts
const store = SqliteEventStore.open(databasePath);
const proxy = new McpProxy({
  eventStore: store,
  observer: new NodeObservationBoundary({ source: watcherSource }),
  phase2SourceAnalysis: analysisOptions,
});

const result = await proxy.execute(
  call,
  context,
  executor,
  signal,
);
```

The exact proxy signature is:

```ts
execute<T>(
  call: McpToolCall,
  context: McpCallContext,
  executor: ToolExecutor<T>,
  signal?: AbortSignal,
): Promise<McpProxyResult<T>>
```

The executor signature is:

```ts
type ToolExecutor<T> =
  (signal: AbortSignal) => Promise<ToolExecutionResult<T>>;
```

The adapter must supply real values for `McpToolCall`, `McpCallContext`, the
workspace root, agent/task/worktree attribution, correlation ID, and source
sequences. It must not invent effect paths or resource versions.

## Required Post-Tool Handoff

After `await proxy.execute(...)` returns, the adapter must read the persisted
events from the same event store:

1. Locate `result.completedEventId`.
2. Read that `tool.completed` event.
3. Read only the events listed in its
   `payload.effectEventIds`.
4. Retain only persisted `file.changed` events for the evidence effect payload.
5. Pass the exact `McpProxyResult` and those persisted events to the evidence
   recorder bridge.

The bridge input is:

```json
{
  "action": "tool.completed",
  "agentId": "agent-id-or-null",
  "taskId": "task-id-or-null",
  "worktreeId": "worktree-id-or-null",
  "toolCallId": "runtime-tool-call-id-or-null",
  "patchmesh": {
    "result": "the returned McpProxyResult",
    "events": [
      "the persisted tool.completed event",
      "its persisted file.changed effect events"
    ]
  }
}
```

The bridge is integrated at `tools/evidence/record.mjs:21` and implemented by
`tools/evidence/lib/patchmesh-bridge.mjs`.

## Effect Authority Rules

- `derivedEffect.changedPaths` may contain only locators from persisted,
  completion-linked `file.changed` events.
- Requested hook paths, `tool_input`, command strings, and tool responses are
  never effect evidence.
- `coverage.presentation === "sufficient"` maps to `derivedEffect.status:
  "verified"`.
- `coverage.presentation === "degraded"` maps to `derivedEffect.status:
  "degraded"` and preserves every gap.
- Missing completion or effect events maps to `derivedEffect.status:
  "unknown"` with an explicit gap.
- Failed, interrupted, opaque, bypassed, mismatched, out-of-band, or otherwise
  incomplete observations cannot be promoted to verified effects.
- Evidence recorder failure must not block or alter the underlying tool result.

## Required M7 Verification

The external adapter unlocks M7 real-agent verification only after it produces
real traces that satisfy all of the following:

- parent and subagent run IDs plus task/worktree attribution are present;
- the PatchMesh SQLite event log contains the corresponding request, completion,
  and actual file-change events;
- the trace validates with `corepack pnpm evidence:validate`;
- at least one tool completion has non-empty, completion-linked observed changes;
- verified coverage is backed by the actual `McpProxyResult` and persisted events;
- replay and event digests are recorded;
- a human reviewer assigns the detector scenario label, expected finding,
  coverage classification, reviewer ID, review time, and holdout membership;
- only reviewed real-agent cases enter the M7 field corpus.

The current committed `.evidence` traces do not satisfy the effect requirement:
they are valid attribution traces with zero verified effects. They must not be
reclassified or used as detector positives or negatives.

## Current Repository Boundary

No production host adapter currently calls `McpProxy.execute`. Existing callsites
are tests, Phase 1/2 golden harnesses, and the benchmark. The missing external
component is therefore the runtime-specific owner of actual tool execution that
can perform the post-tool handoff above.

Until that adapter exists, M7 remains blocked. No synthetic runtime, fake trace,
requested-path inference, or tool-response inference is an acceptable substitute.
