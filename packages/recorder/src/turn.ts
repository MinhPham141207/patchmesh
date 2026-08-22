import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Turn markers - the journal entries that open one unit of top-level work.
 *
 * A delegated run is named by the host: its calls carry `agent_id` and its spawn carries the
 * same id back, so a subagent's work always had a task. Ordinary work had nothing, because a
 * session is not a unit of work - it is every unit the user asked for, run together.
 *
 * `UserPromptSubmit` is the boundary the host already publishes. Recording it costs the
 * tool-call path nothing: the hook fires once per turn rather than once per call, and the
 * recorder journals its payload with the same append it uses for everything else. Turn state
 * is then replayed at ingest, which walks entries in order anyway.
 *
 * A turn does not reliably end where a drain ends, though, so the open turn per session is
 * carried between drains as well - see `readTurnState` below for what that costs and why the
 * first design without it lost most of its attribution.
 *
 * The prompt itself is never read. `redactHookPayload` drops it before the first disk write,
 * and only the host's opaque `prompt_id` survives to name the turn.
 */

const TURN_HOOK_EVENT = "UserPromptSubmit";

/**
 * The hook that reports a call is starting. It is journalled for the live in-flight view and
 * is not a record of work done, so ingest must skip it: the same call arrives again as
 * `PostToolUse`, and recording both would double every call in the ledger.
 */
const START_HOOK_EVENT = "PreToolUse";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether this journal entry opens a turn rather than recording a tool call.
 *
 * Ingest must ask before building events: a marker has no `tool_name`, so handing it to
 * `buildHookEvents` would raise and file a perfectly good entry as unrepresentable.
 */
export function isTurnMarker(payload: unknown): boolean {
  return isRecord(payload) && payload["hook_event_name"] === TURN_HOOK_EVENT;
}

/** Whether this entry announces a call rather than reporting one. See `readInFlightCalls`. */
export function isCallStart(payload: unknown): boolean {
  return isRecord(payload) && payload["hook_event_name"] === START_HOOK_EVENT;
}

export interface TurnFields {
  /** Which session opened the turn. Two sessions recording into one repository interleave. */
  readonly sessionId: string | null;
  /** The host's own identifier for the prompt, when it declares one. */
  readonly promptId: string | null;
}

export function turnFieldsOf(payload: unknown): TurnFields {
  if (!isRecord(payload)) return { sessionId: null, promptId: null };
  const sessionId = payload["session_id"];
  const promptId = payload["prompt_id"];
  return {
    sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
    promptId: typeof promptId === "string" && promptId !== "" ? promptId : null,
  };
}

/**
 * Turn state that outlives the drain which observed it.
 *
 * The original design replayed turn state inside a single drain and deliberately held nothing
 * across processes, on the assumption that a drain boundary is a turn boundary — ingest runs on
 * `Stop`, which fires once per turn. Measured against this repository's own ledger that
 * assumption fails often: null-attributed calls arrive in contiguous blocks of 37, 28 and 4,
 * which is the shape of whole drains whose marker was consumed by an earlier one, not of
 * scattered per-call failures. A marker is journalled once per turn while calls are journalled
 * many times over, so a single marker landing in the wrong drain unattributes the whole turn.
 *
 * Carrying it forward is not inference. The host really did declare that turn; this only
 * remembers the declaration past the process that saw it, exactly as `carryForward` remembers
 * an unfinished call past the drain that saw it start.
 */
export const TURN_STATE_FILENAME = "turns.json";

export const TURN_STATE_VERSION = 1;

/**
 * A turn untouched for this long is treated as over.
 *
 * Without a ceiling, a session that ended without a final marker would keep claiming every
 * later call in its repository, which is the opposite failure: confident attribution to work
 * that finished yesterday. Twelve hours is longer than any single turn and shorter than the
 * gap between working days.
 */
export const TURN_STATE_TTL_MS = 12 * 60 * 60_000;

/** The turn a session most recently opened, and when the host declared it. */
export interface OpenTurn {
  readonly taskId: string | null;
  readonly at: string;
}

export function turnStatePathFor(worktreeRoot: string, directory: string): string {
  return join(worktreeRoot, directory, TURN_STATE_FILENAME);
}

/**
 * Read the turns still open when the last drain ended, dropping any that have expired.
 *
 * Unreadable or malformed state is not an error. Losing it costs attribution on one drain,
 * which is the behaviour that existed before this file did; failing the ingest would cost the
 * recorded calls themselves.
 */
export function readTurnState(statePath: string, now: Date): Map<string, OpenTurn> {
  const open = new Map<string, OpenTurn>();
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return open;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return open;
  }
  if (!isRecord(parsed) || parsed["v"] !== TURN_STATE_VERSION) return open;
  const sessions = parsed["sessions"];
  if (!isRecord(sessions)) return open;

  const oldest = now.getTime() - TURN_STATE_TTL_MS;
  for (const [sessionId, value] of Object.entries(sessions)) {
    if (!isRecord(value)) continue;
    const at = value["at"];
    if (typeof at !== "string") continue;
    const declaredAt = new Date(at).getTime();
    if (Number.isNaN(declaredAt) || declaredAt < oldest) continue;
    const taskId = value["taskId"];
    open.set(sessionId, { taskId: typeof taskId === "string" ? taskId : null, at });
  }
  return open;
}

/**
 * Persist the turns left open by this drain.
 *
 * Written whole rather than appended: this is current state, not history, and the ledger is
 * where history lives. A write failure is swallowed for the same reason a read failure is.
 */
export function writeTurnState(statePath: string, turns: ReadonlyMap<string, OpenTurn>, now: Date): void {
  const oldest = now.getTime() - TURN_STATE_TTL_MS;
  const sessions: Record<string, OpenTurn> = {};
  for (const [sessionId, turn] of turns) {
    const declaredAt = new Date(turn.at).getTime();
    if (Number.isNaN(declaredAt) || declaredAt < oldest) continue;
    sessions[sessionId] = turn;
  }

  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ v: TURN_STATE_VERSION, sessions })}\n`, "utf8");
  } catch {
    // The next drain starts from an empty map and attributes one turn's calls to null.
  }
}
