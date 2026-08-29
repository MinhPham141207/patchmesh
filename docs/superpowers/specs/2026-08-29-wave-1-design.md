# Design: Wave 1 — Attribution, events, duplicates, and the feedback loop

**Date:** 2026-08-29
**Status:** Proposed
**Success criterion:** Attribution holds under concurrency; three new event types are produced; duplicate work is detectable; feedback has real input; the attribution rate is visible in `doctor`.
**Hard boundary:** warn, never block. PatchMesh may inject text into an agent's context; it may never deny, pause, or redirect a tool call.

---

## Problem list and chosen approaches

Five problems, sequenced so each slice ships green (`pnpm check`) independently:

| # | Problem | Chosen approach |
|---|---------|-----------------|
| P1 | Attribution degrades under concurrency (PM-04 C) | Nest subagent spans by rule |
| P2 | 13 of 16 event types never produced (PM-05 A+B) | Derive symbol/dependency events at ingest + emit `task.completed` |
| P3 | Duplicate work undetectable (PM-06 A) | Content hash per changed file at ingest |
| P4 | 27% of events carry no task (PM-09 A+C) | Correlation-based backfill + attribution rate in `doctor` |
| P5 | Feedback loop has no input (PM-11 A) | Persist overlap findings as `finding.created` events |

---

## P1 — Nest subagent spans (PM-04 C)

**Defect.** Attribution uses `soleCallCovering`: a change binds to the call whose `[started, completed]` window contains the file's mtime. When a parent session spawns a subagent, both windows overlap for the subagent's duration. The conservative rule discards the ambiguous change, leaving it attributed to the turn (null task).

**Fix.** The parent/child relationship is known from agent IDs: a child's id is `parent.sub.N`. A change whose mtime falls inside both a parent's and a child's window binds to the child — the child is the narrower, more specific scope. This is a rule, not a heuristic: a subagent call is always nested inside its parent's span by construction.

**Implementation:** In `packages/recorder/src/effects.ts`, add a `nestedCallCovering` function alongside the existing `soleCallCovering`. When multiple windows cover an mtime, select the call whose agent ID is a descendant of the others (contains `.`). If no descendant relationship exists among covering calls, fall back to the current null-attribution behaviour.

**Scope:** Removes the subagent ambiguity class entirely. The two-independent-sessions case (different top-level agents) is unchanged and addressed by P3's content hashing.

**Schema impact:** None. The binding is an ingest-time decision, not a new field.

---

## P2 — Produce symbol, dependency, and task events (PM-05 A+B)

**Defect.** The protocol defines 16 event types. The live ledger contains 3. Thirteen types — including `symbol.changed`, `dependency.changed`, `task.completed`, `finding.created`, and `decision.created` — are never written. Detectors (`contracts`, `stale`, `feedback`) are typed against these inputs and can never report findings.

**Two slices, shipped together:**

### P2-A — Derive symbol and dependency events at ingest (PM-05 A)

When a `file.changed` event is ingested, parse the changed file off disk and derive:

- **`symbol.changed`** — every exported symbol whose signature or body changed. Derived by diffing the file's AST before and after (already available in `packages/analyzers`).
- **`dependency.changed`** — every import whose resolved target changed. Derived by comparing the import map before and after.

Both are derived facts, not observed events. They carry `source: "analyzer"` to distinguish them from hook-recorded traffic. The derivation runs at ingest time, off the hook hot path, on a handful of changed files.

**What this unblocks:** `contracts` becomes the first working detector. `detectExportedContractInvalidation` can now fire because `symbol.changed` and `dependency.changed` inputs exist.

**Cost:** One parse per changed file at ingest. Bounded by the number of `file.changed` events in a drain (typically < 10 per turn). Already stat-ing these files; the marginal work is AST parsing.

### P2-B — Emit `task.completed` from turn boundaries (PM-05 B)

When a turn closes and its task is resolved, emit a `task.completed` event. Turn state is already persisted across drains; task identity comes from the same turn boundary that `recap` already uses.

