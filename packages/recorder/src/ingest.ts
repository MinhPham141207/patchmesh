import { execFileSync } from "node:child_process";
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
import type { AgentId, CorrelationId, TaskId } from "patchmesh-protocol";
import { canonicalDigest, SqliteEventStore } from "patchmesh-storage";
import { observationRequestId, observeTurnEffects, type EffectAttributionCall } from "./effects.js";
import { buildHookEvents, declaredLogicalPath, type HookPayload } from "./hook.js";
import { agentIdForSession, createCorrelationId, createEventId, resolveRepositoryIdentity, taskIdForTurn } from "./identity.js";
import { deriveAnalysisEvents, latestSymbolVersions } from "./symbols.js";
import { ABANDONED_AFTER_MS } from "./inflight.js";
import { appendJournalEntry, parseJournalLine, type JournalEntry } from "./journal.js";
import { resolveProvenanceHost } from "./source.js";
import { snapshotPathFor } from "./record.js";
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
  /**
   * The calls this drain recorded, with the window each occupied, so observed changes can be
   * matched to the call that was running when they happened.
   */
  readonly calls: readonly EffectAttributionCall[];
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
    return { ingested: 0, skipped: 0, turns: 0, closedTurn: null, calls: [], ledgerPath: null };
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
  // Windows of the calls drained here, handed to effect observation so a change can name the
  // call it happened inside rather than only the turn it happened during.
  const calls: EffectAttributionCall[] = [];

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
        calls,
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

  return { ingested, skipped, turns, closedTurn: soleTurnOf(turnTasks, activeSessions), calls, ledgerPath };
}

/**
 * Propagate task attribution within correlation groups that have exactly one task.
 *
 * Where a correlation has exactly one non-null taskId among its events, that task is
 * assigned to every null-attribution event in the group. Groups with zero tasks or
 * multiple tasks stay unchanged — the former is honest absence, the latter is
 * ambiguous.
 *
 * Events are stored as JSON blobs (`canonical_event`) and reconstructed from that blob
 * on read. Updating only the `task_id` column would leave the JSON unchanged, so this
 * function also patches the JSON and recomputes the content digest.
 */
export function backfillAttribution(ledgerPath: string): void {
  const store = SqliteEventStore.open(ledgerPath);
  try {
    // Find correlation groups with exactly one distinct non-null task.
    const groups = store.handle.prepare(`
      SELECT correlation_id, GROUP_CONCAT(DISTINCT task_id) as tasks
      FROM events
      WHERE correlation_id IS NOT NULL
      GROUP BY correlation_id
      HAVING COUNT(DISTINCT task_id) = 1
         AND MAX(task_id) IS NOT NULL
    `).all() as Array<{ correlation_id: string; tasks: string }>;

    const updateTask = store.handle.prepare(`
      UPDATE events SET task_id = ?
      WHERE event_id = ?
    `);
    const updateBlob = store.handle.prepare(`
      UPDATE events SET canonical_event = ?, content_digest = ?
      WHERE event_id = ?
    `);

    for (const group of groups) {
      const task = group.tasks;

      // Find null-attribution rows in this correlation group.
      const rows = store.handle.prepare(`
        SELECT event_id, canonical_event
        FROM events
        WHERE correlation_id = ? AND task_id IS NULL
      `).all(group.correlation_id) as Array<{ event_id: string; canonical_event: Uint8Array | string }>;

      for (const row of rows) {
        // Patch the task_id column.
        updateTask.run(task, row.event_id);

        // Patch the canonical_event JSON blob so read() returns the updated taskId.
        const bytes = typeof row.canonical_event === "string"
          ? new TextEncoder().encode(row.canonical_event)
          : new Uint8Array(row.canonical_event);
        const event = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        event.taskId = task;
        const patched = JSON.stringify(event);
        const digest = canonicalDigest(event);
        updateBlob.run(patched, digest, row.event_id);
      }
    }
  } finally {
    store.close();
  }
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

export interface EmitTaskCompletedOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly turn: { readonly agentId: AgentId | null; readonly taskId: TaskId | null };
}

/**
 * Append a `task.completed` event for the turn that just closed.
 *
 * The event carries the files changed during the turn (from `file.changed` events already
 * in the store) and the git HEAD as `baseRevision`. When the store cannot be read or the
 * git call fails, the event is still emitted with degraded fields rather than skipped —
 * a partial answer beats silence.
 */
