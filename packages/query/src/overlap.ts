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

export interface ResourceOverlap {
  readonly logicalPath: string;
  readonly tasks: readonly OverlappingTask[];
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
    return { overlaps: [], truncated: 0, logicalPath: null, filesObserved: 0 };
  }
  const targetResourceId =
    requestedPath === null ? null : resourceIdForPath(identity.repositoryId, requestedPath);

  const store = SqliteEventStore.open(options.ledgerPath);
  let events: readonly ProtocolEvent[];
  try {
    // The window and the event type reach SQLite rather than JavaScript: this used to load
    // every event ever recorded and discard almost all of it, so the cost of one answer grew
    // with total history instead of with the window asked for.
    events = store.read({ eventTypes: ["file.changed"], since: since.toISOString() });
  } finally {
    store.close();
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
  for (const entry of byResource.values()) {
    if (entry.tasks.size < 2) continue;
    if (ignored.has(entry.locator)) continue;
    const tasks = [...entry.tasks.values()].sort((left, right) => right.at.localeCompare(left.at));
    if (!hasDistinctWorkers(tasks)) continue;
    // Asking "am I overlapping with anyone" is the common case, and an overlap the caller is
    // not part of is someone else's business.
    if (options.taskId !== undefined && !tasks.some((task) => task.taskId === options.taskId)) continue;
    all.push({ logicalPath: entry.locator, tasks });
  }

  all.sort((left, right) => right.tasks[0]!.at.localeCompare(left.tasks[0]!.at));
  const overlaps = all.slice(0, limit);
  return {
    overlaps,
    truncated: all.length - overlaps.length,
    logicalPath: requestedPath,
    filesObserved: byResource.size,
  };
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
    workers.add(`${task.agentId ?? ""}\u0000${task.worktreeId ?? ""}`);
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
    return `No two tasks changed the same file in ${scope} (${result.filesObserved} file(s) observed changing).`;
  }

  const blocks = result.overlaps.map((overlap) => {
    const lines = overlap.tasks.map(
      (task) => `    - ${task.at} ${task.agentId ?? "unattributed"} (${task.taskId}) ${task.changeKind}`,
    );
    return `- \`${overlap.logicalPath}\` changed by ${overlap.tasks.length} tasks:\n${lines.join("\n")}`;
  });

  const header = `${result.overlaps.length} file(s) in ${scope} changed by more than one task:`;
  const footer = result.truncated > 0 ? `\n(${result.truncated} more not shown.)` : "";
  const caveat =
    "\nThis is a record of what happened, not a judgement. Two tasks touching one file may be " +
    "collaboration, a rebase, or divergence - the ledger holds paths and hashes, not intent.";
  return `${header}\n${blocks.join("\n")}${footer}${caveat}`;
}
