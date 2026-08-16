import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { default as addFormats } from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import type {
  AttributionCorrectedEvent,
  DecisionCreatedEvent,
  DependentWriteEvent,
  DependencyChangedEvent,
  DerivedEvidenceEvent,
  FindingFeedbackCreatedEvent,
  ProtocolEvent,
  ToolCompletedEvent,
  TaskConcurrencyObservedEvent,
} from "./events.js";
import type { EventId, Source } from "./identities.js";
import {
  type ValidationDiagnostic,
  type ValidationResult,
} from "./diagnostics.js";

const phase0SchemaNames = [
  "identities",
  "event-payloads",
  "event-envelope",
  "dependency",
  "coverage",
  "finding",
  "decision",
  "task-validity",
] as const;

const phase0SchemaDirectory = new URL("../../../schemas/phase0/v1/", import.meta.url);
const phase2SchemaDirectory = new URL("../../../schemas/phase2/v1/", import.meta.url);
const phase3SchemaDirectory = new URL("../../../schemas/phase2/v2/", import.meta.url);

function readSchema(directory: URL, name: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`${name}.schema.json`, directory));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function createValidators(): { readonly phase0: ValidateFunction; readonly phase2: ValidateFunction; readonly phase3: ValidateFunction } {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const registerFormats = addFormats as unknown as (instance: Ajv2020) => Ajv2020;
  registerFormats(ajv);
  for (const name of phase0SchemaNames) ajv.addSchema(readSchema(phase0SchemaDirectory, name));
  ajv.addSchema(readSchema(phase2SchemaDirectory, "finding-feedback"));
  ajv.addSchema(readSchema(phase2SchemaDirectory, "dependent-write"));
  ajv.addSchema(readSchema(phase2SchemaDirectory, "derived-evidence"));
  ajv.addSchema(readSchema(phase2SchemaDirectory, "task-concurrency-observed"));
  ajv.addSchema(readSchema(phase2SchemaDirectory, "event-envelope"));
  ajv.addSchema(readSchema(phase3SchemaDirectory, "dependent-write"));
  ajv.addSchema(readSchema(phase3SchemaDirectory, "derived-evidence"));
  ajv.addSchema(readSchema(phase3SchemaDirectory, "task-concurrency-observed"));
  ajv.addSchema(readSchema(phase3SchemaDirectory, "event-envelope"));
  const phase0 = ajv.getSchema("https://patchmesh.dev/schemas/phase0/v1/event-envelope.schema.json");
  const phase2 = ajv.getSchema("https://patchmesh.dev/schemas/phase2/v1/event-envelope.schema.json");
  const phase3 = ajv.getSchema("https://patchmesh.dev/schemas/phase2/v2/event-envelope.schema.json");
  if (!phase0 || !phase2 || !phase3) throw new Error("event envelope schema was not registered");
  return { phase0, phase2, phase3 };
}

const validators = createValidators();

function diagnostic(code: string, path: string, message: string): ValidationDiagnostic {
  return { code, path, message };
}

function ajvDiagnostic(error: ErrorObject): ValidationDiagnostic {
  const path = error.keyword === "required"
    ? `${error.instancePath}/${String(error.params.missingProperty)}`
    : error.instancePath || "/";
  return diagnostic("PHASE0_SCHEMA_INVALID", path, `schema validation failed (${error.keyword})`);
}

