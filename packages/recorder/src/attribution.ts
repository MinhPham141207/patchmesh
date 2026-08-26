import type { AgentId, TaskId } from "patchmesh-protocol";
import { agentIdForSession, subagentIdFor, taskIdForDelegate } from "./identity.js";

/**
 * Which agent made one recorded tool call, and which task it belongs to.
 *
 * `agentId` separates a subagent run from the session that spawned it; `taskId` is shared by
 * the spawning call and every call that subagent makes, which is what joins two independently
 * recorded streams back into one unit of work.
 */
export interface CallAttribution {
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
}

/** Host tools that delegate work to a subagent. Claude Code names it `Agent`; `Task` is kept
 * because other hosts and older builds use that name for the same operation. */
export const SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: unknown, key: string): string | null {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export interface AttributionInput {
  readonly sessionId: string;
  readonly hostToolName: string;
  /** `agent_id`, present only on a call a subagent made. */
  readonly agentId: string | null;
  /** `tool_response.agentId`, present only on the spawn that created that subagent. */
  readonly spawnedAgentId: string | null;
  /**
   * The task opened by the turn this call falls inside, replayed from the last
   * `UserPromptSubmit` marker. Used only when the host declared no delegated task.
   */
  readonly turnTaskId?: TaskId | null;
}

/**
 * Resolve attribution from one hook payload plus the turn it fell inside.
 *
 * The host declares both halves of the delegation link and neither is inferred. A subagent's
 * calls carry its `agent_id`; the spawning call's response carries that same id as `agentId`.
 * Everything else is the session's own work, attributed to the turn that opened it.
 *
 * A delegated task always wins over the turn task. It is the more specific claim - the turn
 * says which request the work serves, the delegate says which run performed it - and losing
 * it would collapse a subagent back into its parent, which is the whole point of attribution.
 *
 * This replaces an earlier design that reconstructed lineage from the host transcript. Real
 * subagent traffic disproved it: a subagent's calls reach `PostToolUse` under the *parent's*
 * `session_id` and `transcript_path`, are written to no transcript at all, and no entry
 * anywhere is marked as a sidechain - so there was nothing in the transcript to walk.
 */
export function resolveAttribution(input: AttributionInput): CallAttribution {
  const sessionAgentId = agentIdForSession(input.sessionId);

  // A call the host stamped with an agent is that agent's, whatever else it looks like.
  if (input.agentId !== null) {
    return {
      agentId: subagentIdFor(input.sessionId, input.agentId),
      taskId: taskIdForDelegate(input.agentId),
    };
  }

  // A spawn is the parent's own work, but it opens the task its subagent runs under.
  if (SPAWN_TOOL_NAMES.has(input.hostToolName) && input.spawnedAgentId !== null) {
    return { agentId: sessionAgentId, taskId: taskIdForDelegate(input.spawnedAgentId) };
  }

  // Ordinary top-level work: it belongs to the turn the user opened, and only falls back to
  // no task at all when no marker has been seen - a session whose first turn predates this
  // build, or a host that does not publish the boundary.
  return { agentId: sessionAgentId, taskId: input.turnTaskId ?? null };
}

/** The normalized host-record shape attribution is read from. */
export interface AttributionFieldsSource {
  /** The delegate that made this call, when the host named one (Claude's `agent_id`). */
  readonly subagentId?: unknown;
  readonly response?: unknown;
}

/**
 * Read the attribution fields out of a normalized host record: the subagent that made this
 * call, and the delegate a spawn's response says it created.
 */
export function attributionFieldsOf(record: AttributionFieldsSource): { agentId: string | null; spawnedAgentId: string | null } {
  return {
    agentId: typeof record.subagentId === "string" && record.subagentId !== "" ? record.subagentId : null,
    spawnedAgentId: stringField(record.response, "agentId"),
  };
}
