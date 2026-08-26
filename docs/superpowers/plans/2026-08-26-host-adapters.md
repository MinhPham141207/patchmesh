# Host Adapters Implementation Plan (F-01 Waves 0–B, plus the MCP floor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a second coding agent (OpenCode) record into the same ledger with named host provenance, so overlaps/recap see cross-host work — preceded by the null-task overlap fix that makes cross-host contention visible at all.

**Architecture:** A `hosts/` registry inside `packages/recorder` (table lookup, zero dependencies on the hot path) behind one `HostAdapter` interface. The OpenCode integration is a generated dependency-free plugin that spawns the existing recorder binary per tool call, feeding stdin JSON under the same contract as a Claude hook. Spec: [2026-08-26-host-adapters-design.md](../specs/2026-08-26-host-adapters-design.md).

**Tech Stack:** TypeScript (strict), Node ≥ 24 (`node:test`, `node:sqlite`), pnpm workspace. Build then test: workspace tests import packages from `dist`.

## Global Constraints

- Both recorder binaries always exit 0; a recording failure may never break an agent's tool call.
- `bin.ts` hot path: only node builtins plus its current local imports (`advisory`, `identity`, `journal`, `redact`, `recent-writes`) and now `./hosts/*`. No package imports. The test at `packages/recorder/test/journal.test.ts:165` walks this graph — extend it, never weaken it.
- Host selection order, first hit wins: `--host` flag → `PATCHMESH_HOST` env → envelope sniffing → `"claude-code"`.
- Coverage tiers: `claude-code` = `observed`, `opencode` = `observed`, `generic-mcp` = `declared`. Non-observed-tier events never count as observed coverage.
- No new npm dependencies anywhere in this plan.
- Full correctness gate: `corepack pnpm check`. Targeted run pattern: `corepack pnpm build && node --test <testfile>`.
- Before pushing: `bash tools/ci/check-linux.sh` (Windows-green has shipped Linux-red twice here).
- Phase 0 protocol vocabulary is NOT changed by this plan (no new event types; see Task 9 scope note).

---

### Task 1: Null-task changes participate in overlap detection (Wave 0)

Today `packages/query/src/overlap.ts:309` skips every change whose `taskId` is null. An OpenCode session without Claude's turn-boundary hook produces exactly these, so cross-host contention would be invisible. New rule: a change participates when it carries *any* worker identity — `taskId`, or (`agentId` or `worktreeId`). Group participants by taskId when present, else by worker key. Truly unattributed changes stay excluded, preserving `contentionAmong`'s corpus-tested guarantee that an unattributed write can never play a party.

**Files:**
- Modify: `packages/query/src/overlap.ts` (~lines 34–41, 301–328, 607–611, 627)
- Test: `packages/query/test/overlap.test.ts`

**Interfaces:**
- Consumes: existing exported `workerKey(agentId, worktreeId)`.
- Produces: `OverlappingTask.taskId` becomes `string | null`; new export `participantKeyFor(taskId: string | null, agentId: string | null, worktreeId: string | null): string`.

- [ ] **Step 1: Write the failing test**

Append to `packages/query/test/overlap.test.ts`, planting events exactly the way that file's existing tests plant them (same fixture-builder style, same journal/ingest path):

```ts
test("two agents with no task still contend on one file", () => {
  const repo = /* same repo helper the neighbouring tests use */;
  const base = Date.parse("2026-08-26T10:00:00Z");
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();
  // Agent A writes at T+0 and stays active until T+40s (a later tool.completed).
  // Agent B writes the same file at T+20s. Distinct agentIds, both taskId null.
  plantFileChanged(repo, { agentId: "agent_aaaa", taskId: null, at: at(0), path: "src/shared.ts" });
  plantToolCompleted(repo, { agentId: "agent_aaaa", taskId: null, at: at(40_000) });
  plantFileChanged(repo, { agentId: "agent_bbbb", taskId: null, at: at(20_000), path: "src/shared.ts" });

  const result = findOverlappingWork({
    worktreeRoot: repo.root,
    ledgerPath: repo.ledgerPath,
    withinMinutes: 30,
    now: () => new Date(base + 60_000),
  });

  assert.equal(result.overlaps.length, 1);
  assert.ok(result.overlaps[0]!.tasks.every((task) => task.taskId === null));
});
```