function sortDiagnostics(diagnostics: readonly ValidationDiagnostic[]): readonly ValidationDiagnostic[] {
  return [...diagnostics].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseEvent(input: unknown): ValidationResult<ProtocolEvent> {
  if (!isRecord(input)) {
    return { value: null, diagnostics: [diagnostic("PHASE0_SCHEMA_INVALID", "/", "event must be an object")] };
  }
  if (Object.hasOwn(input, "schemaVersion") && input.schemaVersion !== 1 && input.schemaVersion !== 2 && input.schemaVersion !== 3) {
    return { value: null, diagnostics: [diagnostic("PHASE0_SCHEMA_UNSUPPORTED", "/schemaVersion", "schema version is unsupported")] };
  }
  const validateEnvelope = input.schemaVersion === 3 ? validators.phase3 : input.schemaVersion === 2 ? validators.phase2 : validators.phase0;
  if (!validateEnvelope(input)) {
    return { value: null, diagnostics: sortDiagnostics((validateEnvelope.errors ?? []).map(ajvDiagnostic)) };
  }
  return { value: cloneAndFreeze(input as unknown as ProtocolEvent), diagnostics: [] };
}

function producerKey(source: Source): string {
  return `${source.kind}:${source.sourceId}:${source.instanceId}`;
}

function sameDomain(left: ProtocolEvent, right: ProtocolEvent): boolean {
  return left.repositoryId === right.repositoryId &&
    left.workspaceId === right.workspaceId &&
    left.worktreeId === right.worktreeId;
}

function sameRepositoryWorkspace(left: ProtocolEvent, right: ProtocolEvent): boolean {
  return left.repositoryId === right.repositoryId && left.workspaceId === right.workspaceId;
}

function configurationDigest(configuration: Readonly<Record<string, string | number | boolean>>): string {
  const canonical = JSON.stringify(Object.fromEntries(
    Object.entries(configuration).sort(([left], [right]) => left.localeCompare(right)),
  ));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function sameVersionDomain(event: ProtocolEvent, version: { domain: { repositoryId: string; workspaceId: string; worktreeId: string } }): boolean {
  return event.repositoryId === version.domain.repositoryId &&
    event.workspaceId === version.domain.workspaceId &&
    event.worktreeId === version.domain.worktreeId;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function validateTargetSnapshot(snapshot: {
  targetSnapshotId: string; integrationTargetId: string; repositoryId: string; kind: string; locator: string; baseCommit: string; candidateIds: readonly string[]; digest: string;
}, repositoryId: string, path: string, diagnostics: ValidationDiagnostic[]): void {
  const digest = createHash("sha256").update(canonicalJson({
    integrationTargetId: snapshot.integrationTargetId, repositoryId: snapshot.repositoryId,
    kind: snapshot.kind, locator: snapshot.locator, baseCommit: snapshot.baseCommit, candidateIds: snapshot.candidateIds,
  })).digest("hex");
  if (snapshot.repositoryId !== repositoryId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/repositoryId`, "target snapshot crosses event repository"));
  if (snapshot.digest !== digest || snapshot.targetSnapshotId !== `snapshot_${digest}`) {
    diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/digest`, "target snapshot digest is invalid"));
  }
}

function validateProofDependentWrite(event: DependentWriteEvent, eventsById: ReadonlyMap<EventId, ProtocolEvent>, diagnostics: ValidationDiagnostic[]): void {
  if (event.schemaVersion !== 3) return;
  const write = event.payload.write;
  const path = `/events/${event.eventId}/payload/write`;
  validateTargetSnapshot(write.targetSnapshot, event.repositoryId, `${path}/targetSnapshot`, diagnostics);
  const token = write.readToken;
  validateTargetSnapshot(token.targetSnapshot, event.repositoryId, `${path}/readToken/targetSnapshot`, diagnostics);
  const expectedToken = sha256({ schemaVersion: token.schemaVersion, repositoryId: token.repositoryId, workspaceId: token.workspaceId, worktreeId: token.worktreeId, taskId: token.taskId, resourceId: token.resourceId, observedVersion: token.observedVersion, readEventId: token.readEventId, targetSnapshot: token.targetSnapshot });
  if (token.tokenDigest !== expectedToken) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/readToken/tokenDigest`, "observed-read token digest is invalid"));
  if (token.readEventId !== write.dependsOnReadEventId || token.taskId !== event.taskId || token.repositoryId !== event.repositoryId || token.workspaceId !== event.workspaceId || token.worktreeId !== event.worktreeId || canonicalJson(token.targetSnapshot) !== canonicalJson(write.targetSnapshot)) {
    diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/readToken`, "observed-read token does not bind this dependent write"));
  }
  const read = eventsById.get(token.readEventId);
  if (read?.eventType === "file.read" || read?.eventType === "symbol.read") {
    if (token.resourceId !== read.payload.resource.resourceId || canonicalJson(token.observedVersion) !== canonicalJson(read.payload.version)) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/readToken`, "observed-read token does not match the persisted read"));
  }
  const effect = eventsById.get(write.writeEffectEventId);
  if (effect === undefined) diagnostics.push(diagnostic("PHASE3_REFERENCE_MISSING", `${path}/writeEffectEventId`, "dependent write effect event is absent"));
  else if (effect.eventType !== "file.changed" || effect.payload.resource.resourceId !== write.resourceId || !sameDomain(event, effect) || effect.taskId !== event.taskId || write.writeEffectCoverageId !== write.coverageId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/writeEffectEventId`, "dependent write effect must be a matching sufficiently covered file change"));
  const completion = eventsById.get(write.completionEventId);
  if (completion === undefined) diagnostics.push(diagnostic("PHASE3_REFERENCE_MISSING", `${path}/completionEventId`, "dependent write completion is absent"));
  else if (completion.eventType !== "tool.completed" || completion.payload.outcome !== "succeeded" || !completion.payload.deterministicallyAttributedEffectEventIds?.includes(write.writeEffectEventId) || !sameDomain(event, completion) || completion.taskId !== event.taskId || completion.correlationId !== event.correlationId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/completionEventId`, "dependent write requires a succeeded completion with a deterministically attributed persisted effect"));
  if (write.comparison.integrationTarget !== write.targetSnapshot.integrationTargetId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/comparison/integrationTarget`, "dependent write comparison target does not match its target snapshot"));
}

