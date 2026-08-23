# PM-01 — Nothing consumes the ledger

- **Status:** `resolved` — `SessionStart` recap injection shipped 2026-08-23
- **Severity:** critical
- **Blocks:** PM-02, PM-10, PM-11, and every claim about value

## Resolution (2026-08-23) — option A shipped

`patchmesh init` now wires a sixth hook, `SessionStart`, running
`packages/gateway/src/session-start-bin.ts`. It runs a bounded recap and returns it as
`hookSpecificOutput.additionalContext`, the same shape Knowl uses successfully in this
repository.

- **It lives in `patchmesh-gateway`, not the recorder.** `patchmesh-query` depends on
  `patchmesh-recorder`, so the recorder cannot import recap without a cycle. The gateway
  already depends on both, and it owns `recordAnswer`, so the injected recap is measured on
  exactly the same terms as every other answer — which is the number this problem exists to
  move.
- **It may import the heavy packages.** Unlike `patchmesh-record`, it runs once per session
  rather than once per call, so the schema-compilation cost the recorder's flat import graph
  exists to avoid is paid a single time and never on the per-call path.
- **Always exits 0.** Malformed payload, missing ledger, directory that is not a repository —
  all mean "say nothing", never "fail". A hook that can break session start gets uninstalled
  after one incident.
- **Bounded twice**, in tasks (5) and in bytes (4,000). Measured against this repository's
  ledger the injected context is **1,491 bytes**, close to the 1,741 bytes PM-10 measured for
  the MCP recap. An unbounded recap is just the ledger again.
- **Nothing recorded means nothing injected.** Injecting "no recent work" into every session
  is pure cost for no answer.

**Measured cost: ~2.0–2.4s per session start**, against the 15s timeout. The split is ~190ms
recorder import, ~70ms query import, and **~1.4s reading and parsing the 24h event window**
(2,790 events). The dominant cost is the SQLite read, not module load — so it scales with
daily activity rather than with total ledger size, but it is worth revisiting if a day's
traffic grows much beyond this.

**Contention is injected too, and leads.** The recap says what happened; contention is the only
thing PatchMesh knows that can change what the agent does *next*, and it was still reachable
only by choosing to ask — which is this problem exactly, one level in. `SessionStart` now runs
`findOverlappingWork` over a four-hour window and puts any contested files **above** the recap,
with the `why:` evidence line attached.

Three things keep it affordable and honest:

- **Nothing is said when there is no contention.** A "no collisions" line in every session is
  the permanent-`degraded` mistake of PM-12 in a new costume.
- **Four hours, not the recap's twenty-four.** A day-old collision is history, not a warning,
  and the short window is why the query is nearly free: session start measured **1.7–2.2s**
  with contention included, against 2.0–2.4s without it.
- **It was not injected until the signal was calibrated.** Before the contention rule this
  query returned twenty files at any window past eight hours, thirteen of them sequential.
  Pushing that into every session unasked would have spent context teaching the agent to skip
  the section. See [overlap-precision](../measurements/overlap-precision.md).

Its own `try`/`catch`, separate from the recap's: a failure in the newer, more expensive query
must cost the notice, never the recap that was already computed.

**Installed and verified 2026-08-23.** `patchmesh doctor` reports all 6 hooks installed and
`PatchMesh is recording.`

Next: measure answers-per-session for a week before considering option B.

---

## The problem (as originally written; the hook list below is inaccurate)

`patchmesh init` wires five hooks — `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`,
`SubagentStop` (`apps/cli/src/init.ts:54`). Every one of them is write-side. There is no
read-side hook of any kind, so nothing in an agent's loop ever asks the ledger a question.

> **Correction.** The actual `HOOKS` array was `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
> `Stop`, `SessionEnd` — there was no `SubagentStop`, and `UserPromptSubmit` *was* wired, as
> the write-side turn boundary. The conclusion held (all five were write-side, nothing read),
> but option B's costing did not: it was called "strictly more expensive than A" on the
> assumption of a new process spawn, and that spawn already happened every turn. The real
> marginal cost of B is the ledger read, not the process.

Recall is available two ways, and both require someone to choose to use them: an MCP tool
an agent must decide to call, and a CLI command a human must type. Agents do not call tools
they have not been told they need.

## Evidence

```
events recorded    3,674
answers returned       8      (.patchmesh/answers.ndjson)
ratio                ~459:1
last answer        2026-08-22T19:04Z
latest event       2026-08-23T06:47Z   -> ~12h of work, zero answers
```

The contrast is in this repository: Knowl is consumed on every single turn because it
installs a `SessionStart` and a `UserPromptSubmit` hook. It has worse data than PatchMesh
and vastly better distribution.

## Why it matters

This is the binding constraint on the entire product. The net-token invariant, overlap
value, and recall usefulness are all measurements of a tool that is effectively never
invoked. They cannot come out well, or badly — they cannot come out at all.

## Candidate solutions

### A. `SessionStart` recap injection — recommended

Add a sixth hook that runs `recap` and returns it as additional context, exactly the shape
Knowl already uses successfully in this repository.

- Cost: one hook wiring, one binary that already exists, one `init` change.
- Risk: startup latency on every session. Recap is a bounded query and the CLI's cold cost
  is the known ~1.2s module load; budget a timeout and fail open like every other hook.
- Effect: answers-per-session goes from ~0 to 1. It converts the Tier 0 gate on its own and
  creates the intervention arm that PM-10 needs to be measurable at all.

### B. `UserPromptSubmit` injection

Fires per turn rather than per session, so context stays current within a long session.

- Strictly more expensive than A, and mostly redundant on short sessions.
- Worth adding only after A shows the injected context is being used.

### C. Tool description as the carrier

Register the MCP tools with descriptions that state when to call them, rather than pushing
context.

- Cheapest possible change, and the one already implicitly tried. It has produced 8 calls
  in five days. Not a solution on its own.

### D. Make recap part of `init`'s output and the README's first line

Already done, and it is why there are 8 answers instead of 0. Documentation moves a human
once; a hook moves every session.

## Recommendation

Do A. Measure answers-per-session for a week. Only then consider B.
