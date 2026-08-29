# Design: Wave 1 — Subagent attribution, task events, attribution backfill, and findings persistence

**Date:** 2026-08-29
**Status:** Proposed
**Success criterion:** Attribution holds under concurrency with subagent nesting; `task.completed` events are produced; 27% null-attribution rate drops via correlation backfill; attribution rate visible in `doctor`; overlap findings are persisted as `finding.created` events.
**Hard boundary:** warn, never block. PatchMesh may inject text into an agent's context; it may never deny, pause, or redirect a tool call.

---

## Problem list and chosen approaches

Three problems, sequenced so each slice ships green (`pnpm check`) independently:

| # | Problem | Chosen approach |
|---|---------|-----------------|
| P1 | Attribution degrades under concurrency — subagent spans (PM-04 C) | Nest subagent spans by rule |
| P2 | 27% of events carry no task + attribution invisible (PM-09 A+C) | Correlation-based backfill + attribution rate in `doctor` |
| P3 | Feedback loop has no input (PM-11 A) | Persist overlap findings as `finding.created` events |

**Already implemented (removed from scope):**

- **PM-05 A (symbol/dependency events):** `packages/recorder/src/symbols.ts` already calls `deriveAnalysisEvents` from `patchmesh-analyzers`, producing `symbol.changed` and `dependency.changed` events at ingest. The `contracts` detector can now fire.
- **PM-06 A (content hashing):** `file.changed` events already carry `beforeVersion`/`afterVersion` with `kind: "content_hash"` and real SHA-256 digests (`effects.ts:465-471`). Duplicate and rework detection are queryable today.

---

## P1 — Nest subagent spans (PM-04 C)

**Defect.** Attribution uses `soleCallCovering` (`effects.ts:269`): a change binds to the call whose `[startedAtMs, completedAtMs]` window contains the file's mtime. When a parent session spawns a subagent, both windows overlap for the subagent's duration. The conservative rule returns `null` on ambiguity, leaving the change attributed to the turn (null task).

**Fix.** The parent/child relationship is known from agent IDs: a child's id is `parent.sub.N` (contains `.`). A change whose mtime falls inside both a parent's and a child's window binds to the child — the child is the narrower, more specific scope. This is a rule, not a heuristic: a subagent call is always nested inside its parent's span by construction.

**Implementation:** In `packages/recorder/src/effects.ts`, add a `nestedCallCovering` function alongside the existing `soleCallCovering`. When multiple windows cover an mtime, select the call whose agent ID is a descendant of the others (contains `.`). If no descendant relationship exists among covering calls, fall back to the current null-attribution behaviour.

**Scope:** Removes the subagent ambiguity class entirely. The two-independent-sessions case (different top-level agents) is unchanged and already addressed by content hashing.

**Schema impact:** None. The binding is an ingest-time decision, not a new field.

---

## P2 — Correlation-based attribution backfill + doctor rate (PM-09 A+C)

**Defect.** 27% of events carry no task (1,005 of 3,674). An unattributed event is invisible to every task-scoped query, which is most of the product's surface. The cause is structural: turn boundaries don't always resolve, and ambiguous effect binding falls back to null.

**Two slices:**

### P2-A — Backfill task attribution from correlation (PM-09 A)

Events already carry a `correlation_id` that links related calls within a session. Where a correlation has exactly one task among its events, propagate that task to the rest of the correlation's events.

**Rule:** `correlation_id` groups events. Within a group, find the set of distinct `taskId` values. If the set has exactly one non-null value, assign that task to every event in the group with a null `taskId`.

**Why this works:** A session's turns are correlated. When one turn resolves a task and a later turn doesn't, the correlation links them. The single-task case recovers most of the lost attribution without heuristic guessing. Correlations with no task at all (short-lived or tooling sessions) stay unattributed — honestly, not laundered into a synthetic task.

**Implementation:** In `packages/recorder/src/ingest.ts`, after draining the journal and recording effects, run a backfill pass over the newly ingested events. For each correlation group with exactly one non-null task, update the null-attribution events. This is a batch UPDATE against SQLite, bounded by the number of events in the drain.

**What this does not do:** Nothing for correlations with zero tasks, and nothing for correlations with multiple tasks (which is ambiguous). Those events stay null-attributed, which is the honest outcome.

### P2-B — Attribution rate in `doctor` (PM-09 C)

`patchmesh doctor` currently reports hook health and ledger size. Add the attribution rate: `X% of events carry a task (Y of Z)`.

**Why:** The number should be visible so it stops being discovered by audit. It also gives a before/after measurement for P2-A.

