import type {
  CoverageId,
  DependencyId,
  EventId,
  FindingType,
  ResourceId,
  TaskId,
} from "@patchmesh/protocol";

export interface DetectorEvidence {
  readonly subjectResourceId: ResourceId;
  readonly affectedTaskId: TaskId | null;
  readonly dependencyIds: readonly DependencyId[];
  readonly evidenceEventIds: readonly EventId[];
  readonly coverageIds: readonly CoverageId[];
}

export interface DetectorFinding {
  readonly findingType: FindingType;
  readonly evidence: DetectorEvidence;
  readonly confidence: number;
  readonly reason: string;
}

export interface ReportOnlyDecision {
  readonly action: "record" | "notify" | "request_recheck" | "mark_possibly_stale" | "request_revalidation";
  readonly gatewayDirective: "allow" | "allow_with_notice";
}
