# PM-09 — 27% of events carry no task

- **Status:** `open`
- **Severity:** medium

## The problem

```
events                3,674
null attribution      1,005   (27%)
unattributed calls      402   (reported by recap)
agents with (+unattributed)   4 of 12 top-level
```

Four agents show `0 (+unattributed)` in `patchmesh agents` — every event they produced is
task-less. An event with no task is invisible to every task-scoped query, which is most of
the product's surface.

## Why it matters

`recap` ends with "402 call(s) belong to no task and are not summarized here." That line is
honest, and it is also a quarter of the corpus excluded from the summary that is supposed to
be the product's leading value.

## Causes, in order of size

1. **Turn boundaries do not always resolve.** Task identity comes from turn state; a session
   that ends abnormally, or one whose drain closes several turns at once, leaves calls
   unclaimed.
2. **Ambiguous effect binding falls back to turn, and a null turn means a null task**
   (PM-04).
3. **Sessions that never prompt.** Agents with 14-62 events and zero tasks look like
   short-lived or tooling sessions that produced calls without a user turn.

## Candidate solutions

### A. Backfill task attribution at ingest from correlation

Calls already carry a `correlation_id`. Where a correlation has exactly one task among its
events, propagate that task to the rest of the correlation.

- Rule-based, not heuristic — the validator already requires effects to match their
  completion's correlation, agent and task.
- Recovers a large share cheaply. Does nothing for correlations with no task at all.

### B. Synthesize a task per session as a floor

An agent with no task gets one covering its span, so nothing is unattributable.

- Guarantees full coverage, and makes `recap` describe everything.
- A synthetic task is not a real intention. Risks laundering "we do not know" into "task X",
  which is exactly the failure mode `stale` and `contracts` were fixed to avoid.

### C. Report attribution rate in `doctor`

Make the number visible so it stops being discovered by audit.

- Cheap, no recovery, high diagnostic value.

### D. Emit `task.completed` (see PM-05 B)

A real terminator makes turn resolution auditable rather than inferred.

## Recommendation

A, then C. Explicitly reject B — an unattributed call should stay unattributed. The product
is already good at declining to lie, and that property is worth more than a full-looking
report.
