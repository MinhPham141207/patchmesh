import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventId, ProtocolEvent } from "patchmesh-protocol";
import type { ReadServices } from "patchmesh-query";
import { SqliteEventStore } from "patchmesh-storage";
import type { GraphSiteModel } from "../src/graph-model.js";
import {
  boundGraphSiteModel,
  buildAgentsLens,
  buildFilesLens,
  buildMapLens,
  buildNowLens,
  collapseEvents,
  shortId,
  CHANGES_PER_FILE,
  FILE_ID_SAMPLE,
  MAP_AGENTS,
} from "../src/console-model.js";
import { startGraphServer } from "../src/graph-server.js";
import { runCli } from "../src/main.js";

/* ----------------------------------------------------------- fixtures */

function change(at: string, agentId: string | null, taskId: string | null) {
  return { at, agentId, taskId, changeKind: "modified", before: null, after: null, eventId: "evt_x" as EventId };
}

function modelWith(overrides: Partial<GraphSiteModel> = {}): GraphSiteModel {
  const base: GraphSiteModel = {
    ledger: "/ledger",
    generatedAt: "2026-08-25T00:00:00.000Z",
    filters: {},
    counts: { events: 9, agents: 2, tasks: 2, files: 2, changes: 4, contested: 1, unattributedChanges: 1 },
    agents: [
      {
        id: "agent_aaaaaaaa-1111", label: "a", parentId: null, taskIds: ["task_1"],
        changeCount: 2, readCount: 0, fileIds: ["res_a"], firstAt: "2026-08-01T00:00:00.000Z",
        lastAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "agent_bbbbbbbb-2222", label: "b", parentId: null, taskIds: ["task_2"],
        changeCount: 1, readCount: 3, fileIds: ["res_a", "res_b"], firstAt: "2026-08-20T00:00:00.000Z",
        lastAt: "2026-08-20T00:00:00.000Z",
      },
    ],
    tasks: [],
    files: [
      {
        id: "res_a", path: "src/auth.ts", dir: "src", name: "auth.ts", kind: "file",
        changedBy: ["agent_aaaaaaaa-1111", "agent_bbbbbbbb-2222"], readBy: [], taskIds: ["task_1"],
        changes: [
          change("2026-08-01T00:00:00.000Z", "agent_aaaaaaaa-1111", "task_1"),
          change("2026-08-02T00:00:00.000Z", "agent_aaaaaaaa-1111", "task_1"),
          change("2026-08-20T00:00:00.000Z", "agent_bbbbbbbb-2222", "task_2"),
        ],
        reads: [], firstAt: "2026-08-01T00:00:00.000Z", lastAt: "2026-08-20T00:00:00.000Z",
      },
      {
        id: "res_b", path: "pnpm-lock.yaml", dir: "", name: "pnpm-lock.yaml", kind: "file",
        changedBy: [], readBy: [], taskIds: [],
        changes: [change("2026-08-03T00:00:00.000Z", null, null)],
        reads: [], firstAt: "2026-08-03T00:00:00.000Z", lastAt: "2026-08-03T00:00:00.000Z",
      },
    ],
    gaps: [],
  };
  return { ...base, ...overrides };
}

function event(partial: Partial<ProtocolEvent> & { eventId: string; eventType: string }): ProtocolEvent {
  return {
    agentId: null, taskId: null, causationId: null, correlationId: null,
    repositoryId: "repo_1", schemaVersion: 1, sourceSequence: null,
    source: { kind: "gateway", sourceId: "s", instanceId: "i" },
    timestamp: "2026-08-25T00:00:00.000Z", payload: {},
    ...partial,
  } as unknown as ProtocolEvent;
}

/* -------------------------------------------------------------- units */