Write `plantFileChanged` / `plantToolCompleted` as thin wrappers over the existing fixture helpers in that file; if tests there inline their fixtures instead, inline these identically.

- [ ] **Step 2: Run it to verify it fails**

Run: `corepack pnpm build && node --test packages/query/test/overlap.test.ts`
Expected: FAIL — `overlaps.length` is 0 because both changes were skipped at the null-task guard.

- [ ] **Step 3: Implement the minimal change**

In `packages/query/src/overlap.ts`:

(a) Widen the type — `readonly taskId: string | null;` in `OverlappingTask`.

(b) Add next to `workerKey`:

```ts
/**
 * What one participant in an overlap is keyed on: its task when it has one, else its worker
 * identity. An OpenCode session records with no task by construction, so keying on tasks alone
 * hides cross-host contention behind exactly the attribution gap a second host widens.
 */
export function participantKeyFor(
  taskId: string | null,
  agentId: string | null,
  worktreeId: string | null,
): string {
  return taskId ?? `worker:${workerKey(agentId, worktreeId)}`;
}
```

(c) Replace lines 307–309 (skip + comment):

```ts
    // A change needs SOME worker identity to be one side of an overlap: a task, or an agent /
    // worktree. One with none could equally be either party, and reporting it as a third would
    // invent a participant. Keying null-task entries by worker keeps one agent's own consecutive
    // writes merged into one participant -- `hasDistinctWorkers` still refuses to call a single
    // worker contested with itself.
    if (event.taskId === null && event.agentId === null && event.worktreeId === null) continue;
```

(d) In the grouping block, key entries by participant:

```ts
    const entry = byResource.get(resourceId) ?? { locator: String(resource?.locator ?? ""), tasks: new Map() };
    const participantKey = participantKeyFor(event.taskId, event.agentId ?? null, event.worktreeId ?? null);
    if (!entry.tasks.has(participantKey)) {
      entry.tasks.set(participantKey, {
        taskId: event.taskId,
        agentId: event.agentId,
        at: event.timestamp,
        changeKind: String(payload["changeKind"] ?? "changed"),
        worktreeId: event.worktreeId ?? null,
      });
    }
```

(e) In `renderOverlap`, stop feeding null ids to the shortener:

```ts
      ...overlap.tasks.flatMap((task) => (task.taskId === null ? [] : [task.taskId])),
```

and render row ~627 as:

```ts
    const label = task.taskId === null ? short(task.agentId!) : short(task.taskId);
    // line becomes: `    - ${task.at} ${name(task.agentId)} (${label}) ${task.changeKind}`,
```

(A worker-keyed participant always has a non-null `agentId`; worktree-keyed ones keep rendering via `name()`.)

(f) Fix any compile sites `tsc` surfaces. `tools/phase2/overlap-corpus.ts` literals still assign. The `options.taskId` filter keeps working: null-task entries never match a requested non-null id.

- [ ] **Step 4: Run query + gateway overlap suites**

Run: `corepack pnpm build && node --test packages/query/test/ && node --test packages/gateway/test/overlap.test.ts`
Expected: PASS including the new test and all existing contention tests.

- [ ] **Step 5: Commit**

```bash
git add packages/query tools/phase2 && git commit -m "Let null-task changes with known workers contend in overlaps"
```

---

### Task 2: Capture real OpenCode envelopes into fixtures (Wave 0 evidence)

F-01's rule: capability claims come from documentation fetched directly and live capture, not belief. This produces the fixtures Task 5's parser is written against. If you are executing inside OpenCode, your own tool calls are capture material.

