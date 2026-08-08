import type { AppendResult } from "@patchmesh/storage";
import type {
  CorrelationId,
  EventId,
  NullableAgentId,
  NullableTaskId,
  RepositoryId,
  ResourceId,
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
}

export interface McpCallContext {
  readonly source: Source;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
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
}

export interface McpProxyOptions {
  readonly eventStore: EventAppender;
  readonly createEventId?: () => EventId;
  readonly now?: () => string;
}

export interface McpProxyResult<T> {
  readonly execution: ToolExecutionResult<T>;
  readonly requestEventId: EventId;
  readonly completedEventId: EventId;
}
