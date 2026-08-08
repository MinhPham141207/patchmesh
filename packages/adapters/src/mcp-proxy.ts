import { randomUUID } from "node:crypto";
import {
  parseEvent,
  ProtocolValidationError,
  type EventId,
  type ProtocolEvent,
  type ToolCompletedEvent,
  type ToolRequestedEvent,
} from "@patchmesh/protocol";
import type {
  McpCallContext,
  McpProxyOptions,
  McpProxyResult,
  McpToolCall,
  EventAppender,
  ToolExecutionResult,
  ToolExecutor,
} from "./types.js";
import { McpProxyStorageError } from "./errors.js";

function appendValidated(event: ProtocolEvent, eventStore: EventAppender): ProtocolEvent {
  const parsed = parseEvent(event);
  if (parsed.value === null) throw new ProtocolValidationError(parsed.diagnostics);
  return eventStore.append(parsed.value).event;
}

function asToolRequested(event: ProtocolEvent): ToolRequestedEvent {
  if (event.eventType !== "tool.requested") throw new Error("stored request event has an invalid type");
  return event;
}

function createToolRequestedEvent(
  call: McpToolCall,
  context: McpCallContext,
  eventId: EventId,
  timestamp: string,
): ToolRequestedEvent {
  return {
    schemaVersion: 1,
    eventId,
    eventType: "tool.requested",
    source: context.source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    sourceSequence: context.requestSourceSequence,
    payload: {
      toolName: call.toolName,
      operation: call.operation,
      targetResourceId: call.targetResourceId,
      opaque: call.opaque,
    },
  };
}

function createToolCompletedEvent(
  context: McpCallContext,
  requestEventId: EventId,
  eventId: EventId,
  timestamp: string,
  outcome: ToolCompletedEvent["payload"]["outcome"],
  exitCode: number | null,
): ToolCompletedEvent {
  return {
    schemaVersion: 1,
    eventId,
    eventType: "tool.completed",
    source: context.source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: requestEventId,
    sourceSequence: context.completionSourceSequence,
    payload: {
      requestEventId,
      outcome,
      exitCode,
      effectEventIds: [],
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class McpProxy {
  private readonly eventStore: EventAppender;
  private readonly createEventId: () => EventId;
  private readonly now: () => string;

  constructor(options: McpProxyOptions) {
    this.eventStore = options.eventStore;
    this.createEventId = options.createEventId ?? (() => `evt_${randomUUID()}` as EventId);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async execute<T>(
    call: McpToolCall,
    context: McpCallContext,
    executor: ToolExecutor<T>,
    signal?: AbortSignal,
  ): Promise<McpProxyResult<T>> {
    let requestEvent: ToolRequestedEvent;
    try {
      requestEvent = asToolRequested(appendValidated(
        createToolRequestedEvent(call, context, this.createEventId(), this.now()),
        this.eventStore,
      ));
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw error;
      throw new McpProxyStorageError(
        "MCP_REQUEST_PERSIST_FAILED",
        "request",
        null,
        null,
        { cause: error },
      );
    }

    const executionSignal = signal ?? new AbortController().signal;
    let execution: ToolExecutionResult<T>;
    try {
      execution = await executor(executionSignal);
    } catch (error) {
      execution = executionSignal.aborted || isAbortError(error)
        ? { outcome: "interrupted", exitCode: null }
        : { outcome: "failed", error, exitCode: null };
    }

    let completedEvent: ProtocolEvent;
    try {
      completedEvent = appendValidated(
        createToolCompletedEvent(
          context,
          requestEvent.eventId,
          this.createEventId(),
          this.now(),
          execution.outcome,
          execution.exitCode,
        ),
        this.eventStore,
      );
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw error;
      throw new McpProxyStorageError(
        "MCP_COMPLETION_PERSIST_FAILED",
        "completion",
        requestEvent.eventId,
        execution.outcome,
        { cause: error },
      );
    }

    return {
      execution,
      requestEventId: requestEvent.eventId,
      completedEventId: completedEvent.eventId,
    };
  }
}
