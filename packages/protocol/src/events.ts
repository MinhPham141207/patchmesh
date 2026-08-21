import type {
  AgentId,
  CorrelationId,
  CoverageId,
  DecisionId,
  DeliveryId,
  DependencyId,
  EventId,
  FeedbackId,
  FindingId,
  LogicalResource,
  NullableAgentId,
  NullableTaskId,
  RepositoryId,
  ResourceId,
  ResourceVersion,
  Source,
  TargetSnapshot,
  TargetSnapshotId,
  TaskId,
  VersionDomain,
  WorkspaceId,
  WorkProductId,
  WorktreeId,
} from "./identities.js";

export interface BaseEvent {
  readonly schemaVersion: 1;
  readonly eventId: EventId;
  readonly source: Source;
  readonly timestamp: string;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly agentId: NullableAgentId;
  readonly taskId: NullableTaskId;
  readonly correlationId: CorrelationId;
  readonly causationId: EventId | null;
  readonly sourceSequence: number | null;
}

export interface BaseEventV2 extends Omit<BaseEvent, "schemaVersion"> {
  readonly schemaVersion: 2;
}

export interface BaseEventV3 extends Omit<BaseEvent, "schemaVersion" | "agentId" | "taskId"> {
  readonly schemaVersion: 3;
  readonly agentId: AgentId;
  readonly taskId: TaskId;
}

/**
 * Normalized tool vocabulary. Detectors match on this closed set; `other` carries every
 * host tool that has no coordination meaning (search, listing, todo, fetch).
 *
 * `spawn_subagent` is not merely another host tool: it is the only call that creates a new
 * actor, so it is the edge that turns a flat event log into an agent tree. A detector asking
 * whether two agents collided has to be able to find it without string-matching host names.
 */
export type ToolName =
  | "read_file"
  | "edit_file"
  | "run_shell"
  | "run_test"
  | "git_commit"
  | "spawn_subagent"
  | "other";

export interface ToolRequestedPayload {
  readonly toolName: ToolName;
  readonly operation: string;
  readonly targetResourceId: ResourceId | null;
  readonly opaque: boolean;
  /**
   * Raw tool name as the host named it, retained so a recorded session stays auditable
   * against the host transcript after normalization into `toolName`. Optional: events
   * produced before host recording existed do not carry it.
   */
  readonly hostToolName?: string;
}

export interface ToolCompletedPayload {
  readonly requestEventId: EventId;
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly exitCode: number | null;
  readonly effectEventIds: readonly EventId[];
  /** Watcher file-change effects whose origin was confirmed by structured execution metadata. */
  readonly deterministicallyAttributedEffectEventIds?: readonly EventId[];
}

export interface ResourceObservedPayload {
  readonly resource: LogicalResource;
  readonly version: ResourceVersion;
  readonly access: "read" | "execute";
}

export interface ResourceChangedPayload {
  readonly resource: LogicalResource;
  readonly beforeVersion: ResourceVersion | null;
  readonly afterVersion: ResourceVersion;
  readonly changeKind: "created" | "modified" | "deleted" | "renamed";
}

export interface TaskCompletedPayload {
  readonly workProductId: WorkProductId;
  readonly baseRevision: string;
  readonly targetSnapshotId: TargetSnapshotId;
  readonly resourceIds: readonly ResourceId[];
}

export interface ProvenanceObservation {
  readonly kind: "declared" | "statically_observed" | "dynamically_observed" | "semantically_inferred";
  readonly producer: { readonly sourceId: string; readonly version: string };
  readonly rule: { readonly ruleId: string; readonly version: string } | null;
  readonly evidenceEventIds: readonly EventId[];
}

export interface Dependency {
  readonly dependencyId: DependencyId;
  readonly dependentResourceId: ResourceId;
  readonly dependencyResourceId: ResourceId;
  readonly dependentVersion: ResourceVersion;
  readonly dependencyVersion: ResourceVersion;
  readonly observations: readonly ProvenanceObservation[];
  readonly evidenceEventIds: readonly EventId[];
}

