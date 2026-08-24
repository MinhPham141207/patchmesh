# Concurrency harness — manufacturing labelled contention data

**Built 2026-08-24.** This file documents `tools/concurrency/`, which exists because
[the coordination premise had almost never been exercised](../problems/ORDER.md): the live
ledger held 7 genuine contention cases, ever, from a single agent pair
(`agent_2478f630` / `agent_6e6c8445`) across two days, because the author works one agent at a
time. Every precision claim and `IDLE_GAP_MINUTES = 30` itself rest on that sample of 7. This
harness cannot make more of that happen organically — it manufactures real, labelled contention
data instead, so the detector can be measured against more than seven data points.

## What it is not

It is not a way to validate PatchMesh against *real* agent behaviour. It proves the detector's
logic behaves as intended against constructed traffic that is deliberately shaped to probe it.
A corpus this harness produces can tell you **where the code's own rule draws its line** and
**whether that line is internally consistent** (a small idle gap alone isn't enough; a huge one
correctly excludes a worker who never came back). It cannot tell you what fraction of *real*
agent sessions would actually produce contention, what real idle-gap distributions look like, or
whether 30 minutes is the right number for real work. Only more real dogfooding, or a second
agent pair, answers that. Treat every number below as a statement about the code, not about
agents in general.

## How it works

`tools/concurrency/harness.ts` drives the same functions the shipped hooks call —
`appendJournalEntry`, `ingestJournal`, `recordTurnEffects` from `patchmesh-recorder`, then reads
the result back with `findOverlappingWork` from `patchmesh-query` — against a scratch git
checkout created fresh under the OS temp directory on every run
(`mkdtempSync(join(tmpdir(), "patchmesh-concurrency-"))`). Nothing about the recorder or query
code is modified or mocked:

- Every "write" action performs a real `fs.writeFileSync` to a real file in the scratch checkout,
  with content that changes every time, so the recorder's snapshot diff has genuine bytes to
  observe — not a fabricated `file.changed` row.
- Every recorded call goes through `appendJournalEntry` (the same journal format
  `patchmesh-record` writes) and `ingestJournal` (the same drain `patchmesh-ingest` runs),
  producing real, schema-validated `tool.requested` / `tool.completed` / `file.changed` events in
  a real SQLite ledger via `SqliteEventStore`.
- The result is read back with the *unmodified* `findOverlappingWork`, and separately with the
  real, unmodified `patchmesh overlaps` CLI pointed at the scratch ledger — see "Independent
  confirmation" below.

