import type { ProtocolEvent } from "patchmesh-protocol";
import { undeliveredCount, type ReadServices, type RecapResult } from "patchmesh-query";
import type { GraphSiteModel, ModelGap } from "./graph-model.js";

/**
 * Every payload this module produces is capped.
 *
 * The lesson is older than this file: `status --json` shipped 2,611 gap objects because the
 * aggregation that fixed the text renderer never reached the machine-readable path, and
 * `/graph.json` then grew 315 KB -> 1.76 MB in two days for the same reason. A serialization
 * boundary that does not name its own limit acquires one from the ledger, which has none.
 *
 * So each lens states its cap here, reports the total it drew from, and says how much it
 * withheld. A caller that needs the rest asks for the rest; nothing is silently truncated.
 */
export const AGENT_ROWS = 60;
export const FILE_ROWS = 200;
export const EVENT_ROWS = 120;
export const MAP_FILES = 30;
export const MAP_AGENTS = 16;
/** Change history kept per file in `/graph.json`. Whole histories are what made it 1.76 MB. */
export const CHANGES_PER_FILE = 8;
/** Sampled resource ids per agent and task. The page reads the count, never the ids. */
export const FILE_ID_SAMPLE = 10;
/** Operation text is a shell command; whole ones run to hundreds of characters. */
export const OPERATION_CHARS = 240;

/** How much of a list a lens actually drew, so a reader can tell a cap from an empty ledger. */
export interface Bounds {
  readonly total: number;
  readonly shown: number;
  readonly withheld: number;
}

function bounds(total: number, shown: number): Bounds {
  return { total, shown, withheld: Math.max(total - shown, 0) };
}

/**
 * Shorten an agent or task id to the prefix people actually read.
 *
 * `recap` established this: `agent_b11c2b2a` is what a human matches against, and the
 * remaining 24 characters of a UUID have never once disambiguated anything in this ledger.
 * The whole id stays in the payload as `id`, so a filter or a copy still works.
 */
export function shortId(id: string): string {
  const marker = id.indexOf(".sub.");
  if (marker !== -1) return `${shortId(id.slice(0, marker))}.sub.${id.slice(marker + 5, marker + 13)}`;
  const underscore = id.indexOf("_");
  if (underscore === -1) return id.slice(0, 14);
  return id.slice(0, underscore + 9);
}

