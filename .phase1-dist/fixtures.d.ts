import type { AgentId, ProtocolEvent, RepositoryId, TaskId, WorkspaceId, WorktreeId } from "@patchmesh/protocol";
export declare const repositoryId: RepositoryId;
export declare const workspaceId: WorkspaceId;
export declare const producerWorktreeId: WorktreeId;
export declare const consumerWorktreeId: WorktreeId;
export declare const producerAgentId: AgentId;
export declare const consumerAgentId: AgentId;
export declare const producerTaskId: TaskId;
export declare const consumerTaskId: TaskId;
export declare function buildGoldenEvents(): readonly ProtocolEvent[];
export declare function buildReplayCorpus(eventCount: number): readonly ProtocolEvent[];
export declare function duplicateVariant(events: readonly ProtocolEvent[]): readonly ProtocolEvent[];
export declare function outOfOrderVariant(events: readonly ProtocolEvent[]): readonly ProtocolEvent[];
export declare function conflictingDuplicate(event: ProtocolEvent): ProtocolEvent;
export declare function missingCausalReference(event: ProtocolEvent): ProtocolEvent;
//# sourceMappingURL=fixtures.d.ts.map