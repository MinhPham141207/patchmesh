import type { NormalizedTool } from "../tool-mapping.js";
import type { HostAdapter, HostRecord } from "./types.js";

/**
 * Host tool names carry no coordination meaning on their own, so each is mapped onto the
 * closed protocol vocabulary. Anything unrecognized maps to `other` and stays opaque:
 * an unknown tool must never be silently treated as a read or a write.
 */
const HOST_TOOLS: Readonly<Record<string, NormalizedTool>> = {
  Read: { toolName: "read_file", pathProperty: "file_path", opaque: false },
  NotebookRead: { toolName: "read_file", pathProperty: "notebook_path", opaque: false },
  Write: { toolName: "edit_file", pathProperty: "file_path", opaque: false },
  Edit: { toolName: "edit_file", pathProperty: "file_path", opaque: false },
  MultiEdit: { toolName: "edit_file", pathProperty: "file_path", opaque: false },
  NotebookEdit: { toolName: "edit_file", pathProperty: "notebook_path", opaque: false },
  // Delegation is recorded as itself, not as an unrecognized call: the spawn is the edge
  // that links a parent's stream to the subagent's, so a detector must be able to find it
  // without matching on host tool names. It stays opaque because what the subagent will
  // touch is unknowable at spawn time - that is what its own recorded calls are for.
  // Claude Code names this tool `Agent`; `Task` is kept for hosts and older builds that use
  // that name for the same operation.
  Agent: { toolName: "spawn_subagent", pathProperty: null, opaque: true },
  Task: { toolName: "spawn_subagent", pathProperty: null, opaque: true },
  Bash: { toolName: "run_shell", pathProperty: null, opaque: true },
  BashOutput: { toolName: "run_shell", pathProperty: null, opaque: true },
  KillShell: { toolName: "run_shell", pathProperty: null, opaque: true },
};

/** A shell command whose effect is a commit, recognized only in its unambiguous form. */
const GIT_COMMIT = /^\s*git\s+(?:-[^\s]+\s+|--[^\s]+(?:=[^\s]+)?\s+)*commit\b/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function normalizeClaudeTool(hostToolName: string, command: string | null): NormalizedTool {
  const mapped = HOST_TOOLS[hostToolName];
  if (mapped === undefined) {
    return { toolName: "other", pathProperty: null, opaque: true };
  }
  if (mapped.toolName === "run_shell" && command !== null && GIT_COMMIT.test(command)) {
    return { ...mapped, toolName: "git_commit" };
  }
  return mapped;
}

export function recognizesClaudeHostTool(hostToolName: string): boolean {
  return Object.hasOwn(HOST_TOOLS, hostToolName);
}

/**
 * Reads exactly the fields today's `HookPayload` relies on from a Claude Code `PostToolUse`
 * envelope. An envelope without `hook_event_name`, or whose `tool_name` is not a non-empty
 * string, is not one this adapter can own - returning null lets the caller decide what an
 * unclaimed envelope means rather than recording a half-understood call.
 */
export function parseClaudeEnvelope(envelope: unknown): HostRecord | null {
  if (!isRecord(envelope)) return null;
  if (envelope["hook_event_name"] === undefined) return null;
  const rawToolName = envelope["tool_name"];
  const hostToolName = typeof rawToolName === "string" ? rawToolName.trim() : "";
  if (hostToolName === "") return null;
  return {
    stage: "post",
    sessionId: typeof envelope["session_id"] === "string" ? envelope["session_id"] : "",
    hostToolName,
    input: envelope["tool_input"],
    response: envelope["tool_response"],
    delegateId: stringOrNull(envelope["tool_use_id"]),
    delegateType: stringOrNull(envelope["agent_type"]),
  };
}

export const claudeCodeAdapter: HostAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  tier: "observed",
  parse: parseClaudeEnvelope,
};