export interface DependencyChangedPayload {
  readonly dependency: Dependency;
}

export interface AttributionCorrectedPayload {
  readonly targetEventId: EventId;
  readonly attributedAgentId: NullableAgentId;
  readonly attributedTaskId: NullableTaskId;
  readonly reason: string;
  readonly evidenceEventIds: readonly EventId[];
}

export type FindingType = "same_symbol_overlap" | "stale_read_before_write" | "exported_contract_invalidation";
export type FindingStatus = "open" | "dismissed" | "resolved";
export type ConfidenceBand = "low" | "medium" | "high";
export type Severity = "info" | "warning" | "critical";

export interface Finding {
  readonly findingId: FindingId;
  readonly findingType: FindingType;
  readonly status: FindingStatus;
  readonly subjectResourceId: ResourceId;
  readonly affectedTaskId: NullableTaskId;
  readonly dependencyIds: readonly DependencyId[];
  readonly evidenceEventIds: readonly EventId[];
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly severity: Severity;
  readonly coverageIds: readonly CoverageId[];
  readonly detector: { readonly detectorId: string; readonly version: string };
}

export interface FindingCreatedPayload {
  readonly finding: Finding;
}

/**
 * An immutable response to a finding.  This deliberately records a response rather
 * than mutating the finding so replay can reconstruct both its current status and
 * the complete response history.
 */
export interface FindingFeedback {
  readonly feedbackId: FeedbackId;
  readonly findingId: FindingId;
  readonly decisionId: DecisionId | null;
  readonly actor: DecisionTarget;
  readonly disposition: "dismissed" | "acknowledged" | "not_affected" | "already_handled" | "needs_more_information";
  readonly useful: boolean | null;
  readonly reason: string | null;
  readonly evidenceEventIds: readonly EventId[];
}

export interface FindingFeedbackCreatedPayload {
  readonly feedback: FindingFeedback;
}

/** Explicit proof that a write depends on a previously observed resource read. */
export interface DependentWritePayload {
  readonly write: {
    readonly dependencyId: DependencyId;
    readonly resourceId: ResourceId;
    readonly dependsOnReadEventId: EventId;
    readonly coverageId: CoverageId;
    /** V2.1 explicit comparison; absent legacy writes remain replayable but are not stale evidence. */
    readonly comparison?: {
      readonly changedEventId: EventId;
      readonly coverageId: CoverageId;
      readonly integrationTarget: string;
    };
  };
}

export type Sha256Digest = `sha256:${string}`;

/** A complete immutable integration-target snapshot carried by PR5 proof events. */
/**
 * The canonical Phase 0 snapshot contract. Its digest is the plain hexadecimal
 * SHA-256 of the closed snapshot object and its ID is `snapshot_${digest}`.
 */
export type ImmutableTargetSnapshot = TargetSnapshot;

/**
 * Canonical host-issued proof that a task observed one persisted resource version.
 * The token is presented by a later dependent write; it is not a separate event.
 */
export interface ObservedReadToken {
  readonly schemaVersion: 1;
  readonly tokenDigest: Sha256Digest;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly observedVersion: ResourceVersion;
  readonly readEventId: EventId;
  readonly targetSnapshot: ImmutableTargetSnapshot;
}

/** PR5 proof that a dependent write used a target-bound observed-read token. */
export type ProofBearingDependentWrite = Omit<
  DependentWritePayload["write"],
  "comparison"
> & {
  readonly comparison: NonNullable<DependentWritePayload["write"]["comparison"]>;
  readonly readToken: ObservedReadToken;
  readonly targetSnapshot: ImmutableTargetSnapshot;
  readonly writeEffectEventId: EventId;
  readonly writeEffectCoverageId: CoverageId;
  readonly completionEventId: EventId;
};