test("an id shortens to the prefix people read, and a subagent keeps its parent's", () => {
  assert.equal(shortId("agent_b11c2b2a-2701-4c36-880a-12e458e33c9d"), "agent_b11c2b2a");
  assert.equal(shortId("task_dd472870-1111-2222-3333-444444444444"), "task_dd472870");
  // The parent prefix is what makes a subagent legible; truncating from the left would lose it.
  assert.match(shortId("agent_4124a9b5.sub.a45e215b556dd388f"), /^agent_4124a9b5\.sub\./);
});

test("agents are ordered by when they were last here, not by id", () => {
  const lens = buildAgentsLens(modelWith());
  // agent_bbbb worked on the 20th, agent_aaaa on the 1st. Alphabetically that is backwards,
  // which is exactly what the CLI's sort does.
  assert.deepEqual(lens.rows.map((row) => row.short), ["agent_bbbbbbbb", "agent_aaaaaaaa"]);
  assert.equal(lens.rows[0]?.reads, 3);
  assert.equal(lens.bounds.total, 2);
  assert.equal(lens.bounds.withheld, 0);
});

test("files rank by churn and a change nobody claims is counted, not dropped", () => {
  const lens = buildFilesLens(modelWith());
  assert.deepEqual(lens.rows.map((row) => row.name), ["auth.ts", "pnpm-lock.yaml"]);
  assert.equal(lens.rows[0]?.contested, true);
  assert.equal(lens.rows[0]?.agents.length, 2);
  // The lock file's only change carries no agent: it is a row with an unattributed count,
  // not an absent row.
  assert.equal(lens.rows[1]?.contested, false);
  assert.equal(lens.rows[1]?.unattributed, 1);
});

test("the map puts changes in agent columns and unattributed work in its own", () => {
  const lens = buildMapLens(modelWith());
  const auth = lens.rows.find((row) => row.name === "auth.ts")!;
  const lock = lens.rows.find((row) => row.name === "pnpm-lock.yaml")!;

  assert.equal(lens.agents.length, 2);
  // Two changes by the first agent, one by the second - a row with more than one mark is a
  // contested file, which is the whole reason the matrix needs no "contested only" filter.
  assert.equal(auth.cells.reduce((total, cell) => total + cell, 0), 3);
  assert.equal(auth.cells.filter((cell) => cell > 0).length, 2);
  assert.equal(auth.unattributed, 0);
  assert.equal(lock.cells.reduce((total, cell) => total + cell, 0), 0);
  assert.equal(lock.unattributed, 1);
  assert.equal(lock.total, 1);
});

test("the map bounds its agent axis and says so when a row's marks do not add up", () => {
  const many = Array.from({ length: MAP_AGENTS + 4 }, (_, index) => ({
    id: `agent_${index}`, label: `${index}`, parentId: null, taskIds: [],
    changeCount: MAP_AGENTS + 4 - index, readCount: 0, fileIds: ["res_a"],
    firstAt: null, lastAt: null,
  }));
  const model = modelWith({
    agents: many,
    files: [{
      ...modelWith().files[0]!,
      changes: many.map((agent, index) => change(`2026-08-0${(index % 9) + 1}T00:00:00.000Z`, agent.id, null)),
    }],
  });
  const lens = buildMapLens(model);
  assert.equal(lens.agents.length, MAP_AGENTS);
  // The four busiest-but-uncolumned agents' changes are not silently dropped from the count.
  assert.equal(lens.othersColumn, true);
});

