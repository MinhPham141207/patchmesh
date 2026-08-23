# PM-04 — Attribution degrades exactly under concurrency

- **Status:** `open`
- **Severity:** high

## The problem

Observed file changes bind to the call whose `[started, completed]` window contains the
file's mtime (`packages/recorder/src/effects.ts`). The binding rule is `soleCallCovering`:
it attributes only when **exactly one** call's window contains the change, and returns null
on ambiguity, leaving the change attributed to the turn instead.

The design is correct and deliberately conservative. Its consequence is that attribution is
sharpest when one agent works alone and blurriest when several work at once — the inverse of
where the product needs it.

Two cases produce ambiguity: two sessions active in one repository, and a subagent working
inside its parent's span. Both are the concurrency the product is for.

## Evidence

`patchmesh status` reports 1,005 null-attribution events of 3,674. `patchmesh recap` reports
402 calls belonging to no task. `patchmesh agents` shows four agents with
`(+unattributed)` alongside their task counts.

There is also a structural limit already recorded: overlap on a *single* file cannot be
produced inside one drain, because snapshot diffing sees final state — one file yields one
`file.changed` however many agents wrote it, and only the last mtime survives. Contention on
one file is only detectable across drains.

## Why it matters

An unattributed change is invisible to every task-scoped query. Under concurrency the
product both needs attribution most and has it least.

## Candidate solutions

### A. Narrow the ambiguity window with content hashing

Record a content hash per changed file at ingest. When two windows overlap, a hash that
matches one call's declared edit disambiguates without inference.

- Also unlocks PM-06 (duplicate detection) and rework detection. Highest joint value.
- Costs a read of each changed file at ingest — bounded, already stat-ing exactly those files.

### B. Rank by window tightness instead of demanding uniqueness

When several windows cover an mtime, prefer the narrowest, and record the attribution as
probable rather than certain.

- Recovers most of the lost attribution cheaply.
- Introduces a confidence notion the event schema does not currently have, and a wrong
  attribution is worse than a null one for a coordination claim.

### C. Nest subagent spans explicitly

The parent/child relationship is known from `agent_x.sub.y` ids. A change inside a child's
window should bind to the child, not be discarded because the parent's window also covers it.

- Removes one whole ambiguity class by rule rather than by inference. Low risk.
- Does nothing for the two-independent-sessions case.

### D. Per-file watcher with change-time events

Watch the worktree and emit `file.changed` at the moment of change rather than diffing at
ingest.

- Solves the single-file, multiple-writer limit that diffing cannot.
- A resident watcher is a daemon, with all the lifecycle cost the hook design was chosen to
  avoid. Large change; defer.

## Recommendation

C first — it is a rule, not a heuristic, and it removes a whole class. Then A, which pays for
itself across three problems.