**Files:**
- Create (temporary): `.opencode/plugins/patchmesh-probe.mjs`
- Create: `packages/recorder/test/fixtures/opencode/*.json` (sanitized captures) + a sibling `ENVELOPES.md`
- Modify: `.gitignore` (ignore `.patchmesh-probe/`)

- [ ] **Step 1: Write the probe plugin**

```js
// Temporary evidence gatherer; deleted in Task 9.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".patchmesh-probe");
export const PatchMeshProbe = async () => {
  mkdirSync(DIR, { recursive: true });
  const capture = (name) => async (input, output) => {
    try { appendFileSync(join(DIR, `${name}.jsonl`), `${JSON.stringify({ input, output })}\n`); } catch {}
  };
  return {
    "tool.execute.before": capture("before"),
    "tool.execute.after": capture("after"),
    event: async ({ event }) => {
      try {
        if (String(event.type).startsWith("session."))
          appendFileSync(join(DIR, "session-events.ndjson"), `${JSON.stringify(event)}\n`);
      } catch {}
    },
  };
};
```

- [ ] **Step 2: Restart an OpenCode session in this repository and do ordinary work for a few minutes** (edit a scratch file, run a shell command). Confirm `.patchmesh-probe/` fills.

- [ ] **Step 3: Sanitize into fixtures**

Copy ONE representative before/after pair per tool kind exercised (`bash`, `edit`/`write`, `read`) into `packages/recorder/test/fixtures/opencode/`, replacing secret-shaped strings and long outputs with `"REDACTED"` (the whitelist in `packages/recorder/src/redact.ts` names what counts). In `ENVELOPES.md` record per fixture: which property carries the session id, the tool name, the arguments, and whether anything names a subagent/delegate (F-01 §10 question 2).

If no session identity is exposed anywhere: STOP and report back — the tier drops to `declared` per the spec's §2 finding 2 caveat, and Tasks 5–8 get rewritten around session-tier ingestion before proceeding.

- [ ] **Step 4: Commit**

```bash
git add .gitignore packages/recorder/test/fixtures/opencode/
git commit -m "Capture real OpenCode tool envelopes as adapter fixtures"
```

(Leave the probe installed until Task 9 deletes it.)

---

### Task 3: The host registry, with Claude Code extracted into it (Wave A)

**Files:**
- Create: `packages/recorder/src/hosts/types.ts`, `packages/recorder/src/hosts/claude-code.ts`, `packages/recorder/src/hosts/index.ts`
- Modify: `packages/recorder/src/tool-mapping.ts` (becomes a thin re-export shim), `packages/recorder/test/journal.test.ts` (import-graph test)
- Test: `packages/recorder/test/hosts.test.ts`

**Interfaces:**
- Produces (Tasks 5–8 consume these):

```ts
// hosts/types.ts
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
}

export function resolveHostAdapter(host: string): HostAdapter;   // table lookup; unknown -> claude-code
export function tierForSourceId(sourceId: string): CoverageTier | null; // source_<host>_hook -> tier
```

- [ ] **Step 1: Write the failing test**

`packages/recorder/test/hosts.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHostAdapter, tierForSourceId } from "../src/hosts/index.js";
import { normalizeTool } from "../src/tool-mapping.js";

test("unknown host falls back to claude-code", () => {
  assert.equal(resolveHostAdapter("nonsense").id, "claude-code");
});

test("tiers resolve from recorded source ids", () => {
  assert.equal(tierForSourceId("source_claude_code_hook"), "observed");
  assert.equal(tierForSourceId("source_opencode_hook"), "observed");
  assert.equal(tierForSourceId("source_generic_mcp"), "declared");
  assert.equal(tierForSourceId("source_unknown_thing"), null);
});

test("claude adapter parses its own envelope and rejects others", () => {
  const claude = resolveHostAdapter("claude-code");
  const record = claude.parse({
    session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: {},
  });
  assert.equal(record?.hostToolName, "Edit");
  assert.equal(claude.parse({ tool: "edit" }), null); // an OpenCode-shaped envelope is not Claude's
});

test("claude tool mapping is unchanged after extraction", () => {
  assert.equal(normalizeTool("Edit", null).toolName, "edit_file");
  assert.equal(normalizeTool("Bash", "git commit -m x").toolName, "git_commit");
});
```

