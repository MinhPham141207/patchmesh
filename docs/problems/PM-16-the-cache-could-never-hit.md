# PM-16 — The read cache was wired into every tool and could never hit

- **Status:** `resolved` 2026-08-24
- **Severity:** medium

## The problem

`readEventsCached` was wired into all three read tools — `recap.ts`, `overlap.ts`,
`recall.ts` — and hit **exactly never**.

Measured over stdio against the live server, five runs each, warm process:

```
patchmesh_recap {}                 177 ms
patchmesh_recap 7d limit 25        606 ms
patchmesh_recent_activity 7d 100   498 ms
```

Repeated identical calls did not get faster. Nothing failed, nothing warned, and the only
symptom was latency that looked like the cost of reading a ledger.

### The cause

Every window is relative. Each caller computes:

```ts
const since = new Date(now.getTime() - withinMinutes * 60_000);
```

`since` is therefore a fresh millisecond-precision timestamp on every call, and `since` is part
of the cache key. **No two calls could ever produce the same key.** The cache filled with
single-use entries and evicted them unread.

This is worth naming as a class: a cache keyed on a value derived from `now` is not a cache.

## Why it matters

- The `SessionStart` hook pays it twice per fire — a recap window and a contention window that
  overlap almost completely — before the user's first prompt.
- The cost scales with ledger age, not query complexity. At 5,523 events a 7-day window was
  600ms; nothing about that improves on its own.
- An agent asking two or three questions in one turn re-read the same rows two or three times.

## Candidate solutions

### A. Bucket the read boundary — **shipped**

`readWindowCached` rounds the boundary **down** to the minute for the read, then trims to the
exact `since` in memory. The widened read is a superset, so the rows a caller sees are exactly
the rows `read({ since })` would have returned; what changes is that every call inside the same
minute shares one query.

One minute, against windows of four hours and one day, is below the resolution of any question
either window is asked.

The filter is unconditional rather than short-circuiting on the first row's timestamp: rows
come back in insertion order, and a batched drain can insert an older event after a newer one.

### B. Push the window into SQL with an index on `timestamp`

Already the case — `read()` compiles `since` into a `timestamp >= ?` predicate. Not the
problem, and it is why A is sufficient.

### C. Serve recap from a rolling projection

O(1) in ledger age, and the right end state at a much larger scale. Wave 3.

## Resolution (2026-08-24) — option A

`readWindowCached` in `packages/storage/src/event-cache.ts`, wired into the three window
readers. `measureTimeToResume` also moved off its direct `SqliteEventStore.open` onto
`readEventsCached`: it reads unbounded, so its key was always stable, and the cohort split now
runs the same read twice.

Measured the same way, after:

| call | before | after |
| --- | --- | --- |
| `patchmesh_recap` 7d limit 25 | 606 ms | **186 ms** |
| `patchmesh_recent_activity` 7d limit 100 | 498 ms | **33 ms** |
| `patchmesh_recap {}` | 177 ms | 184 ms |
| `patchmesh_overlapping_work {}` | 17 ms | 18 ms |

The default `recap` is unchanged because its cost is not the read: `renderRecap` shells out to
git for the commits in the window. That is a separate cost and a separate problem.

**A hit counter ships with it.** `eventCacheStats()` reports hits and misses, and a test
asserts that two boundaries inside the same minute cost one read between them. The defect this
guards against was invisible for exactly as long as nothing counted — "the cache is wired" and
"the cache works" needed to become different assertions.

## Not fixed

The 1.4s cold MCP handshake. It is paid once per session and the hook that follows it costs
less; there is nothing here worth the change.