function validateProofConcurrency(event: TaskConcurrencyObservedEvent, eventsById: ReadonlyMap<EventId, ProtocolEvent>, diagnostics: ValidationDiagnostic[]): void {
  if (event.schemaVersion !== 3) return;
  const observation = event.payload.observation;
  const path = `/events/${event.eventId}/payload/observation`;
  validateTargetSnapshot(observation.targetSnapshot, event.repositoryId, `${path}/targetSnapshot`, diagnostics);
  const first = eventsById.get(observation.firstChangeEventId);
  const second = eventsById.get(observation.secondChangeEventId);
  if (observation.firstAgentId === observation.secondAgentId || observation.firstTaskId === observation.secondTaskId || observation.firstWorktreeId === observation.secondWorktreeId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", path, "concurrency proof requires distinct agents, tasks, and worktrees"));
  if (observation.integrationTarget !== observation.targetSnapshot.integrationTargetId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/integrationTarget`, "concurrency target does not match its target snapshot"));
  if (first?.eventType === "symbol.changed" && second?.eventType === "symbol.changed") {
    if (first.repositoryId !== event.repositoryId || second.repositoryId !== event.repositoryId || first.agentId !== observation.firstAgentId || second.agentId !== observation.secondAgentId || first.taskId !== observation.firstTaskId || second.taskId !== observation.secondTaskId || first.worktreeId !== observation.firstWorktreeId || second.worktreeId !== observation.secondWorktreeId || first.payload.resource.resourceId !== second.payload.resource.resourceId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", path, "concurrency proof changes do not identify the declared same-symbol participants"));
  }
  if (observation.overlapProof.kind === "executor_owned_tool_windows") {
    for (const [requestId, completionId, taskId, change] of [[observation.overlapProof.firstRequestEventId, observation.overlapProof.firstCompletionEventId, observation.firstTaskId, first], [observation.overlapProof.secondRequestEventId, observation.overlapProof.secondCompletionEventId, observation.secondTaskId, second]] as const) {
      const request = eventsById.get(requestId); const completion = eventsById.get(completionId);
      if (request?.eventType !== "tool.requested" || completion?.eventType !== "tool.completed" || change?.eventType !== "symbol.changed" || completion.payload.requestEventId !== requestId || !completion.payload.effectEventIds.includes(change.eventId) || request.taskId !== taskId || completion.taskId !== taskId || !sameDomain(request, change) || !sameDomain(completion, change)) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/overlapProof`, "executor window witness must bind each tool window and effect to its symbol change"));
    }
  } else if (observation.overlapProof.firstLifecycleId === observation.overlapProof.secondLifecycleId) {
    diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/overlapProof`, "task lifetime witness must identify two distinct lifecycles"));
  }
}

function validateProofDerivedEvidence(event: DerivedEvidenceEvent, eventsById: ReadonlyMap<EventId, ProtocolEvent>, diagnostics: ValidationDiagnostic[]): void {
  if (event.schemaVersion !== 3) return;
  const evidence = event.payload.evidence;
  const path = `/events/${event.eventId}/payload/evidence`;
  validateTargetSnapshot(evidence.targetSnapshot, event.repositoryId, `${path}/targetSnapshot`, diagnostics);
  if (evidence.integrationTarget !== evidence.targetSnapshot.integrationTargetId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/integrationTarget`, "derived evidence target does not match its target snapshot"));
  if ((evidence.factKind === "symbol") !== (evidence.proof.kind === "hash_bound_symbol_contract")) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof/kind`, "derived evidence proof kind does not match fact kind"));
  const analysis = evidence.proof.sourceAnalysis;
  const source = eventsById.get(analysis.sourceEventId);
  if (!evidence.sourceEventIds.includes(analysis.sourceEventId)) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof/sourceAnalysis/sourceEventId`, "proof source must be declared in sourceEventIds"));
  if (source?.eventType === "file.read" || source?.eventType === "symbol.read") {
    if (source.payload.resource.resourceId !== analysis.sourceResourceId || canonicalJson(source.payload.version) !== canonicalJson(analysis.sourceVersion)) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof/sourceAnalysis`, "analysis binding does not match its persisted source event"));
  } else if (source?.eventType === "file.changed" || source?.eventType === "symbol.changed") {
    if (source.payload.resource.resourceId !== analysis.sourceResourceId || canonicalJson(source.payload.afterVersion) !== canonicalJson(analysis.sourceVersion)) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof/sourceAnalysis`, "analysis binding does not match its persisted source event"));
  } else if (source === undefined) diagnostics.push(diagnostic("PHASE3_REFERENCE_MISSING", `${path}/proof/sourceAnalysis/sourceEventId`, "analysis source event is absent"));
  else diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof/sourceAnalysis/sourceEventId`, "analysis source must be a persisted resource observation"));
  if (analysis.analysisInputDigest !== sha256({ sourceResourceId: analysis.sourceResourceId, sourceVersion: analysis.sourceVersion })) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof/sourceAnalysis/analysisInputDigest`, "analysis input digest is invalid"));
  if (evidence.proof.kind === "resolver_confirmed_consumer_dependency") {
    const target = eventsById.get(evidence.targetEventId);
    if (target?.eventType !== "dependency.changed" || evidence.proof.dependencyId !== target.payload.dependency.dependencyId || evidence.proof.consumerResourceId !== target.payload.dependency.dependentResourceId || evidence.proof.contractResourceId !== target.payload.dependency.dependencyResourceId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `${path}/proof`, "resolver proof does not match its target dependency"));
  }
}