export interface DependentWriteProofPayload {
  readonly write: ProofBearingDependentWrite;
}

/** Immutable observation that two independently-attributed task changes overlapped. */
export interface TaskConcurrencyObservedPayload {
  readonly observation: {
    readonly firstTaskId: TaskId;
    readonly secondTaskId: TaskId;
    readonly firstChangeEventId: EventId;
    readonly secondChangeEventId: EventId;
    readonly integrationTarget: string;
    readonly coverageId: CoverageId;
  };
}

/** Immutable witness emitted from an authoritative host-owned overlap registry. */
export type AuthoritativeOverlapProof =
  | {
      readonly kind: "authoritative_task_lifetimes";
      readonly firstLifecycleId: string;
      readonly secondLifecycleId: string;
    }
  | {
      readonly kind: "executor_owned_tool_windows";
      readonly firstWindowId: string;
      readonly secondWindowId: string;
      readonly firstRequestEventId: EventId;
      readonly firstCompletionEventId: EventId;
      readonly secondRequestEventId: EventId;
      readonly secondCompletionEventId: EventId;
    };

export type ProofBearingTaskConcurrencyObservation =
  TaskConcurrencyObservedPayload["observation"] & {
    readonly firstAgentId: AgentId;
    readonly secondAgentId: AgentId;
    readonly firstWorktreeId: WorktreeId;
    readonly secondWorktreeId: WorktreeId;
    readonly targetSnapshot: ImmutableTargetSnapshot;
    readonly overlapProof: AuthoritativeOverlapProof;
  };

export interface TaskConcurrencyProofPayload {
  readonly observation: ProofBearingTaskConcurrencyObservation;
}

export interface DerivedEvidencePayload {
  readonly evidence: {
    readonly targetEventId: EventId;
    readonly factKind: "symbol" | "dependency";
    readonly analyzer: { readonly analyzerId: string; readonly version: string };
    readonly configuration: Readonly<Record<string, string | number | boolean>>;
    readonly configurationDigest: string;
    readonly sourceEventIds: readonly EventId[];
    readonly integrationTarget: string;
    readonly coverage: { readonly status: "sufficient" | "degraded"; readonly reason: string };
    readonly coverageId: CoverageId;
    readonly stableFactId: ResourceId | DependencyId;
    readonly exported: boolean;
    readonly normalizedSignature: string | null;
  };
}

/** Hash-bound source input used by a deterministic analyzer or resolver. */
export interface SourceAnalysisBinding {
  readonly sourceEventId: EventId;
  readonly sourceResourceId: ResourceId;
  readonly sourceVersion: ResourceVersion;
  readonly analysisInputDigest: Sha256Digest;
}

export type DerivedRelationshipProof =
  | {
      readonly kind: "hash_bound_symbol_contract";
      readonly sourceAnalysis: SourceAnalysisBinding;
    }
  | {
      readonly kind: "resolver_confirmed_consumer_dependency";
      readonly sourceAnalysis: SourceAnalysisBinding;
      readonly resolver: {
        readonly resolverId: string;
        readonly version: string;
      };
      readonly dependencyId: DependencyId;
      readonly consumerResourceId: ResourceId;
      readonly contractResourceId: ResourceId;
      readonly resolution: "confirmed";
    };

export type ProofBearingDerivedEvidence = DerivedEvidencePayload["evidence"] & {
  readonly targetSnapshot: ImmutableTargetSnapshot;
  readonly proof: DerivedRelationshipProof;
};

export interface DerivedEvidenceProofPayload {
  readonly evidence: ProofBearingDerivedEvidence;
}

export interface DecisionTarget {
  readonly agentId: NullableAgentId;
  readonly taskId: NullableTaskId;
}

