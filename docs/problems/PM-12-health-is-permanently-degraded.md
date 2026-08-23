# PM-12 — Health is permanently `degraded`

- **Status:** `resolved` 2026-08-23
- **Severity:** low

## Resolution (2026-08-23) — option A with option C's wording

- **Health describes the recorder.** `getStatus` no longer keys health off coverage; it is
  `degraded` only when replay finds a source sequence gap, which means events were actually
  lost. `status` and `doctor` now agree.
- **Coverage is a number.** `StatusView.coverage` gained `covered` and `total`, and `status`
  prints `Coverage: 10% (180/1788 scopes) observational`.
- **The verdict word is gone.** `observational` names the permanent, correct, expected state of
  a hook-recorded ledger. `degraded` is no longer reachable from coverage at all, so the word
  is available again for a real fault.
- Double-counting fixed at the same time via PM-08 B.

Before and after on the live ledger:

```
Health:            degraded            ->  healthy
Coverage:          degraded            ->  10% (180/1788 scopes) observational
Coverage gap:      opaque (1,460)      ->  opaque (1,407)
```

Option B (threshold the verdict against a repository's own baseline) was deliberately not
built. A rate that is visible and moves is enough to notice a regression by eye, and a moving
baseline can normalise a slow one.

---

## The problem

`patchmesh status` opens with:

```
Health:            degraded
Coverage:          degraded
Coverage gap:      opaque (1,414) ...
Coverage gap:      unattributed (201) ...
```

Meanwhile `patchmesh doctor` reports every check green and ends "PatchMesh is recording."

`degraded` is not describing a fault. It is describing the permanent, expected, correct state
of a hook-recorded ledger — Bash is opaque by design (PM-08) and some changes are genuinely
unattributable (PM-09). A status that is always `degraded` carries no information, and a user
who sees it on day one learns to ignore it, which is exactly when a real degradation would
need to be noticed.

## Why it matters

Two commands disagree about whether the system is healthy. The signal that could warn about
a real problem has been spent on a permanent condition.

## Candidate solutions

### A. Separate coverage from health — recommended

Health should mean "the recorder is functioning". Coverage should be reported as a
percentage, not a verdict. An opaque call whose effects were observed and bound is not a
gap at all (PM-08 B), so the count is overstated on top of being mislabelled.

- Small change, entirely in reporting.
- Makes `status` and `doctor` agree.

### B. Threshold the verdict

`degraded` only when coverage falls below a baseline the repository establishes over its
first N events.

- Restores information content to the word.
- A moving baseline can normalise a slow regression.

### C. Rename the state

Call it `partial` or `observational` — accurate, and it stops reading as a fault.

- Cheapest option; does not fix the double-counting.

## Recommendation

A, with C's wording. Report coverage as a number and reserve health for things `doctor`
would fail on.
