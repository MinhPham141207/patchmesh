import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  DecisionCreatedEvent,
  DecisionDeliveryChangedEvent,
  DependentWriteEvent,
  DependencyChangedEvent,
  FileChangedEvent,
  FileReadEvent,
  FindingCreatedEvent,
  FindingFeedbackCreatedEvent,
  ProtocolEvent,
  ToolCompletedEvent,
  ToolRequestedEvent,
} from "patchmesh-protocol";
import { projectWorkGraph, SqliteEventStore, StorageError } from "../src/index.js";
import { replayEvents } from "../src/replay.js";

async function withTemporaryDatabase(run: (databasePath: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m2-replay-"));
  const databasePath = join(directory, "events.sqlite");
  try {
    await run(databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const request: ToolRequestedEvent = {
  schemaVersion: 1,
  eventId: "evt_00000000000000000000000000000001",
  eventType: "tool.requested",
  source: {
    kind: "gateway",
    sourceId: "source_gateway",
    instanceId: "11111111-1111-4111-8111-111111111111",
  },
  timestamp: "2026-08-08T00:00:00.000Z",
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_22222222-2222-4222-8222-222222222222",
  worktreeId: "wt_33333333-3333-4333-8333-333333333333",
  agentId: "agent_a",
  taskId: null,
  correlationId: "corr_00000000000000000000000000000001",
  causationId: null,
  sourceSequence: 0,
  payload: {
    toolName: "read_file",
    operation: "read src/example.ts",
    targetResourceId: null,
    opaque: false,
  },
};

const completion: ToolCompletedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000002",
  eventType: "tool.completed",
  causationId: request.eventId,
  sourceSequence: 1,
  payload: {
    requestEventId: request.eventId,
    outcome: "succeeded",
    exitCode: 0,
    effectEventIds: [],
  },
};

const missingParentCompletion: ToolCompletedEvent = {
  ...completion,
  eventId: "evt_00000000000000000000000000000003",
  causationId: "evt_00000000000000000000000000000099",
  payload: {
    ...completion.payload,
    requestEventId: "evt_00000000000000000000000000000099",
  },
};

const cycleA: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000004",
  correlationId: "corr_00000000000000000000000000000002",
  causationId: "evt_00000000000000000000000000000005",
};

const cycleB: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000005",
  correlationId: cycleA.correlationId,
  causationId: cycleA.eventId,
  sourceSequence: 1,
};

const impossibleCompletion: ToolCompletedEvent = {
  ...completion,
  eventId: "evt_00000000000000000000000000000006",
  causationId: null,
  payload: {
    ...completion.payload,
    requestEventId: "evt_00000000000000000000000000000006",
  },
};

const gapCompletion: ToolCompletedEvent = {
  ...completion,
  eventId: "evt_00000000000000000000000000000007",
  sourceSequence: 2,
};

const rootA: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000010",
  correlationId: "corr_00000000000000000000000000000003",
  sourceSequence: 0,
};

const rootB: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000020",
  correlationId: "corr_00000000000000000000000000000004",
  sourceSequence: 1,
};

const childWithEarlierId: ToolRequestedEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000005",
  correlationId: rootA.correlationId,
  causationId: rootA.eventId,
  sourceSequence: 2,
};

const invalidFileRead: FileReadEvent = {
  ...request,
  eventId: "evt_00000000000000000000000000000030",
  eventType: "file.read",
  correlationId: "corr_00000000000000000000000000000005",
  payload: {
    resource: {
      resourceId: "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repositoryId: "repo_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "file",
      locator: "src/example.ts",
    },
    version: {
      resourceId: "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      domain: {
        repositoryId: request.repositoryId,
        workspaceId: request.workspaceId,
        worktreeId: request.worktreeId,
      },
      kind: "content_hash",
      value: "hash",
      evidenceEventIds: [request.eventId],
    },
    access: "read",
  },
};

const v2ResourceId = `res_${"3".repeat(64)}` as const;
const v2DependencyResourceId = `res_${"4".repeat(64)}` as const;
const v2CoverageId = `coverage_${"5".repeat(32)}` as const;
const v2Domain = {
  repositoryId: request.repositoryId,
  workspaceId: request.workspaceId,
  worktreeId: request.worktreeId,
};

