import type { EventId, TaskId } from "patchmesh-protocol";
import type { GraphFilters, GraphNode, GraphView, ReadServices } from "patchmesh-query";

type GraphEdge = GraphView["snapshot"]["edges"][number];

/** One recorded change to one file, with the worker and moment that produced it. */
export interface ModelChange {
  readonly at: string | null;
  readonly agentId: string | null;
  readonly taskId: string | null;
  readonly changeKind: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly eventId: EventId;
}

/** One recorded read of one file. Reads are rare on hook-recorded ledgers, so they stay flat. */
export interface ModelRead {
  readonly at: string | null;
  readonly agentId: string | null;
  readonly taskId: string | null;
  readonly eventId: EventId;
}

export interface ModelFile {
  readonly id: string;
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly kind: string;
  readonly changedBy: readonly string[];
  readonly readBy: readonly string[];
  readonly taskIds: readonly string[];
  readonly changes: readonly ModelChange[];
  readonly reads: readonly ModelRead[];
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

export interface ModelAgent {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly taskIds: readonly string[];
  readonly changeCount: number;
  readonly readCount: number;
  readonly fileIds: readonly string[];
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

export interface ModelTask {
  readonly id: string;
  readonly agentIds: readonly string[];
  readonly fileIds: readonly string[];
  readonly changeCount: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
}

/** A coverage gap collapsed to the shape `status` prints: what fell short, why, and how often. */
export interface ModelGap {
  readonly kind: string;
  readonly reason: string;
  readonly count: number;
}

export interface GraphSiteModel {
  readonly ledger: string;
  readonly generatedAt: string;
  readonly filters: GraphFilters;
  readonly counts: {
    readonly events: number;
    readonly agents: number;
    readonly tasks: number;
    readonly files: number;
    readonly changes: number;
    readonly contested: number;
    readonly unattributedChanges: number;
  };
  readonly agents: readonly ModelAgent[];
  readonly tasks: readonly ModelTask[];
  readonly files: readonly ModelFile[];
  readonly gaps: readonly ModelGap[];
}

/**
 * Resolve which agent spawned a subagent.
 *
 * The recorder names a subagent `<parentPrefix>.sub.<taskSuffix>`, and the prefix is a
 * *truncation* of the parent's id rather than the whole thing — so the parent has to be
 * looked up among the agents actually present instead of being read straight off the id.
 */
export function parentAgentId(agentId: string, agentIds: readonly string[]): string | null {
  const marker = agentId.indexOf(".sub.");
  if (marker === -1) return null;
  const prefix = agentId.slice(0, marker);
  return agentIds.find((candidate) => candidate !== agentId && candidate.startsWith(prefix)) ?? null;
}

function directoryOf(path: string): string {
  const marker = path.lastIndexOf("/");
  return marker === -1 ? "" : path.slice(0, marker);
}

function baseNameOf(path: string): string {
  const marker = path.lastIndexOf("/");
  return marker === -1 ? path : path.slice(marker + 1);
}

function earlier(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/** Mutable accumulator for one file, collapsed into a `ModelFile` once every edge is seen. */
interface FileAccumulator {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly changedBy: Set<string>;
  readonly readBy: Set<string>;
  readonly taskIds: Set<string>;
  readonly changes: ModelChange[];
  readonly reads: ModelRead[];
}

/**
 * Build the view model the graph page renders.
 *
 * The projection holds 966 nodes and 1,244 edges for four days of work in this repository,
 * two thirds of which are version nodes — a content hash is not something a person navigates
 * to, it is something they look at *once they have picked a file*. So versions collapse into
 * the change list of the file they belong to, and the page navigates the part that has names:
 * agents, the tasks they ran, and the files those tasks touched.
 */
export function buildGraphSiteModel(services: ReadServices, filters: GraphFilters, ledger: string): GraphSiteModel {
  const view = services.getGraph(filters);
  const events = services.listEvents({});

  const timestamps = new Map<EventId, string>();
  for (const event of events.events) timestamps.set(event.eventId, event.timestamp);

  // Version value by node id, so a `changes` edge can name the content it produced without
  // the page ever seeing a version node.
  const versionValues = new Map<string, string | null>();
  const nodesById = new Map<string, GraphNode>();
  for (const node of view.snapshot.nodes) {
    nodesById.set(node.nodeId, node);
    if (node.kind === "version") versionValues.set(node.nodeId, node.version.value);
  }

  const files = new Map<string, FileAccumulator>();
  for (const node of view.snapshot.nodes) {
    if (node.kind !== "resource") continue;
    files.set(node.nodeId, {
      id: node.resource.resourceId,
      path: node.resource.locator,
      kind: node.resource.kind,
      changedBy: new Set(),
      readBy: new Set(),
      taskIds: new Set(),
      changes: [],
      reads: [],
    });
  }

  const agentTasks = new Map<string, Set<string>>();
  const taskAgents = new Map<string, Set<string>>();
  for (const node of view.snapshot.nodes) {
    if (node.kind === "agent") agentTasks.set(node.agentId, agentTasks.get(node.agentId) ?? new Set());
    if (node.kind === "task") taskAgents.set(node.taskId, taskAgents.get(node.taskId) ?? new Set());
  }

  const link = (agentId: string | null, taskId: string | null): void => {
    if (agentId === null || taskId === null) return;
    (agentTasks.get(agentId) ?? agentTasks.set(agentId, new Set()).get(agentId)!).add(taskId);
    (taskAgents.get(taskId) ?? taskAgents.set(taskId, new Set()).get(taskId)!).add(agentId);
  };

  let unattributedChanges = 0;
  for (const edge of view.snapshot.edges) {
    if (edge.kind === "performs") {
      const agentId = edge.fromNodeId?.slice("agent:".length) ?? null;
      const taskId = edge.toNodeId.slice("task:".length);
      link(agentId, taskId);
      continue;
    }
    if (edge.kind !== "changes" && edge.kind !== "reads") continue;
    const file = files.get(edge.toNodeId);
    if (file === undefined) continue;
    const eventId = edge.evidenceEventIds[0] ?? ("" as EventId);
    const at = timestamps.get(eventId) ?? null;
    const { agentId, taskId } = edge.attribution;
    link(agentId, taskId);
    if (taskId !== null) file.taskIds.add(taskId);
    if (edge.kind === "reads") {
      if (agentId !== null) file.readBy.add(agentId);
      file.reads.push({ at, agentId, taskId, eventId });
      continue;
    }
    if (agentId === null) unattributedChanges += 1;
    else file.changedBy.add(agentId);
    file.changes.push({
      at,
      agentId,
      taskId,
      changeKind: edge.changeKind ?? "modified",
      before: edge.beforeVersionId == null ? null : versionValues.get(edge.beforeVersionId) ?? null,
      after: edge.afterVersionId === undefined ? null : versionValues.get(edge.afterVersionId) ?? null,
      eventId,
    });
  }

  const byTime = (left: { at: string | null }, right: { at: string | null }): number =>
    (left.at ?? "") < (right.at ?? "") ? -1 : (left.at ?? "") > (right.at ?? "") ? 1 : 0;

  const modelFiles: ModelFile[] = [...files.values()]
    .map((file) => {
      const changes = [...file.changes].sort(byTime);
      const reads = [...file.reads].sort(byTime);
      const moments = [...changes, ...reads].map((entry) => entry.at);
      return {
        id: file.id,
        path: file.path,
        dir: directoryOf(file.path),
        name: baseNameOf(file.path),
        kind: file.kind,
        changedBy: [...file.changedBy].sort(),
        readBy: [...file.readBy].sort(),
        taskIds: [...file.taskIds].sort(),
        changes,
        reads,
        firstAt: moments.reduce(earlier, null),
        lastAt: moments.reduce(later, null),
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const agentIds = [...agentTasks.keys()];
  const modelAgents: ModelAgent[] = agentIds
    .map((agentId) => {
      const touched = modelFiles.filter((file) => file.changedBy.includes(agentId) || file.readBy.includes(agentId));
      const own = modelFiles.flatMap((file) => file.changes.filter((change) => change.agentId === agentId));
      const reads = modelFiles.flatMap((file) => file.reads.filter((read) => read.agentId === agentId));
      const moments = [...own, ...reads].map((entry) => entry.at);
      return {
        id: agentId,
        label: agentId,
        parentId: parentAgentId(agentId, agentIds),
        taskIds: [...(agentTasks.get(agentId) ?? [])].sort(),
        changeCount: own.length,
        readCount: reads.length,
        fileIds: touched.map((file) => file.id),
        firstAt: moments.reduce(earlier, null),
        lastAt: moments.reduce(later, null),
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const modelTasks: ModelTask[] = [...taskAgents.keys()]
    .map((taskId) => {
      const touched = modelFiles.filter((file) => file.taskIds.includes(taskId as TaskId));
      const own = touched.flatMap((file) => file.changes.filter((change) => change.taskId === taskId));
      const moments = own.map((change) => change.at);
      return {
        id: taskId,
        agentIds: [...(taskAgents.get(taskId) ?? [])].sort(),
        fileIds: touched.map((file) => file.id),
        changeCount: own.length,
        firstAt: moments.reduce(earlier, null),
        lastAt: moments.reduce(later, null),
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const gaps = new Map<string, ModelGap>();
  for (const gap of view.coverageWarnings) {
    const key = `${gap.kind}\t${gap.reason}`;
    const existing = gaps.get(key);
    gaps.set(key, { kind: gap.kind, reason: gap.reason, count: (existing?.count ?? 0) + 1 });
  }

  return {
    ledger,
    generatedAt: new Date().toISOString(),
    filters,
    counts: {
      events: events.events.length,
      agents: modelAgents.length,
      tasks: modelTasks.length,
      files: modelFiles.length,
      changes: modelFiles.reduce((total, file) => total + file.changes.length, 0),
      contested: modelFiles.filter((file) => file.changedBy.length > 1).length,
      unattributedChanges,
    },
    agents: modelAgents,
    tasks: modelTasks,
    files: modelFiles,
    gaps: [...gaps.values()].sort((left, right) => right.count - left.count),
  };
}
