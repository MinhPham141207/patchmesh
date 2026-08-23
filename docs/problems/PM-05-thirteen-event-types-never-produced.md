# PM-05 — 13 of 16 event types are never produced

- **Status:** `open` — option C (documentation) done 2026-08-23
- **Severity:** high

## Option C done (2026-08-23) — the unreachable types are marked at the source

`packages/protocol/src/events.ts` now carries the audit above `Phase1InputEvent`: which three
types are produced, which ten are reachable but unemitted and by what route, and which three
are **structurally unreachable** from hook traffic (`file.read`, `symbol.read`,
`write.dependent`) with the reason. Marked rather than deleted, as recommended.

The remaining work is A (analyzer-derived symbol and dependency events) and B
(`task.completed`), both unstarted.

---

## The problem

The protocol defines sixteen event types. The live ledger contains three.

```
tool.completed   1,541
tool.requested   1,541
file.changed       592
```

Never written, ever: `file.read`, `symbol.read`, `symbol.changed`, `task.completed`,
`dependency.changed`, `attribution.corrected`, `evidence.derived`, `finding.created`,
`finding.feedback.created`, `write.dependent`, `decision.created`, `validity.changed`,
`decision.delivery.changed`.

## Why it matters

This single line is the ceiling on every detector in the product. `stale` is typed against
`file.read` and `write.dependent`; `contracts` against `symbol.changed` and
`dependency.changed`; `feedback` against `finding.created`. None of those inputs exist, so
those commands can never report anything (see PM-07, PM-11).

It also means the protocol was specified against an imagined runtime and the recorder was
later built against the real one, and the two have never been reconciled. That is the same
root failure that produced the closed five-member `ToolName` enum.

## Candidate solutions

### A. Derive symbol and dependency events at ingest — recommended, and already scoped

`packages/analyzers` can parse changed files off disk at ingest. Both
`ExportedContractChangeEvidence` and `ConsumerContractDependencyEvidence` are derivable by
direct observation of file content — no inference from shell commands, so the requested-path
inference ban is not touched.

- Turns `contracts` from permanently inert into the first working detector.
- Costs analyzer work at ingest, off the hook hot path, on a handful of changed files.
- Does not help `stale`, which is blocked structurally (PM-07).

### B. Emit `task.completed` from turn boundaries

Turn state is already persisted across drains and tasks already exist in `recap`. The event
is a projection of state the recorder already holds.

- Cheap, and it gives task-scoped queries a real terminator instead of inferring one.

### C. Prune the protocol to what is producible

Delete or explicitly mark as unreachable the event types no recorder can emit.

- Honest, and it shrinks the surface that has to be understood.
- Discards the design work behind the authority model. Prefer marking over deleting.

### D. Accept the gap and document it

Each inert command already declines rather than lying, which is the right behaviour.

- Zero cost, zero progress. Acceptable only as a holding position.

## Recommendation

A and B. Then C as documentation — mark the unreachable types explicitly so the next reader
does not spend a day discovering PM-07 again.