function payloadOf(event: ProtocolEvent): Record<string, unknown> {
  return event.payload as unknown as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/* ------------------------------------------------------------------ now */

export interface NowLens {
  readonly ledger: string;
  readonly generatedAt: string;
  readonly counts: {
    readonly events: number;
    readonly agents: number;
    readonly tasks: number;
    readonly nullAttribution: number;
    readonly undeliveredMessages: number;
    readonly coveredScopes: number;
    readonly totalScopes: number;
    readonly presentation: string;
  };
  readonly health: string;
  readonly gaps: readonly ModelGap[];
  readonly window: number | null;
  readonly tasks: RecapResult["tasks"];
  readonly truncated: number;
  readonly unattributedCalls: number;
}

/**
 * The landing lens, and the only one that does not touch the work-graph projection.
 *
 * `getStatus` already holds every count on this screen and `recapRecentWork` reads a time
 * window rather than the whole ledger, so opening the console costs a windowed read instead
 * of a full projection. Files and contested counts are deliberately absent: they need the
 * projection, and making the landing page pay for them would put the most expensive query in
 * the product behind the most frequent click.
 */
export function buildNowLens(services: ReadServices, ledger: string, recap: RecapResult | null): NowLens {
  const status = services.getStatus();
  // Grouped by (kind, reason) rather than listed per scope, for the reason `coverageGapLines`
  // already gives: a hook-recorded ledger emits one `opaque` gap per shell command, so the
  // ungrouped list is thousands of near-identical objects that grow for as long as the
  // repository is worked in.
  const gaps = new Map<string, ModelGap>();
  for (const gap of status.coverage.gaps) {
    const reason = gap.reason ?? "";
    const key = `${gap.kind}\t${reason}`;
    gaps.set(key, { kind: gap.kind, reason, count: (gaps.get(key)?.count ?? 0) + 1 });
  }
  return {
    ledger,
    generatedAt: new Date().toISOString(),
    counts: {
      events: status.eventCount,
      agents: status.agentCount,
      tasks: status.taskCount,
      nullAttribution: status.nullAttributionEventCount,
      // Read from the ledger this lens was opened on; `undeliveredCount` fails soft to zero
      // when it is unreadable, the same degradation every other count here follows.
      undeliveredMessages: undeliveredCount(ledger),
      coveredScopes: status.coverage.covered,
      totalScopes: status.coverage.total,
      presentation: status.coverage.presentation,
    },
    health: status.health,
    gaps: [...gaps.values()].sort((left, right) => right.count - left.count),
    window: recap?.withinMinutes ?? null,
    tasks: recap?.tasks ?? [],
    truncated: recap?.truncated ?? 0,
    unattributedCalls: recap?.unattributedCalls ?? 0,
  };
}

/* --------------------------------------------------------------- agents */

export interface AgentRow {
  readonly id: string;
  readonly short: string;
  readonly parentId: string | null;
  readonly tasks: number;
  readonly changes: number;
  readonly reads: number;
  readonly files: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

export interface AgentsLens {
  readonly generatedAt: string;
  readonly bounds: Bounds;
  readonly rows: readonly AgentRow[];
}

/**
 * Agents ordered by when they were last here.
 *
 * The CLI sorts these alphabetically by UUID, which is a random order wearing a deterministic
 * one's clothes. Recency is the only sort that answers the question this screen is opened
 * for, and unlike the CLI's `listAgents` the projection carries the timestamps to do it.
 */
export function buildAgentsLens(model: GraphSiteModel): AgentsLens {
  const ranked = [...model.agents].sort((left, right) => {
    const l = left.lastAt ?? "";
    const r = right.lastAt ?? "";
    if (l !== r) return l < r ? 1 : -1;
    return right.changeCount - left.changeCount;
  });
  const rows = ranked.slice(0, AGENT_ROWS).map((agent) => ({
    id: agent.id,
    short: shortId(agent.id),
    parentId: agent.parentId,
    tasks: agent.taskIds.length,
    changes: agent.changeCount,
    reads: agent.readCount,
    files: agent.fileIds.length,
    firstAt: agent.firstAt,
    lastAt: agent.lastAt,
  }));
  return { generatedAt: model.generatedAt, bounds: bounds(model.agents.length, rows.length), rows };
}

/* ---------------------------------------------------------------- files */

export interface FileRow {
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly changes: number;
  readonly agents: readonly string[];
  readonly unattributed: number;
  readonly contested: boolean;
  readonly lastAt: string | null;
}

export interface FilesLens {
  readonly generatedAt: string;
  readonly bounds: Bounds;
  readonly counts: { readonly files: number; readonly changes: number; readonly contested: number; readonly unattributedChanges: number };
  readonly rows: readonly FileRow[];
}

/** Files ranked by churn, because a file nobody changed is not what this screen is opened for. */
export function buildFilesLens(model: GraphSiteModel): FilesLens {
  const touched = model.files.filter((file) => file.changes.length > 0);
  const ranked = [...touched].sort((left, right) => {
    if (right.changes.length !== left.changes.length) return right.changes.length - left.changes.length;
    return (right.lastAt ?? "") < (left.lastAt ?? "") ? -1 : 1;
  });
  const rows = ranked.slice(0, FILE_ROWS).map((file) => ({
    path: file.path,
    dir: file.dir,
    name: file.name,
    changes: file.changes.length,
    agents: file.changedBy.map(shortId),
    unattributed: file.changes.filter((change) => change.agentId === null).length,
    contested: file.changedBy.length > 1,
    lastAt: file.lastAt,
  }));
  return {
    generatedAt: model.generatedAt,
    bounds: bounds(touched.length, rows.length),
    counts: {
      files: model.counts.files,
      changes: model.counts.changes,
      contested: model.counts.contested,
      unattributedChanges: model.counts.unattributedChanges,
    },
    rows,
  };
}

/* ------------------------------------------------------------------ map */

export interface MapLens {
  readonly generatedAt: string;
  readonly agents: readonly { readonly id: string; readonly short: string }[];
  readonly files: Bounds;
  readonly rows: readonly {
    readonly path: string;
    readonly dir: string;
    readonly name: string;
    readonly cells: readonly number[];
    readonly unattributed: number;
    readonly total: number;
  }[];
  /** Changes falling outside the drawn agent columns, so the row's marks add up to its total. */
  readonly othersColumn: boolean;
}

/**
 * The work map as a matrix rather than a node-link diagram.
 *
 * The projection currently holds 31 agents and 1,064 files joined by 2,660 changes. Drawn as
 * a node-link graph that is a hairball at every zoom, because edge crossings grow faster than
 * the edges do -- and the escape hatch, "contested only", still returns 336 rows. A matrix
 * carries the same joins with no crossings at all: it sorts on either axis, scrolls instead
 * of dissolving, and a contested file simply *is* a row with more than one mark, which needs
 * no filter to notice.
 *
 * Bounded on both axes, since a matrix is the one shape whose cost is the product of them.
 */
export function buildMapLens(model: GraphSiteModel): MapLens {
  const byChanges = [...model.agents].sort((left, right) => right.changeCount - left.changeCount);
  const columns = byChanges.slice(0, MAP_AGENTS);
  const columnIndex = new Map(columns.map((agent, index) => [agent.id, index] as const));

  const touched = model.files.filter((file) => file.changes.length > 0);
  const ranked = [...touched].sort((left, right) => right.changes.length - left.changes.length);
  const drawn = ranked.slice(0, MAP_FILES);

  let others = false;
  const rows = drawn.map((file) => {
    const cells = new Array<number>(columns.length).fill(0);
    let unattributed = 0;
    let outside = 0;
    for (const change of file.changes) {
      if (change.agentId === null) { unattributed += 1; continue; }
      const index = columnIndex.get(change.agentId);
      if (index === undefined) { outside += 1; continue; }
      cells[index] = (cells[index] ?? 0) + 1;
    }
    if (outside > 0) others = true;
    return {
      path: file.path,
      dir: file.dir,
      name: file.name,
      cells,
      unattributed,
      total: file.changes.length,
    };
  });

  return {
    generatedAt: model.generatedAt,
    agents: columns.map((agent) => ({ id: agent.id, short: shortId(agent.id) })),
    files: bounds(touched.length, rows.length),
    rows,
    othersColumn: others,
  };
}

/* --------------------------------------------------------------- events */

export interface EventRow {
  readonly at: string;
  readonly agentId: string | null;
  readonly agentShort: string | null;
  readonly taskId: string | null;
  readonly tool: string | null;
  readonly operation: string | null;
  readonly operationTruncated: boolean;
  readonly events: number;
  readonly failed: boolean;
  readonly changed: readonly string[];
  readonly moreChanged: number;
}

export interface EventsLens {
  readonly generatedAt: string;
  readonly bounds: Bounds;
  /** Raw events the rows were folded from, so the collapse ratio is visible rather than implied. */
  readonly eventsRead: number;
  readonly rows: readonly EventRow[];
}

const PATHS_PER_ROW = 4;

/**
 * Fold the event stream into one row per call.
 *
 * A `tool.requested` and its `tool.completed` are two records of one action, and the pair is
 * most of what a hook-recorded ledger holds -- 120 raw events collapse to 40 rows on this
 * repository. The text renderer prints both, as `event-id · timestamp · type`: three columns
 * that never say what happened, while `payload.operation` held the answer the whole time.
 *
 * Grouped by `correlationId`, which is what already ties a call to its effects, so the files
 * a call changed land on the row that caused them.
 */
export function collapseEvents(events: readonly ProtocolEvent[], limit: number): EventsLens {
  const order: string[] = [];
  const groups = new Map<string, {
    at: string; agentId: string | null; taskId: string | null;
    tool: string | null; operation: string | null; events: number;
    failed: boolean; changed: Set<string>;
  }>();

  for (const event of events) {
    const key = event.correlationId ?? event.eventId;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        at: event.timestamp, agentId: event.agentId, taskId: event.taskId,
        tool: null, operation: null, events: 0, failed: false, changed: new Set<string>(),
      };
      groups.set(key, group);
      order.push(key);
    }
    group.events += 1;
    if (event.timestamp > group.at) group.at = event.timestamp;
    if (group.agentId === null && event.agentId !== null) group.agentId = event.agentId;
    if (group.taskId === null && event.taskId !== null) group.taskId = event.taskId;

    const payload = payloadOf(event);
    group.tool ??= stringField(payload, "hostToolName") ?? stringField(payload, "toolName");
    group.operation ??= stringField(payload, "operation");
    if (event.eventType === "tool.completed" && payload["outcome"] === "failed") group.failed = true;
    if (event.eventType === "file.changed") {
      const resource = payload["resource"] as { locator?: unknown } | undefined;
      if (typeof resource?.locator === "string") group.changed.add(resource.locator);
    }
  }

  // Newest first by when the call happened, not when the ledger wrote it: concurrent agents
  // journal out of order, and arrival order interleaves their calls.
  const newest = [...order]
    .sort((left, right) => (groups.get(left)!.at < groups.get(right)!.at ? 1 : -1))
    .slice(0, limit);
  const rows = newest.map((key) => {
    const group = groups.get(key)!;
    const changed = [...group.changed];
    const operation = group.operation;
    return {
      at: group.at,
      agentId: group.agentId,
      agentShort: group.agentId === null ? null : shortId(group.agentId),
      taskId: group.taskId,
      tool: group.tool,
      operation: operation === null ? null : operation.slice(0, OPERATION_CHARS),
      operationTruncated: operation !== null && operation.length > OPERATION_CHARS,
      events: group.events,
      failed: group.failed,
      changed: changed.slice(0, PATHS_PER_ROW),
      moreChanged: Math.max(changed.length - PATHS_PER_ROW, 0),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    bounds: bounds(order.length, rows.length),
    eventsRead: events.length,
    rows,
  };
}

export function buildEventsLens(services: ReadServices, limit = EVENT_ROWS): EventsLens {
  return collapseEvents(services.listEvents({}).events, limit);
}

/* ------------------------------------------------------ /graph.json fix */

/**
 * Bound the work-graph model before it is serialized.
 *
 * `/graph.json` served a bare `JSON.stringify` of the whole model and grew with the ledger
 * without limit -- 315 KB at design time, 1.76 MB two days later, re-serialized on every
 * request because the model is deliberately rebuilt per request. This is the same defect
 * `boundGaps` and `boundCoverage` fixed on the CLI's `--json` path; there were three
 * serialization boundaries and that audit found two.
 *
 * Whole change histories are the bulk of it, so they are the part that is sampled: a file
 * keeps its most recent changes and reports how many it withheld.
 */
export function boundGraphSiteModel(model: GraphSiteModel): GraphSiteModel & {
  readonly bounds: { readonly files: Bounds; readonly changesPerFile: number };
} {
  const touched = [...model.files].sort((left, right) => right.changes.length - left.changes.length);
  const kept = touched.slice(0, FILE_ROWS).map((file) => ({
    ...file,
    changes: file.changes.slice(-CHANGES_PER_FILE),
    changesWithheld: Math.max(file.changes.length - CHANGES_PER_FILE, 0),
    reads: file.reads.slice(-CHANGES_PER_FILE),
  }));

  // `fileIds` is the other half of the bulk: a busy agent carries 541 of them, each a 70-char
  // `res_<sha256>`, and the page only ever reads `.length`. So the count travels as a number
  // and the ids are sampled - 300 KB of hashes nothing dereferences.
  const sampleIds = <T extends { readonly fileIds: readonly string[] }>(entry: T) => ({
    ...entry,
    fileIds: entry.fileIds.slice(0, FILE_ID_SAMPLE),
    fileCount: entry.fileIds.length,
  });

  return {
    ...model,
    agents: model.agents.map(sampleIds),
    tasks: model.tasks.map(sampleIds),
    files: kept,
    bounds: { files: bounds(model.files.length, kept.length), changesPerFile: CHANGES_PER_FILE },
  };
}
