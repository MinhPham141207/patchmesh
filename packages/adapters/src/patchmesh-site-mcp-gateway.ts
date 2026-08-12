import { randomUUID } from "node:crypto";
import { sanitizeDiagnostic } from "@patchmesh/observation";
import type {
  EventId,
  ProtocolEvent,
  Source,
  ToolCompletedEvent,
} from "@patchmesh/protocol";
import type { EventAppender } from "./types.js";
import { digestHostAdapterCapabilities, type HostAdapterCapabilities, type HostAdapterCapabilityDigest } from "./host-adapter-capabilities.js";
import { McpProxy } from "./mcp-proxy.js";
import type {
  McpCallContext,
  McpProxyOptions,
  McpProxyResult,
  McpToolCall,
  ToolExecutionResult,
  ToolExecutor,
} from "./types.js";

export interface PatchMeshSiteRuntimeIdentity {
  readonly source: Source;
  readonly repositoryId: McpCallContext["repositoryId"];
  readonly workspaceId: McpCallContext["workspaceId"];
  readonly worktreeId: McpCallContext["worktreeId"];
  readonly workspaceRoot: string;
  readonly agentId: McpCallContext["agentId"];
  readonly taskId: McpCallContext["taskId"];
  readonly causationId: McpCallContext["causationId"];
}

/**
 * These claims are supplied by the patchmesh-site host configuration, not by an
 * MCP request. `synchronousGateway` is the PR4 capability checkpoint: without
 * it this adapter cannot claim to own an execution window.
 */
export interface PatchMeshSiteHostContract {
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly synchronousGateway: boolean;
  readonly authoritativeIdentity: boolean;
  readonly taskLifecycle: boolean;
  readonly exactReportedEffects: boolean;
  readonly integrationTargetSnapshot: boolean;
  /**
   * Must remain false for this PR4 gateway: it serializes every dispatch so its
   * source-sequence ordering is append-ordered.
   */
  readonly concurrentWorktreeObservation: boolean;
  readonly observedReadVersion: boolean;
  readonly dependentWriteToken: boolean;
}

export type PatchMeshSiteCapabilityStatus =
  | {
      readonly status: "internal_ready";
      readonly capabilities: HostAdapterCapabilities;
      readonly capabilityDigest: HostAdapterCapabilityDigest;
    }
  | {
      readonly status: "blocked";
      readonly code:
        | "PATCHMESH_SITE_SYNCHRONOUS_GATEWAY_UNAVAILABLE"
        | "PATCHMESH_SITE_CONCURRENT_WORKTREE_OBSERVATION_UNSUPPORTED"
        | "PATCHMESH_SITE_CAPABILITY_INVALID";
      readonly reason: string;
      readonly capabilities: HostAdapterCapabilities;
      readonly capabilityDigest: HostAdapterCapabilityDigest;
    };

export function detectPatchMeshSiteCapabilities(contract: PatchMeshSiteHostContract): PatchMeshSiteCapabilityStatus {
  const capabilities: HostAdapterCapabilities = {
    schemaVersion: 1,
    runtime: "patchmesh-site",
    runtimeVersion: contract.runtimeVersion,
    adapterVersion: contract.adapterVersion,
    wrapsToolExecution: contract.synchronousGateway,
    authoritativeIdentity: contract.authoritativeIdentity,
    taskLifecycle: contract.taskLifecycle,
    exactReportedEffects: contract.exactReportedEffects,
    integrationTargetSnapshot: contract.integrationTargetSnapshot,
    // Dispatch is intentionally serialized in PR4 to preserve append ordering.
    concurrentWorktreeObservation: false,
    observedReadVersion: contract.observedReadVersion,
    dependentWriteToken: contract.dependentWriteToken,
  };
  const capabilityDigest = digestHostAdapterCapabilities(capabilities);
  if (contract.runtimeVersion.trim().length === 0 || contract.adapterVersion.trim().length === 0) {
    return {
      status: "blocked",
      code: "PATCHMESH_SITE_CAPABILITY_INVALID",
      reason: "patchmesh-site runtimeVersion and adapterVersion must be non-empty",
      capabilities,
      capabilityDigest,
    };
  }
  if (!contract.synchronousGateway) {
    return {
      status: "blocked",
      code: "PATCHMESH_SITE_SYNCHRONOUS_GATEWAY_UNAVAILABLE",
      reason: "patchmesh-site does not provide a synchronous executor-owning MCP gateway",
      capabilities,
      capabilityDigest,
    };
  }
  if (contract.concurrentWorktreeObservation) {
    return {
      status: "blocked",
      code: "PATCHMESH_SITE_CONCURRENT_WORKTREE_OBSERVATION_UNSUPPORTED",
      reason: "patchmesh-site PR4 serializes gateway dispatches and cannot claim concurrent worktree observation",
      capabilities,
      capabilityDigest,
    };
  }
  return { status: "internal_ready", capabilities, capabilityDigest };
}

