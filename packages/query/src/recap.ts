import type { ProtocolEvent } from "patchmesh-protocol";
import { ignoredByRepository } from "patchmesh-recorder";
import { commitsWithin, readCommitsSince } from "./label.js";
import { SqliteEventStore } from "patchmesh-storage";

/**
 * What a prior session already established, so a fresh agent resumes instead of re-deriving.
 *
 * This is the tool aimed at the expensive half of an agent's work. Measured across 425
 * recorded calls in this repository: 46% were reading a file and 17% searching, against 1%
 * asking git for history. Attribution answers that 1%. Re-derivation - working out what the
 * last session was doing and how far it got - is what sends an agent back through the tree,
 * and it is the only thing a ledger can displace at that scale.
 *
 * A recap is a summary, so it is bounded twice: in how many tasks it describes and in how much
 * it says about each. An unbounded recap is just the ledger again, and re-reading the ledger
 * is not cheaper than re-reading the code.
 */
export interface RecappedTask {
  readonly taskId: string;
  /** The agent that owned the task, plus any subagent that worked under it. */
  readonly agentIds: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly calls: number;
  readonly failed: number;
  readonly changedPaths: readonly string[];
  /** Changed files beyond those listed, so a summary never reads as an inventory. */
  readonly moreChanged: number;
  /** Subjects of commits that landed while this task was running. See `label.ts`. */
  readonly commits: readonly string[];
}

export interface RecapOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  /** Narrow to one agent's work. Omitted means every agent that worked here. */
  readonly agent?: string | undefined;
  readonly withinMinutes?: number | undefined;
  readonly limit?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface RecapResult {
  readonly tasks: readonly RecappedTask[];
  readonly truncated: number;
  /** Calls that belong to no task, which a recap cannot describe as a unit of work. */
  readonly unattributedCalls: number;
}

/** A recap looks further back than recall: its subject is the last session, not the last minutes. */
const DEFAULT_WITHIN_MINUTES = 24 * 60;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const MAX_PATHS_PER_TASK = 5;

function payloadOf(event: ProtocolEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

interface Accumulator {
  readonly agentIds: Set<string>;
  readonly changedPaths: Set<string>;
  startedAt: string;
  endedAt: string;
  calls: number;
  failed: number;
}

export function recapRecentWork(options: RecapOptions): RecapResult {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const withinMinutes = Math.max(options.withinMinutes ?? DEFAULT_WITHIN_MINUTES, 1);
  const now = (options.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - withinMinutes * 60_000);

  const store = SqliteEventStore.open(options.ledgerPath);
  let events: readonly ProtocolEvent[];
  try {
    // `tool.completed` is not summarized directly, but it carries the failure outcome each
    // request is counted by; dropping it here would silently zero every failure count.
    events = store.read({
      eventTypes: ["tool.requested", "tool.completed", "file.changed"],
      since: since.toISOString(),
    });
  } finally {
    store.close();
  }

  const failedRequestIds = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "tool.completed") continue;
    const payload = payloadOf(event);
    if (payload["outcome"] !== "failed") continue;
    const requestEventId = payload["requestEventId"];
    if (typeof requestEventId === "string") failedRequestIds.add(requestEventId);
  }

  const tasks = new Map<string, Accumulator>();
  let unattributedCalls = 0;

  for (const event of events) {
    if (new Date(event.timestamp) < since) continue;
    const isCall = event.eventType === "tool.requested";
    const isChange = event.eventType === "file.changed";
    if (!isCall && !isChange) continue;
    if (options.agent !== undefined && event.agentId !== options.agent) continue;

    if (event.taskId === null) {
      // Work with no task cannot be summarized as a unit; it is counted and declared instead
      // of being folded into somebody else's task.
      if (isCall) unattributedCalls += 1;
      continue;
    }

    const accumulator = tasks.get(event.taskId) ?? {
      agentIds: new Set<string>(),
      changedPaths: new Set<string>(),
      startedAt: event.timestamp,
      endedAt: event.timestamp,
      calls: 0,
      failed: 0,
    };
    if (event.agentId !== null) accumulator.agentIds.add(event.agentId);
    if (event.timestamp < accumulator.startedAt) accumulator.startedAt = event.timestamp;
    if (event.timestamp > accumulator.endedAt) accumulator.endedAt = event.timestamp;
    if (isCall) {
      accumulator.calls += 1;
      if (failedRequestIds.has(event.eventId)) accumulator.failed += 1;
    } else {
      const resource = payloadOf(event)["resource"] as { locator?: unknown } | undefined;
      if (typeof resource?.locator === "string") accumulator.changedPaths.add(resource.locator);
    }
    tasks.set(event.taskId, accumulator);
  }

  // Asked once for every path in the recap rather than once per task: `git check-ignore` is a
  // subprocess, and a recap that names a sibling tool's cache as work spends the reader's
  // context to tell them nothing. Same policy as the write side; see `ignoredByRepository`.
  const ignored = ignoredByRepository(
    options.worktreeRoot,
    [...new Set([...tasks.values()].flatMap((accumulator) => [...accumulator.changedPaths]))],
  );

  // One git call for the whole window, not one per task.
  const commits = readCommitsSince(options.worktreeRoot, since);

  const all: RecappedTask[] = [...tasks.entries()].map(([taskId, accumulator]) => {
    const paths = [...accumulator.changedPaths].filter((path) => !ignored.has(path)).sort();
    return {
      taskId,
      agentIds: [...accumulator.agentIds].sort(),
      startedAt: accumulator.startedAt,
      endedAt: accumulator.endedAt,
      calls: accumulator.calls,
      failed: accumulator.failed,
      changedPaths: paths.slice(0, MAX_PATHS_PER_TASK),
      moreChanged: Math.max(paths.length - MAX_PATHS_PER_TASK, 0),
      commits: commitsWithin(commits, accumulator.startedAt, accumulator.endedAt),
    };
  });

  all.sort((left, right) => right.endedAt.localeCompare(left.endedAt));
  const selected = all.slice(0, limit);
  return { tasks: selected, truncated: all.length - selected.length, unattributedCalls };
}