- [ ] **Step 2: Run to verify failure** — `corepack pnpm build && node --test packages/recorder/test/hosts.test.ts` → FAIL (`hosts/index.js` missing).

- [ ] **Step 3: Implement**

Move `HOST_TOOLS`, `GIT_COMMIT` and the body of `normalizeTool` verbatim from `tool-mapping.ts` into `hosts/claude-code.ts`; add `parse` reading exactly the fields today's `HookPayload` reads (`session_id`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id` → `delegateId`, `agent_type` → `delegateType`). Return null when `hook_event_name` is absent or `tool_name` is not a non-empty string. `tool-mapping.ts` keeps exporting `NormalizedTool` + `normalizeTool` by delegating to the extracted table so no import site changes yet. `hosts/index.ts` holds the registry array `[claudeCodeAdapter]` (opencode/generic-mcp join in later tasks), `resolveHostAdapter`, and `tierForSourceId` derived from each adapter's `id` via the existing `sourceIdForHost` mapping.

- [ ] **Step 4: Extend the import-graph test** — in `journal.test.ts:165`'s walk, include `src/hosts/**` among the modules that must stay free of package imports. Run that test: PASS.

- [ ] **Step 5: Full recorder suite + commit**

```bash
corepack pnpm build && node --test packages/recorder/test/
git add packages/recorder && git commit -m "Extract the Claude Code host adapter behind a registry"
```

---

### Task 4: hook.ts consumes HostRecord (Wave A)

**Files:**
- Modify: `packages/recorder/src/hook.ts`, `packages/recorder/src/attribution.ts` (only if its input type names payload fields directly)
- Test: `packages/recorder/test/recorder.test.ts`

**Interfaces:**
- Consumes: `resolveHostAdapter().parse` from Task 3.
- Produces: `buildHookEvents(options)` keeps its exact signature and output — this is a pure internal refactor, which is what makes byte-identity testable.

- [ ] **Step 1: Write the identity test first**

In `recorder.test.ts`, add a frozen-envelope replay: keep a committed array of real captured Claude envelopes (harvest 5–10 from existing test fixtures or redact fresh ones from `.patchmesh/journal.ndjson`), run them through `buildHookEvents` before the refactor, and snapshot the resulting event pairs into a committed fixture file `packages/recorder/test/fixtures/claude-frozen-events.json`. Assert deep equality on every field.

```ts
test("refactor leaves event construction byte-identical on frozen envelopes", () => {
  for (const envelope of FROZEN_ENVELOPES) {
    const expected = FROZEN_EVENTS[envelopeIndex++];
    const actual = buildHookEvents({ payload: envelope as HookPayload, worktreeRoot: "/wt" });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  }
});
```