const v2Finding: FindingCreatedEvent = {
  ...request,
  eventId: `evt_${"4".repeat(32)}`,
  eventType: "finding.created",
  taskId: "task_a",
  correlationId: `corr_${"4".repeat(32)}`,
  sourceSequence: null,
  payload: {
    finding: {
      findingId: `finding_${"4".repeat(32)}`,
      findingType: "same_symbol_overlap",
      status: "open",
      subjectResourceId: v2ResourceId,
      affectedTaskId: "task_a",
      dependencyIds: [],
      evidenceEventIds: [`evt_${"4".repeat(32)}`],
      confidence: 0.9,
      confidenceBand: "high",
      severity: "warning",
      coverageIds: [v2CoverageId],
      detector: { detectorId: "detector_phase2", version: "1" },
    },
  },
};

const v2Decision: DecisionCreatedEvent = {
  ...v2Finding,
  eventId: `evt_${"4".repeat(31)}5`,
  eventType: "decision.created",
  causationId: v2Finding.eventId,
  payload: {
    decision: {
      decisionId: `decision_${"4".repeat(31)}5`,
      findingId: v2Finding.payload.finding.findingId,
      target: { agentId: "agent_a", taskId: "task_a" },
      coordinationAction: "notify",
      gatewayDirective: "allow_with_notice",
      reason: "overlap is confirmed",
      evidenceEventIds: [v2Finding.eventId],
      confidence: 0.9,
      confidenceBand: "high",
      policy: { policyId: "policy_phase2", version: "1" },
      expectedResponse: "affected",
      coverageIds: [v2CoverageId],
      state: "active",
      deliveries: [],
    },
  },
};

const v2Feedback: FindingFeedbackCreatedEvent = {
  ...v2Finding,
  schemaVersion: 2,
  eventId: `evt_${"3".repeat(32)}`,
  eventType: "finding.feedback.created",
  causationId: `evt_${"4".repeat(31)}6`,
  payload: {
    feedback: {
      feedbackId: `feedback_${"4".repeat(31)}7`,
      findingId: v2Finding.payload.finding.findingId,
      decisionId: v2Decision.payload.decision.decisionId,
      actor: { agentId: "agent_a", taskId: "task_a" },
      disposition: "dismissed",
      useful: true,
      reason: "notification prevented redundant work",
      evidenceEventIds: [v2Finding.eventId, v2Decision.eventId],
    },
  },
};

const v2Delivery: DecisionDeliveryChangedEvent = {
  ...v2Finding,
  eventId: `evt_${"4".repeat(31)}6`,
  eventType: "decision.delivery.changed",
  causationId: v2Decision.eventId,
  payload: {
    decisionId: v2Decision.payload.decision.decisionId,
    delivery: {
      deliveryId: `delivery_${"4".repeat(31)}6`,
      target: { agentId: "agent_a", taskId: "task_a" },
      state: "delivered",
      eventIds: [`evt_${"4".repeat(31)}6`],
    },
  },
};

const v2Read: FileReadEvent = {
  ...request,
  eventId: `evt_${"5".repeat(32)}`,
  eventType: "file.read",
  taskId: "task_a",
  correlationId: `corr_${"5".repeat(32)}`,
  sourceSequence: null,
  payload: {
    resource: {
      resourceId: v2DependencyResourceId,
      repositoryId: request.repositoryId,
      kind: "file",
      locator: "src/dependency.ts",
    },
    version: {
      resourceId: v2DependencyResourceId,
      domain: v2Domain,
      kind: "content_hash",
      value: `sha256:${"5".repeat(64)}`,
      evidenceEventIds: [`evt_${"5".repeat(32)}`],
    },
    access: "read",
  },
};

const v2Dependency: DependencyChangedEvent = {
  ...request,
  eventId: `evt_${"5".repeat(31)}6`,
  eventType: "dependency.changed",
  taskId: "task_a",
  correlationId: `corr_${"5".repeat(31)}6`,
  sourceSequence: null,
  payload: {
    dependency: {
      dependencyId: `dep_${"5".repeat(31)}6`,
      dependentResourceId: v2ResourceId,
      dependencyResourceId: v2DependencyResourceId,
      dependentVersion: {
        resourceId: v2ResourceId,
        domain: v2Domain,
        kind: "content_hash",
        value: `sha256:${"3".repeat(64)}`,
        evidenceEventIds: [`evt_${"5".repeat(31)}6`],
      },
      dependencyVersion: v2Read.payload.version,
      observations: [{
        kind: "declared",
        producer: { sourceId: "source_gateway", version: "1" },
        rule: null,
        evidenceEventIds: [`evt_${"5".repeat(31)}6`],
      }],
      evidenceEventIds: [`evt_${"5".repeat(31)}6`],
    },
  },
};

