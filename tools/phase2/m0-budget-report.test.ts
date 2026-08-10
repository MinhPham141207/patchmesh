import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateM0Budget, type M0BudgetInput } from "./m0-budget-report.js";

const workload = (source: M0BudgetInput["source"] = "node_observation") => ({
  workloadId: "small",
  source,
  samplesMs: [10, 20, 30],
  p95Ms: 30,
  budgetMs: 50,
  failures: 0,
});

test("accepts only actual observation measurements within budget", () => {
  const report = evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [workload()],
  });

  assert.equal(report.decision, "accepted");
  assert.equal(report.workloads[0]?.accepted, true);
});

test("does not accept recorder-only evidence as an interception budget", () => {
  const report = evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [workload("evidence_recorder")],
    owner: "phase2-runtime",
    dueGate: "M0 observation benchmark",
  });

  assert.equal(report.decision, "deferred");
  assert.match(report.reason, /recorder/i);
});

test("deferred decisions require an owner and due gate", () => {
  assert.throws(() => evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [{ ...workload(), p95Ms: 100 }],
  }), /owner and dueGate/);
});
