import type {
  AgentId,
  AttributionCorrectedEvent,
  CorrelationId,
  EventId,
  FileChangedEvent,
  FileReadEvent,
  LogicalResource,
  ProtocolEvent,
  RepositoryId,
  ResourceId,
  ResourceVersion,
  Source,
  SymbolChangedEvent,
  SymbolReadEvent,
  TaskCompletedEvent,
  TaskId,
  ToolCompletedEvent,
  ToolRequestedEvent,
  WorkspaceId,
  WorktreeId,
} from "@patchmesh/protocol";

export const repositoryId = "repo_11111111-1111-4111-8111-111111111111" as RepositoryId;
export const workspaceId = "ws_22222222-2222-4222-8222-222222222222" as WorkspaceId;
export const producerWorktreeId = "wt_33333333-3333-4333-8333-333333333333" as WorktreeId;
export const consumerWorktreeId = "wt_44444444-4444-4444-8444-444444444444" as WorktreeId;
export const producerAgentId = "agent_m7_producer" as AgentId;
export const consumerAgentId = "agent_m7_consumer" as AgentId;
export const producerTaskId = "task_m7_producer" as TaskId;
export const consumerTaskId = "task_m7_consumer" as TaskId;

const source: Source = {
  kind: "gateway",
  sourceId: "source_m7_gateway",
  instanceId: "55555555-5555-4555-8555-555555555555",
};

const eventId = (number: number): EventId => `evt_${number.toString(16).padStart(32, "0")}`;
const correlationId = (number: number): CorrelationId => `corr_${number.toString(16).padStart(32, "0")}`;
const resourceId = (number: number): ResourceId => `res_${number.toString(16).padStart(64, "0")}`;

const contractResource: LogicalResource = {
  resourceId: resourceId(1),
  repositoryId,
  kind: "symbol",
  locator: "src/contracts.ts#calculateTotal",
};

const consumerResource: LogicalResource = {
  resourceId: resourceId(2),
  repositoryId,
  kind: "file",
  locator: "src/cart.ts",
};

function base(
  id: EventId,
  correlation: CorrelationId,
  worktreeId: WorktreeId,
  agentId: AgentId | null,
  taskId: TaskId | null,
  sequence: number | null,
  causationId: EventId | null = null,
): Omit<ToolRequestedEvent, "eventType" | "payload"> {
  return {
    schemaVersion: 1,
    eventId: id,
    source,
    timestamp: "2026-08-08T00:00:00.000Z",
    repositoryId,
    workspaceId,
    worktreeId,
    agentId,
    taskId,
    correlationId: correlation,
    causationId,
    sourceSequence: sequence,
  };
}

function version(
  resource: LogicalResource,
  worktreeId: WorktreeId,
  event: EventId,
  value: string,
  kind: ResourceVersion["kind"] = "content_hash",
): ResourceVersion {
  return {
    resourceId: resource.resourceId,
    domain: { repositoryId, workspaceId, worktreeId },
    kind,
    value,
    evidenceEventIds: [event],
  };
}

function toolRequested(
  id: EventId,
  correlation: CorrelationId,
  worktreeId: WorktreeId,
  agentId: AgentId | null,
  taskId: TaskId | null,
  sequence: number,
  toolName: ToolRequestedEvent["payload"]["toolName"],
  operation: string,
  targetResourceId: ResourceId | null,
): ToolRequestedEvent {
  return {
    ...base(id, correlation, worktreeId, agentId, taskId, sequence),
    eventType: "tool.requested",
    payload: { toolName, operation, targetResourceId, opaque: false },
  };
}

function toolCompleted(
  id: EventId,
  request: ToolRequestedEvent,
  worktreeId: WorktreeId,
  agentId: AgentId | null,
  taskId: TaskId | null,
  sequence: number,
  effectEventIds: readonly EventId[] = [],
): ToolCompletedEvent {
  return {
    ...base(id, request.correlationId, worktreeId, agentId, taskId, sequence, request.eventId),
    eventType: "tool.completed",
    payload: {
      requestEventId: request.eventId,
      outcome: "succeeded",
      exitCode: 0,
      effectEventIds,
    },
  };
}

function symbolRead(
  id: EventId,
  worktreeId: WorktreeId,
  agentId: AgentId | null,
  taskId: TaskId | null,
): SymbolReadEvent {
  return {
    ...base(id, correlationId(3), worktreeId, agentId, taskId, 2),
    eventType: "symbol.read",
    payload: {
      resource: contractResource,
      version: version(contractResource, worktreeId, id, "sha256:m7-contract-v1"),
      access: "read",
    },
  };
}

function symbolChanged(id: EventId): SymbolChangedEvent {
  return {
    ...base(id, correlationId(5), producerWorktreeId, producerAgentId, producerTaskId, 4),
    eventType: "symbol.changed",
    payload: {
      resource: contractResource,
      beforeVersion: version(contractResource, producerWorktreeId, id, "sha256:m7-contract-v1", "symbol_signature"),
      afterVersion: version(contractResource, producerWorktreeId, id, "sha256:m7-contract-v2", "symbol_signature"),
      changeKind: "modified",
    },
  };
}

