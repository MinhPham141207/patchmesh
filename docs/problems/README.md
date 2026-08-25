# Problems

One file per problem PatchMesh currently faces. Each carries a status, the evidence it
rests on, and candidate solutions with their trade-offs.

Measured against the live ledger on 2026-08-24: 5,523 events, 21 sessions, 2,275 tool calls,
93 answers returned - of which 82 were the session-start hook's own injections and **14 were
an agent choosing to ask**. Recording is not the binding constraint and has not been for some
time; being asked is. See [PM-13](PM-13-pull-is-zero-and-the-recap-suppresses-it.md).

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `open` | Real, unaddressed, and actionable now. |
| `blocked` | Real and understood, but waiting on another problem being solved first. |
| `partial` | Mitigated but not closed; the residue is described in the file. |
| `structural` | Cannot be fixed within the current design; needs a redesign decision. |
| `resolved` | Closed. The file keeps the original diagnosis and adds what shipped. |

See [ORDER.md](ORDER.md) for the recommended sequence.

## Open problems

| # | Problem | Status | Severity |
| --- | --- | --- | --- |
| [PM-01](PM-01-nothing-consumes-the-ledger.md) | Nothing consumes the ledger | `resolved` | critical |
| [PM-02](PM-02-no-intervention-point.md) | Detection is post-hoc; nothing intervenes | `open` | high |
| [PM-03](PM-03-ledger-scope-is-per-worktree.md) | Ledger identity is per-worktree | `resolved` | high |
| [PM-04](PM-04-attribution-fails-under-concurrency.md) | Attribution degrades exactly under concurrency | `open` | high |
| [PM-05](PM-05-thirteen-event-types-never-produced.md) | 13 of 16 event types are never produced | `open` | high |
| [PM-06](PM-06-duplicate-work-undetectable.md) | Duplicate work — the founding claim — is undetectable | `blocked` | high |
| [PM-07](PM-07-stale-read-needs-an-undeclarable-contract.md) | Stale-read detection needs a contract hooks cannot make | `structural` | medium |
| [PM-08](PM-08-bash-opacity.md) | Most recorded traffic is opaque | `partial` | medium |
| [PM-09](PM-09-null-attribution.md) | 27% of events carry no task | `open` | medium |
| [PM-10](PM-10-invariant-rests-on-a-counterfactual.md) | The net-token invariant rests on an estimate | `partial` | medium |
| [PM-11](PM-11-feedback-loop-has-no-input.md) | The feedback loop has no input | `blocked` | low |
| [PM-12](PM-12-health-is-permanently-degraded.md) | Health is permanently `degraded` | `resolved` | low |
| [PM-13](PM-13-pull-is-zero-and-the-recap-suppresses-it.md) | Pull is zero, and the recap suppressed it | `partial` | high |
| [PM-14](PM-14-sessionstart-fires-in-bursts.md) | `SessionStart` fires in bursts, re-serving the same text | `partial` | medium |
| [PM-15](PM-15-answers-log-is-not-a-call-counter.md) | `answers.ndjson` is not a call counter | `resolved` | medium |
| [PM-16](PM-16-the-cache-could-never-hit.md) | The read cache could never hit | `resolved` | medium |

### Shipped 2026-08-23 (Wave 0 of [ORDER.md](ORDER.md))

| Item | What landed |
| --- | --- |
| PM-10 B | `patchmesh recap --metrics`; baseline frozen at **median 83 calls** in [docs/measurements](../measurements/time-to-resume.md) before the hook existed |
| PM-12 + PM-08 B | Health split from coverage; coverage is a rate, not a verdict; opaque-but-bound calls stop counting as gaps |
| PM-03 | `workspaceId` derives from the shared ledger root; multi-writer contention now tested |
| PM-01 A | `SessionStart` injection — contention first, then recap; measured as an answer, bounded to 4 KB, always exit 0 |
| PM-05 C, PM-07 D | Unreachable event types and the structurally blocked detector marked at the source |
| PM-02 precondition | `overlaps` gained a real concurrency test, a labelled field corpus and a quality gate — precision 0.35 → 1.0. See [overlap-precision](../measurements/overlap-precision.md) |

**PM-01 is installed and verified** — `patchmesh doctor` reports all 6 hooks installed. The
`SessionStart` hook injects the recap and, when there is any, leads with the files another
worker was recently in flight over.

### Shipped 2026-08-24 (Wave 1a - the measurement wave)

Prompted by an audit of how much agents actually rely on the MCP surface. Ordered so the
instrument landed before the treatment: PM-15 had to be trustworthy before PM-13's change
could be judged by it.

| Item | What landed |
| --- | --- |
| [PM-16](PM-16-the-cache-could-never-hit.md) | `readWindowCached` buckets the window boundary so a relative window can share a read. 7-day recap **606ms -> 186ms**, 7-day recall **498ms -> 33ms**. Ships with a hit counter. |
| [PM-14](PM-14-sessionstart-fires-in-bursts.md) B | Per-session injection digest; an identical repeat inside 5 minutes is suppressed, a later one is not. The matcher is left alone pending the new `trigger` data. |
| [PM-15](PM-15-answers-log-is-not-a-call-counter.md) | Adoption now derived from the ledger, not `answers.ndjson`. Rows gained `source`, `agentId`, `trigger`, `ok`; failures are recorded; `PATCHMESH_MEASURE=0` opts out. |
| [PM-13](PM-13-pull-is-zero-and-the-recap-suppresses-it.md) B+C | All three tool descriptions and the injected recap now lead with **when to call**, not what is returned. The "call this only for a different window" stop instruction is gone. |
| [PM-10](PM-10-invariant-rests-on-a-counterfactual.md) | `recap --metrics` splits control vs treatment **by default** and states plainly when an arm is too thin to compare. |

### Shipped 2026-08-25

Found by re-judging the product against the live ledger rather than against its tests.

| Item | What landed |
| --- | --- |
| [PM-17](PM-17-reports-answer-about-the-last-stop.md) | `freshenLedger`: every report drains the journal before reading, so it answers about now rather than about the last `Stop`. Free when nothing is pending (0.13-0.97ms), bounded at 500 entries, fail-open. `doctor` deliberately abstains. |
| [PM-18](PM-18-nothing-budgets-the-ledger.md) | `doctor` reports ledger size always and warns past 64MiB, naming `prune` rather than running it. |

## Closed, recorded so they are not re-litigated

| Problem | Closed by |
| --- | --- |
| Journal persisted raw hook payloads including secrets | `packages/recorder/src/redact.ts` key whitelist, applied before the first disk write |
| Interrupted drains stranded `.processing` files forever | `adoptStaleClaims` in `packages/recorder/src/ingest.ts:371` |
| One checkout produced two worktree identities by path spelling | `ee99104`, guarded by `f19b044` |
| Work-graph projection was O(n log n); CLI hung at 1,100 events | Single-pass `buildProjection`; `status` 40.4s to 1.5s |
| Closed five-member `ToolName` enum could not express real host tools | `other` plus `hostToolName`, additive and backward compatible |
| Packages were private and unpublishable | 10 packages live on npm at 0.1.1 |
