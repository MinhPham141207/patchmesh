import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentIdForSession } from "./identity.js";
import { JOURNAL_FILENAME, parseJournalLine } from "./journal.js";
import { journalFilesFor } from "./inflight.js";

export const RECENT_WRITE_MINUTES = 30;

export interface RecentWrite {
  readonly at: string;
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly path: string;
}

export interface ReadRecentWritesOptions {
  readonly worktreeRoot: string;
  readonly directory?: string | undefined;
  readonly now?: (() => Date) | undefined;
  /** Skip this session's own entries. */
  readonly excludeSessionId?: string | undefined;
  /** Only entries strictly after this ISO timestamp (the delivery watermark). */
  readonly sinceIso?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Completed writes by other sessions inside the last `RECENT_WRITE_MINUTES`, newest first.

 * This is the data source the contention advisory actually needs: the in-flight view only
 * sees an agent caught mid-call, while most collisions are with work that finished minutes
 * ago. Reading is best effort - an unreadable journal contributes nothing rather than failing.
 */
export function readRecentWrites(options: ReadRecentWritesOptions): readonly RecentWrite[] {
  const journalPath = join(options.worktreeRoot, options.directory ?? ".patchmesh", JOURNAL_FILENAME);
  const now = (options.now ?? (() => new Date()))().getTime();
  const windowMs = RECENT_WRITE_MINUTES * 60_000;
  const writes: RecentWrite[] = [];
  for (const file of journalFilesFor(journalPath)) {
    let contents: string;
    try { contents = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of contents.split("\n")) {
      const entry = parseJournalLine(line);
      if (entry === null || !isRecord(entry.payload)) continue;
      const payload = entry.payload;
      if (payload["hook_event_name"] !== "PostToolUse") continue;
      if (options.excludeSessionId !== undefined && payload["session_id"] === options.excludeSessionId) continue;
      const toolInput = isRecord(payload["tool_input"]) ? payload["tool_input"] : {};
      const path = stringField(toolInput, "file_path");
      if (path === null) continue;
      const age = now - new Date(entry.at).getTime();
      if (age < 0 || age > windowMs) continue;
      if (options.sinceIso !== undefined && entry.at <= options.sinceIso) continue;
      const sessionId = stringField(payload, "session_id");
      writes.push({
        at: entry.at,
        sessionId,
        agentId: sessionId === null ? null : agentIdForSession(sessionId),
        hostToolName: stringField(payload, "tool_name") ?? "unknown",
        path,
      });
    }
  }
  writes.sort((left, right) => right.at.localeCompare(left.at)); // newest first
  return writes.slice(0, 50);
}

export function watermarkPathFor(worktreeRoot: string, directory: string, sessionId: string): string {
  return join(worktreeRoot, directory ?? ".patchmesh", "cursors", `${sessionId}.json`);
}

/**
 * The session's delivery cursor, arming at `nowIso` on first contact.
 *
 * Arming is a side effect on purpose: a brand-new session must never be handed everything
 * the last half hour produced, only what happens after it first looked.
 */
export function readWatermark(path: string, nowIso: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { watermark?: unknown };
    if (typeof parsed.watermark === "string" && !Number.isNaN(Date.parse(parsed.watermark))) {
      return parsed.watermark;
    }
  } catch {
    // Absent or corrupt: arm at now. History is never dumped on first contact.
  }
  advanceWatermark(path, nowIso);
  return nowIso;
}

/** Atomic replace so a concurrent reader never sees a torn cursor. */
export function advanceWatermark(path: string, at: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ watermark: at }), "utf8");
    renameSync(temporary, path);
  } catch {
    try { writeFileSync(path, JSON.stringify({ watermark: at }), "utf8"); } catch { /* advisory-only */ }
  }
}
