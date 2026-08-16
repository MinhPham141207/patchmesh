import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import {
  deriveDependencyChangedEvents,
  deriveEvidenceFacts,
  deriveSymbolChangedEvents,
  configurationDigest,
  resolveLocalContractDependencies,
  type DerivedEvidenceFacts,
  type AnalysisCoverage,
  type SourceAnalysisInput,
  type SourceFacts,
  type SymbolEvidenceFact,
  type SymbolEventContext,
} from "@patchmesh/analyzers";
import {
  parseEvent,
  ProtocolValidationError,
  validateEventSet,
  type CoverageId,
  type DependentWriteEvent,
  type EventId,
  type FileChangedEvent,
  type DerivedEvidenceEvent,
  type FileReadEvent,
  type LogicalResource,
  type ObservedReadToken,
  type ProtocolEvent,
  type ResourceVersion,
  type ToolCompletedEvent,
  type ToolRequestedEvent,
} from "@patchmesh/protocol";
import { projectWorkGraph } from "@patchmesh/storage";
import {
  deriveCoverage,
  diffSnapshots,
  fileResourceId,
  normalizeLogicalPath,
  sanitizeDiagnostic,
  type ObservationCapture,
  type ObservationContext,
  type ObservationGap,
  type IncrementalObservationBoundary,
  type ObservationWindow,
  type ObservedFileChange,
} from "@patchmesh/observation";
import type {
  McpCallContext,
  McpProxyOptions,
  McpProxyResult,
  McpToolCall,
  EventAppender,
  ToolExecutionResult,
  ToolExecutor,
} from "./types.js";
import { McpProxyStorageError } from "./errors.js";

interface DerivedSourceAnalysis {
  readonly facts: DerivedEvidenceFacts;
  readonly context: SymbolEventContext;
  readonly symbolEventIds: readonly EventId[];
  readonly targetSnapshot: McpCallContext["targetSnapshot"];
}

function isIncrementalObserver(value: McpProxyOptions["observer"]): value is IncrementalObservationBoundary {
  return value !== undefined && "beginWindow" in value && "endWindow" in value;
}

function appendValidated(event: ProtocolEvent, eventStore: EventAppender): ProtocolEvent {
  const parsed = parseEvent(event);
  if (parsed.value === null) throw new ProtocolValidationError(parsed.diagnostics);
  return eventStore.append(parsed.value).event;
}

function appendProofValidated(event: ProtocolEvent, eventStore: EventAppender): ProtocolEvent {
  const parsed = parseEvent(event);
  if (parsed.value === null) throw new ProtocolValidationError(parsed.diagnostics);
  if (eventStore.read !== undefined) {
    const diagnostics = validateEventSet([...eventStore.read(), parsed.value]);
    if (diagnostics.length > 0) throw new ProtocolValidationError(diagnostics);
  }
  return eventStore.append(parsed.value).event;
}

function randomHexId(): string {
  return randomUUID().replaceAll("-", "");
}

function contentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sufficientPersistedCoverageId(events: readonly ProtocolEvent[], eventId: EventId): CoverageId | null {
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

function issueObservedReadToken(
  context: McpCallContext,
  readEvent: FileReadEvent,
  enabled: boolean,
): ObservedReadToken | null {
  if (!enabled || context.taskId === null || context.targetSnapshot === undefined) return null;
  const tokenWithoutDigest = {
    schemaVersion: 1 as const,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    taskId: context.taskId,
    resourceId: readEvent.payload.resource.resourceId,
    observedVersion: readEvent.payload.version,
    readEventId: readEvent.eventId,
    targetSnapshot: context.targetSnapshot,
  };
  return {
    ...tokenWithoutDigest,
    tokenDigest: `sha256:${createHash("sha256").update(canonicalJson(tokenWithoutDigest)).digest("hex")}`,
  };
}

function asToolRequested(event: ProtocolEvent): ToolRequestedEvent {
  if (event.eventType !== "tool.requested") throw new Error("stored request event has an invalid type");
  return event;
}

function createToolRequestedEvent(
  call: McpToolCall,
  context: McpCallContext,
  eventId: EventId,
  timestamp: string,
): ToolRequestedEvent {
  return {
    schemaVersion: 1,
    eventId,
    eventType: "tool.requested",
    source: context.source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    sourceSequence: context.requestSourceSequence,
    payload: {
      toolName: call.toolName,
      operation: sanitizeDiagnostic(call.operation),
      targetResourceId: call.targetResourceId,
      opaque: call.opaque,
    },
  };
}

function createToolCompletedEvent(
  context: McpCallContext,
  requestEventId: EventId,
  eventId: EventId,
  timestamp: string,
  outcome: ToolCompletedEvent["payload"]["outcome"],
  exitCode: number | null,
  effectEventIds: readonly EventId[],
  deterministicallyAttributedEffectEventIds: readonly EventId[],
): ToolCompletedEvent {
  return {
    schemaVersion: 1,
    eventId,
    eventType: "tool.completed",
    source: context.source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: requestEventId,
    sourceSequence: context.completionSourceSequence,
    payload: {
      requestEventId,
      outcome,
      exitCode,
      effectEventIds,
      ...(deterministicallyAttributedEffectEventIds.length === 0
        ? {}
        : { deterministicallyAttributedEffectEventIds }),
    },
  };
}

const snapshotOriginGapReason = "snapshot observation verifies final state but cannot prove each effect originated from the intercepted operation";

function isSnapshotOriginGap(gap: ObservationGap): boolean {
  return gap.kind === "unverified" && gap.scope === "tool.effects" && gap.reason === snapshotOriginGapReason;
}

function hasExactEffectResourceMatch(
  reported: readonly string[],
  observed: readonly string[],
): boolean {
  if (reported.length === 0 || reported.length !== observed.length) return false;
  if (new Set(reported).size !== reported.length || new Set(observed).size !== observed.length) return false;
  const orderedReported = [...reported].sort((left, right) => left.localeCompare(right));
  const orderedObserved = [...observed].sort((left, right) => left.localeCompare(right));
  return orderedReported.every((resourceId, index) => resourceId === orderedObserved[index]);
}

function deterministicallyAttributedEffectEventIds(
  call: McpToolCall,
  execution: ToolExecutionResult<unknown>,
  changes: readonly FileChangedEvent[],
  observationGaps: readonly ObservationGap[],
  outOfBandEventIds: readonly EventId[],
): readonly EventId[] {
  if (execution.outcome !== "succeeded" || call.opaque || changes.length === 0 || outOfBandEventIds.length > 0) return [];
  if (!hasExactEffectResourceMatch(
    execution.effectResourceIds ?? [],
    changes.map((change) => change.payload.resource.resourceId),
  )) return [];
  if (observationGaps.some((gap) => !isSnapshotOriginGap(gap))) return [];
  return changes.map((change) => change.eventId);
}

function createResource(repositoryId: LogicalResource["repositoryId"], path: string): LogicalResource {
  const locator = normalizeLogicalPath(path);
  return {
    resourceId: fileResourceId(repositoryId, locator),
    repositoryId,
    kind: "file",
    locator,
  };
}

function createVersion(
  resourceId: LogicalResource["resourceId"],
  context: McpCallContext,
  state: ObservedFileChange["after"],
  eventId: EventId,
): ResourceVersion {
  return {
    resourceId,
    domain: {
      repositoryId: context.repositoryId,
      workspaceId: context.workspaceId,
      worktreeId: context.worktreeId,
    },
    kind: state === null ? "deleted" : "content_hash",
    value: state?.contentHash ?? null,
    evidenceEventIds: [eventId],
  };
}

function createFileChangedEvent(
  change: ObservedFileChange,
  context: McpCallContext,
  source: ProtocolEvent["source"],
  causationId: EventId | null,
  correlationId: ProtocolEvent["correlationId"],
  agentId: ProtocolEvent["agentId"],
  taskId: ProtocolEvent["taskId"],
  eventId: EventId,
  timestamp: string,
): FileChangedEvent {
  const resource = createResource(context.repositoryId, change.path);
  return {
    schemaVersion: 1,
    eventId,
    eventType: "file.changed",
    source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId,
    taskId,
    correlationId,
    causationId,
    sourceSequence: null,
    payload: {
      resource,
      beforeVersion: change.before === null
        ? null
        : createVersion(resource.resourceId, context, change.before, eventId),
      afterVersion: createVersion(resource.resourceId, context, change.after, eventId),
      changeKind: change.changeKind,
    },
  };
}

function createFileReadEvent(
  call: McpToolCall,
  context: McpCallContext,
  requestEventId: EventId,
  eventId: EventId,
  timestamp: string,
): FileReadEvent | null {
  if (call.observedRead === undefined) return null;
  const { resource, version } = call.observedRead;
  return {
    schemaVersion: 1,
    eventId,
    eventType: "file.read",
    source: context.source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: requestEventId,
    sourceSequence: null,
    payload: {
      resource,
      version: {
        resourceId: resource.resourceId,
        domain: {
          repositoryId: context.repositoryId,
          workspaceId: context.workspaceId,
          worktreeId: context.worktreeId,
        },
        kind: version.kind,
        value: version.value,
        evidenceEventIds: [eventId],
      },
      access: "read",
    },
  };
}

function createDerivedEvidenceEvent(
  target: ProtocolEvent,
  eventId: EventId,
  sourceFacts: SourceFacts,
  factKind: "symbol" | "dependency",
  stableFactId: string,
  sourceEventIds: readonly EventId[],
  exported: boolean,
  coverageId: string,
  normalizedSignature: string | null,
  targetSnapshot?: McpCallContext["targetSnapshot"],
  sourceVersion?: ResourceVersion,
  contractResourceId?: import("@patchmesh/protocol").ResourceId,
): DerivedEvidenceEvent {
  if (targetSnapshot !== undefined && sourceVersion !== undefined && target.agentId !== null && target.taskId !== null) {
    const sourceEventId = sourceEventIds[0];
    if (sourceEventId !== undefined) {
      return {
        schemaVersion: 3,
        eventId,
        eventType: "evidence.derived",
        source: target.source,
        timestamp: target.timestamp,
        repositoryId: target.repositoryId,
        workspaceId: target.workspaceId,
        worktreeId: target.worktreeId,
        agentId: target.agentId,
        taskId: target.taskId,
        correlationId: target.correlationId,
        causationId: target.eventId,
        sourceSequence: null,
        payload: { evidence: {
          targetEventId: target.eventId, factKind, analyzer: sourceFacts.analyzer,
          configuration: sourceFacts.configuration, configurationDigest: configurationDigest(sourceFacts.configuration),
          sourceEventIds: [...new Set(sourceEventIds)].sort((left, right) => left.localeCompare(right)),
          integrationTarget: targetSnapshot.integrationTargetId, coverage: sourceFacts.coverage,
          coverageId: coverageId as DerivedEvidenceEvent["payload"]["evidence"]["coverageId"],
          stableFactId: stableFactId as DerivedEvidenceEvent["payload"]["evidence"]["stableFactId"], exported, normalizedSignature,
          targetSnapshot,
          proof: factKind === "symbol" ? { kind: "hash_bound_symbol_contract", sourceAnalysis: {
            sourceEventId, sourceResourceId: sourceFacts.resource.resourceId, sourceVersion,
            analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: sourceFacts.resource.resourceId, sourceVersion })).digest("hex")}`,
          } } : { kind: "resolver_confirmed_consumer_dependency", sourceAnalysis: {
            sourceEventId, sourceResourceId: sourceFacts.resource.resourceId, sourceVersion,
            analysisInputDigest: `sha256:${createHash("sha256").update(canonicalJson({ sourceResourceId: sourceFacts.resource.resourceId, sourceVersion })).digest("hex")}`,
          }, resolver: { resolverId: "local-contract-resolver", version: "1" }, dependencyId: stableFactId as import("@patchmesh/protocol").DependencyId, consumerResourceId: sourceFacts.resource.resourceId, contractResourceId: contractResourceId ?? sourceFacts.resource.resourceId, resolution: "confirmed" },
        } },
      };
    }
  }
  return {
    schemaVersion: 2,
    eventId,
    eventType: "evidence.derived",
    source: target.source,
    timestamp: target.timestamp,
    repositoryId: target.repositoryId,
    workspaceId: target.workspaceId,
    worktreeId: target.worktreeId,
    agentId: target.agentId,
    taskId: target.taskId,
    correlationId: target.correlationId,
    causationId: target.eventId,
    sourceSequence: null,
    payload: {
      evidence: {
        targetEventId: target.eventId,
        factKind,
        analyzer: sourceFacts.analyzer,
        configuration: sourceFacts.configuration,
        configurationDigest: configurationDigest(sourceFacts.configuration),
        sourceEventIds: [...new Set(sourceEventIds)].sort((left, right) => left.localeCompare(right)),
        integrationTarget: sourceFacts.integrationTarget,
        coverage: sourceFacts.coverage,
        coverageId: coverageId as DerivedEvidenceEvent["payload"]["evidence"]["coverageId"],
        stableFactId: stableFactId as DerivedEvidenceEvent["payload"]["evidence"]["stableFactId"],
        exported,
        normalizedSignature,
      },
    },
  };
}

function persistedContractFacts(events: readonly ProtocolEvent[]): readonly SymbolEvidenceFact[] {
  const eventsById = new Map(events.map((event) => [event.eventId, event] as const));
  const facts: SymbolEvidenceFact[] = [];
  for (const metadata of events) {
    if (metadata.eventType !== "evidence.derived"
      || metadata.payload.evidence.factKind !== "symbol"
      || !metadata.payload.evidence.exported
      || metadata.payload.evidence.coverage.status !== "sufficient"
      || metadata.payload.evidence.normalizedSignature === null) continue;
    const target = eventsById.get(metadata.payload.evidence.targetEventId);
    if (target?.eventType !== "symbol.changed") continue;
    const coverage: AnalysisCoverage = metadata.payload.evidence.coverage.status === "sufficient"
      ? { status: "sufficient", reason: "supported" }
      : { status: "degraded", reason: "opaque_source" };
    const sourceFacts: SourceFacts = {
      resource: target.payload.resource,
      version: target.payload.afterVersion,
      symbols: [],
      imports: [],
      coverage,
      sourceEventIds: metadata.payload.evidence.sourceEventIds,
      analyzer: metadata.payload.evidence.analyzer,
      configuration: metadata.payload.evidence.configuration,
      integrationTarget: metadata.payload.evidence.integrationTarget,
    };
    facts.push({
      resource: target.payload.resource,
      version: target.payload.afterVersion,
      exported: true,
      signature: metadata.payload.evidence.normalizedSignature,
      coverageId: metadata.payload.evidence.coverageId,
      sourceFacts,
    });
  }
  return facts.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/**
 * A target-bound source proof can be reused by a linked worktree only when it
 * proves the same logical resource content. Workspace/worktree IDs describe
 * the capture location, not the immutable source hash being replaced.
 */
function sameHashBoundSourceVersion(left: ResourceVersion, right: ResourceVersion): boolean {
  return left.resourceId === right.resourceId
    && left.domain.repositoryId === right.domain.repositoryId
    && left.kind === right.kind
    && left.value !== null
    && left.value === right.value;
}

/**
 * Materializes a symbol modification only when a persisted, target-bound source
 * analysis proves the exact file version being replaced. This is an explicit
 * version edge, never a replay/order inference.
 */
function priorSymbolVersions(
  events: readonly ProtocolEvent[],
  changed: FileChangedEvent,
  targetSnapshot: McpCallContext["targetSnapshot"],
  facts: DerivedEvidenceFacts,
): ReadonlyMap<import("@patchmesh/protocol").ResourceId, ResourceVersion> {
  if (targetSnapshot === undefined || changed.payload.beforeVersion === null) return new Map();
  const byId = new Map(events.map((event) => [event.eventId, event] as const));
  const expectedConfigurationDigest = configurationDigest(facts.source.configuration);
  const expectedSymbols = new Set(facts.symbols.map((fact) => fact.resource.resourceId));
  const candidates = new Map<import("@patchmesh/protocol").ResourceId, ResourceVersion[]>();
  for (const evidence of events) {
    if (evidence.eventType !== "evidence.derived" || evidence.schemaVersion !== 3
      || evidence.payload.evidence.factKind !== "symbol"
      || evidence.payload.evidence.proof.kind !== "hash_bound_symbol_contract"
      || evidence.payload.evidence.analyzer.analyzerId !== facts.source.analyzer.analyzerId
      || evidence.payload.evidence.analyzer.version !== facts.source.analyzer.version
      || evidence.payload.evidence.configurationDigest !== expectedConfigurationDigest
      || evidence.payload.evidence.targetSnapshot.targetSnapshotId !== targetSnapshot.targetSnapshotId
      || evidence.payload.evidence.targetSnapshot.digest !== targetSnapshot.digest) continue;
    const source = evidence.payload.evidence.proof.sourceAnalysis;
    if (source.sourceResourceId !== changed.payload.resource.resourceId
      || !sameHashBoundSourceVersion(source.sourceVersion, changed.payload.beforeVersion)) continue;
    const symbol = byId.get(evidence.payload.evidence.targetEventId);
    if (symbol?.eventType !== "symbol.changed"
      || !expectedSymbols.has(symbol.payload.resource.resourceId)
      || symbol.payload.afterVersion.resourceId !== symbol.payload.resource.resourceId
      || symbol.payload.afterVersion.domain.repositoryId !== facts.source.version.domain.repositoryId) continue;
    candidates.set(symbol.payload.resource.resourceId, [
      ...(candidates.get(symbol.payload.resource.resourceId) ?? []),
      symbol.payload.afterVersion,
    ]);
  }
  return new Map([...candidates].flatMap(([resourceId, versions]) => {
    return versions.length === 1 ? [[resourceId, versions[0]!] as const] : [];
  }));
}

function createDependentWriteEvent(
  call: McpToolCall,
  context: McpCallContext,
  changedEvent: FileChangedEvent,
  coverageId: CoverageId,
  eventId: EventId,
  timestamp: string,
  completionEventId: EventId,
): DependentWriteEvent | null {
  const dependentWrite = call.dependentWrite;
  if (dependentWrite === undefined || context.taskId === null) return null;
  if (context.targetSnapshot !== undefined && context.agentId !== null && dependentWrite.readToken !== undefined && dependentWrite.comparison !== undefined) {
    return {
      schemaVersion: 3,
      eventId,
      eventType: "write.dependent",
      source: context.source,
      timestamp,
      repositoryId: context.repositoryId,
      workspaceId: context.workspaceId,
      worktreeId: context.worktreeId,
      agentId: context.agentId,
      taskId: context.taskId,
      correlationId: context.correlationId,
      causationId: changedEvent.eventId,
      sourceSequence: null,
      payload: {
        write: {
          dependencyId: dependentWrite.dependencyId,
          resourceId: dependentWrite.resourceId,
          dependsOnReadEventId: dependentWrite.dependsOnReadEventId,
          coverageId,
          comparison: dependentWrite.comparison,
          readToken: dependentWrite.readToken,
          targetSnapshot: context.targetSnapshot,
          writeEffectEventId: changedEvent.eventId,
          writeEffectCoverageId: coverageId,
          completionEventId,
        },
      },
    };
  }
  return {
    schemaVersion: 2,
    eventId,
    eventType: "write.dependent",
    source: context.source,
    timestamp,
    repositoryId: context.repositoryId,
    workspaceId: context.workspaceId,
    worktreeId: context.worktreeId,
    agentId: context.agentId,
    taskId: context.taskId,
    correlationId: context.correlationId,
    causationId: changedEvent.eventId,
    sourceSequence: null,
    payload: {
      write: {
        dependencyId: dependentWrite.dependencyId,
        resourceId: dependentWrite.resourceId,
        dependsOnReadEventId: dependentWrite.dependsOnReadEventId,
        coverageId,
      },
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class McpProxy {
  private readonly eventStore: EventAppender;
  private readonly createEventId: () => EventId;
  private readonly now: () => string;
  private readonly observer: McpProxyOptions["observer"];
  private readonly createCorrelationId: () => ProtocolEvent["correlationId"];
  private readonly phase2SourceAnalysis: McpProxyOptions["phase2SourceAnalysis"];
  private readonly proofAuthority: NonNullable<McpProxyOptions["proofAuthority"]>;

  constructor(options: McpProxyOptions) {
    this.eventStore = options.eventStore;
    this.createEventId = options.createEventId ?? (() => `evt_${randomHexId()}` as EventId);
    this.now = options.now ?? (() => new Date().toISOString());
    this.observer = options.observer;
    this.createCorrelationId = options.createCorrelationId ?? (() => `corr_${randomHexId()}`);
    this.phase2SourceAnalysis = options.phase2SourceAnalysis;
    this.proofAuthority = options.proofAuthority ?? {
      authoritativeIdentity: false, taskLifecycle: false, integrationTargetSnapshot: false,
      observedReadVersion: false, dependentWriteToken: false, exactReportedEffects: false,
    };
  }

  /** Releases observer-owned watcher sessions when the host shuts this proxy down. */
  async dispose(): Promise<void> {
    if (isIncrementalObserver(this.observer)) await this.observer.dispose?.();
  }

  private async deriveChangedSourceEvents(
    event: FileChangedEvent,
    workspaceRoot: string | undefined,
    targetSnapshot: McpCallContext["targetSnapshot"],
  ): Promise<DerivedSourceAnalysis | string | null> {
    const options = this.phase2SourceAnalysis;
    if (options === undefined) return null;
    if (workspaceRoot === undefined) return "workspace root was not supplied for source analysis";
    if (event.payload.afterVersion.value === null) return "deleted resources cannot be source-analyzed";
    const root = resolve(workspaceRoot);
    const filePath = resolve(root, event.payload.resource.locator);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return "observed resource is outside the workspace root";
    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch {
      return "changed source could not be read";
    }
    if (contentHash(content) !== event.payload.afterVersion.value) {
      return "changed source no longer matches observed version";
    }
    const extension = extname(filePath).toLowerCase();
    const language: SourceAnalysisInput["language"] = extension === ".ts" || extension === ".tsx"
      ? "typescript"
      : extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs"
        ? "javascript"
        : "unsupported";
    const facts = deriveEvidenceFacts({
      resource: event.payload.resource,
      version: event.payload.afterVersion,
      content: content.toString("utf8"),
      language,
      sourceEventIds: [event.eventId],
      analyzer: options.analyzer,
      configuration: options.configuration,
      // V3 dependency resolution must share the immutable target binding used
      // by persisted contract facts; legacy contexts keep their supplied name.
      integrationTarget: targetSnapshot?.integrationTargetId ?? options.integrationTarget,
    });
    if (facts.source.coverage.status === "degraded") return facts.source.coverage.reason;
    const symbolContext: SymbolEventContext = {
      repositoryId: event.repositoryId,
      workspaceId: event.workspaceId,
      worktreeId: event.worktreeId,
      agentId: event.agentId,
      taskId: event.taskId,
      correlationId: event.correlationId,
      source: options.source,
      timestamp: this.now(),
      sourceSequenceStart: null,
    };
    const priorVersions = priorSymbolVersions(this.eventStore.read?.() ?? [], event, targetSnapshot, facts);
    const symbolEvents = deriveSymbolChangedEvents(
      facts,
      facts.symbols.map(() => this.createEventId()),
      symbolContext,
    ).map((symbolEvent) => {
      const beforeVersion = priorVersions.get(symbolEvent.payload.resource.resourceId);
      return beforeVersion === undefined ? symbolEvent : {
        ...symbolEvent,
        // The predecessor is hash-bound across worktrees; materialize that
        // signature in this current symbol event's version domain.
        payload: {
          ...symbolEvent.payload,
          beforeVersion: {
            ...symbolEvent.payload.afterVersion,
            value: beforeVersion.value,
            evidenceEventIds: beforeVersion.evidenceEventIds,
          },
          changeKind: "modified" as const,
        },
      };
    });
     try {
       for (const [index, symbolEvent] of symbolEvents.entries()) {
         appendValidated(symbolEvent, this.eventStore);
         const fact = facts.symbols[index];
         if (fact === undefined) return "derived symbol fact is missing its event";
         const evidence = createDerivedEvidenceEvent(
           symbolEvent,
           this.createEventId(),
           facts.source,
           "symbol",
           fact.resource.resourceId,
            fact.sourceFacts.sourceEventIds,
            fact.exported,
            fact.coverageId,
           fact.signature,
           targetSnapshot,
           event.payload.afterVersion,
         );
         if (evidence.schemaVersion === 3) appendProofValidated(evidence, this.eventStore);
         else appendValidated(evidence, this.eventStore);
       }
    } catch {
      return "derived symbol event persistence failed";
    }
    return { facts, context: symbolContext, symbolEventIds: symbolEvents.map((symbolEvent) => symbolEvent.eventId), targetSnapshot };
  }

  private persistResolvedDependencies(
    analyses: readonly DerivedSourceAnalysis[],
    observedRead: McpToolCall["observedRead"],
  ): string | null {
    const observedVersions = observedRead === undefined
      ? []
      : [{
          resourceId: observedRead.resource.resourceId,
          kind: observedRead.version.kind,
          value: observedRead.version.value,
        }];
    const dependencies = resolveLocalContractDependencies(
      analyses.map((analysis) => analysis.facts),
      this.eventStore.read === undefined ? [] : persistedContractFacts(this.eventStore.read()),
      observedVersions,
    );
    try {
      for (const dependency of dependencies) {
        const sourceEventId = dependency.consumer.sourceFacts.sourceEventIds[0];
        const analysis = analyses.find((candidate) => candidate.facts.source.sourceEventIds[0] === sourceEventId);
        if (analysis === undefined) return "resolved dependency is missing its consumer source context";
         const event = deriveDependencyChangedEvents([dependency], [this.createEventId()], analysis.context)[0];
        if (event === undefined) return "resolver did not produce a dependency event";
        appendValidated(event, this.eventStore);
        const evidence = createDerivedEvidenceEvent(
          event,
          this.createEventId(),
          dependency.consumer.sourceFacts,
          "dependency",
          event.payload.dependency.dependencyId,
          // The proof's hash-bound analysis input is the consumer source.
          // The dependency event retains both consumer and contract evidence.
          dependency.consumer.sourceFacts.sourceEventIds,
           false,
           dependency.consumer.coverageId,
          dependency.contract.signature,
          analysis.targetSnapshot,
          analysis.facts.source.version,
          dependency.contract.resource.resourceId,
        );
        if (evidence.schemaVersion === 3) appendProofValidated(evidence, this.eventStore);
        else appendValidated(evidence, this.eventStore);
      }
    } catch {
      return "derived dependency event persistence failed";
    }
    return null;
  }

  async execute<T>(
    call: McpToolCall,
    context: McpCallContext,
    executor: ToolExecutor<T>,
    signal?: AbortSignal,
  ): Promise<McpProxyResult<T>> {
    let requestEvent: ToolRequestedEvent;
    try {
      requestEvent = asToolRequested(appendValidated(
        createToolRequestedEvent(call, context, this.createEventId(), this.now()),
        this.eventStore,
      ));
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw error;
      throw new McpProxyStorageError(
        "MCP_REQUEST_PERSIST_FAILED",
        "request",
        null,
        null,
        { cause: error },
      );
    }

    const executionSignal = signal ?? new AbortController().signal;
    const observationGaps: ObservationGap[] = [];
    const readEventIds: EventId[] = [];
    const observedReadTokens: ObservedReadToken[] = [];
    const readEvent = call.observedRead === undefined
      ? null
      : createFileReadEvent(call, context, requestEvent.eventId, this.createEventId(), this.now());
    if (readEvent !== null) {
      try {
        appendValidated(readEvent, this.eventStore);
        readEventIds.push(readEvent.eventId);
      } catch {
        observationGaps.push({
          kind: "unverified",
          scope: readEvent.payload.resource.locator,
          reason: "explicit read metadata could not be persisted",
        });
      }
    }
    let beforeCapture: ObservationCapture | null = null;
    let observationWindow: ObservationWindow | null = null;
    if (this.observer) {
      if (context.workspaceRoot === undefined) {
        observationGaps.push({
          kind: "unverified",
          scope: "workspace",
          reason: "workspace root was not supplied for observation",
        });
      } else {
        const observationContext: ObservationContext = {
          workspaceRoot: context.workspaceRoot,
          repositoryId: context.repositoryId,
          workspaceId: context.workspaceId,
          worktreeId: context.worktreeId,
        };
        try {
          if (isIncrementalObserver(this.observer)) {
            observationWindow = await this.observer.beginWindow(observationContext);
            beforeCapture = observationWindow.before;
          } else {
            beforeCapture = await this.observer.captureBefore(observationContext);
          }
          observationGaps.push(...beforeCapture.gaps);
        } catch {
          observationGaps.push({
            kind: "unverified",
            scope: "before",
            reason: "pre-execution observation failed",
          });
        }
      }
    }

    let execution: ToolExecutionResult<T>;
    try {
      execution = await executor(executionSignal);
    } catch (error) {
      execution = executionSignal.aborted || isAbortError(error)
        ? { outcome: "interrupted", exitCode: null }
        : { outcome: "failed", error, exitCode: null };
    }
    if (execution.outcome === "succeeded" && readEvent !== null) {
      const readToken = issueObservedReadToken(context, readEvent,
        this.proofAuthority.authoritativeIdentity && this.proofAuthority.taskLifecycle
        && this.proofAuthority.integrationTargetSnapshot && this.proofAuthority.observedReadVersion);
      if (readToken !== null) observedReadTokens.push(readToken);
    }

    let afterCapture: ObservationCapture | null = null;
    if (this.observer && context.workspaceRoot !== undefined) {
      const observationContext: ObservationContext = {
        workspaceRoot: context.workspaceRoot,
        repositoryId: context.repositoryId,
        workspaceId: context.workspaceId,
        worktreeId: context.worktreeId,
      };
      try {
        if (observationWindow !== null && isIncrementalObserver(this.observer)) {
          const result = await this.observer.endWindow(observationWindow);
          afterCapture = result.capture;
          if (result.completeness === "degraded") {
            observationGaps.push({ kind: "unverified", scope: "observation.window", reason: "incremental observation window requires reconciliation" });
          }
        } else {
          afterCapture = await this.observer.captureAfter(observationContext);
        }
        observationGaps.push(...afterCapture.gaps);
      } catch {
        observationGaps.push({
          kind: "unverified",
          scope: "after",
          reason: "post-execution observation failed",
        });
      }
    }

    const effectEventIds: EventId[] = [];
    const outOfBandEventIds: EventId[] = [];
    const analysisDiagnostics: Array<{ readonly path: string; readonly reason: string }> = [];
    const sourceAnalyses: DerivedSourceAnalysis[] = [];
    const interceptedChanges: FileChangedEvent[] = [];
    if (this.observer) {
      if (beforeCapture !== null && afterCapture !== null) {
        const diff = diffSnapshots(beforeCapture.snapshot, afterCapture.snapshot, call.opaque);
        observationGaps.push(...diff.gaps);
        for (const change of diff.changes) {
          const eventId = this.createEventId();
          try {
            const persisted = appendValidated(
              createFileChangedEvent(
                change,
                context,
                this.observer.source,
                requestEvent.eventId,
                context.correlationId,
                context.agentId,
                context.taskId,
                eventId,
                this.now(),
              ),
              this.eventStore,
            );
            effectEventIds.push(eventId);
            const changedEvent = persisted as FileChangedEvent;
            interceptedChanges.push(changedEvent);
            const analysis = await this.deriveChangedSourceEvents(changedEvent, context.workspaceRoot,
              this.proofAuthority.authoritativeIdentity && this.proofAuthority.taskLifecycle && this.proofAuthority.integrationTargetSnapshot ? context.targetSnapshot : undefined);
            if (typeof analysis === "string") {
              analysisDiagnostics.push({ path: change.path, reason: analysis });
              observationGaps.push({ kind: "unverified", scope: `source:${change.path}`, reason: analysis });
            } else if (analysis !== null) {
              sourceAnalyses.push(analysis);
              effectEventIds.push(...analysis.symbolEventIds);
            }
          } catch {
            observationGaps.push({
              kind: "unverified",
              scope: change.path,
              reason: "effect event persistence failed",
            });
          }
        }
      } else if (context.workspaceRoot !== undefined) {
        observationGaps.push({
          kind: "unverified",
          scope: "tool.effects",
          reason: "effect comparison requires both observation boundaries",
        });
      }

      const outOfBandChanges = [
        ...(beforeCapture?.outOfBandChanges ?? []),
        ...(afterCapture?.outOfBandChanges ?? []),
      ];
      for (const change of outOfBandChanges) {
        observationGaps.push({
          kind: "unattributed",
          scope: change.path,
          reason: "effect was observed outside the intercepted MCP call",
        });
        const eventId = this.createEventId();
        try {
            const persisted = appendValidated(
              createFileChangedEvent(
              change,
              context,
              this.observer.source,
              null,
              this.createCorrelationId(),
              null,
              null,
              eventId,
              this.now(),
            ),
              this.eventStore,
            );
            outOfBandEventIds.push(eventId);
            const analysis = await this.deriveChangedSourceEvents(persisted as FileChangedEvent, context.workspaceRoot,
              this.proofAuthority.authoritativeIdentity && this.proofAuthority.taskLifecycle && this.proofAuthority.integrationTargetSnapshot ? context.targetSnapshot : undefined);
            if (typeof analysis === "string") {
              analysisDiagnostics.push({ path: change.path, reason: analysis });
              observationGaps.push({ kind: "unverified", scope: `source:${change.path}`, reason: analysis });
            } else if (analysis !== null) {
              sourceAnalyses.push(analysis);
            }
        } catch {
          observationGaps.push({
            kind: "unverified",
            scope: change.path,
            reason: "out-of-band effect persistence failed",
          });
        }
      }
    }

    const dependencyReason = this.persistResolvedDependencies(sourceAnalyses, call.observedRead);
    if (dependencyReason !== null) {
      analysisDiagnostics.push({ path: "dependencies", reason: dependencyReason });
      observationGaps.push({ kind: "unverified", scope: "source:dependencies", reason: dependencyReason });
    }

    const dependentWriteChange = call.dependentWrite === undefined
      ? null
      : interceptedChanges.find((event) => event.payload.resource.resourceId === call.dependentWrite?.resourceId) ?? null;
    const hasDependentWriteDependency = call.dependentWrite !== undefined
      && this.eventStore.read?.().some((event) => event.eventType === "dependency.changed"
        && event.payload.dependency.dependencyId === call.dependentWrite?.dependencyId
        && event.payload.dependency.dependentResourceId === call.dependentWrite?.resourceId) === true;
    if (call.dependentWrite !== undefined && dependentWriteChange === null) {
      observationGaps.push({
        kind: "unverified",
        scope: "write.dependent",
        reason: "dependent write metadata did not match an intercepted changed resource",
      });
    }
    if (call.dependentWrite !== undefined && context.taskId === null) {
      observationGaps.push({
        kind: "unverified",
        scope: "write.dependent",
        reason: "dependent write metadata requires task attribution",
      });
    }
    if (call.dependentWrite !== undefined && !hasDependentWriteDependency) {
      observationGaps.push({
        kind: "unverified",
        scope: "write.dependent",
        reason: "dependent write metadata did not reference a durable matching dependency",
      });
    }

    const attributedEffectIds = deterministicallyAttributedEffectEventIds(
      call,
      execution,
      interceptedChanges,
      observationGaps,
      outOfBandEventIds,
    );
    const resolvedObservationGaps = attributedEffectIds.length === 0
      ? observationGaps
      : observationGaps.filter((gap) => !isSnapshotOriginGap(gap));

    let completedEvent: ProtocolEvent;
    try {
      completedEvent = appendValidated(
        createToolCompletedEvent(
          context,
          requestEvent.eventId,
          this.createEventId(),
          this.now(),
          execution.outcome,
          execution.exitCode,
          effectEventIds,
          attributedEffectIds,
        ),
        this.eventStore,
      );
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw error;
      throw new McpProxyStorageError(
        "MCP_COMPLETION_PERSIST_FAILED",
        "completion",
        requestEvent.eventId,
        execution.outcome,
        { cause: error },
      );
    }

    const evidenceEventIds = [
      requestEvent.eventId,
      ...readEventIds,
      ...effectEventIds,
      ...outOfBandEventIds,
      completedEvent.eventId,
    ];
    const coverage = this.observer === undefined
      ? null
      : deriveCoverage({
          scope: `tool:${requestEvent.eventId}`,
          modes: beforeCapture !== null && afterCapture !== null
            ? ["intercepted", "verified"]
            : ["intercepted", "unknown"],
          gaps: resolvedObservationGaps,
          evidenceEventIds,
        });

    const persistedEvents = this.eventStore.read?.() ?? [];
    const presentedToken = call.dependentWrite?.readToken;
    const tokenRead = presentedToken === undefined ? undefined : persistedEvents.find((event) => event.eventId === presentedToken.readEventId);
    const expectedTokenDigest = presentedToken === undefined ? null : `sha256:${createHash("sha256").update(canonicalJson({
      schemaVersion: presentedToken.schemaVersion, repositoryId: presentedToken.repositoryId,
      workspaceId: presentedToken.workspaceId, worktreeId: presentedToken.worktreeId, taskId: presentedToken.taskId,
      resourceId: presentedToken.resourceId, observedVersion: presentedToken.observedVersion,
      readEventId: presentedToken.readEventId, targetSnapshot: presentedToken.targetSnapshot,
    })).digest("hex")}`;
    const proofTokenMatches = presentedToken !== undefined
      && observedReadTokens.length === 0
      && presentedToken.tokenDigest === expectedTokenDigest
      && presentedToken.repositoryId === context.repositoryId && presentedToken.workspaceId === context.workspaceId
      && presentedToken.worktreeId === context.worktreeId && presentedToken.taskId === context.taskId
      && presentedToken.readEventId === call.dependentWrite?.dependsOnReadEventId
      && canonicalJson(presentedToken.targetSnapshot) === canonicalJson(context.targetSnapshot)
      && (tokenRead?.eventType === "file.read" || tokenRead?.eventType === "symbol.read")
      && tokenRead.payload.resource.resourceId === presentedToken.resourceId
      && canonicalJson(tokenRead.payload.version) === canonicalJson(presentedToken.observedVersion);
    const candidate = call.dependentWrite?.comparison === undefined ? undefined
      : persistedEvents.find((event) => event.eventId === call.dependentWrite?.comparison?.changedEventId);
    const candidateCoverageId = candidate === undefined ? null : sufficientPersistedCoverageId(persistedEvents, candidate.eventId);
    const writeEffectCoverageId = dependentWriteChange === null ? null : sufficientPersistedCoverageId(persistedEvents, dependentWriteChange.eventId);
    const proofCandidateMatches = call.dependentWrite?.comparison !== undefined
      && (candidate?.eventType === "file.changed" || candidate?.eventType === "symbol.changed")
      && candidate.payload.resource.resourceId === call.dependentWrite?.readToken?.resourceId
      && candidateCoverageId !== null
      && candidateCoverageId === call.dependentWrite.comparison.coverageId;
    const proofAuthorityAvailable = this.proofAuthority.authoritativeIdentity && this.proofAuthority.taskLifecycle
      && this.proofAuthority.integrationTargetSnapshot && this.proofAuthority.observedReadVersion && this.proofAuthority.dependentWriteToken && this.proofAuthority.exactReportedEffects;
    const useProofPath = context.targetSnapshot !== undefined && presentedToken !== undefined;
    if (useProofPath && (!proofTokenMatches || !proofCandidateMatches || writeEffectCoverageId === null || coverage?.presentation !== "sufficient" || execution.outcome !== "succeeded")) {
      observationGaps.push({
        kind: "unverified",
        scope: "write.dependent",
        reason: "proof-bearing dependent write lacks a matching token, candidate, succeeded completion, or sufficient coverage",
      });
    }

    const completionLinkedAttributed = completedEvent.eventType === "tool.completed"
      && completedEvent.payload.deterministicallyAttributedEffectEventIds?.includes(dependentWriteChange?.eventId as EventId) === true;
    if (coverage !== null && dependentWriteChange !== null && hasDependentWriteDependency
      && (!useProofPath || (proofAuthorityAvailable && proofTokenMatches && proofCandidateMatches && writeEffectCoverageId !== null && completionLinkedAttributed && coverage.presentation === "sufficient" && execution.outcome === "succeeded"))) {
      const dependentWriteEvent = createDependentWriteEvent(
        call,
        context,
        dependentWriteChange,
        useProofPath ? writeEffectCoverageId! : coverage.coverageId,
        this.createEventId(),
        this.now(),
        completedEvent.eventId,
      );
      if (dependentWriteEvent !== null) {
        try {
          if (dependentWriteEvent.schemaVersion === 3) appendProofValidated(dependentWriteEvent, this.eventStore);
          else appendValidated(dependentWriteEvent, this.eventStore);
        } catch (error) {
          if (error instanceof ProtocolValidationError) throw error;
          throw new McpProxyStorageError(
            "MCP_DEPENDENT_WRITE_PERSIST_FAILED",
            "dependent-write",
            requestEvent.eventId,
            execution.outcome,
            { cause: error },
          );
        }
      }
    }

    return {
      execution,
      requestEventId: requestEvent.eventId,
      completedEventId: completedEvent.eventId,
      readEventIds,
      observedReadTokens,
      coverage,
      observationDiagnostics: resolvedObservationGaps,
      analysisDiagnostics,
    };
  }
}
