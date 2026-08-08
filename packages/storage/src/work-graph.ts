import type {
  DependencyChangedEvent,
  EventId,
  ProtocolEvent,
  ResourceChangedPayload,
  ResourceObservedPayload,
} from "@patchmesh/protocol";
import { replayEvents, type ReplayReducer, type SourceSequenceGap } from "./replay.js";
import { deriveProjectionCoverage } from "./work-graph-coverage.js";
import {
  agentNodeId,
  edgeId,
  resourceNodeId,
  taskNodeId,
  versionNodeId,
} from "./work-graph-ids.js";
import type {
  AgentNode,
  AttributionOverride,
  GraphEdge,
  GraphNode,
  ResourceNode,
  TaskNode,
  VersionNode,
  WorkGraphReplayResult,
  WorkGraphSnapshot,
  WorkGraphState,
} from "./work-graph-types.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort(compareStrings) as T[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function initialState(): WorkGraphState {
  return {
    eventsById: new Map(),
    correctionsByTarget: new Map(),
    nodes: new Map(),
    edges: new Map(),
    coverageInputs: [],
  };
}

function eventEvidence(node: GraphNode | GraphEdge): readonly EventId[] {
  return node.evidenceEventIds;
}

function mergeEvidence<T extends GraphNode | GraphEdge>(value: T, eventIds: readonly EventId[]): T {
  return { ...value, evidenceEventIds: sortedUnique([...eventEvidence(value), ...eventIds]) } as T;
}

function upsertNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  const existing = nodes.get(node.nodeId);
  nodes.set(node.nodeId, existing === undefined ? node : mergeEvidence(existing, node.evidenceEventIds));
}

function upsertEdge(edges: Map<string, GraphEdge>, edge: GraphEdge): void {
  const existing = edges.get(edge.edgeId);
  edges.set(edge.edgeId, existing === undefined ? edge : mergeEvidence(existing, edge.evidenceEventIds));
}

function attribution(event: ProtocolEvent): GraphEdge["attribution"] {
  return { agentId: event.agentId, taskId: event.taskId };
}

function sourceNodeId(event: ProtocolEvent): string | null {
  if (event.taskId !== null) return taskNodeId(event.taskId);
  if (event.agentId !== null) return agentNodeId(event.agentId);
  return null;
}

function effectiveEvent(
  event: ProtocolEvent,
  corrections: ReadonlyMap<EventId, AttributionOverride>,
): ProtocolEvent {
  const correction = corrections.get(event.eventId)?.correction.payload;
  return correction === undefined
    ? event
    : { ...event, agentId: correction.attributedAgentId, taskId: correction.attributedTaskId };
}

function addEnvelopeNodes(state: WorkGraphState, event: ProtocolEvent): void {
  if (event.agentId !== null) {
    const node: AgentNode = {
      kind: "agent",
      nodeId: agentNodeId(event.agentId),
      agentId: event.agentId,
      evidenceEventIds: [event.eventId],
    };
    upsertNode(state.nodes as Map<string, GraphNode>, node);
  }
  if (event.taskId !== null) {
    const node: TaskNode = {
      kind: "task",
      nodeId: taskNodeId(event.taskId),
      taskId: event.taskId,
      evidenceEventIds: [event.eventId],
      completionEventIds: [],
      workProductIds: [],
    };
    upsertNode(state.nodes as Map<string, GraphNode>, node);
  }
  if (event.agentId !== null && event.taskId !== null) {
    upsertEdge(state.edges as Map<string, GraphEdge>, {
      edgeId: edgeId("performs", agentNodeId(event.agentId), taskNodeId(event.taskId), "attribution"),
      kind: "performs",
      fromNodeId: agentNodeId(event.agentId),
      toNodeId: taskNodeId(event.taskId),
      evidenceEventIds: [event.eventId],
      attribution: attribution(event),
    });
  }
}

function addResourceNode(state: WorkGraphState, payload: ResourceObservedPayload | ResourceChangedPayload, eventId: EventId): void {
  const node: ResourceNode = {
    kind: "resource",
    nodeId: resourceNodeId(payload.resource),
    resource: payload.resource,
    evidenceEventIds: [eventId],
  };
  upsertNode(state.nodes as Map<string, GraphNode>, node);
}

