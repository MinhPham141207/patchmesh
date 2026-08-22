import { createHash, randomUUID } from "node:crypto";
import { sanitizeDiagnostic } from "patchmesh-observation";
import { parseEvent, validateEventSet } from "patchmesh-protocol";
import { projectWorkGraph } from "patchmesh-storage";
import type {
  CoverageId,
  EventId,
  ProtocolEvent,
  Source,
  TargetSnapshot,
  ToolCompletedEvent,
} from "patchmesh-protocol";
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
  /** Required for PR5 proof production; host configuration, never MCP payload. */
  readonly targetSnapshot?: TargetSnapshot;
  /** Stable host-issued lifetime registered through beginTaskLifecycle. */
  readonly lifecycleId?: string;
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

export class PatchMeshSiteLifecycleError extends Error {
  readonly code = "PATCHMESH_SITE_LIFECYCLE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PatchMeshSiteLifecycleError";
  }
}

export class PatchMeshSiteProofCapabilityError extends Error {
  readonly code = "PATCHMESH_SITE_PROOF_CAPABILITY_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "PatchMeshSiteProofCapabilityError"; }
}

export interface PatchMeshSiteTaskLifecycle {
  readonly lifecycleId: string;
  readonly source: Source;
  readonly repositoryId: McpCallContext["repositoryId"];
  readonly workspaceId: McpCallContext["workspaceId"];
  readonly worktreeId: McpCallContext["worktreeId"];
  readonly agentId: NonNullable<McpCallContext["agentId"]>;
  readonly taskId: NonNullable<McpCallContext["taskId"]>;
  readonly targetSnapshot: TargetSnapshot;
}