function validateToolCompletion(
  event: ToolCompletedEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const request = eventsById.get(event.payload.requestEventId);
  if (!request) {
    diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", `/events/${event.eventId}/payload/requestEventId`, "referenced request event is absent"));
    return;
  }
  if (request.eventType !== "tool.requested") {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/requestEventId`, "tool completion request must be a tool.requested event"));
  }
  if (!sameDomain(event, request) || event.correlationId !== request.correlationId) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/requestEventId`, "tool completion does not match its request domain"));
  }
  if (event.causationId !== event.payload.requestEventId && !event.payload.effectEventIds.includes(event.causationId as EventId)) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "tool completion must be caused by its request or declared effect"));
  }

  for (const effectEventId of event.payload.deterministicallyAttributedEffectEventIds ?? []) {
    const path = `/events/${event.eventId}/payload/deterministicallyAttributedEffectEventIds`;
    if (event.payload.outcome !== "succeeded") {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", path, "deterministically attributed effects require a succeeded tool completion"));
      continue;
    }
    if (!event.payload.effectEventIds.includes(effectEventId)) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", path, "deterministically attributed effect must be declared in effectEventIds"));
      continue;
    }
    const effect = eventsById.get(effectEventId);
    if (effect === undefined) {
      diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", path, "deterministically attributed effect event is absent"));
      continue;
    }
    if (effect.eventType !== "file.changed" || effect.source.kind !== "watcher") {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", path, "deterministically attributed effect must be a watcher file.changed event"));
      continue;
    }
    if (!sameDomain(event, effect)
      || event.correlationId !== effect.correlationId
      || event.agentId !== effect.agentId
      || event.taskId !== effect.taskId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", path, "deterministically attributed effect does not match completion attribution"));
    }
  }
}