export class PatchMeshSiteIdentityMismatchError extends Error {
  readonly code = "PATCHMESH_SITE_IDENTITY_MISMATCH";

  constructor() {
    super("MCP payload identity does not match authoritative patchmesh-site runtime identity");
    this.name = "PatchMeshSiteIdentityMismatchError";
  }
}

/** Raised before persistence when the supplied host identity is not an adapter source. */
export class PatchMeshSiteRuntimeIdentityError extends Error {
  readonly code = "PATCHMESH_SITE_RUNTIME_IDENTITY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PatchMeshSiteRuntimeIdentityError";
  }
}

/** Raised when the host contract cannot support the synchronous PR4 boundary. */
export class PatchMeshSiteCapabilityError extends Error {
  readonly code: Extract<PatchMeshSiteCapabilityStatus, { status: "blocked" }> ["code"];
  readonly capabilityDigest: HostAdapterCapabilityDigest;

  constructor(status: Extract<PatchMeshSiteCapabilityStatus, { status: "blocked" }>) {
    super(`${status.code}: ${status.reason}`);
    this.name = "PatchMeshSiteCapabilityError";
    this.code = status.code;
    this.capabilityDigest = status.capabilityDigest;
  }
}

export class PatchMeshSitePersistedEvidenceError extends Error {
  readonly code = "PATCHMESH_SITE_PERSISTED_EVIDENCE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PatchMeshSitePersistedEvidenceError";
  }
}

export interface PatchMeshSitePayloadIdentity {
  readonly repositoryId?: McpCallContext["repositoryId"];
  readonly workspaceId?: McpCallContext["workspaceId"];
  readonly worktreeId?: McpCallContext["worktreeId"];
  readonly agentId?: McpCallContext["agentId"];
  readonly taskId?: McpCallContext["taskId"];
}

export interface PatchMeshSiteToolInvocation<T> {
  readonly call: McpToolCall;
  readonly execute: ToolExecutor<T>;
  /** Host-owned call ID for recorder correlation; it is not PatchMesh identity. */
  readonly hostToolCallId?: string | null;
  /** Optional host payload claims can confirm identity but never supply it. */
  readonly payloadIdentity?: PatchMeshSitePayloadIdentity;
}

export interface PatchMeshSitePersistedToolEvidence {
  readonly request: ProtocolEvent;
  readonly completion: ProtocolEvent;
  /** Only event IDs explicitly linked from this terminal completion. */
  readonly effects: readonly ProtocolEvent[];
  /** Recorder-safe order: request, linked effects, terminal completion. */
  readonly events: readonly ProtocolEvent[];
}

export interface PatchMeshSiteEvidencePayload<T> {
  readonly action: "tool.completed";
  readonly agentId: McpCallContext["agentId"];
  readonly taskId: McpCallContext["taskId"];
  readonly worktreeId: McpCallContext["worktreeId"];
  readonly toolCallId: string | null;
  readonly patchmesh: {
    readonly runtime: "patchmesh-site";
    readonly runtimeVersion: string;
    readonly adapterVersion: string;
    readonly capabilityDigest: HostAdapterCapabilityDigest;
    readonly result: McpProxyResult<T>;
    readonly events: readonly ProtocolEvent[];
  };
}

export interface PatchMeshSiteEvidenceRecorder {
  record<T>(payload: PatchMeshSiteEvidencePayload<T>): Promise<void> | void;
}

export interface PatchMeshSiteEventStore extends EventAppender {
  read(): readonly ProtocolEvent[];
}

export interface PatchMeshSiteMcpGatewayOptions {
  readonly eventStore: PatchMeshSiteEventStore;
  readonly hostContract: PatchMeshSiteHostContract;
  readonly proxyOptions?: Omit<McpProxyOptions, "eventStore">;
  readonly evidenceRecorder?: PatchMeshSiteEvidenceRecorder;
  readonly createCorrelationId?: () => McpCallContext["correlationId"];
}

