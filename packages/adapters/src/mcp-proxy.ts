import { randomUUID } from "node:crypto";
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
  type CoverageId,
  type DependentWriteEvent,
  type EventId,
  type FileChangedEvent,
  type DerivedEvidenceEvent,
  type FileReadEvent,
  type LogicalResource,
  type ProtocolEvent,
  type ResourceVersion,
  type ToolCompletedEvent,
  type ToolRequestedEvent,
} from "@patchmesh/protocol";
import {
  deriveCoverage,
  diffSnapshots,
  fileResourceId,
  normalizeLogicalPath,
  sanitizeDiagnostic,
  type ObservationCapture,
  type ObservationContext,
  type ObservationGap,
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
}

function appendValidated(event: ProtocolEvent, eventStore: EventAppender): ProtocolEvent {
  const parsed = parseEvent(event);
  if (parsed.value === null) throw new ProtocolValidationError(parsed.diagnostics);
  return eventStore.append(parsed.value).event;
}

function randomHexId(): string {
  return randomUUID().replaceAll("-", "");
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
): DerivedEvidenceEvent {
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

function createDependentWriteEvent(
  call: McpToolCall,
  context: McpCallContext,
  changedEvent: FileChangedEvent,
  coverageId: CoverageId,
  eventId: EventId,
  timestamp: string,
): DependentWriteEvent | null {
  const dependentWrite = call.dependentWrite;
  if (dependentWrite === undefined || context.taskId === null) return null;
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

  constructor(options: McpProxyOptions) {
    this.eventStore = options.eventStore;
    this.createEventId = options.createEventId ?? (() => `evt_${randomHexId()}` as EventId);
    this.now = options.now ?? (() => new Date().toISOString());
    this.observer = options.observer;
    this.createCorrelationId = options.createCorrelationId ?? (() => `corr_${randomHexId()}`);
    this.phase2SourceAnalysis = options.phase2SourceAnalysis;
  }

  private async deriveChangedSourceEvents(
    event: FileChangedEvent,
    workspaceRoot: string | undefined,
  ): Promise<DerivedSourceAnalysis | string | null> {
    const options = this.phase2SourceAnalysis;
    if (options === undefined) return null;
    if (workspaceRoot === undefined) return "workspace root was not supplied for source analysis";
    if (event.payload.afterVersion.value === null) return "deleted resources cannot be source-analyzed";
    const root = resolve(workspaceRoot);
    const filePath = resolve(root, event.payload.resource.locator);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return "observed resource is outside the workspace root";
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return "changed source could not be read";
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
      content,
      language,
      sourceEventIds: [event.eventId],
      analyzer: options.analyzer,
      configuration: options.configuration,
      integrationTarget: options.integrationTarget,
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
    const symbolEvents = deriveSymbolChangedEvents(
      facts,
      facts.symbols.map(() => this.createEventId()),
      symbolContext,
    );
     try {
       for (const [index, symbolEvent] of symbolEvents.entries()) {
         appendValidated(symbolEvent, this.eventStore);
         const fact = facts.symbols[index];
         if (fact === undefined) return "derived symbol fact is missing its event";
         appendValidated(createDerivedEvidenceEvent(
           symbolEvent,
           this.createEventId(),
           facts.source,
           "symbol",
           fact.resource.resourceId,
            fact.sourceFacts.sourceEventIds,
            fact.exported,
            fact.coverageId,
            fact.signature,
         ), this.eventStore);
       }
    } catch {
      return "derived symbol event persistence failed";
    }
    return { facts, context: symbolContext, symbolEventIds: symbolEvents.map((symbolEvent) => symbolEvent.eventId) };
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
        appendValidated(createDerivedEvidenceEvent(
          event,
          this.createEventId(),
          dependency.consumer.sourceFacts,
          "dependency",
          event.payload.dependency.dependencyId,
           event.payload.dependency.evidenceEventIds,
           false,
           dependency.consumer.coverageId,
           dependency.contract.signature,
        ), this.eventStore);
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
          beforeCapture = await this.observer.captureBefore(observationContext);
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

    let afterCapture: ObservationCapture | null = null;
    if (this.observer && context.workspaceRoot !== undefined) {
      const observationContext: ObservationContext = {
        workspaceRoot: context.workspaceRoot,
        repositoryId: context.repositoryId,
        workspaceId: context.workspaceId,
        worktreeId: context.worktreeId,
      };
      try {
        afterCapture = await this.observer.captureAfter(observationContext);
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
            const analysis = await this.deriveChangedSourceEvents(changedEvent, context.workspaceRoot);
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
            const analysis = await this.deriveChangedSourceEvents(persisted as FileChangedEvent, context.workspaceRoot);
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

    if (coverage !== null && dependentWriteChange !== null && hasDependentWriteDependency) {
      const dependentWriteEvent = createDependentWriteEvent(
        call,
        context,
        dependentWriteChange,
        coverage.coverageId,
        this.createEventId(),
        this.now(),
      );
      if (dependentWriteEvent !== null) {
        try {
          appendValidated(dependentWriteEvent, this.eventStore);
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
      coverage,
      observationDiagnostics: resolvedObservationGaps,
      analysisDiagnostics,
    };
  }
}
