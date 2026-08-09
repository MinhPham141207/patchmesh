import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventId, ProtocolEvent } from "@patchmesh/protocol";
import type { ReadServices, StatusView } from "@patchmesh/query";
import type { WorkGraphSnapshot } from "@patchmesh/storage";
import { runCli } from "../src/main.js";

const status: StatusView = {
  health: "degraded",
  store: { state: "open", replayable: true },
  eventCount: 0,
  eventTypeCounts: {} as StatusView["eventTypeCounts"],
  agentCount: 0,
  taskCount: 0,
  nullAttributionEventCount: 0,
  coverage: { presentation: "degraded", modes: ["unknown"], gaps: [] },
  errorCategory: null,
};

const emptyGraph: WorkGraphSnapshot = { nodes: [], edges: [], coverage: [] };
const services = {
  getStatus: () => status,
  listAgents: () => ({ agents: [] }),
  listEvents: () => ({ events: [], nextCursor: null, hasMore: false }),
  getGraph: () => ({ snapshot: emptyGraph, filters: {}, coverageWarnings: [] }),
  listFindings: () => ({ findings: [], coverageWarnings: [] }),
  explainDecision: () => ({
    decision: {
      decision: {
        decisionId: "decision_cli",
        findingId: "finding_cli",
        coordinationAction: "record",
        gatewayDirective: "allow",
        state: "active",
        evidenceEventIds: [],
      },
      deliveries: [],
      feedback: [{
        eventId: "evt_00000000000000000000000000000009",
        feedback: { feedbackId: "feedback_cli", disposition: "acknowledged" },
      }],
      eventIds: [],
    },
    finding: null,
    coverageWarnings: [],
  }),
  followEvents: async function* () {},
} as unknown as ReadServices;

const dependencies = { services };

test("rejects unscheduled commands with usage exit code", async () => {
  const result = await runCli(["watch"], dependencies);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unsupported command/i);
});

test("graph JSON output is stable and contains no Phase 2 fields", async () => {
  const first = await runCli(["graph", "--json"], dependencies);
  const second = await runCli(["graph", "--json"], dependencies);

  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.includes("findings"), false);
  assert.equal(first.stdout.includes("validity"), false);
});

test("degraded status remains a successful reporting result", async () => {
  const result = await runCli(["status", "--json"], dependencies);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).health, "degraded");
});

test("events JSON renders one stable redacted page record", async () => {
  const event = { eventId: "evt_cli" as EventId, eventType: "file.read" } as ProtocolEvent;
  const eventServices = {
    ...services,
    listEvents: () => ({ events: [event], nextCursor: event.eventId, hasMore: false }),
  } as unknown as ReadServices;
  const result = await runCli(["events", "--json"], { services: eventServices });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).events[0], event);
});

test("overlaps and stale use public finding-list services", async () => {
  const overlaps = await runCli(["overlaps"], dependencies);
  const stale = await runCli(["stale", "--json"], dependencies);

  assert.equal(overlaps.exitCode, 0);
  assert.match(overlaps.stdout, /No findings/);
  assert.deepEqual(JSON.parse(stale.stdout), { findings: [], coverageWarnings: [] });
});

test("explain requires an ID and renders a report-only decision", async () => {
  const missing = await runCli(["explain"], dependencies);
  const result = await runCli(["explain", "decision_cli"], dependencies);

  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /requires a decision ID/i);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /DECISION EXPLANATION/);
  assert.match(result.stdout, /Directive: allow/);
  assert.match(result.stdout, /Feedback: evt_00000000000000000000000000000009 feedback_cli acknowledged/);
});

test("feedback records an immutable response through the supplied writer", async () => {
  let received: unknown = null;
  const result = await runCli([
    "feedback", "finding_cli", "--disposition", "dismissed", "--useful", "true",
    "--reason", "handled", "--agent", "agent_cli", "--task", "task_cli",
  ], {
    services,
    feedbackWriter: {
      respondToFinding(input) {
        received = input;
        return { status: "inserted", event: {} as never };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "inserted\n");
  assert.deepEqual(received, {
    findingId: "finding_cli",
    decisionId: null,
    disposition: "dismissed",
    useful: true,
    reason: "handled",
    actor: { agentId: "agent_cli", taskId: "task_cli" },
  });
});

test("feedback rejects malformed input and unavailable writers", async () => {
  const missingDisposition = await runCli(["feedback", "finding_cli"], dependencies);
  const unavailable = await runCli(["feedback", "finding_cli", "--disposition", "acknowledged"], dependencies);

  assert.equal(missingDisposition.exitCode, 2);
  assert.match(missingDisposition.stderr, /disposition/i);
  assert.equal(unavailable.exitCode, 3);
});

test("delivery records an immutable decision delivery state through the supplied writer", async () => {
  let received: unknown = null;
  const result = await runCli(["delivery", "decision_cli", "--state", "delivered", "--json"], {
    services,
    deliveryWriter: {
      respondToDecisionDelivery(input) {
        received = input;
        return { status: "inserted", event: {} as never };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: "inserted", event: {} });
  assert.deepEqual(received, { decisionId: "decision_cli", state: "delivered" });
});

test("delivery rejects missing, malformed, and unavailable writer inputs", async () => {
  const missingId = await runCli(["delivery", "--state", "delivered"], dependencies);
  const invalidState = await runCli(["delivery", "decision_cli", "--state", "sent"], dependencies);
  const unavailable = await runCli(["delivery", "decision_cli", "--state", "delivered"], dependencies);

  assert.equal(missingId.exitCode, 2);
  assert.match(missingId.stderr, /decision ID/i);
  assert.equal(invalidState.exitCode, 2);
  assert.match(invalidState.stderr, /delivery state/i);
  assert.equal(unavailable.exitCode, 3);
});
