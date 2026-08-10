function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

const eventIdPattern = /^evt_[0-9a-f]{32}$/;
const repositoryIdPattern = /^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workspaceIdPattern = /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/;
const worktreeIdPattern = /^wt_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/;
const agentIdPattern = /^agent_[a-z0-9][a-z0-9._-]{0,63}$/;
const taskIdPattern = /^task_[a-z0-9][a-z0-9._-]{0,63}$/;
const correlationIdPattern = /^corr_[0-9a-f]{32}$/;
const coverageIdPattern = /^coverage_[0-9a-f]{32}$/;
const resourceIdPattern = /^res_[0-9a-f]{64}$/;
const sourceIdPattern = /^source_[a-z0-9][a-z0-9._-]{0,63}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isEventId(value) {
  return typeof value === "string" && eventIdPattern.test(value);
}

function isUniqueEventIdList(value) {
  return Array.isArray(value) && value.every(isEventId) && new Set(value).size === value.length;
}

function isProtocolEnvelope(event, eventType) {
  const source = asRecord(event?.source);
  return asRecord(event) !== null
    && event.schemaVersion === 1
    && event.eventType === eventType
    && isEventId(event.eventId)
    && source !== null
    && ["gateway", "adapter", "watcher", "analyzer", "core"].includes(source.kind)
    && typeof source.sourceId === "string" && source.sourceId.length > 0
    && typeof source.instanceId === "string" && source.instanceId.length > 0
    && typeof event.timestamp === "string" && event.timestamp.length > 0
    && typeof event.repositoryId === "string" && event.repositoryId.length > 0
    && typeof event.workspaceId === "string" && event.workspaceId.length > 0
    && typeof event.worktreeId === "string" && event.worktreeId.length > 0
    && (event.agentId === null || typeof event.agentId === "string")
    && (event.taskId === null || typeof event.taskId === "string")
    && typeof event.correlationId === "string" && correlationIdPattern.test(event.correlationId)
    && (event.causationId === null || isEventId(event.causationId))
    && (event.sourceSequence === null || (Number.isInteger(event.sourceSequence) && event.sourceSequence >= 0))
    && asRecord(event.payload) !== null;
}

function isProtocolToolRequest(event) {
  if (!isProtocolEnvelope(event, "tool.requested") || event.source.kind !== "adapter") return false;
  const payload = event.payload;
  return ["read_file", "edit_file", "run_shell", "run_test", "git_commit"].includes(payload.toolName)
    && typeof payload.operation === "string" && payload.operation.length > 0
    && (payload.targetResourceId === null || resourceIdPattern.test(payload.targetResourceId))
    && typeof payload.opaque === "boolean";
}

function isProtocolToolCompletion(event) {
  if (!isProtocolEnvelope(event, "tool.completed") || event.source.kind !== "adapter") return false;
  const payload = event.payload;
  return isEventId(payload.requestEventId)
    && ["succeeded", "failed", "interrupted"].includes(payload.outcome)
    && (payload.exitCode === null || Number.isInteger(payload.exitCode))
    && isUniqueEventIdList(payload.effectEventIds)
    && (payload.deterministicallyAttributedEffectEventIds === undefined
      || isUniqueEventIdList(payload.deterministicallyAttributedEffectEventIds));
}

function isProtocolFileChange(event) {
  if (!isProtocolEnvelope(event, "file.changed") || event.source.kind !== "watcher") return false;
  const payload = event.payload;
  const resource = asRecord(payload.resource);
  return resource !== null
    && typeof resource.resourceId === "string" && resourceIdPattern.test(resource.resourceId)
    && resource.repositoryId === event.repositoryId
    && ["file", "symbol", "api", "schema", "test"].includes(resource.kind)
    && typeof resource.locator === "string" && resource.locator.length > 0
    && !resource.locator.startsWith("/") && !/^[A-Za-z]:/.test(resource.locator)
    && !resource.locator.includes("\\") && !resource.locator.includes("\u0000")
    && asRecord(payload.afterVersion) !== null
    && ["created", "modified", "deleted", "renamed"].includes(payload.changeKind);
}

function sharesOperationContext(completion, change) {
  return completion !== null
    && completion.repositoryId === change.repositoryId
    && completion.workspaceId === change.workspaceId
    && completion.worktreeId === change.worktreeId
    && completion.agentId === change.agentId
    && completion.taskId === change.taskId
    && completion.correlationId === change.correlationId
    && change.causationId === completion.payload.requestEventId;
}

function hasSufficientBoundCoverage(coverage, request, completion, deterministicChanges) {
  if (coverage === null
    || typeof coverage.coverageId !== "string" || !coverageIdPattern.test(coverage.coverageId)
    || coverage.scope !== `tool:${completion.payload.requestEventId}`
    || !Array.isArray(coverage.modes) || !coverage.modes.includes("intercepted") || !coverage.modes.includes("verified")
    || coverage.presentation !== "sufficient"
    || !Array.isArray(coverage.gaps) || coverage.gaps.length !== 0
    || !isUniqueEventIdList(coverage.evidenceEventIds)) return false;
  const boundEventIds = new Set(coverage.evidenceEventIds);
  return request !== null
    && boundEventIds.has(request.eventId)
    && boundEventIds.has(completion.eventId)
    && deterministicChanges.every((change) => boundEventIds.has(change.eventId));
}

function resultStatus(outcome) {
  if (outcome === "failed") return "failed";
  if (outcome === "interrupted") return "interrupted";
  if (outcome === "succeeded") return "succeeded";
  return "unknown";
}

