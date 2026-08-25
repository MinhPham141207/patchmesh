import { sanitizeDiagnostic } from "patchmesh-observation";
import type { AgentId, EventId, ProtocolEvent, Source, TaskId } from "patchmesh-protocol";
import { attributionFieldsOf, resolveAttribution, type CallAttribution } from "./attribution.js";
import {
  createCorrelationId,
  createEventId,
  logicalPathFor,
  resolveRepositoryIdentity,
  resourceIdForPath,
  deterministicUuid,
} from "./identity.js";
import { normalizeTool } from "./tool-mapping.js";

/** The subset of a Claude Code `PostToolUse` hook payload the recorder relies on. */
export interface HookPayload {
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
  /**
   * Host identifier for this specific invocation. It is the join key between a recorded
   * call and the transcript turn that made it, which is what attribution is resolved from,
   * and for a spawn it also names the task the subagent will run under.
   */
  readonly tool_use_id?: unknown;
  /** Where the host wrote the conversation this call belongs to. */
  readonly transcript_path?: unknown;
  /** Present only on a call a subagent made: the host's id for that delegate. */
  readonly agent_id?: unknown;
  readonly agent_type?: unknown;
}

export interface RecordedPair {
  readonly requested: ProtocolEvent;
  readonly completed: ProtocolEvent;
}

export class HookRecordingError extends Error {}

const MAX_OPERATION_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Phase 0 `operation` pattern rejects leading/trailing whitespace and, because JSON
 * Schema patterns run without the dotall flag, anything containing a newline. Host
 * commands are routinely multi-line, so whitespace is collapsed before redaction.
 */
export function normalizeOperation(value: string, fallback: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  const redacted = sanitizeDiagnostic(collapsed === "" ? fallback : collapsed);
  const bounded = redacted.replace(/\s+/gu, " ").trim().slice(0, MAX_OPERATION_LENGTH).trim();
  return bounded === "" ? fallback : bounded;
}

function commandOf(toolInput: unknown): string | null {
  if (!isRecord(toolInput)) return null;
  const command = toolInput["command"];
  return typeof command === "string" ? command : null;
}

function describedOperation(hostToolName: string, toolInput: unknown, logicalPath: string | null): string {
  const command = commandOf(toolInput);
  if (command !== null) return normalizeOperation(`${hostToolName} ${command}`, hostToolName);
  if (logicalPath !== null) return normalizeOperation(`${hostToolName} ${logicalPath}`, hostToolName);
  return normalizeOperation(hostToolName, "tool");
}

/**
 * Hosts report failure inconsistently across tools, so only an explicit signal is read as
 * failure. An unreadable response is recorded as succeeded with a null exit code rather
 * than inventing an outcome; coverage, not the outcome field, carries that uncertainty.
 */
function outcomeOf(toolResponse: unknown): { outcome: "succeeded" | "failed"; exitCode: number | null } {
  if (!isRecord(toolResponse)) return { outcome: "succeeded", exitCode: null };
  const rawExit = toolResponse["exit_code"] ?? toolResponse["exitCode"];
  const exitCode = typeof rawExit === "number" && Number.isInteger(rawExit) ? rawExit : null;
  const errored =
    toolResponse["is_error"] === true ||
    toolResponse["isError"] === true ||
    typeof toolResponse["error"] === "string" ||
    (exitCode !== null && exitCode !== 0);
  return { outcome: errored ? "failed" : "succeeded", exitCode };
}

function pathFrom(toolInput: unknown, property: string | null): string | null {
  if (property === null || !isRecord(toolInput)) return null;
  const value = toolInput[property];
  return typeof value === "string" ? value : null;
}

/**
 * The worktree-relative logical path this call's own input declared, or null when it names
 * none.
 *
 * Shared between the recorded pair and effect attribution so both read the same declaration
 * the same way -- including which `tool_input` property counts (a notebook edit declares
 * `notebook_path`, not `file_path`). Normalized by `logicalPathFor`, so a declared path and
 * an observed change's path compare equal.
 */
