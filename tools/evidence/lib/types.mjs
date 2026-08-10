export const TRACE_SCHEMA_VERSION = 1;
export const RECORDER_VERSION = "0.1.0";

export const RESULT_STATUSES = new Set([
  "started",
  "succeeded",
  "failed",
  "interrupted",
  "rejected",
  "unknown",
]);

export const EFFECT_STATUSES = new Set(["verified", "inferred", "degraded", "unknown"]);
