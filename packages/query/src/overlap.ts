import type { ProtocolEvent } from "patchmesh-protocol";
import {
  ignoredByRepository,
  logicalPathFor,
  readInFlightCalls,
  resolveRepositoryIdentity,
  resourceIdForPath,
} from "patchmesh-recorder";
import { readWindowCached } from "patchmesh-storage";
import { describeWindow } from "./label.js";
import { idShortener } from "./short-id.js";

/**
 * Where two units of work touched the same file.
 *
 * This is the first question PatchMesh answers that is about a relationship rather than a
 * record, and it was unanswerable until two things existed. Ordinary work had no task, so
 * every call in a session collapsed into one unit and nothing could overlap with anything.
 * And a file written by a shell command was bound to no resource, so the file most likely to
 * be contested was the file least likely to be recorded.
 *
 * It still reports rather than judges. Two tasks changing one file may be one agent finishing
 * what another started, a rebase, or genuinely divergent work; the ledger holds paths and
 * content hashes, not intent, so it cannot tell those apart and does not try. What it can say
 * without guessing is: these two units of work both changed this file, here is when.
 *
 * Two tasks alone are not enough to say that, though, and the first version said it anyway.
 * Run live against this repository it returned eight files - every one of them a sibling
 * tool's SQLite cache, and every one a single agent's own two consecutive turns four minutes
 * apart. Sequence is not overlap, and cache churn is not work. Both are fixed below, because
 * an advisory tool that is wrong eight times out of eight costs the reader more context than
 * it saves them and teaches them to stop reading it.
 */
export interface OverlappingTask {
  readonly taskId: string;
  readonly agentId: string | null;
  readonly at: string;
  readonly changeKind: string;
  /** Which checkout the change was observed in. Two worktrees are two workers by definition. */
  readonly worktreeId: string | null;
}

/**
 * Why this file counts as contested rather than merely edited twice.
 *
 * Carried on the finding rather than left implicit, because an advisory that says "these two
 * touched the same file" is a claim the reader has to take on trust, and one that says "the
 * first worker was still going an hour after the second wrote it" is a claim they can check.
 */
export interface ContentionEvidence {
  /** The worker who wrote first and had not finished. */
  readonly earlierWorkerAgentId: string | null;
  readonly earlierWriteAt: string;
  /** When that worker was last observed doing anything at all. */
  readonly earlierWorkerLastActiveAt: string;
  /**
   * The earlier worker's nearest observed activity at or before the later write.
   *
   * This is the number the claim actually rests on, and reporting it is what lets a reader
   * tell "was mid-keystroke when the other write landed" from "had a session open". See
   * `IDLE_GAP_MINUTES`.
   */
  readonly earlierWorkerActiveAt: string;
  /** Milliseconds from that activity to the later write. Small means genuinely simultaneous. */
  readonly earlierWorkerIdleGapMs: number;
  /** The worker who wrote while the first was still going. */
  readonly laterWorkerAgentId: string | null;
  readonly laterWriteAt: string;
}

/**
 * One worker's observed activity: every timestamp it was seen at, ascending.
 *
 * A session id is not a unit of time. Agent sessions on this repository span 4 to 68 hours,
 * and a worker's *last* event says only when its session ended -- so treating "last activity
 * postdates your write" as "was still working when you wrote" makes every write inside a long
 * session look contested. Keeping the instants rather than the span is what lets the rule ask
 * about the moment that matters instead of about the session.
 */
export type WorkerActivity = readonly string[];

/**
 * How long a worker must have been silent before a write for it to count as not present at it.
 *
 * Chosen against this repository's ledger rather than picked round. The silences immediately
 * before the writes the rule calls contention measure 0.3 to 15.6 minutes; the silences that
 * separate one working session from the next run to hours. Thirty minutes sits above every
 * real decision point observed here and well below the session boundaries, and it preserves
 * all seven of the contentions the labelled corpus asserts.
 *
 * It is a threshold on a continuum, so the finding also carries the measured gap: a reader who
 * disagrees with this number can see the evidence that produced the claim.
 */
