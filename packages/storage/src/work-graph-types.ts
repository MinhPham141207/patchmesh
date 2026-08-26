import type {
  AgentId,
  AttributionCorrectedEvent,
  CoverageId,
  Decision,
  Dependency,
  EventId,
  Finding,
  FindingFeedback,
  FindingId,
  LogicalResource,
  NullableAgentId,
  NullableTaskId,
  ProtocolEvent,
  ResourceVersion,
  TaskId,
  WorkProductId,
} from "patchmesh-protocol";
import type { SourceSequenceGap } from "./replay.js";

export type GraphNodeKind = "agent" | "task" | "resource" | "version";

export type GraphEdgeKind =
  | "performs"
  | "reads"
  | "changes"
  | "depends_on"
  | "references_version";

export interface AgentNode {
  readonly kind: "agent";
  readonly nodeId: string;
  readonly agentId: AgentId;
  readonly evidenceEventIds: readonly EventId[];
}

export interface TaskNode {
  readonly kind: "task";
  readonly nodeId: string;
  readonly taskId: TaskId;
  readonly evidenceEventIds: readonly EventId[];
  readonly completionEventIds: readonly EventId[];
  readonly workProductIds: readonly WorkProductId[];
}

export interface ResourceNode {
  readonly kind: "resource";
  readonly nodeId: string;
  readonly resource: LogicalResource;
  readonly evidenceEventIds: readonly EventId[];
}

export interface VersionNode {
  readonly kind: "version";
  readonly nodeId: string;
  readonly version: ResourceVersion;
  readonly evidenceEventIds: readonly EventId[];
}

export type GraphNode = AgentNode | TaskNode | ResourceNode | VersionNode;

export interface GraphEdge {
  readonly edgeId: string;
  readonly kind: GraphEdgeKind;
  readonly fromNodeId: string | null;
  readonly toNodeId: string;
  readonly evidenceEventIds: readonly EventId[];
  readonly attribution: {
    readonly agentId: NullableAgentId;
    readonly taskId: NullableTaskId;
  };
  readonly changeKind?: "created" | "modified" | "deleted" | "renamed";
  readonly beforeVersionId?: string | null;
  readonly afterVersionId?: string;
  readonly dependency?: Dependency;
}

export type ProjectionCoverageMode = "intercepted" | "verified" | "inferred" | "unknown";

export type ProjectionCoverageGapKind = "opaque" | "unverified" | "unattributed" | "missing_sequence";

export interface ProjectionCoverageGap {
  readonly kind: ProjectionCoverageGapKind;
  readonly scope: string;
  readonly reason: string;
  readonly evidenceEventIds: readonly EventId[];
}

export interface ProjectionCoverage {
  readonly coverageId: CoverageId;
  readonly scope: string;
  readonly modes: readonly ProjectionCoverageMode[];
  readonly gaps: readonly ProjectionCoverageGap[];
  readonly evidenceEventIds: readonly EventId[];
  readonly presentation: "sufficient" | "degraded" | "unknown";
}

export interface FindingView {
  readonly finding: Finding;
  readonly feedback: readonly FeedbackView[];
  readonly status: Finding["status"];
  readonly eventIds: readonly EventId[];
}

/** An immutable feedback response together with the event that records it. */
export interface FeedbackView {
  readonly eventId: EventId;
  readonly feedback: FindingFeedback;
}

export interface DecisionView {
  readonly decision: Decision;
  readonly deliveries: readonly Decision["deliveries"][number][];
  readonly feedback: readonly FeedbackView[];
  readonly eventIds: readonly EventId[];
}

export interface WorkGraphSnapshot {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly coverage: readonly ProjectionCoverage[];
  readonly findings: readonly FindingView[];
  readonly decisions: readonly DecisionView[];
}

export interface WorkGraphReplayResult {
  readonly orderedEvents: readonly ProtocolEvent[];
  readonly sourceSequenceGaps: readonly SourceSequenceGap[];
  /** Results served from a projection checkpoint carry an empty `eventsById` (history is trusted, not held). */
  readonly state: WorkGraphState;
  readonly snapshot: WorkGraphSnapshot;
}

export interface AttributionOverride {
  readonly eventId: EventId;
  readonly correction: AttributionCorrectedEvent;
}

export interface WorkGraphState {
  readonly eventsById: Map<EventId, ProtocolEvent>;
  readonly correctionsByTarget: Map<EventId, AttributionOverride>;
  readonly nodes: Map<string, GraphNode>;
  readonly edges: Map<string, GraphEdge>;
  readonly findings: Map<FindingId, FindingView>;
  readonly decisions: Map<string, DecisionView>;
  readonly coverageInputs: readonly ProjectionCoverage[];
}