(Commit the fixture in the same change as Step 2's refactor so the assertion has teeth; generate it by running the pre-refactor code once and writing the output file.)

- [ ] **Step 2: Refactor** — at the top of `buildHookEvents`, replace direct `payload.*` reads with:

```ts
const adapter = resolveHostAdapter(resolveSourceHost());
const record = adapter.parse(payload);
if (record === null) throw new HookRecordingError("payload matched no installed host adapter");
```

then thread `record.sessionId / record.hostToolName / record.input / record.response / record.delegateId / record.delegateType` through the existing body. `declaredLogicalPath` takes `input` instead of `HookPayload`. Nothing else moves.

- [ ] **Step 3: Verify identity** — run the recorder suite: PASS with the frozen test green.
- [ ] **Step 4: Commit**

```bash
git add packages/recorder && git commit -m "Build hook events from a normalized host record"
```

---

### Task 5: The OpenCode adapter (Wave B)

**Files:**
- Create: `packages/recorder/src/hosts/opencode.ts`
- Modify: `packages/recorder/src/hosts/index.ts` (register it)
- Test: `packages/recorder/test/hosts.test.ts`
- Fixture inputs: Task 2's captures

**Interfaces:**
- Consumes: `HostAdapter` from Task 3; fixtures from Task 2.
- Produces: adapter `{ id: "opencode", displayName: "OpenCode", tier: "observed", parse }` registered in the registry; tool table mapping OpenCode names onto the closed protocol set.

- [ ] **Step 1: Write failing tests from real fixtures**

```ts
import opencodeBefore from "./fixtures/opencode/tool-execute-before.json" with { type: "json" };
import opencodeAfter from "./fixtures/opencode/tool-execute-after.json" with { type: "json" };

test("opencode adapter parses its captured envelopes", () => {
  const opencode = resolveHostAdapter("opencode");
  assert.equal(opencode.parse(opencodeBefore) === null, false);
  const record = opencode.parse(opencodeBefore)!;
  assert.equal(record.sessionId.length > 0, true);   // property name comes from ENVELOPES.md
  assert.equal(claude.parse(opencodeBefore), null);   // and Claude does not claim it
});

test("opencode tool table maps the closed vocabulary", () => {
  // Exact host-side names and path properties come from the Task 2 fixtures; these assertions
  // are written against what was captured, not guessed:
  assert.equal(normalizeToolFor("opencode", "bash", "git commit -m x").toolName, "git_commit");
  assert.equal(normalizeToolFor("opencode", "edit", null).toolName, "edit_file");
  assert.equal(normalizeToolFor("opencode", "something-unknown", null).toolName, "other");
});
```

`normalizeToolFor(hostId, name, command)` is a new export on `hosts/index.ts` delegating to the named adapter's table (`normalizeTool` stays as its `claude-code` alias). The OpenCode table lives in `hosts/opencode.ts`: shell tools → `run_shell` opaque (with the shared `GIT_COMMIT` promotion), file-editing tools → `edit_file` with the fixture-verified path property, read tools → `read_file`, anything else → `other` opaque.

- [ ] **Step 2: Verify fail → implement → verify pass** — same cycle as Tasks 3–4. Extend the import-graph walk to cover the new file automatically (it already walks `src/hosts/**`).
- [ ] **Step 3: Commit**

```bash
git add packages/recorder && git commit -m "Add the OpenCode host adapter"
```

---

### Task 6: bin.ts accepts --host and drains OpenCode envelopes (Wave B)

**Files:**
- Modify: `packages/recorder/src/bin.ts`
- Test: `packages/recorder/test/journal.test.ts` (or a new `bin-host.test.ts` following its spawn-the-binary pattern)

- [ ] **Step 1: Failing test** — spawn `bin.js --host opencode` with a captured before-envelope on stdin; assert exit code 0 and that `.patchmesh/journal.ndjson` gained entries whose `source.sourceId` equals `"source_opencode_hook"` and whose `eventType` set matches the stage (`before` → journal marker only if the design journals pre-events; at minimum the after-pair records `tool.requested`+`tool.completed`). Assert the same envelope without `--host` still routes to claude-code (sniffing fallback keeps old installs intact).

- [ ] **Step 2: Implement** — parse `--host <id>` from argv before stdin handling; when present, validate against the registry and set `process.env["PATCHMESH_HOST"] = id` so every downstream `resolveSourceHost()` call picks it up. Envelope dispatch in the main path goes through the registry: try `resolveHostAdapter(env).parse(raw)` first, then sniff across adapters for the pre/post stage. Keep everything inside the existing always-exit-0 wrapper; an unparsable envelope appends nothing and exits 0.

- [ ] **Step 3: Verify** — new test PASS; full recorder suite PASS; import-graph test still PASS.
- [ ] **Step 4: Commit**

```bash
git add packages/recorder && git commit -m "Route the hook binary through the host registry"
```

---

### Task 7: init writes the OpenCode plugin; doctor checks it (Wave B)

**Files:**
- Modify: `apps/cli/src/init.ts`, `apps/cli/src/doctor.ts`, `apps/cli/src/main.ts` (--host flag threading), `apps/cli/src/render.ts` (init output line)
- Test: the CLI test file that already covers init idempotence (follow its existing helper style)

**Interfaces:**
- Produces: `patchmesh init --host opencode` writes `.opencode/plugins/patchmesh.mjs`; re-running reports `unchanged`; `--force` overwrites. Doctor gains a per-host section where an uninstalled non-default host is informational, never a failure.

- [ ] **Step 1: Failing tests**

```ts
test("init --host opencode installs the plugin once", async () => {
  const repo = await makeRepo();
  await runInit(repo.root, { host: "opencode" });
  const pluginPath = join(repo.root, ".opencode", "plugins", "patchmesh.mjs");
  assert.equal(existsSync(pluginPath), true);
  const second = await runInit(repo.root, { host: "opencode" });
  assert.equal(second.steps.some((s) => s.outcome === "unchanged"), true);
});

test("the generated plugin spawns the resolved recorder binary", async () => {
  const plugin = readFileSync(join(repo.root, ".opencode", "plugins", "patchmesh.mjs"), "utf8");
  assert.match(plugin, /--host opencode/);
  assert.match(plugin, /bin\.js/);
});
```

- [ ] **Step 2: Implement**

The plugin template is a string constant in `init.ts` — dependency-free ESM, mirroring the probe's shape but spawning instead of appending:

```js
export const PatchMeshPlugin = async () => ({
  "tool.execute.before": relay("before"),
  "tool.execute.after": relay("after"),
});
// relay(stage) reads the hook arguments, JSON-wraps {stage, ...args}, pipes them to
// RECORDER_BIN --host opencode via Bun's $ or node child_process.spawnSync, never inspects
// the result, and swallows every error: recording may cost time, never break a tool call.
```

Binary resolution follows init's existing rule (`defaultPackageRoot()`-style absolute path baked in at write time; repository-relative when installed as a dev dependency — reuse whatever logic today's hook commands use). Idempotence: compare existing file content byte-for-byte before writing. Doctor: add an `opencode` section asserting the plugin file exists and references a binary path that exists; report `not installed` as plain information when absent.