function addVersionNode(state: WorkGraphState, version: ResourceChangedPayload["afterVersion"] | ResourceObservedPayload["version"], eventId: EventId): string {
  const nodeId = versionNodeId(version);
  const node: VersionNode = {
    kind: "version",
    nodeId,
    version,
    evidenceEventIds: [eventId, ...version.evidenceEventIds],
  };
  upsertNode(state.nodes as Map<string, GraphNode>, node);
  return nodeId;
}

function addVersionReference(state: WorkGraphState, event: ProtocolEvent, resource: ResourceObservedPayload["resource"], versionNode: string): void {
  upsertEdge(state.edges as Map<string, GraphEdge>, {
    edgeId: edgeId("references_version", resourceNodeId(resource), versionNode, "resource-version"),
    kind: "references_version",
    fromNodeId: resourceNodeId(resource),
    toNodeId: versionNode,
    evidenceEventIds: [event.eventId],
    attribution: attribution(event),
  });
}

function addObservedResource(state: WorkGraphState, event: ProtocolEvent, payload: ResourceObservedPayload): void {
  addResourceNode(state, payload, event.eventId);
  const observedVersionNode = addVersionNode(state, payload.version, event.eventId);
  addVersionReference(state, event, payload.resource, observedVersionNode);
  upsertEdge(state.edges as Map<string, GraphEdge>, {
    edgeId: edgeId("reads", sourceNodeId(event), resourceNodeId(payload.resource), event.eventId),
    kind: "reads",
    fromNodeId: sourceNodeId(event),
    toNodeId: resourceNodeId(payload.resource),
    evidenceEventIds: [event.eventId],
    attribution: attribution(event),
  });
}

function addChangedResource(state: WorkGraphState, event: ProtocolEvent, payload: ResourceChangedPayload): void {
  addResourceNode(state, payload, event.eventId);
  const beforeVersionNode = payload.beforeVersion === null
    ? null
    : addVersionNode(state, payload.beforeVersion, event.eventId);
  const afterVersionNode = addVersionNode(state, payload.afterVersion, event.eventId);
  if (beforeVersionNode !== null) addVersionReference(state, event, payload.resource, beforeVersionNode);
  addVersionReference(state, event, payload.resource, afterVersionNode);
  upsertEdge(state.edges as Map<string, GraphEdge>, {
    edgeId: edgeId("changes", sourceNodeId(event), resourceNodeId(payload.resource), event.eventId),
    kind: "changes",
    fromNodeId: sourceNodeId(event),
    toNodeId: resourceNodeId(payload.resource),
    evidenceEventIds: [event.eventId],
    attribution: attribution(event),
    changeKind: payload.changeKind,
    beforeVersionId: beforeVersionNode,
    afterVersionId: afterVersionNode,
  });
}

function addTaskCompletion(state: WorkGraphState, event: ProtocolEvent): void {
  if (event.eventType !== "task.completed" || event.taskId === null) return;
  const node = state.nodes.get(taskNodeId(event.taskId));
  if (!node || node.kind !== "task") return;
  state.nodes.set(node.nodeId, {
    ...node,
    evidenceEventIds: sortedUnique([...node.evidenceEventIds, event.eventId]),
    completionEventIds: sortedUnique([...node.completionEventIds, event.eventId]),
    workProductIds: sortedUnique([...node.workProductIds, event.payload.workProductId]),
  });
}

function addDependency(state: WorkGraphState, event: DependencyChangedEvent): void {
  const dependency = event.payload.dependency;
  const dependentNodeId = `resource:${dependency.dependentResourceId}`;
  const dependencyNodeId = `resource:${dependency.dependencyResourceId}`;
  addVersionNode(state, dependency.dependentVersion, event.eventId);
  addVersionNode(state, dependency.dependencyVersion, event.eventId);
  upsertEdge(state.edges as Map<string, GraphEdge>, {
    edgeId: edgeId("depends_on", dependentNodeId, dependencyNodeId, dependency.dependencyId),
    kind: "depends_on",
    fromNodeId: dependentNodeId,
    toNodeId: dependencyNodeId,
    evidenceEventIds: sortedUnique([event.eventId, ...dependency.evidenceEventIds]),
    attribution: attribution(event),
    dependency: {
      ...dependency,
    },
  });
}

