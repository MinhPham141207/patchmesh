import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AttributionCorrectedEvent,
  DependencyChangedEvent,
  EventId,
  FileChangedEvent,
  FileReadEvent,
  LogicalResource,
  ResourceId,
  ResourceVersion,
  RepositoryId,
  TaskCompletedEvent,
  TaskId,
  ToolCompletedEvent,
  ToolRequestedEvent,
  ProtocolEvent,
  WorktreeId,
  WorkspaceId,
} from "patchmesh-protocol";
import { canonicalBytes, StorageError } from "../src/index.js";
import { coverageId, versionNodeId } from "../src/work-graph-ids.js";
import { WorkGraphProjector, projectWorkGraph } from "../src/work-graph.js";
import type { GraphNode } from "../src/work-graph-types.js";

const repositoryId = "repo_11111111-1111-4111-8111-111111111111" as RepositoryId;
const workspaceId = "ws_22222222-2222-4222-8222-222222222222" as WorkspaceId;
const resourceId = `res_${"a".repeat(64)}` as ResourceId;
const otherResourceId = `res_${"b".repeat(64)}` as ResourceId;
const taskId = "task_task-a" as TaskId;

const resource: LogicalResource = {
  resourceId,
  repositoryId,
  kind: "file",
  locator: "src/example.ts",
};

const otherResource: LogicalResource = {
  resourceId: otherResourceId,
  repositoryId,
  kind: "file",
  locator: "src/consumer.ts",
};

function versionForWorktree(worktreeId: WorktreeId): ResourceVersion {
  return {
    resourceId,
    domain: { repositoryId, workspaceId, worktreeId },
    kind: "content_hash",
    value: "hash",
    evidenceEventIds: ["evt_00000000000000000000000000000001" as EventId],
  };
}

function contentVersion(id: ResourceId, value: string, eventId: string): ResourceVersion {
  return {
    resourceId: id,
    domain: {
      repositoryId,
      workspaceId,
      worktreeId: "wt_33333333-3333-4333-8333-333333333333" as WorktreeId,
    },
    kind: "content_hash",
    value,
    evidenceEventIds: [eventId as EventId],
  };
}

function baseEvent(
  eventId: string,
  correlationId: string,
  agentId: string | null = "agent_agent-a",
  taskIdValue: TaskId | null = taskId,
): Omit<ProtocolEvent, "eventType" | "payload"> {
  return {
    schemaVersion: 1,
    eventId: eventId as EventId,
    source: {
      kind: "watcher",
      sourceId: "source_watcher",
      instanceId: "11111111-1111-4111-8111-111111111111",
    },
    timestamp: "2026-08-08T00:00:00.000Z",
    repositoryId,
    workspaceId,
    worktreeId: "wt_33333333-3333-4333-8333-333333333333" as WorktreeId,
    agentId: agentId as ProtocolEvent["agentId"],
    taskId: taskIdValue,
    correlationId: correlationId as ProtocolEvent["correlationId"],
    causationId: null,
    sourceSequence: null,
  };
}

const fileRead: FileReadEvent = {
  ...baseEvent("evt_00000000000000000000000000000011", "corr_00000000000000000000000000000011"),
  eventType: "file.read",
  payload: {
    resource,
    version: contentVersion(resourceId, "before", "evt_00000000000000000000000000000011"),
    access: "read",
  },
};

const fileChanged: FileChangedEvent = {
  ...baseEvent("evt_00000000000000000000000000000012", "corr_00000000000000000000000000000012"),
  eventType: "file.changed",
  payload: {
    resource,
    beforeVersion: contentVersion(resourceId, "before", "evt_00000000000000000000000000000012"),
    afterVersion: contentVersion(resourceId, "after", "evt_00000000000000000000000000000012"),
    changeKind: "modified",
  },
};

