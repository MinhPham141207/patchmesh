import type { ProtocolEvent } from "patchmesh-protocol";
import { ignoredByRepository } from "patchmesh-recorder";
import { commitsWithin, describeWindow, readCommitsSince } from "./label.js";
import { IDLE_GAP_MINUTES } from "./overlap.js";
import { idShortener } from "./short-id.js";
import { readWindowCached } from "patchmesh-storage";

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
  /** True while the task's last observed event is inside the idle gap. */
  readonly active: boolean;
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
  /** The window this answer covers, in minutes, so the answer can say what it looked at. */
  readonly withinMinutes: number;
  /** When the recap was taken; rendering needs it to say how long ago the last activity was. */
  readonly nowIso?: string | undefined;
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

  // `tool.completed` is not summarized directly, but it carries the failure outcome each
  // request is counted by; dropping it here would silently zero every failure count.
  //
  // Read unchecked and through the cache: this is an advisory answer, not an integrity
  // decision. See `reconstructStoredEvent` and `readEventsCached`.
  const events = readWindowCached(
    options.ledgerPath,
    {
      eventTypes: ["tool.requested", "tool.completed", "file.changed"],
      since: since.toISOString(),
    },
    { validate: false },
  );

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

  // Same idle rule as overlap: a task whose last observed event is inside the gap may still
  // be running, and closing its range would tell a resuming agent their current work is done.
  const activeMs = IDLE_GAP_MINUTES * 60_000;
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
      active: now.getTime() - new Date(accumulator.endedAt).getTime() <= activeMs,
    };
  });

  all.sort((left, right) => right.endedAt.localeCompare(left.endedAt));
  const selected = all.slice(0, limit);
  return { tasks: selected, truncated: all.length - selected.length, unattributedCalls, withinMinutes, nowIso: now.toISOString() };
}

/** Render a recap as the compact text an agent reads before deciding where to start. */
export function renderRecap(result: RecapResult, agent: string | undefined): string {
  const scope = agent === undefined ? "this repository" : `\`${agent}\``;
  // Which "recently" this is; see `describeWindow`.
  const window = describeWindow(result.withinMinutes);
  if (result.tasks.length === 0) {
    const tail =
      result.unattributedCalls > 0
        ? ` ${result.unattributedCalls} recorded call(s) belong to no task, so there is nothing to summarize as a unit of work.`
        : "";
    return `No work recorded for ${scope} in the last ${window}.${tail}`;
  }

  // See `shortIds`: an id is only ever compared with the ones printed beside it.
  const short = idShortener([
    ...result.tasks.flatMap((task) => task.agentIds),
    ...result.tasks.map((task) => task.taskId),
  ]);

  const blocks = result.tasks.map((task) => {
    const who =
      task.agentIds.length === 1
        ? short(task.agentIds[0]!)
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
    // An active task is not a closed range: it may still be running, and reading "X to Y"
    // would tell the resuming agent their current work is finished.
    const nowMs = result.nowIso === undefined ? Date.now() : Date.parse(result.nowIso);
    const span = task.active
      ? `${task.startedAt} · last activity ${Math.max(1, Math.round((nowMs - Date.parse(task.endedAt)) / 60_000))} min ago (may still be running)`
      : `${task.startedAt} to ${task.endedAt}`;
    return `- ${short(task.taskId)}\n  ${who}, ${span}, ${task.calls} call(s)${failed}\n${files}${committed}`;
  });

  const header = `${result.tasks.length} task(s) in ${scope} in the last ${window}, most recent first:`;
  const truncated = result.truncated > 0 ? `\n(${result.truncated} older task(s) not shown.)` : "";
  const unattributed =
    result.unattributedCalls > 0
      ? `\n${result.unattributedCalls} call(s) belong to no task and are not summarized here.`
      : "";
  // The standing caveat moved into the MCP tool description, which is paid once per session
  // rather than once per answer. What is left is the half a reader cannot get from the
  // description because it is about *these* rows: a changed file is not a finished intention.
  const caveat = "\nA changed file is not a finished intention.";
  return `${header}\n${blocks.join("\n")}${truncated}${unattributed}${caveat}`;
}
