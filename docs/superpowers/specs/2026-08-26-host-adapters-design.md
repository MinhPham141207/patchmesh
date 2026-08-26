# Host adapters — multi-host recording (F-01 Waves A–B)

| | |
| --- | --- |
| **Date** | 2026-08-26 |
| **Status** | approved direction, pending implementation plan |
| **Supersedes** | §4–§4.7 of [F-01](../../features/F-01-multi-host-agent-workspace.md) where they differ |
| **Touches** | `packages/recorder`, `packages/query`, `apps/cli`, `.opencode/plugins/` (generated), `docs/THREAT_MODEL.md` (not needed — no new injection surface) |

## 1. The ask

Make a second coding agent record into the same ledger with its host named on every
event, so `overlaps`, `recap` and `recent_activity` see cross-host work. Scope agreed
with the user: the full host registry plus two real hosts (Claude Code refactored,
OpenCode new), plus the `generic-mcp` floor adapter.

## 2. What is already true (verified 2026-08-26)

Verified against the tree at `704ca77` and https://opencode.ai/docs/plugins/.

1. **Host provenance is stamped, parameterised, and read nowhere.**
   `resolveSourceHost` ([source.ts](../../../packages/recorder/src/source.ts)) reads
   `PATCHMESH_HOST` per event and `sourceIdForHost` mints `source_<host>_hook`.
   No query, CLI renderer or MCP tool reads the field back.
2. **OpenCode exposes per-tool-call interception.** Its plugin API provides
   `tool.execute.before` and `tool.execute.after` hooks that see built-in tools
   (`bash`, `edit`, `write`, `read`, ...), plus session lifecycle events
   (`session.created`, `session.idle`). This makes OpenCode **`observed` tier** — better
   than F-01 §4.5 expected. Unverified residual: whether a subagent run is nameable
   from these hooks; Wave 0 answers it empirically.
3. **The null-task overlap drop still exists.** `overlap.ts` line 309 executes
   `if (event.taskId === null) continue;`. F-01 §3 called this a hard blocker; Wave 2b
   fixed the advisory half (recent-write predicate) but not this. It is *more* load-bearing
   now: an OpenCode session has no Claude-style turn-boundary hook, so its events carry
   null tasks by default — cross-host contention would be invisible exactly when it matters.
4. **The hot-path rule stands.** `bin.ts` may import only node builtins plus
   `identity/journal/redact/advisory/recent-writes`; a test walks the transitive import
   graph. p50 hook cost is 108 ms because of it. The host registry must live inside the
   recorder package with no new dependencies, selected by table lookup, never a runtime
   plugin loader.

## 3. Approach decision

Three approaches were considered for getting OpenCode data into the journal:

- **A. Plugin spawns the existing recorder binary** (chosen). A generated
  `.opencode/plugins/patchmesh.mjs` spawns `node <recorder>/dist/bin.js --host opencode`
  per tool call, feeding stdin JSON under the same contract as a Claude hook. Zero new
  user dependencies, identical journal format, the import-graph test keeps guarding
  latency, ingest/query change almost not at all. Cost: one ~50–150 ms process spawn per
  tool call inside OpenCode.
- **B. Plugin imports the recorder as an npm dependency.** Rejected: OpenCode installs
  plugins with Bun into `~/.cache/opencode/node_modules`, so version skew between the
  bundled recorder and the installed CLI becomes a failure mode; redaction logic ships in
  two runtimes; bypasses the hot-path guard.
- **C. Record through the MCP gateway** (`McpProxy`). Rejected per F-01: serialized
  dispatch, `declared` tier at best, discards the observed surface just verified.

## 4. Architecture

### 4.1 The registry

New module `packages/recorder/src/hosts/`, one file per host:

```ts
export type HostId = "claude-code" | "opencode" | "generic-mcp";
export type CoverageTier = "observed" | "session" | "declared";

export interface HostRecord {
  readonly stage: "pre" | "post" | "turn" | "stop";
  readonly sessionId: string;
  readonly hostToolName: string;
  readonly input: unknown;
  readonly response: unknown;
  readonly delegateId: string | null;
  readonly delegateType: string | null;
}

export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly tier: CoverageTier;
  /** Envelope -> normalized record. Null for an envelope this host does not own. */
  parse(envelope: unknown): HostRecord | null;
  normalizeTool(hostToolName: string, command: string | null): NormalizedTool;
}
```