function validateAttributionCorrection(
  event: AttributionCorrectedEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const target = eventsById.get(event.payload.targetEventId);
  if (!target) {
    diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", `/events/${event.eventId}/payload/targetEventId`, "attribution target is absent"));
  } else if (!sameDomain(event, target) || event.correlationId !== target.correlationId) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/targetEventId`, "attribution target crosses repository, domain, or correlation"));
  } else if (
    target.schemaVersion === 3
    && (event.payload.attributedAgentId !== target.agentId || event.payload.attributedTaskId !== target.taskId)
  ) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/targetEventId`, "attribution corrections cannot alter immutable V3 proof identities"));
  }
  if (event.payload.attributedAgentId === null && event.payload.attributedTaskId === null) {
    diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload`, "attribution correction must supply an identity"));
  }
}

function validateResourcePayload(event: ProtocolEvent, diagnostics: ValidationDiagnostic[]): void {
  if (event.eventType === "file.read" || event.eventType === "symbol.read") {
    const payload = event.payload;
    if (payload.resource.repositoryId !== event.repositoryId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/resource/repositoryId`, "logical resource crosses event repository"));
    }
    if (payload.resource.resourceId !== payload.version.resourceId || !sameVersionDomain(event, payload.version)) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/version`, "observed version does not match its event domain or resource"));
    }
  }
  if (event.eventType === "file.changed" || event.eventType === "symbol.changed") {
    const payload = event.payload;
    if (payload.resource.repositoryId !== event.repositoryId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload/resource/repositoryId`, "logical resource crosses event repository"));
    }
    for (const version of [payload.beforeVersion, payload.afterVersion]) {
      if (version && (version.resourceId !== payload.resource.resourceId || !sameVersionDomain(event, version))) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/payload`, "changed version does not match its event domain or resource"));
      }
    }
  }
}

function validateFindingFeedback(
  event: FindingFeedbackCreatedEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const feedback = event.payload.feedback;
  const finding = [...eventsById.values()].find((candidate) =>
    candidate.eventType === "finding.created" && candidate.payload.finding.findingId === feedback.findingId);

  if (finding === undefined) {
    diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `/events/${event.eventId}/payload/feedback/findingId`, "feedback finding is absent"));
  } else if (!sameDomain(event, finding) || event.correlationId !== finding.correlationId) {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/feedback/findingId`, "feedback finding crosses repository, domain, or correlation"));
  }

  if (feedback.decisionId !== null) {
    const decision = [...eventsById.values()].find((candidate): candidate is DecisionCreatedEvent =>
      candidate.eventType === "decision.created" && candidate.payload.decision.decisionId === feedback.decisionId);
    if (decision === undefined) {
      diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `/events/${event.eventId}/payload/feedback/decisionId`, "feedback decision is absent"));
    } else {
      if (decision.payload.decision.findingId !== feedback.findingId) {
        diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/feedback/decisionId`, "feedback decision does not belong to its finding"));
      }
      if (!sameDomain(event, decision) || event.correlationId !== decision.correlationId) {
        diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/feedback/decisionId`, "feedback decision crosses repository, domain, or correlation"));
      }
    }
  }

  if (event.agentId !== feedback.actor.agentId || event.taskId !== feedback.actor.taskId) {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/feedback/actor`, "feedback actor must match envelope attribution"));
  }

  for (const evidenceEventId of feedback.evidenceEventIds) {
    const evidence = eventsById.get(evidenceEventId);
    if (evidence === undefined) {
      diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `/events/${event.eventId}/payload/feedback/evidenceEventIds`, "feedback evidence event is absent"));
    } else if (!sameDomain(event, evidence) || event.correlationId !== evidence.correlationId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/feedback/evidenceEventIds`, "feedback evidence crosses repository, domain, or correlation"));
    }
  }
}