export function emitTaskCompleted(options: EmitTaskCompletedOptions): void {
  const { worktreeRoot, ledgerPath, turn } = options;
  const identity = resolveRepositoryIdentity(worktreeRoot);

  let baseRevision = "0000000000000000000000000000000000000000";
  try {
    baseRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreeRoot,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    // Git unavailable or not a repo — degrade gracefully.
  }

  const store = SqliteEventStore.open(ledgerPath);
  try {
    const resourceIdRows = turn.taskId !== null
      ? store.handle.prepare(`
          SELECT canonical_event
          FROM events
          WHERE event_type = 'file.changed'
            AND task_id = ?
        `).all(turn.taskId) as Array<{ canonical_event: Uint8Array | string }>
      : [];

    const resourceIds = resourceIdRows
      .map((row) => {
        const bytes = typeof row.canonical_event === "string"
          ? new TextEncoder().encode(row.canonical_event)
          : new Uint8Array(row.canonical_event);
        const event = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const payload = event.payload as Record<string, unknown> | undefined;
        const resource = payload?.resource as Record<string, unknown> | undefined;
        return typeof resource?.resourceId === "string" ? resource.resourceId : null;
      })
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    let correlationId = createCorrelationId();
    if (turn.taskId !== null && resourceIds.length > 0) {
      const row = store.handle.prepare(`
        SELECT correlation_id FROM events
        WHERE event_type = 'file.changed' AND task_id = ?
        LIMIT 1
      `).get(turn.taskId) as { correlation_id: string } | undefined;
      if (row !== undefined) {
        correlationId = row.correlation_id as CorrelationId;
      }
    }

    const workProductId = `work_${canonicalDigest(turn.taskId ?? "unattributed").slice(0, 32)}`;
    const targetSnapshotId = `snapshot_${canonicalDigest(snapshotPathFor(worktreeRoot))}`;

    const event = {
      schemaVersion: 1 as const,
      eventId: createEventId(),
      eventType: "task.completed" as const,
      source: {
        kind: "watcher" as const,
        sourceId: "source_patchmesh_observer",
        instanceId: identity.worktreeId.slice("wt_".length),
      },
      timestamp: new Date().toISOString(),
      repositoryId: identity.repositoryId,
      workspaceId: identity.workspaceId,
      worktreeId: identity.worktreeId,
      agentId: turn.agentId,
      taskId: turn.taskId,
      correlationId,
      causationId: null,
      sourceSequence: null,
      payload: {
        workProductId,
        baseRevision,
        targetSnapshotId,
        resourceIds,
      },
    };

    store.appendAtomic([event]);
  } finally {
    store.close();
  }
}

export interface RecordTurnEffectsOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly snapshotPath: string;
  readonly turn: { readonly agentId: AgentId | null; readonly taskId: TaskId | null } | null;
  /** Call windows from the drain that just ran, for matching changes to calls. */
  readonly calls?: readonly EffectAttributionCall[] | undefined;
  /**
   * Clock for the observed changes. Defaults to the real one, which is right in production.
   *
   * Exposed because `ingestJournal` already takes one and this did not, so a test that pinned
   * its calls to a fixture clock still got its file changes stamped with the wall clock. The
   * two clocks then disagreed by years, and any assertion about what happened before what was
   * really an assertion about which line of the test ran first.
   */
  readonly now?: (() => string) | undefined;
  /** Stable sidecar transaction id; derived from turn/calls when omitted. */
  readonly requestId?: string | undefined;
}

