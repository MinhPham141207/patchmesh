import type { ProtocolEvent } from "patchmesh-protocol";
import {
  ignoredByRepository,
  logicalPathFor,
  resolveRepositoryIdentity,
  resourceIdForPath,
} from "patchmesh-recorder";
import { SqliteEventStore } from "patchmesh-storage";

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
  /** The worker who wrote while the first was still going. */
  readonly laterWorkerAgentId: string | null;
  readonly laterWriteAt: string;
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
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_WITHIN_MINUTES = 240;

function payloadOf(event: ProtocolEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
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
    return { overlaps: [], truncated: 0, logicalPath: null, filesObserved: 0, sequential: 0 };
  }
  const targetResourceId =
    requestedPath === null ? null : resourceIdForPath(identity.repositoryId, requestedPath);

  const store = SqliteEventStore.open(options.ledgerPath);
  let events: readonly ProtocolEvent[];
  try {
    // The window and the event type reach SQLite rather than JavaScript: this used to load
    // every event ever recorded and discard almost all of it, so the cost of one answer grew
    // with total history instead of with the window asked for.
    //
    // `tool.requested` is read alongside the changes because a change is an instant and
    // contention is about intervals. It is what says whether a worker was still going after
    // somebody else wrote; without it the only available question is "did these land near each
    // other", which is a question about the window rather than about the work.
    events = store.read({ eventTypes: ["tool.requested", "file.changed"], since: since.toISOString() });
  } finally {
    store.close();
  }

  // When each worker was last observed doing anything, which is what turns an instant into an
  // interval. Computed over every event in the window, calls included: a worker that stopped
  // changing files but kept reading them has not finished.
  const lastActiveByWorker = new Map<string, string>();
  for (const event of events) {
    if (event.agentId === null && event.worktreeId === null) continue;
    const worker = workerKey(event.agentId, event.worktreeId ?? null);
    const seen = lastActiveByWorker.get(worker);
    if (seen === undefined || event.timestamp > seen) lastActiveByWorker.set(worker, event.timestamp);
  }

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
    const contention = contentionAmong(tasks, lastActiveByWorker);
    if (contention === null) {
      sequential += 1;
      continue;
    }
    all.push({ logicalPath: entry.locator, tasks, contention });
  }

  all.sort((left, right) => right.tasks[0]!.at.localeCompare(left.tasks[0]!.at));
  const overlaps = all.slice(0, limit);
  return {
    overlaps,
    truncated: all.length - overlaps.length,
    logicalPath: requestedPath,
    filesObserved: byResource.size,
    sequential,
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
  lastActiveByWorker: ReadonlyMap<string, string>,
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
    const earlierLastActive = lastActiveByWorker.get(earlierWorker);
    if (earlierLastActive === undefined) continue;
    for (let other = index + 1; other < ordered.length; other += 1) {
      const later = ordered[other]!;
      if (workerKey(later.agentId, later.worktreeId) === earlierWorker) continue;
      if (earlierLastActive <= later.at) continue;
      return {
        earlierWorkerAgentId: earlier.agentId,
        earlierWriteAt: earlier.at,
        earlierWorkerLastActiveAt: earlierLastActive,
        laterWorkerAgentId: later.agentId,
        laterWriteAt: later.at,
      };
    }
  }
  return null;
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

  if (result.overlaps.length === 0) {
    // "Nothing observed" and "observed, nothing shared" are different answers, and an agent
    // deciding whether to proceed needs to know which one it got.
    if (result.filesObserved === 0) {
      return (
        `No file changes have been observed for ${scope} in this window, so overlap cannot be ` +
        `assessed. This is an absence of evidence, not evidence of independence.`
      );
    }
    // Sequence is a real answer and a different one from "nobody else was here". A reader who
    // is deciding whether to proceed wants to know that somebody did edit this file and had
    // finished before they started.
    const inSequence =
      result.sequential > 0
        ? ` ${result.sequential} file(s) were changed by two workers in sequence, each finishing before the next began.`
        : "";
    return `No two workers changed the same file at once in ${scope} (${result.filesObserved} file(s) observed changing).${inSequence}`;
  }

  const blocks = result.overlaps.map((overlap) => {
    const lines = overlap.tasks.map(
      (task) => `    - ${task.at} ${task.agentId ?? "unattributed"} (${task.taskId}) ${task.changeKind}`,
    );
    // The reason, stated so the reader can check it rather than take it on trust.
    const why =
      `    why: ${overlap.contention.earlierWorkerAgentId ?? "an unattributed worker"} wrote at ` +
      `${overlap.contention.earlierWriteAt} and was still working at ` +
      `${overlap.contention.earlierWorkerLastActiveAt}, after ` +
      `${overlap.contention.laterWorkerAgentId ?? "another worker"} wrote at ${overlap.contention.laterWriteAt}.`;
    // "Two workers were in flight" is the claim; the task list is the file's history and is
    // mostly not the contending pair. Saying "changed by 8 tasks while more than one worker
    // was active" read as though all eight were concurrent, which is not what was measured.
    return `- \`${overlap.logicalPath}\` — two workers in flight, across ${overlap.tasks.length} task(s) that changed it:\n${lines.join("\n")}\n${why}`;
  });

  const header = `${result.overlaps.length} file(s) in ${scope} were changed by two workers at once:`;
  const footer = result.truncated > 0 ? `\n(${result.truncated} more not shown.)` : "";
  const sequence =
    result.sequential > 0
      ? `\n${result.sequential} further file(s) were changed by two workers in sequence and are not reported as contention.`
      : "";
  const caveat =
    "\nThis is a record of what happened, not a judgement. Both workers were in flight over the " +
    "same file, which is not the same as saying either is wrong - the ledger holds paths and " +
    "hashes, not intent.";
  return `${header}\n${blocks.join("\n")}${footer}${sequence}${caveat}`;
}