function validateDependentWrite(
  event: DependentWriteEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const write = event.payload.write;
  const read = eventsById.get(write.dependsOnReadEventId);
  if (read === undefined) {
    diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `/events/${event.eventId}/payload/write/dependsOnReadEventId`, "dependent write read event is absent"));
  } else if (read.eventType !== "file.read" && read.eventType !== "symbol.read") {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/write/dependsOnReadEventId`, "dependent write must reference a resource read"));
  } else {
    if (!sameDomain(event, read)) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/write/dependsOnReadEventId`, "dependent write read crosses repository or domain"));
    }
    if (event.taskId === null || read.taskId !== event.taskId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/taskId`, "dependent write and read must have the same task attribution"));
    }
  }

  const dependency = [...eventsById.values()].find((candidate): candidate is DependencyChangedEvent =>
    candidate.eventType === "dependency.changed" && candidate.payload.dependency.dependencyId === write.dependencyId);
  if (dependency === undefined) {
    diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `/events/${event.eventId}/payload/write/dependencyId`, "dependent write dependency is absent"));
  } else {
    if (!sameDomain(event, dependency)) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/write/dependencyId`, "dependent write dependency crosses repository or domain"));
    }
    if (dependency.payload.dependency.dependentResourceId !== write.resourceId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/write/resourceId`, "dependent write resource does not match its dependency"));
    }
    if ((read?.eventType === "file.read" || read?.eventType === "symbol.read") &&
      dependency.payload.dependency.dependencyResourceId !== read.payload.resource.resourceId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/write/dependsOnReadEventId`, "dependent write read resource does not match its dependency"));
    }
  }

  const changed = event.causationId === null ? undefined : eventsById.get(event.causationId);
  if (changed === undefined) {
    diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `/events/${event.eventId}/causationId`, "dependent write must be caused by its changed resource event"));
  } else if (changed.eventType !== "file.changed" && changed.eventType !== "symbol.changed") {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "dependent write causation must reference a changed resource"));
  } else {
    if (changed.payload.resource.resourceId !== write.resourceId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/payload/write/resourceId`, "dependent write resource does not match its changed resource event"));
    }
    if (!sameDomain(event, changed) || event.correlationId !== changed.correlationId || changed.taskId !== event.taskId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "dependent write changed resource crosses repository, domain, correlation, or task"));
    }
  }

  const comparison = write.comparison;
  if (comparison !== undefined) {
    const changed = eventsById.get(comparison.changedEventId);
    const path = `/events/${event.eventId}/payload/write/comparison`;
    if (changed === undefined) diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `${path}/changedEventId`, "dependent write comparison change is absent"));
    else if (changed.eventType !== "file.changed" && changed.eventType !== "symbol.changed") diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/changedEventId`, "dependent write comparison must reference a changed resource"));
    else {
      if (!sameRepositoryWorkspace(event, changed) || (read?.eventType === "file.read" || read?.eventType === "symbol.read") && (changed.payload.resource.resourceId !== read.payload.resource.resourceId || changed.payload.afterVersion.resourceId !== read.payload.version.resourceId)) {
        diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/changedEventId`, "dependent write comparison does not match the read resource or domain"));
      }
      if (changed.eventType === "symbol.changed") {
        const evidence = [...eventsById.values()].filter((candidate): candidate is DerivedEvidenceEvent =>
          candidate.eventType === "evidence.derived"
          && candidate.payload.evidence.targetEventId === changed.eventId
          && candidate.payload.evidence.factKind === "symbol"
          && candidate.payload.evidence.coverage.status === "sufficient",
        );
        if (evidence.length !== 1 || evidence[0]!.payload.evidence.integrationTarget !== comparison.integrationTarget) {
          diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/integrationTarget`, "dependent write comparison integration target does not match sufficient symbol evidence"));
        }
      }
    }
  }
}