const otherFileRead: FileReadEvent = {
  ...baseEvent("evt_00000000000000000000000000000015", "corr_00000000000000000000000000000015"),
  eventType: "file.read",
  payload: {
    resource: otherResource,
    version: contentVersion(otherResourceId, "consumer", "evt_00000000000000000000000000000015"),
    access: "read",
  },
};

const unattributedRead: FileReadEvent = {
  ...baseEvent(
    "evt_00000000000000000000000000000016",
    "corr_00000000000000000000000000000016",
    null,
    null,
  ),
  eventType: "file.read",
  payload: {
    resource,
    version: contentVersion(resourceId, "unattributed", "evt_00000000000000000000000000000016"),
    access: "read",
  },
};

const attributionCorrection: AttributionCorrectedEvent = {
  ...baseEvent("evt_00000000000000000000000000000017", unattributedRead.correlationId),
  eventType: "attribution.corrected",
  causationId: unattributedRead.eventId,
  payload: {
    targetEventId: unattributedRead.eventId,
    attributedAgentId: "agent_agent-a",
    attributedTaskId: taskId,
    reason: "task attribution became available",
    evidenceEventIds: ["evt_00000000000000000000000000000017" as EventId],
  },
};

const toolRequest: ToolRequestedEvent = {
  ...baseEvent("evt_00000000000000000000000000000018", "corr_00000000000000000000000000000018"),
  eventType: "tool.requested",
  source: {
    kind: "gateway",
    sourceId: "source_gateway",
    instanceId: "11111111-1111-4111-8111-111111111111",
  },
  sourceSequence: 0,
  payload: {
    toolName: "edit_file",
    operation: "edit src/example.ts",
    targetResourceId: resourceId,
    opaque: false,
  },
};

const linkedEffect: FileChangedEvent = {
  ...fileChanged,
  eventId: "evt_00000000000000000000000000000019",
  correlationId: toolRequest.correlationId,
  causationId: toolRequest.eventId,
};

const directlyObservedEffect: FileChangedEvent = {
  ...linkedEffect,
  source: toolRequest.source,
};

const toolCompletion: ToolCompletedEvent = {
  ...baseEvent("evt_00000000000000000000000000000020", toolRequest.correlationId),
  eventType: "tool.completed",
  source: toolRequest.source,
  causationId: toolRequest.eventId,
  sourceSequence: 1,
  payload: {
    requestEventId: toolRequest.eventId,
    outcome: "succeeded",
    exitCode: 0,
    effectEventIds: [linkedEffect.eventId],
  },
};

const deterministicallyAttributedToolCompletion: ToolCompletedEvent = {
  ...toolCompletion,
  eventId: "evt_00000000000000000000000000000031",
  sourceSequence: 6,
  payload: {
    ...toolCompletion.payload,
    deterministicallyAttributedEffectEventIds: [linkedEffect.eventId],
  },
};

const opaqueToolRequest: ToolRequestedEvent = {
  ...toolRequest,
  eventId: "evt_00000000000000000000000000000021",
  correlationId: "corr_00000000000000000000000000000021",
  sourceSequence: 2,
  payload: { ...toolRequest.payload, opaque: true },
};

const opaqueToolCompletion: ToolCompletedEvent = {
  ...toolCompletion,
  eventId: "evt_00000000000000000000000000000022",
  correlationId: opaqueToolRequest.correlationId,
  causationId: opaqueToolRequest.eventId,
  sourceSequence: 3,
  payload: {
    ...toolCompletion.payload,
    requestEventId: opaqueToolRequest.eventId,
    effectEventIds: [],
  },
};

const unresolvedEffectCompletion: ToolCompletedEvent = {
  ...toolCompletion,
  eventId: "evt_00000000000000000000000000000023",
  correlationId: toolRequest.correlationId,
  causationId: toolRequest.eventId,
  sourceSequence: 4,
  payload: {
    ...toolCompletion.payload,
    effectEventIds: ["evt_00000000000000000000000000000099" as EventId],
  },
};

