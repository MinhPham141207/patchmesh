export type RepositoryId = `repo_${string}`;
export type WorkspaceId = `ws_${string}`;
export type WorktreeId = `wt_${string}`;
export type AgentId = `agent_${string}`;
export type TaskId = `task_${string}`;
export type EventId = `evt_${string}`;
export type ResourceId = `res_${string}`;
export type TargetId = `target_${string}`;
export type TargetSnapshotId = `snapshot_${string}`;
export type CorrelationId = `corr_${string}`;
export type DependencyId = `dep_${string}`;
export type WorkProductId = `work_${string}`;
export type FindingId = `finding_${string}`;
export type FeedbackId = `feedback_${string}`;
export type DecisionId = `decision_${string}`;
export type CoverageId = `coverage_${string}`;
export type DeliveryId = `delivery_${string}`;
export type ValidityId = `validity_${string}`;
export type MessageId = `msg_${string}`;

export type NullableAgentId = AgentId | null;
export type NullableTaskId = TaskId | null;

export type SourceKind = "gateway" | "adapter" | "watcher" | "analyzer" | "core";

export interface Source {
  readonly kind: SourceKind;
  readonly sourceId: string;
  readonly instanceId: string;
}

export interface VersionDomain {
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
}

export type ResourceKind = "file" | "symbol" | "api" | "schema" | "test";

export interface LogicalResource {
  readonly resourceId: ResourceId;
  readonly repositoryId: RepositoryId;
  readonly kind: ResourceKind;
  readonly locator: string;
}

export type VersionKind =
  | "git_commit"
  | "git_blob"
  | "content_hash"
  | "symbol_signature"
  | "schema_version"
  | "api_version"
  | "deleted";

export interface ResourceVersion {
  readonly resourceId: ResourceId;
  readonly domain: VersionDomain;
  readonly kind: VersionKind;
  readonly value: string | null;
  readonly evidenceEventIds: readonly EventId[];
}

export type IntegrationTargetKind = "branch" | "revision" | "candidate_aggregate";

export interface TargetSnapshot {
  readonly targetSnapshotId: TargetSnapshotId;
  readonly integrationTargetId: TargetId;
  readonly repositoryId: RepositoryId;
  readonly kind: IntegrationTargetKind;
  readonly locator: string;
  readonly baseCommit: string;
  readonly candidateIds: readonly string[];
  readonly digest: string;
}
