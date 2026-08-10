import { normalizeHookPayload } from "./normalize.mjs";
import { appendTraceEvent } from "./trace-store.mjs";
import { updateRunManifest } from "./manifest.mjs";
import { EFFECT_STATUSES, RESULT_STATUSES } from "./types.mjs";

function diagnostic(code, message) {
  return { code, path: "/", message };
}

function contextFrom(env, payload, now) {
  const get = (field, variable) => typeof payload?.[field] === "string" ? payload[field] : typeof env?.[variable] === "string" ? env[variable] : null;
  return {
    runId: get("runId", "PATCHMESH_RUN_ID"),
    repositoryRoot: typeof env?.PATCHMESH_REPOSITORY_ROOT === "string" ? env.PATCHMESH_REPOSITORY_ROOT : null,
    agentId: get("agentId", "PATCHMESH_AGENT_ID"),
    taskId: get("taskId", "PATCHMESH_TASK_ID"),
    worktreeId: get("worktreeId", "PATCHMESH_WORKTREE_ID"),
    parentRunId: get("parentRunId", "PATCHMESH_PARENT_RUN_ID"),
    parentTaskId: get("parentTaskId", "PATCHMESH_PARENT_TASK_ID"),
    now,
  };
}

function validateInput(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return diagnostic("TRACE_INPUT_INVALID", "hook payload must be an object");
  if (typeof payload.action !== "string" || payload.action.length === 0) return diagnostic("TRACE_INPUT_INVALID", "hook payload action is required");
  if (payload.result?.status !== undefined && !RESULT_STATUSES.has(payload.result.status)) return diagnostic("TRACE_INPUT_INVALID", "hook result status is invalid");
  if (payload.derivedEffect?.status !== undefined && !EFFECT_STATUSES.has(payload.derivedEffect.status)) return diagnostic("TRACE_INPUT_INVALID", "hook effect status is invalid");
  return null;
}

export async function recordHookPayload({ payload, env = process.env, now = new Date().toISOString() }) {
  const inputDiagnostic = validateInput(payload);
  const context = contextFrom(env, payload, now);
  if (inputDiagnostic !== null) return { accepted: false, duplicate: false, eventId: null, tracePath: null, diagnostic: inputDiagnostic };
  if (context.runId === null) return { accepted: false, duplicate: false, eventId: null, tracePath: null, diagnostic: diagnostic("TRACE_CONTEXT_INVALID", "PATCHMESH_RUN_ID is required") };
  const evidenceRoot = typeof env.PATCHMESH_EVIDENCE_ROOT === "string" ? env.PATCHMESH_EVIDENCE_ROOT : ".evidence";
  const event = normalizeHookPayload(payload, context);
  const result = await appendTraceEvent({ evidenceRoot, runId: context.runId, event });
  let diagnosticResult = result.diagnostic;
  if (result.accepted) {
    try {
      await updateRunManifest({ evidenceRoot, runId: context.runId, now });
    } catch (error) {
      diagnosticResult = diagnostic("TRACE_MANIFEST_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
  return {
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.event?.eventId ?? event.eventId,
    tracePath: result.tracePath,
    diagnostic: diagnosticResult,
  };
}
