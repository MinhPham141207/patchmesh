# PR4 patchmesh-site MCP Gateway and M7 Production Host Boundary

## Status

PR4 now provides an internal `patchmesh-site` transparent MCP gateway in
`@patchmesh/adapters`. It is the selected integration path for a host that
declares synchronous dispatch ownership, and delegates every supported host tool
call to `McpProxy.execute` exactly once. It constructs `McpCallContext` from a
trusted host/session identity object, rejects mismatched payload identity, reads a
closed same-store evidence slice after completion, and keeps recorder failure
separate from the original tool result.

This is **internal readiness**, not production-gate acceptance. The actual
`patchmesh-site` deployment/runtime callsite is outside this repository, so no
real host-owned execution has yet passed through the gateway. M7 remains blocked
until that external integration produces a qualifying persisted completion-linked
effect. PR5 relationship-proof capture is implemented for host-authoritative contexts;
PR6–PR7 remain outside this gateway.

The `patchmesh-site` host configuration must declare whether it has synchronous
executor ownership. `detectPatchMeshSiteCapabilities` returns the canonical
capability digest only when that contract is supplied; a false
`synchronousGateway` returns the typed
`PATCHMESH_SITE_SYNCHRONOUS_GATEWAY_UNAVAILABLE` blocker. Constructing a gateway
from a blocked contract raises `PatchMeshSiteCapabilityError` with that code and
digest, rather than silently activating an unqualified path.

### PR4 serialized-dispatch limitation

PR4 serializes every `PatchMeshSiteMcpGateway.dispatch` call, including calls for
different worktrees. This preserves append-ordered adapter source sequences, but
means this gateway does **not** support concurrent executor-window observation. Its
published capability is always `concurrentWorktreeObservation: false`; a host
contract that declares it `true` is rejected with
`PATCHMESH_SITE_CONCURRENT_WORKTREE_OBSERVATION_UNSUPPORTED`. Supporting true
concurrent executor windows require a later, separately designed gateway model.
PR5 can still record authoritative overlapping task lifetimes, which are distinct
from overlapping gateway dispatches.

## Existing PatchMesh Path

The production host must instantiate and use the public gateway rather than call
an executor directly:

```ts
const gateway = new PatchMeshSiteMcpGateway({
  eventStore: SqliteEventStore.open(databasePath),
  hostContract,
  proxyOptions: {
    observer: new NodeObservationBoundary({ source: watcherSource }),
    phase2SourceAnalysis: analysisOptions,
  },
  evidenceRecorder,
});

const result = await gateway.dispatch(authoritativeRuntimeIdentity, {
  call,
  execute: executor,
  hostToolCallId,
}, signal);
```

`PatchMeshSiteMcpGateway.dispatch` is the host boundary. Internally it calls the
canonical proxy signature exactly once:

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

The host supplies real values for `McpToolCall` and the authoritative runtime
identity (workspace root, agent/task/worktree attribution, source, repository,
and causation). The gateway assigns correlation and monotonic source sequences.
Payload identity may only confirm that context; it cannot replace it. Neither the
host nor the gateway may invent effect paths or resource versions.

## Required Post-Tool Handoff

After `await proxy.execute(...)` returns, the gateway reads the persisted events
from the same event store:

1. Locate `result.completedEventId`.
2. Read that terminal `tool.completed` event and the persisted request identified by
   its `payload.requestEventId`.
3. Read only the events listed in its
   `payload.effectEventIds`.
4. Retain only persisted `file.changed` events for the evidence effect payload.
5. Pass the exact `McpProxyResult` and the closed persisted slice to the evidence
   recorder bridge. The recorder payload also carries `runtime`, runtime/adapter
   versions, and the canonical capability digest. Its event order is always
   request → linked `file.changed` effects → terminal completion.

The bridge input is:

```json
{
  "action": "tool.completed",
  "agentId": "agent-id-or-null",
  "taskId": "task-id-or-null",
  "worktreeId": "worktree-id-or-null",
  "toolCallId": "runtime-tool-call-id-or-null",
  "patchmesh": {
    "runtime": "patchmesh-site",
    "runtimeVersion": "host-owned version",
    "adapterVersion": "PatchMesh adapter version",
    "capabilityDigest": "sha256:...",
    "result": "the returned McpProxyResult",
    "events": [
      "the persisted tool.requested event",
      "its persisted completion-linked file.changed effect events",
      "the persisted tool.completed event"
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

## PR4 Verification and Remaining External Gate

The internal gateway has deterministic integration coverage for capability
detection, exact-once success/failure/interruption/non-zero execution, abort,
identity mismatch, recorder failure, same-store evidence isolation, and a local
Git-backed file-changing gateway call with non-empty completion-linked verified
effects. This proves the repository-side implementation path only.

The production gate becomes unblocked only when the real `patchmesh-site` host
owns an execution, calls `PatchMeshSiteMcpGateway.dispatch`, and its SQLite store
contains the resulting request, terminal completion, and non-empty sufficient
completion-linked effects. That run must then pass the required trace and human
review workflow. Until then M7 is externally blocked. No synthetic runtime, fake
trace, requested-path inference, or tool-response inference is an acceptable
substitute.
