# Design: PM-05 B — Emit `task.completed` from turn boundaries

**Date:** 2026-08-29
**Status:** Proposed
**Success criterion:** A `task.completed` event is appended to the ledger for every turn that closes *with ≥1 file.changed*, carrying the task identity and the files it changed. `pnpm check` green. Turns with no file changes produce no event (schema requires `resourceIds` minItems 1).
**Hard boundary:** warn, never block.

---

## Problem

`task.completed` is defined in the protocol (`packages/protocol/src/events.ts:456`) but never emitted. The protocol comments call it "a projection of turn state the recorder already holds" (line 635). Without it:

- Detectors that need a closed task boundary (e.g., work-product scoping) have no event to key on.
- The correlation backfill (`PM-09 A`) works because it groups by `correlation_id`, but a dedicated completion event would make the lifecycle explicit rather than inferred.
- `feedback` cannot reference a completed task — only findings.

Turn state already tracks which task a session is working on (`turn.ts`), and `closedTurn` in `IngestResult` names the turn that closed. The missing piece is emitting an event at that boundary.

---

## Approach

Emit one `task.completed` event per turn that closes, at the end of `ingestJournal` after effects are observed. The event carries:

- **`taskId`** — from `closedTurn.taskId` (already on `IngestResult`).
- **`agentId`** — from `closedTurn.agentId`.
- **`payload.resourceIds`** — file paths from `file.changed` events attributed to this turn in the same drain. This is the set of files the task touched.
- **`payload.workProductId`** — derived from the taskId. The taskId is already a stable identifier; wrapping it as `work_${hash(taskId)}` satisfies the branded type.
- **`payload.baseRevision`** — git HEAD at turn-close. Cheap (one `git rev-parse HEAD`), and it bounds the turn's work against a known repository state.
- **`payload.targetSnapshotId`** — hash of the snapshot path, consistent with how `file.changed` events reference snapshots.

### When to emit

After `recordTurnEffects` returns the `file.changed` events, and after `soleTurnOf` resolves `closedTurn`. At this point we have:

1. The closed turn's identity (agentId, taskId).
2. The files changed during the turn (from effect observation).
3. Git HEAD (available from the worktree).

The event is appended to the store before the store closes, in the same transaction scope as the other events from this drain.

### When NOT to emit

- **No closed turn** (`closedTurn` is null): multiple sessions were active, or no marker was seen. No completion event — we cannot name whose turn it was.
- **No file.changed in the turn** (`resourceIds` would be empty): schema requires `resourceIds` minItems 1, so no event is emitted. A turn that changed no files has nothing to complete.
- **Null taskId**: the turn had no task and no file.changed to query (resourceIds is taskId-scoped). No event is emitted in the current implementation because the lookup is `WHERE task_id = ?` with a null taskId yielding an empty result. Agent-only attribution would require a different lookup key (e.g., agentId or correlationId) — deferred.

### Multi-session drains

When two sessions are active in one drain, `soleTurnOf` returns null. We do not emit for either session — their turns may still be open, and emitting a completion for one but not the other would be wrong. This is the same conservative rule that governs effect attribution.

---

## Payload derivation

```typescript
// At turn-close, after recordTurnEffects:
const resourceIds = fileChangedEvents
  .filter(e => e.payload.attribution?.taskId === closedTurn.taskId)
  .map(e => e.payload.resourceId);

const workProductId = `work_${canonicalDigest(closedTurn.taskId ?? "unattributed")}`;
const targetSnapshotId = `snapshot_${canonicalDigest(snapshotPath)}`;
const baseRevision = execSync("git rev-parse HEAD", { cwd: worktreeRoot }).toString().trim();

store.appendAtomic([{
  schemaVersion: 1,
  eventId: createEventId(),
  eventType: "task.completed",
  timestamp: new Date().toISOString(),
  repositoryId,
  workspaceId,
  agentId: closedTurn.agentId,
  taskId: closedTurn.taskId,
  correlationId: ..., // same correlation as the turn's calls
  causationId: ...,   // the UserPromptSubmit marker event
  payload: { workProductId, baseRevision, targetSnapshotId, resourceIds },
}]);
```

The git call is bounded: one short-lived process per drain, only when a turn actually closes. On a turnless drain (no marker, or multi-session), it is never called.

---

## Schema impact

None. `task.completed` and `TaskCompletedPayload` are already defined in the protocol. No version bump.

---

## Error handling

- **Git unavailable or fails** → `baseRevision` falls back to `"0000000000000000000000000000000000000000"` (40 zero hex chars). `"unknown"` would fail schema pattern `^[0-9a-f]{40}([0-9a-f]{24})?$`. The fallback is schema-compliant and still signals degradation.
- **Store append fails** → same as any other event: the turn state is already written, the calls are already recorded. One missing completion event does not lose data.
- **No file.changed events in the turn** → `resourceIds` would be empty, violating schema `minItems: 1`. No event is emitted — a turn that changed nothing has no work product to complete.

---

## Testing

- **Unit:** emit fires for a single-session drain with a marker; no emit when `closedTurn` is null; no emit when no marker was seen.
- **Unit:** `resourceIds` in the payload matches the `file.changed` events attributed to the turn.
- **Unit:** `workProductId` is deterministic from taskId.
- **Integration:** full ingest pipeline with a marker produces a `task.completed` event in the ledger.
- **Regression:** existing suites unchanged; `closedTurn` semantics unchanged.

---

## Out of scope

- **Payload enrichment** (adding `symbol.changed` or `dependency.changed` events to `resourceIds`): deferred — those are separate event types, not file paths.
- **Emitting on session end** (not just turn end): a session can have many turns; we complete per-turn, not per-session.
- **Task hierarchy** (parent-child task completion): out of scope until subagent task nesting is designed.
