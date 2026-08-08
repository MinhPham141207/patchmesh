import type {
  CorrelationId,
  CoverageId,
  EventId,
  NullableAgentId,
  NullableTaskId,
  RepositoryId,
  Source,
  WorkspaceId,
  WorktreeId,
} from "@patchmesh/protocol";

export interface ObservationContext {
  readonly workspaceRoot: string;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
}

export interface ObservedFileState {
  readonly contentHash: string;
  readonly gitBlob: string | null;
  readonly fileKind: "file" | "directory" | "symlink";
}

export interface ObservationSnapshot {
  readonly repository: {
    readonly commonDirectory: string | null;
    readonly revision: string | null;
  };
  readonly worktree: {
    readonly administrativeDirectory: string | null;
  };
  readonly files: ReadonlyMap<string, ObservedFileState>;
}

export type ObservationGapKind =
  | "bypassed"
  | "opaque"
  | "missing_sequence"
  | "unattributed"
  | "unverified";

export interface ObservationGap {
  readonly kind: ObservationGapKind;
  readonly scope: string;
  readonly reason: string;
}

export interface ObservationDiagnostic extends ObservationGap {}

export interface ObservedFileChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly before: ObservedFileState | null;
  readonly after: ObservedFileState | null;
  readonly changeKind: "created" | "modified" | "deleted" | "renamed";
  readonly outOfBand: boolean;
  readonly agentId?: NullableAgentId;
  readonly taskId?: NullableTaskId;
  readonly correlationId?: CorrelationId;
}

export interface ObservationCapture {
  readonly snapshot: ObservationSnapshot;
  readonly gaps: readonly ObservationGap[];
  readonly outOfBandChanges: readonly ObservedFileChange[];
}

export interface ObservationBoundary {
  readonly source: Source;
  captureBefore(context: ObservationContext): Promise<ObservationCapture>;
  captureAfter(context: ObservationContext): Promise<ObservationCapture>;
}

export interface DerivedCoverage {
  readonly coverageId: CoverageId;
  readonly scope: string;
  readonly modes: readonly ("intercepted" | "verified" | "inferred" | "unknown")[];
  readonly evidenceEventIds: readonly EventId[];
  readonly gaps: readonly (ObservationGap & { readonly evidenceEventIds: readonly EventId[] })[];
  readonly presentation: "sufficient" | "degraded" | "unknown";
}
