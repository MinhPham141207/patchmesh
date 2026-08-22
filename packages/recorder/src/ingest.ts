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
import type { TaskId } from "@patchmesh/protocol";
import { SqliteEventStore } from "@patchmesh/storage";
import type { AgentId } from "@patchmesh/protocol";
import { observeTurnEffects } from "./effects.js";
import { buildHookEvents, type HookPayload } from "./hook.js";
import { agentIdForSession, resolveRepositoryIdentity, taskIdForTurn } from "./identity.js";
import { ABANDONED_AFTER_MS } from "./inflight.js";
import { appendJournalEntry, parseJournalLine, type JournalEntry } from "./journal.js";
import {
  isCallStart,
  isTurnMarker,
  type OpenTurn,
  readTurnState,
  TURN_STATE_FILENAME,
  turnFieldsOf,
  writeTurnState,
} from "./turn.js";

export interface IngestResult {
  readonly ingested: number;
  readonly skipped: number;
  /** Turn boundaries replayed. These open a task; they are not themselves recorded calls. */
  readonly turns: number;
  /**
   * The single turn this drain closed, when it could name exactly one.
   *
   * Null when no marker was seen or when more than one session recorded into this repository,
   * because effects observed over a window two sessions shared belong to neither alone.
   */
  readonly closedTurn: { readonly agentId: AgentId | null; readonly taskId: TaskId | null } | null;
  readonly ledgerPath: string | null;
}

export interface IngestJournalOptions {
  readonly worktreeRoot: string;
  readonly journalPath: string;
  readonly ledgerPath: string;
  /** Where turns left open by the previous drain are kept. Defaults beside the journal. */
  readonly turnStatePath?: string | undefined;
  /**
   * Clock used to decide which unfinished calls are still worth carrying forward. Only tests
   * supply it; a real drain reads the wall clock.
   */
  readonly now?: (() => Date) | undefined;
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
  const now = options.now ?? (() => new Date());
  const turnStatePath = options.turnStatePath ?? join(dirname(journalPath), TURN_STATE_FILENAME);

  const claimedPaths = [...claimJournal(journalPath), ...adoptStaleClaims(journalPath)];
  if (claimedPaths.length === 0) {
    return { ingested: 0, skipped: 0, turns: 0, closedTurn: null, ledgerPath: null };
  }

  let ingested = 0;
  let skipped = 0;
  let turns = 0;
  const unprocessed: string[] = [];
  // Turn state is per session, because two sessions recording into one repository interleave
  // in the journal and each one's marker must only claim its own calls. It is seeded from the
  // previous drain because a turn does not reliably end where a drain ends: the marker is
  // journalled once and the calls many times, so a turn split across two drains would leave
  // every call in the second one unattributed. See `readTurnState`.
  const turnTasks = readTurnState(turnStatePath, now());
  // Which sessions this drain actually saw work from, marker or call. Attribution may reach
  // back into a previous drain's turns; deciding whose effects these are may not.
  const activeSessions = new Set<string>();
  // A call that is still running when another session drains the shared journal must survive
  // that drain. Without this, one agent's Stop erases the very in-flight work a second agent
  // needs to see, which is precisely when a collision guard has to work.
  const unfinished = new Map<string, JournalEntry>();

  mkdirSync(dirname(ledgerPath), { recursive: true });
  // Opening the store happens inside the claims' lifetime: a locked or corrupt ledger throws
  // here, and the claims stay on disk for the next run to adopt rather than being stranded.
  const store = SqliteEventStore.open(ledgerPath);
  try {
    for (const claimedPath of claimedPaths) {
      const drained = drainClaim({
        claimedPath,
        store,
        worktreeRoot,
        unprocessed,
        turnTasks,
        activeSessions,
        unfinished,
      });
      ingested += drained.ingested;
      skipped += drained.skipped;
      turns += drained.turns;
    }
  } finally {
    store.close();
  }

  if (unprocessed.length > 0) {
    writeFileSync(`${claimedPaths[0]!}.rejected`, `${unprocessed.join("\n")}\n`, "utf8");
  }
  for (const claimedPath of claimedPaths) rmSync(claimedPath, { force: true });
  carryForward(journalPath, unfinished, now());
  writeTurnState(turnStatePath, turnTasks, now());

  return { ingested, skipped, turns, closedTurn: soleTurnOf(turnTasks, activeSessions), ledgerPath };
}

/**
 * The one turn a drain closed, or nothing when it closed more or fewer than one.
 *
 * Effects are observed over the whole window between drains, so they can only be attributed
 * when that window belonged to a single turn. Two sessions working in one repository share
 * the window, and a file that changed inside it belongs to neither of them in particular.
 *
 * Only sessions that recorded something in *this* drain are counted. Carried-forward turn
 * state exists to attribute calls to the turn that produced them; a session that was merely
 * still open has not shown it did anything in this window, and counting it would either steal
 * another session's effects or suppress attribution entirely.
 */
function soleTurnOf(
  turnTasks: ReadonlyMap<string, OpenTurn>,
  activeSessions: ReadonlySet<string>,
): { agentId: AgentId | null; taskId: TaskId | null } | null {
  if (activeSessions.size !== 1) return null;
  const sessionId = [...activeSessions][0]!;
  const turn = turnTasks.get(sessionId);
  if (turn === undefined) return null;
  return { agentId: agentIdForSession(sessionId), taskId: turn.taskId as TaskId | null };
}