export function declaredLogicalPath(worktreeRoot: string, payload: HookPayload): string | null {
  const hostToolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  const normalized = normalizeTool(hostToolName, commandOf(payload.tool_input));
  const rawPath = pathFrom(payload.tool_input, normalized.pathProperty);
  return rawPath === null ? null : logicalPathFor(worktreeRoot, rawPath);
}

export interface BuildHookEventsOptions {
  readonly payload: HookPayload;
  readonly worktreeRoot: string;
  readonly now?: () => string;
  readonly nextEventId?: () => EventId;
  /**
   * Overrides the attribution read from the payload. Only tests supply it; real recordings
   * resolve attribution from the fields the host declares.
   */
  readonly attribution?: CallAttribution | undefined;
  /**
   * Task opened by the turn this call fell inside, replayed by ingest from the preceding
   * `UserPromptSubmit` marker. Ignored when the host declared a delegated task.
   */
  readonly turnTaskId?: TaskId | null;
}

/**
 * Build the causally linked `tool.requested` / `tool.completed` pair for one completed
 * host tool call. Both events are produced from a single `PostToolUse` invocation, so the
 * completion always has its request durable in the same atomic append - there is no
 * cross-process correlation to lose.
 */
export function buildHookEvents(options: BuildHookEventsOptions): RecordedPair {
  const { payload, worktreeRoot } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const nextEventId = options.nextEventId ?? createEventId;

  const hostToolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
  if (hostToolName === "") throw new HookRecordingError("hook payload has no tool_name");

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const identity = resolveRepositoryIdentity(worktreeRoot);
  const normalized = normalizeTool(hostToolName, commandOf(payload.tool_input));
  // Both halves of the link are declared by the host: a subagent's calls carry `agent_id`,
  // and the spawn's response carries that same id. Nothing here is inferred.
  const fields = attributionFieldsOf(payload);
  const attribution =
    options.attribution ??
    resolveAttribution({ sessionId, hostToolName, ...fields, turnTaskId: options.turnTaskId ?? null });
  const agentId: AgentId | null = attribution.agentId;
  const taskId: TaskId | null = attribution.taskId;
  const logicalPath = declaredLogicalPath(identity.worktreeRoot, payload);
  const targetResourceId =
    logicalPath === null ? null : resourceIdForPath(identity.repositoryId, logicalPath);

  const source: Source = {
    kind: "gateway",
    sourceId: "source_claude_code_hook",
    // Stable per session so one agent session is one producer stream.
    instanceId: deterministicUuid("patchmesh:recorder-instance", sessionId),
  };

  const correlationId = createCorrelationId();
  const requestedId = nextEventId();
  const completedId = nextEventId();
  const envelope = {
    schemaVersion: 1 as const,
    source,
    timestamp: now(),
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
    agentId,
    taskId,
    correlationId,
    sourceSequence: null,
  };

  const { outcome, exitCode } = outcomeOf(payload.tool_response);

  const requested = {
    ...envelope,
    eventId: requestedId,
    eventType: "tool.requested" as const,
    causationId: null,
    payload: {
      toolName: normalized.toolName,
      hostToolName,
      operation: describedOperation(hostToolName, payload.tool_input, logicalPath),
      targetResourceId,
      // A resolvable in-repository path is the only thing that makes a call non-opaque.
      opaque: normalized.opaque || targetResourceId === null,
    },
  } as unknown as ProtocolEvent;

  const completed = {
    ...envelope,
    eventId: completedId,
    eventType: "tool.completed" as const,
    causationId: requestedId,
    payload: {
      requestEventId: requestedId,
      outcome,
      exitCode,
      // Effect observation is not part of this slice; an empty set is honest.
      effectEventIds: [],
    },
  } as unknown as ProtocolEvent;

  return { requested, completed };
}
