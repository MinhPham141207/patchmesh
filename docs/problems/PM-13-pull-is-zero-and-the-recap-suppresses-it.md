# PM-13 — Pull is still zero, and the recap is what suppresses it

- **Status:** `partial` 2026-08-24 — the suppression is removed; whether removing it moves the
  number is now measurable and unmeasured.
- **Severity:** high

## The problem

PM-01 is `resolved` because *something* consumes the ledger. What it opened was a **push**
surface. Voluntary pull never moved.

Counted from the ledger's own `tool.requested` rows on 2026-08-24 (5,523 events, 2,275 calls),
in the same repository, by the same agents, in the same sessions:

| server | voluntary calls, lifetime |
| --- | --- |
| `knowl` (memory) | **152** — 72 store, 62 query, 10 update, 5 state, 3 decide |
| `patchmesh` | **14** — 7 recent_activity, 4 recap, 3 overlapping_work |

**11:1.** PatchMesh is 0.6% of all recorded tool calls: one voluntary question per ~395 events
it records.

### The cause is in our own text

The injected `SessionStart` context used to end:

> This recap is already in your context — call `patchmesh_recap` only for a different window,
> agent, or depth.

That is a stop instruction, and agents obey it. The three MCP tool descriptions had the same
shape: each described *what the tool returns* rather than *when to call it*, and `recap`'s
description repeated the suppression verbatim.

Knowl's advantage is not better data. `KNOWL.md` makes a query a **precondition** of project
work, and a `UserPromptSubmit` hook restates it every turn. PatchMesh had richer data, a push
surface, and a closing sentence that told the agent not to ask again.

## Why it matters

- **PM-11** (the feedback loop has no input) is downstream of this. 14 calls will never produce
  a usable feedback sample; it is not blocked on its own design.
- **PM-10 A** (the displacement join) needs answers to join against.
- Every value claim about the pull surface is a claim about a tool that is effectively unused.

## Candidate solutions

### A. Copy Knowl — a mandatory-query contract plus a per-turn reminder

Proven: the 11:1 ratio *is* the evidence that it works, measured in this repository.

**Rejected as the primary fix.** It taxes every turn with tokens for data that is not relevant
every turn — memory is, "who else is in this file" is not — and it is a prompt fix that only
works for hosts that read our file.

### B. Tool descriptions lead with the trigger — **shipped 2026-08-24**

A tool description is always in context, in every MCP client, at zero marginal cost. It was
being spent on a summary of the return value.

All three now open with the condition, in the imperative:

- `patchmesh_recent_activity`: *"Call this before your first edit to a file, with that file's
  `path`."* — plus the reason no other source can answer it: work in flight is not in git yet.
- `patchmesh_overlapping_work`: *"Call this before starting a batch of edits, and before
  continuing work another agent may already have moved."*
- `patchmesh_recap`: *"Call this when you need history the session-start context did not
  cover"* — and it now states that edge concretely (one day, five tasks) instead of telling the
  agent not to call.

### C. The injected recap names a trigger instead of a stop — **shipped 2026-08-24**

`asAdditionalContext` now closes with:

> Before your first edit to a file, ask `patchmesh_recent_activity` for that `path`: work in
> flight is not in git yet, so nothing else can tell you another agent is already in it.
>
> This recap covers one day, five tasks deep. `patchmesh_recap` reaches past that edge, and
> `patchmesh_overlapping_work` names what two workers are both changing.

Same length, no suppression, and it states the edge of what was pushed so the agent can tell
when it has reached it.

### D. Stop needing pull at all — the `PreToolUse` advisory (PM-02)

When an agent is about to edit `F`, inject "agent X was in `F` 12 minutes ago". No remembering,
no contract, and no token cost on turns where nothing is contended. **This is the real fix**,
and it makes PM-13 moot rather than solved. Wave 2, unchanged.

### E. Accept it — declare PatchMesh push-only and delete the pull tools

Honest, and it shrinks the surface. Premature while B and C are one day's work and untried.

## Recommendation

B and C shipped. D remains the answer. **If the ledger-derived adoption rate does not move
materially within a week of ordinary use, that is strong evidence for E** — and the measurement
that decides it is PM-15's, which is why PM-15 had to land in the same change.

## How to check whether it worked

```
patchmesh recap --metrics
```

The adoption block reports PatchMesh calls against all attributed tool calls and against every
other MCP server the same sessions used. The baseline this change is measured from, taken
immediately before it shipped:

```
Sessions:          21, of which 5 asked PatchMesh at least once
PatchMesh calls:   15 of 2306 attributed tool call(s)
One ask per:       154 tool call(s)

  knowl                          155 call(s)  across 15 session(s)
  patchmesh                       15 call(s)  across 5 session(s)
```