**The one controlled variable is time.** A real agent session can span hours; this needs to run
in seconds. `appendJournalEntry(journalPath, payload, at)` and
`recordTurnEffects({ ..., now })` both take their timestamp as an explicit argument rather than
always reading the wall clock — this is documented in `journal.ts` ("captured when the tool call
completed, not when it was later ingested") and is exactly the seam `ingestJournal` uses to make
hook-time timestamps survive into the ledger. The harness supplies every timestamp from a fixed,
arbitrary epoch (`2024-01-01T00:00:00.000Z` + minute offsets), not from `Date.now()`, so a run is
reproducible byte-for-byte regardless of when or how long it takes to execute. This is disclosed
in the manifest itself (`note` field) and nowhere else in the pipeline is anything faked: no
event is written directly to the ledger, no `file.changed` row is invented without a
corresponding real write, and no schema validation is bypassed.

### Safety

`assertScratchIsolation` runs before anything is written and refuses to proceed unless: the
scratch root resolves under the OS temp directory, the scratch root is not (and is not inside)
the real repository root, and the scratch root's *computed* ledger path
(`ledgerPathFor(scratchRoot)`) does not equal the real repo's `.patchmesh/ledger.db`. All three
are independent checks so that one failing silently isn't enough to reach the real ledger.

## Running it

```
node_modules/.bin/tsx tools/concurrency/harness.ts            # keeps the scratch checkout
node_modules/.bin/tsx tools/concurrency/harness.ts --clean    # deletes it after printing results
```

It prints a pass/fail table for the cases that carry an asserted ground truth, then a table of
detector verdicts across the idle-gap sweep, then writes the full manifest to
`tools/concurrency/output/last-run-manifest.json`. With no `--clean`, it also prints the scratch
ledger's path and a ready-to-run `patchmesh overlaps` command against it, so the result can be
inspected with the actual CLI rather than only through the harness's own summary.

## The manifest format

Each entry in `manifest.cases` is one constructed scenario (see `tools/concurrency/scenarios.ts`
for the authoritative types):

```jsonc
{
  "caseId": "positive-tight-interleave",
  "kind": "positive-interleaved",          // or negative-large-gap-and-stopped,
                                            // negative-small-gap-but-stopped, boundary-probe
  "file": "notes/shared-plan.md",          // unique per case
  "workers": [{ "label": "A", "sessionId": "harness-p1-agent-a" }, ...],
  "actions": [
    { "worker": "A", "offsetMinutes": 0, "kind": "write", "atIso": "2024-01-01T00:00:00.000Z" },
    // ...
  ],
  "groundTruth": "contended",              // "sequential" | "undetermined"
  "constructedGapMinutes": 30,             // only set on boundary-probe cases
  "description": "..."
}
```

`manifest.results` joins each case to what the detector actually said, by that case's unique
file path: `detectorVerdict` (`"flagged" | "sequential" | "no-signal"`) and, when flagged, the
real `ContentionEvidence` object `findOverlappingWork` produced (the same shape rendered in
`patchmesh overlaps`' `why:` line).

### Why `groundTruth` is sometimes `"undetermined"`

This is the harness's central discipline. `groundTruth` is asserted from **how the case was
constructed** — which workers were actually active when, by the harness's own script — never by
re-running the detector's idle-gap / still-going-afterward formula on the same data. Doing the
latter is the exact circularity a prior audit found in `tools/phase2/overlap-corpus.ts`: that
corpus labelled cases using `contentionAmong`'s own rule, so its reported 1.0 precision measured
conformance to the rule, not the rule's validity.

For the four "clear" cases, ground truth is genuinely independent of the formula: a case built as
a cold hand-off (agent stops for good, the other starts three hours later) or a tight interleave
(both agents visibly still working around each other's writes) is unambiguous by construction,
whatever threshold the detector happens to use.

For the nine boundary-probe cases, no such independent fact exists — the harness holds "the
earlier worker is demonstrably active both before and after the later write" constant and varies
only the idle gap before the write (5, 15, 25, 29, 30, 31, 35, 45, 90 minutes). Whether a
25-minute gap should count as "still working" is precisely the question `IDLE_GAP_MINUTES` answers
by assertion; a harness that assigned these a ground-truth label would just be asserting the
answer back at itself. So probes carry `"undetermined"` and are reported as raw
gap-to-verdict pairs, not scored.

## What one run actually produced

Run 2026-08-24, `tools/concurrency/harness.ts` (default, ledger kept):

```
patchmesh-concurrency-harness: 54 tool call(s) ingested, 27 file.changed event(s) observed
IDLE_GAP_MINUTES = 30

Clear cases (ground truth asserted independently of the detector):
  [MATCH] positive-tight-interleave: expected contended, detector said flagged
  [MATCH] positive-background-owner: expected contended, detector said flagged
  [MATCH] negative-cold-handoff: expected sequential, detector said sequential
  [MATCH] negative-warm-handoff: expected sequential, detector said sequential
  4/4 matched.

Boundary probes (no ground truth asserted -- reporting where the constant flips the verdict):
  gap=5min -> flagged
  gap=15min -> flagged
  gap=25min -> flagged
  gap=29min -> flagged
  gap=30min -> flagged
  gap=31min -> sequential
  gap=35min -> sequential
  gap=45min -> sequential
  gap=90min -> sequential
```

All four clear cases matched their independently asserted ground truth, including
`negative-warm-handoff` — the case built specifically to fail if the detector judged contention
from idle-gap size alone (a 5-minute gap, well under the 30-minute allowance, but the earlier
worker never acted again). The boundary sweep shows the flip landing exactly where the source
says it should: `idleGapMs > IDLE_GAP_MINUTES * 60_000` excludes anything strictly greater than
30 minutes, so 30 minutes itself is included (flagged) and 31 is not. This is now measured,
not merely read out of the source.

### Independent confirmation via the real CLI

The manifest and the harness's own pass/fail table both come from the harness calling
`findOverlappingWork` directly. As a check against relying on only that one code path, the same
scratch ledger produced above was also queried with the unmodified, already-published
`patchmesh overlaps` CLI (`apps/cli/dist/main.js`), pointed at the scratch ledger with a
`--within` wide enough to reach the fixed 2024 epoch:

```
node apps/cli/dist/main.js overlaps --database "<scratch>\.patchmesh\ledger.db" --within 1391655
```

Output (abridged to the counts — full text matched every file above):

```
7 file(s) in this repository were changed by two workers at once, in the last 966.4d:
- docs/boundary-30m.md ... (last seen 30m before that write)
- docs/boundary-29m.md ... (last seen 29m before that write)
- docs/boundary-25m.md ... (last seen 25m before that write)
- docs/boundary-15m.md ... (last seen 15m before that write)
- docs/boundary-5m.md  ... (last seen 5m before that write)
- config/settings.json ... (last seen 3m before that write)
- notes/shared-plan.md ... (last seen 3m before that write)
6 further file(s) were changed by two workers in sequence and are not reported as contention.
```

7 flagged (2 clear positives + boundary gaps 5/15/25/29/30) and 6 sequential (2 clear negatives +
boundary gaps 31/35/45/90) — exactly the harness's own tally, produced by a second, independent
code path (the shipped CLI binary, with no test-only options) reading the same ledger. This is
the strongest evidence available that the harness's writes are real recorder output, not an
artifact of how the harness itself queries them.

## Limits, stated plainly

- **This is staged traffic, not organic dogfooding.** Every session, every gap, every file was
  chosen by the harness. It demonstrates the detector's logic is internally consistent and that
  the 30-minute boundary behaves as documented; it does not demonstrate that 30 minutes is the
  right number for how real agents actually work, because no real agent produced this data.
- **Overlap on a single file within one drain is still structurally undetectable** — this
  harness does not attempt it, for the same reason a prior investigation found it impossible:
  snapshot diffing sees final state, so one file yields one `file.changed` however many workers
  wrote it inside one drain. Every contended case here spans at least two drains, which is the
  only shape of contention this architecture can ever see.
- **The manifest's "clear" ground truth is only as good as the four cases chosen.** Four
  scenarios is enough to catch the specific circularity and idle-gap-alone failure modes this
  harness was built to probe; it is not a statistically powered test suite, and a `4/4` match is
  a sanity check on the code, not a precision estimate.
- **Boundary probes report, they do not judge.** Nine points is enough to locate where the
  current constant flips; it says nothing about whether that is the *right* place, which needs
  real gap distributions this harness cannot supply.