interface PersistedObservationRequest {
  readonly requestId: string;
  readonly turn: { readonly agentId: AgentId | null; readonly taskId: TaskId | null } | null;
  readonly calls: readonly EffectAttributionCall[];
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
  const requestStatePath = join(options.worktreeRoot, ".patchmesh", "observation", "recorder-request.json");
  const markerExisted = existsSync(requestStatePath);
  const sidecarStatePath = join(options.worktreeRoot, ".patchmesh", "observation", "sidecar.json");
  const derivedRequestId = options.requestId ?? observationRequestId({ identity, agentId: options.turn?.agentId ?? null, taskId: options.turn?.taskId ?? null, calls: options.calls });
  const persisted = options.requestId === undefined
    ? readOrCreateObservationRequest(requestStatePath, {
      requestId: derivedRequestId,
      turn: options.turn,
      calls: options.calls ?? [],
    })
    : null;
  const requestId = persisted?.requestId ?? options.requestId ?? derivedRequestId;
  const turn = persisted?.turn ?? options.turn;
  const calls = persisted?.calls ?? options.calls;
  const { events, baselineOnly, acknowledge } = await observeTurnEffects({
    identity,
    snapshotPath: options.snapshotPath,
    // `file.changed` is a watcher's claim about the filesystem, not a gateway's claim about a
    // call it proxied, and validation holds effects to that.
    source: {
      kind: "watcher",
      sourceId: "source_patchmesh_observer",
      instanceId: identity.worktreeId.slice("wt_".length),
    },
    agentId: turn?.agentId ?? null,
    taskId: turn?.taskId ?? null,
    calls,
    requestId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (events.length > 0) {
    mkdirSync(dirname(options.ledgerPath), { recursive: true });
    const store = SqliteEventStore.open(options.ledgerPath);
    try {
      // One append per change: a file that cannot be represented must not discard the rest.
      for (const event of events) store.appendAtomic([event]);

      // Symbols are derived after the changes are durable, and appended separately. Each one
      // names its `file.changed` as causal parent, so the parent must already be in the ledger;
      // and deriving them cannot be allowed to cost the observations, which are the thing this
      // function exists to record. A parse failure loses symbols, never file changes.
      try {
        const symbols = deriveAnalysisEvents({
          identity,
          source: {
            kind: "watcher",
            sourceId: "source_patchmesh_observer",
            instanceId: identity.worktreeId.slice("wt_".length),
          },
          changes: events,
          priorSymbolVersions: latestSymbolVersions(store.read({ eventTypes: ["symbol.changed"] })),
          now: options.now ?? (() => new Date().toISOString()),
          nextEventId: () => createEventId(),
        });
        for (const symbol of symbols) store.appendAtomic([symbol]);
      } catch {
        // Deliberately silent, like every other recorder failure: this runs after a session
        // ends and has no one to report to. The observations above are already committed.
      }
    } finally {
      store.close();
    }
  }
  // Commit the sidecar cursor even when this transaction had no file changes (including the
  // initial baseline); otherwise every subsequent drain would replay the same window.
  if (acknowledge !== undefined) await acknowledge();
  // A pre-existing marker may describe a prepared sidecar transaction. Keep it when IPC is
  // temporarily unavailable; clearing it would strand that transaction and lose crash retry.
  // A marker created during a legacy fallback is safe to clear when no sidecar state exists.
  if (acknowledge !== undefined || !markerExisted || !existsSync(sidecarStatePath)) {
    clearObservationRequest(requestStatePath, requestId);
  }
  return { changed: events.length, baselineOnly };
}

function readOrCreateObservationRequest(path: string, fallback: PersistedObservationRequest): PersistedObservationRequest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPersistedObservationRequest(parsed)) return parsed;
    if (typeof parsed === "string" && parsed !== "") return { ...fallback, requestId: parsed };
  } catch {
    // Create below.
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(fallback)}\n`, { encoding: "utf8", flag: "wx" });
    return fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isPersistedObservationRequest(parsed)) return parsed;
        if (typeof parsed === "string" && parsed !== "") return { ...fallback, requestId: parsed };
      } catch {
        // Fall through to the deterministic id.
      }
    }
    return fallback;
  }
}

function isPersistedObservationRequest(value: unknown): value is PersistedObservationRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const turn = candidate.turn;
  const validTurn = turn === null || (typeof turn === "object" && turn !== null && !Array.isArray(turn)
    && (typeof (turn as Record<string, unknown>).agentId === "string" || (turn as Record<string, unknown>).agentId === null)
    && (typeof (turn as Record<string, unknown>).taskId === "string" || (turn as Record<string, unknown>).taskId === null));
  const validCalls = Array.isArray(candidate.calls) && candidate.calls.every((call) => {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return false;
    const value = call as Record<string, unknown>;
    return typeof value.completionEventId === "string"
      && typeof value.correlationId === "string"
      && (typeof value.agentId === "string" || value.agentId === null)
      && (typeof value.taskId === "string" || value.taskId === null)
      && typeof value.startedAtMs === "number" && Number.isFinite(value.startedAtMs)
      && typeof value.completedAtMs === "number" && Number.isFinite(value.completedAtMs)
      && (typeof value.declaredPath === "string" || value.declaredPath === null);
  });
  return typeof candidate.requestId === "string" && candidate.requestId !== "" && validTurn && validCalls;
}

function clearObservationRequest(path: string, requestId: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if ((isPersistedObservationRequest(parsed) && parsed.requestId === requestId) || parsed === requestId) rmSync(path, { force: true });
  } catch {
    // Best effort; an old id is harmless after sidecar acknowledgement.
  }
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
  /** Collects each recorded call's window, for matching observed changes against. */
  readonly calls: EffectAttributionCall[];
}

function drainClaim(options: DrainClaimOptions): { ingested: number; skipped: number; turns: number } {
  const { claimedPath, store, worktreeRoot, unprocessed, turnTasks, activeSessions, unfinished, calls } = options;
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
    // The start is read before it is discarded: it is the only record of when this call began,
    // and the window it opens is what lets an observed change name a call rather than a turn.
    const startedAt = completedCallId === null ? undefined : unfinished.get(completedCallId)?.at;
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
      const journalPayload = entry.payload as HookPayload;
      const sessionId = sessionIdOf(entry.payload);
      if (sessionId !== null) activeSessions.add(sessionId);
      const { requested, completed } = buildHookEvents({
        payload: journalPayload,
        worktreeRoot,
        now: () => entry.at,
        turnTaskId: sessionId === null ? null : ((turnTasks.get(sessionId)?.taskId ?? null) as TaskId | null),
      });
      store.appendAtomic([requested, completed]);
      // With no start there is no window, so completion bounds both ends and effectively
      // nothing matches. That is the honest degradation when `PreToolUse` is not installed.
      calls.push({
        completionEventId: completed.eventId,
        correlationId: completed.correlationId,
        agentId: completed.agentId,
        taskId: completed.taskId,
        startedAtMs: new Date(startedAt ?? entry.at).getTime(),
        completedAtMs: new Date(entry.at).getTime(),
        // What the call's own input declared, normalized as a change's path is, so a change
        // can name this call even where the mtime join is ambiguous or unanswerable.
        declaredPath: declaredLogicalPath(
          worktreeRoot,
          resolveProvenanceHost(journalPayload.patchmesh_host),
          typeof journalPayload.tool_name === "string" ? journalPayload.tool_name : "",
          journalPayload.tool_input,
        ),
      });
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