interface ActiveLifecycle extends PatchMeshSiteTaskLifecycle {
  readonly overlaps: ReadonlySet<string>;
  /** Symbol changes emitted by dispatches while this exact lifetime was active. */
  readonly symbolChangeEventIds: ReadonlySet<EventId>;
  readonly state: "active" | "ended";
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalTargetSnapshot(snapshot: TargetSnapshot, repositoryId: string): void {
  const digest = createHash("sha256").update(canonicalJson({
    integrationTargetId: snapshot.integrationTargetId,
    repositoryId: snapshot.repositoryId,
    kind: snapshot.kind,
    locator: snapshot.locator,
    baseCommit: snapshot.baseCommit,
    candidateIds: snapshot.candidateIds,
  })).digest("hex");
  if (snapshot.repositoryId !== repositoryId || snapshot.digest !== digest || snapshot.targetSnapshotId !== `snapshot_${digest}`) {
    throw new PatchMeshSiteRuntimeIdentityError("patchmesh-site runtime target snapshot is not canonical for this repository");
  }
}

function stripLifecycleState(lifecycle: ActiveLifecycle): PatchMeshSiteTaskLifecycle {
  const { overlaps: _overlaps, symbolChangeEventIds: _symbolChangeEventIds, state: _state, ...registration } = lifecycle;
  return registration;
}

function matchesLifecycle(identity: PatchMeshSiteRuntimeIdentity, lifecycle: ActiveLifecycle): boolean {
  return identity.source.sourceId === lifecycle.source.sourceId
    && identity.source.instanceId === lifecycle.source.instanceId
    && identity.repositoryId === lifecycle.repositoryId
    && identity.workspaceId === lifecycle.workspaceId
    && identity.worktreeId === lifecycle.worktreeId
    && identity.agentId === lifecycle.agentId
    && identity.taskId === lifecycle.taskId
    && identity.targetSnapshot !== undefined
    && canonicalJson(identity.targetSnapshot) === canonicalJson(lifecycle.targetSnapshot);
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

function sufficientCoverageIdFor(events: readonly ProtocolEvent[], eventId: EventId): CoverageId | null {
  try {
    const byId = new Map(events.map((event) => [event.eventId, event] as const));
    const sufficient = projectWorkGraph(events).snapshot.coverage
      .filter((entry) => entry.presentation === "sufficient");
    const visited = new Set<EventId>();
    let current = byId.get(eventId);
    while (current !== undefined && !visited.has(current.eventId)) {
      const event = current;
      visited.add(event.eventId);
      const matches = sufficient.filter((entry) => entry.evidenceEventIds.includes(event.eventId));
      if (matches.length === 1) return matches[0]!.coverageId;
      current = event.causationId === null ? undefined : byId.get(event.causationId);
    }
    return null;
  } catch {
    return null;
  }
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
  private readonly lifecycles = new Map<string, ActiveLifecycle>();
  private readonly emittedConcurrency = new Set<string>();
  private dispatchTail: Promise<void> = Promise.resolve();

  constructor(options: PatchMeshSiteMcpGatewayOptions) {
    const status = detectPatchMeshSiteCapabilities(options.hostContract);
    if (status.status === "blocked") throw new PatchMeshSiteCapabilityError(status);
    this.capabilities = status.capabilities;
    this.capabilityDigest = status.capabilityDigest;
    this.eventStore = options.eventStore;
    this.proxy = new McpProxy({ ...options.proxyOptions, eventStore: options.eventStore, proofAuthority: {
      authoritativeIdentity: status.capabilities.authoritativeIdentity,
      taskLifecycle: status.capabilities.taskLifecycle,
      integrationTargetSnapshot: status.capabilities.integrationTargetSnapshot,
      observedReadVersion: status.capabilities.observedReadVersion,
      dependentWriteToken: status.capabilities.dependentWriteToken,
      exactReportedEffects: status.capabilities.exactReportedEffects,
    } });
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

  /** Registers a host-owned task lifetime. Same data is idempotent; conflicts fail closed. */
  beginTaskLifecycle(lifecycle: PatchMeshSiteTaskLifecycle): void {
    if (!this.capabilities.authoritativeIdentity || !this.capabilities.taskLifecycle || !this.capabilities.integrationTargetSnapshot) {
      throw new PatchMeshSiteProofCapabilityError("host capabilities do not authorize authoritative task lifecycle proofs");
    }
    if (lifecycle.lifecycleId.trim().length === 0) throw new PatchMeshSiteLifecycleError("lifecycle ID must be non-empty");
    assertCanonicalTargetSnapshot(lifecycle.targetSnapshot, lifecycle.repositoryId);
    const existing = this.lifecycles.get(lifecycle.lifecycleId);
    if (existing !== undefined) {
      if (existing.state !== "active" || canonicalJson(stripLifecycleState(existing)) !== canonicalJson(lifecycle)) {
        throw new PatchMeshSiteLifecycleError("conflicting duplicate task lifecycle registration");
      }
      return;
    }
    const overlaps = new Set([...this.lifecycles.values()]
      .filter((candidate) => candidate.state === "active" && candidate.repositoryId === lifecycle.repositoryId)
      .map((candidate) => candidate.lifecycleId));
    for (const overlapId of overlaps) {
      const other = this.lifecycles.get(overlapId);
      if (other !== undefined) this.lifecycles.set(overlapId, { ...other, overlaps: new Set([...other.overlaps, lifecycle.lifecycleId]) });
    }
    this.lifecycles.set(lifecycle.lifecycleId, { ...lifecycle, overlaps, symbolChangeEventIds: new Set(), state: "active" });
  }

  /** Ends exactly one active host-owned lifetime; an already-ended or unknown ID is rejected. */
  endTaskLifecycle(lifecycleId: string): void {
    const existing = this.lifecycles.get(lifecycleId);
    if (existing === undefined || existing.state !== "active") throw new PatchMeshSiteLifecycleError("task lifecycle is not active");
    this.lifecycles.set(lifecycleId, { ...existing, state: "ended" });
  }

  private async dispatchSerialized<T>(
    identity: PatchMeshSiteRuntimeIdentity,
    invocation: PatchMeshSiteToolInvocation<T>,
    signal: AbortSignal | undefined,
  ): Promise<PatchMeshSiteGatewayResult<T>> {
    assertRuntimeIdentity(identity);
    assertPayloadIdentity(identity, invocation.payloadIdentity);
    if (identity.targetSnapshot !== undefined) {
      if (!this.capabilities.authoritativeIdentity || !this.capabilities.taskLifecycle || !this.capabilities.integrationTargetSnapshot) {
        throw new PatchMeshSiteProofCapabilityError("host capabilities do not authorize target-bound proof capture");
      }
      assertCanonicalTargetSnapshot(identity.targetSnapshot, identity.repositoryId);
    }
    const lifecycle = identity.lifecycleId === undefined ? undefined : this.lifecycles.get(identity.lifecycleId);
    if (identity.lifecycleId !== undefined && (lifecycle === undefined || lifecycle.state !== "active" || !matchesLifecycle(identity, lifecycle))) {
      throw new PatchMeshSiteLifecycleError("runtime identity does not match an active authoritative task lifecycle");
    }
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
      ...(identity.targetSnapshot === undefined ? {} : { targetSnapshot: identity.targetSnapshot }),
    };
    const proxyResult = await this.proxy.execute(invocation.call, context, invocation.execute, signal);
    if (lifecycle !== undefined) {
      this.recordLifecycleSymbolChanges(lifecycle.lifecycleId, proxyResult.completedEventId);
      const activeLifecycle = this.lifecycles.get(lifecycle.lifecycleId);
      if (activeLifecycle !== undefined) this.emitConcurrencyProofs(activeLifecycle);
    }
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

  private emitConcurrencyProofs(current: ActiveLifecycle): void {
    const events = this.eventStore.read();
    const sufficientEvidence = new Map<EventId, Extract<ProtocolEvent, { eventType: "evidence.derived" }>[] >();
    for (const event of events) {
      if (event.eventType === "evidence.derived" && event.schemaVersion === 3
        && event.payload.evidence.factKind === "symbol" && event.payload.evidence.coverage.status === "sufficient"
        && canonicalJson(event.payload.evidence.targetSnapshot) === canonicalJson(current.targetSnapshot)) {
        sufficientEvidence.set(event.payload.evidence.targetEventId, [...(sufficientEvidence.get(event.payload.evidence.targetEventId) ?? []), event]);
      }
    }
    const currentChanges = events.filter((event): event is Extract<ProtocolEvent, { eventType: "symbol.changed" }> => event.eventType === "symbol.changed" && current.symbolChangeEventIds.has(event.eventId));
    for (const first of currentChanges) for (const second of events) {
      if (second.eventType !== "symbol.changed" || second.eventId === first.eventId || second.repositoryId !== current.repositoryId || second.payload.resource.resourceId !== first.payload.resource.resourceId || second.taskId === null || second.agentId === null) continue;
      const matchingLifecycles = [...this.lifecycles.values()].filter((candidate) => candidate.lifecycleId !== current.lifecycleId
        && candidate.taskId === second.taskId && candidate.agentId === second.agentId
        && candidate.worktreeId === second.worktreeId && candidate.workspaceId === second.workspaceId
        && candidate.repositoryId === second.repositoryId && candidate.symbolChangeEventIds.has(second.eventId));
      if (matchingLifecycles.length !== 1) continue;
      const other = matchingLifecycles[0]!;
      if (!current.overlaps.has(other.lifecycleId) || canonicalJson(other.targetSnapshot) !== canonicalJson(current.targetSnapshot) || second.worktreeId === current.worktreeId || second.agentId === current.agentId) continue;
      const firstEvidences = sufficientEvidence.get(first.eventId) ?? [];
      const secondEvidences = sufficientEvidence.get(second.eventId) ?? [];
      if (firstEvidences.length !== 1 || secondEvidences.length !== 1) continue;
      const ordered = [first, second].sort((left, right) => left.eventId.localeCompare(right.eventId));
      const key = `${ordered[0]!.eventId}:${ordered[1]!.eventId}:${current.targetSnapshot.targetSnapshotId}`;
      if (this.emittedConcurrency.has(key)) continue;
      const [left, right] = ordered as [typeof first, typeof second];
      const leftLifecycle = left.taskId === current.taskId ? current : other;
      const rightLifecycle = right.taskId === current.taskId ? current : other;
      const proofId = `evt_${createHash("sha256").update(key).digest("hex").slice(0, 32)}` as EventId;
      if (events.some((event) => event.eventId === proofId)) { this.emittedConcurrency.add(key); continue; }
      // The observation itself is caused by the current dispatch's change. The
      // other worktree is an overlap participant, never a cross-domain cause.
      const coverageId = sufficientCoverageIdFor(events, first.eventId);
      if (coverageId === null) continue;
      const proof: ProtocolEvent = {
        schemaVersion: 3, eventId: proofId, eventType: "task.concurrency.observed", source: current.source, timestamp: new Date().toISOString(), repositoryId: current.repositoryId, workspaceId: current.workspaceId, worktreeId: current.worktreeId, agentId: current.agentId, taskId: current.taskId, correlationId: first.correlationId, causationId: first.eventId, sourceSequence: null,
        payload: { observation: { firstTaskId: left.taskId!, secondTaskId: right.taskId!, firstChangeEventId: left.eventId, secondChangeEventId: right.eventId, integrationTarget: current.targetSnapshot.integrationTargetId, coverageId, firstAgentId: left.agentId!, secondAgentId: right.agentId!, firstWorktreeId: left.worktreeId, secondWorktreeId: right.worktreeId, targetSnapshot: current.targetSnapshot, overlapProof: { kind: "authoritative_task_lifetimes", firstLifecycleId: leftLifecycle.lifecycleId, secondLifecycleId: rightLifecycle.lifecycleId } } },
      };
      try {
        const parsed = parseEvent(proof);
        if (parsed.value === null) continue;
        if (validateEventSet([...this.eventStore.read(), parsed.value]).length > 0) continue;
        this.eventStore.append(parsed.value);
        this.emittedConcurrency.add(key);
      } catch { /* proof capture is non-authoritative and fails closed */ }
    }
  }

  /** Retains only symbol effects linked to one terminal completion of an active lifetime. */
  private recordLifecycleSymbolChanges(lifecycleId: string, completedEventId: EventId): void {
    const lifecycle = this.lifecycles.get(lifecycleId);
    if (lifecycle === undefined || lifecycle.state !== "active") return;
    const events = this.eventStore.read();
    const completion = events.find((event) => event.eventId === completedEventId);
    if (completion?.eventType !== "tool.completed") return;
    const byId = new Map(events.map((event) => [event.eventId, event] as const));
    const additions = completion.payload.effectEventIds
      .map((eventId) => byId.get(eventId))
      .filter((event): event is Extract<ProtocolEvent, { eventType: "symbol.changed" }> => event?.eventType === "symbol.changed" && sameToolContext(event, completion))
      .map((event) => event.eventId);
    if (additions.length === 0) return;
    this.lifecycles.set(lifecycleId, {
      ...lifecycle,
      symbolChangeEventIds: new Set([...lifecycle.symbolChangeEventIds, ...additions]),
    });
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