export const IDLE_GAP_MINUTES = 30;

/**
 * A file another worker has open *right now*, as opposed to one two workers shared in the past.
 *
 * The ledger cannot answer this and never will: ingest runs on the Stop hook, so by the time a
 * write reaches the ledger the session that made it has ended. That is why every overlap this
 * module reported before was necessarily a post-mortem -- true, useful for review, and always
 * too late to change what either worker did. The journal is the only live source, and it is the
 * same one `recallRecentActivity` already reads.
 *
 * `alsoChangedRecently` is the ledger half: workers who touched this file inside the window and
 * have already finished. A live holder with no history behind it is still worth naming, so this
 * may be empty.
 */
export interface LiveContention {
  readonly logicalPath: string;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly runningForMs: number;
  readonly alsoChangedRecently: readonly string[];
}

export interface ResourceOverlap {
  readonly logicalPath: string;
  readonly tasks: readonly OverlappingTask[];
  readonly contention: ContentionEvidence;
}

export interface OverlapOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly path?: string | undefined;
  readonly withinMinutes?: number | undefined;
  readonly limit?: number | undefined;
  /** Omit overlaps that this task is not part of, so a caller asks about its own work. */
  readonly taskId?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface OverlapResult {
  readonly overlaps: readonly ResourceOverlap[];
  /**
   * Files a different worker has in flight as this answer is produced.
   *
   * Listed apart from `overlaps` rather than merged into them because they are a different kind
   * of claim: an overlap is a completed fact about two writes, and this is an observation about
   * a call that has not returned. Merging them would let a reader treat "someone is in this
   * file" as "someone wrote this file", which is exactly the inference the rest of this module
   * refuses to make.
   */
  readonly live: readonly LiveContention[];
  /**
   * In-flight calls that name no file at all, counted rather than dropped.
   *
   * Most real calls are shell commands whose command text is not a path claim, so the largest
   * share of concurrent work used to be the part this answer stayed silent about -- and a
   * reader could take "no files open" to mean "nobody working". Counting them says otherwise
   * without guessing: recovering a path from command text is exactly the inference this
   * project bans, so the number is all an honest answer can give. A call that names its file
   * but is not a write -- an in-flight `Read`, say -- is neither counted here nor reported as
   * holding anything: it names its file and it is not a write contention.
   */
  readonly liveOpaqueCalls: number;
  readonly truncated: number;
  readonly logicalPath: string | null;
  /** Files observed changing in the window at all, so "none" can be told from "nothing seen". */
  readonly filesObserved: number;
  /**
   * Files two different workers changed in sequence, each finishing before the next began.
   *
   * Reported rather than silently dropped. These are the rows the old rule called overlaps,
   * and a reader who remembers seeing twenty of them needs to know they were reclassified
   * rather than lost.
   */
  readonly sequential: number;
  /** The window this answer covers, in minutes, so the answer can say what it looked at. */
  readonly withinMinutes: number;
  /** Events seen in the window at all, so a thin ledger can be told from a quiet one. */
  readonly eventsObserved: number;
}

/** Host tools whose recorded operation is a path rather than an opaque command. */
const PATHED_HOST_TOOLS = new Set(["Edit", "Write"]);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_WITHIN_MINUTES = 240;

