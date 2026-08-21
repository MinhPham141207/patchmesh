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

test("an unsupported command names the available commands instead of dead-ending", async () => {
  const result = await runCli(["watch"], dependencies);

  assert.equal(result.exitCode, 2);
  for (const command of ["status", "overlaps", "stale", "contracts", "explain", "feedback", "delivery"]) {
    assert.match(result.stderr, new RegExp(`\\b${command}\\b`), `usage should mention ${command}`);
  }
});

test("help is a successful command and states the report-only boundary", async () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const result = await runCli(argv, dependencies);
    assert.equal(result.exitCode, 0, `${argv[0]} should succeed`);
    assert.match(result.stdout, /Usage: patchmesh/);
    assert.match(result.stdout, /report-only/i);
    assert.equal(result.stderr, "");
  }
});

test("every detector finding type is reachable from a CLI command", async () => {
  const requested: string[] = [];
  const recordingServices = {
    ...services,
    listFindings: (filters: { readonly findingType: string }) => {
      requested.push(filters.findingType);
      return { findings: [], coverageWarnings: [] };
    },
  } as unknown as ReadServices;

  for (const command of ["overlaps", "stale", "contracts"]) {
    const result = await runCli([command], { services: recordingServices });
    assert.equal(result.exitCode, 0, `${command} should succeed`);
  }

  // The three detector finding types must each have a command; a detector whose
  // output no command surfaces is unreachable coordination output.
  assert.deepEqual(requested, [
    "same_symbol_overlap",
    "stale_read_before_write",
    "exported_contract_invalidation",
  ]);
});

test("write commands report what was recorded and name an idempotent replay", async () => {
  const inserted = { status: "inserted", event: { eventId: "evt_new" } };
  const duplicate = { status: "duplicate", event: { eventId: "evt_new" } };

  const first = await runCli(["delivery", "decision_a", "--state", "delivered"], {
    services,
    deliveryWriter: { respondToDecisionDelivery: () => inserted },
  } as never);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /DECISION DELIVERY/);
  assert.match(first.stdout, /decision_a/);
  assert.match(first.stdout, /State: delivered/);
  assert.match(first.stdout, /Outcome: recorded/);
  assert.match(first.stdout, /evt_new/);

  const replay = await runCli(["delivery", "decision_a", "--state", "delivered"], {
    services,
    deliveryWriter: { respondToDecisionDelivery: () => duplicate },
  } as never);
  assert.equal(replay.exitCode, 0, "an identical replay is not a failure");
  assert.match(replay.stdout, /already recorded/);

  const feedback = await runCli(["feedback", "finding_a", "--disposition", "dismissed"], {
    services,
    feedbackWriter: { respondToFinding: () => inserted },
  } as never);
  assert.equal(feedback.exitCode, 0);
  assert.match(feedback.stdout, /FINDING FEEDBACK/);
  assert.match(feedback.stdout, /Disposition: dismissed/);
});

test("write commands keep machine output unchanged under --json", async () => {
  const result = await runCli(["delivery", "decision_a", "--state", "failed", "--json"], {
    services,
    deliveryWriter: { respondToDecisionDelivery: () => ({ status: "inserted", event: { eventId: "evt_j" } }) },
  } as never);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: "inserted", event: { eventId: "evt_j" } });
});

test("findings commands surface coverage warnings alongside an empty result", async () => {
  const degradedServices = {
    ...services,
    listFindings: () => ({
      findings: [],
      coverageWarnings: [{ kind: "unverified", scope: "write.dependent" }],
    }),
  } as unknown as ReadServices;

  const result = await runCli(["contracts"], { services: degradedServices });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No findings/);
  assert.match(result.stdout, /Coverage gap: unverified write\.dependent/);
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
        return { status: "inserted", event: { eventId: "evt_feedback" } as never };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    result.stdout,
    "FINDING FEEDBACK\nFinding: finding_cli\nDisposition: dismissed\nOutcome: recorded\nEvent: evt_feedback\n",
  );
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
