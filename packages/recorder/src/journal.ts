import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const JOURNAL_FILENAME = "journal.ndjson";
export const JOURNAL_VERSION = 1;

export function journalPathFor(worktreeRoot: string, directory: string): string {
  return join(worktreeRoot, directory, JOURNAL_FILENAME);
}

export interface JournalEntry {
  readonly v: number;
  /** Captured when the tool call completed, not when it was later ingested. */
  readonly at: string;
  readonly payload: unknown;
}

export function parseJournalLine(line: string): JournalEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed) as JournalEntry;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.v !== JOURNAL_VERSION || typeof parsed.at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Append one already-redacted hook payload to the journal.
 *
 * Callers must pass the output of `redactHookPayload`; this function serializes whatever it
 * is given, so handing it a raw host payload writes secrets to disk.
 *
 * This is the only work done on the agent's tool-call path, so it deliberately imports
 * nothing beyond `node:fs`. Validating a payload into protocol events costs roughly
 * 400ms of Ajv import and schema compilation per process, which is unacceptable per tool
 * call; that cost is paid once per session by `ingestJournal` instead. Re-serializing
 * through JSON guarantees one line per entry even when the payload contains newlines.
 */
export function appendJournalEntry(journalPath: string, payload: unknown, at: string): void {
  const entry: JournalEntry = { v: JOURNAL_VERSION, at, payload };
  mkdirSync(dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
}