/** Render a recap as the compact text an agent reads before deciding where to start. */
export function renderRecap(result: RecapResult, agent: string | undefined): string {
  const scope = agent === undefined ? "this repository" : `\`${agent}\``;
  if (result.tasks.length === 0) {
    const tail =
      result.unattributedCalls > 0
        ? ` ${result.unattributedCalls} recorded call(s) belong to no task, so there is nothing to summarize as a unit of work.`
        : "";
    return `No recent work recorded for ${scope}.${tail}`;
  }

  const blocks = result.tasks.map((task) => {
    const who =
      task.agentIds.length === 1
        ? task.agentIds[0]!
        : `${task.agentIds.length} agents (${task.agentIds.filter((id) => id.includes(".sub.")).length} subagent(s))`;
    const failed = task.failed > 0 ? `, ${task.failed} failed` : "";
    // A task that landed commits while observing no changes of its own is a real and common
    // shape - the turn that runs `git add` and `git commit` over work earlier turns did - and
    // rendering it as "changed no files" beside a list of six commits reads as a contradiction
    // rather than as the timing claim it is.
    const files =
      task.changedPaths.length === 0
        ? task.commits.length === 0
          ? "  changed no files"
          : "  changed no files itself; the commits below carry work observed under earlier tasks"
        : `  changed: ${task.changedPaths.join(", ")}` +
          (task.moreChanged > 0 ? ` (+${task.moreChanged} more)` : "");
    // "committed", not "did": the commit landed while this task was running, which is an
    // observation about timing rather than a statement of what the task was for.
    const committed = task.commits.length === 0 ? "" : `\n  committed: ${task.commits.join(" | ")}`;
    return `- ${task.taskId}\n  ${who}, ${task.startedAt} to ${task.endedAt}, ${task.calls} call(s)${failed}\n${files}${committed}`;
  });

  const header = `${result.tasks.length} recent task(s) in ${scope}, most recent first:`;
  const truncated = result.truncated > 0 ? `\n(${result.truncated} older task(s) not shown.)` : "";
  const unattributed =
    result.unattributedCalls > 0
      ? `\n${result.unattributedCalls} call(s) belong to no task and are not summarized here.`
      : "";
  const caveat =
    "\nThis is what was done, not what it means. A changed file is not a finished intention.";
  return `${header}\n${blocks.join("\n")}${truncated}${unattributed}${caveat}`;
}