- [ ] **Step 3: Verify** — CLI suite PASS; manually run `node apps/cli/dist/main.js init --host opencode` in this repo and confirm the file appears and re-run says unchanged.
- [ ] **Step 4: Commit**

```bash
git add apps/cli && git commit -m "Install and check the OpenCode plugin from init and doctor"
```

---

### Task 8: Read side renders host and tier (Wave B)

**Files:**
- Modify: `packages/query/src/agents.ts` (or wherever `patchmesh agents` builds rows — follow the recap/agents service files in `packages/query/src/`), `apps/cli/src/render.ts`, `packages/gateway/src/server.ts` (only if the MCP agents output shares the renderer)
- Test: the query + CLI tests covering `agents` and `status`

- [ ] **Step 1: Failing test** — build a ledger containing events from two source ids (`source_claude_code_hook`, `source_opencode_hook`); assert the agents report renders each agent as `<name> · <displayName> (<tier>)`, e.g. `agent_aaaa · OpenCode (observed)`; assert status's coverage line counts only observed-tier sources toward observation coverage.

- [ ] **Step 2: Implement** — join each event stream's `source.sourceId` through `tierForSourceId` (Task 3, imported from `patchmesh-recorder`) and render host + tier beside every agent. Unknown source ids render as `(unrecognized host)` rather than being counted either way.

