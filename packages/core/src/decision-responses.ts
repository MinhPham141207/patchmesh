import type {
  DecisionDelivery,
  DecisionDeliveryChangedEvent,
  DecisionId,
  EventId,
  FeedbackId,
  FindingFeedbackCreatedEvent,
  FindingId,
  Source,
  WorkspaceId,
  WorktreeId,
} from "@patchmesh/protocol";

export interface ResponseEventContext {
  readonly eventId: EventId;
  readonly repositoryId: DecisionDeliveryChangedEvent["repositoryId"];
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly correlationId: DecisionDeliveryChangedEvent["correlationId"];
  readonly causationId: EventId;
  readonly source: Source;
  readonly timestamp: string;
  readonly sourceSequence: number | null;
}

export interface DeliveryResponseInput {
  readonly decisionId: DecisionId;
  readonly delivery: DecisionDelivery;
}

export interface FeedbackResponseInput {
  readonly feedbackId: FeedbackId;
  readonly findingId: FindingId;
  readonly decisionId: DecisionId | null;
  readonly actor: { readonly agentId: FindingFeedbackCreatedEvent["agentId"]; readonly taskId: FindingFeedbackCreatedEvent["taskId"] };
  readonly disposition: FindingFeedbackCreatedEvent["payload"]["feedback"]["disposition"];
  readonly useful: boolean | null;
  readonly reason: string | null;
  readonly evidenceEventIds: readonly EventId[];
}

/** Creates a replayable delivery-state response without mutating the decision. */
export function createDecisionDeliveryChangedEvent(
  input: DeliveryResponseInput,
  context: ResponseEventContext,
): DecisionDeliveryChangedEvent {
  return {
    schemaVersion: 1,
    eventId: context.eventId,
    eventType: "decision.delivery.changed",
    source: context.source,
    timestamp: context.timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: input.delivery.target.agentId,
    taskId: input.delivery.target.taskId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    sourceSequence: context.sourceSequence,
    payload: input,
  };
}

/** Creates a versioned immutable feedback response; acknowledgments are not dismissal. */
export function createFindingFeedbackCreatedEvent(
  input: FeedbackResponseInput,
  context: ResponseEventContext,
): FindingFeedbackCreatedEvent {
  return {
    schemaVersion: 2,
    eventId: context.eventId,
    eventType: "finding.feedback.created",
    source: context.source,
    timestamp: context.timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: input.actor.agentId,
    taskId: input.actor.taskId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    sourceSequence: context.sourceSequence,
    payload: { feedback: input },
  };
}