`hook.ts` keeps its event-building body and consumes `HostRecord`; the Claude-specific
field reads move into `hosts/claude-code.ts` together with today's `HOST_TOOLS` table.
A second table in `hosts/opencode.ts` maps OpenCode's lowercase vocabulary onto the same
closed protocol set (`bash -> run_shell` opaque, `edit`/`write -> edit_file` with their
path property, unrecognized -> `other` opaque). Exact property names come from Wave 0
evidence, not from this document.

Selection order, first hit wins: `--host <id>` flag → `PATCHMESH_HOST` → first adapter
whose `parse` returns non-null → `claude-code`. Step 4 keeps every existing install
recording unchanged.

### 4.2 The OpenCode plugin

`patchmesh init --host opencode` writes `.opencode/plugins/patchmesh.mjs`: a
self-contained, dependency-free file that registers `tool.execute.before` /
`tool.execute.after` and spawns the recorder binary resolved at init time
(repository-relative when installed as a dev dependency, absolute otherwise).
Every spawn is wrapped so a failure can only lose a record, never break a tool call —
the same always-exit-0 discipline as the Claude hooks.

Out of scope for v1, deliberately: turn-boundary task attribution for OpenCode. There is
no `UserPromptSubmit` equivalent wired up, so OpenCode calls record with agent + session
attribution and `taskId: null`. That is acceptable because Wave 0 removes the null-task
blind spot; a turn boundary can ride `message.updated`-class events in a later wave once
the envelope shapes are known.

Effects snapshot diffing stays opt-in as today; observed-tier declared paths come from
tool inputs directly.

### 4.3 Read side

- `patchmesh agents` and `patchmesh status` resolve each event stream's
  `source.sourceId` against the registry and render `displayName (tier)` beside the
  agent — `opencode (observed)`, not `agent_7a1033a6` alone.
- Tool coverage counts only `observed`-tier events as observed; `declared`-tier
  participation is reported separately using the existing `sufficient`/`degraded`
  vocabulary rather than a parallel one.
- No cross-host comparison is rendered without both tiers on screen.

### 4.4 generic-mcp floor

Three MCP tools — `patchmesh_session_begin`, `patchmesh_checkin`,
`patchmesh_session_end` — let any MCP-capable host participate at `declared` tier:
session boundaries and volunteered check-ins, no call observation. Named as a floor,
never rendered as equivalent participation.

## 5. Delivery order

| Wave | Content | Done when |
| --- | --- | --- |
| **0** | Fix the null-task drop in `overlap.ts` (classify contention by distinct `agentId`, keeping the task grouping where tasks exist). Write a throwaway probe plugin, run one real OpenCode session, capture actual `tool.execute.*` envelopes into fixtures. | `overlaps` reports a null-task two-agent contention; fixtures hold real envelopes, not guesses |
| **A** | `hosts/` registry, `HostAdapter`, `hook.ts` consuming `HostRecord`, Claude tables moved. | Claude Code output is byte-identical to pre-change on a frozen ledger; import-graph test extended over `hosts/` passes |
| **B** | `hosts/opencode.ts`, generated plugin, `init --host opencode`, per-host `doctor`, read-side tier rendering. | Real traffic from both hosts lands in one ledger and `overlaps` reports cross-host contention on a file both touched |
| **C** | `generic-mcp` floor tools. | An MCP-only client produces declared-tier events visible in `status` |

Wave 0 is worth doing whether or not the rest ships.

## 6. Testing

- Import-graph test extended to fail if `hosts/` pulls a package dependency onto the
  hot path.
- Fixture-driven parser tests per host: one golden positive, one negative (foreign
  envelope returns null), one malformed-input case per adapter.
- Frozen-ledger identity test: replay a captured ledger through refactored Claude
  ingestion and diff event output byte-for-byte.
- Concurrency scenario in `tools/concurrency` style: two sessions with different
  `PATCHMESH_HOST` values contend on one file; assert `overlaps` finds it with null tasks.
- `init` idempotence test for the generated plugin (re-run does not append a second copy).

## 7. Risks and open questions

1. **Subagent naming on OpenCode** — unresolved until Wave 0. If delegates cannot be
   named, all OpenCode work attributes to the session agent, and the honest framing is
   recorded rather than papered over.
2. **Spawn latency inside OpenCode** — measured during Wave B acceptance; if p50 exceeds
   roughly 300 ms the batching options get reopened, not silently accepted.
3. **Plugin config ownership** — `init` must decide ownership by the binary a hook
   command runs, never by a substring of the repo name (the recurring `init.ts` bug);
   the generated plugin carries that rule forward.
4. **Agent-id collisions across hosts** — remote (UUID-shaped session ids); the ledger
   disambiguates on `source.sourceId`. Recorded, not paid for.
