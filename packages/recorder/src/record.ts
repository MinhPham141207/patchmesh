import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteEventStore } from "patchmesh-storage";
import { buildHookEvents, HookRecordingError, type HookPayload } from "./hook.js";
import { findWorktreeRoot, ledgerRootFor } from "./identity.js";

export const LEDGER_DIRECTORY = ".patchmesh";
export const LEDGER_FILENAME = "ledger.db";

export const SNAPSHOT_FILENAME = "snapshot.json";

/** Where the last observed worktree state is kept, so the next drain can diff against it. */
export function snapshotPathFor(worktreeRoot: string): string {
  return join(worktreeRoot, LEDGER_DIRECTORY, SNAPSHOT_FILENAME);
}

/**
 * Where this repository's ledger lives: under the *primary* worktree, so every linked
 * worktree of one repository records into and reads from one database.
 *
 * Unchanged for a single-worktree checkout, which is why no existing ledger moves. See
 * `ledgerRootFor`. The journal, snapshot and turn state deliberately stay per-worktree: the
 * snapshot is a diff baseline of one checkout's files, and sharing it across worktrees with
 * different file sets would read as a phantom change on every drain.
 */
export function ledgerPathFor(worktreeRoot: string): string {
  return join(ledgerRootFor(worktreeRoot), LEDGER_DIRECTORY, LEDGER_FILENAME);
}

export interface RecordHookResult {
  readonly recorded: boolean;
  readonly ledgerPath: string | null;
  readonly reason: string | null;
}

export interface RecordHookOptions {
  readonly payload: HookPayload;
  /** Overrides worktree discovery; tests and non-git roots supply it directly. */
  readonly worktreeRoot?: string;
  readonly ledgerPath?: string;
}

/**
 * Record one completed host tool call. The request and completion are appended in a
 * single atomic batch so a reader never sees a completion whose request is missing.
 */
export function recordHook(options: RecordHookOptions): RecordHookResult {
  const cwd = typeof options.payload.cwd === "string" ? options.payload.cwd : process.cwd();
  const worktreeRoot = options.worktreeRoot ?? findWorktreeRoot(cwd);
  if (worktreeRoot === null) {
    return { recorded: false, ledgerPath: null, reason: "no git worktree found for hook cwd" };
  }

  const ledgerPath = options.ledgerPath ?? ledgerPathFor(worktreeRoot);
  const { requested, completed } = buildHookEvents({ payload: options.payload, worktreeRoot });

  mkdirSync(dirname(ledgerPath), { recursive: true });
  const store = SqliteEventStore.open(ledgerPath);
  try {
    store.appendAtomic([requested, completed]);
  } finally {
    store.close();
  }
  return { recorded: true, ledgerPath, reason: null };
}

export { HookRecordingError };
export type { HookPayload };
