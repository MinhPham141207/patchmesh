import type {
  DecisionCreatedEvent,
  DecisionId,
  EventId,
  FindingCreatedEvent,
  FindingId,
  Source,
  WorkspaceId,
  WorktreeId,
} from "@patchmesh/protocol";

import { evaluateReportOnlyPolicy, type ReportOnlyPolicyInput } from "./report-only-policy.js";
import type { DetectorFinding } from "./types.js";

export interface DurableRecordContext {
  readonly findingId: FindingId;
  readonly decisionId: DecisionId;
  readonly findingEventId: EventId;
  readonly decisionEventId: EventId;
  readonly repositoryId: FindingCreatedEvent["repositoryId"];
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly correlationId: FindingCreatedEvent["correlationId"];
  readonly source: Source;
  readonly timestamp: string;
  readonly sourceSequenceStart: number | null;
  readonly detector: { readonly detectorId: string; readonly version: string };
  readonly policy: { readonly policyId: string; readonly version: string };
}

export interface DurableReportOnlyRecords {
  readonly finding: FindingCreatedEvent;
  readonly decision: DecisionCreatedEvent;
}

function confidenceBand(confidence: number): "low" | "medium" | "high" {
  return confidence < 0.5 ? "low" : confidence < 0.8 ? "medium" : "high";
}

function severity(confidence: number): "info" | "warning" | "critical" {
  return confidence < 0.5 ? "info" : confidence < 0.9 ? "warning" : "critical";
}

function causalParent(finding: DetectorFinding): EventId {
  const eventId = finding.evidence.evidenceEventIds[0];
  if (eventId === undefined) throw new Error("durable finding creation requires causal evidence");
  return eventId;
}

/**
 * Builds immutable, schema-shaped Phase 2 output without persisting it. The caller
 * owns append/deduplication; this function ensures policy is limited to the report-
 * only vocabulary and that the decision is causally downstream of its finding.
 */
export function createDurableReportOnlyRecords(
  finding: DetectorFinding,
  policyInput: Omit<ReportOnlyPolicyInput, "finding">,
  context: DurableRecordContext,
): DurableReportOnlyRecords {
  const policy = evaluateReportOnlyPolicy({ finding, ...policyInput });
  const findingEvent: FindingCreatedEvent = {
    schemaVersion: 1,
    eventId: context.findingEventId,
    eventType: "finding.created",
    source: context.source,
    timestamp: context.timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: null,
    taskId: finding.evidence.affectedTaskId,
    correlationId: context.correlationId,
    causationId: causalParent(finding),
    sourceSequence: context.sourceSequenceStart,
    payload: {
      finding: {
        findingId: context.findingId,
        findingType: finding.findingType,
        status: "open",
        subjectResourceId: finding.evidence.subjectResourceId,
        affectedTaskId: finding.evidence.affectedTaskId,
        dependencyIds: finding.evidence.dependencyIds,
        evidenceEventIds: finding.evidence.evidenceEventIds,
        confidence: finding.confidence,
        confidenceBand: confidenceBand(finding.confidence),
        severity: severity(finding.confidence),
        coverageIds: finding.evidence.coverageIds,
        detector: context.detector,
      },
    },
  };
  const decisionEvent: DecisionCreatedEvent = {
    ...findingEvent,
    eventId: context.decisionEventId,
    eventType: "decision.created",
    causationId: findingEvent.eventId,
    sourceSequence: context.sourceSequenceStart === null ? null : context.sourceSequenceStart + 1,
    payload: {
      decision: {
        decisionId: context.decisionId,
        findingId: context.findingId,
        target: { agentId: null, taskId: finding.evidence.affectedTaskId },
        coordinationAction: policy.action,
        gatewayDirective: policy.gatewayDirective,
        reason: finding.reason,
        evidenceEventIds: finding.evidence.evidenceEventIds,
        confidence: finding.confidence,
        confidenceBand: confidenceBand(finding.confidence),
        policy: context.policy,
        expectedResponse: "affected",
        coverageIds: finding.evidence.coverageIds,
        state: "active",
        deliveries: [],
      },
    },
  };
  return { finding: findingEvent, decision: decisionEvent };
}
