# PM-15 — `answers.ndjson` is not a call counter, and anything local can write to it

- **Status:** `resolved` 2026-08-24
- **Severity:** medium — high for anything measured on it, which is every adoption claim the
  project makes.

## The problem

Three independent defects in one file, found on 2026-08-24 while trying to answer "how much do
agents rely on this".

### 1. It disagrees with the ledger, in both directions

Agent-initiated calls, `answers.ndjson` against `tool.requested` rows:

| tool | ledger requested | answers logged |
| --- | --- | --- |
| `patchmesh_recent_activity` | 7 | 4 |
| `patchmesh_recap` | 4 | 5 |
| `patchmesh_overlapping_work` | 3 | 2 |

Fewer *and* more. The undercount is defect 2; the overcount is a row whose `tool.requested`
event never reached the ledger.

### 2. Failures were invisible

The three tools fail soft — they return prose saying nothing was available rather than an MCP
error — and `recordAnswer` was called **only on the success path**. A call that errored left no
trace anywhere in this file.

### 3. Any local process could write adoption

There was no caller identity and no source. A latency probe of the MCP server run from a shell
wrote **26 rows** that were indistinguishable from an agent choosing to ask.

Worse, and found while fixing it: **our own test suite was doing the same thing.** The
session-start suite's fail-open cases deliberately pass a payload with no usable `cwd`, so the
hook falls back to the process working directory -- which, when running the tests, is this
recorded repository. Two of the four malformed payloads get far enough to record an answer, so
**every run of the gateway suite wrote two rows into the live `answers.ndjson`**. The test even
carried a comment acknowledging the fallback; nobody had followed it as far as the write.

And structurally: the hook's own injections were recorded with the same shape as agent calls,
so "88 answers" pooled 77 pushes with 11 pulls.

## Why it matters

Every adoption number, the PM-01 success claim, and PM-10's displacement join all rest on this
file. A metric that a benchmark run can inflate is not a metric.

## Candidate solutions

### A. Derive adoption from the ledger — **shipped**

The ledger already records every MCP call as a `tool.requested` row with the host's tool name,
attributed to a session, in order, **including the ones that failed**. It is the better source
and it was there the whole time. If the product cannot count its own calls from its own event
store, the event store is what needs fixing.

`packages/query/src/adoption.ts` reports:

- PatchMesh calls against **all** attributed tool calls, and the "one ask per N calls" rate
- sessions, and how many of them ever asked — the number a push surface exists to move
- per-tool counts with distinct sessions, so one enthusiastic session is not read as adoption
- **every other MCP server the same sessions used.** This is the point, not decoration: 14
  calls is small or large only against how often these agents call any tool of that kind.

Unattributed calls are excluded from both halves rather than only from the numerator —
counting them in the denominator alone would understate adoption on exactly the days
attribution was worst (PM-09).

### B. Say who asked and how — **shipped**

`AnswerMeasurement` gained `source` (`mcp` | `session_start` | `cli` | `probe`), `agentId`
where the surface knows it, and `trigger` for the hook. `MEASUREMENT_VERSION` is now **2**, so
a reader can tell a row that can name its caller from one that cannot.

### C. Record the failure path — **shipped**

Every `catch` in the gateway now records the call with `ok: false`. A call that happened is a
call that happened; whether it produced an answer is what the field is for.

### D. Let measurement opt out — **shipped**

`PATCHMESH_MEASURE=0` suppresses the write. Benchmarking the read path used to inflate the
adoption count it was benchmarking.

### E. Stop the test suite writing to the live log — **shipped**

`runHook` in `packages/gateway/test/session-start.test.ts` takes a `measure` flag, and the
fail-open cases run with `PATCHMESH_MEASURE=0`. Verified: a full gateway suite run now changes
the live file by **zero rows**, where it previously added two.

This is the argument for D in miniature. An opt-out is not a nicety for benchmarks; without
one, any code that exercises the read path contaminates the record of it.

## Resolution (2026-08-24)

All five. `answers.ndjson` is demoted from the adoption source to what it is good at: answer
size, item counts, withholding, and the record of when the hook first injected anything —
which is the only place the PM-10 treatment boundary exists, because the session-start binary
reads and never writes an event.

Adoption is now read from the ledger via `patchmesh recap --metrics`.

## Residue

- **The live file was cleaned.** 26 probe rows and 14 rows written by test runs were removed on
  2026-08-24, restoring it to the 93 rows that predate this work. A copy of the unfiltered file
  was kept outside the repository. Everything removed was written by this machine during this
  change; no agent-initiated row was touched.
- The one overcounted `patchmesh_recap` row (defect 1, the "more" direction) is not explained.
  A `tool.requested` event that never reached the ledger is a recorder question, not a
  measurement one; it is not pursued here.
- **Defect 3 recurred after this resolution: `source: "probe"` was added but nothing ever set
  it.** A 2026-08-24 re-judgment found 43 lifetime rows in `answers.ndjson` against 15 real
  calls in the ledger, including 30 rows from a benchmark of the gateway's stdio surface — the
  three `mcp`-source `recordAnswer` calls in `server.ts` still fired on every
  `patchmesh_recent_activity` / `patchmesh_overlapping_work` / `patchmesh_recap` call (and every
  failure), and MCP carries no caller identity, so a benchmark client and a real agent produced
  identically-shaped rows. Tagging the source was never going to fix this: there was no signal
  available at that call site to tag it with.

## Follow-up (2026-08-24, second pass)

Retired `recordAnswer` from the MCP surface entirely rather than trying to distinguish it
further. `server.ts` no longer imports `./measure.js` or calls `recordAnswer`/`recordFailure` at
any of its four former call sites — those rows duplicated what `patchmesh-query`'s `adoption.ts`
already counts correctly from the ledger, and could never be made trustworthy because the
protocol they ride on has no caller identity to attach. `AnswerSource` is narrowed from
`"mcp" | "session_start" | "cli" | "probe"` to the single value `"session_start"` (`"cli"` was
already dead; nothing ever produced it), so the type system now guarantees no future call site
can write an unattributable row.

What remains: the `SessionStart` hook's own `recordAnswer` call in `session-start-bin.ts`, which
is not a duplicate of adoption — it is the only record of when the hook first pushed context,
which `packages/query/src/resume.ts`'s `treatmentBoundaryFrom` needs for the PM-10 treatment
boundary and which the ledger cannot answer (the hook only reads). That call carries a real,
derived agent id and cannot be reproduced by probing the MCP surface. End state: one honest
adoption source (the ledger), and `answers.ndjson` narrowed to the one thing it alone can still
say truthfully.
