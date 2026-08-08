import { randomUUID } from "node:crypto";
import {
  parseEvent,
  ProtocolValidationError,
  type EventId,
  type FileChangedEvent,
  type LogicalResource,
  type ProtocolEvent,
  type ResourceVersion,
  type ToolCompletedEvent,
  type ToolRequestedEvent,
} from "@patchmesh/protocol";
import {
  deriveCoverage,
  diffSnapshots,
  fileResourceId,
  normalizeLogicalPath,
  type ObservationCapture,
  type ObservationContext,
  type ObservationGap,
  type ObservedFileChange,
} from "@patchmesh/observation";
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
  effectEventIds: readonly EventId[],
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
      effectEventIds,
    },
  };
}

function createResource(repositoryId: LogicalResource["repositoryId"], path: string): LogicalResource {
  const locator = normalizeLogicalPath(path);
  return {
    resourceId: fileResourceId(repositoryId, locator),
    repositoryId,
    kind: "file",
    locator,
  };
}

function createVersion(
  resourceId: LogicalResource["resourceId"],
  context: McpCallContext,
  state: ObservedFileChange["after"],
  eventId: EventId,
): ResourceVersion {
  return {
    resourceId,
    domain: {
      repositoryId: context.repositoryId,
      workspaceId: context.workspaceId,
      worktreeId: context.worktreeId,
    },
    kind: state === null ? "deleted" : "content_hash",
    value: state?.contentHash ?? null,
    evidenceEventIds: [eventId],
  };
}

function createFileChangedEvent(
  change: ObservedFileChange,
  context: McpCallContext,
  source: ProtocolEvent["source"],
  causationId: EventId | null,
  correlationId: ProtocolEvent["correlationId"],
  agentId: ProtocolEvent["agentId"],
  taskId: ProtocolEvent["taskId"],
  eventId: EventId,
  timestamp: string,
): FileChangedEvent {
  const resource = createResource(context.repositoryId, change.path);
  return {
    schemaVersion: 1,
    eventId,
    eventType: "file.changed",
    source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId,
    taskId,
    correlationId,
    causationId,
    sourceSequence: null,
    payload: {
      resource,
      beforeVersion: change.before === null
        ? null
        : createVersion(resource.resourceId, context, change.before, eventId),
      afterVersion: createVersion(resource.resourceId, context, change.after, eventId),
      changeKind: change.changeKind,
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
  private readonly observer: McpProxyOptions["observer"];
  private readonly createCorrelationId: () => ProtocolEvent["correlationId"];

  constructor(options: McpProxyOptions) {
    this.eventStore = options.eventStore;
    this.createEventId = options.createEventId ?? (() => `evt_${randomUUID()}` as EventId);
    this.now = options.now ?? (() => new Date().toISOString());
    this.observer = options.observer;
    this.createCorrelationId = options.createCorrelationId ?? (() => `corr_${randomUUID()}`);
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
    const observationGaps: ObservationGap[] = [];
    let beforeCapture: ObservationCapture | null = null;
    if (this.observer) {
      if (context.workspaceRoot === undefined) {
        observationGaps.push({
          kind: "unverified",
          scope: "workspace",
          reason: "workspace root was not supplied for observation",
        });
      } else {
        const observationContext: ObservationContext = {
          workspaceRoot: context.workspaceRoot,
          repositoryId: context.repositoryId,
          workspaceId: context.workspaceId,
          worktreeId: context.worktreeId,
        };
        try {
          beforeCapture = await this.observer.captureBefore(observationContext);
          observationGaps.push(...beforeCapture.gaps);
        } catch {
          observationGaps.push({
            kind: "unverified",
            scope: "before",
            reason: "pre-execution observation failed",
          });
        }
      }
    }

    let execution: ToolExecutionResult<T>;
    try {
      execution = await executor(executionSignal);
    } catch (error) {
      execution = executionSignal.aborted || isAbortError(error)
        ? { outcome: "interrupted", exitCode: null }
        : { outcome: "failed", error, exitCode: null };
    }

    let afterCapture: ObservationCapture | null = null;
    if (this.observer && context.workspaceRoot !== undefined) {
      const observationContext: ObservationContext = {
        workspaceRoot: context.workspaceRoot,
        repositoryId: context.repositoryId,
        workspaceId: context.workspaceId,
        worktreeId: context.worktreeId,
      };
      try {
        afterCapture = await this.observer.captureAfter(observationContext);
        observationGaps.push(...afterCapture.gaps);
      } catch {
        observationGaps.push({
          kind: "unverified",
          scope: "after",
          reason: "post-execution observation failed",
        });
      }
    }

    const effectEventIds: EventId[] = [];
    const outOfBandEventIds: EventId[] = [];
    if (this.observer) {
      if (beforeCapture !== null && afterCapture !== null) {
        const diff = diffSnapshots(beforeCapture.snapshot, afterCapture.snapshot, call.opaque);
        observationGaps.push(...diff.gaps);
        for (const change of diff.changes) {
          const eventId = this.createEventId();
          try {
            appendValidated(
              createFileChangedEvent(
                change,
                context,
                this.observer.source,
                requestEvent.eventId,
                context.correlationId,
                context.agentId,
                context.taskId,
                eventId,
                this.now(),
              ),
              this.eventStore,
            );
            effectEventIds.push(eventId);
          } catch {
            observationGaps.push({
              kind: "unverified",
              scope: change.path,
              reason: "effect event persistence failed",
            });
          }
        }
      } else if (context.workspaceRoot !== undefined) {
        observationGaps.push({
          kind: "unverified",
          scope: "tool.effects",
          reason: "effect comparison requires both observation boundaries",
        });
      }

      const outOfBandChanges = [
        ...(beforeCapture?.outOfBandChanges ?? []),
        ...(afterCapture?.outOfBandChanges ?? []),
      ];
      for (const change of outOfBandChanges) {
        observationGaps.push({
          kind: "unattributed",
          scope: change.path,
          reason: "effect was observed outside the intercepted MCP call",
        });
        const eventId = this.createEventId();
        try {
          appendValidated(
            createFileChangedEvent(
              change,
              context,
              this.observer.source,
              null,
              this.createCorrelationId(),
              null,
              null,
              eventId,
              this.now(),
            ),
            this.eventStore,
          );
          outOfBandEventIds.push(eventId);
        } catch {
          observationGaps.push({
            kind: "unverified",
            scope: change.path,
            reason: "out-of-band effect persistence failed",
          });
        }
      }
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
          effectEventIds,
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

    const evidenceEventIds = [
      requestEvent.eventId,
      ...effectEventIds,
      ...outOfBandEventIds,
      completedEvent.eventId,
    ];
    const coverage = this.observer === undefined
      ? null
      : deriveCoverage({
          scope: `tool:${requestEvent.eventId}`,
          modes: beforeCapture !== null && afterCapture !== null
            ? ["intercepted", "verified"]
            : ["intercepted", "unknown"],
          gaps: observationGaps,
          evidenceEventIds,
        });

    return {
      execution,
      requestEventId: requestEvent.eventId,
      completedEventId: completedEvent.eventId,
      coverage,
      observationDiagnostics: observationGaps,
    };
  }
}
