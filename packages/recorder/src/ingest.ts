import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { SqliteEventStore } from "@patchmesh/storage";
import { buildHookEvents, type HookPayload } from "./hook.js";
import { parseJournalLine } from "./journal.js";

export interface IngestResult {
  readonly ingested: number;
  readonly skipped: number;
  readonly ledgerPath: string | null;
}

export interface IngestJournalOptions {
  readonly worktreeRoot: string;
  readonly journalPath: string;
  readonly ledgerPath: string;
}

/** Suffix marking a journal that some ingest has taken responsibility for draining. */
const PROCESSING_SUFFIX = ".processing";

/**
 * A claim younger than this is presumed to belong to a healthy ingest still running. A drain
 * is milliseconds of work, so a claim this old means its owner died holding it.
 */
const STALE_CLAIM_MS = 60_000;

/**
 * Drain the journal into validated protocol events.
 *
 * The journal is first renamed aside, so a hook writing concurrently starts a fresh file and
 * no entry is observed twice. Each entry is appended as its own atomic request and completion
 * pair: one malformed entry is skipped rather than discarding the batch, and a reader never
 * sees a completion whose request is missing.
 *
 * A claim that was never drained is adopted by a later run. Renaming aside is what makes
 * concurrent hooks safe, but it also means a crash between the rename and the drain moves
 * observations somewhere nothing would ever look again - and because `ingest-bin` deliberately
 * exits 0, that loss would be silent.
 */
export function ingestJournal(options: IngestJournalOptions): IngestResult {
  const { journalPath, ledgerPath, worktreeRoot } = options;

  const claimedPaths = [...claimJournal(journalPath), ...adoptStaleClaims(journalPath)];
  if (claimedPaths.length === 0) return { ingested: 0, skipped: 0, ledgerPath: null };

  let ingested = 0;
  let skipped = 0;
  const unprocessed: string[] = [];

  mkdirSync(dirname(ledgerPath), { recursive: true });
  // Opening the store happens inside the claims' lifetime: a locked or corrupt ledger throws
  // here, and the claims stay on disk for the next run to adopt rather than being stranded.
  const store = SqliteEventStore.open(ledgerPath);
  try {
    for (const claimedPath of claimedPaths) {
      const drained = drainClaim({ claimedPath, store, worktreeRoot, unprocessed });
      ingested += drained.ingested;
      skipped += drained.skipped;
    }
  } finally {
    store.close();
  }

  if (unprocessed.length > 0) {
    writeFileSync(`${claimedPaths[0]!}.rejected`, `${unprocessed.join("\n")}\n`, "utf8");
  }
  for (const claimedPath of claimedPaths) rmSync(claimedPath, { force: true });

  return { ingested, skipped, ledgerPath };
}

interface DrainClaimOptions {
  readonly claimedPath: string;
  readonly store: SqliteEventStore;
  readonly worktreeRoot: string;
  readonly unprocessed: string[];
}

function drainClaim(options: DrainClaimOptions): { ingested: number; skipped: number } {
  const { claimedPath, store, worktreeRoot, unprocessed } = options;
  let lines: string[];
  try {
    lines = readFileSync(claimedPath, "utf8").split("\n");
  } catch {
    return { ingested: 0, skipped: 0 };
  }

  let ingested = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const entry = parseJournalLine(line);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    try {
      const { requested, completed } = buildHookEvents({
        payload: entry.payload as HookPayload,
        worktreeRoot,
        now: () => entry.at,
      });
      store.appendAtomic([requested, completed]);
      ingested += 1;
    } catch {
      // A payload this build cannot represent is retained, not silently dropped, so a later
      // recorder version can still ingest it.
      unprocessed.push(line);
      skipped += 1;
    }
  }
  return { ingested, skipped };
}

/** Rename the live journal aside, returning the claim, or nothing when there was none to take. */
function claimJournal(journalPath: string): string[] {
  if (!existsSync(journalPath)) return [];
  const claimedPath = `${journalPath}.${process.pid}.${Date.now()}${PROCESSING_SUFFIX}`;
  try {
    renameSync(journalPath, claimedPath);
  } catch {
    // Another ingest already claimed it, or a writer holds it open. Retry next time.
    return [];
  }
  return [claimedPath];
}

/**
 * Take over claims abandoned by an ingest that never finished.
 *
 * Ownership transfers by renaming again: the rename is atomic, so of two ingests racing for
 * one abandoned claim exactly one wins and the loser simply finds it gone. The age check is
 * what keeps this from stealing work from a healthy ingest that is still draining.
 */
function adoptStaleClaims(journalPath: string): string[] {
  const directory = dirname(journalPath);
  const prefix = `${basename(journalPath)}.`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const adopted: string[] = [];
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(PROCESSING_SUFFIX)) continue;
    const stalePath = join(directory, entry);
    try {
      if (now - statSync(stalePath).mtimeMs < STALE_CLAIM_MS) continue;
      const adoptedPath = `${journalPath}.${process.pid}.${now}.${adopted.length}${PROCESSING_SUFFIX}`;
      renameSync(stalePath, adoptedPath);
      adopted.push(adoptedPath);
    } catch {
      // Lost the race, or the file vanished. Another ingest owns it now.
    }
  }
  return adopted;
}