function validateTaskConcurrencyObservation(event: TaskConcurrencyObservedEvent, eventsById: ReadonlyMap<EventId, ProtocolEvent>, diagnostics: ValidationDiagnostic[]): void {
  const observation = event.payload.observation;
  const path = `/events/${event.eventId}/payload/observation`;
  if (event.source.kind !== "gateway" && event.source.kind !== "adapter") {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `/events/${event.eventId}/source`, "concurrency observation must be emitted by an adapter or gateway"));
  }
  if (observation.firstTaskId === observation.secondTaskId) diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}`, "concurrency observation must identify two distinct tasks"));
  const first = eventsById.get(observation.firstChangeEventId);
  const second = eventsById.get(observation.secondChangeEventId);
  for (const [name, change, taskId] of [["first", first, observation.firstTaskId], ["second", second, observation.secondTaskId]] as const) {
    if (change === undefined) diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `${path}/${name}ChangeEventId`, "concurrency change event is absent"));
    else if (change.eventType !== "symbol.changed") diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/${name}ChangeEventId`, "concurrency observation must reference a symbol change"));
    else if ((event.schemaVersion === 2 ? !sameRepositoryWorkspace(event, change) : event.repositoryId !== change.repositoryId) || change.taskId !== taskId) diagnostics.push(diagnostic(event.schemaVersion === 2 ? "PHASE2_SCHEMA_INVALID" : "PHASE3_SCHEMA_INVALID", `${path}/${name}ChangeEventId`, "concurrency change does not match its task or repository"));
  }
  if (first?.eventType === "symbol.changed" && second?.eventType === "symbol.changed" && first.worktreeId === second.worktreeId) {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}`, "concurrency observation must reference distinct worktrees"));
  }
}

function validateDerivedEvidence(
  event: DerivedEvidenceEvent,
  eventsById: ReadonlyMap<EventId, ProtocolEvent>,
  diagnostics: ValidationDiagnostic[],
): void {
  const evidence = event.payload.evidence;
  const target = eventsById.get(evidence.targetEventId);
  const path = `/events/${event.eventId}/payload/evidence`;
  if (event.source.kind !== "analyzer") {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/analyzer`, "derived evidence must be emitted by an analyzer source"));
  }
  if (configurationDigest(evidence.configuration) !== evidence.configurationDigest) {
    diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/configurationDigest`, "derived evidence configuration digest does not match configuration"));
  }
  if (target === undefined) {
    diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `${path}/targetEventId`, "derived evidence target event is absent"));
  } else {
    const expectedEventType = evidence.factKind === "symbol" ? "symbol.changed" : "dependency.changed";
    if (target.eventType !== expectedEventType) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/targetEventId`, "derived evidence target type does not match fact kind"));
    }
    if (!sameDomain(event, target) || event.correlationId !== target.correlationId || event.causationId !== target.eventId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/targetEventId`, "derived evidence target does not match its causal domain"));
    }
    const expectedFactId = target.eventType === "symbol.changed"
      ? target.payload.resource.resourceId
      : target.eventType === "dependency.changed"
        ? target.payload.dependency.dependencyId
        : null;
    if (expectedFactId !== evidence.stableFactId) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/stableFactId`, "derived evidence fact ID does not match its target"));
    }
  }

  for (const sourceEventId of evidence.sourceEventIds) {
    const source = eventsById.get(sourceEventId);
    if (source === undefined) {
      diagnostics.push(diagnostic("PHASE2_REFERENCE_MISSING", `${path}/sourceEventIds`, "derived evidence source event is absent"));
    } else if (!sameRepositoryWorkspace(event, source)) {
      diagnostics.push(diagnostic("PHASE2_SCHEMA_INVALID", `${path}/sourceEventIds`, "derived evidence source crosses repository or workspace"));
    }
  }
}

