import { EFFECT_STATUSES, RESULT_STATUSES } from "./types.mjs";

function diagnostic(code, path, message) {
  return { code, path, message };
}

export function validateTraceEvent(event) {
  const diagnostics = [];
  if (event === null || typeof event !== "object") return [diagnostic("TRACE_EVENT_INVALID", "/", "event must be an object")];
  if (event.schemaVersion !== 1) diagnostics.push(diagnostic("TRACE_SCHEMA_VERSION_INVALID", "/schemaVersion", "schemaVersion must be 1"));
  if (typeof event.eventId !== "string" || !event.eventId.startsWith("trace_")) diagnostics.push(diagnostic("TRACE_EVENT_ID_INVALID", "/eventId", "eventId must use the trace_ prefix"));
  if (typeof event.runId !== "string" || event.runId.length === 0) diagnostics.push(diagnostic("TRACE_RUN_ID_INVALID", "/runId", "runId must be a non-empty string"));
  if (!Number.isInteger(event.sequence) || event.sequence < 1) diagnostics.push(diagnostic("TRACE_SEQUENCE_INVALID", "/sequence", "sequence must be a positive integer"));
  if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) diagnostics.push(diagnostic("TRACE_TIMESTAMP_INVALID", "/timestamp", "timestamp must be an ISO timestamp"));
  if (typeof event.action !== "string" || event.action.length === 0) diagnostics.push(diagnostic("TRACE_ACTION_INVALID", "/action", "action must be a non-empty string"));
  if (!Array.isArray(event.paths)) diagnostics.push(diagnostic("TRACE_PATHS_INVALID", "/paths", "paths must be an array"));
  if (!Array.isArray(event.resources)) diagnostics.push(diagnostic("TRACE_RESOURCES_INVALID", "/resources", "resources must be an array"));
  const result = event.result;
  if (result === null || typeof result !== "object" || !RESULT_STATUSES.has(result.status)) diagnostics.push(diagnostic("TRACE_RESULT_STATUS_INVALID", "/result/status", "result status is invalid"));
  const effect = event.derivedEffect;
  if (effect === null || typeof effect !== "object" || !EFFECT_STATUSES.has(effect.status)) diagnostics.push(diagnostic("TRACE_EFFECT_STATUS_INVALID", "/derivedEffect/status", "derived effect status is invalid"));
  if (effect === null || typeof effect !== "object" || typeof effect.confidence !== "number" || effect.confidence < 0 || effect.confidence > 1) diagnostics.push(diagnostic("TRACE_CONFIDENCE_INVALID", "/derivedEffect/confidence", "confidence must be between 0 and 1"));
  return diagnostics;
}

export function validateRunManifest(manifest) {
  const diagnostics = [];
  if (manifest === null || typeof manifest !== "object") return [diagnostic("TRACE_MANIFEST_INVALID", "/", "manifest must be an object")];
  if (manifest.schemaVersion !== 1) diagnostics.push(diagnostic("TRACE_MANIFEST_SCHEMA_VERSION_INVALID", "/schemaVersion", "schemaVersion must be 1"));
  if (typeof manifest.runId !== "string" || manifest.runId.length === 0) diagnostics.push(diagnostic("TRACE_MANIFEST_RUN_ID_INVALID", "/runId", "runId must be a non-empty string"));
  if (typeof manifest.recorderVersion !== "string" || manifest.recorderVersion.length === 0) diagnostics.push(diagnostic("TRACE_MANIFEST_RECORDER_VERSION_INVALID", "/recorderVersion", "recorderVersion must be a non-empty string"));
  if (typeof manifest.startedAt !== "string" || Number.isNaN(Date.parse(manifest.startedAt))) diagnostics.push(diagnostic("TRACE_MANIFEST_STARTED_AT_INVALID", "/startedAt", "startedAt must be an ISO timestamp"));
  if (!Number.isInteger(manifest.eventCount) || manifest.eventCount < 0) diagnostics.push(diagnostic("TRACE_MANIFEST_COUNT_INVALID", "/eventCount", "eventCount must be a non-negative integer"));
  if (!Array.isArray(manifest.errors)) diagnostics.push(diagnostic("TRACE_MANIFEST_ERRORS_INVALID", "/errors", "errors must be an array"));
  if (!Array.isArray(manifest.gaps)) diagnostics.push(diagnostic("TRACE_MANIFEST_GAPS_INVALID", "/gaps", "gaps must be an array"));
  return diagnostics;
}
