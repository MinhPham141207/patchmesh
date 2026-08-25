# Order of work

Sequencing for the twelve problems in this directory. Ordered by dependency and
information gain, **not** by severity — severity ranks pain, order ranks what unblocks
learning.

> **Status: Wave 0 shipped 2026-08-23. Wave 1a and Wave 1b shipped 2026-08-24. PM-17 and PM-18
> shipped 2026-08-25.** PM-10 B, PM-12, PM-08 B, PM-03 and PM-01 A are done, along with the free
> documentation items. Wave 1a - PM-16, PM-14 B, PM-15, PM-13 B+C and PM-10's default output -
> closed the measurement gap that Wave 0 opened. Wave 1b took PM-02 A most of the way and made
> the overlap gate falsifiable. PM-17 closed a freshness gap that sat underneath all of them:
> every report answered about the last `Stop` rather than about now, so a session's own work was
> invisible for its whole duration. Wave 1 proper (content hashing, PM-09) is next.
>
> **PM-17 was not on this list, and that is the point.** It was found by re-judging the product
> against the live ledger rather than against its tests, which were green throughout. A problem
> file cannot be sequenced before somebody notices the problem.

## The constraint that decided the first step

**PM-10's baseline had to be captured before PM-01 shipped.** It was:
[docs/measurements/time-to-resume.md](../measurements/time-to-resume.md).

Time-to-resume is the control arm. The moment a `SessionStart` hook starts injecting recap
into every session, every session is contaminated and the un-instrumented baseline can never
be measured again. It has been computed ad-hoc — median **84** calls before an agent's first
`file.changed`, across 6 agents (61, 77, 83, 84, 141, 175) — but that is a scratch query
against the ledger, not a recorded artifact.

So the first thing to do is not the most important thing. It is the thing that expires.

---

## Wave 0 — capture the baseline, then open the gate — **DONE 2026-08-23**

| Step | Item | Outcome |
| --- | --- | --- |
| 1 | [PM-10](PM-10-invariant-rests-on-a-counterfactual.md) B — time-to-resume as a command | Shipped. Baseline **median 83 calls**, frozen in [docs/measurements](../measurements/time-to-resume.md) before step 4 existed. |
| 2 | [PM-12](PM-12-health-is-permanently-degraded.md) + [PM-08](PM-08-bash-opacity.md) B — split health from coverage | Shipped. `Health: healthy`, `Coverage: 10% (180/1788 scopes) observational`. |
| 3 | [PM-03](PM-03-ledger-scope-is-per-worktree.md) — workspace identity + concurrency test | Shipped. **Moved up from Wave 1**: the ledger-path half was already built, leaving a one-line identity change. |
| 4 | [PM-01](PM-01-nothing-consumes-the-ledger.md) A — `SessionStart` recap injection | Shipped. 1,491 bytes injected, ~2.0–2.4s per session start, always exit 0. |

Free items [PM-05](PM-05-thirteen-event-types-never-produced.md) C and
[PM-07](PM-07-stale-read-needs-an-undeclarable-contract.md) D done at the same time.

> **Why PM-03 moved.** `ledgerRootFor` already reduced linked worktrees to one shared ledger
> before this file was written, so PM-03's central claim was stale. What remained was that
> `workspaceId` still hashed the per-worktree path, which blinded the workspace-scoped
> detectors across worktrees. That is a one-line change plus a contention test, so it belonged
> before the hook rather than after it.

**Installed and verified.** `patchmesh doctor` reports all 6 hooks installed and `PatchMesh is
recording.` The hook injects the recap and leads with contention when there is any — see
PM-01's resolution note.

## Wave 1a — measure the thing Wave 0 shipped — **DONE 2026-08-24**