const noEffectCompletion: ToolCompletedEvent = {
  ...toolCompletion,
  eventId: "evt_00000000000000000000000000000025",
  correlationId: toolRequest.correlationId,
  causationId: toolRequest.eventId,
  sourceSequence: 5,
  payload: {
    ...toolCompletion.payload,
    effectEventIds: [],
  },
};

const outOfBandChange: FileChangedEvent = {
  ...fileChanged,
  eventId: "evt_00000000000000000000000000000024",
  correlationId: "corr_00000000000000000000000000000024",
  agentId: null,
  taskId: null,
  causationId: null,
};

const projectionEvents: readonly ProtocolEvent[] = [
  {
    ...baseEvent("evt_00000000000000000000000000000026", "corr_00000000000000000000000000000026"),
    eventType: "finding.created",
    payload: { finding: {} as never },
  } as ProtocolEvent,
  {
    ...baseEvent("evt_00000000000000000000000000000027", "corr_00000000000000000000000000000027"),
    eventType: "decision.created",
    payload: { decision: {} as never },
  } as ProtocolEvent,
  {
    ...baseEvent("evt_00000000000000000000000000000028", "corr_00000000000000000000000000000028"),
    eventType: "validity.changed",
    payload: { record: {} as never, transition: {} as never },
  } as ProtocolEvent,
  {
    ...baseEvent("evt_00000000000000000000000000000029", "corr_00000000000000000000000000000029"),
    eventType: "decision.delivery.changed",
    payload: { decisionId: "decision_projection-a", delivery: {} as never },
  } as ProtocolEvent,
];

const taskCompleted: TaskCompletedEvent = {
  ...baseEvent("evt_00000000000000000000000000000013", "corr_00000000000000000000000000000013"),
  eventType: "task.completed",
  payload: {
    workProductId: "work_product-a",
    baseRevision: "commit-a",
    targetSnapshotId: "snapshot_target-a",
    resourceIds: [resourceId],
  },
};

const dependencyChanged: DependencyChangedEvent = {
  ...baseEvent("evt_00000000000000000000000000000014", "corr_00000000000000000000000000000014"),
  eventType: "dependency.changed",
  payload: {
    dependency: {
      dependencyId: "dep_dependency-a",
      dependentResourceId: otherResourceId,
      dependencyResourceId: resourceId,
      dependentVersion: contentVersion(otherResourceId, "consumer", "evt_00000000000000000000000000000014"),
      dependencyVersion: contentVersion(resourceId, "after", "evt_00000000000000000000000000000014"),
      observations: [{
        kind: "declared",
        producer: { sourceId: "source_watcher", version: "1" },
        rule: null,
        evidenceEventIds: ["evt_00000000000000000000000000000014" as EventId],
      }],
      evidenceEventIds: ["evt_00000000000000000000000000000014" as EventId],
    },
  },
};

function projectOrdered(events: readonly ProtocolEvent[]) {
  return projectWorkGraph(events);
}

test("version identity includes its version domain", () => {
  const left = versionNodeId(versionForWorktree("wt_33333333-3333-4333-8333-333333333333" as WorktreeId));
  const right = versionNodeId(versionForWorktree("wt_44444444-4444-4444-8444-444444444444" as WorktreeId));

  assert.notEqual(left, right);
});

test("coverage identity is independent of input ordering", () => {
  assert.equal(
    coverageId({
      scope: "tool:evt_a",
      modes: ["verified", "intercepted"],
      gaps: [],
      evidenceEventIds: ["evt_b", "evt_a"],
    }),
    coverageId({
      scope: "tool:evt_a",
      modes: ["intercepted", "verified"],
      gaps: [],
      evidenceEventIds: ["evt_a", "evt_b"],
    }),
  );
});

