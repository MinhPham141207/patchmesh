import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "./canonical.mjs";
import { validateTraceEvent } from "./validate.mjs";

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;

function diagnostic(code, message) {
  return { code, path: "/", message };
}

function safeRunId(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("runId must contain only letters, numbers, underscores, or hyphens");
  return runId;
}

async function readEvents(tracePath) {
  try {
    const content = await readFile(tracePath, "utf8");
    return content.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function withRunLock(evidenceRoot, runId, operation) {
  const lockDirectory = join(evidenceRoot, ".locks");
  const lockPath = join(lockDirectory, `${safeRunId(runId)}.lock`);
  await mkdir(lockDirectory, { recursive: true });
  const started = Date.now();
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() - started >= LOCK_TIMEOUT_MS) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function appendTraceEvent({ evidenceRoot, runId, event }) {
  const root = resolve(evidenceRoot);
  const traceDirectory = join(root, "trace");
  const tracePath = join(traceDirectory, `${safeRunId(runId)}.jsonl`);
  try {
    return await withRunLock(root, runId, async () => {
      await mkdir(traceDirectory, { recursive: true });
      const existing = await readEvents(tracePath);
      const existingEvent = existing.find((candidate) => candidate.eventId === event?.eventId);
      if (existingEvent !== undefined) {
        if (canonicalJson(existingEvent) === canonicalJson(event)) {
          return { accepted: true, duplicate: true, event: existingEvent, tracePath, diagnostic: null };
        }
        return { accepted: false, duplicate: false, event: null, tracePath, diagnostic: diagnostic("TRACE_EVENT_ID_CONFLICT", "event ID conflict") };
      }
      const nextSequence = existing.reduce((highest, candidate) => Math.max(highest, Number.isInteger(candidate.sequence) ? candidate.sequence : 0), 0) + 1;
      const storedEvent = event?.sequence === null || event?.sequence === undefined ? { ...event, sequence: nextSequence } : event;
      const validation = validateTraceEvent(storedEvent);
      if (validation.length > 0) {
        return { accepted: false, duplicate: false, event: null, tracePath, diagnostic: diagnostic(validation[0].code, validation[0].message) };
      }
      await appendFile(tracePath, `${canonicalJson(storedEvent)}\n`, "utf8");
      return { accepted: true, duplicate: false, event: storedEvent, tracePath, diagnostic: null };
    });
  } catch (error) {
    return {
      accepted: false,
      duplicate: false,
      event: null,
      tracePath,
      diagnostic: diagnostic(error?.code === "EEXIST" ? "TRACE_LOCK_TIMEOUT" : "TRACE_WRITE_FAILED", error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function readTraceEvents(tracePath) {
  return readEvents(tracePath);
}
