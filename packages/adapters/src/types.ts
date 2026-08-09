import type { AppendResult } from "@patchmesh/storage";
import type {
  DerivedCoverage,
  ObservationBoundary,
  ObservationDiagnostic,
} from "@patchmesh/observation";
import type {
  CorrelationId,
  DependencyId,
  EventId,
  NullableAgentId,
  NullableTaskId,
  RepositoryId,
  LogicalResource,
  ProtocolEvent,
  ResourceId,
  ResourceVersion,
  Source,
  ToolName,
  WorkspaceId,
  WorktreeId,
} from "@patchmesh/protocol";

export interface McpToolCall {
  readonly toolName: ToolName;
  readonly operation: string;
  readonly targetResourceId: ResourceId | null;
  readonly opaque: boolean;
  /** Explicit runtime metadata required before a file-level read may be persisted. */
  readonly observedRead?: {
    readonly resource: LogicalResource;
    readonly version: Pick<ResourceVersion, "kind" | "value">;
  };
  /** Structured proof that this operation writes a resource dependent on an earlier observed read. */
  readonly dependentWrite?: {
    readonly dependencyId: DependencyId;
    readonly resourceId: ResourceId;
    readonly dependsOnReadEventId: EventId;
  };
}

export interface McpCallContext {
  readonly source: Source;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
  readonly workspaceRoot?: string;
  readonly agentId: NullableAgentId;
  readonly taskId: NullableTaskId;
  readonly correlationId: CorrelationId;
  readonly causationId: EventId | null;
  readonly requestSourceSequence: number | null;
  readonly completionSourceSequence: number | null;
}

export type ToolExecutionResult<T> =
  | { readonly outcome: "succeeded"; readonly value: T; readonly exitCode: number | null }
  | { readonly outcome: "failed"; readonly error?: unknown; readonly exitCode: number | null }
  | { readonly outcome: "interrupted"; readonly reason?: unknown; readonly exitCode: number | null };

export type ToolExecutor<T> = (signal: AbortSignal) => Promise<ToolExecutionResult<T>>;

export interface EventAppender {
  append(input: unknown): AppendResult;
  /** Required to verify cross-event references before emitting V2 dependent writes. */
  read?(): readonly ProtocolEvent[];
}

/** Optional bounded source-analysis configuration for observed changed files. */
export interface Phase2SourceAnalysisOptions {
  readonly source: Source;
  readonly analyzer: { readonly analyzerId: string; readonly version: string };
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly integrationTarget: string;
}

export interface McpProxyOptions {
  readonly eventStore: EventAppender;
  readonly createEventId?: () => EventId;
  readonly now?: () => string;
  readonly observer?: ObservationBoundary;
  readonly createCorrelationId?: () => CorrelationId;
  readonly phase2SourceAnalysis?: Phase2SourceAnalysisOptions;
}

export interface McpProxyResult<T> {
  readonly execution: ToolExecutionResult<T>;
  readonly requestEventId: EventId;
  readonly completedEventId: EventId;
  readonly readEventIds: readonly EventId[];
  readonly coverage: DerivedCoverage | null;
  readonly observationDiagnostics: readonly ObservationDiagnostic[];
  readonly analysisDiagnostics: readonly { readonly path: string; readonly reason: string }[];
}
