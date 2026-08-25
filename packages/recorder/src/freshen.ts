import { existsSync, readFileSync } from "node:fs";
import { ingestJournal, recordTurnEffects } from "./ingest.js";
import { journalPathFor } from "./journal.js";
import { LEDGER_DIRECTORY, ledgerPathFor, snapshotPathFor } from "./record.js";

/**
 * How many pending entries a read is willing to drain before it declines and says so.
 *
 * A warm drain costs roughly 8ms per entry, so this is about four seconds - past the point
 * where a reader would rather have a stale answer now than a fresh one late. A backlog this
 * large is not a mid-session journal anyway; it means the Stop hook has not run in a long
 * time, which is a `doctor` problem rather than something a report should silently absorb.
 */
export const FRESHEN_MAX_ENTRIES = 500;

export type FreshenOutcome = "drained" | "empty" | "over-budget" | "failed";

export interface FreshenResult {
  readonly outcome: FreshenOutcome;
  /** Entries seen waiting in the live journal, whether or not they were drained. */
  readonly pending: number;
  readonly ingested: number;
  readonly changed: number;
  /** Why a drain did not happen, when that is worth telling the caller. Null when it did. */
  readonly reason: string | null;
}

export interface FreshenLedgerOptions {
  readonly worktreeRoot: string;
  /** Defaults to this repository's ledger. Pass it explicitly to drain into a specific one. */
  readonly ledgerPath?: string | undefined;
  readonly journalPath?: string | undefined;
  readonly snapshotPath?: string | undefined;
  readonly maxEntries?: number | undefined;
}

const EMPTY: FreshenResult = { outcome: "empty", pending: 0, ingested: 0, changed: 0, reason: null };

/** Entries waiting in the live journal. Cheap: the journal is a session's worth of lines. */
function countPending(journalPath: string): number {
  if (!existsSync(journalPath)) return 0;
  let text: string;
  try {
    text = readFileSync(journalPath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") count += 1;
  return count;
}

/**
 * Drain whatever the journal is holding, so a read answers about now rather than about the
 * last time a session stopped.
 *
 * Recording and reading disagreed about when work becomes visible. The hook appends every
 * call to the journal immediately, but `ingest` runs on `Stop`, so a session's own work
 * reached the ledger only after that session ended - and every report read the ledger.
 * Measured on this repository: the ledger's latest event was 14 hours behind a journal that
 * had been written to minutes earlier, and `overlaps` correctly reported no file changes in
 * the last 4h on a day of continuous work. The window in which contention can still be acted
 * on is exactly the window the ledger could not see.
 *
 * So the read path drains first. Three properties make that affordable and safe:
 *
 * - **Free when there is nothing to do.** The common case - a repeated read against a journal
 *   already drained - costs one `existsSync` and a small file read, measured at 0.13-0.97ms.
 *   The expensive part is paid only when it would otherwise have produced a wrong answer.
 * - **Bounded.** Past `maxEntries` it declines rather than making a report wait on a backlog.
 * - **Fail-open, like every other recorder path.** A freshen that cannot run must never cost
 *   the caller its answer; a stale answer beats no answer, and a report that can be broken by
 *   its own bookkeeping gets turned off.
 *
 * Concurrency is already handled beneath this: `ingestJournal` claims the journal by renaming
 * it aside, which is atomic, so a reader racing the Stop hook simply loses the claim and finds
 * nothing to drain. Both were going to do the same work.
 */
export async function freshenLedger(options: FreshenLedgerOptions): Promise<FreshenResult> {
  const { worktreeRoot } = options;
  const maxEntries = options.maxEntries ?? FRESHEN_MAX_ENTRIES;

  let journalPath: string;
  let ledgerPath: string;
  let snapshotPath: string;
  try {
    journalPath = options.journalPath ?? journalPathFor(worktreeRoot, LEDGER_DIRECTORY);
    ledgerPath = options.ledgerPath ?? ledgerPathFor(worktreeRoot);
    snapshotPath = options.snapshotPath ?? snapshotPathFor(worktreeRoot);
  } catch {
    return EMPTY;
  }

  const pending = countPending(journalPath);
  if (pending === 0) return EMPTY;
  if (pending > maxEntries) {
    return {
      outcome: "over-budget",
      pending,
      ingested: 0,
      changed: 0,
      reason: `${pending} entr(ies) are waiting to be ingested, past the ${maxEntries} a report will drain inline`,
    };
  }

  let ingested = 0;
  try {
    const result = ingestJournal({ worktreeRoot, journalPath, ledgerPath });
    ingested = result.ingested;
    // Nothing was claimed: another drain owns the journal right now. Returning here keeps a
    // read that lost the race from walking the filesystem for effects it cannot attribute.
    if (result.ledgerPath === null) return { ...EMPTY, pending };

    // Observed after the journal is safely drained, for the same reason `ingest-bin` does it
    // in this order: a failure here leaves the recorded calls in the ledger rather than
    // stranding them in a claim nothing will look at again.
    const effects = await recordTurnEffects({
      worktreeRoot,
      ledgerPath,
      snapshotPath,
      turn: result.closedTurn,
      calls: result.calls,
    });
    return { outcome: "drained", pending, ingested, changed: effects.changed, reason: null };
  } catch (error) {
    return {
      outcome: "failed",
      pending,
      ingested,
      changed: 0,
      reason: error instanceof Error ? error.message : "unknown freshen failure",
    };
  }
}
