# Design: Make coordination real

**Date:** 2026-08-25
**Status:** Proposed
**Success criterion:** live contention detection that actually fires, and attribution that holds up when two agents work at once — even if pull usage stays low.
**Hard boundary:** warn, never block. PatchMesh may inject text into an agent's context (`additionalContext`); it may never deny, pause, or redirect a tool call. The README promise stands.

Agent-to-agent messaging (F-01 capability C) is explicitly out of scope until these land.

---

## Problem list and chosen approaches

Six problems, sequenced so each slice ships green (`pnpm check`) independently:

| # | Problem | Chosen approach |
|---|---------|-----------------|
| P5 | Recap renders open tasks as finished | Derive liveness from in-flight state |
| P1 | Contention advisory never fires | Recent-write trigger + per-session delivery cursor |
| P2 | Overlap answers stop at Stop-time ingest | Live journal section shared with P1 |
| P3 | Attribution fails under concurrency; ~11% nulls | Declared-path binding + labelled turn attribution |
| P6 | Provenance hardcoded to `claude_code_hook` | Host selection order from F-01 capability A |
| P4 | ~90% of Bash calls name no path | Accept and scope; report opaque as unknown |

---

## P5 — Recap liveness

**Defect.** `recap.ts` computes `endedAt` as `max(event.timestamp)` over a task's events. An open task renders as a closed `X to Y` range, so a session-start briefing describes the agent's current work as finished.

**Fix.** A task is *active* when its last observed event is within `IDLE_GAP_MINUTES` (30, already calibrated) of now. In-flight matching by `taskId` was considered and rejected: journal entries carry no task identifier — tasks are derived at ingest from turn markers — so in-flight state cannot be joined to a task without inventing a new recorded field. Recency against the measured contention silences (0.3–15.6 min) is the honest signal: "last activity 12 min ago" does not claim the task finished, which is exactly the error being fixed.

Active tasks render `started X · last activity Nm ago (may still be running)`; only genuinely stale tasks get the closed `X to Y` range. `RecappedTask` gains an additive `active: boolean`. No new data is recorded — this reuses what the ledger already holds.

## P1 — Advisory predicate replacement *(the core change)*

**Defect.** All three advisory stages gate on `readInFlightCalls` (unmatched `PreToolUse`) plus `ADVISORY_HOST_TOOLS` (`Edit`/`Write`). A call's Pre→Post window is ~1.9 s, so the predicate requires another agent to be inside an Edit on the same path at that instant. Measured over a full session of genuine two-agent contention: zero firings.

**Replacement predicate:** *a different session wrote this path within the recent-write window, and this session has not been told yet.*

Components, all inside `packages/recorder/src/`:

