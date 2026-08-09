import type { CorrelationId, EventId, RepositoryId, Source, WorkspaceId, WorktreeId } from "@patchmesh/protocol";

import { createDurableReportOnlyRecords, type DurableReportOnlyRecords } from "./durable-records.js";
import { evaluateReportOnlyPolicy } from "./report-only-policy.js";
import { decisionIdFor, findingIdFor } from "./stable-identities.js";
import type { DetectorFinding } from "./types.js";

export interface DurableEventPair {
  readonly findingEventId: EventId;
  readonly decisionEventId: EventId;
}

export interface ReportOnlyOrchestrationContext {
  readonly eventIds: readonly DurableEventPair[];
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly correlationId: CorrelationId;
  readonly source: Source;
  readonly timestamp: string;
  readonly sourceSequenceStart: number | null;
  readonly detector: { readonly detectorId: string; readonly version: string };
  readonly policy: { readonly policyId: string; readonly version: string };
  readonly affectedTaskCompleted: (finding: DetectorFinding) => boolean;
}

/**
 * Turns a deterministic finding set into report-only immutable records. Event IDs
 * are supplied by the persistence boundary, while stable finding/decision IDs and
 * output ordering remain independent of detector input order.
 */
export function createReportOnlyOrchestrationRecords(
  findings: readonly DetectorFinding[],
  context: ReportOnlyOrchestrationContext,
): readonly DurableReportOnlyRecords[] {
  const ordered = [...findings]
    .map((finding) => ({ finding, findingId: findingIdFor(finding) }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
  if (ordered.length !== context.eventIds.length) {
    throw new Error("one durable event pair is required for every finding");
  }
  return ordered.map(({ finding, findingId }, index) => {
    const policy = evaluateReportOnlyPolicy({ finding, affectedTaskCompleted: context.affectedTaskCompleted(finding) });
    const eventIds = context.eventIds[index]!;
    return createDurableReportOnlyRecords(finding, { affectedTaskCompleted: context.affectedTaskCompleted(finding) }, {
      findingId,
      decisionId: decisionIdFor(findingId, policy, finding.evidence.affectedTaskId),
      findingEventId: eventIds.findingEventId,
      decisionEventId: eventIds.decisionEventId,
      repositoryId: context.repositoryId,
      workspaceId: context.workspaceId,
      worktreeId: context.worktreeId,
      correlationId: context.correlationId,
      source: context.source,
      timestamp: context.timestamp,
      sourceSequenceStart: context.sourceSequenceStart === null ? null : context.sourceSequenceStart + (index * 2),
      detector: context.detector,
      policy: context.policy,
    });
  });
}