**What this gives:** Task-scoped queries get a real terminator instead of inferring one from idle gaps. `recap` can show "task X completed at T" instead of "task X last active T minutes ago."

**Cost:** One event per turn that resolves a task. Cheap.

### Schema impact

Three new event types added to `Phase1InputEvent` union in `packages/protocol/src/events.ts`:

- `symbol.changed` payload: `{ filePath, symbolName, symbolKind, changeKind: "signature" | "body" | "added" | "removed" }`
- `dependency.changed` payload: `{ filePath, importPath, oldResolvedPath, newResolvedPath }`
- `task.completed` payload: `{ taskId, agentId, startedAt, completedAt }`

All additive. Existing consumers ignore unknown event types. No version bump.

---

## P3 — Content hash per changed file (PM-06 A)

**Defect.** Duplicate work — the product's founding claim — is undetectable because the recorded `operation` is a redacted descriptor (`Edit <path>`), not the content or intent of the change. Two agents editing the same file in different ways reads as a collision; two agents producing the same result reads as two distinct events.

**Fix.** At ingest, when a `file.changed` event is created, compute a content hash of the file's current state and store it in the event payload. The hash is a direct observation of the result, not an inference about intent.

**What this enables (in this wave):**

- **Duplicate detection (PM-06):** Two `file.changed` events on the same path with identical hashes mean the same resulting content — convergent output, regardless of intent. Detectable by a simple query: `SELECT * FROM events WHERE type='file.changed' AND filePath=? AND contentHash=?`.
- **Rework detection:** A `file.changed` whose `afterVersion` hash matches a previous `file.changed` on the same path means the file was changed back — revert, undo, or oscillation. Also a simple query.

**What this enables (future waves):**

- **PM-04 A disambiguation:** When two call windows overlap on one file, a hash that matches one call's declared edit disambiguates without inference. (Deferred to a future wave — P1's subagent nesting removes the ambiguity class most frequently hit today.)
- **PM-10 A displacement join:** Did the agent read the file the answer named? The hash chain provides the before/after versions needed to measure this.

**Implementation:** In `packages/recorder/src/effects.ts`, after binding a change to a call (or to the turn), read the file and compute a SHA-256 hash. Store as `contentHash: string` on the `file.changed` payload. The read is bounded (already stat-ing these files), and the hash computation is O(file size) — acceptable for the handful of files changed per drain.

**Storage cost:** One 64-character hex string per `file.changed` event. 592 events so far = ~38 KB. Negligible.

**Schema impact:** One optional field on `file.changed` payload: `contentHash?: string`. Additive, no version bump.

---

## P4 — Correlation-based attribution backfill + doctor rate (PM-09 A+C)

**Defect.** 27% of events carry no task (1,005 of 3,674). An unattributed event is invisible to every task-scoped query, which is most of the product's surface. The cause is structural: turn boundaries don't always resolve, and ambiguous effect binding falls back to null.

**Two slices:**

### P4-A — Backfill task attribution from correlation (PM-09 A)

Events already carry a `correlation_id` that links related calls within a session. Where a correlation has exactly one task among its events, propagate that task to the rest of the correlation's events.

**Rule:** `correlation_id` groups events. Within a group, find the set of distinct `taskId` values. If the set has exactly one non-null value, assign that task to every event in the group with a null `taskId`.

**Why this works:** A session's turns are correlated. When one turn resolves a task and a later turn doesn't, the correlation links them. The single-task case recovers most of the lost attribution without heuristic guessing. Correlations with no task at all (short-lived or tooling sessions) stay unattributed — honestly, not laundered into a synthetic task.

**Implementation:** In `packages/recorder/src/ingest.ts`, after draining the journal, run a backfill pass over the newly ingested events. For each correlation group with exactly one non-null task, update the null-attribution events. This is a batch UPDATE against SQLite, bounded by the number of events in the drain.