const v2Change: FileChangedEvent = {
  ...request,
  eventId: `evt_${"5".repeat(31)}7`,
  eventType: "file.changed",
  taskId: "task_a",
  correlationId: `corr_${"5".repeat(31)}7`,
  sourceSequence: null,
  payload: {
    resource: {
      resourceId: v2ResourceId,
      repositoryId: request.repositoryId,
      kind: "file",
      locator: "src/dependent.ts",
    },
    beforeVersion: v2Dependency.payload.dependency.dependentVersion,
    afterVersion: {
      ...v2Dependency.payload.dependency.dependentVersion,
      value: `sha256:${"6".repeat(64)}`,
      evidenceEventIds: [`evt_${"5".repeat(31)}7`],
    },
    changeKind: "modified",
  },
};

const v2DependentWrite: DependentWriteEvent = {
  ...request,
  schemaVersion: 2,
  eventId: `evt_${"5".repeat(31)}8`,
  eventType: "write.dependent",
  taskId: "task_a",
  correlationId: v2Change.correlationId,
  causationId: v2Change.eventId,
  sourceSequence: null,
  payload: {
    write: {
      dependencyId: v2Dependency.payload.dependency.dependencyId,
      resourceId: v2ResourceId,
      dependsOnReadEventId: v2Read.eventId,
      coverageId: v2CoverageId,
    },
  },
};

const v2ReplayEvents: readonly ProtocolEvent[] = [
  v2Finding,
  v2Decision,
  v2Delivery,
  v2Feedback,
  v2Read,
  v2Dependency,
  v2Change,
  v2DependentWrite,
];

test("canonical and causally out-of-order input converge", () => withTemporaryDatabase(async (canonicalPath) => {
  await withTemporaryDatabase((outOfOrderPath) => {
    const canonical = SqliteEventStore.open(canonicalPath);
    const outOfOrder = SqliteEventStore.open(outOfOrderPath);
    try {
      assert.equal(canonical.append(request).status, "inserted");
      assert.equal(canonical.append(completion).status, "inserted");
      assert.equal(outOfOrder.append(completion).status, "inserted");
      assert.equal(outOfOrder.append(request).status, "inserted");
      assert.equal(outOfOrder.append(structuredClone(request)).status, "duplicate");

      assert.deepEqual(
        outOfOrder.read().map((event) => event.eventId),
        [completion.eventId, request.eventId],
      );

      const canonicalReplay = canonical.replay();
      const outOfOrderReplay = outOfOrder.replay();
      assert.deepEqual(
        canonicalReplay.orderedEvents.map((event) => event.eventId),
        outOfOrderReplay.orderedEvents.map((event) => event.eventId),
      );
      assert.deepEqual(canonicalReplay.state, outOfOrderReplay.state);
    } finally {
      canonical.close();
      outOfOrder.close();
    }
  });
}));

test("V2 feedback and dependent-write replay converges under duplicates and out-of-order arrival", () =>
  withTemporaryDatabase(async (canonicalPath) => {
    await withTemporaryDatabase((outOfOrderPath) => {
      const canonical = SqliteEventStore.open(canonicalPath);
      const outOfOrder = SqliteEventStore.open(outOfOrderPath);
      const reversed = [...v2ReplayEvents].reverse();
      try {
        for (const event of v2ReplayEvents) assert.equal(canonical.append(event).status, "inserted");
        for (const event of reversed) assert.equal(outOfOrder.append(event).status, "inserted");
        assert.equal(outOfOrder.append(structuredClone(v2Feedback)).status, "duplicate");
        assert.equal(outOfOrder.append(structuredClone(v2DependentWrite)).status, "duplicate");

        assert.deepEqual(
          outOfOrder.read().map((event) => event.eventId),
          reversed.map((event) => event.eventId),
        );

        const canonicalReplay = canonical.replay();
        const outOfOrderReplay = outOfOrder.replay();
        assert.deepEqual(
          outOfOrderReplay.orderedEvents.map((event) => event.eventId),
          v2ReplayEvents.map((event) => event.eventId),
        );
        assert.deepEqual(outOfOrderReplay.state, canonicalReplay.state);

        const canonicalProjection = projectWorkGraph(canonical.read());
        const outOfOrderProjection = projectWorkGraph(outOfOrder.read());
        assert.deepEqual(outOfOrderProjection.snapshot, canonicalProjection.snapshot);
        assert.equal(outOfOrderProjection.snapshot.findings[0]?.status, "dismissed");
        assert.equal(outOfOrderProjection.snapshot.findings[0]?.feedback[0]?.feedback.useful, true);
        assert.equal(outOfOrderProjection.snapshot.decisions[0]?.deliveries[0]?.state, "delivered");
        assert.equal(outOfOrderProjection.snapshot.decisions[0]?.feedback.length, 1);
      } finally {
        canonical.close();
        outOfOrder.close();
      }
    });
  }));

