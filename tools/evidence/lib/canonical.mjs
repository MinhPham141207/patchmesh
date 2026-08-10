import { createHash } from "node:crypto";

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

export function createEventId({ runId, action, sourceEventId = null, toolCallId = null, payloadDigest }) {
  return `trace_${createHash("sha256").update(canonicalJson({ runId, action, sourceEventId, toolCallId, payloadDigest })).digest("hex")}`;
}