export function validateEventSet(events: readonly ProtocolEvent[]): readonly ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const eventsById = new Map<EventId, ProtocolEvent>();
  const sequenceByProducer = new Map<string, EventId>();
  const rootsByCorrelation = new Map<string, EventId>();

  for (const event of events) {
    const previous = eventsById.get(event.eventId);
    if (previous === undefined) eventsById.set(event.eventId, event);
    else if (canonicalJson(previous) !== canonicalJson(event)) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `/events/${event.eventId}`, "event ID has conflicting canonical content"));
  }

  for (const event of events) {
    if (event.causationId === event.eventId) {
      diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "event cannot cause itself"));
    } else if (event.causationId !== null) {
      const parent = eventsById.get(event.causationId);
      if (!parent) {
        diagnostics.push(diagnostic("PHASE0_REFERENCE_MISSING", `/events/${event.eventId}/causationId`, "causal parent is absent"));
      } else {
        if (parent.correlationId !== event.correlationId) {
          diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/correlationId`, "child must inherit parent correlation ID"));
        }
        if (producerKey(parent.source) === producerKey(event.source) && parent.sourceSequence !== null && event.sourceSequence !== null && event.sourceSequence <= parent.sourceSequence) {
          diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/sourceSequence`, "causal child must advance its producer sequence"));
        }
      }
    } else {
      const root = rootsByCorrelation.get(event.correlationId);
      if (root && root !== event.eventId) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "one correlation cannot have multiple roots"));
      } else {
        rootsByCorrelation.set(event.correlationId, event.eventId);
      }
    }

    if (event.sourceSequence !== null) {
      const sequenceKey = `${producerKey(event.source)}:${event.sourceSequence}`;
      const previous = sequenceByProducer.get(sequenceKey);
      if (previous && previous !== event.eventId) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/sourceSequence`, "source sequence is duplicated in one producer instance"));
      } else {
        sequenceByProducer.set(sequenceKey, event.eventId);
      }
    }

    if (event.eventType === "tool.completed") validateToolCompletion(event, eventsById, diagnostics);
    if (event.eventType === "attribution.corrected") validateAttributionCorrection(event, eventsById, diagnostics);
    if (event.eventType === "finding.feedback.created") validateFindingFeedback(event, eventsById, diagnostics);
    if (event.eventType === "write.dependent") validateDependentWrite(event, eventsById, diagnostics);
    if (event.eventType === "task.concurrency.observed") validateTaskConcurrencyObservation(event, eventsById, diagnostics);
    if (event.eventType === "evidence.derived") validateDerivedEvidence(event, eventsById, diagnostics);
    if (event.eventType === "write.dependent") validateProofDependentWrite(event, eventsById, diagnostics);
    if (event.eventType === "task.concurrency.observed") validateProofConcurrency(event, eventsById, diagnostics);
    if (event.eventType === "evidence.derived") validateProofDerivedEvidence(event, eventsById, diagnostics);
    validateResourcePayload(event, diagnostics);
  }

  for (const event of events) {
    const visited = new Set<EventId>([event.eventId]);
    let current = event;
    while (current.causationId !== null) {
      if (visited.has(current.causationId)) {
        diagnostics.push(diagnostic("PHASE0_SCHEMA_INVALID", `/events/${event.eventId}/causationId`, "causal graph contains a cycle"));
        break;
      }
      visited.add(current.causationId);
      const parent = eventsById.get(current.causationId);
      if (!parent) break;
      current = parent;
    }
  }

  const sufficientProofs = new Map<string, EventId>();
  for (const event of events) {
    if (event.eventType !== "evidence.derived" || event.schemaVersion !== 3 || event.payload.evidence.coverage.status !== "sufficient") continue;
    const key = `${event.payload.evidence.targetEventId}:${event.payload.evidence.targetSnapshot.targetSnapshotId}`;
    const previous = sufficientProofs.get(key);
    if (previous !== undefined && previous !== event.eventId) diagnostics.push(diagnostic("PHASE3_SCHEMA_INVALID", `/events/${event.eventId}/payload/evidence`, "multiple sufficient derived proofs for one target snapshot are ambiguous"));
    else sufficientProofs.set(key, event.eventId);
  }

  return sortDiagnostics(diagnostics);
}
