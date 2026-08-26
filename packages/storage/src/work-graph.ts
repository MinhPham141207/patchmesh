import type {
  DependencyChangedEvent,
  EventId,
  ProtocolEvent,
  ResourceChangedPayload,
  ResourceObservedPayload,
} from "patchmesh-protocol";
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
  DecisionView,
  AgentNode,
  AttributionOverride,
  FindingView,
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
    findings: new Map(),
    decisions: new Map(),
    coverageInputs: [],
  };
}

function eventEvidence(node: GraphNode | GraphEdge): readonly EventId[] {
  return node.evidenceEventIds;
}

/**
 * Accumulate evidence without sorting it, because the snapshot sorts it anyway.
 *
 * A hot node - the repository, an agent, a long-lived task - is touched by a large share of
 * all events, so its evidence list grows with the ledger: measured at 569 entries after 2,000
 * events and 1,639 after 8,931. Re-deriving `sortedUnique` on every touch therefore sorted a
 * list of length k on each of k touches, which is O(k^2 log k) on the busiest nodes and was
 * the second-largest cost in the projection after the coverage scan.
 *
 * Nothing needed it. `snapshotFromState` already applies `sortedUnique` to every node's and
 * edge's evidence on the way out, and no node or edge id is derived from this array -- they
 * come from the agent, task, resource or version they name. `coverageId` does hash evidence,
 * and sorts its own input. So the intermediate order was never observable.
 */
function mergeEvidence<T extends GraphNode | GraphEdge>(value: T, eventIds: readonly EventId[]): T {
  return { ...value, evidenceEventIds: [...eventEvidence(value), ...eventIds] } as T;
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
  // V3 relationship proofs require immutable non-null authoritative attribution.
  // A later V1/V2 correction must never weaken their closed proof envelope.
  return correction === undefined || event.schemaVersion === 3
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

function deriveFindingAndDecisionViews(state: WorkGraphState): void {
  const findings = new Map<FindingView["finding"]["findingId"], FindingView>();
  const decisions = new Map<string, DecisionView>();
  const feedback = new Map<FindingView["finding"]["findingId"], FindingView["feedback"]>();
  const deliveries = new Map<string, Map<string, DecisionView["deliveries"][number]>>();

  for (const event of [...state.eventsById.values()].sort((left, right) => compareStrings(left.eventId, right.eventId))) {
    if (event.eventType === "finding.created") {
      findings.set(event.payload.finding.findingId, {
        finding: event.payload.finding,
        feedback: [],
        status: event.payload.finding.status,
        eventIds: [event.eventId],
      });
    }
    if (event.eventType === "finding.feedback.created") {
      const current = feedback.get(event.payload.feedback.findingId) ?? [];
      feedback.set(event.payload.feedback.findingId, [...current, { eventId: event.eventId, feedback: event.payload.feedback }]);
    }
    if (event.eventType === "decision.created") {
      decisions.set(event.payload.decision.decisionId, {
        decision: event.payload.decision,
        deliveries: [],
        feedback: [],
        eventIds: [event.eventId],
      });
    }
    if (event.eventType === "decision.delivery.changed") {
      const byDelivery = deliveries.get(event.payload.decisionId) ?? new Map();
      const existing = byDelivery.get(event.payload.delivery.deliveryId);
      if (existing === undefined || existing.eventIds.length <= event.payload.delivery.eventIds.length) {
        byDelivery.set(event.payload.delivery.deliveryId, event.payload.delivery);
      }
      deliveries.set(event.payload.decisionId, byDelivery);
    }
  }

  for (const [findingId, view] of findings) {
    const findingFeedback = [...(feedback.get(findingId) ?? [])].sort((left, right) => compareStrings(left.eventId, right.eventId));
    findings.set(findingId, {
      ...view,
      feedback: findingFeedback,
      status: findingFeedback.some((entry) => entry.feedback.disposition === "dismissed") ? "dismissed" : view.status,
      eventIds: sortedUnique([view.eventIds[0] ?? "", ...findingFeedback.map((entry) => entry.eventId)]).filter(Boolean) as readonly EventId[],
    });
  }

  for (const [decisionId, view] of decisions) {
    const decisionFeedback = [...(feedback.get(view.decision.findingId) ?? [])]
      .filter((entry) => entry.feedback.decisionId === decisionId)
      .sort((left, right) => compareStrings(left.eventId, right.eventId));
    const decisionDeliveries = [...(deliveries.get(decisionId)?.values() ?? [])]
      .sort((left, right) => compareStrings(left.deliveryId, right.deliveryId));
    decisions.set(decisionId, {
      ...view,
      deliveries: decisionDeliveries,
      feedback: decisionFeedback,
      eventIds: sortedUnique([view.eventIds[0] ?? "", ...decisionDeliveries.flatMap((entry) => entry.eventIds), ...decisionFeedback.map((entry) => entry.eventId)]).filter(Boolean) as readonly EventId[],
    });
  }

  state.findings.clear();
  for (const [findingId, view] of findings) state.findings.set(findingId, view);
  state.decisions.clear();
  for (const [decisionId, view] of decisions) state.decisions.set(decisionId, view);
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
  deriveFindingAndDecisionViews(rebuilt);
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
    findings: new Map(state.findings),
    decisions: new Map(state.decisions),
    coverageInputs: [...state.coverageInputs],
  };
  if (event.eventType === "attribution.corrected") {
    const correction: AttributionOverride = { eventId: event.payload.targetEventId, correction: event };
    next.correctionsByTarget.set(event.payload.targetEventId, correction);
    return rebuildProjection(next);
  }
  mapEvent(next, effectiveEvent(event, next.correctionsByTarget));
  deriveFindingAndDecisionViews(next);
  return {
    ...next,
    coverageInputs: deriveProjectionCoverage(
      [...next.eventsById.values()],
      [],
      next.correctionsByTarget,
    ),
  };
}