function payloadOf(event: ProtocolEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

/**
 * What other workers have open right now, joined to who else touched those files recently.
 *
 * Best effort and never fatal, exactly as `recallRecentActivity` treats the same read: an
 * unreadable journal means the live view is empty, not that the answer failed. A live view that
 * throws would take down the historical answer beside it, which is the more established of the
 * two.
 *
 * Only calls whose host tool names a path become `live`. ~90% of recorded `Bash` calls carry
 * no path, and recovering one from command text is the inference this project bans, so an
 * opaque call is left out of that list rather than reported against a file it may not touch --
 * but it is counted in the returned `opaque`, because invisible is not the same as absent. A
 * call with a known file that simply is not a write (an in-flight `Read`) is neither: it does
 * not hold the file, and its file being known means it is not opaque, so it stays uncounted.
 */
function liveContentionFrom(
  options: OverlapOptions,
  now: Date,
  changedByWorker: ReadonlyMap<string, ReadonlySet<string>>,
): { live: readonly LiveContention[]; opaque: number } {
  let inFlight;
  try {
    inFlight = readInFlightCalls({ worktreeRoot: options.worktreeRoot, now: () => now });
  } catch {
    return { live: [], opaque: 0 };
  }

  const live: LiveContention[] = [];
  let opaque = 0;
  const seen = new Set<string>();
  for (const call of inFlight) {
    // Opaque is precise: a call whose file is unknown because nothing in its input named one.
    if (call.filePath === null) {
      opaque += 1;
      continue;
    }
    // A known file held by a tool that cannot write it -- a Read in flight -- is neither a
    // contention nor an unknown: it is irrelevant to this answer.
    if (!PATHED_HOST_TOOLS.has(call.hostToolName)) continue;
    const path = call.filePath;
    if (seen.has(path)) continue;
    seen.add(path);

    // Everyone except the holder who also changed this file inside the window. The holder is
    // excluded because a worker contending with itself is a sequence, not a collision.
    const others: string[] = [];
    for (const [worker, paths] of changedByWorker) {
      if (worker === call.agentId) continue;
      if (paths.has(path)) others.push(worker);
    }
    live.push({
      logicalPath: path,
      agentId: call.agentId,
      hostToolName: call.hostToolName,
      runningForMs: call.runningForMs,
      alsoChangedRecently: others,
    });
  }
  return { live, opaque };
}

/**
 * Find files that more than one task changed inside the window.
 *
 * Only observed changes count. A recorded call is what an agent asked for, and two agents
 * reading one file is not an overlap worth reporting; a change is what the filesystem shows,
 * which is the claim that matters when deciding whether work has diverged.
 */
export function findOverlappingWork(options: OverlapOptions): OverlapResult {
  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const withinMinutes = Math.max(options.withinMinutes ?? DEFAULT_WITHIN_MINUTES, 1);
  const now = (options.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - withinMinutes * 60_000);

  const pathRequested = options.path !== undefined && options.path.trim() !== "";
  const requestedPath = pathRequested ? logicalPathFor(identity.worktreeRoot, options.path!) : null;
  if (pathRequested && requestedPath === null) {
    return {
      overlaps: [],
      live: [],
      liveOpaqueCalls: 0,
      truncated: 0,
      logicalPath: null,
      filesObserved: 0,
      sequential: 0,
      withinMinutes,
      eventsObserved: 0,
    };
  }
  const targetResourceId =
    requestedPath === null ? null : resourceIdForPath(identity.repositoryId, requestedPath);

  // The window and the event type reach SQLite rather than JavaScript: this used to load
  // every event ever recorded and discard almost all of it, so the cost of one answer grew
  // with total history instead of with the window asked for.
  //
  // `tool.requested` is read alongside the changes because a change is an instant and
  // contention is about intervals. It is what says whether a worker was still going after
  // somebody else wrote; without it the only available question is "did these land near each
  // other", which is a question about the window rather than about the work.
  //
  // Unchecked and cached, as an advisory read: see `reconstructStoredEvent`.
  const events = readWindowCached(
    options.ledgerPath,
    { eventTypes: ["tool.requested", "file.changed"], since: since.toISOString() },
    { validate: false },
  );

  // When each worker was actually working, which is what turns an instant into an interval.
  // Computed over every event in the window, calls included: a worker that stopped changing
  // files but kept reading them has not finished.
  const activityByWorker = workerActivityFrom(events);

  // Group observed changes by the file they touched, keeping the first time each task touched
  // it: what matters is that a task changed this file, not how many times it did.
  const byResource = new Map<string, { locator: string; tasks: Map<string, OverlappingTask> }>();
  for (const event of events) {
    if (event.eventType !== "file.changed") continue;
    if (new Date(event.timestamp) < since) continue;
    // An unattributed change cannot be one side of an overlap: with no task it could equally
    // be either party, and reporting it as a third would invent a participant.
    if (event.taskId === null) continue;

    const payload = payloadOf(event);
    const resource = payload["resource"] as { resourceId?: unknown; locator?: unknown } | undefined;
    const resourceId = typeof resource?.resourceId === "string" ? resource.resourceId : null;
    if (resourceId === null) continue;
    if (targetResourceId !== null && resourceId !== targetResourceId) continue;

    const entry = byResource.get(resourceId) ?? { locator: String(resource?.locator ?? ""), tasks: new Map() };
    if (!entry.tasks.has(event.taskId)) {
      entry.tasks.set(event.taskId, {
        taskId: event.taskId,
        agentId: event.agentId,
        at: event.timestamp,
        changeKind: String(payload["changeKind"] ?? "changed"),
        worktreeId: event.worktreeId ?? null,
      });
    }
    byResource.set(resourceId, entry);
  }

  // One batched question for the whole result, not one per file, and only for files that got
  // this far. See `ignoredByRepository`: git already knows what this repository calls work.
  const ignored = ignoredByRepository(
    identity.worktreeRoot,
    [...byResource.values()].filter((entry) => entry.tasks.size >= 2).map((entry) => entry.locator),
  );

  const all: ResourceOverlap[] = [];
  let sequential = 0;
  for (const entry of byResource.values()) {
    if (entry.tasks.size < 2) continue;
    if (ignored.has(entry.locator)) continue;
    const tasks = [...entry.tasks.values()].sort((left, right) => right.at.localeCompare(left.at));
    if (!hasDistinctWorkers(tasks)) continue;
    // Asking "am I overlapping with anyone" is the common case, and an overlap the caller is
    // not part of is someone else's business.
    if (options.taskId !== undefined && !tasks.some((task) => task.taskId === options.taskId)) continue;
    const contention = contentionAmong(tasks, activityByWorker);
    if (contention === null) {
      sequential += 1;
      continue;
    }
    all.push({ logicalPath: entry.locator, tasks, contention });
  }

  all.sort((left, right) => right.tasks[0]!.at.localeCompare(left.tasks[0]!.at));
  const overlaps = all.slice(0, limit);
  // Who changed which file in the window, so a live holder can be joined to the workers who
  // already touched what it is holding. Built from the same grouped changes the overlaps use.
  const changedByWorker = new Map<string, Set<string>>();
  for (const entry of byResource.values()) {
    for (const task of entry.tasks.values()) {
      if (task.agentId === null) continue;
      const paths = changedByWorker.get(task.agentId) ?? new Set<string>();
      paths.add(entry.locator);
      changedByWorker.set(task.agentId, paths);
    }
  }
  const { live: liveAll, opaque } = liveContentionFrom(options, now, changedByWorker);
  const live = liveAll.filter(
    (item) => requestedPath === null || item.logicalPath === requestedPath,
  );
  // Opaque calls carry no path, so a path-scoped question cannot exclude them and they are
  // counted whatever the scope.
  return {
    overlaps,
    live,
    liveOpaqueCalls: opaque,
    truncated: all.length - overlaps.length,
    logicalPath: requestedPath,
    filesObserved: byResource.size,
    sequential,
    withinMinutes,
    eventsObserved: events.length,
  };
}

/**
 * Identity of a worker, for keying last-activity and for counting distinct participants.
 *
 * Exported because a labeled corpus has to build the same keys the rule looks up, and a corpus
 * that reconstructs an internal key format by hand silently scores nothing: every lookup misses,
 * every case comes back negative, and the gate reports perfect precision with zero recall.
 * That happened once already. Callers outside this module should use this rather than the shape.
 */
export function workerKey(agentId: string | null, worktreeId: string | null): string {
  return `${agentId ?? ""}\u0000${worktreeId ?? ""}`;
}

/**
 * Whether two workers were writing this file at once, or one after the other.
 *
 * This is the difference between contention and sequence, and until it existed the command
 * could not tell them apart. It reported every file two workers had touched inside the window
 * the caller happened to choose, so the answer was a function of the knob: against this
 * repository's own ledger, `--within 30` gave nothing, `--within 120` gave nine, and anything
 * from eight hours out gave twenty and never moved again. Twenty files two people edited on
 * the same day is not twenty collisions.
 *
 * The test: order the changes, and for a pair by different workers ask whether the **earlier**
 * writer was still doing something after the **later** one wrote. If it was, both were in
 * flight over the same file and neither was working from a settled version. If it was not, the
 * first had finished and the second built on its work, which is how collaboration is supposed
 * to look.
 *
 * Intersecting *task* spans were tried first and are wrong: a task is one turn, median four
 * minutes here, so two agents interleaving turns for an hour never intersect and the rule
 * reported nothing at all (89 candidate files -> 0). Intersecting *agent session* spans are
 * wrong the other way -- one session here ran for 2.8 days, and everything intersects a span
 * that long. Last-activity against the other's write is the honest middle: it uses the
 * interval where the interval is real and the instant where the instant is real.
 *
 * Deliberately conservative. This can only miss contention, never invent it, which is the
 * right direction for something that will one day interrupt an agent mid-task.
 */
export function contentionAmong(
  tasks: readonly OverlappingTask[],
  activityByWorker: ReadonlyMap<string, WorkerActivity>,
): ContentionEvidence | null {
  // An unknown worker is not a distinct one, on either side of the pair. `hasDistinctWorkers`
  // already refuses to count a null/null change as a participant; leaving it countable here let
  // an unattributed write play the second party and manufacture a collision with whoever
  // happened to still be working. The labeled corpus caught this on its first run.
  const ordered = [...tasks]
    .filter((task) => task.agentId !== null || task.worktreeId !== null)
    .sort((left, right) => left.at.localeCompare(right.at));
  for (let index = 0; index < ordered.length; index += 1) {
    const earlier = ordered[index]!;
    const earlierWorker = workerKey(earlier.agentId, earlier.worktreeId);
    const activity = activityByWorker.get(earlierWorker);
    if (activity === undefined || activity.length === 0) continue;
    const lastActive = activity[activity.length - 1]!;

    for (let other = index + 1; other < ordered.length; other += 1) {
      const later = ordered[other]!;
      if (workerKey(later.agentId, later.worktreeId) === earlierWorker) continue;

      // Two conditions, and the first one is the whole fix.
      //
      // **Still there.** The earlier worker has to have been observed doing something shortly
      // *before* the other write. Asking only whether its session ended later is what made a
      // 68-hour session contend with everything inside it -- the session had not ended, but
      // the worker was not at the keyboard either.
      const activeAt = nearestAtOrBefore(activity, later.at);
      if (activeAt === null) continue;
      const idleGapMs = new Date(later.at).getTime() - new Date(activeAt).getTime();
      if (idleGapMs > IDLE_GAP_MINUTES * 60_000) continue;

      // **Not finished.** It also has to still be going afterwards. A worker whose very last
      // observed act was at or before the other write had stopped, and a write landing after
      // somebody downed tools is a hand-off rather than a collision -- which is why the
      // boundary is exclusive: one session ending exactly as another begins is the commonest
      // shape of ordinary sequential work.
      if (lastActive <= later.at) continue;

      return {
        earlierWorkerAgentId: earlier.agentId,
        earlierWriteAt: earlier.at,
        earlierWorkerLastActiveAt: lastActive,
        earlierWorkerActiveAt: activeAt,
        earlierWorkerIdleGapMs: Math.max(idleGapMs, 0),
        laterWorkerAgentId: later.agentId,
        laterWriteAt: later.at,
      };
    }
  }
  return null;
}

/** The last timestamp at or before `at`, by binary search over an ascending list. */
function nearestAtOrBefore(timestamps: readonly string[], at: string): string | null {
  let low = 0;
  let high = timestamps.length - 1;
  let found: string | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timestamps[middle]! <= at) {
      found = timestamps[middle]!;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Collect every worker's observed timestamps, ascending.
 *
 * The events arrive in insertion order, which is close to but not exactly timestamp order --
 * ingest preserves hook-time timestamps and drains a journal per session -- so this sorts
 * rather than assuming.
 */
export function workerActivityFrom(
  events: readonly ProtocolEvent[],
): ReadonlyMap<string, WorkerActivity> {
  const timestampsByWorker = new Map<string, string[]>();
  for (const event of events) {
    if (event.agentId === null && event.worktreeId === null) continue;
    const worker = workerKey(event.agentId, event.worktreeId ?? null);
    const seen = timestampsByWorker.get(worker);
    if (seen === undefined) timestampsByWorker.set(worker, [event.timestamp]);
    else seen.push(event.timestamp);
  }
  for (const timestamps of timestampsByWorker.values()) timestamps.sort();
  return timestampsByWorker;
}

/**
 * Whether these tasks were done by more than one worker.
 *
 * A session runs one task at a time, so one agent's two tasks are consecutive by construction:
 * it finished the first before it began the second, and reporting that as contested is a false
 * alarm every time. What makes two changes an overlap is two workers - a different agent, a
 * subagent running beside its parent, or a second checkout of the same repository.
 *
 * An unknown worker is not a distinct one. A change with no agent could have come from either
 * party, so counting it as a second participant would invent the very thing being reported.
 */
function hasDistinctWorkers(tasks: readonly OverlappingTask[]): boolean {
  const workers = new Set<string>();
  for (const task of tasks) {
    if (task.agentId === null && task.worktreeId === null) continue;
    workers.add(workerKey(task.agentId, task.worktreeId));
  }
  return workers.size >= 2;
}

/** Render an overlap result as the compact text an agent reads inline. */
export function renderOverlap(result: OverlapResult, requestedPath: string | undefined): string {
  const scope = result.logicalPath !== null ? `\`${result.logicalPath}\`` : "this repository";
  // Which "recently" this is. The three read tools default to different windows, and an answer
  // that does not say which one it used cannot be told from one that found nothing.
  const window = describeWindow(result.withinMinutes);

  // Live first, and printed even when there are no historical overlaps at all. A file somebody
  // is inside right now is the only thing in this answer that can still change what the reader
  // does next; everything below it is review.
  const liveShort = idShortener([
    ...result.live.flatMap((item) => (item.agentId === null ? [] : [item.agentId])),
    ...result.live.flatMap((item) => [...item.alsoChangedRecently]),
  ]);
  const liveLines: string[] = [];
  if (result.live.length > 0) {
    liveLines.push(`${result.live.length} file(s) are open right now, by a worker that has not finished:`);
    liveLines.push(
      ...result.live.map((item) => {
        const who = item.agentId === null ? "an unidentified worker" : liveShort(item.agentId);
        const seconds = Math.max(Math.round(item.runningForMs / 1000), 0);
        const alsoLine =
          item.alsoChangedRecently.length === 0
            ? ""
            : `\n    also changed in this window by: ${item.alsoChangedRecently.map(liveShort).join(", ")}`;
        return `- \`${item.logicalPath}\` — ${who} (${item.hostToolName}, running ${seconds}s)${alsoLine}`;
      }),
    );
  }
  // Appended whenever there are any, including when no pathed call made the list above: a
  // shell-only moment would otherwise render as "nothing open", which it is not.
  if (result.liveOpaqueCalls > 0) {
    liveLines.push(`(${result.liveOpaqueCalls} call(s) in flight nearby name no file - which files they touch is unknown.)`);
  }
  const liveSection =
    liveLines.length === 0
      ? ""
      : liveLines.join("\n")
        + "\nThis is read from the journal, not the ledger, so it is what is happening rather than "
        + "what happened. A call in flight is not a write: it may not change this file at all.\n\n";

  if (result.overlaps.length === 0) {
    // "Nothing observed" and "observed, nothing shared" are different answers, and an agent
    // deciding whether to proceed needs to know which one it got.
    if (result.filesObserved === 0) {
      // A third case sits underneath those two: a ledger with nothing in it yet. Saying how
      // much was seen at all is what keeps a fresh install from reading as a clean bill of
      // health.
      const seen =
        result.eventsObserved === 0
          ? " Nothing at all is recorded in this window, so this may be a ledger that has not been written to yet."
          : ` ${result.eventsObserved} event(s) were recorded in it.`;
      return (
        `${liveSection}No file changes have been observed for ${scope} in the last ${window}, so overlap ` +
        `cannot be assessed. This is an absence of evidence, not evidence of independence.${seen}`
      );
    }
    // Sequence is a real answer and a different one from "nobody else was here". A reader who
    // is deciding whether to proceed wants to know that somebody did edit this file and had
    // finished before they started.
    const inSequence =
      result.sequential > 0
        ? ` ${result.sequential} file(s) were changed by two workers in sequence, each finishing before the next began.`
        : "";
    return `${liveSection}No two workers changed the same file at once in ${scope} in the last ${window} (${result.filesObserved} file(s) observed changing).${inSequence}`;
  }

  // One shortening table for the whole answer: ids are only ever compared with the other ids
  // printed beside them. See `shortIds`.
  const short = idShortener(
    result.overlaps.flatMap((overlap) => [
      ...overlap.tasks.flatMap((task) => (task.agentId === null ? [] : [task.agentId])),
      ...overlap.tasks.map((task) => task.taskId),
    ]),
  );
  const name = (agentId: string | null) => (agentId === null ? "unattributed" : short(agentId));

  const blocks = result.overlaps.map((overlap) => {
    // Only the pair the claim is about. The rest of the task list is the file's edit history:
    // on a live answer `README.md` printed eleven rows of which the evidence named two, and
    // the other nine were charged to the reader to say nothing. They are counted instead.
    const contending = overlap.tasks.filter(
      (task) =>
        (task.at === overlap.contention.earlierWriteAt &&
          task.agentId === overlap.contention.earlierWorkerAgentId) ||
        (task.at === overlap.contention.laterWriteAt &&
          task.agentId === overlap.contention.laterWorkerAgentId),
    );
    const lines = contending.map(
      (task) => `    - ${task.at} ${name(task.agentId)} (${short(task.taskId)}) ${task.changeKind}`,
    );
    const others = overlap.tasks.length - contending.length;
    const rest =
      others > 0
        ? `\n    (${others} other task(s) also changed this file in the window.)`
        : "";

    // The reason, stated so the reader can check it rather than take it on trust -- including
    // how recently the earlier worker had been seen, which is what separates a genuinely
    // simultaneous edit from a session that merely had not ended yet.
    const gap = describeGap(overlap.contention.earlierWorkerIdleGapMs);
    const why =
      `    why: ${name(overlap.contention.earlierWorkerAgentId)} wrote at ` +
      `${overlap.contention.earlierWriteAt} and was still working when ` +
      `${name(overlap.contention.laterWorkerAgentId)} wrote at ${overlap.contention.laterWriteAt} ` +
      `(last seen ${gap} before that write).`;
    return `- \`${overlap.logicalPath}\` — two workers in flight, of ${overlap.tasks.length} task(s) that changed it:\n${lines.join("\n")}${rest}\n${why}`;
  });

  const header = `${result.overlaps.length} file(s) in ${scope} were changed by two workers at once, in the last ${window}:`;
  const footer = result.truncated > 0 ? `\n(${result.truncated} more not shown.)` : "";
  const sequence =
    result.sequential > 0
      ? `\n${result.sequential} further file(s) were changed by two workers in sequence and are not reported as contention.`
      : "";
  // Kept, where recap's and recall's were dropped: this is the answer a reader is most likely
  // to over-read, because "contested" sounds like a verdict and the ledger has no way to reach
  // one. Shortened to the part that changes what they do with it.
  const caveat = "\nBoth were in flight over this file; the ledger holds paths and hashes, not intent.";
  return `${header}\n${blocks.join("\n")}${footer}${sequence}${caveat}`;
}

/** A duration a reader can weigh, rather than a millisecond count they have to convert. */
function describeGap(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}
