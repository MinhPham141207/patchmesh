import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readInFlightCalls, LEDGER_DIRECTORY, type InFlightCall } from "patchmesh-recorder";
import { readWindowCached } from "patchmesh-storage";
import { idShortener } from "./short-id.js";

/**
 * Who is working right now, and whether an empty answer can be believed.
 *
 * These are one question, not two. Every other tool here reports history, so "nothing found"
 * has always had two readings that look identical: nothing happened, or nothing was recorded.
 * A reader deciding whether to start editing needs to know which one it got, and no existing
 * surface tells it -- `doctor` does, but `doctor` is a CLI command a person runs, not something
 * an agent mid-task can ask.
 *
 * So presence is reported alongside the evidence for trusting it. An empty in-flight list from
 * a healthy recorder means the coast is clear; the same list from a recorder that has not
 * written in six hours means nobody knows.
 */

/** How stale the newest ledger event may be before silence stops meaning "quiet". */
const STALE_LEDGER_HOURS = 6;

/**
 * How far behind the journal may fall before it means ingest is not running.
 *
 * The journal is drained on `Stop`, so a backlog during an active session is normal and says
 * nothing. Age is the signal that separates "mid-session" from "the drain never happened":
 * entries older than this were written by a session that has certainly ended.
 */
const STALE_JOURNAL_HOURS = 12;

export type RecordingVerdict = "recording" | "idle" | "stale";

export interface RecordingHealth {
  readonly ledgerExists: boolean;
  readonly eventsInWindow: number;
  /** Age of the newest event in the window, or null when the window holds none. */
  readonly newestEventAgeMs: number | null;
  readonly journalPending: number;
  readonly journalAgeMs: number | null;
  /**
   * What an empty answer from this repository is worth.
   *
   * `recording` -- the pipeline is demonstrably live, so silence is real silence.
   * `idle` -- nothing recent, but nothing broken either; this is a quiet repository.
   * `stale` -- something is wrong, and no absence reported here should be trusted.
   */
  readonly verdict: RecordingVerdict;
  readonly reason: string;
}

export interface ActiveWork {
  readonly inFlight: readonly InFlightCall[];
  readonly recording: RecordingHealth;
  readonly withinMinutes: number;
}

export interface ActiveWorkOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly withinMinutes?: number | undefined;
  /** Leave this agent's own running calls out, so a caller does not see itself as company. */
  readonly excludeAgentId?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_WITHIN_MINUTES = 240;

function journalHealth(worktreeRoot: string, now: Date): { pending: number; ageMs: number | null } {
  const journalPath = join(worktreeRoot, LEDGER_DIRECTORY, "journal.ndjson");
  try {
    if (!existsSync(journalPath)) return { pending: 0, ageMs: null };
    const pending = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
    return { pending, ageMs: now.getTime() - statSync(journalPath).mtimeMs };
  } catch {
    // An unreadable journal is not a failed answer. It costs the backlog signal, nothing else.
    return { pending: 0, ageMs: null };
  }
}

export function readActiveWork(options: ActiveWorkOptions): ActiveWork {
  const now = (options.now ?? (() => new Date()))();
  const withinMinutes = Math.max(options.withinMinutes ?? DEFAULT_WITHIN_MINUTES, 1);
  const since = new Date(now.getTime() - withinMinutes * 60_000);

  let inFlight: readonly InFlightCall[] = [];
  try {
    inFlight = readInFlightCalls({
      worktreeRoot: options.worktreeRoot,
      now: () => now,
      excludeAgentId: options.excludeAgentId,
    });
  } catch {
    inFlight = [];
  }

  const ledgerExists = existsSync(options.ledgerPath);
  let events: readonly { timestamp: string }[] = [];
  if (ledgerExists) {
    try {
      events = readWindowCached(options.ledgerPath, { since: since.toISOString() }, { validate: false });
    } catch {
      events = [];
    }
  }
  const newest = events.reduce<string | null>(
    (latest, event) => (latest === null || event.timestamp > latest ? event.timestamp : latest),
    null,
  );
  const newestEventAgeMs = newest === null ? null : now.getTime() - new Date(newest).getTime();
  const journal = journalHealth(options.worktreeRoot, now);

  const { verdict, reason } = verdictFor(ledgerExists, newestEventAgeMs, journal, inFlight.length);

  return {
    inFlight,
    recording: {
      ledgerExists,
      eventsInWindow: events.length,
      newestEventAgeMs,
      journalPending: journal.pending,
      journalAgeMs: journal.ageMs,
      verdict,
      reason,
    },
    withinMinutes,
  };
}

