import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProtocolEvent, ToolRequestedEvent } from "patchmesh-protocol";
import { clearEventCache, SqliteEventStore } from "patchmesh-storage";
import { measureAdoption, measureTimeToResume, renderAdoption, treatmentBoundaryFrom } from "../src/index.js";

function ledger(): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-adoption-"));
  return { root, path: join(root, "ledger.db") };
}

let sequence = 0;

/** One recorded tool call, varying only the three things adoption is counted from. */
function call(agentId: string | null, hostToolName: string, at: string): ToolRequestedEvent {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_${String(sequence).padStart(32, "0")}`,
    eventType: "tool.requested",
    source: {
      kind: "gateway",
      sourceId: "source_gateway",
      instanceId: "11111111-1111-4111-8111-111111111111",
    },
    timestamp: at,
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId,
    taskId: null,
    correlationId: `corr_${String(sequence).padStart(32, "0")}`,
    causationId: null,
    sourceSequence: sequence,
    payload: {
      toolName: "other",
      hostToolName,
      operation: `called ${hostToolName}`,
      targetResourceId: null,
      opaque: false,
    },
  };
}

function write(path: string, events: readonly ProtocolEvent[]): void {
  const store = SqliteEventStore.open(path);
  try {
    store.appendAtomic(events);
  } finally {
    store.close();
  }
}

test("adoption counts PatchMesh calls against every tool call, from the ledger", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [
      call("agent_a", "Bash", "2026-08-22T10:00:00.000Z"),
      call("agent_a", "Edit", "2026-08-22T10:01:00.000Z"),
      call("agent_a", "mcp__patchmesh__patchmesh_recap", "2026-08-22T10:02:00.000Z"),
      call("agent_b", "Bash", "2026-08-22T10:03:00.000Z"),
    ]);
    const metrics = measureAdoption({ ledgerPath: path });
    assert.equal(metrics.totalCalls, 4);
    assert.equal(metrics.patchmeshCalls, 1);
    assert.equal(metrics.callsPerAsk, 4);
    assert.equal(metrics.sessions, 2);
    // The number a push surface exists to move: sessions that ever chose to ask, not calls.
    assert.equal(metrics.sessionsThatAsked, 1);
    assert.deepEqual(metrics.byTool, [{ tool: "patchmesh_recap", calls: 1, sessions: 1 }]);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("other MCP servers are counted alongside, because a bare count has no scale", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [
      call("agent_a", "mcp__knowl__knowl_query", "2026-08-22T10:00:00.000Z"),
      call("agent_a", "mcp__knowl__knowl_store", "2026-08-22T10:01:00.000Z"),
      call("agent_a", "mcp__patchmesh__patchmesh_recap", "2026-08-22T10:02:00.000Z"),
    ]);
    const metrics = measureAdoption({ ledgerPath: path });
    // 14 calls is small or large only against how often these agents call any tool of this
    // kind. Measured here, the memory server in the same sessions had 152.
    assert.deepEqual(metrics.byServer, [
      { server: "knowl", calls: 2, sessions: 1 },
      { server: "patchmesh", calls: 1, sessions: 1 },
    ]);
    assert.match(renderAdoption(metrics), /knowl/);
    assert.match(renderAdoption(metrics), /<- this one/);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unattributed call belongs to no session and is counted in neither half", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [
      call(null, "Bash", "2026-08-22T10:00:00.000Z"),
      call("agent_a", "Bash", "2026-08-22T10:01:00.000Z"),
    ]);
    // Counting it in the denominator while it can never reach the numerator would understate
    // adoption on exactly the days attribution was worst.
    assert.equal(measureAdoption({ ledgerPath: path }).totalCalls, 1);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository nobody asked in reports that, rather than a rate", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [call("agent_a", "Bash", "2026-08-22T10:00:00.000Z")]);
    const metrics = measureAdoption({ ledgerPath: path });
    assert.equal(metrics.patchmeshCalls, 0);
    // Not zero and not infinity: there is no such thing as "one ask per N" when there were no
    // asks, and printing a number there would invent one.
    assert.equal(metrics.callsPerAsk, null);
    assert.match(renderAdoption(metrics), /never asked/);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the treatment boundary is the first injection the measurement file records", () => {
  const answers = [
    '{"v":1,"at":"2026-08-22T07:46:16.103Z","tool":"patchmesh_recap","answerBytes":1741}',
    '{"v":1,"at":"2026-08-23T08:22:31.147Z","tool":"session_start_recap","answerBytes":1491}',
    '{"v":2,"at":"2026-08-23T09:00:00.000Z","tool":"session_start_recap","answerBytes":1491}',
    '{"v":2,"at":"2026-08-2',
  ].join("\n");
  // An agent's own earlier call is not the treatment; the hook's first fire is. A truncated
  // final line is normal in an append-only log and must not fail the read.
  assert.equal(treatmentBoundaryFrom(answers), "2026-08-23T08:22:31.147Z");
  assert.equal(treatmentBoundaryFrom(""), null);
  assert.equal(treatmentBoundaryFrom('{"v":1,"at":"2026-08-22T07:46:16.103Z","tool":"patchmesh_recap"}'), null);
});

test("the split is on when a session started, and refuses to conclude on a thin arm", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    const boundary = "2026-08-23T00:00:00.000Z";
    const events: ProtocolEvent[] = [];
    // Six control sessions that each made one call and changed nothing, one treatment session.
    for (let index = 0; index < 6; index += 1) {
      events.push(call(`agent_before_${index}`, "Bash", "2026-08-22T10:00:00.000Z"));
    }
    events.push(call("agent_after", "Bash", "2026-08-23T10:00:00.000Z"));
    write(path, events);

    const metrics = measureTimeToResume({ ledgerPath: path, treatmentSince: boundary });
    assert.equal(metrics.arms?.control.agentsWithoutChange, 6);
    assert.equal(metrics.arms?.treatment.agentsWithoutChange, 1);
    // Neither arm reached a first change, so neither has a median and nothing is comparable.
    // The point of the flag is that the default output says so instead of printing a number.
    assert.equal(metrics.arms?.conclusive, false);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session that started before the boundary stays in control however long it runs", () => {
  const { root, path } = ledger();
  try {
    clearEventCache();
    write(path, [
      call("agent_long", "Bash", "2026-08-22T23:00:00.000Z"),
      // Same session, hours after the treatment began. Splitting on *event* time would put
      // this half in the treatment arm and produce a treatment median from an untreated
      // session; splitting on session start puts the whole session where it belongs.
      call("agent_long", "Bash", "2026-08-23T10:00:00.000Z"),
    ]);
    const metrics = measureTimeToResume({ ledgerPath: path, treatmentSince: "2026-08-23T00:00:00.000Z" });
    assert.equal(metrics.arms?.control.agentsWithoutChange, 1);
    assert.equal(metrics.arms?.treatment.agentsWithoutChange, 0);
  } finally {
    clearEventCache();
    rmSync(root, { recursive: true, force: true });
  }
});