function mapEvent(state: WorkGraphState, event: ProtocolEvent): void {
  addEnvelopeNodes(state, event);
  if (event.eventType === "file.read" || event.eventType === "symbol.read") addObservedResource(state, event, event.payload);
  if (event.eventType === "file.changed" || event.eventType === "symbol.changed") addChangedResource(state, event, event.payload);
  addTaskCompletion(state, event);
  if (event.eventType === "dependency.changed") addDependency(state, event);
}

function rebuildProjection(state: WorkGraphState): WorkGraphState {
  const rebuilt: WorkGraphState = {
    ...initialState(),
    eventsById: new Map(state.eventsById),
    correctionsByTarget: new Map(state.correctionsByTarget),
  };
  for (const event of state.eventsById.values()) {
    if (event.eventType === "attribution.corrected") {
      addEnvelopeNodes(rebuilt, event);
      continue;
    }
    mapEvent(rebuilt, effectiveEvent(event, rebuilt.correctionsByTarget));
  }
  return {
    ...rebuilt,
    coverageInputs: deriveProjectionCoverage(
      [...rebuilt.eventsById.values()],
      [],
      rebuilt.correctionsByTarget,
    ),
  };
}

function applyEvent(state: WorkGraphState, event: ProtocolEvent): WorkGraphState {
  const next: WorkGraphState = {
    eventsById: new Map(state.eventsById).set(event.eventId, event),
    correctionsByTarget: new Map(state.correctionsByTarget),
    nodes: new Map(state.nodes),
    edges: new Map(state.edges),
    coverageInputs: [...state.coverageInputs],
  };
  if (event.eventType === "attribution.corrected") {
    const correction: AttributionOverride = { eventId: event.payload.targetEventId, correction: event };
    next.correctionsByTarget.set(event.payload.targetEventId, correction);
    return rebuildProjection(next);
  }
  mapEvent(next, effectiveEvent(event, next.correctionsByTarget));
  return {
    ...next,
    coverageInputs: deriveProjectionCoverage(
      [...next.eventsById.values()],
      [],
      next.correctionsByTarget,
    ),
  };
}

function snapshotFromState(
  state: WorkGraphState,
  sourceSequenceGaps: readonly SourceSequenceGap[] = [],
): WorkGraphSnapshot {
  const nodes = [...state.nodes.values()].sort((left, right) =>
    compareStrings(left.kind, right.kind) || compareStrings(left.nodeId, right.nodeId));
  const edges = [...state.edges.values()].sort((left, right) =>
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.fromNodeId ?? "", right.fromNodeId ?? "") ||
    compareStrings(left.toNodeId, right.toNodeId) ||
    compareStrings(left.edgeId, right.edgeId));
  const coverage = sourceSequenceGaps.length === 0
    ? state.coverageInputs
    : deriveProjectionCoverage([...state.eventsById.values()], sourceSequenceGaps, state.correctionsByTarget);
  return deepFreeze({
    nodes: nodes.map((node) => ({ ...node, evidenceEventIds: sortedUnique(node.evidenceEventIds) })),
    edges: edges.map((edge) => ({ ...edge, evidenceEventIds: sortedUnique(edge.evidenceEventIds) })),
    coverage: [...coverage].sort((left, right) => compareStrings(left.coverageId, right.coverageId)),
  });
}

export class WorkGraphProjector implements ReplayReducer<WorkGraphState> {
  private incrementalState = initialState();

  initialState(): WorkGraphState {
    return initialState();
  }

  apply(state: WorkGraphState, event: ProtocolEvent): WorkGraphState {
    return applyEvent(state, event);
  }

  process(event: ProtocolEvent): WorkGraphSnapshot {
    this.incrementalState = this.apply(this.incrementalState, event);
    return snapshotFromState(this.incrementalState);
  }

  snapshot(): WorkGraphSnapshot {
    return snapshotFromState(this.incrementalState);
  }
}

export function projectWorkGraph(events: readonly ProtocolEvent[]): WorkGraphReplayResult {
  const projector = new WorkGraphProjector();
  const replay = replayEvents(events, projector);
  return {
    orderedEvents: replay.orderedEvents,
    sourceSequenceGaps: replay.sourceSequenceGaps,
    snapshot: snapshotFromState(replay.state, replay.sourceSequenceGaps),
  };
}