export function snapshotFromState(
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
    findings: [...state.findings.values()].sort((left, right) => compareStrings(left.finding.findingId, right.finding.findingId)),
    decisions: [...state.decisions.values()].sort((left, right) => compareStrings(left.decision.decisionId, right.decision.decisionId)),
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

/**
 * Build the whole projection from an ordered event set in one pass.
 *
 * `applyEvent` is written for the incremental reducer, where each event must yield a complete
 * snapshot: it copies all six collections and re-derives every view. Folding it over a whole
 * event set costs O(n^2 log n), which is not a theoretical bound. Measured on this repository's
 * own ledger, `patchmesh status` took 40s and the detector commands never returned at all -
 * 60 events answered instantly, 800 took 14.3s, and 1,131 exceeded two minutes. Every
 * fixture-sized test passed throughout, which is why it survived so long.
 *
 * Corrections are collected before anything is mapped, so a correction that arrives after the
 * event it corrects is applied without rebuilding. That is what `rebuildProjection` does per
 * correction; doing it once up front is both cheaper and simpler.
 */
function buildProjection(orderedEvents: readonly ProtocolEvent[]): WorkGraphState {
  const state = initialState();
  for (const event of orderedEvents) {
    state.eventsById.set(event.eventId, event);
    if (event.eventType === "attribution.corrected") {
      state.correctionsByTarget.set(event.payload.targetEventId, {
        eventId: event.payload.targetEventId,
        correction: event,
      });
    }
  }

  for (const event of orderedEvents) {
    if (event.eventType === "attribution.corrected") {
      addEnvelopeNodes(state, event);
      continue;
    }
    mapEvent(state, effectiveEvent(event, state.correctionsByTarget));
  }
  deriveFindingAndDecisionViews(state);

  return {
    ...state,
    coverageInputs: deriveProjectionCoverage([...state.eventsById.values()], [], state.correctionsByTarget),
  };
}

export function reduceEvents(orderedEvents: readonly ProtocolEvent[]): WorkGraphState {
  const reducer = new WorkGraphProjector();
  let state = reducer.initialState();
  for (const event of orderedEvents) state = reducer.apply(state, event);
  return state;
}

/**
 * Apply a suffix of events to an already-projected base state, deferring every whole-ledger
 * derivation to once after the batch — the same discipline that makes `buildProjection` linear.
 *
 * Returns null when a suffix `attribution.corrected` targets an event outside the suffix: the
 * prefix was mapped under the old attribution and cannot be unmapped incrementally, so the
 * caller must discard its checkpoint and rebuild with `projectWorkGraph`. A correction inside
 * the suffix is fine — corrections are collected before any suffix event is mapped, matching
 * `buildProjection`'s two-pass shape.
 *
 * Precondition: the suffix events must be deduplicated (validated store output satisfies this);
 * a duplicate event id in the suffix would map twice.
 *
 * Byte-identity with `buildProjection(prefix ++ suffix)` rests on three facts: evidence arrays
 * accumulate in processing order but `snapshotFromState` sorts them on output; finding and
 * decision views re-sort every event by id; coverage is re-derived wholesale. Nothing else
 * observes processing order.
 */
export function extendProjection(
  base: WorkGraphState,
  suffixEvents: readonly ProtocolEvent[],
): WorkGraphState | null {
  const suffixIds = new Set(suffixEvents.map((event) => event.eventId));
  for (const event of suffixEvents) {
    if (event.eventType === "attribution.corrected" && !suffixIds.has(event.payload.targetEventId)) {
      return null;
    }
  }

  const next: WorkGraphState = {
    eventsById: new Map(base.eventsById),
    correctionsByTarget: new Map(base.correctionsByTarget),
    nodes: new Map(base.nodes),
    edges: new Map(base.edges),
    findings: new Map(base.findings),
    decisions: new Map(base.decisions),
    coverageInputs: [...base.coverageInputs],
  };

  for (const event of suffixEvents) {
    next.eventsById.set(event.eventId, event);
    if (event.eventType === "attribution.corrected") {
      next.correctionsByTarget.set(event.payload.targetEventId, {
        eventId: event.payload.targetEventId,
        correction: event,
      });
    }
  }
  for (const event of suffixEvents) {
    if (event.eventType === "attribution.corrected") {
      addEnvelopeNodes(next, event);
      continue;
    }
    mapEvent(next, effectiveEvent(event, next.correctionsByTarget));
  }
  deriveFindingAndDecisionViews(next);

  return {
    ...next,
    coverageInputs: deriveProjectionCoverage([...next.eventsById.values()], [], next.correctionsByTarget),
  };
}

export function projectWorkGraph(events: readonly ProtocolEvent[]): WorkGraphReplayResult {
  const replay = replayEvents(events);
  const state = buildProjection(replay.orderedEvents);
  return {
    orderedEvents: replay.orderedEvents,
    sourceSequenceGaps: replay.sourceSequenceGaps,
    state,
    snapshot: snapshotFromState(state, replay.sourceSequenceGaps),
  };
}