- **Recent-write reader** (`advisory.ts`, extending the existing `computeAdvisoryFor` shape): reads PostToolUse entries from the local journal (`journal.js`, already in the permitted import graph — `node:fs`/`node:path` only, so the import-graph guard in `journal.test.ts` still holds). Filters to entries whose `agentId` differs from the caller and whose declared path matches. Window: `RECENT_WRITE_MINUTES`, initially 30 (same calibration as `IDLE_GAP_MINUTES`; both face the measured 0.3–15.6 min contention silences).
- **Per-session delivery cursor** (`.patchmesh/cursors/<agentId>.json`): stores `{ watermark }` — the timestamp of the last journal entry this session was told about. Rules:
  - Absent cursor on first contact ⇒ initialise to *now*. First contact never dumps history; it arms the channel.
  - Deliver facts for entries strictly newer than the watermark, then advance the watermark to the newest delivered entry. Each fact is delivered once per session.
  - Single-writer per session by construction (the session's own hooks), so no lock is needed beyond atomic replace-write.
- **Stage behaviour**, all three sharing the one predicate:
  - `PreToolUse` (Edit/Write on path P): warn — "another worker wrote `<P>` N minutes ago."
  - `PostToolUse` (after writing P): inform — same fact plus the honest clause "you just wrote it too."
  - `UserPromptSubmit`: bounded digest (top 5 paths by recency) of cross-agent recent writes, replacing the near-dead turn-start check.

Messages stay observed-fact ("X wrote src/auth.ts 4 min ago"), never inference ("you are conflicting").

**Known limit, stated:** the cursor and journal are per-worktree, so live advisories cover sessions inside one worktree. Cross-worktree contention remains visible only through the shared ledger (P2's live section reads the primary ledger), i.e. at drain granularity. Closing that gap would need cross-worktree journal reads and is deferred.

## P2 — Live section in overlap answers

`patchmesh_overlapping_work` and `overlaps` already carry a live section (`OverlapResult.live`, built from journals by `liveContentionFrom`). This wave strengthens it: opaque calls in flight are **counted** (`liveOpaqueCalls`) so "unknown write activity nearby" is a number rather than a silence, consistent with P4's accepted scope. The ledger-derived result above it is unchanged; the existing bounded-answer discipline applies unchanged.

## P3 — Attribution under concurrency

Two changes, shipped together:

- **Declared-path binding (removes most races).** The host hook hands us `file_path` on Edit/Write. The recorder adds it to the PostToolUse payload whitelist (redaction pipeline unchanged) and, at ingest, binds a snapshot/effects-walk change to a call when **exactly one** call in the window declared that exact path — regardless of mtime ordering. The filesystem walk remains the fallback for opaque Bash. Ambiguity that survives continues to attribute to the turn (never guessed), but is now **labelled** (`attribution: "turn"` on the change payload — an additive, optional field; existing consumers ignore it).
- **Turn-labelled nulls (shrinks the 11%).** An effects-walk change matching no call window binds to the owning turn's open task, carrying `attribution: "turn"`. Null attribution becomes the exception (no task open at all) instead of the default for shell-written files. The console and `files` lens render turn-labelled changes distinctly from confirmed call bindings, so the honesty survives the rendering.

Schema impact: one optional enum field on `resourceChanged` payload; additive, no version bump (mirrors how mailbox events were added).

## P6 — Provenance follows the host

The recorder writes `source.sourceId` as `source_<host>_hook` using F-01 capability A's selection order: init-written config > `PATCHMESH_HOST` env > envelope sniffing > `claude-code`. Default output is byte-identical to today, so existing ledgers and installs are unaffected. `doctor` reports the resolved host, closing the OpenCode install's false-negative noted in the 0.2.0 install audit.

## P4 — Bash opacity

No code. Advisories and the live section match Edit/Write paths; opaque Bash activity near a contested path is reported as *"unknown write activity nearby (N shell calls)"* — counted, never path-guessed (M7 ban stands). Documented in PM-08 as the accepted scope; a live `fs.watch` spike is named there as future work with its Windows-timing risk recorded.

---

## Data flow (after all slices)

```
Session B runs Edit on src/auth.ts
  -> PreToolUse hook: advisory reads journal PostToolUse entries
     finds Session A wrote src/auth.ts 4 min ago, B not told yet (cursor)
     -> additionalContext warning enters B's context BEFORE the write
  -> PostToolUse: B's own write lands in the journal (already does)
  -> ingest at Stop: declared-path binding attributes B's change to B's call
  -> overlaps / overlapping_work: ledger section + live journal section
  -> console /agents /events /map: turn-labelled vs call-bound changes distinct
```

## Error handling

- Journal unreadable / cursor corrupt ⇒ advisory silently declines (hooks always exit 0; a broken PatchMesh never breaks a session). Corrupt cursors are replaced, not parsed.
- Clock skew between sessions: comparisons use journal-entry timestamps only; worst case is a duplicate or missed single fact, never a wrong claim.
- Ledger unavailable ⇒ live section still answers from journals; ledger section reports its own unavailability as today.

## Testing

- **Unit (recorder):** predicate truth table (own writes excluded, watermark advance, first-contact arming, corrupt cursor recovery); import-graph guard unchanged.
- **Unit (query):** recap liveness (in-flight match, idle-gap match, closed task); declared-path binding (unique match binds, ambiguous falls to turn, opaque unaffected); turn-labelled nulls.
- **Integration (staged contention, the acceptance test):** two worktrees, two scripted sessions, one shared file — B's Edit receives exactly one PreToolUse warning naming A's write; cursor suppresses repeats; `overlaps` lists the file under both ledger and live sections; recap shows A's task active while running.
- **Regression:** default provenance bytes identical on a Claude-only install; every existing suite green via `pnpm check`.

## Rollout order

P5 → P1+P2 → P3 → P6 → P4 (docs only). P5 is a warm-up that improves every briefing P1 sends; P1/P2 share one reader and ship together; P3 is independent; P6 is small and unblocks future multi-host identity; P4 closes the register.