Wave 0 opened the consumption gate and then could not say whether anything came through it.
An audit of agent reliance found the pull surface unused (14 lifetime calls against the memory
server's 152), the push surface firing in bursts, the file that counted both untrustworthy,
and the read cache structurally unable to hit. Four problems, one root cause between them:
**nothing that measured PatchMesh was itself trustworthy.**

The ordering constraint is the same one that put PM-10 B before PM-01 A. **PM-15 had to land
before PM-13**, because PM-13 is a change whose only evidence of working is a number PM-15
produces. Shipping the treatment before fixing the instrument would have made the result
unreadable in exactly the way PM-10's pooled median already was.

| Step | Item | Outcome |
| --- | --- | --- |
| 1 | [PM-16](PM-16-the-cache-could-never-hit.md) — bucket the window boundary | Shipped. 7d recap 606ms -> 186ms, 7d recall 498ms -> 33ms. First, because nothing depends on it. |
| 2 | [PM-14](PM-14-sessionstart-fires-in-bursts.md) B — per-session injection digest | Shipped. Stops the burst polluting the counter about to be trusted. |
| 3 | [PM-15](PM-15-answers-log-is-not-a-call-counter.md) — the instrument | Shipped. Adoption from the ledger; `source`/`ok`/`agentId`/`trigger`; `PATCHMESH_MEASURE=0`. |
| 4 | [PM-13](PM-13-pull-is-zero-and-the-recap-suppresses-it.md) B+C — trigger-led descriptions | Shipped. The cheap experiment, now measurable. |
| 5 | [PM-10](PM-10-invariant-rests-on-a-counterfactual.md) — split by default | Shipped. Says "not yet comparable" instead of printing a misleading median. |

**What Wave 1a deliberately did not do:** narrow the `SessionStart` matcher (PM-14 A), because
nothing had recorded which source fires it — that data now exists. And PM-13 D, the
`PreToolUse` advisory, which is the real fix for pull being zero and stays in Wave 2.

**The open question Wave 1a hands forward.** PM-13 B+C is an experiment, not a solution. If
adoption does not move materially within a week of ordinary use, the honest conclusion is that
PatchMesh is a push product and the pull tools should be reconsidered rather than re-marketed.
The baseline to measure against is in PM-13.

## Wave 1 — make the data support a claim

- **Content hashing** — the shared change behind
  [PM-04](PM-04-attribution-fails-under-concurrency.md) A and
  [PM-06](PM-06-duplicate-work-undetectable.md) A. One implementation, three problems
  (disambiguation, duplicate detection, rework detection).

  > **Check first:** `file.changed` payloads already carry
  > `beforeVersion`/`afterVersion` with `kind: "content_hash"` and a real digest. The hash may
  > already exist, in which case this is a query change rather than an ingest change. Verify
  > before building anything.

- **[PM-04](PM-04-attribution-fails-under-concurrency.md) C** — nest subagent spans. Do this
  first within the wave: it is a rule, not a heuristic, and it removes a whole ambiguity class.
- **[PM-09](PM-09-null-attribution.md) A** — correlation backfill, plus C (report the rate in
  `doctor`). Cheap, and it directly improves the recap quality now in front of every session.

## Wave 1b — say something near the write, and make the gate able to fail — **DONE 2026-08-24**

Four packages in parallel, partitioned by directory so no two workers shared a file.

| Item | Outcome |
| --- | --- |
| [PM-02](PM-02-no-intervention-point.md) A — contention advisory | **Partial.** Detection ships and is cheap. Delivery moved from before the write to one call after it. |
| [PM-02](PM-02-no-intervention-point.md)'s precision claim | Corpus relabelled from content hashes. Precision **1.0 -> 0.667** (n=8). The gate can now fail. |
| Concurrency data | `tools/concurrency` manufactures real labelled contention. `IDLE_GAP_MINUTES` confirmed inclusive at exactly 30. |
| [PM-15](PM-15-answers-log-is-not-a-call-counter.md) residue | `recordAnswer` removed from the MCP surface. One adoption source remains. |

> **Why PM-02 A is partial, and what it cost.** The advisory was built for `PreToolUse` and
> works there, but the host has **no non-blocking channel from `PreToolUse` to the model**:
> `allow`'s reason is user-transcript-only, and `deny`/`ask` both block — which this file rules
> out until the advisory has a measured false-positive rate. So delivery runs through
> `PostToolUse` `additionalContext`, which does reach the model. That is one tool call *after*
> the write rather than before it. It is a real weakening of the intent and it is recorded as
> such; it is still far earlier than Stop-time ingest plus a voluntary call. The `PreToolUse`
> path is kept intact and unmodified, so it is already correct if the host gains such a channel.

> **The relabelling found a defect, and it was not fixed here.** `apps/cli/test/cli.test.ts` —
> the widest gap any positive rested on, at 15.6 minutes — is a **hash-verified clean handoff**:
> the later write's `beforeVersion` is byte-identical to the earlier write's `afterVersion`, with
> nothing between them. `contentionAmong` flags it only because 15.6 < 30. That is n=1 on the
> disagreeing side, so it does not prove 30 is wrong. It proves the constant was tuned against a
> corpus that restated the detector's own rule and had never been checked independently.
> Whoever next touches `overlap.ts` owns this.

> **A limit on the new labels, stated plainly.** Content-hash chains never break between adjacent
> real writes in this ledger, because the observer serialises one working tree. So a hash mismatch
> mostly means other writes intervened, not that a destructive clobber occurred. The label is
> genuinely independent of the detector's timing rule — which was the point — but it is weaker
> evidence of interference than "clobber" suggests.

## Wave 2 — actually say it before the write

- **A turn-start advisory on `UserPromptSubmit`** — **DONE 2026-08-24.** Its `additionalContext`
  reaches the model and fires before the turn's first tool call, so this is the first thing
  PatchMesh says before a write rather than after one. Repository-wide rather than per-file,
  because `UserPromptSubmit` carries no `tool_input` to match a path against. Silent when
  nothing is in flight. Complements the per-edit `PostToolUse` check; it does not replace it.

  > **It needed no host configuration change.** `UserPromptSubmit` was already wired to the
  > recorder binary by `patchmesh init`, as the turn boundary that gives ordinary work a task —
  > so this was a decision inside an invocation that already happened, exactly as the
  > `Pre`/`PostToolUse` advisories were. The assumption that it required a new hook was wrong.
  > All three advisory stages now ride hooks that were already installed.

- **[PM-07](PM-07-stale-read-needs-an-undeclarable-contract.md) A** — the time-based staleness
  reframe. Still one feature with the advisory, and it now has a delivery channel to ride on.
- **Re-examine `IDLE_GAP_MINUTES`** against `tools/concurrency` and the hash-verified corpus,
  which between them are the first evidence about the constant that is not circular.
- Option B (blocking) stays out. It needs a measured false-positive rate in the wild, and
  `adoption.ts` now shows how little the surface is exercised.

## Wave 2b — coordination realness — **DONE 2026-08-25**

Six slices from [the coordination-realness spec](../superpowers/specs/2026-08-25-coordination-realness-design.md),
each shipped green on main. The motivating measurement: the in-flight-window advisory predicate
fired **zero times** over a full session of genuine two-agent contention, so P1 replaced it with
a recent-write predicate plus a per-session delivery cursor.

| Slice | Commit |
| --- | --- |
| P5 — recap liveness | `a7e2b63` Recap reports task liveness instead of closing open tasks |
| P1 — recent-write reader + delivery cursor | `f03fe67` Add the recent-write reader and per-session delivery cursor |
| P1 — all three advisory stages rewired | `78f8db3` Advisories fire on recent cross-agent writes, delivered once per session (acceptance: `4bded7e`) |
| P2/P4 — opaque in-flight calls counted, not guessed | `8839971` Overlap answers count opaque in-flight calls instead of ignoring them |
| P3 — declared-path binding + attribution labels | `1d02a38` Bind changes by declared path first, and label every change's attribution basis |
| P6 — provenance follows the host | `2534429` Recorder provenance resolves its host instead of hardcoding Claude Code |

PM-02 closes as resolved on the strength of the acceptance test
(`packages/recorder/test/contention-acceptance.test.ts`); PM-08 stays partial with its accepted
scope now live.

## Wave 3 — make detectors produce findings

- **[PM-05](PM-05-thirteen-event-types-never-produced.md) A** — analyzer-derived symbol and
  dependency events at ingest. Makes `contracts` the first working detector.
- **PM-05 B** — emit `task.completed` from turn boundaries.
- **[PM-11](PM-11-feedback-loop-has-no-input.md) A** — persist findings, so `feedback`
  finally has input.

## Wave 4 — close the measurement loop

- **PM-10 A** — the observed displacement join (did the agent read the file the answer
  named?). Genuinely needs a real sample, which only exists months after PM-01.

## Free — done 2026-08-23

**PM-05 C** and **PM-07 D**: the unreachable event types are marked above `Phase1InputEvent`
in `packages/protocol/src/events.ts`, and the structurally blocked detector is marked in
`packages/core/src/stale-read-before-write.ts`.

---

## Explicitly not yet

- **PM-06 in full.** It is the founding claim and the wrong thing to build third. It is
  `blocked`, expensive, and its prompt-capture half has an unanswered privacy question. The
  hashing slice in Wave 1 buys the cheap majority; stop there until PM-01 shows whether
  anyone wants the rest.
- **PM-02 B — blocking `PreToolUse`.** Not until the advisory version has a measured
  false-positive rate. PM-04 says attribution is weakest under exactly the concurrency that
  would trigger a block.

## If only three things get done

**PM-10 B, then PM-03, then PM-01.** Baseline, coordination substrate, gate. All three shipped
2026-08-23; everything below them is now easier to prioritise.

**Next three:** PM-09 A (cheap, improves what every session now sees), PM-04 C (a rule, removes
an ambiguity class), then the PM-02 + PM-07 A advisory — which is the first change that makes
PatchMesh say something before a write rather than after it.
