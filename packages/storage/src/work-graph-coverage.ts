import type {
  EventId,
  ProtocolEvent,
  ToolCompletedEvent,
  ToolRequestedEvent,
} from "@patchmesh/protocol";
import type { SourceSequenceGap } from "./replay.js";
import { coverageId } from "./work-graph-ids.js";
import type {
  AttributionOverride,
  ProjectionCoverage,
  ProjectionCoverageGap,
  ProjectionCoverageMode,
} from "./work-graph-types.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort(compareStrings) as T[];
}

function effectiveAttribution(
  event: ProtocolEvent,
  corrections: ReadonlyMap<EventId, AttributionOverride>,
): { readonly agentId: ProtocolEvent["agentId"]; readonly taskId: ProtocolEvent["taskId"] } {
  const override = corrections.get(event.eventId)?.correction.payload;
  return override === undefined
    ? { agentId: event.agentId, taskId: event.taskId }
    : { agentId: override.attributedAgentId, taskId: override.attributedTaskId };
}

function gap(
  kind: ProjectionCoverageGap["kind"],
  scope: string,
  reason: string,
  evidenceEventIds: readonly EventId[],
): ProjectionCoverageGap {
  return { kind, scope, reason, evidenceEventIds: sortedUnique(evidenceEventIds) };
}

function createCoverage(
  scope: string,
  modes: readonly ProjectionCoverageMode[],
  gaps: readonly ProjectionCoverageGap[],
  evidenceEventIds: readonly EventId[],
): ProjectionCoverage {
  const sortedEvidence = sortedUnique(evidenceEventIds);
  const sortedGaps = [...gaps].sort((left, right) =>
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.scope, right.scope) ||
    compareStrings(left.reason, right.reason));
  const modeOrder: readonly ProjectionCoverageMode[] = ["intercepted", "verified", "inferred", "unknown"];
  const canonicalModes: readonly ProjectionCoverageMode[] = modeOrder.filter((mode) => modes.includes(mode));
  return {
    coverageId: coverageId({ scope, modes: canonicalModes, gaps: sortedGaps, evidenceEventIds: sortedEvidence }),
    scope,
    modes: canonicalModes,
    gaps: sortedGaps,
    evidenceEventIds: sortedEvidence,
    presentation: sortedGaps.length > 0
      ? "degraded"
      : canonicalModes.includes("verified")
        ? "sufficient"
        : "unknown",
  };
}

function toolCoverage(
  request: ToolRequestedEvent,
  completion: ToolCompletedEvent | undefined,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
): ProjectionCoverage {
  const evidenceEventIds: EventId[] = [request.eventId];
  const gaps: ProjectionCoverageGap[] = [];
  const modes: ProjectionCoverageMode[] = ["intercepted"];
  if (completion === undefined) {
    gaps.push(gap("unverified", `tool:${request.eventId}`, "tool completion evidence is absent", [request.eventId]));
    modes.push("unknown");
    return createCoverage(`tool:${request.eventId}`, modes, gaps, evidenceEventIds);
  }

  evidenceEventIds.push(completion.eventId);
  const observedReadEventIds = [...eventsById.values()]
    .filter((event) => (event.eventType === "file.read" || event.eventType === "symbol.read")
      && event.causationId === request.eventId)
    .map((event) => event.eventId);
  evidenceEventIds.push(...observedReadEventIds);
  for (const effectEventId of completion.payload.effectEventIds) {
    const effect = eventsById.get(effectEventId);
    if (effect === undefined || (effect.eventType !== "file.changed" && effect.eventType !== "symbol.changed")) {
      gaps.push(gap("unverified", `tool:${request.eventId}`, "declared effect event is absent or not a resource change", [effectEventId]));
      continue;
    }
    evidenceEventIds.push(effect.eventId);
    if (effect.source.kind === "watcher") {
      gaps.push(gap(
        "unverified",
        `tool:${request.eventId}`,
        "snapshot-observed effect origin cannot be proven solely from the intercepted operation",
        [effect.eventId],
      ));
    }
  }

  if (request.payload.opaque) {
    gaps.push(gap("opaque", `tool:${request.eventId}`, "opaque operation effects are not prospectively enumerable", [request.eventId]));
    modes.push("unknown");
  } else if ((completion.payload.effectEventIds.length > 0 || observedReadEventIds.length > 0) && gaps.length === 0) {
    modes.push("verified");
  } else if (completion.payload.effectEventIds.length === 0) {
    modes.push("unknown");
  } else {
    modes.push("unknown");
  }

  return createCoverage(`tool:${request.eventId}`, modes, gaps, evidenceEventIds);
}

export function deriveProjectionCoverage(
  events: readonly ProtocolEvent[],
  sourceSequenceGaps: readonly SourceSequenceGap[],
  corrections: ReadonlyMap<EventId, AttributionOverride> = new Map(),
): readonly ProjectionCoverage[] {
  const eventsById = new Map(events.map((event) => [event.eventId, event] as const));
  const completionsByRequest = new Map<EventId, ToolCompletedEvent>();
  for (const event of events) {
    if (event.eventType === "tool.completed") completionsByRequest.set(event.payload.requestEventId, event);
  }

  const coverage: ProjectionCoverage[] = [];
  for (const event of events) {
    if (event.eventType === "tool.requested") {
      coverage.push(toolCoverage(event, completionsByRequest.get(event.eventId), eventsById));
    }
    if (event.eventType === "file.changed" || event.eventType === "symbol.changed") {
      const attribution = effectiveAttribution(event, corrections);
      if (event.causationId === null && attribution.agentId === null && attribution.taskId === null) {
        coverage.push(createCoverage(
          `event:${event.eventId}`,
          ["unknown"],
          [gap("unattributed", `event:${event.eventId}`, "resource change has no intercepted causal parent or attribution", [event.eventId])],
          [event.eventId],
        ));
      }
    }
  }

  for (const sequenceGap of sourceSequenceGaps) {
    const scope = `source:${sequenceGap.source.kind}:${sequenceGap.source.sourceId}:${sequenceGap.source.instanceId}`;
    coverage.push(createCoverage(
      "event-stream",
      ["unknown"],
      sequenceGap.missingRanges.map((range) => gap(
        "missing_sequence",
        scope,
        `source sequence gap ${range.from}-${range.to}`,
        [],
      )),
      [],
    ));
  }

  return coverage.sort((left, right) => compareStrings(left.coverageId, right.coverageId));
}
