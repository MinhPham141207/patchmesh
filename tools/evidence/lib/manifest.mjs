import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "./canonical.mjs";
import { readTraceEvents } from "./trace-store.mjs";
import { RECORDER_VERSION } from "./types.mjs";

function finalStatus(events) {
  const terminal = [...events].reverse().find((event) => event.action === "session.stop" || event.action === "subagent.stop");
  if (terminal?.result.status === "failed") return "failed";
  if (terminal?.result.status === "interrupted") return "interrupted";
  if (terminal?.result.status === "succeeded") return "succeeded";
  return events.length === 0 ? "unknown" : "running";
}

export async function updateRunManifest({ evidenceRoot, runId, now = new Date().toISOString() }) {
  const root = resolve(evidenceRoot);
  const tracePath = join(root, "trace", `${runId}.jsonl`);
  const events = await readTraceEvents(tracePath);
  const first = events[0] ?? null;
  const terminal = [...events].reverse().find((event) => event.action === "session.stop" || event.action === "subagent.stop");
  const manifest = {
    schemaVersion: 1,
    recorderVersion: RECORDER_VERSION,
    runId,
    parentRunId: first?.parentRunId ?? null,
    parentTaskId: first?.parentTaskId ?? null,
    agentId: first?.agentId ?? null,
    taskId: first?.taskId ?? null,
    worktreeId: first?.worktreeId ?? null,
    startedAt: first?.timestamp ?? now,
    endedAt: terminal?.timestamp ?? null,
    status: finalStatus(events),
    eventCount: events.length,
    firstSequence: events[0]?.sequence ?? null,
    lastSequence: events.at(-1)?.sequence ?? null,
    traceDigest: events.length === 0 ? null : sha256(canonicalJson(events)),
    errors: events.filter((event) => event.action === "trace.error").map((event) => event.result.errorClass ?? "trace.error"),
    gaps: events.flatMap((event) => event.derivedEffect.gaps),
  };
  const manifestDirectory = join(root, "runs");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(join(manifestDirectory, `${runId}.manifest.json`), `${canonicalJson(manifest)}\n`, "utf8");
  return manifest;
}
