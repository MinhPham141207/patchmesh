# Persistent watcher effect capture plan

1. Add a standard-library sidecar/client in `packages/observation`.
   - Persist cursor, snapshot, pending transaction, and bounded watcher journal atomically.
   - Expose start/ensure, `drain`, `ack`, and stop helpers over local IPC.
   - Reuse `NodeObservationBoundary` incremental capture and retain full reconciliation fallback.
2. Replace recorder full capture with sidecar prepare/append/ack.
   - Derive a deterministic request ID from the drained call set and worktree identity.
   - Derive deterministic `file.changed` IDs so a retry is a harmless duplicate append.
   - Keep ledger writes before acknowledgement; leave pending work retryable on failures.
3. Start the sidecar from `SessionStart`; keep Stop/SessionEnd idempotent.
4. Add regression tests for restart, loss/overflow, ignored trees, concurrency, retries, and
   deterministic IDs.
5. Update `issues.md`; run focused tests, full tests, build/typecheck, benchmark, and diff check.