function verdictFor(
  ledgerExists: boolean,
  newestEventAgeMs: number | null,
  journal: { pending: number; ageMs: number | null },
  inFlightCount: number,
): { verdict: RecordingVerdict; reason: string } {
  if (!ledgerExists) {
    return {
      verdict: "stale",
      reason: "there is no ledger, so nothing has ever been recorded here and no absence below means anything",
    };
  }
  if (journal.ageMs !== null && journal.pending > 0 && journal.ageMs > STALE_JOURNAL_HOURS * 3_600_000) {
    return {
      verdict: "stale",
      reason:
        `${journal.pending} journal entr(ies) have been waiting to be ingested for over `
        + `${STALE_JOURNAL_HOURS}h, which means the drain is not running`,
    };
  }
  // A call in flight is itself proof the hook is firing, whatever the ledger looks like: the
  // journal it was read from is written by the same binary that records everything else.
  if (inFlightCount > 0) {
    return { verdict: "recording", reason: "calls are in flight, so the recording hook is firing right now" };
  }
  if (newestEventAgeMs === null) {
    return {
      verdict: "idle",
      reason: "the ledger exists but holds nothing in this window, so this is a quiet repository rather than a broken one",
    };
  }
  if (newestEventAgeMs > STALE_LEDGER_HOURS * 3_600_000) {
    return {
      verdict: "stale",
      reason: `the newest recorded event is over ${STALE_LEDGER_HOURS}h old, so recording may have stopped`,
    };
  }
  return { verdict: "recording", reason: "events were recorded recently, so silence here is real silence" };
}

/**
 * One line, bounded, for a call that may be a whole script.
 *
 * The journal flattens nothing: a heredoc or an inlined program arrives with its newlines
 * intact and turns a one-line presence report into a page of somebody else's source. What a
 * reader needs from a running call is which tool and roughly what, not the text of it. Same
 * bound and same reason as `summarizeOperation` in the gateway's recall renderer.
 */
const OPERATION_LIMIT = 120;

function summarize(operation: string): string {
  const firstLine = operation.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.trim();
  const truncated = collapsed.length < operation.trim().length;
  return collapsed.length > OPERATION_LIMIT
    ? `${collapsed.slice(0, OPERATION_LIMIT)} …`
    : `${collapsed}${truncated ? " …" : ""}`;
}

/** A duration a reader can weigh, rather than a millisecond count they have to convert. */
function age(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function renderActiveWork(result: ActiveWork): string {
  const short = idShortener(result.inFlight.flatMap((call) => (call.agentId === null ? [] : [call.agentId])));

  const presence =
    result.inFlight.length === 0
      ? "No other worker has a call in flight right now."
      : `${result.inFlight.length} call(s) are running right now:\n`
        + result.inFlight
          .map((call) => {
            const who = call.agentId === null ? "an unidentified worker" : short(call.agentId);
            const what = call.operation === null ? call.hostToolName : `${call.hostToolName}: ${summarize(call.operation)}`;
            return `- ${who} — ${what} (running ${age(call.runningForMs)})`;
          })
          .join("\n");

  // The verdict is printed even when work is in flight, because it is what says how much the
  // *absence* of other work is worth - and that is the half a reader acts on.
  const trust = `\n\nRecording: ${result.recording.verdict} — ${result.recording.reason}.`;

  const detail =
    result.recording.newestEventAgeMs === null
      ? ""
      : ` Newest recorded event ${age(result.recording.newestEventAgeMs)} ago;`
        + ` ${result.recording.eventsInWindow} event(s) in this window.`;

  const backlog =
    result.recording.journalPending > 0
      ? ` ${result.recording.journalPending} entr(ies) not yet ingested`
        + `${result.recording.journalAgeMs === null ? "" : `, last written ${age(result.recording.journalAgeMs)} ago`}.`
      : "";

  return `${presence}${trust}${detail}${backlog}`;
}
