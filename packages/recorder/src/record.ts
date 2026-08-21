import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteEventStore } from "@patchmesh/storage";
import { buildHookEvents, HookRecordingError, type HookPayload } from "./hook.js";
import { findWorktreeRoot } from "./identity.js";

export const LEDGER_DIRECTORY = ".patchmesh";
export const LEDGER_FILENAME = "ledger.db";

export function ledgerPathFor(worktreeRoot: string): string {
  return join(worktreeRoot, LEDGER_DIRECTORY, LEDGER_FILENAME);
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
