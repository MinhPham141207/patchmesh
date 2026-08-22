import type {
  AgentId,
  EventType,
  ProtocolEvent,
  TaskId,
} from "patchmesh-protocol";
import { projectWorkGraph } from "patchmesh-storage";
import { redactEvent } from "./redaction.js";
import { parseTimeBound } from "./time.js";
import {
  ReadServiceError,
  type AgentFilters,
  type AgentView,
  type AgentsView,
  type DecisionExplanation,
  type EventListQuery,
  type EventPage,
  type FindingListQuery,
  type FindingsView,
  type FollowOptions,
  type GraphFilters,
  type GraphView,
  type ReadServiceOptions,
  type ReadServices,
  type StatusView,
} from "./types.js";

const eventTypes: readonly EventType[] = [
  "tool.requested",
  "tool.completed",
  "file.read",
  "file.changed",
  "symbol.read",
  "symbol.changed",
  "task.completed",
  "dependency.changed",
  "evidence.derived",
  "attribution.corrected",
  "finding.created",
  "finding.feedback.created",
  "write.dependent",
  "decision.created",
  "validity.changed",
  "decision.delivery.changed",
];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort(compareStrings) as T[];
}

function errorCategory(error: unknown): string {
  if (error instanceof ReadServiceError) return error.code;
  return error instanceof Error ? "store_read_failed" : "read_failed";
}

function emptyEventTypeCounts(): Record<EventType, number> {
  return Object.fromEntries(eventTypes.map((eventType) => [eventType, 0])) as Record<EventType, number>;
}

function readEvents(options: ReadServiceOptions): readonly ProtocolEvent[] {
  try {
    return options.reader.read();
  } catch (error) {
    throw new ReadServiceError("unavailable", errorCategory(error));
  }
}

function withCorrectedAttribution(events: readonly ProtocolEvent[]): readonly ProtocolEvent[] {
  const corrections = new Map<ProtocolEvent["eventId"], {
    readonly agentId: ProtocolEvent["agentId"];
    readonly taskId: ProtocolEvent["taskId"];
  }>();
  for (const event of events) {
    if (event.eventType !== "attribution.corrected") continue;
    corrections.set(event.payload.targetEventId, {
      agentId: event.payload.attributedAgentId,
      taskId: event.payload.attributedTaskId,
    });
  }
  return events.map((event) => {
    const correction = corrections.get(event.eventId);
    // V3 proof identities are part of their closed, immutable envelope.
    return correction === undefined || event.schemaVersion === 3
      ? event
      : { ...event, agentId: correction.agentId, taskId: correction.taskId };
  });
}

function aggregateCoverage(events: readonly ProtocolEvent[]): StatusView["coverage"] {
  const snapshot = projectWorkGraph(events).snapshot;
  const modes = sortedUnique(snapshot.coverage.flatMap((coverage) => coverage.modes));
  const gaps = snapshot.coverage.flatMap((coverage) => coverage.gaps);
  return {
    presentation: snapshot.coverage.some((coverage) => coverage.presentation === "degraded")
      ? "degraded"
      : snapshot.coverage.some((coverage) => coverage.presentation === "sufficient")
        ? "sufficient"
        : "unknown",
    modes,
    gaps,
  };
}

function normalizeFilters(events: readonly ProtocolEvent[], query: EventListQuery, now: number): {
  readonly since: number | null;
  readonly until: number | null;
  readonly limit: number | null;
} {
  const since = query.since === undefined ? null : parseTimeBound(query.since, now);
  const until = query.until === undefined ? null : parseTimeBound(query.until, now);
  if (since !== null && until !== null && since > until) throw new ReadServiceError("usage", "since must not be after until");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
    throw new ReadServiceError("usage", "limit must be a positive integer");
  }
  void events;
  return { since, until, limit: query.limit ?? null };
}

function matchesEvent(event: ProtocolEvent, query: EventListQuery, since: number | null, until: number | null): boolean {
  if (query.agentId !== undefined && event.agentId !== query.agentId) return false;
  if (query.taskId !== undefined && event.taskId !== query.taskId) return false;
  if (query.eventType !== undefined && event.eventType !== query.eventType) return false;
  const timestamp = Date.parse(event.timestamp);
  if (since !== null && timestamp < since) return false;
  if (until !== null && timestamp > until) return false;
  return true;
}

