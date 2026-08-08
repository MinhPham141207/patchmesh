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