- [ ] **Step 3: Verify** — query + CLI suites PASS; run `patchmesh agents` against this repo's own ledger (which now has both hosts after Task 9's dogfooding) and eyeball both tiers on screen.
- [ ] **Step 4: Commit**

```bash
git add packages/query apps/cli packages/gateway && git commit -m "Render host provenance and coverage tier beside every agent"
```

---

### Task 9: Cross-host contention acceptance + latency measurement (Wave B gate)

**Files:**
- Create: `tools/concurrency/cross-host-scenario.ts` (following `tools/concurrency/scenarios.ts`'s structure)
- Delete: `.opencode/plugins/patchmesh-probe.mjs` (Task 2 cleanup)
- Modify: spec's Wave B acceptance note in `docs/features/F-01-multi-host-agent-workspace.md` §9 (record outcomes)

- [ ] **Step 1: Build the scenario** — drive two recorder invocations with different `PATCHMESH_HOST` values contending on one file inside one temp repo (reuse `tools/concurrency/harness.ts`'s ledger setup): claude-code agent writes at T+0 with activity until T+40s; opencode agent (null taskId, per Task 1's keying) writes at T+20s.

- [ ] **Step 2: Assert the acceptance** — `findOverlappingWork` returns one overlap naming both hosts' agents, contention evidence intact. This is the acceptance test that matters; everything before it was scaffolding.

- [ ] **Step 3: Measure plugin latency** — with the real plugin installed, time 20 recorded tool calls end-to-end from the OpenCode side (probe timestamps or manual timing around known calls). Record p50 in the F-01 §9 note. If p50 exceeds ~300 ms, STOP and reopen the batching discussion per the spec's §7.2 rather than shipping silently.

- [ ] **Step 4: Dogfood, then commit** — run one real OpenCode session in this repo alongside a Claude session editing nearby files; confirm `patchmesh overlaps` fires cross-host on genuine traffic. Then:

```bash
git add tools/concurrency .opencode docs/features/F-01-multi-host-agent-workspace.md
git commit -m "Accept cross-host contention end to end"
```

---

### Task 10: generic-mcp declared participation floor (Wave C, reduced)

Scope note from the spec: adding session-lifecycle event types would be a Phase 0 contract change (schemas + corpus + validator together) and is deliberately NOT here. What ships instead: MCP-only hosts already record through the gateway path; this task makes that participation honestly visible.

**Files:**
- Modify: `packages/recorder/src/hosts/index.ts` (+ tiny `generic-mcp.ts` adapter entry with `tier: "declared"` and a parse that returns null for hook envelopes — it exists so `tierForSourceId("source_generic_mcp")` resolves and future ingestion has a home)
- Modify: `apps/cli/src/doctor.ts` (informational generic-mcp line)
- Docs: `docs/HOST_ADAPTER_BOUNDARY.md` gains a short "declared tier" paragraph stating plainly that gateway-recorded calls are self-participation, not observation
- Test: extend `packages/recorder/test/hosts.test.ts`

- [ ] **Step 1: Failing test** — `tierForSourceId("source_generic_mcp")` returns `"declared"`; `resolveHostAdapter("generic-mcp").parse(<claude envelope>)` returns null.
- [ ] **Step 2: Implement** — registry entry + doctor line + doc paragraph.
- [ ] **Step 3: Verify & commit**

```bash
corepack pnpm check
git add packages/recorder apps/cli docs/HOST_ADAPTER_BOUNDARY.md
git commit -m "Recognize gateway-recorded participation as the declared tier"
```

---

## Final gate

- [ ] `corepack pnpm check` green on Windows.
- [ ] `bash tools/ci/check-linux.sh` green before pushing.
- [ ] Update `docs/features/F-01-multi-host-agent-workspace.md` §9 marking Waves A–B shipped with their acceptance evidence links, and `CHANGELOG.md`.


