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
  /**
   * Also walk the filesystem for what changed, not just drain the calls. Defaults to false.
   *
   * Draining is cheap - 4-6ms warm - because it moves lines from one file into a database.
   * Observing effects is not: it stats and content-hashes every tracked file and shells out to
   * `git check-ignore`, measured at **681-949ms on this repository even when it finds nothing
   * to record**, and a CPU profile of it is 54% idle, so it is I/O bound and will not optimise
   * away. It scales with the size of the checkout, not with how much happened.
   *
   * That is the same wall `effect-detection-cannot-run-on-the-hook-hot-path` hit one level
   * down, and the answer is the same: it belongs on a session boundary, not a per-call path.
   *
   * So the split is by caller, and it is a real trade rather than a tuning knob:
   *
   * - **The MCP tools leave it off.** An agent is told to call `patchmesh_recent_activity`
   *   before every edit, and PM-13's finding is that friction is what keeps the pull surface
   *   at one call per 183. Making every one of those calls a second slower to fold in a
   *   filesystem walk would buy freshness with the adoption the freshness is for. Those tools
   *   still get current *calls*, and `overlapping_work` reads the journal directly for the
   *   in-flight contention that actually changes what an agent does next.
   * - **The CLI reports and the `SessionStart` hook turn it on.** A person running
   *   `patchmesh overlaps` is asking a question once and can afford the walk; `SessionStart`
   *   pays it once per session, at the moment the previous session's changes matter most.
   * - **`Stop` remains the unthrottled path**, and is what binds observed changes to the call
   *   windows that caused them.
   */
  readonly observeEffects?: boolean | undefined;
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

    // No new calls means no new call windows to bind changes to, so the walk could only
    // produce unattributed observations at full price. The live journal always holds at least
    // the in-flight call that is asking, so without this a repeated read pays the walk forever.
    if (options.observeEffects !== true || ingested === 0) {
      return { outcome: "drained", pending, ingested, changed: 0, reason: null };
    }

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