test("projects resource observations and dependency evidence", () => {
  const snapshot = projectOrdered([fileRead, otherFileRead, fileChanged, taskCompleted, dependencyChanged]).snapshot;

  assert.equal(snapshot.nodes.filter((node) => node.kind === "agent").length, 1);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "task").length, 1);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "resource").length, 2);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "version").length >= 3, true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "performs"), true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "reads"), true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "changes" && edge.changeKind === "modified"), true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "references_version"), true);
  assert.equal(snapshot.edges.some((edge) => edge.kind === "depends_on" && edge.dependency?.dependencyId === "dep_dependency-a"), true);
});

test("correction changes projected attribution but not the source event", () => {
  const result = projectOrdered([unattributedRead, attributionCorrection]);
  const read = result.orderedEvents.find((event) => event.eventId === unattributedRead.eventId);
  const readEdge = result.snapshot.edges.find((edge) => edge.kind === "reads");

  assert.equal(read?.agentId, null);
  assert.equal(read?.taskId, null);
  assert.equal(readEdge?.attribution.agentId, "agent_agent-a");
  assert.equal(readEdge?.attribution.taskId, taskId);
});

test("derives verified coverage from directly observed linked effects", () => {
  const coverage = projectOrdered([toolRequest, directlyObservedEffect, toolCompletion]).snapshot.coverage;

  assert.equal(coverage.some((value) => value.modes.includes("intercepted") && value.modes.includes("verified")), true);
});

test("derives verified coverage from an explicit read linked to a completed read-only call", () => {
  const linkedRead: FileReadEvent = {
    ...fileRead,
    correlationId: toolRequest.correlationId,
    causationId: toolRequest.eventId,
  };
  const coverage = projectOrdered([toolRequest, linkedRead, noEffectCompletion]).snapshot.coverage;

  assert.equal(coverage.some((value) => value.presentation === "sufficient" && value.evidenceEventIds.includes(linkedRead.eventId)), true);
});

test("degrades snapshot-watcher effect coverage because origin is uncertain", () => {
  const coverage = projectOrdered([toolRequest, linkedEffect, toolCompletion]).snapshot.coverage;

  assert.equal(coverage.some((value) => value.presentation === "degraded"), true);
  assert.equal(
    coverage.some((value) => value.gaps.some((gap) => gap.reason.includes("effect origin cannot be proven"))),
    true,
  );
});

test("derives sufficient coverage from durable deterministic watcher attribution", () => {
  const coverage = projectOrdered([
    toolRequest,
    linkedEffect,
    deterministicallyAttributedToolCompletion,
  ]).snapshot.coverage;

  assert.equal(coverage.some((value) => value.presentation === "sufficient"), true);
  assert.equal(coverage.some((value) => value.gaps.some((gap) => gap.reason.includes("effect origin cannot be proven"))), false);
});

test("reports degraded coverage for opaque and unresolved effects", () => {
  const opaque = projectOrdered([opaqueToolRequest, opaqueToolCompletion]).snapshot.coverage;
  const unresolved = projectOrdered([toolRequest, unresolvedEffectCompletion]).snapshot.coverage;

  assert.equal(opaque.some((value) => value.gaps.some((gap) => gap.kind === "opaque")), true);
  assert.equal(unresolved.some((value) => value.gaps.some((gap) => gap.kind === "unverified")), true);
});

test("an opaque call whose effect was bound by observation is not a coverage gap", () => {
  // The shape a hook recorder actually produces: `effectEventIds` is empty because the
  // completion is written before the filesystem is diffed, and the change points back at the
  // completion instead. `effects.ts` sets that causation only when exactly one call's window
  // covered the change, so it is the deterministic binding.
  const boundChange: FileChangedEvent = {
    ...fileChanged,
    eventId: "evt_00000000000000000000000000000041",
    correlationId: opaqueToolRequest.correlationId,
    causationId: opaqueToolCompletion.eventId,
  };
  const coverage = projectOrdered([opaqueToolRequest, opaqueToolCompletion, boundChange]).snapshot.coverage;
  const toolScope = coverage.find((value) => value.scope === `tool:${opaqueToolRequest.eventId}`);

  assert.ok(toolScope, "the opaque call still has a coverage scope");
  // Opacity is about intent, not effect. The write is known; what the command meant is not.
  assert.equal(toolScope.gaps.some((gap) => gap.kind === "opaque"), false);
  assert.equal(toolScope.presentation, "sufficient");
  assert.equal(toolScope.evidenceEventIds.includes(boundChange.eventId), true);
});

