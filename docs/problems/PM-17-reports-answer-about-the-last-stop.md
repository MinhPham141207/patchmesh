# PM-17 — Every report answered about the last `Stop`, not about now

- **Status:** `resolved` 2026-08-25
- **Severity:** high

## The problem

Recording and reading disagreed about when work becomes visible, and nothing said so.

The `PostToolUse` hook appends every call to `.patchmesh/journal.ndjson` immediately. `ingest`
drains that journal into the ledger on `Stop`. Every report — `recap`, `overlaps`,
`recent_activity`, `status`, and the `SessionStart` injection — read the **ledger**.

So a session's own work reached the readable side only after that session ended.

Measured live on this repository, 2026-08-25:

```
[OK] ledger:  8522 event(s), latest 2026-08-24T20:24:28.282Z
[OK] journal: 18 entr(ies) waiting for the next drain
```

The journal had been written to at `10:27Z` that morning. **The ledger was fourteen hours
behind the live file**, and `overlaps` reported, correctly and uselessly:

```
No file changes have been observed for this repository in the last 4h, so overlap cannot be
assessed. ... this may be a ledger that has not been written to yet.
```

on a day of continuous work.

## Why it matters

This is not a latency problem, it is a **scope** problem, and it lands hardest on the one
surface that gets used.

- **The window in which contention can still be acted on is exactly the window the ledger
  could not see.** `overlapping_work` exists to say "somebody else is in this file". Two agents
  working concurrently are both mid-session by definition, so neither one's calls were in the
  ledger while the answer mattered. Live contention (added 2026-08-24) routes around this by
  reading the journal directly, but only for that one field of that one tool.
- **It degrades the push surface, which is the only one agents receive.** Adoption of the pull
  tools is one call per 183 (`recap --metrics`), so the `SessionStart` recap is effectively the
  whole product. A session-start recap that omits the previous session's last turn is the
  failure that matters most, and `SessionStart` is precisely the moment when the previous
  session has certainly stopped and its journal is complete.
- **It is invisible.** Nothing was broken, no check failed, and the reports were internally
  consistent. `doctor` reported the 18 pending entries as `[OK]`, which they are.

## The fix

`freshenLedger` (`packages/recorder/src/freshen.ts`): the read path drains the journal before
it reads. Called by all four MCP tools, the `SessionStart` binary, and the report commands.

Three properties make it affordable and safe:

- **Free when there is nothing to do.** The common case — a repeated read against an already
  drained journal — costs one `existsSync` and a small file read, measured at **0.13–0.97ms**.
  The expensive part is paid only when it would otherwise have produced a wrong answer.
- **Bounded.** A warm drain costs roughly **8ms per entry** (measured: 10 entries 132ms, 50
  entries 431ms, 200 entries 1,593ms). Past `FRESHEN_MAX_ENTRIES` (500, about four seconds) it
  declines and says so rather than making a report wait on a backlog. A backlog that large is
  a `doctor` problem, not something a report should silently absorb.
- **Fail-open**, like every other recorder path. A freshen that cannot run costs the caller
  nothing; a stale answer beats no answer, and a report that can be broken by its own
  bookkeeping gets turned off.

Concurrency was already handled beneath it: `ingestJournal` claims the journal by renaming it
aside, which is atomic, so a reader racing the `Stop` hook loses the claim and finds nothing to
drain. Both were going to do the same work.

### Two things that had to come with it

**`doctor` deliberately does not freshen.** It is the one command whose subject *is* the
undrained journal; draining first would erase the backlog it exists to report.

**A report pointed at a foreign `--database` does not drain either.** Freshening *consumes* the
journal. Doing that while reading a fixture, a copy, or another checkout's ledger would write
those calls where they do not belong **and** destroy them, so they could never reach the ledger
that wanted them. `ownsLedger` in `apps/cli/src/main.ts` gates it.

**The snapshot write became atomic.** `writeSnapshot` used a plain `writeFileSync`, which was
tolerable with one writer on the `Stop` path. Draining on read means a report and the `Stop`
hook can capture at the same moment, and a torn snapshot does not fail loudly — `readSnapshot`
treats an unparseable file as *no baseline*, which reports every file in the checkout as newly
created. It now writes aside and renames.

## Verification

Live on this repository, before and after, in the same minute:

```
BEFORE  ledger 8822 event(s), latest 2026-08-25T04:30:05.112Z   journal 3 entr(ies) waiting
        overlaps: "No file changes have been observed ... in the last 4h"

AFTER   ledger 8824 event(s), latest 2026-08-25T04:34:48.043Z   journal 1 entr(y) waiting
        overlaps: "... (10 file(s) observed changing)"
```

`recap` now names the *in-flight* session's own edits, which no report could see before.
`doctor` still reported the pending entries beforehand, confirming it does not drain.

Cost on the CLI is dominated by the command's existing baseline, not by the drain: `recap`
against an already-drained journal ran 2,469–3,026ms, and against a journal with entries
waiting, 2,715–4,582ms. The `SessionStart` binary ran in **683ms** with a near-empty journal —
the normal case, because `Stop` has usually already drained it. When `Stop` did not run,
freshen is the repair.

## The cost that had to be gated, found by measuring the MCP path

The first version of this ran the effects walk on every freshen, and that was a **10x
regression on the surface agents use**. Measured over stdio against the live server:
`patchmesh_recap` 122ms warm before, **1,674ms** after; `patchmesh_recent_activity` 33ms
before, **1,333ms** after.

`recordTurnEffects` costs **681-949ms on this repository even when it drains nothing and finds
nothing**, because it stats and content-hashes every tracked file and shells out to
`git check-ignore`. A CPU profile of it is **54% idle** - it is I/O bound, scales with the size
of the checkout rather than with how much happened, and will not optimise away. This is the
same wall `effect-detection-cannot-run-on-the-hook-hot-path` hit one level down.

So observation is opt-in, and the split is a real trade rather than a tuning knob:

- **The MCP tools leave it off.** An agent is told to call `patchmesh_recent_activity` before
  every edit, and PM-13's finding is that friction is exactly what keeps the pull surface at
  one call per 183. Buying freshness with a second per call would spend the adoption the
  freshness is for. Those tools still get current *calls*, and `overlapping_work` reads the
  journal directly for the in-flight contention that actually changes what an agent does next.
- **The CLI reports and `SessionStart` turn it on.** A person running `patchmesh overlaps` asks
  once and can afford the walk; `SessionStart` pays it once, when the previous session's
  changes matter most.
- **`Stop` remains the unthrottled path**, and is what binds observed changes to the call
  windows that caused them.

It is additionally gated on the drain having ingested something. The live journal always holds
at least the in-flight call that is doing the asking, so `pending > 0` is not a sufficient gate
on its own - and no new calls means no new call windows to bind changes to, so the walk could
only produce unattributed observations at full price.

After gating, over stdio: `initialize` 498ms, `recap` 436ms then **63ms warm**,
`recent_activity` **28ms** then **7ms warm**, `overlapping_work` **29ms**, `active_work` 47ms.
Better than the pre-change baseline, with fresher answers.

## What it does not fix

Reads are still invisible (PM-08), so freshening makes the *write* side current and leaves the
read side exactly as blind as it was. And a call that is still running has no completion to
ingest — in-flight work remains the journal's business, which is what `readInFlightCalls` and
live contention already do.
