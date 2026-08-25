import type {
  EventId,
  ProtocolEvent,
  ToolCompletedEvent,
  ToolRequestedEvent,
} from "patchmesh-protocol";
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
  observedEffectsByCause: ReadonlyMap<EventId, readonly EventId[]>,
  observedReadsByCause: ReadonlyMap<EventId, readonly EventId[]>,
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
  const deterministicallyAttributedEffectEventIds = new Set(
    completion.payload.deterministicallyAttributedEffectEventIds ?? [],
  );
  // Indexed rather than scanned. This was a filter over every event in the ledger, run once per
  // tool request, which made the whole projection quadratic: `patchmesh status` took 41s on a
  // 8,824-event ledger and cost rose 4x for every doubling. The index is built in the same pass
  // that already builds `observedEffectsByCause`, in event order, so the result is identical.
  const observedReadEventIds = observedReadsByCause.get(request.eventId) ?? [];
  evidenceEventIds.push(...observedReadEventIds);
  for (const effectEventId of completion.payload.effectEventIds) {
    const effect = eventsById.get(effectEventId);
    if (effect === undefined || (effect.eventType !== "file.changed" && effect.eventType !== "symbol.changed")) {
      gaps.push(gap("unverified", `tool:${request.eventId}`, "declared effect event is absent or not a resource change", [effectEventId]));
      continue;
    }
    evidenceEventIds.push(effect.eventId);
    if (effect.source.kind === "watcher" && !deterministicallyAttributedEffectEventIds.has(effect.eventId)) {
      gaps.push(gap(
        "unverified",
        `tool:${request.eventId}`,
        "snapshot-observed effect origin cannot be proven solely from the intercepted operation",
        [effect.eventId],
      ));
    }
  }

  /**
   * Effects bound to this call by observation rather than declared by it.
   *
   * A hook recorder cannot declare its effects. `tool.completed` is written when the call
   * returns, and the filesystem is not diffed until the turn drains, so `effectEventIds` is
   * always empty on this path -- the linkage runs the other way, from the `file.changed`
   * event back to the completion it was bound to. `effects.ts` sets that `causationId` only
   * when exactly one call's window covered the change (`soleCallCovering`), so a non-null
   * causation *is* the deterministic binding, and there is no weaker case to distinguish.
   */
  const boundEffectEventIds = observedEffectsByCause.get(completion.eventId) ?? [];
  evidenceEventIds.push(...boundEffectEventIds);

  const effectsObserved = completion.payload.effectEventIds.length > 0 || boundEffectEventIds.length > 0;
  const effectsBound = effectsObserved && gaps.length === 0;

  // An opaque call whose effects were observed and bound is not a coverage gap.
  //
  // Opacity is a statement about *intent*: the ledger does not know what `sed -i` was trying
  // to do. It is not a statement about effect, and once the filesystem observation binds the
  // write to this call the effect is known exactly as well as an `Edit` call's is. Counting
  // it as missing conflated the two and made a shell-first agent look unobserved while its
  // every write was in fact recorded -- which is how `Coverage` came to read `degraded`
  // permanently and stopped carrying information. See docs/problems/PM-08 and PM-12.
  //
  // An opaque call with no observed effect stays a gap, and honestly so: most shell commands
  // are reads, a read leaves nothing on disk, and nothing here knows what it looked at.
  if (request.payload.opaque && !effectsBound) {
    gaps.push(gap("opaque", `tool:${request.eventId}`, "opaque operation effects are not prospectively enumerable", [request.eventId]));
    modes.push("unknown");
  } else if ((effectsObserved || observedReadEventIds.length > 0) && gaps.length === 0) {
    modes.push("verified");
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
  // Observed changes indexed by the completion they were bound to, which is the only direction
  // the hook path can express: the change is written after the completion and points back at it.
  const observedEffectsByCause = new Map<EventId, EventId[]>();
  // Observed reads indexed by the request that caused them, for the same reason: `toolCoverage`
  // needs the reads belonging to one call, and finding them by scanning every event once per
  // call is what made this O(requests x events).
  const observedReadsByCause = new Map<EventId, EventId[]>();
  for (const event of events) {
    if (event.eventType === "tool.completed") completionsByRequest.set(event.payload.requestEventId, event);
    if ((event.eventType === "file.changed" || event.eventType === "symbol.changed") && event.causationId !== null) {
      const bound = observedEffectsByCause.get(event.causationId);
      if (bound === undefined) observedEffectsByCause.set(event.causationId, [event.eventId]);
      else bound.push(event.eventId);
    }
    if ((event.eventType === "file.read" || event.eventType === "symbol.read") && event.causationId !== null) {
      const read = observedReadsByCause.get(event.causationId);
      if (read === undefined) observedReadsByCause.set(event.causationId, [event.eventId]);
      else read.push(event.eventId);
    }
  }

  const coverage: ProjectionCoverage[] = [];
  for (const event of events) {
    if (event.eventType === "tool.requested") {
      coverage.push(toolCoverage(
        event,
        completionsByRequest.get(event.eventId),
        eventsById,
        observedEffectsByCause,
        observedReadsByCause,
      ));
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