export interface RecordTurnEffectsOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
  readonly turn: { readonly agentId: AgentId | null; readonly taskId: TaskId | null } | null;
}

export interface RecordTurnEffectsResult {
  readonly changed: number;
  /** True when this run only established a baseline, which is the first run in a checkout. */
  readonly baselineOnly: boolean;
}

/**
 * Observe what changed on disk since the last drain and record it against the closed turn.
 *
 * Kept separate from `ingestJournal` because it is a separate claim. Draining says which calls
 * were made; this says which files differ, and the two are joined only by the turn they share.
 * It also runs after the journal is safely drained, so a failure here cannot strand recorded
 * calls - the ledger keeps the calls it already has and simply gains no effects this round.
 */
export async function recordTurnEffects(options: RecordTurnEffectsOptions): Promise<RecordTurnEffectsResult> {
  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  const { events, baselineOnly } = await observeTurnEffects({
    identity,
    snapshotPath: options.snapshotPath,
    // `file.changed` is a watcher's claim about the filesystem, not a gateway's claim about a
    // call it proxied, and validation holds effects to that.
    source: {
      kind: "watcher",
      sourceId: "source_patchmesh_observer",
      instanceId: identity.worktreeId.slice("wt_".length),
    },
    agentId: options.turn?.agentId ?? null,
    taskId: options.turn?.taskId ?? null,
  });

  if (events.length > 0) {
    mkdirSync(dirname(options.ledgerPath), { recursive: true });
    const store = SqliteEventStore.open(options.ledgerPath);
    try {
      // One append per change: a file that cannot be represented must not discard the rest.
      for (const event of events) store.appendAtomic([event]);
    } finally {
      store.close();
    }
  }
  return { changed: events.length, baselineOnly };
}

interface DrainClaimOptions {
  readonly claimedPath: string;
  readonly store: SqliteEventStore;
  readonly worktreeRoot: string;
  readonly unprocessed: string[];
  /** Session id to the task its most recent turn opened. Mutated as markers are replayed. */
  readonly turnTasks: Map<string, OpenTurn>;
  /** Sessions observed working in this drain, which is what effects may be attributed to. */
  readonly activeSessions: Set<string>;
  /** Starts seen with no completion yet, carried back to the live journal after the drain. */
  readonly unfinished: Map<string, JournalEntry>;
}

function drainClaim(options: DrainClaimOptions): { ingested: number; skipped: number; turns: number } {
  const { claimedPath, store, worktreeRoot, unprocessed, turnTasks, activeSessions, unfinished } = options;
  let lines: string[];
  try {
    lines = readFileSync(claimedPath, "utf8").split("\n");
  } catch {
    return { ingested: 0, skipped: 0, turns: 0 };
  }

  let ingested = 0;
  let skipped = 0;
  let turns = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const entry = parseJournalLine(line);
    if (entry === null) {
      skipped += 1;
      continue;
    }
    // A start is the live in-flight signal, not a record of work done. The same call arrives
    // again as PostToolUse, so recording both would double every call in the ledger. It is
    // remembered rather than dropped: a start whose completion never arrived belongs to a call
    // still running, and draining the journal must not make it disappear.
    if (isCallStart(entry.payload)) {
      const callId = callIdOf(entry.payload);
      if (callId !== null) unfinished.set(callId, entry);
      continue;
    }
    const completedCallId = callIdOf(entry.payload);
    if (completedCallId !== null) unfinished.delete(completedCallId);

    // A turn boundary is state, not a call. It carries no tool, so building events from it
    // would raise and file a well-formed entry as unrepresentable.
    if (isTurnMarker(entry.payload)) {
      const { sessionId, promptId } = turnFieldsOf(entry.payload);
      if (sessionId !== null) {
        turnTasks.set(sessionId, { taskId: taskIdForTurn(sessionId, promptId, entry.at), at: entry.at });
        activeSessions.add(sessionId);
        turns += 1;
      }
      continue;
    }

    try {
      const sessionId = sessionIdOf(entry.payload);
      if (sessionId !== null) activeSessions.add(sessionId);
      const { requested, completed } = buildHookEvents({
        payload: entry.payload as HookPayload,
        worktreeRoot,
        now: () => entry.at,
        turnTaskId: sessionId === null ? null : ((turnTasks.get(sessionId)?.taskId ?? null) as TaskId | null),
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
  return { ingested, skipped, turns };
}

/**
 * Return still-running starts to the live journal.
 *
 * Entries older than the abandoned cutoff are left behind: a session killed mid-call would
 * otherwise be carried forever, growing the journal and making a dead call look live.
 */
function carryForward(journalPath: string, unfinished: ReadonlyMap<string, JournalEntry>, now: Date): void {
  const oldest = now.getTime() - ABANDONED_AFTER_MS;
  for (const entry of unfinished.values()) {
    if (new Date(entry.at).getTime() < oldest) continue;
    try {
      appendJournalEntry(journalPath, entry.payload, entry.at);
    } catch {
      // The in-flight view loses one entry. Never worth failing an ingest that already
      // succeeded in draining real work.
    }
  }
}

/** The host's own identifier for one call, which is what pairs a start with its completion. */
function callIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)["tool_use_id"];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Which session produced one journalled call, so its turn can be found. */
function sessionIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)["session_id"];
  return typeof value === "string" && value !== "" ? value : null;
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

