function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
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
  const completionPayload = asRecord(completion?.payload);
  const effectEventIds = Array.isArray(completionPayload?.effectEventIds)
    ? new Set(completionPayload.effectEventIds.filter((eventId) => typeof eventId === "string"))
    : new Set();
  const changes = events
    .filter((event) => event?.eventType === "file.changed" && effectEventIds.has(event.eventId))
    .map(changedResource)
    .filter((change) => change !== null)
    .sort((left, right) => left.resource.locator.localeCompare(right.resource.locator));
  const coverage = asRecord(result?.coverage);
  const gapReasons = effectGapReasons(coverage, result?.observationDiagnostics, result?.analysisDiagnostics);
  const hasPersistedEffectEvidence = completion !== undefined && changes.length > 0;
  const coveragePresentation = coverage?.presentation;
  const effectStatus = !hasPersistedEffectEvidence
    ? "unknown"
    : coveragePresentation === "sufficient"
      ? "verified"
      : coveragePresentation === "degraded"
        ? "degraded"
        : "unknown";
  if (!hasPersistedEffectEvidence) gapReasons.push("persisted completion effect evidence was unavailable");
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