test("an opaque call with no observed effect stays a gap, because a read leaves no trace", () => {
  const coverage = projectOrdered([opaqueToolRequest, opaqueToolCompletion]).snapshot.coverage;
  const toolScope = coverage.find((value) => value.scope === `tool:${opaqueToolRequest.eventId}`);

  assert.ok(toolScope);
  assert.equal(toolScope.gaps.some((gap) => gap.kind === "opaque"), true);
});

test("reports unattributed out-of-band coverage and interception-only coverage", () => {
  const outOfBand = projectOrdered([outOfBandChange]).snapshot.coverage;
  const replay = projectOrdered([toolRequest, noEffectCompletion]);
  const interceptedOnly = replay.snapshot.coverage;

  assert.equal(outOfBand.some((value) => value.gaps.some((gap) => gap.kind === "unattributed")), true);
  assert.equal(interceptedOnly.some((value) => value.presentation === "unknown"), true);
  assert.equal(interceptedOnly.some((value) => value.gaps.some((gap) => gap.kind === "missing_sequence")), true);
  assert.deepEqual(replay.sourceSequenceGaps[0]?.missingRanges, [{ from: 1, to: 4 }]);
});

test("canonical and causally out-of-order projection inputs converge", () => {
  const canonical = projectOrdered([toolRequest, linkedEffect, toolCompletion]);
  const outOfOrder = projectOrdered([toolCompletion, linkedEffect, toolRequest]);

  assert.deepEqual(canonicalBytes(canonical.snapshot), canonicalBytes(outOfOrder.snapshot));
});

test("incremental and clean replay produce byte-equivalent snapshots", () => {
  const projector = new WorkGraphProjector();
  for (const event of [toolRequest, linkedEffect, toolCompletion]) projector.process(event);
  const rebuilt = projectOrdered([toolRequest, linkedEffect, toolCompletion]);

  assert.deepEqual(canonicalBytes(projector.snapshot()), canonicalBytes(rebuilt.snapshot));
});

test("projection snapshots are deeply frozen", () => {
  const snapshot = projectOrdered([fileRead]).snapshot;

  assert.throws(() => {
    (snapshot.nodes as GraphNode[]).push(snapshot.nodes[0]!);
  }, TypeError);
  assert.throws(() => {
    (snapshot.nodes[0]!.evidenceEventIds as EventId[]).push("evt_mutation" as EventId);
  }, TypeError);
});

test("replay validation fails before a projection snapshot is returned", () => {
  const missingParent = {
    ...toolCompletion,
    eventId: "evt_00000000000000000000000000000030" as EventId,
    causationId: "evt_00000000000000000000000000000099" as EventId,
    payload: {
      ...toolCompletion.payload,
      requestEventId: "evt_00000000000000000000000000000099" as EventId,
      effectEventIds: [],
    },
  };

  assert.throws(
    () => projectOrdered([missingParent]),
    (error: unknown) => error instanceof StorageError && error.code === "PHASE0_REFERENCE_MISSING",
  );
});

test("projection event types expose rebuildable Phase 2 view containers", () => {
  const snapshot = projectOrdered(projectionEvents).snapshot;

  assert.deepEqual(snapshot.edges.filter((edge) => edge.kind === "changes"), []);
  assert.deepEqual(snapshot.coverage, []);
  assert.equal(snapshot.findings.length, 1);
  assert.equal(snapshot.decisions.length, 1);
});

