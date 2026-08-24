# Overlap precision — separating contention from sequence

**Measured 2026-08-23 against this repository's own ledger** (rule construction, timing corpus).
**Relabeled 2026-08-24 against the live ledger at commit `6240502`** (independent outcome
evidence, this revision). Read the second measurement first — the first one's headline number is
not what it looks like.

`findOverlappingWork` is the only detector in PatchMesh that fires on hook-recorded data. This
file records what the rule does, what its previous precision number actually measured, and what
an honest measurement now says.

## The problem the rule fixes: the answer was the knob

An overlap used to be any file two distinct workers changed inside whatever window the caller
passed. Nothing tested that the two were working at the same time, so the result was a function
of `--within` rather than of the work — saturating at 20 files by eight hours, of which 13 were
sequential edits by workers who had each finished before the next began.

The rule now orders a file's changes and asks, for a pair by different workers, whether the
**earlier** writer was still doing something after the **later** one wrote (`IDLE_GAP_MINUTES =
30`). That fix is unrelated to what this document corrects and is not revisited here — see
`packages/query/src/overlap.ts` for the rule itself.

## What the old "precision 1.0 / recall 1.0" actually measured

The corpus that produced that number (`field-v2`, retired) assigned every label by asking: *was
the earlier writer still making calls after the later writer changed the file?* That is
`contentionAmong`'s own rule, worded identically. The corpus's `OBSERVED_ACTIVITY` map — the
input the labels were checked against — was the same session-activity data the rule itself reads.

**Precision 1.0 / recall 1.0 on that corpus proves the code implements the rule it was written to
implement. It says nothing about whether the rule tracks real contention.** `docs/problems/PM-02`
cited that number as "the signal is now calibrated," which the corpus never supported — a
tautology cannot calibrate anything, because it cannot fail. A gate that cannot fail is not a
gate.

This was not a case of the reported overlaps being wrong (a follow-up check confirmed the seven
files flagged live are genuine dense, simultaneous work — see the ledger note on session density).
The rule was fine; the *measurement* of the rule was circular.

## The fix: labels from content hashes, an independent signal

Every `file.changed` event carries `beforeVersion` and `afterVersion`, each a `content_hash` over
the file's real bytes, recorded by the filesystem observer — a signal `contentionAmong` never
reads. That gives an outcome question a timing heuristic cannot answer: **did the later writer's
`beforeVersion` equal the earlier writer's `afterVersion`?** If yes, the later write built on
exactly what the earlier one left, regardless of how the timing looked. If no, something else
reached the file first between the two compared writes.

`tools/phase2/overlap-corpus.ts` (`field-v3-hash-verified`) now holds only cases with a verified
hash comparison on both sides — real digests, pulled from the live ledger, checked against each
other and against the file's full recorded history so a mismatch can be explained rather than
just asserted. Cases with no independent signal to check against (one worker's own consecutive
turns, an unattributed second writer, and the constructed shapes that pin `IDLE_GAP_MINUTES` at
its boundary) moved to `detectorBehaviorRegressionCases` — still run as regression tests, but no
longer counted as field evidence. Folding them into the same array as the hash-verified cases is
part of what made `field-v2` look more validated than it was.

## The honest numbers

```
truePositive  2      precision  0.667
falsePositive 1      recall     1.0
trueNegative  5      falsePositiveRate  0.167
falseNegative 0      Brier      0.104
```

**n = 8.** Two hash-verified positives and one hash-verified false positive come from two agent
pairs; five hash-verified negatives come from three agent pairs on two files. This is smaller
than the nine cases `field-v2` reported, because four of those nine had no independent evidence to
check against and are no longer counted as field cases.

Thresholds moved from `precision >= 1.0, recall >= 0.80, FPR <= 0.0` to `precision >= 0.60, recall
>= 0.90, FPR <= 0.25, Brier <= 0.15` — set with a little room below/above the measured values, not
at them, because n=8 is small enough that one more verified case would move the ratio, and a
threshold pinned exactly at today's number invites being "adjusted" the next time it moves rather
than treated as a real regression. **These thresholds were not chosen to make 1.0 keep appearing.
The number really dropped, and the gate reflects that drop.**

## The one measured disagreement: content hashes say the widest-gap positive was clean

`field-v1`/`field-v2` already flagged `apps/cli/test/cli.test.ts` (agent_6e6c8445 →
agent_c460874d, 15.6-minute idle gap) as "the widest gap any positive rests on." Content hashes
now show why that phrasing was a warning: **agent_c460874d's write's `beforeVersion` is byte-for-
byte identical to agent_6e6c8445's write's `afterVersion`.** Zero writes intervened. This was a
clean, directly-adjacent handoff — not two sessions in flight over unsettled work — and
`contentionAmong` called it contention only because the 15.6-minute gap sits under
`IDLE_GAP_MINUTES = 30`.

**This is reported as a finding, not fixed here.** `packages/query/src/overlap.ts` is the detector
under test for this work; changing it while relabeling its corpus would reintroduce exactly the
circularity this rewrite closes. What this one case shows, precisely:

- A 15.6-minute silence, on this one measured instance, was not evidence of unsettled work.
- `IDLE_GAP_MINUTES = 30` was chosen (per its own doc comment) to sit "above every real decision
  point observed" in the *original* three-positive sample — a sample that, per this measurement,
  was itself two-thirds correct and one-third wrong. The threshold was tuned against a corpus that
  was not independently checked.
- With n=1 on the disagreeing side, this does not prove 30 minutes is the wrong number — it proves
  the number has never been checked against anything but its own logic until now, and the one
  check available says it produced a false positive here.

The other two originally-flagged positives (README.md, `packages/recorder/src/effects.ts`, both
agent_2478f630 → agent_6e6c8445) do **not** chain-match, but not because of a clobber between
those two agents: in both cases, several more writes by the *earlier* agent (continuing its own
session) and one unattributed write landed between the compared pair. The hash evidence is
correctly reported as "diverged" — the later writer did not build on that specific task's exact
output — but a reader should not read that as proof of a destructive collision. See each case's
`intervening` field in `overlap-corpus.ts` for exactly what happened.

## What this number may and may not be used for

This is **hash-verified field evidence from a single repository, single developer's session set,
and n=8**. It is a stronger claim than `field-v2`'s field evidence, because the labels no longer
come from the thing being scored — but it is still not field *validation*.

- **Fair use:** as a regression gate against further drift, and as documented grounds for
  treating `IDLE_GAP_MINUTES = 30` as unverified rather than calibrated.
- **Not fair use:** publishing a precision figure for other people's workloads, treating the S5
  exit bar as met, or citing 0.667 as *the* precision of the rule — n=8 with one disagreeing case
  is not enough to say the true rate is anywhere near that number with confidence. It is enough to
  say the true rate is **not proven to be 1.0**, which is the entire point of this document.

## Cost

Unchanged from the previous measurement: `patchmesh overlaps --within 1440` runs in ~2.2–3.0s
against this ledger, reaching SQLite for the window rather than scanning total history.
