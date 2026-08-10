import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateM0Budget, p95FromSamples, type M0WorkloadInput } from "./m0-budget-report.js";

const workload = (workloadId: "small" | "medium" | "large", source: M0WorkloadInput["source"] = "node_observation") => ({
  workloadId,
  source,
  samplesMs: [10, 20, 20, 30, 30],
  budgetMs: workloadId === "small" ? 30 : workloadId === "medium" ? 60 : 120,
  failures: 0,
});

test("accepts only actual observation measurements within budget", () => {
  const report = evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [workload("small"), workload("medium"), workload("large")],
  });

  assert.equal(report.decision, "accepted");
  assert.equal(report.workloads.every((entry) => entry.accepted), true);
});

test("recomputes p95 from the raw measurements instead of trusting a supplied summary", () => {
  const staleSummary = { ...workload("small"), samplesMs: [10, 20, 30, 40, 50], p95Ms: 0 };
  const report = evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [staleSummary, workload("medium"), workload("large")],
    owner: "phase2-runtime",
    dueGate: "M0 observation benchmark",
  });

  assert.equal(p95FromSamples([10, 20, 30, 40, 50]), 50);
  assert.equal(report.workloads[0]?.p95Ms, 50);
  assert.equal(report.decision, "deferred");
});

test("does not accept recorder-only evidence as an interception budget", () => {
  const report = evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [workload("small", "evidence_recorder"), workload("medium"), workload("large")],
    owner: "phase2-runtime",
    dueGate: "M0 observation benchmark",
  });

  assert.equal(report.decision, "deferred");
  assert.match(report.reason, /recorder/i);
});

test("deferred decisions require an owner and due gate", () => {
  assert.throws(() => evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [{ ...workload("small"), samplesMs: [100, 100, 100, 100, 100] }, workload("medium"), workload("large")],
  }), /owner and dueGate/);
});

test("requires all named NodeObservationBoundary tiers with their fixed budgets", () => {
  const report = evaluateM0Budget({
    environment: { nodeVersion: "v24.15.0", os: "win32", architecture: "x64" },
    workloads: [{ ...workload("small"), budgetMs: 999 }, workload("medium")],
    owner: "phase2-runtime",
    dueGate: "M0 observation benchmark",
  });

  assert.equal(report.decision, "deferred");
  assert.match(report.reason, /small, medium, and large/);
});
