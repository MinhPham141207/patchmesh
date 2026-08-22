import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentIdForSession } from "./identity.js";
import { JOURNAL_FILENAME, parseJournalLine } from "./journal.js";

/**
 * What is running right now, read from the journal rather than the ledger.
 *
 * The ledger cannot answer this and never will: ingest runs on the session's Stop hook, so by
 * the time a call reaches the ledger the work it describes has finished. In-flight state only
 * exists in the journal, which the hook writes live.
 *
 * A `PreToolUse` entry with no matching `PostToolUse` is a call that started and has not
 * reported back. The host's own `tool_use_id` pairs them, so nothing is inferred from ordering
 * or timing. This is the collision guard the ledger could not provide: another agent's started
 * work is visible to a second agent before either of them finishes.
 *
 * Reading is best effort by design. Ingest renames the journal aside while draining, so an
 * entry can vanish mid-read; claims are scanned too, but a missing file means "nothing to
 * report", never an error.
 */

/** A call that started and has not been observed finishing. */
export interface InFlightCall {
  readonly at: string;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly operation: string | null;
  /** How long it has been running, in milliseconds, at the time of the read. */
  readonly runningForMs: number;
}

/**
 * A call still unfinished after this long is treated as lost rather than running.
 *
 * A hook that crashed, or a session killed mid-call, leaves a `PreToolUse` no `PostToolUse`
 * will ever answer. Reporting those forever would turn the in-flight view into a graveyard
 * that makes every file look contested.
 */
export const ABANDONED_AFTER_MS = 15 * 60_000;

const MAX_IN_FLIGHT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Every journal file that may hold live entries: the open one, plus any claim being drained. */
function journalFilesFor(journalPath: string): readonly string[] {
  const files = [journalPath];
  const directory = dirname(journalPath);
  const prefix = `${basename(journalPath)}.`;
  try {
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(prefix) && entry.endsWith(".processing")) files.push(join(directory, entry));
    }
  } catch {
    // No directory yet. The open journal alone is enough to try.
  }
  return files;
}

export interface ReadInFlightOptions {
  readonly worktreeRoot: string;
  readonly directory?: string | undefined;
  readonly now?: (() => Date) | undefined;
  /** Ignore this agent's own calls, so a caller does not see itself as a collision. */
  readonly excludeAgentId?: string | undefined;
}

export function readInFlightCalls(options: ReadInFlightOptions): readonly InFlightCall[] {
  const journalPath = join(options.worktreeRoot, options.directory ?? ".patchmesh", JOURNAL_FILENAME);
  const now = (options.now ?? (() => new Date()))().getTime();

  // Keyed by the host's own call id, so a start and its completion pair without guessing.
  const started = new Map<string, InFlightCall>();
  const finished = new Set<string>();

  for (const file of journalFilesFor(journalPath)) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      const entry = parseJournalLine(line);
      if (entry === null || !isRecord(entry.payload)) continue;
      const payload = entry.payload;
      const callId = stringField(payload, "tool_use_id");
      if (callId === null) continue;

      const event = stringField(payload, "hook_event_name");
      if (event === "PostToolUse") {
        finished.add(callId);
        continue;
      }
      if (event !== "PreToolUse") continue;

      const sessionId = stringField(payload, "session_id");
      const toolInput = isRecord(payload["tool_input"]) ? payload["tool_input"] : {};
      started.set(callId, {
        at: entry.at,
        agentId: sessionId === null ? null : agentIdForSession(sessionId),
        hostToolName: stringField(payload, "tool_name") ?? "unknown",
        operation: stringField(toolInput, "command") ?? stringField(toolInput, "file_path"),
        runningForMs: Math.max(now - new Date(entry.at).getTime(), 0),
      });
    }
  }

  const live: InFlightCall[] = [];
  for (const [callId, call] of started) {
    if (finished.has(callId)) continue;
    if (call.runningForMs > ABANDONED_AFTER_MS) continue;
    if (options.excludeAgentId !== undefined && call.agentId === options.excludeAgentId) continue;
    live.push(call);
  }
  // Longest-running first: a call that has been going for minutes is the one worth knowing about.
  live.sort((left, right) => right.runningForMs - left.runningForMs);
  return live.slice(0, MAX_IN_FLIGHT);
}