function fileChanged(id: EventId): FileChangedEvent {
  return {
    ...base(id, correlationId(6), producerWorktreeId, producerAgentId, producerTaskId, 5),
    eventType: "file.changed",
    payload: {
      resource: { ...consumerResource, kind: "file", locator: "src/contracts.ts" },
      beforeVersion: version(consumerResource, producerWorktreeId, id, "sha256:m7-file-v1"),
      afterVersion: version(consumerResource, producerWorktreeId, id, "sha256:m7-file-v2"),
      changeKind: "modified",
    },
  };
}

function taskCompleted(id: EventId): TaskCompletedEvent {
  return {
    ...base(id, correlationId(8), consumerWorktreeId, consumerAgentId, consumerTaskId, 7),
    eventType: "task.completed",
    payload: {
      workProductId: "work_88888888888888888888888888888888",
      baseRevision: "a".repeat(40),
      targetSnapshotId: `snapshot_${"b".repeat(64)}`,
      resourceIds: [consumerResource.resourceId],
    },
  };
}

function attributionCorrected(
  id: EventId,
  targetEvent: SymbolReadEvent,
): AttributionCorrectedEvent {
  return {
    ...base(id, targetEvent.correlationId, consumerWorktreeId, null, null, 8, targetEvent.eventId),
    eventType: "attribution.corrected",
    payload: {
      targetEventId: targetEvent.eventId,
      attributedAgentId: consumerAgentId,
      attributedTaskId: consumerTaskId,
      reason: "consumer attribution became available after ingestion",
      evidenceEventIds: [id],
    },
  };
}

export function buildGoldenEvents(): readonly ProtocolEvent[] {
  const consumerRequest = toolRequested(
    eventId(1),
    correlationId(1),
    consumerWorktreeId,
    null,
    null,
    0,
    "read_file",
    "read src/contracts.ts",
    consumerResource.resourceId,
  );
  const consumerCompletion = toolCompleted(eventId(3), consumerRequest, consumerWorktreeId, null, null, 1);
  const producerRequest = toolRequested(
    eventId(4),
    correlationId(4),
    producerWorktreeId,
    producerAgentId,
    producerTaskId,
    3,
    "edit_file",
    "change calculateTotal signature",
    contractResource.resourceId,
  );
  const producerCompletion = toolCompleted(eventId(7), producerRequest, producerWorktreeId, producerAgentId, producerTaskId, 6, [eventId(6)]);
  const read: SymbolReadEvent = symbolRead(eventId(2), consumerWorktreeId, null, null);
  const changed = symbolChanged(eventId(5));
  const file = fileChanged(eventId(6));
  const completed = taskCompleted(eventId(8));
  const correction = attributionCorrected(eventId(9), read);
  return [consumerRequest, read, consumerCompletion, producerRequest, changed, file, producerCompletion, completed, correction];
}

function replayResource(index: number): LogicalResource {
  return {
    resourceId: resourceId(1000 + index),
    repositoryId,
    kind: "file",
    locator: `src/replay-${index}.ts`,
  };
}

function replayEvent(index: number): FileReadEvent {
  const id = eventId(1000 + index);
  const resource = replayResource(index);
  return {
    ...base(id, correlationId(1000 + index), consumerWorktreeId, consumerAgentId, consumerTaskId, index),
    eventType: "file.read",
    payload: {
      resource,
      version: version(resource, consumerWorktreeId, id, `sha256:m7-replay-${index}`),
      access: "read",
    },
  };
}

export function buildReplayCorpus(eventCount: number): readonly ProtocolEvent[] {
  if (!Number.isInteger(eventCount) || eventCount < 1) throw new Error("eventCount must be a positive integer");
  return Array.from({ length: eventCount }, (_, index) => replayEvent(index));
}

export function duplicateVariant(events: readonly ProtocolEvent[]): readonly ProtocolEvent[] {
  return events.flatMap((event) => [event, event]);
}

export function outOfOrderVariant(events: readonly ProtocolEvent[]): readonly ProtocolEvent[] {
  const result = [...events];
  for (let index = 0; index + 1 < result.length; index += 2) {
    const next = result[index + 1];
    const current = result[index];
    if (next !== undefined && current !== undefined) {
      result[index] = next;
      result[index + 1] = current;
    }
  }
  return result;
}

export function conflictingDuplicate(event: ProtocolEvent): ProtocolEvent {
  if (event.eventType !== "file.read") throw new Error("conflict fixture expects a file.read event");
  return {
    ...event,
    payload: {
      ...event.payload,
      access: "execute",
    },
  };
}

export function missingCausalReference(event: ProtocolEvent): ProtocolEvent {
  if (event.eventType !== "tool.completed") throw new Error("missing-causation fixture expects a tool.completed event");
  return {
    ...event,
    causationId: eventId(999999),
    payload: { ...event.payload, requestEventId: eventId(999999) },
  };
}
