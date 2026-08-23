# PM-10 — The net-token invariant rests on an estimate

- **Status:** `partial` — option B shipped and baseline frozen 2026-08-23
- **Severity:** medium
- **Depends on:** PM-01

## Resolution (2026-08-23) — option B shipped, and the baseline is frozen

`patchmesh recap --metrics` (and `--json`) reports calls before an agent's first observed
change, per agent and as a median. `packages/query/src/resume.ts`.

**The baseline was captured before the `SessionStart` hook existed**, which was the whole
reason this went first: the control arm is destroyed by the fix. It is recorded in
[`docs/measurements/time-to-resume.md`](../measurements/time-to-resume.md) with the full
per-agent JSON beside it.

```
Median:            83 calls
Agents measured:   7        (175, 141, 84, 83, 77, 61, 36)
Never changed:     6
Window:            2026-08-18 to 2026-08-23, 3,781 events
```

Two design choices worth keeping:

- **Agents that never changed a file are reported apart from the median, not as zero.** "Never
  resumed" and "resumed immediately" are opposite results, and averaging them erases both.
- **Subagents are excluded by default.** A subagent is spawned to do one thing and starts
  changing files almost immediately, so counting them drags the median toward zero and
  flatters the number. The measure is about resuming a session; a subagent resumes nothing.

Option A (the displacement join) still needs a real post-PM-01 sample. Option D remains
rejected: bytes, not tokens.

---

## The problem

The delivery plan's exit bar is that context PatchMesh returns must be smaller than the
discovery it displaces, "published, not assumed". One measurement exists:

```
patchmesh_recap, 5 tasks   1,741 bytes  (~435 tokens)
git log --stat -5          9,572 bytes  (~2,393 tokens)   -> 5x
reading the 7 changed files 36,111 bytes (~9,027 tokens)  -> 20x
```

The cost side is observed. The displaced side is an **estimate of a counterfactual** — what
the agent *would* have read. Nobody knows whether it would have read all seven files, and
recap does not actually substitute for reading them, because it names which files changed
without saying what is in them.

n = 8 answers, all from one two-day window, none since.

## Why it matters

The headline number in the product's value story is a single observation against a guess.
It is plausibly on the right side of the invariant; it is not shown to be.

## Candidate solutions

### A. Replace the estimate with an observed join — recommended

`.patchmesh/answers.ndjson` already records tool, requested path, answer bytes, items
carried and items withheld. The missing half is what happened next.

> After an answer at time T naming file F, did the agent read F within the next N calls?
> **Yes** — the answer did not displace anything; it added cost.
> **No** — it plausibly displaced the read.

`displacement_rate` = fraction of answers *not* followed by the read they should have
replaced. Both sides then come from the ledger; no counterfactual is estimated.

- The data to compute it is already being recorded on both sides.
- Requires PM-01, because 8 answers is not a sample.

### B. Measure time-to-resume instead

Calls from session start to first `file.changed`. Current baseline, computed from the live
ledger: **median 84 calls** across 6 agents (61, 77, 83, 84, 141, 175).

- Needs no counterfactual at all, and wins on a single sequential agent — the workflow that
  actually exists here.
- Should be the headline metric. It is currently not computed by any PatchMesh command.

### C. Controlled A/B with hooks on and off

- The cleanest causal claim available.
- Re-running one task twice is contaminated: the second run already knows the answer. Needs
  matched task *pairs*, or one session archetype compared across days.

### D. Switch from bytes to tokens

- Deliberately rejected already: a tokenizer is a dependency and a version, and ~4 bytes per
  token is a stable proxy. Keep bytes; let whoever publishes the number convert.

## Recommendation

B as the headline, because it is computable today and needs no counterfactual — ship it as
`patchmesh recap --metrics` or a `doctor` line. A once PM-01 produces a real sample.
