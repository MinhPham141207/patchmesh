import { canonicalJson, sha256 } from "./canonical.mjs";
import { validateTraceEvent, validateRunManifest } from "./validate.mjs";

function diagnostic(code, path, message) {
  return { code, path, message };
}

export function validateTrace(events, manifest = null) {
  const diagnostics = [];
  let expectedSequence = 1;
  for (const [index, event] of events.entries()) {
    diagnostics.push(...validateTraceEvent(event).map((item) => ({ ...item, path: `/events/${index}${item.path}` })));
    if (event.sequence !== expectedSequence) diagnostics.push(diagnostic("TRACE_SEQUENCE_INVALID", `/events/${index}/sequence`, `expected sequence ${expectedSequence}`));
    if (event.runId !== manifest?.runId && manifest !== null) diagnostics.push(diagnostic("TRACE_RUN_ID_MISMATCH", `/events/${index}/runId`, "event runId does not match manifest"));
    expectedSequence += 1;
  }
  if (manifest !== null) {
    diagnostics.push(...validateRunManifest(manifest));
    if (manifest.eventCount !== events.length) diagnostics.push(diagnostic("TRACE_MANIFEST_MISMATCH", "/eventCount", "manifest event count does not match trace"));
    if (manifest.traceDigest !== null && manifest.traceDigest !== sha256(canonicalJson(events))) diagnostics.push(diagnostic("TRACE_MANIFEST_DIGEST_MISMATCH", "/traceDigest", "manifest digest does not match trace"));
  }
  return { valid: diagnostics.length === 0, diagnostics, stats: { eventCount: events.length, sequenceCount: expectedSequence - 1 } };
}

export function summarizeTrace(events, manifest = null) {
  const postTool = events.filter((event) => ["tool.completed", "tool.failed", "tool.interrupted"].includes(event.action));
  const verifiedEffects = postTool.filter((event) => event.derivedEffect.status === "verified").length;
  const statusCounts = Object.fromEntries(["started", "succeeded", "failed", "interrupted", "rejected", "unknown"].map((status) => [status, events.filter((event) => event.result.status === status).length]));
  const effectCounts = Object.fromEntries(["verified", "inferred", "degraded", "unknown"].map((status) => [status, events.filter((event) => event.derivedEffect.status === status).length]));
  const actionCounts = Object.fromEntries([...new Set(events.map((event) => event.action))].sort().map((action) => [action, events.filter((event) => event.action === action).length]));
  return {
    schemaVersion: 1,
    runId: manifest?.runId ?? events[0]?.runId ?? null,
    eventCount: events.length,
    actionCounts,
    resultCounts: statusCounts,
    effectCounts,
    completedToolCount: events.filter((event) => event.action === "tool.completed" && event.result.status === "succeeded").length,
    failedToolCount: events.filter((event) => event.action === "tool.failed" || event.result.status === "failed").length,
    interruptedToolCount: events.filter((event) => event.action === "tool.interrupted" || event.result.status === "interrupted").length,
    rejectedToolCount: events.filter((event) => event.result.status === "rejected").length,
    unknownEffectCount: effectCounts.unknown,
    redactionCount: events.reduce((total, event) => total + event.result.redactionCount, 0),
    effectCoverage: postTool.length === 0 ? 0 : verifiedEffects / postTool.length,
    gapCounts: Object.fromEntries([...new Set(events.flatMap((event) => event.derivedEffect.gaps))].sort().map((gap) => [gap, events.flatMap((event) => event.derivedEffect.gaps).filter((item) => item === gap).length])),
    traceDigest: sha256(canonicalJson(events)),
    manifestDigest: manifest === null ? null : sha256(canonicalJson(manifest)),
  };
}
