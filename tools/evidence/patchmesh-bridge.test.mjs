import assert from "node:assert/strict";
import { test } from "node:test";
import { translatePatchMeshPayload } from "./lib/patchmesh-bridge.mjs";

const coverage = (presentation, gaps = []) => ({
  coverageId: "coverage_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  scope: "tool:evt_complete",
  modes: presentation === "sufficient" ? ["intercepted", "verified"] : ["intercepted", "unknown"],
  evidenceEventIds: ["evt_change", "evt_complete"],
  gaps,
  presentation,
});

const changed = {
  eventId: "evt_change",
  eventType: "file.changed",
  payload: {
    resource: { resourceId: "res_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "file", locator: "src/actual.ts" },
    beforeVersion: { kind: "content_hash", value: "sha256:before" },
    afterVersion: { kind: "content_hash", value: "sha256:after" },
    changeKind: "modified",
  },
};

function payload(presentation = "sufficient", gaps = []) {
  return {
    action: "tool.completed",
    paths: ["src/requested.ts"],
    result: { status: "succeeded" },
    patchmesh: {
      result: {
        execution: { outcome: "succeeded", exitCode: 0 },
        completedEventId: "evt_complete",
        coverage: coverage(presentation, gaps),
        observationDiagnostics: gaps,
        analysisDiagnostics: [],
      },
      events: [
        { eventId: "evt_complete", eventType: "tool.completed", payload: { effectEventIds: ["evt_change"] } },
        changed,
      ],
    },
  };
}

test("maps actual completion-linked file changes to verified evidence", () => {
  const translated = translatePatchMeshPayload(payload());

  assert.equal(translated.sourceEventId, "evt_complete");
  assert.deepEqual(translated.derivedEffect.changedPaths, ["src/actual.ts"]);
  assert.equal(translated.derivedEffect.status, "verified");
  assert.equal(translated.derivedEffect.confidence, 1);
  assert.equal(translated.paths[0], "src/requested.ts");
  assert.notEqual(translated.paths[0], translated.derivedEffect.changedPaths[0]);
  assert.equal("patchmesh" in translated, false);
});

test("retains observed changes as degraded when coverage has gaps", () => {
  const translated = translatePatchMeshPayload(payload("degraded", [{ kind: "unverified", scope: "tool.effects", reason: "origin uncertain" }]));

  assert.equal(translated.derivedEffect.status, "degraded");
  assert.deepEqual(translated.derivedEffect.changedPaths, ["src/actual.ts"]);
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.deepEqual(translated.derivedEffect.gaps, ["origin uncertain"]);
});

test("does not invent effects when the persisted completion evidence is unavailable", () => {
  const input = payload();
  delete input.patchmesh.events;
  const translated = translatePatchMeshPayload(input);

  assert.equal(translated.derivedEffect.status, "unknown");
  assert.deepEqual(translated.derivedEffect.changedPaths, []);
  assert.equal(translated.derivedEffect.confidence, 0);
  assert.equal(translated.derivedEffect.gaps.includes("persisted completion effect evidence was unavailable"), true);
});
