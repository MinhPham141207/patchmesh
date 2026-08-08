import type {
  AttributionCorrectedEvent,
  DependencyChangedEvent,
  DecisionCreatedEvent,
  DecisionDeliveryChangedEvent,
  FileChangedEvent,
  FileReadEvent,
  FindingCreatedEvent,
  ProtocolEvent,
  SymbolChangedEvent,
  SymbolReadEvent,
  TaskCompletedEvent,
  ToolCompletedEvent,
  ToolRequestedEvent,
  ValidityChangedEvent,
} from "../src/index.js";
import type {
  AgentId,
  CorrelationId,
  EventId,
  RepositoryId,
  ResourceId,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "../src/index.js";

export const repositoryId = "repo_11111111-1111-4111-8111-111111111111" as RepositoryId;
export const workspaceId = "ws_22222222-2222-4222-8222-222222222222" as WorkspaceId;
export const worktreeId = "wt_33333333-3333-4333-8333-333333333333" as WorktreeId;
export const agentId = "agent_a" as AgentId;
export const taskId = "task_a" as TaskId;
export const resourceId = `res_${"1".repeat(64)}` as ResourceId;
export const otherResourceId = `res_${"2".repeat(64)}` as ResourceId;

const eventId = (number: number): EventId => `evt_${number.toString(16).padStart(32, "0")}` as EventId;
const correlationId = (number: number): CorrelationId => `corr_${number.toString(16).padStart(32, "0")}` as CorrelationId;

const source = {
  kind: "gateway" as const,
  sourceId: "source_gateway",
  instanceId: "11111111-1111-4111-8111-111111111111",
};

const resource = {
  resourceId,
  repositoryId,
  kind: "file" as const,
  locator: "src/example.ts",
};

const version = (id: EventId, idForResource = resourceId) => ({
  resourceId: idForResource,
  domain: { repositoryId, workspaceId, worktreeId },
  kind: "content_hash" as const,
  value: `sha256:${"a".repeat(64)}`,
  evidenceEventIds: [id],
});

const base = (id: EventId, sequence: number, correlation = correlationId(1)) => ({
  schemaVersion: 1 as const,
  eventId: id,
  source,
  timestamp: "2026-08-08T00:00:00.000Z",
  repositoryId,
  workspaceId,
  worktreeId,
  agentId,
  taskId: null,
  correlationId: correlation,
  causationId: null,
  sourceSequence: sequence,
});

export function makeToolRequested(): ToolRequestedEvent {
  return {
    ...base(eventId(1), 0),
    eventType: "tool.requested",
    payload: {
      toolName: "read_file",
      operation: "read src/example.ts",
      targetResourceId: resourceId,
      opaque: false,
    },
  };
}

export function makeToolCompleted(
  request: ToolRequestedEvent = makeToolRequested(),
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
): ToolCompletedEvent {
  return {
    ...base(eventId(2), 1, request.correlationId),
    eventType: "tool.completed",
    causationId: request.eventId,
    payload: {
      requestEventId: request.eventId,
      outcome,
      exitCode: outcome === "succeeded" ? 0 : 1,
      effectEventIds: [],
    },
  };
}

export function makeFileRead(): FileReadEvent {
  return {
    ...base(eventId(3), 0, correlationId(3)),
    eventType: "file.read",
    payload: { resource, version: version(eventId(3)), access: "read" },
  };
}

export function makeFileChanged(): FileChangedEvent {
  return {
    ...base(eventId(4), 0, correlationId(4)),
    eventType: "file.changed",
    payload: {
      resource,
      beforeVersion: null,
      afterVersion: version(eventId(4)),
      changeKind: "created",
    },
  };
}

export function makeSymbolRead(): SymbolReadEvent {
  return {
    ...base(eventId(5), 0, correlationId(5)),
    eventType: "symbol.read",
    payload: { resource: { ...resource, kind: "symbol", locator: "src/example.ts#example" }, version: version(eventId(5)), access: "read" },
  };
}

export function makeSymbolChanged(): SymbolChangedEvent {
  return {
    ...base(eventId(6), 0, correlationId(6)),
    eventType: "symbol.changed",
    payload: {
      resource: { ...resource, kind: "symbol", locator: "src/example.ts#example" },
      beforeVersion: version(eventId(6)),
      afterVersion: { ...version(eventId(6)), kind: "symbol_signature", value: `sha256:${"b".repeat(64)}` },
      changeKind: "modified",
    },
  };
}

export function makeTaskCompleted(): TaskCompletedEvent {
  return {
    ...base(eventId(7), 0, correlationId(7)),
    eventType: "task.completed",
    taskId,
    payload: {
      workProductId: `work_${"7".repeat(32)}`,
      baseRevision: "1".repeat(40),
      targetSnapshotId: `snapshot_${"8".repeat(64)}`,
      resourceIds: [resourceId],
    },
  };
}

export function makeDependencyChanged(): DependencyChangedEvent {
  return {
    ...base(eventId(8), 0, correlationId(8)),
    eventType: "dependency.changed",
    payload: {
      dependency: {
        dependencyId: `dep_${"8".repeat(32)}`,
        dependentResourceId: resourceId,
        dependencyResourceId: otherResourceId,
        dependentVersion: version(eventId(8), resourceId),
        dependencyVersion: version(eventId(8), otherResourceId),
        observations: [{
          kind: "declared",
          producer: { sourceId: "source_gateway", version: "1" },
          rule: null,
          evidenceEventIds: [eventId(8)],
        }],
        evidenceEventIds: [eventId(8)],
      },
    },
  };
}

export function makeAttributionCorrected(): AttributionCorrectedEvent {
  return {
    ...base(eventId(9), 1),
    eventType: "attribution.corrected",
    causationId: eventId(1),
    payload: {
      targetEventId: eventId(1),
      attributedAgentId: agentId,
      attributedTaskId: taskId,
      reason: "task attribution became available",
      evidenceEventIds: [eventId(9)],
    },
  };
}

export function makeFindingCreated(): FindingCreatedEvent {
  return {
    ...base(eventId(10), 0, correlationId(10)),
    eventType: "finding.created",
    payload: { finding: {} as FindingCreatedEvent["payload"]["finding"] },
  };
}

export function makeDecisionCreated(): DecisionCreatedEvent {
  return {
    ...base(eventId(11), 0, correlationId(11)),
    eventType: "decision.created",
    payload: { decision: {} as DecisionCreatedEvent["payload"]["decision"] },
  };
}

export function makeValidityChanged(): ValidityChangedEvent {
  return {
    ...base(eventId(12), 0, correlationId(12)),
    eventType: "validity.changed",
    payload: { record: {} as ValidityChangedEvent["payload"]["record"], transition: {} as ValidityChangedEvent["payload"]["transition"] },
  };
}

export function makeDecisionDeliveryChanged(): DecisionDeliveryChangedEvent {
  return {
    ...base(eventId(13), 0, correlationId(13)),
    eventType: "decision.delivery.changed",
    payload: { decisionId: `decision_${"d".repeat(32)}`, delivery: {} as DecisionDeliveryChangedEvent["payload"]["delivery"] },
  };
}

export function makeAllTypedEvents(): ProtocolEvent[] {
  return [
    makeToolRequested(),
    makeToolCompleted(),
    makeFileRead(),
    makeFileChanged(),
    makeSymbolRead(),
    makeSymbolChanged(),
    makeTaskCompleted(),
    makeDependencyChanged(),
    makeAttributionCorrected(),
    makeFindingCreated(),
    makeDecisionCreated(),
    makeValidityChanged(),
    makeDecisionDeliveryChanged(),
  ];
}