/**
 * A ledger of `count` intercepted calls, each with its completion, plus an observed read bound
 * to every fourth one so `toolCoverage` has evidence to gather.
 *
 * Deliberately uniform. This exists to measure how cost scales with size, so the events must
 * differ only in identity and order.
 */
function syntheticCalls(count: number): readonly ProtocolEvent[] {
  const events: ProtocolEvent[] = [];
  const gateway = {
    kind: "gateway",
    sourceId: "source_gateway",
    instanceId: "11111111-1111-4111-8111-111111111111",
  } as const;
  const id = (prefix: string, index: number): string => `${prefix}_${String(index).padStart(32, "0")}`;
  let sequence = 0;

  for (let index = 0; index < count; index += 1) {
    const requestEventId = id("evt", index * 3) as EventId;
    const completionEventId = id("evt", index * 3 + 1) as EventId;
    const correlationId = id("corr", index) as ProtocolEvent["correlationId"];
    const at = new Date(Date.parse("2026-08-08T00:00:00.000Z") + index * 1000).toISOString();

    const request: ToolRequestedEvent = {
      ...baseEvent(requestEventId, correlationId),
      source: gateway,
      sourceSequence: sequence,
      timestamp: at,
      eventType: "tool.requested",
      payload: { toolName: "edit_file", operation: `edit src/f${index}.ts`, targetResourceId: resourceId, opaque: false },
    };
    sequence += 1;

    const completion: ToolCompletedEvent = {
      ...baseEvent(completionEventId, correlationId),
      source: gateway,
      sourceSequence: sequence,
      timestamp: at,
      causationId: requestEventId,
      eventType: "tool.completed",
      payload: { requestEventId, outcome: "succeeded", effectEventIds: [] },
    };
    sequence += 1;

    events.push(request, completion);

    if (index % 4 === 0) {
      const read: FileReadEvent = {
        ...baseEvent(id("evt", index * 3 + 2) as EventId, correlationId),
        timestamp: at,
        causationId: requestEventId,
        eventType: "file.read",
        payload: { resource, version: contentVersion(resourceId, `v${index}`, requestEventId), access: "read" },
      };
      events.push(read);
    }
  }
  return events;
}

function bestOfThree(events: readonly ProtocolEvent[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    projectWorkGraph(events);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test("projection cost stays near-linear in the size of the ledger", () => {
  // This guards a bug that was fixed once and came back. `toolCoverage` looked up the reads
  // belonging to a call by filtering *every event in the ledger*, once per call, which made the
  // whole projection O(requests x events); a second, smaller one re-sorted a node's entire
  // evidence list on every touch, which is O(k^2 log k) on the nodes touched most.
  //
  // Measured on this repository's real 8,931-event ledger, cost rose 4x for every doubling:
  // 227ms at 1,000 events, 902ms at 2,000, 3,365ms at 4,000, 14,047ms at 8,000. `patchmesh
  // status` took 41 seconds. Every fixture-sized test passed throughout, which is exactly why
  // it survived twice -- a few dozen events cannot tell the two curves apart.
  //
  // Asserted as a ratio rather than a wall-clock budget, so it means the same thing on a fast
  // machine and a loaded one. Quadratic predicts ~16x for a 4x larger input; linear predicts 4x.
  // The bound sits between them with room for noise, and each side takes the best of three.
  const small = bestOfThree(syntheticCalls(400));
  const large = bestOfThree(syntheticCalls(1600));

  const ratio = large / Math.max(small, 1);
  assert.ok(
    ratio < 9,
    `projecting 4x the events took ${ratio.toFixed(1)}x the time (${small.toFixed(0)}ms -> ${large.toFixed(0)}ms); `
      + "linear is ~4x and quadratic is ~16x, so this reads as a scan-per-event that should be an index",
  );
});