test("a request and its completion collapse into one call, newest first", () => {
  const events = [
    event({ eventId: "e1", eventType: "tool.requested", correlationId: "c1", timestamp: "2026-08-25T00:00:01.000Z", agentId: "agent_one-xxxx", payload: { hostToolName: "Bash", operation: "Bash ls" } }),
    event({ eventId: "e2", eventType: "tool.completed", correlationId: "c1", timestamp: "2026-08-25T00:00:02.000Z", agentId: "agent_one-xxxx", payload: { outcome: "ok" } }),
    event({ eventId: "e3", eventType: "tool.requested", correlationId: "c2", timestamp: "2026-08-25T00:00:03.000Z", payload: { hostToolName: "Edit", operation: "Edit a.ts" } }),
    event({ eventId: "e4", eventType: "file.changed", correlationId: "c2", timestamp: "2026-08-25T00:00:04.000Z", payload: { resource: { locator: "a.ts" } } }),
    event({ eventId: "e5", eventType: "tool.completed", correlationId: "c2", timestamp: "2026-08-25T00:00:05.000Z", payload: { outcome: "failed" } }),
  ];
  const lens = collapseEvents(events, 10);

  assert.equal(lens.eventsRead, 5);
  assert.equal(lens.bounds.total, 2);
  // Newest first: the command this replaces prints oldest first, so its first screen is the
  // day the repository was created.
  assert.equal(lens.rows[0]?.operation, "Edit a.ts");
  assert.deepEqual(lens.rows[0]?.changed, ["a.ts"]);
  assert.equal(lens.rows[0]?.failed, true);
  assert.equal(lens.rows[0]?.events, 3);
  // A call with no agent is labelled, not hidden.
  assert.equal(lens.rows[0]?.agentShort, null);
  assert.equal(lens.rows[1]?.agentShort, "agent_one-xxxx".slice(0, 14));
  assert.equal(lens.rows[1]?.failed, false);
});

test("the event lens keeps the newest calls when it caps, not the oldest", () => {
  const events = Array.from({ length: 30 }, (_, index) =>
    event({ eventId: `e${index}`, eventType: "tool.requested", correlationId: `c${index}`,
      timestamp: `2026-08-25T00:00:${String(index).padStart(2, "0")}.000Z`,
      payload: { hostToolName: "Bash", operation: `call ${index}` } }));
  const lens = collapseEvents(events, 5);
  assert.equal(lens.bounds.total, 30);
  assert.equal(lens.bounds.withheld, 25);
  assert.equal(lens.rows[0]?.operation, "call 29");
  assert.equal(lens.rows[4]?.operation, "call 25");
});

test("calls are ordered by when they happened, not when the ledger wrote them", () => {
  // Two agents record concurrently, so the ledger's write order is not time order - the
  // later call can be journalled first. Sorting by arrival interleaves them; time does not.
  const events = [
    event({ eventId: "e1", eventType: "tool.requested", correlationId: "c2", timestamp: "2026-08-25T00:00:05.000Z", payload: { hostToolName: "Bash", operation: "late" } }),
    event({ eventId: "e2", eventType: "tool.requested", correlationId: "c1", timestamp: "2026-08-25T00:00:01.000Z", payload: { hostToolName: "Bash", operation: "early" } }),
    event({ eventId: "e3", eventType: "tool.completed", correlationId: "c1", timestamp: "2026-08-25T00:00:02.000Z", payload: { outcome: "ok" } }),
  ];
  const lens = collapseEvents(events, 10);
  assert.equal(lens.rows[0]?.operation, "late");
  assert.equal(lens.rows[1]?.operation, "early");
});

test("the now lens groups coverage gaps instead of listing one per scope", () => {
  const services = {
    getStatus: () => ({
      health: "healthy", store: { state: "open", replayable: true },
      eventCount: 9330, eventTypeCounts: {}, agentCount: 30, taskCount: 116,
      nullAttributionEventCount: 1005,
      coverage: {
        presentation: "observational", covered: 575, total: 3485, modes: [],
        // A hook-recorded ledger emits one of these per shell command; ungrouped, this list
        // is what made `status --json` 522 KB.
        gaps: Array.from({ length: 40 }, () => ({ kind: "opaque", reason: "not enumerable", scope: "s" })),
      },
      errorCategory: null,
    }),
  } as unknown as ReadServices;

  const lens = buildNowLens(services, "/ledger", null);
  assert.deepEqual(lens.gaps, [{ kind: "opaque", reason: "not enumerable", count: 40 }]);
  assert.equal(lens.counts.events, 9330);
  assert.equal(lens.counts.undeliveredMessages, 0);
  assert.equal(lens.tasks.length, 0);
  assert.equal(lens.window, null);
});