**Implementation:** Add one query to `doctor`'s output: `SELECT COUNT(*) FILTER (WHERE taskId IS NOT NULL)` and `SELECT COUNT(*)` from the events table. Render as a line in doctor's text output and as `attributionRate` in `--json` mode.

---

## P3 — Persist overlap findings as `finding.created` (PM-11 A)

**Defect.** `patchmesh feedback` takes a `--finding-id`, but the ledger contains zero `finding.created` events. The feedback loop has nothing to loop about. Overlap detection works and is the product's most validated detector, but its output is re-derived on every query and never persisted.

**Fix.** When `overlaps` is computed, persist each contention as a `finding.created` event in the ledger. Each finding carries:

- `findingId` — stable identity (deterministic from the contention: sorted file paths + involved agent IDs + time window)
- `type: "contention"` — the finding kind
- `filePath` — the contested file
- `agentIds` — the agents involved
- `evidenceEventIds` — the `file.changed` events that prove the contention
- `createdAt` — when the finding was generated

**Why a stable identity matters:** The same contention should not create a new finding on every `overlaps` invocation. The identity is derived from the evidence: given the same set of `file.changed` events, the same `findingId` is produced. This makes findings idempotent.

**What this unblocks:**

- **PM-11:** `feedback` finally has real input. Agents can respond to findings with `dismissed`, `acknowledged`, `already_handled`, etc.
- **PM-10 A:** Displacement join has findings to join against.
- **Labelled corpus:** Findings with feedback form the labelled dataset needed to measure detector precision at scale.

**Implementation:** In `packages/query/src/overlap.ts`, after computing `OverlapResult`, persist each contention as a `finding.created` event. Dedup by `findingId`: if a finding with the same identity already exists in the ledger, skip it. This is a cheap lookup against the events table.

**Schema impact:** `finding.created` is already defined in the protocol but never emitted. The payload fields above match the existing schema. No version bump.

---

## Data flow (after all slices)

```
Session B runs Edit on src/auth.ts
  -> PreToolUse hook:
     1. Recent-write advisory fires if A wrote recently
     2. Journal records the tool call
  -> PostToolUse hook:
     1. Journal records the completion
     2. Filesystem diff detects src/auth.ts changed
     3. Content hash computed and stored on file.changed event (already works)
     4. Nested call attribution: binds to child if parent+child windows overlap (P1)
  -> ingest at Stop:
     1. Correlation backfill: propagates task from correlated events (P2-A)
     2. Symbol/dependency events derived from changed files (already works)
     3. Overlap findings persisted as finding.created (P3)
  -> MCP tools:
     - recap: attribution rate improved by P2-A
     - overlapping_work: returns persisted findings + live section
     - feedback: has real finding.created events to take input on
  -> CLI:
     - doctor: reports attribution rate (P2-B)
     - overlaps: returns persisted findings
```

---

## Error handling

- **Nested attribution finds no descendant** → falls back to current null-attribution behaviour. No regression.
- **Correlation backfill finds multiple tasks** → leaves null. Honest ambiguity, not a guess.
- **Finding dedup fails** (ledger unavailable) → finding not persisted, overlaps still computed live. Query surface unchanged.

---

## Testing

- **Unit (recorder):** nestedCallCovering (child wins over parent, unrelated calls stay null, single call unchanged); correlation backfill (single-task propagates, multi-task stays null, zero-task stays null).
- **Unit (query):** finding dedup (same contention = same findingId); feedback accepts finding_id from persisted findings; doctor reports attribution rate.
- **Integration:** nested subagent attribution produces bound (not null) changes; full ingest pipeline produces finding.created events; `pnpm check` green.
- **Regression:** existing suites unchanged; soleCallCovering unchanged for non-descendant calls.

---

## Rollout order

P1 → P2-A + P2-B → P3

P1 is independent and removes an ambiguity class. P2 is independent of P1 but benefits from seeing improved attribution. P3 depends on the overlap computation being stable (it is).

---

## Explicitly out of scope

- **PM-04 A (content-hash disambiguation for two sessions):** Content hashes already exist in `file.changed` events; using them for attribution disambiguation is a future wave. P1's subagent nesting handles the more frequent case now.
- **PM-05 B (task.completed):** Defined in the protocol but not emitted. Deferred — the correlation backfill recovers attribution without needing explicit task completion events.
- **PM-06 B (prompt capture):** Privacy question unanswered. Deferred.
- **PM-07 (stale-read detection):** Structural. Folded into PM-02's advisory (time-based reframe), not addressed here.
- **PM-08 (Bash opacity):** Accepted boundary. Documented, not fixed.
- **PM-13 (pull usage):** Measured, not addressed here.