function filterGraph(snapshot: GraphView["snapshot"], filters: GraphFilters): GraphView["snapshot"] {
  if (filters.agentId === undefined && filters.taskId === undefined && filters.resourceId === undefined) return snapshot;
  const selected = new Set<string>();
  if (filters.agentId !== undefined) selected.add(`agent:${filters.agentId}`);
  if (filters.taskId !== undefined) selected.add(`task:${filters.taskId}`);
  if (filters.resourceId !== undefined) selected.add(`resource:${filters.resourceId}`);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of snapshot.edges) {
      const attributed = filters.agentId === undefined || edge.attribution.agentId === filters.agentId;
      const taskMatched = filters.taskId === undefined || edge.attribution.taskId === filters.taskId;
      const resourceMatched = filters.resourceId === undefined || edge.fromNodeId === `resource:${filters.resourceId}` || edge.toNodeId === `resource:${filters.resourceId}`;
      if (attributed && taskMatched && resourceMatched && (selected.has(edge.fromNodeId ?? "") || selected.has(edge.toNodeId))) {
        if (edge.fromNodeId !== null && !selected.has(edge.fromNodeId)) { selected.add(edge.fromNodeId); changed = true; }
        if (!selected.has(edge.toNodeId)) { selected.add(edge.toNodeId); changed = true; }
      }
    }
  }
  const edges = snapshot.edges.filter((edge) => {
    const directMatch = (edge.fromNodeId !== null && selected.has(edge.fromNodeId)) || selected.has(edge.toNodeId);
    const attributedMatch = filters.agentId === undefined || edge.attribution.agentId === filters.agentId;
    const taskMatch = filters.taskId === undefined || edge.attribution.taskId === filters.taskId;
    const resourceMatch = filters.resourceId === undefined || edge.fromNodeId === `resource:${filters.resourceId}` || edge.toNodeId === `resource:${filters.resourceId}`;
    return directMatch && attributedMatch && taskMatch && resourceMatch;
  });
  const nodeIds = new Set<string>(selected);
  for (const edge of edges) if (edge.fromNodeId !== null) nodeIds.add(edge.fromNodeId);
  for (const edge of edges) nodeIds.add(edge.toNodeId);
  const findings = snapshot.findings.filter((view) => (
    (filters.resourceId === undefined || view.finding.subjectResourceId === filters.resourceId)
    && (filters.taskId === undefined || view.finding.affectedTaskId === filters.taskId)
  ));
  const findingIds = new Set(findings.map((view) => view.finding.findingId));
  const decisions = snapshot.decisions.filter((view) => (
    findingIds.has(view.decision.findingId)
    || (filters.agentId !== undefined && view.decision.target.agentId === filters.agentId)
    || (filters.taskId !== undefined && view.decision.target.taskId === filters.taskId)
  ));
  return {
    nodes: snapshot.nodes.filter((node) => nodeIds.has(node.nodeId)),
    edges,
    coverage: snapshot.coverage,
    findings,
    decisions,
  };
}

