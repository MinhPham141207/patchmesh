# Persistent watcher effect capture

## Goal

Keep normal recorder drains incremental across hook processes. Full reconciliation remains the
recovery and validation path.

## Contract

- `SessionStart` starts one sidecar per worktree. The sidecar owns `fs.watch`, its path journal,
  the current snapshot, and the committed cursor.
- Recorder drains use local IPC. A request has a deterministic `requestId`.
- `drain` is prepare-only: it serializes requests, observes through the current cursor, and
  persists the pending transaction without advancing the committed cursor.
- Recorder appends returned file events using deterministic IDs, then sends `ack`.
- `ack` atomically commits cursor and snapshot, clears the pending transaction, and is idempotent.
  A crash before acknowledgement leaves the same transaction available for retry.
- Sidecar restart reloads durable state. Missing or invalid state triggers a baseline/full
  reconciliation and a degraded observation gap; it never claims complete coverage.
- Watcher overflow, watcher loss, root/ignore identity changes, and periodic validation request
  full reconciliation. Normal drains hash only watcher candidates.
- IPC, sidecar startup, and all hook integration remain fail-open: recorder calls stay durable
  even when observation is unavailable.

## Boundaries

The observation package owns watcher state, persistence, IPC framing, and reconciliation. The
recorder owns event attribution, deterministic event IDs, ledger append, and the drain/ack order.
No new dependency or protocol event type is required.

## Verification

Cover restart, overflow/loss, ignored paths, concurrent drains, deterministic retry IDs, crash
between append and ack, and a large ignored tree. Run focused package tests, workspace tests,
typecheck/build, benchmark, and `git diff --check`.