export type CoordinationAction =
  | "record"
  | "notify"
  | "request_recheck"
  | "assign_owner"
  | "redirect"
  | "pause"
  | "mark_possibly_stale"
  | "mark_stale"
  | "request_revalidation"
  | "create_follow_up_task"
  | "escalate";

export type GatewayDirective = "allow" | "allow_with_notice" | "delay" | "reject";

export interface DecisionDelivery {
  readonly deliveryId: DeliveryId;
  readonly target: DecisionTarget;
  readonly state: "pending" | "delivered" | "acknowledged" | "failed";
  readonly eventIds: readonly EventId[];
}

export interface Decision {
  readonly decisionId: DecisionId;
  readonly findingId: FindingId;
  readonly target: DecisionTarget;
  readonly coordinationAction: CoordinationAction;
  readonly gatewayDirective: GatewayDirective;
  readonly reason: string;
  readonly evidenceEventIds: readonly EventId[];
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly policy: { readonly policyId: string; readonly version: string };
  readonly expectedResponse: "affected" | "not_affected" | "already_handled" | "needs_more_information";
  readonly coverageIds: readonly CoverageId[];
  readonly state: "active" | "resolved";
  readonly deliveries: readonly DecisionDelivery[];
}

export interface DecisionCreatedPayload {
  readonly decision: Decision;
}

export interface ValidityTransition {
  readonly from: "unassessed" | "valid" | "possibly_stale" | "revalidating" | "stale";
  readonly to: "unassessed" | "valid" | "possibly_stale" | "revalidating" | "stale";
  readonly reason: "validation_passed" | "dependency_impact" | "validation_started" | "validation_failed" | "deterministic_proof" | "validation_inconclusive" | "validation_interrupted" | "target_superseded";
  readonly targetSnapshotId: TargetSnapshotId;
  readonly evidenceEventIds: readonly EventId[];
}

export interface ValidityRecord {
  readonly validityId: string;
  readonly taskId: TaskId;
  readonly workProductId: WorkProductId;
  readonly executionState: "completed" | "failed" | "cancelled";
  readonly validityState: "unassessed" | "valid" | "possibly_stale" | "revalidating" | "stale";
  readonly baseRevision: string;
  readonly targetSnapshotId: TargetSnapshotId;
  readonly observedDependencies: readonly ResourceVersion[];
  readonly validations: readonly { readonly command: string; readonly outcome: "started" | "passed" | "failed" | "inconclusive" | "interrupted"; readonly targetSnapshotId: TargetSnapshotId; readonly resultEventId: EventId }[];
  readonly coverageIds: readonly CoverageId[];
  readonly evidenceEventIds: readonly EventId[];
  readonly lastTransition: ValidityTransition | null;
}

export interface ValidityChangedPayload {
  readonly record: ValidityRecord;
  readonly transition: ValidityTransition;
}

export interface DecisionDeliveryChangedPayload {
  readonly decisionId: DecisionId;
  readonly delivery: DecisionDelivery;
}

export interface ToolRequestedEvent extends BaseEvent {
  readonly eventType: "tool.requested";
  readonly payload: ToolRequestedPayload;
}

export interface ToolCompletedEvent extends BaseEvent {
  readonly eventType: "tool.completed";
  readonly payload: ToolCompletedPayload;
}

export interface FileReadEvent extends BaseEvent {
  readonly eventType: "file.read";
  readonly payload: ResourceObservedPayload;
}

export interface SymbolReadEvent extends BaseEvent {
  readonly eventType: "symbol.read";
  readonly payload: ResourceObservedPayload;
}

export interface FileChangedEvent extends BaseEvent {
  readonly eventType: "file.changed";
  readonly payload: ResourceChangedPayload;
}

export interface SymbolChangedEvent extends BaseEvent {
  readonly eventType: "symbol.changed";
  readonly payload: ResourceChangedPayload;
}

export interface TaskCompletedEvent extends BaseEvent {
  readonly eventType: "task.completed";
  readonly payload: TaskCompletedPayload;
}