export function createReadServices(options: ReadServiceOptions): ReadServices {
  const now = options.now ?? Date.now;
  const getStatus = (): StatusView => {
    try {
      const events = readEvents(options);
      const replay = projectWorkGraph(events);
      const attributedEvents = withCorrectedAttribution(events);
      const eventTypeCounts = emptyEventTypeCounts();
      const agentIds = new Set<AgentId>();
      const taskIds = new Set<TaskId>();
      let nullAttributionEventCount = 0;
      for (const event of attributedEvents) {
        eventTypeCounts[event.eventType] = (eventTypeCounts[event.eventType] ?? 0) + 1;
        if (event.eventType !== "attribution.corrected" && (event.agentId === null || event.taskId === null)) {
          nullAttributionEventCount += 1;
        }
        if (event.agentId !== null) agentIds.add(event.agentId);
        if (event.taskId !== null) taskIds.add(event.taskId);
      }
      const coverage = aggregateCoverage(events);
      return {
        health: coverage.presentation === "degraded" || replay.sourceSequenceGaps.length > 0 ? "degraded" : "healthy",
        store: { state: "open", replayable: true },
        eventCount: events.length,
        eventTypeCounts,
        agentCount: agentIds.size,
        taskCount: taskIds.size,
        nullAttributionEventCount,
        coverage,
        errorCategory: null,
      };
    } catch (error) {
      return {
        health: "unavailable",
        store: { state: "closed", replayable: false },
        eventCount: 0,
        eventTypeCounts: emptyEventTypeCounts(),
        agentCount: 0,
        taskCount: 0,
        nullAttributionEventCount: 0,
        coverage: { presentation: "unknown", modes: [], gaps: [] },
        errorCategory: errorCategory(error),
      };
    }
  };

  const listAgents = (filters: AgentFilters = {}): { readonly agents: readonly AgentView[] } => {
    const events = readEvents(options);
    const attributedEvents = withCorrectedAttribution(events);
    const byAgent = new Map<AgentId, ProtocolEvent[]>();
    for (const event of attributedEvents) {
      if (event.agentId === null || (filters.agentId !== undefined && event.agentId !== filters.agentId)) continue;
      if (filters.taskId !== undefined && event.taskId !== filters.taskId) continue;
      const current = byAgent.get(event.agentId) ?? [];
      current.push(event);
      byAgent.set(event.agentId, current);
    }
    const graph = projectWorkGraph(events).snapshot;
    return {
      agents: [...byAgent.entries()].sort(([left], [right]) => compareStrings(left, right)).map(([agentId, agentEvents]) => {
        const taskIds = sortedUnique(agentEvents.map((event) => event.taskId ?? "")).map((task) => task === "" ? null : task as TaskId);
        const eventTypeCounts: Partial<Record<EventType, number>> = {};
        for (const event of agentEvents) eventTypeCounts[event.eventType] = (eventTypeCounts[event.eventType] ?? 0) + 1;
        const eventIds = new Set(agentEvents.map((event) => event.eventId));
        return {
          agentId,
          taskIds,
          eventCount: agentEvents.length,
          eventTypeCounts,
          coverage: graph.coverage.filter((coverage) => coverage.evidenceEventIds.some((eventId) => eventIds.has(eventId))),
        };
      }),
    };
  };

  const getGraph = (filters: GraphFilters = {}): GraphView => {
    const events = readEvents(options);
    const snapshot = projectWorkGraph(events).snapshot;
    const filtered = filterGraph(snapshot, filters);
    return {
      snapshot: filtered,
      filters,
      coverageWarnings: filtered.coverage.flatMap((coverage) => coverage.gaps),
    };
  };

  const listFindings = (query: FindingListQuery = {}): FindingsView => {
    const snapshot = projectWorkGraph(readEvents(options)).snapshot;
    const findings = snapshot.findings.filter((view) => (
      (query.findingType === undefined || view.finding.findingType === query.findingType)
      && (query.status === undefined || view.status === query.status)
    ));
    return {
      findings,
      coverageWarnings: snapshot.coverage.flatMap((coverage) => coverage.gaps),
    };
  };

  const explainDecision = (decisionId: import("patchmesh-protocol").DecisionId): DecisionExplanation => {
    const snapshot = projectWorkGraph(readEvents(options)).snapshot;
    const decision = snapshot.decisions.find((view) => view.decision.decisionId === decisionId);
    if (decision === undefined) throw new ReadServiceError("cursor", "decision was not found");
    return {
      decision,
      finding: snapshot.findings.find((view) => view.finding.findingId === decision.decision.findingId) ?? null,
      coverageWarnings: snapshot.coverage.flatMap((coverage) => coverage.gaps),
    };
  };

  const listEvents = (query: EventListQuery = {}): EventPage => {
    const events = readEvents(options);
    const { since, until, limit } = normalizeFilters(events, query, now());
    const cursorIndex = query.cursor === undefined ? -1 : events.findIndex((event) => event.eventId === query.cursor);
    if (query.cursor !== undefined && cursorIndex === -1) throw new ReadServiceError("cursor", "event cursor was not found");
    const scanned = events.slice(cursorIndex + 1);
    const matches = scanned.filter((event) => matchesEvent(event, query, since, until));
    const selected = limit === null ? matches : matches.slice(0, limit);
    const scannedForPage = limit === null || selected.length === matches.length
      ? scanned
      : scanned.slice(0, scanned.findIndex((event) => event.eventId === selected.at(-1)?.eventId) + 1);
    const lastScanned = scannedForPage.at(-1)?.eventId ?? query.cursor ?? null;
    return {
      events: selected.map((event) => redactEvent(structuredClone(event))),
      nextCursor: lastScanned,
      hasMore: scannedForPage.length < scanned.length,
    };
  };

  const sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  }));

  const followEvents = async function* (follow: FollowOptions, signal?: AbortSignal): AsyncIterable<EventPage> {
    let cursor = follow.cursor;
    const pageQuery = (): EventListQuery => {
      const { cursor: _cursor, ...filters } = follow;
      return cursor === undefined ? filters : { ...filters, cursor };
    };
    const initial = listEvents(pageQuery());
    cursor = initial.nextCursor ?? cursor;
    yield initial;
    while (!signal?.aborted) {
      await sleep(options.pollIntervalMs ?? 100, signal);
      if (signal?.aborted) return;
      const page = listEvents(pageQuery());
      cursor = page.nextCursor ?? cursor;
      if (page.events.length > 0) yield page;
    }
  };

  return {
    getStatus,
    listAgents,
    listEvents,
    getGraph,
    listFindings,
    explainDecision,
    followEvents,
  };
}
