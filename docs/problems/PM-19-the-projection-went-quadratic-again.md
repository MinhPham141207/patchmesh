# PM-19 — The projection went quadratic again, and `status` took 41 seconds

- **Status:** `resolved` 2026-08-25
- **Severity:** high

## The problem

`patchmesh status` took **40.9 seconds** on this repository's 8,824-event ledger. `patchmesh
agents` took 28.7s. `doctor` took 6.1s.

This is a regression of a bug already fixed once. The earlier fix replaced a fold of
`applyEvent` — which copied seven collections per event — with a single-pass `buildProjection`,
taking `status` from 40.4s to 1.5s. `buildProjection` is still single-pass. The quadratic came
back somewhere else.

Measured with `projectWorkGraph` against slices of the live ledger:

```
n=  500      56 ms    (113 us/event)
n= 1000     227 ms    (227 us/event)
n= 2000     902 ms    (451 us/event)
n= 4000    3365 ms    (841 us/event)
n= 8000   14047 ms   (1756 us/event)
```

Four times the time for every doubling, and per-event cost doubling with it. Textbook O(n²).

## The two causes

A CPU profile named them directly.

**1. A scan per call, at 37% + 7% of runtime.** `toolCoverage` found the reads belonging to one
call like this:

```ts
const observedReadEventIds = [...eventsById.values()]
  .filter((event) => (event.eventType === "file.read" || event.eventType === "symbol.read")
    && event.causationId === request.eventId)
  .map((event) => event.eventId);
```

It runs **once per `tool.requested`** and materialises and scans **every event in the ledger**
each time. With ~3,000 requests over 8,900 events that is ~26 million iterations, each
allocating a fresh 8,900-element array.

What makes it a clean find rather than a design tradeoff: `deriveProjectionCoverage` *already*
builds two indexes up front — `completionsByRequest` and `observedEffectsByCause` — for exactly
this reason. The reads lookup was simply never given one.

**2. Re-sorting a growing list on every touch, at 17% + 8%.** `mergeEvidence` did
`sortedUnique([...existing, ...new])` each time a node or edge was touched. A hot node — the
repository, an agent, a long-lived task — is touched by a large share of all events, so its
evidence list grows with the ledger: **569 entries at 2,000 events, 1,639 at 8,931**. Sorting a
list of length k on each of k touches is O(k² log k).

Nothing needed the intermediate sort. `snapshotFromState` already applies `sortedUnique` to
every node's and edge's evidence on the way out, and no node or edge id derives from that array
— they come from the agent, task, resource or version they name. `coverageId` does hash
evidence and sorts its own input.

**3. And `doctor` loaded the ledger to count it.** `readLedger` called `store.read()` — parsing
and validating every event out of its canonical blob — to learn two numbers. `count()` already
existed, with a comment saying "counted in SQLite rather than by loading them". It gained a
`latestTimestamp()` sibling, served by the `events(timestamp)` index migration 003 already adds.

## Results

```
projectWorkGraph, full ledger    16,934 ms  ->  1,295 ms    13x
patchmesh status                 40,897 ms  -> 12,733 ms     3.2x
patchmesh agents                 28,739 ms  ->  7,400 ms     3.9x
patchmesh doctor                  6,064 ms  ->  1,085 ms     5.6x
```

Per-event cost is now flat across a 16x range (90–220 µs/event with no trend), where before it
rose from 113 to 1,756.

**Proven output-identical.** The whole projection was computed over the same frozen 8,931-event
set before and after: nodes 3,018, edges 4,525, coverage 3,402, and the serialised snapshots are
**byte-for-byte equal at 7,318,389 bytes**.

`status` keeps its remaining cost honestly. It reports `Replayable`, so it is deciding
integrity, and full event validation belongs on that path. After the fix the profile is flat —
no single cost above 7% — which is where optimisation should stop.

## The guard

`projection cost stays near-linear in the size of the ledger` in
`packages/storage/test/work-graph.test.ts` projects 400 and 1,600 synthetic calls and asserts
the larger takes under **9x** the time of the smaller — linear predicts ~4x, quadratic ~16x.
Best-of-three each side, and a ratio rather than a wall-clock budget so it means the same thing
on a fast machine and a loaded one.

**Verified to fail on the unfixed code**, which is the only thing that makes it a guard:

```
✖ projecting 4x the events took 20.4x the time (134ms -> 2729ms)
```

## Why it survived twice

Every fixture-sized test passed throughout, both times. A few dozen events cannot tell a linear
curve from a quadratic one, and the projection was *correct* the whole way — it just took
41 seconds. Nothing in the suite measured a ledger big enough for the shape to show, which is
why the guard added here is a scaling assertion rather than another correctness case.