/** The two mailbox events an undelivered count is made of, seeded the way the CLI leaves them. */
let mailSequence = 0;
function mailboxEvent(eventType: "agent.message.sent" | "agent.message.delivered", messageId: string): ProtocolEvent {
  mailSequence += 1;
  const base = {
    schemaVersion: 1,
    eventId: `evt_${String(mailSequence).padStart(32, "0")}` as EventId,
    source: { kind: "gateway", sourceId: "source_patchmesh_mailbox", instanceId: "11111111-1111-4111-8111-111111111111" },
    timestamp: "2026-08-26T12:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_aaaa1111-2222-4333-8444-555555555555",
    taskId: null,
    correlationId: `corr_${String(mailSequence).padStart(32, "0")}`,
    causationId: null,
    sourceSequence: null,
  };
  return eventType === "agent.message.sent"
    ? { ...base, eventType, payload: {
        messageId, to: { kind: "broadcast", agentId: null }, kind: "notice", subject: `subject ${messageId}`,
        body: `body ${messageId}`, refs: [], expiresAt: "2027-09-02T12:00:00.000Z",
      } } as unknown as ProtocolEvent
    : { ...base, eventType, timestamp: "2026-08-26T13:00:00.000Z", payload: { messageId, channel: "mcp_pull" } } as unknown as ProtocolEvent;
}