export interface DependencyChangedEvent extends BaseEvent {
  readonly eventType: "dependency.changed";
  readonly payload: DependencyChangedPayload;
}

export interface AttributionCorrectedEvent extends BaseEvent {
  readonly eventType: "attribution.corrected";
  readonly payload: AttributionCorrectedPayload;
}

export interface FindingCreatedEvent extends BaseEvent {
  readonly eventType: "finding.created";
  readonly payload: FindingCreatedPayload;
}

export interface FindingFeedbackCreatedEvent extends BaseEventV2 {
  readonly eventType: "finding.feedback.created";
  readonly payload: FindingFeedbackCreatedPayload;
}

export interface DependentWriteEventV2 extends BaseEventV2 {
  readonly eventType: "write.dependent";
  readonly payload: DependentWritePayload;
}

export interface DependentWriteEventV3 extends BaseEventV3 {
  readonly eventType: "write.dependent";
  readonly payload: DependentWriteProofPayload;
}

export type DependentWriteEvent = DependentWriteEventV2 | DependentWriteEventV3;

export interface DerivedEvidenceEventV2 extends BaseEventV2 {
  readonly eventType: "evidence.derived";
  readonly payload: DerivedEvidencePayload;
}

export interface DerivedEvidenceEventV3 extends BaseEventV3 {
  readonly eventType: "evidence.derived";
  readonly payload: DerivedEvidenceProofPayload;
}

export type DerivedEvidenceEvent = DerivedEvidenceEventV2 | DerivedEvidenceEventV3;

export interface TaskConcurrencyObservedEventV2 extends BaseEventV2 {
  readonly eventType: "task.concurrency.observed";
  readonly payload: TaskConcurrencyObservedPayload;
}

export interface TaskConcurrencyObservedEventV3 extends BaseEventV3 {
  readonly eventType: "task.concurrency.observed";
  readonly payload: TaskConcurrencyProofPayload;
}

export type TaskConcurrencyObservedEvent =
  | TaskConcurrencyObservedEventV2
  | TaskConcurrencyObservedEventV3;

export interface DecisionCreatedEvent extends BaseEvent {
  readonly eventType: "decision.created";
  readonly payload: DecisionCreatedPayload;
}

export interface ValidityChangedEvent extends BaseEvent {
  readonly eventType: "validity.changed";
  readonly payload: ValidityChangedPayload;
}

export interface DecisionDeliveryChangedEvent extends BaseEvent {
  readonly eventType: "decision.delivery.changed";
  readonly payload: DecisionDeliveryChangedPayload;
}

export type Phase1InputEvent =
  | ToolRequestedEvent
  | ToolCompletedEvent
  | FileReadEvent
  | FileChangedEvent
  | SymbolReadEvent
  | SymbolChangedEvent
  | TaskCompletedEvent
  | DependencyChangedEvent
  | AttributionCorrectedEvent
  | DerivedEvidenceEvent;

export type ProjectionEvent =
  | FindingCreatedEvent
  | FindingFeedbackCreatedEvent
  | DependentWriteEvent
  | TaskConcurrencyObservedEvent
  | DecisionCreatedEvent
  | ValidityChangedEvent
  | DecisionDeliveryChangedEvent;

export type ProtocolEvent = Phase1InputEvent | ProjectionEvent;

export type EventType = ProtocolEvent["eventType"];

export type EventForType<TEventType extends EventType> = Extract<ProtocolEvent, { readonly eventType: TEventType }>;

export type EventDomain = {
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly agentId: NullableAgentId;
  readonly taskId: NullableTaskId;
  readonly correlationId: CorrelationId;
  readonly source: Source;
  readonly sourceSequence: number | null;
};

export type EventIdentity = {
  readonly eventId: EventId;
  readonly causationId: EventId | null;
};

export type EventVersionDomain = VersionDomain;