export interface PatchMeshSiteGatewayResult<T> {
  /** The original executor result, including failed/interrupted/non-zero outcomes. */
  readonly execution: ToolExecutionResult<T>;
  readonly proxyResult: McpProxyResult<T>;
  readonly evidence: PatchMeshSitePersistedToolEvidence | null;
  /** Recorder/evidence handoff diagnostics never alter `execution`. */
  readonly recorderDiagnostic: string | null;
}

function sameNullableIdentity<T>(authoritative: T, claimed: T | undefined): boolean {
  return claimed === undefined || claimed === authoritative;
}

function assertPayloadIdentity(identity: PatchMeshSiteRuntimeIdentity, claimed: PatchMeshSitePayloadIdentity | undefined): void {
  if (claimed === undefined) return;
  if (claimed.repositoryId !== undefined && claimed.repositoryId !== identity.repositoryId
    || claimed.workspaceId !== undefined && claimed.workspaceId !== identity.workspaceId
    || claimed.worktreeId !== undefined && claimed.worktreeId !== identity.worktreeId
    || !sameNullableIdentity(identity.agentId, claimed.agentId)
    || !sameNullableIdentity(identity.taskId, claimed.taskId)) {
    throw new PatchMeshSiteIdentityMismatchError();
  }
}

function assertRuntimeIdentity(identity: PatchMeshSiteRuntimeIdentity): void {
  const source = identity?.source;
  if (source?.kind !== "adapter"
    || typeof source.sourceId !== "string" || source.sourceId.trim().length === 0
    || typeof source.instanceId !== "string" || source.instanceId.trim().length === 0) {
    throw new PatchMeshSiteRuntimeIdentityError(
      "patchmesh-site runtime identity must provide a non-empty adapter sourceId and instanceId",
    );
  }
}

function sameToolContext(left: ProtocolEvent, right: ProtocolEvent): boolean {
  return left.repositoryId === right.repositoryId
    && left.workspaceId === right.workspaceId
    && left.worktreeId === right.worktreeId
    && left.agentId === right.agentId
    && left.taskId === right.taskId
    && left.correlationId === right.correlationId;
}

function terminalCompletion(events: readonly ProtocolEvent[], completedEventId: EventId): ToolCompletedEvent {
  const completion = events.find((event) => event.eventId === completedEventId);
  if (completion?.eventType !== "tool.completed") {
    throw new PatchMeshSitePersistedEvidenceError("terminal completion is absent from the gateway event store");
  }
  return completion;
}

/**
 * Reads a closed evidence slice from one append-only store. It intentionally does
 * not broaden the slice with correlation-matching events, hook paths, or tool I/O.
 */
export function readPatchMeshSitePersistedToolEvidence(
  eventStore: PatchMeshSiteEventStore,
  completedEventId: EventId,
): PatchMeshSitePersistedToolEvidence {
  const events = eventStore.read();
  const completion = terminalCompletion(events, completedEventId);
  const request = events.find((event) => event.eventId === completion.payload.requestEventId);
  if (request?.eventType !== "tool.requested"
    || completion.causationId !== request.eventId
    || !sameToolContext(request, completion)) {
    throw new PatchMeshSitePersistedEvidenceError("terminal completion is not linked to one matching persisted request");
  }
  const effectById = new Map(events.map((event) => [event.eventId, event] as const));
  const completionLinkedEvents = completion.payload.effectEventIds.map((eventId) => effectById.get(eventId));
  if (completionLinkedEvents.some((event) => event === undefined)) {
    throw new PatchMeshSitePersistedEvidenceError("terminal completion references an unavailable persisted effect");
  }
  const linkedEffects = completionLinkedEvents.filter((event): event is ProtocolEvent => event?.eventType === "file.changed");
  if (linkedEffects.some((event) => event.causationId !== request.eventId || !sameToolContext(event, completion))) {
    throw new PatchMeshSitePersistedEvidenceError("completion-linked effects do not share the persisted tool context");
  }
  return { request, completion, effects: linkedEffects, events: [request, ...linkedEffects, completion] };
}

function boundedRecorderDiagnostic(error: unknown): string {
  const detail = error instanceof Error ? error.message : "patchmesh-site evidence recorder failed";
  return sanitizeDiagnostic(detail).slice(0, 240);
}

function defaultCorrelationId(): McpCallContext["correlationId"] {
  return `corr_${randomUUID().replaceAll("-", "")}`;
}

