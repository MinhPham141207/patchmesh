import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, createEventId, sha256 } from "./canonical.mjs";
import { redactObject, redactValue } from "./redact.mjs";
import { TRACE_SCHEMA_VERSION, RESULT_STATUSES, EFFECT_STATUSES } from "./types.mjs";

const DEFAULT_CONFIG = {
  maxTextBytes: 4096,
  maxErrorBytes: 2048,
  maxArrayEntries: 128,
  redactionPlaceholder: "[REDACTED]",
};

function asNullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizePath(value, repositoryRoot) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = value.replaceAll("\\", "/");
  if (repositoryRoot === null || repositoryRoot === undefined) return normalized;
  const root = resolve(repositoryRoot);
  const candidate = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const relativePath = relative(root, candidate).split(sep).join("/");
  if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../"))) return relativePath;
  return `external/${sha256(normalized).slice("sha256:".length, "sha256:".length + 16)}`;
}

function boundedArray(value, maxArrayEntries) {
  return Array.isArray(value) ? value.slice(0, maxArrayEntries) : [];
}

export function normalizeHookPayload(payload, context, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const input = payload !== null && typeof payload === "object" ? payload : {};
  const now = context.now ?? new Date().toISOString();
  const action = asNullableString(input.action) ?? "trace.error";
  const paths = boundedArray(input.paths, config.maxArrayEntries)
    .map((path) => normalizePath(path, context.repositoryRoot))
    .filter((path) => path !== null);
  const resources = boundedArray(input.resources, config.maxArrayEntries).flatMap((resource) => {
    if (resource === null || typeof resource !== "object") return [];
    const id = asNullableString(resource.id);
    const kind = asNullableString(resource.kind);
    if (id === null || kind === null) return [];
    return [{ kind, id: normalizePath(id, context.repositoryRoot) ?? id, version: asNullableString(resource.version) }];
  });
  const rawResult = input.result !== null && typeof input.result === "object" ? input.result : {};
  const resultStatus = RESULT_STATUSES.has(rawResult.status) ? rawResult.status : "unknown";
  const output = rawResult.output ?? input.output;
  const outputCapture = output === undefined ? { digest: null, redactionCount: 0 } : redactValue(output, {
    maxTextBytes: config.maxTextBytes,
    placeholder: config.redactionPlaceholder,
  });
  const redactedError = rawResult.errorMessage === undefined ? null : redactValue(rawResult.errorMessage, {
    maxTextBytes: config.maxErrorBytes,
    placeholder: config.redactionPlaceholder,
  });
  const effectInput = input.derivedEffect !== null && typeof input.derivedEffect === "object" ? input.derivedEffect : {};
  const effectStatus = EFFECT_STATUSES.has(effectInput.status) ? effectInput.status : "unknown";
  const changedPaths = boundedArray(effectInput.changedPaths, config.maxArrayEntries)
    .map((path) => normalizePath(path, context.repositoryRoot))
    .filter((path) => path !== null);
  const resourceChanges = boundedArray(effectInput.resourceChanges, config.maxArrayEntries)
    .filter((change) => change !== null && typeof change === "object")
    .map((change) => redactObject(change, config).value);
  const gaps = boundedArray(effectInput.gaps, config.maxArrayEntries).filter((gap) => typeof gap === "string");
  if (effectStatus === "unknown" && gaps.length === 0) gaps.push("post-tool effect observation was unavailable");
  const payloadDigest = sha256(canonicalJson({ action, input }));
  const result = {
    status: resultStatus,
    durationMs: typeof rawResult.durationMs === "number" && rawResult.durationMs >= 0 ? rawResult.durationMs : null,
    exitCode: Number.isInteger(rawResult.exitCode) ? rawResult.exitCode : null,
    errorClass: asNullableString(rawResult.errorClass),
    outputDigest: outputCapture.digest,
    redactionCount: outputCapture.redactionCount + (redactedError?.redactionCount ?? 0),
  };
  if (redactedError !== null && result.errorClass === null) result.errorClass = "tool.error";
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    eventId: createEventId({
      runId: context.runId,
      action,
      sourceEventId: asNullableString(input.sourceEventId),
      toolCallId: asNullableString(input.toolCallId),
      payloadDigest,
    }),
    runId: context.runId,
    sequence: null,
    timestamp: typeof input.timestamp === "string" ? input.timestamp : now,
    agentId: asNullableString(input.agentId) ?? asNullableString(context.agentId),
    taskId: asNullableString(input.taskId) ?? asNullableString(context.taskId),
    worktreeId: asNullableString(input.worktreeId) ?? asNullableString(context.worktreeId),
    toolCallId: asNullableString(input.toolCallId),
    parentRunId: asNullableString(input.parentRunId) ?? asNullableString(context.parentRunId),
    parentTaskId: asNullableString(input.parentTaskId) ?? asNullableString(context.parentTaskId),
    action,
    paths,
    resources,
    result,
    derivedEffect: {
      status: effectStatus,
      changedPaths,
      resourceChanges,
      confidence: typeof effectInput.confidence === "number" && effectInput.confidence >= 0 && effectInput.confidence <= 1
        ? effectInput.confidence
        : effectStatus === "unknown" ? 0 : 0.5,
      gaps,
    },
  };
}
