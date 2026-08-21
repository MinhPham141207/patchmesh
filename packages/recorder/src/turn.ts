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
 * is then replayed at ingest, which walks entries in order anyway, so nothing has to be held
 * across processes and the journal alone still reconstructs the ledger.
 *
 * The prompt itself is never read. `redactHookPayload` drops it before the first disk write,
 * and only the host's opaque `prompt_id` survives to name the turn.
 */

const TURN_HOOK_EVENT = "UserPromptSubmit";

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