**What this does not do:** Nothing for correlations with zero tasks, and nothing for correlations with multiple tasks (which is ambiguous). Those events stay null-attributed, which is the honest outcome.

### P4-B — Attribution rate in `doctor` (PM-09 C)

`patchmesh doctor` currently reports hook health and ledger size. Add the attribution rate: `X% of events carry a task (Y of Z)`.

**Why:** The number should be visible so it stops being discovered by audit. It also gives a before/after measurement for P4-A.

**Implementation:** Add one query to `doctor`'s output: `SELECT COUNT(*) FILTER (WHERE taskId IS NOT NULL)` and `SELECT COUNT(*)` from the events table. Render as a line in doctor's text output and as `attributionRate` in `--json` mode.

---

## P5 — Persist overlap findings as `finding.created` (PM-11 A)

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
     1. Recent-write advisory (from coordination-realness) fires if A wrote recently
     2. Journal records the tool call
  -> PostToolUse hook:
     1. Journal records the completion
     2. Filesystem diff detects src/auth.ts changed
     3. Content hash computed and stored on file.changed event
     4. Nested call attribution: binds to child if parent+child windows overlap
  -> ingest at Stop:
     1. Correlation backfill: propagates task from correlated events (PM-09 A)
     2. Symbol/dependency events derived from changed files (PM-05 A)
     3. task.completed emitted if turn resolved a task (PM-05 B)
     4. Overlap findings persisted as finding.created (PM-11 A)
  -> MCP tools:
     - recap: shows task.completed, attribution rate
     - overlapping_work: returns persisted findings + live section
     - feedback: has real finding.created events to take input on
  -> CLI:
     - doctor: reports attribution rate
     - overlaps: returns persisted findings
```

---

## Error handling

- **Hash computation fails** (file deleted between diff and hash) → `contentHash` omitted, event still recorded. Fail-open.
- **Symbol parsing fails** (unparseable file) → `symbol.changed` not derived for that file. Logged, not fatal. Other files still parsed.
- **Correlation backfill finds multiple tasks** → leaves null. Honest ambiguity, not a guess.
- **Finding dedup fails** (ledger unavailable) → finding not persisted, overlaps still computed live. Query surface unchanged.

---

## Testing

- **Unit (recorder):** nestedCallCovering (child wins over parent, unrelated calls stay null); content hash computation (same content = same hash, deleted file = omitted); correlation backfill (single-task propagates, multi-task stays null).
- **Unit (analyzers):** symbol.changed derivation (exported function signature change, new export, removed export); dependency.changed derivation (import path resolved differently); task.completed emission (turn boundary resolves task).
- **Unit (query):** finding dedup (same contention = same findingId); feedback accepts finding_id from persisted findings; doctor reports attribution rate.
- **Integration:** full ingest pipeline produces all five new event types; `pnpm check` green.
- **Regression:** existing suites unchanged; event schema backward-compatible.

---

## Rollout order

P1 → P2-A + P2-B → P3 → P4-A + P4-B → P5

P1 is independent and removes an ambiguity class. P2 is the foundation: it produces the event types that P5 (findings) needs. P3 builds on P2's ingest path (hash is computed during the same file read). P4 is independent of P2/P3 but benefits from seeing the improved attribution. P5 is last because it depends on the overlap computation being stable.

---

## Explicitly out of scope

- **PM-04 A (content-hash disambiguation for two sessions):** P3 adds the hash; using it for attribution disambiguation is a future wave. P1's subagent nesting handles the more frequent case now.
- **PM-06 B (prompt capture):** Privacy question unanswered. Deferred.
- **PM-06 C (diff capture):** More storage, harder redaction. Deferred.
- **PM-07 (stale-read detection):** Structural. Folded into PM-02's advisory (time-based reframe), not addressed here.
- **PM-08 (Bash opacity):** Accepted boundary. Documented, not fixed.
- **PM-13 (pull usage):** Measured, not addressed here. If adoption doesn't move within a week of PM-13 B+C shipping, declare push-only.