test("the now lens counts the ledger's undelivered mail beside its other counts", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-now-mail-"));
  const ledgerPath = join(root, ".patchmesh", "ledger.db");
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  const store = SqliteEventStore.open(ledgerPath);
  try {
    // Two sent, one of them delivered to somebody: one message is still waiting.
    store.appendAtomic([
      mailboxEvent("agent.message.sent", "msg_a".padEnd(36, "a")),
      mailboxEvent("agent.message.sent", "msg_b".padEnd(36, "b")),
      mailboxEvent("agent.message.delivered", "msg_b".padEnd(36, "b")),
    ]);
  } finally {
    store.close();
  }
  try {
    const lens = buildNowLens({
      getStatus: () => ({
        health: "healthy", store: { state: "open", replayable: true },
        eventCount: 0, eventTypeCounts: {}, agentCount: 0, taskCount: 0,
        nullAttributionEventCount: 0,
        coverage: { presentation: "unknown", covered: 0, total: 0, modes: [], gaps: [] },
        errorCategory: null,
      }),
    } as unknown as ReadServices, ledgerPath, null);
    assert.equal(lens.counts.undeliveredMessages, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- the /graph.json fix */

test("the served model is bounded, because the ledger it is built from is not", () => {
  const changes = Array.from({ length: 50 }, (_, index) =>
    change(`2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`, "agent_aaaaaaaa-1111", "task_1"));
  const fileIds = Array.from({ length: 40 }, (_, index) => `res_${index}`);
  const model = modelWith({
    files: [{ ...modelWith().files[0]!, changes }],
    agents: [{ ...modelWith().agents[0]!, fileIds }],
  });

  const bounded = boundGraphSiteModel(model);
  const file = bounded.files[0]!;
  assert.equal(file.changes.length, CHANGES_PER_FILE);
  // The most recent history is what is kept: a file's last few changes are what a reader is
  // asking about, and the first few are what the ledger has most of.
  assert.equal(file.changes.at(-1)?.at, changes.at(-1)?.at);
  assert.equal((file as { changesWithheld?: number }).changesWithheld, 50 - CHANGES_PER_FILE);

  const agent = bounded.agents[0]! as { fileIds: readonly string[]; fileCount?: number };
  assert.equal(agent.fileIds.length, FILE_ID_SAMPLE);
  // The count survives the sampling, because the count is the only part the page reads.
  assert.equal(agent.fileCount, 40);
  assert.equal(bounded.counts.changes, model.counts.changes);
});

/* --------------------------------------------------- the terminal side */

/**
 * The corpus commands' text mode was the original complaint: `events` printed every event
 * since creation as `id · timestamp · type`, and `agents` printed UUIDs in a random order.
 * These tests hold the replacement to the rule the console obeys - open on an answer.
 */
function cliServices(overrides: Partial<Record<"listEvents" | "listAgents", () => unknown>> = {}): ReadServices {
  return {
    listEvents: () => ({ events: [], nextCursor: null, hasMore: false }),
    listAgents: () => ({ agents: [] }),
    ...overrides,
  } as unknown as ReadServices;
}

test("events answers with the newest calls, not the whole ledger", async () => {
  const events = Array.from({ length: 60 }, (_, index) =>
    event({ eventId: `e${index}`, eventType: "tool.requested", correlationId: `c${index}`,
      timestamp: `2026-08-25T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      agentId: "agent_aaaa1111-2222-4333-8444-555555555555",
      payload: { hostToolName: "Bash", operation: `call ${index}` } }));
  const result = await runCli(["events"], { services: cliServices({ listEvents: () => ({ events, nextCursor: null, hasMore: false }) }), worktreeRoot: "/repo" });

  assert.equal(result.exitCode, 0);
  // The verdict comes first: how much the ledger holds and what the screen is showing.
  assert.match(result.stdout, /60 calls?/);
  // Newest first, and bounded - the first screen is the work just done, not day one.
  assert.match(result.stdout, /call 59/);
  assert.equal(/call 0\b/.test(result.stdout), false);
  // The drill-down is named, because twenty rows are not the whole answer.
  assert.match(result.stdout, /patchmesh console/);
});

test("events --raw keeps one line per event, so pipes are unaffected", async () => {
  const events = [event({ eventId: "evt_raw1", eventType: "file.read", correlationId: "c1", payload: {} })];
  const result = await runCli(["events", "--raw"], { services: cliServices({ listEvents: () => ({ events, nextCursor: null, hasMore: false }) }), worktreeRoot: "/repo" });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /evt_raw1\t/);
  assert.equal(result.stdout.includes("patchmesh console"), false);
});

test("events on an empty ledger says so instead of printing an empty table", async () => {
  const result = await runCli(["events"], { services: cliServices(), worktreeRoot: "/repo" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /[Nn]o events/);
});

test("agents lead with activity and carry ids people can read", async () => {
  const agents = [
    { agentId: "agent_bbbb2222-3333-4444-5555-666666666666", taskIds: ["task_1"], eventCount: 900, eventTypeCounts: {}, coverage: [] },
    { agentId: "agent_aaaa1111-2222-3333-4444-555555555555", taskIds: [], eventCount: 5, eventTypeCounts: {}, coverage: [] },
  ];
  const result = await runCli(["agents"], { services: cliServices({ listAgents: () => ({ agents }) }), worktreeRoot: "/repo" });

  assert.equal(result.exitCode, 0);
  const lines = result.stdout.split("\n").filter((line) => line.includes("agent_"));
  // Busiest first: alphabetical order put the quiet agent ahead, which said nothing.
  assert.match(lines[0] ?? "", /agent_bbbb2222/);
  assert.match(lines[1] ?? "", /agent_aaaa1111/);
  // A 36-character UUID column is a table with no signal; the short form is what recap taught.
  assert.equal(result.stdout.includes("5555-666666666666"), false);
  assert.match(result.stdout, /patchmesh console/);
});

/* ------------------------------------------------------------- server */

function serverFixture(): ReadServices {
  return {
    getGraph: () => ({ snapshot: { nodes: [], edges: [] }, coverageWarnings: [] }),
    listEvents: () => ({ events: [], nextCursor: null, hasMore: false }),
    getStatus: () => ({
      health: "healthy", store: { state: "open", replayable: true },
      eventCount: 3, eventTypeCounts: {}, agentCount: 1, taskCount: 1,
      nullAttributionEventCount: 0,
      coverage: { presentation: "observational", covered: 1, total: 2, modes: [], gaps: [] },
      errorCategory: null,
    }),
  } as unknown as ReadServices;
}

test("every lens route serves the console, and every lens has an endpoint behind it", async () => {
  const server = await startGraphServer({ services: serverFixture(), filters: {}, ledger: "/ledger" });
  try {
    for (const route of ["/", "/agents", "/events", "/files", "/map"]) {
      const response = await fetch(`${server.url}${route}`);
      assert.equal(response.status, 200, `${route} should serve the console`);
      assert.match(await response.text(), /PatchMesh console/);
    }
    for (const endpoint of ["now", "agents", "events", "files", "map"]) {
      const response = await fetch(`${server.url}/api/${endpoint}.json`);
      assert.equal(response.status, 200, `/api/${endpoint}.json should answer`);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    }
    assert.equal((await fetch(`${server.url}/api/nope.json`)).status, 404);
  } finally {
    server.close();
  }
  await server.closed;
});

test("the now lens does not touch the work-graph projection", async () => {
  // The landing page is the most frequent click in the product; making it pay for the most
  // expensive query would be the one performance mistake that lands on everybody.
  let projections = 0;
  const services = serverFixture();
  const counting = {
    ...services,
    getGraph: (filters?: unknown) => { projections += 1; return services.getGraph(filters as never); },
  } as ReadServices;

  const server = await startGraphServer({ services: counting, filters: {}, ledger: "/ledger" });
  try {
    await fetch(`${server.url}/api/now.json`);
    assert.equal(projections, 0);
    await fetch(`${server.url}/api/map.json`);
    assert.equal(projections, 1);
  } finally {
    server.close();
  }
  await server.closed;
});

test("a lens whose ledger cannot be read says so instead of serving a broken page", async () => {
  const services = {
    ...serverFixture(),
    getGraph: () => { throw new Error("replay event-set validation failed"); },
  } as unknown as ReadServices;

  const server = await startGraphServer({ services, filters: {}, ledger: "/ledger" });
  try {
    const response = await fetch(`${server.url}/api/map.json`);
    assert.equal(response.status, 500);
    assert.match((await response.json() as { error: string }).error, /replay event-set/);
  } finally {
    server.close();
  }
  await server.closed;
});

test("console serves, prints its lenses, and holds until the server stops", async () => {
  let started: { close: () => void } | null = null;
  const result = await runCli(["console"], {
    services: serverFixture(),
    worktreeRoot: "/repo",
    readRecap: () => ({ tasks: [], truncated: 0, unattributedCalls: 0, withinMinutes: 1440 }),
    serveGraph: async (options) => {
      const server = await startGraphServer(options);
      started = server;
      return server;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /PatchMesh console at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stdout, /\/agents/);
  assert.match(result.stdout, /Ctrl\+C/);
  assert.notEqual(result.hold, undefined);

  started!.close();
  await result.hold;
});

test("console and graph are one server on one port, not two", async () => {
  // Four commands each seizing a random port is the mess this replaces, not a fix for it.
  const ports: (number | undefined)[] = [];
  for (const command of [["console", "--port", "0"], ["graph", "--port", "0"]]) {
    await runCli(command, {
      services: serverFixture(),
      worktreeRoot: "/repo",
      readRecap: () => ({ tasks: [], truncated: 0, unattributedCalls: 0, withinMinutes: 1440 }),
      serveGraph: async (options) => {
        ports.push(options.port);
        const server = await startGraphServer(options);
        server.close();
        return server;
      },
    });
  }
  assert.deepEqual(ports, [0, 0]);
});
