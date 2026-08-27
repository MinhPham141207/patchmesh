import type { NormalizedTool } from "../tool-mapping.js";
import { GIT_COMMIT } from "./claude-code.js";
import type { HostAdapter, HostRecord } from "./types.js";

const HOST_TOOLS: Readonly<Record<string, NormalizedTool>> = {
  read_file: { toolName: "read_file", pathProperty: "path", opaque: false },
  read: { toolName: "read_file", pathProperty: "path", opaque: false },
  apply_patch: { toolName: "edit_file", pathProperty: null, opaque: true },
  edit_file: { toolName: "edit_file", pathProperty: "path", opaque: false },
  shell: { toolName: "run_shell", pathProperty: null, opaque: true },
  bash: { toolName: "run_shell", pathProperty: null, opaque: true },
  run_shell: { toolName: "run_shell", pathProperty: null, opaque: true },
  run_test: { toolName: "run_test", pathProperty: null, opaque: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function firstString(envelope: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(envelope[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstValue(envelope: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (envelope[key] !== undefined) return envelope[key];
  }
  return undefined;
}

function eventOf(envelope: Record<string, unknown>): string | null {
  return firstString(envelope, ["hook_event_name", "event", "event_name", "hookEventName"]);
}

function stageOf(event: string | null): HostRecord["stage"] | null {
  if (event === "PreToolUse" || event === "preToolUse") return "pre";
  if (event === "PostToolUse" || event === "postToolUse" || event === "PostToolUseFailure" || event === "postToolUseFailure") {
    return "post";
  }
  return event === null ? "post" : null;
}

export function normalizeCodexTool(hostToolName: string, command: string | null): NormalizedTool {
  const key = hostToolName.trim().toLowerCase();
  const mapped = HOST_TOOLS[key];
  if (mapped === undefined) return { toolName: "other", pathProperty: null, opaque: true };
  if (mapped.toolName === "run_shell" && command !== null && GIT_COMMIT.test(command)) {
    return { ...mapped, toolName: "git_commit" };
  }
  return mapped;
}

/** Parse the observed Codex hook shape, plus the canonical aliases used by the relay. */
export function parseCodexEnvelope(envelope: unknown): HostRecord | null {
  if (!isRecord(envelope)) return null;
  const stage = stageOf(eventOf(envelope));
  if (stage === null) return null;
  const sessionId = firstString(envelope, ["session_id", "conversation_id", "thread_id", "sessionId", "conversationId", "threadId"]);
  const hostToolName = firstString(envelope, ["tool_name", "toolName"]);
  if (sessionId === null || hostToolName === null) return null;
  const input = firstValue(envelope, ["tool_input", "toolInput", "input"]);
  const response = firstValue(envelope, ["tool_response", "toolResponse", "output", "result"]);
  const event = eventOf(envelope);
  const errored = event === "PostToolUseFailure" || event === "postToolUseFailure" || isRecord(response) && (
    response["is_error"] === true || response["isError"] === true || typeof response["error"] === "string"
  );
  return {
    stage,
    sessionId,
    hostToolName,
    input,
    response,
    delegateId: firstString(envelope, ["tool_use_id", "toolUseId", "tool_call_id", "toolCallId", "call_id", "callId", "turn_id", "generation_id"]),
    delegateType: firstString(envelope, ["agent_type", "agentType"]),
    subagentId: firstString(envelope, ["agent_id", "agentId"]),
    ...(errored ? { errored: true } : {}),
  };
}

export const codexAdapter: HostAdapter = {
  id: "codex",
  displayName: "Codex",
  tier: "observed",
  parse: parseCodexEnvelope,
};
