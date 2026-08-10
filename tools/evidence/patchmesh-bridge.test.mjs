import assert from "node:assert/strict";
import { test } from "node:test";
import { translatePatchMeshPayload } from "./lib/patchmesh-bridge.mjs";

const ids = {
  request: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  change: "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  complete: "evt_cccccccccccccccccccccccccccccccc",
  repository: "repo_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspace: "ws_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  worktree: "wt_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlation: "corr_dddddddddddddddddddddddddddddddd",
  resource: "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const adapterSource = { kind: "adapter", sourceId: "source_mcp", instanceId: "11111111-1111-4111-8111-111111111111" };
const watcherSource = { kind: "watcher", sourceId: "source_watcher", instanceId: "22222222-2222-4222-8222-222222222222" };

function envelope(eventType, eventId, source, causationId, sourceSequence, payload) {
  return {
    schemaVersion: 1,
    eventId,
    eventType,
    source,
    timestamp: "2026-08-10T00:00:00.000Z",
    repositoryId: ids.repository,
    workspaceId: ids.workspace,
    worktreeId: ids.worktree,
    agentId: "agent_test",
    taskId: "task_test",
    correlationId: ids.correlation,
    causationId,
    sourceSequence,
    payload,
  };
}

const request = envelope("tool.requested", ids.request, adapterSource, null, 1, {
  toolName: "edit_file",
  operation: "edit source",
  targetResourceId: null,
  opaque: false,
});

const changed = envelope("file.changed", ids.change, watcherSource, ids.request, null, {
  resource: { resourceId: ids.resource, repositoryId: ids.repository, kind: "file", locator: "src/actual.ts" },
  beforeVersion: null,
  afterVersion: {
    resourceId: ids.resource,
    domain: { repositoryId: ids.repository, workspaceId: ids.workspace, worktreeId: ids.worktree },
    kind: "content_hash",
    value: "sha256:after",
    evidenceEventIds: [ids.change],
  },
  changeKind: "modified",
});

function coverage(presentation, gaps = [], evidenceEventIds = [ids.request, ids.change, ids.complete]) {
  return {
    coverageId: "coverage_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope: `tool:${ids.request}`,
    modes: presentation === "sufficient" ? ["intercepted", "verified"] : ["intercepted", "unknown"],
    evidenceEventIds,
    gaps,
    presentation,
  };
}

function payload({ presentation = "sufficient", gaps = [], effectEventIds = [ids.change], deterministicEffectEventIds = [ids.change], coverageEventIds } = {}) {
  return {
    action: "tool.completed",
    paths: ["src/requested.ts"],
    result: { status: "succeeded" },
    patchmesh: {
      result: {
        execution: { outcome: "succeeded", exitCode: 0 },
        completedEventId: ids.complete,
        coverage: coverage(presentation, gaps, coverageEventIds),
        observationDiagnostics: gaps,
        analysisDiagnostics: [],
      },
      events: [
        request,
        changed,
        envelope("tool.completed", ids.complete, adapterSource, ids.request, 2, {
          requestEventId: ids.request,
          outcome: "succeeded",
          exitCode: 0,
          effectEventIds,
          ...(deterministicEffectEventIds === undefined ? {} : { deterministicallyAttributedEffectEventIds: deterministicEffectEventIds }),
        }),
      ],
    },
  };
}

test("maps deterministically attributed persisted file changes to verified evidence", () => {
  const translated = translatePatchMeshPayload(payload());

  assert.equal(translated.sourceEventId, ids.complete);
  assert.deepEqual(translated.derivedEffect.changedPaths, ["src/actual.ts"]);
  assert.equal(translated.derivedEffect.status, "verified");
  assert.equal(translated.derivedEffect.confidence, 1);
  assert.equal(translated.paths[0], "src/requested.ts");
  assert.notEqual(translated.paths[0], translated.derivedEffect.changedPaths[0]);
  assert.equal("patchmesh" in translated, false);
});

test("retains persisted changes as degraded when coverage has gaps", () => {
  const translated = translatePatchMeshPayload(payload({
    presentation: "degraded",
    gaps: [{ kind: "unverified", scope: "tool.effects", reason: "origin uncertain", evidenceEventIds: [ids.request, ids.change, ids.complete] }],
  }));

  assert.equal(translated.derivedEffect.status, "degraded");
  assert.deepEqual(translated.derivedEffect.changedPaths, ["src/actual.ts"]);
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.deepEqual(translated.derivedEffect.gaps, ["origin uncertain", "sufficient coverage was not bound to deterministic effect evidence"]);
});

test("does not invent effects when the persisted completion evidence is unavailable", () => {
  const input = payload();
  delete input.patchmesh.events;
  const translated = translatePatchMeshPayload(input);

  assert.equal(translated.derivedEffect.status, "unknown");
  assert.deepEqual(translated.derivedEffect.changedPaths, []);
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.equal(translated.derivedEffect.gaps.includes("persisted protocol completion effect evidence was unavailable"), true);
});

test("does not verify an ordinary effect ID fabricated with sufficient coverage", () => {
  const input = payload();
  delete input.patchmesh.events[2].payload.deterministicallyAttributedEffectEventIds;
  const translated = translatePatchMeshPayload(input);

  assert.equal(translated.derivedEffect.status, "degraded");
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.equal(translated.derivedEffect.gaps.includes("deterministically attributed persisted effect evidence was unavailable"), true);
});

test("does not verify sufficient coverage that is not bound to every deterministic effect", () => {
  const translated = translatePatchMeshPayload(payload({ coverageEventIds: [ids.request, ids.complete] }));

  assert.equal(translated.derivedEffect.status, "degraded");
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.equal(translated.derivedEffect.gaps.includes("sufficient coverage was not bound to deterministic effect evidence"), true);
});

test("does not verify effects without a persisted valid protocol request", () => {
  const input = payload();
  input.patchmesh.events[0].payload.toolName = "unrecognized_tool";
  const translated = translatePatchMeshPayload(input);

  assert.equal(translated.derivedEffect.status, "degraded");
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.equal(translated.derivedEffect.gaps.includes("persisted valid protocol request evidence was unavailable"), true);
});

test("does not verify a request that does not strictly match its completion context", () => {
  const input = payload();
  input.patchmesh.events[0].source.instanceId = "not-a-uuid";
  const translated = translatePatchMeshPayload(input);

  assert.equal(translated.derivedEffect.status, "degraded");
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.equal(translated.derivedEffect.gaps.includes("persisted valid protocol request evidence was unavailable"), true);
});

test("does not trust a non-protocol completion payload", () => {
  const input = payload();
  delete input.patchmesh.events[2].source;
  const translated = translatePatchMeshPayload(input);

  assert.equal(translated.derivedEffect.status, "unknown");
  assert.deepEqual(translated.derivedEffect.changedPaths, []);
  assert.equal(translated.derivedEffect.confidence, 0);
});
