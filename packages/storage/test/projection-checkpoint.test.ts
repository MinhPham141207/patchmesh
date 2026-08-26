import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { openDatabase } from "../src/database.js";
import {
  PROJECTOR_VERSION,
  checkpointRecordHash,
  clearProjectionCheckpoint,
  loadProjectionCheckpoint,
  saveProjectionCheckpoint,
  type ProjectionCheckpointRecord,
} from "../src/projection-checkpoint.js";

const dirs: string[] = [];
const databases: import("node:sqlite").DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "patchmesh-checkpoint-"));
  dirs.push(dir);
  const database = openDatabase(join(dir, "ledger.db"));
  databases.push(database);
  return database;
}

function sampleRecord(): ProjectionCheckpointRecord {
  return {
    projectorVersion: PROJECTOR_VERSION,
    lastInsertionPosition: 42,
    gaps: [],
    coverageForSnapshot: [],
    correctionsByTarget: [],
    nodes: [{
      kind: "agent",
      nodeId: "agent:a",
      agentId: "agent_a",
      evidenceEventIds: ["evt_1", "evt_2"],
    }],
    edges: [],
    findings: [],
    decisions: [],
  };
}

test("checkpoint round-trips through SQLite", () => {
  const database = tempDatabase();
  const record = sampleRecord();
  saveProjectionCheckpoint(database, record);
  assert.deepEqual(loadProjectionCheckpoint(database), record);
});

test("loading with no checkpoint row returns null", () => {
  const database = tempDatabase();
  assert.equal(loadProjectionCheckpoint(database), null);
});

test("saving twice replaces the single row", () => {
  const database = tempDatabase();
  saveProjectionCheckpoint(database, sampleRecord());
  const updated = { ...sampleRecord(), lastInsertionPosition: 43 };
  saveProjectionCheckpoint(database, updated);
  assert.equal(loadProjectionCheckpoint(database)?.lastInsertionPosition, 43);
});

test("clearing removes the checkpoint", () => {
  const database = tempDatabase();
  saveProjectionCheckpoint(database, sampleRecord());
  clearProjectionCheckpoint(database);
  assert.equal(loadProjectionCheckpoint(database), null);
});

test("a tampered blob fails hash verification", () => {
  const database = tempDatabase();
  const record = sampleRecord();
  saveProjectionCheckpoint(database, record);
  database.exec("UPDATE projection_checkpoint SET state_blob = replace(state_blob, '42', '43')");
  const loaded = loadProjectionCheckpoint(database);
  assert.equal(loaded, null);
});
