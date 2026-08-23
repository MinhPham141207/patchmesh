# Overlap precision — separating contention from sequence

**Measured 2026-08-23 against this repository's own ledger (3,781 events, 18 agents, 63 tasks).**

`findOverlappingWork` is the only detector in PatchMesh that fires on hook-recorded data, and
until this change it was the only one with no precision measure. This file records what it was
doing, what it does now, and what the number is allowed to be used for.

## The problem: the answer was the knob

An overlap was any file two distinct workers changed inside whatever window the caller passed.
Nothing tested that the two were working at the same time, so the result was a function of
`--within` rather than of the work:

| `--within` | overlaps reported (old rule) | (new rule) |
| --- | --- | --- |
| 30 min | 0 | 0 |
| 120 min | 9 | 0 |
| 480 min | 20 | 2 |
| 1440 min | 20 | 7 |
| 10080 min | 20 | 7 |

The old column saturates at 20 by eight hours and never moves again. Of those 20, **13 were
workers who had each stopped before the next began** — sequential edits to a popular file. A
sampled row read `apps/cli/src/args.ts` "changed by 8 tasks" across four agents over five days.
That is a frequently-edited file, not a collision.

Against the labels in `tools/phase2/overlap-corpus.ts` the old rule scores a precision of
roughly **0.35**.

## The rule now

Order the changes to a file. For a pair by different workers, ask whether the **earlier** writer
was still doing something after the **later** one wrote.

- **Yes** — both were in flight over the file and neither was working from a settled version.
- **No** — the first had finished and the second built on its work. That is collaboration, and
  reporting it is what made the command cry wolf.

The finding carries its own evidence, so the claim can be checked rather than trusted:

```
- `README.md` — two workers in flight, across 10 task(s) that changed it:
    ...
    why: agent_2478f630 wrote at 2026-08-22T16:21:30Z and was still working at
         2026-08-22T19:26:37Z, after agent_6e6c8445 wrote at 2026-08-22T19:19:56Z.
```

Files reclassified as sequential are counted and declared rather than silently dropped, so a
reader who remembers seeing twenty of them knows they were reclassified rather than lost.

### Two units that do not work, and why

Both were tried against the live ledger before settling on the rule above.

- **Intersecting task spans.** A task is one turn — median 228 seconds here. Two agents
  interleaving turns for an hour never intersect, so the rule reported **nothing at all**: 89
  candidate files collapsed to 0, including the pair independently recorded as genuine
  contention when it happened.
- **Intersecting agent-session spans.** Too wide in the other direction. One session in this
  ledger ran for 2.8 days, and everything intersects a span that long.

Last-activity against the other worker's write is the honest middle: it uses the interval where
the interval is real and the instant where the instant is real.

## The gate

`tools/phase2/overlap-quality-evaluation.ts` scores the rule against a labelled corpus and is
run by `pnpm check`.

```
truePositive  3      precision  1.0
falsePositive 0      recall     1.0
trueNegative  6      brier      0.003
falseNegative 0      FPR        0.0
```

Thresholds are `precision >= 1.0`, `recall >= 0.80`, `FPR <= 0.0` — deliberately stricter on
precision than the synthetic engineering gate and far more forgiving on recall. An advisory that
will one day interrupt an agent is judged by how often it is *wrong*: a missed collision costs
what it would have cost anyway, while a false one costs the reader's attention and teaches them
to stop reading. The rule is conservative and can only miss contention, never invent it, so
recall is where the slack belongs.

**The corpus caught a real bug on its first run.** `contentionAmong` counted an unattributed
change as a valid second party, so an unknown writer could manufacture a collision with whoever
happened to still be working. `hasDistinctWorkers` had always refused to do this; the new rule
had not inherited the refusal.

## What this number may and may not be used for

This is **field evidence, not field validation**. Every case is a real recorded row, which is
what makes it able to catch a rule that reports popularity instead of contention — but it is one
repository, one developer, nine labelled cases, and the labels are the author's.

- **Fair use:** as a regression gate, and as grounds for building the `PreToolUse` advisory
  (PM-02) on this signal at all.
- **Not fair use:** publishing a precision figure for other people's workloads, or treating the
  S5 exit bar as met. That bar wants a corpus accumulated from real dogfood use across
  detectors, which needs findings to be persisted first (PM-11).

## Cost

Contention needs `tool.requested` as well as `file.changed`, because a change is an instant and
contention is about intervals. `patchmesh overlaps --within 1440` runs in ~2.2–3.0s against this
ledger. The window still reaches SQLite, so the cost grows with the window asked for rather than
with total history.