test("replays a large independent corpus without quadratic ready-event scanning", { timeout: 5_000 }, () => {
  const events: FileReadEvent[] = Array.from({ length: 20_000 }, (_, index) => {
    const eventId = `evt_${index.toString(16).padStart(32, "0")}` as FileReadEvent["eventId"];
    const resourceId = `res_${(index + 1).toString(16).padStart(64, "0")}`;
    return {
      ...request,
      eventId,
      eventType: "file.read",
      correlationId: `corr_${index.toString(16).padStart(32, "0")}`,
      sourceSequence: index,
      payload: {
        resource: {
          resourceId,
          repositoryId: request.repositoryId,
          kind: "file",
          locator: `src/replay-${index}.ts`,
        },
        version: {
          resourceId,
          domain: {
            repositoryId: request.repositoryId,
            workspaceId: request.workspaceId,
            worktreeId: request.worktreeId,
          },
          kind: "content_hash",
          value: `sha256-${index}`,
          evidenceEventIds: [eventId],
        },
        access: "read",
      },
    };
  });
  const started = performance.now();
  const replay = replayEvents(events);
  assert.equal(replay.orderedEvents.length, events.length);
  assert.ok(performance.now() - started < 4_000);
});

test("newly unblocked events participate in the global ready-event tie-break", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(rootB);
    store.append(childWithEarlierId);
    store.append(rootA);

    assert.deepEqual(
      store.replay().orderedEvents.map((event) => event.eventId),
      [rootA.eventId, childWithEarlierId.eventId, rootB.eventId],
    );
  } finally {
    store.close();
  }
}));

test("missing causal parent fails replay without a result", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(missingParentCompletion);

    assert.throws(
      () => store.replay(),
      (error: unknown) => error instanceof StorageError && error.code === "PHASE0_REFERENCE_MISSING",
    );
  } finally {
    store.close();
  }
}));

test("causal cycle fails with a bounded replay error", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(cycleA);
    store.append(cycleB);

    assert.throws(
      () => store.replay(),
      (error: unknown) => error instanceof StorageError && error.code === "M2_REPLAY_CAUSALITY_UNRESOLVED",
    );
  } finally {
    store.close();
  }
}));

test("impossible transition fails without invoking the reducer", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(impossibleCompletion);
    let applied = 0;

    assert.throws(
      () => store.replay({
        initialState: () => 0,
        apply: (state: number, _event: ProtocolEvent) => {
          applied += 1;
          return state + 1;
        },
      }),
      (error: unknown) => error instanceof StorageError && error.code === "PHASE0_TRANSITION_INVALID",
    );
    assert.equal(applied, 0);
  } finally {
    store.close();
  }
}));

test("schema-invalid resource relationships retain their schema error", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(invalidFileRead);

    assert.throws(
      () => store.replay(),
      (error: unknown) => error instanceof StorageError && error.code === "PHASE0_SCHEMA_INVALID",
    );
  } finally {
    store.close();
  }
}));

test("source-sequence gaps are reported as degraded coverage", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(request);
    store.append(gapCompletion);

    const replay = store.replay();
    assert.deepEqual(replay.sourceSequenceGaps, [{
      source: request.source,
      missingRanges: [{ from: 1, to: 1 }],
    }]);
  } finally {
    store.close();
  }
}));

test("a reducer receives validated events in causal order", () => withTemporaryDatabase((databasePath) => {
  const store = SqliteEventStore.open(databasePath);
  try {
    store.append(completion);
    store.append(request);
    const seen: string[] = [];

    const replay = store.replay({
      initialState: () => seen,
      apply: (state: string[], event: ProtocolEvent) => {
        state.push(event.eventType);
        return state;
      },
    });

    assert.deepEqual(replay.state, ["tool.requested", "tool.completed"]);
  } finally {
    store.close();
  }
}));
