import type {
  AgentId,
  CorrelationId,
  EventId,
  Source,
  SymbolChangedEvent,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "patchmesh-protocol";

import type { DerivedEvidenceFacts, SymbolEvidenceFact } from "./evidence-facts.js";

export interface SymbolEventContext {
  readonly repositoryId: SymbolChangedEvent["repositoryId"];
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly agentId: AgentId | null;
  readonly taskId: TaskId | null;
  readonly correlationId: CorrelationId;
  readonly source: Source;
  readonly timestamp: string;
  readonly sourceSequenceStart: number | null;
}

function sourceEventId(fact: SymbolEvidenceFact): EventId {
  const eventId = fact.sourceFacts.sourceEventIds[0];
  if (eventId === undefined) throw new Error("symbol evidence requires at least one source event ID");
  return eventId;
}

/**
 * Converts already-derived source facts into immutable symbol-change candidates.
 * Event IDs are injected by the persistence boundary, keeping analysis pure and
 * making duplicate/replay identity auditable rather than guessed here.
 */
export function deriveSymbolChangedEvents(
  facts: DerivedEvidenceFacts,
  eventIds: readonly EventId[],
  context: SymbolEventContext,
): readonly SymbolChangedEvent[] {
  if (facts.symbols.length !== eventIds.length) {
    throw new Error("one event ID is required for each derived symbol fact");
  }
  return facts.symbols.map((fact, index) => ({
    schemaVersion: 1,
    eventId: eventIds[index]!,
    eventType: "symbol.changed",
    source: context.source,
    timestamp: context.timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: sourceEventId(fact),
    sourceSequence: context.sourceSequenceStart === null ? null : context.sourceSequenceStart + index,
    payload: {
      resource: fact.resource,
      beforeVersion: null,
      afterVersion: fact.version,
      changeKind: "created",
    },
  }));
}