function effectGapReasons(coverage, observationDiagnostics, analysisDiagnostics) {
  return uniqueStrings([
    ...(Array.isArray(coverage?.gaps) ? coverage.gaps.map((gap) => asRecord(gap)?.reason) : []),
    ...(Array.isArray(observationDiagnostics) ? observationDiagnostics.map((gap) => asRecord(gap)?.reason) : []),
    ...(Array.isArray(analysisDiagnostics) ? analysisDiagnostics.map((diagnostic) => asRecord(diagnostic)?.reason) : []),
  ]);
}

function changedResource(event) {
  const payload = asRecord(event?.payload);
  const resource = asRecord(payload?.resource);
  if (resource === null || typeof resource.resourceId !== "string" || typeof resource.locator !== "string") return null;
  return {
    eventId: event.eventId,
    resource,
    beforeVersion: payload.beforeVersion ?? null,
    afterVersion: payload.afterVersion ?? null,
    changeKind: payload.changeKind ?? "modified",
  };
}

/**
 * Translates an explicit McpProxy result plus its persisted events into the
 * generic evidence-recorder payload. It never treats hook paths as effects.
 */
export function translatePatchMeshPayload(payload) {
  const input = asRecord(payload);
  const patchmesh = asRecord(input?.patchmesh);
  if (patchmesh === null) return payload;

  const result = asRecord(patchmesh.result);
  const execution = asRecord(result?.execution);
  const events = Array.isArray(patchmesh.events) ? patchmesh.events : [];
  const completedEventId = typeof result?.completedEventId === "string" ? result.completedEventId : null;
  const completion = events.find((event) => event?.eventId === completedEventId && event?.eventType === "tool.completed");
  const protocolCompletion = isProtocolToolCompletion(completion) ? completion : null;
  const completionPayload = protocolCompletion?.payload;
  const request = events.find((event) => event?.eventId === completionPayload?.requestEventId && event?.eventType === "tool.requested");
  const protocolRequest = isProtocolToolRequest(request) && request.eventId === protocolCompletion?.payload.requestEventId
    && request.repositoryId === protocolCompletion.repositoryId
    && request.workspaceId === protocolCompletion.workspaceId
    && request.worktreeId === protocolCompletion.worktreeId
    && request.agentId === protocolCompletion.agentId
    && request.taskId === protocolCompletion.taskId
    && request.correlationId === protocolCompletion.correlationId
    && protocolCompletion.causationId === request.eventId
    ? request
    : null;
  const effectEventIds = Array.isArray(completionPayload?.effectEventIds)
    ? new Set(completionPayload.effectEventIds)
    : new Set();
  const changes = events
    .filter((event) => effectEventIds.has(event?.eventId) && isProtocolFileChange(event) && sharesOperationContext(protocolCompletion, event))
    .map(changedResource)
    .filter((change) => change !== null)
    .sort((left, right) => left.resource.locator.localeCompare(right.resource.locator));
  const coverage = asRecord(result?.coverage);
  const gapReasons = effectGapReasons(coverage, result?.observationDiagnostics, result?.analysisDiagnostics);
  const deterministicEffectIds = Array.isArray(completionPayload?.deterministicallyAttributedEffectEventIds)
    ? new Set(completionPayload.deterministicallyAttributedEffectEventIds)
    : new Set();
  const deterministicChanges = changes.filter((change) => deterministicEffectIds.has(change.eventId));
  const hasPersistedEffectEvidence = protocolCompletion !== null && changes.length > 0;
  const hasDeterministicEffectEvidence = protocolCompletion?.payload.outcome === "succeeded"
    && deterministicEffectIds.size > 0
    && deterministicChanges.length === deterministicEffectIds.size;
  const hasVerifiedEvidence = protocolRequest !== null
    && hasDeterministicEffectEvidence
    && hasSufficientBoundCoverage(coverage, protocolRequest, protocolCompletion, deterministicChanges);
  const effectStatus = !hasPersistedEffectEvidence
    ? "unknown"
    : hasVerifiedEvidence
      ? "verified"
      : coverage?.presentation === "unknown"
        ? "unknown"
        : "degraded";
  if (!hasPersistedEffectEvidence) gapReasons.push("persisted protocol completion effect evidence was unavailable");
  else if (!hasDeterministicEffectEvidence) gapReasons.push("deterministically attributed persisted effect evidence was unavailable");
  else if (protocolRequest === null) gapReasons.push("persisted valid protocol request evidence was unavailable");
  else if (!hasVerifiedEvidence) gapReasons.push("sufficient coverage was not bound to deterministic effect evidence");
  const { patchmesh: _ignored, ...withoutPatchmesh } = input;
  const inputResult = asRecord(input.result) ?? {};
  return {
    ...withoutPatchmesh,
    sourceEventId: completedEventId ?? input.sourceEventId,
    resources: changes.map((change) => ({
      kind: change.resource.kind,
      id: change.resource.resourceId,
      version: change.afterVersion?.value ?? null,
    })),
    result: {
      ...inputResult,
      status: resultStatus(execution?.outcome ?? inputResult.status),
      exitCode: Number.isInteger(execution?.exitCode) ? execution.exitCode : inputResult.exitCode ?? null,
    },
    derivedEffect: {
      status: effectStatus,
      changedPaths: changes.map((change) => change.resource.locator),
      resourceChanges: changes,
      confidence: effectStatus === "verified" ? 1 : 0,
      gaps: uniqueStrings(gapReasons),
    },
  };
}