/**
 * A transparent patchmesh-site MCP gateway. The gateway owns the host dispatch
 * window and has no route that invokes the executor outside `McpProxy.execute`.
 */
export class PatchMeshSiteMcpGateway {
  readonly capabilities: HostAdapterCapabilities;
  readonly capabilityDigest: HostAdapterCapabilityDigest;
  readonly productionGate = "external_host_execution_required" as const;
  private readonly proxy: McpProxy;
  private readonly eventStore: PatchMeshSiteEventStore;
  private readonly evidenceRecorder: PatchMeshSiteEvidenceRecorder | undefined;
  private readonly createCorrelationId: () => McpCallContext["correlationId"];
  private readonly sourceSequences = new Map<string, number>();
  private dispatchTail: Promise<void> = Promise.resolve();

  constructor(options: PatchMeshSiteMcpGatewayOptions) {
    const status = detectPatchMeshSiteCapabilities(options.hostContract);
    if (status.status === "blocked") throw new PatchMeshSiteCapabilityError(status);
    this.capabilities = status.capabilities;
    this.capabilityDigest = status.capabilityDigest;
    this.eventStore = options.eventStore;
    this.proxy = new McpProxy({ ...options.proxyOptions, eventStore: options.eventStore });
    this.evidenceRecorder = options.evidenceRecorder;
    this.createCorrelationId = options.createCorrelationId ?? defaultCorrelationId;
  }

  async dispatch<T>(
    identity: PatchMeshSiteRuntimeIdentity,
    invocation: PatchMeshSiteToolInvocation<T>,
    signal?: AbortSignal,
  ): Promise<PatchMeshSiteGatewayResult<T>> {
    return this.runExclusive(() => this.dispatchSerialized(identity, invocation, signal));
  }

  private async dispatchSerialized<T>(
    identity: PatchMeshSiteRuntimeIdentity,
    invocation: PatchMeshSiteToolInvocation<T>,
    signal: AbortSignal | undefined,
  ): Promise<PatchMeshSiteGatewayResult<T>> {
    assertRuntimeIdentity(identity);
    assertPayloadIdentity(identity, invocation.payloadIdentity);
    const sourceKey = `${identity.source.kind}:${identity.source.sourceId}:${identity.source.instanceId}`;
    const requestSourceSequence = this.sourceSequences.get(sourceKey) ?? 0;
    const completionSourceSequence = requestSourceSequence + 1;
    this.sourceSequences.set(sourceKey, completionSourceSequence + 1);
    const context: McpCallContext = {
      source: identity.source,
      repositoryId: identity.repositoryId,
      workspaceId: identity.workspaceId,
      worktreeId: identity.worktreeId,
      workspaceRoot: identity.workspaceRoot,
      agentId: identity.agentId,
      taskId: identity.taskId,
      correlationId: this.createCorrelationId(),
      causationId: identity.causationId,
      requestSourceSequence,
      completionSourceSequence,
    };
    const proxyResult = await this.proxy.execute(invocation.call, context, invocation.execute, signal);
    let evidence: PatchMeshSitePersistedToolEvidence | null = null;
    let recorderDiagnostic: string | null = null;
    try {
      evidence = readPatchMeshSitePersistedToolEvidence(this.eventStore, proxyResult.completedEventId);
      if (this.evidenceRecorder !== undefined) {
        await this.evidenceRecorder.record({
          action: "tool.completed",
          agentId: identity.agentId,
          taskId: identity.taskId,
          worktreeId: identity.worktreeId,
          toolCallId: invocation.hostToolCallId ?? null,
          patchmesh: {
            runtime: "patchmesh-site",
            runtimeVersion: this.capabilities.runtimeVersion,
            adapterVersion: this.capabilities.adapterVersion,
            capabilityDigest: this.capabilityDigest,
            result: proxyResult,
            events: evidence.events,
          },
        });
      }
    } catch (error) {
      recorderDiagnostic = boundedRecorderDiagnostic(error);
      evidence = null;
    }
    return { execution: proxyResult.execution, proxyResult, evidence, recorderDiagnostic };
  }

  /**
   * McpProxy receives fixed request/completion sequence numbers. Serializing the
   * full dispatch prevents a later completion from being appended ahead of an
   * earlier reserved completion when host calls overlap.
   */
  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.dispatchTail;
    let release: (() => void) | undefined;
    this.dispatchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release!();
    }
  }

  async dispose(): Promise<void> {
    await this.proxy.dispose();
  }
}
