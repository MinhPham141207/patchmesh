import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPerformance, PERFORMANCE_MIN_SAMPLE } from "patchmesh-query";
import type { PerformanceReport } from "patchmesh-query";

function reportOf(agents: PerformanceReport["agents"]): PerformanceReport {
  return {
    agents,
    withinMinutes: 60,
    windowStart: "2026-09-01T00:00:00.000Z",
    windowEnd: "2026-09-01T01:00:00.000Z",
    roleFilter: null,
    hostFilter: null,
  };
}

test("performance report carries tier and n for every agent", () => {
  const text = renderPerformance(reportOf([
    {
      agentId: "agent_aaaa", host: "Claude Code", hostTier: "observed", roleId: "builder",
      resumeCalls: 3, effectDensity: 0.5, reworkRate: 0.1, contentionCaused: 1,
      scopeAdherence: 0.9, n: 10, thin: false,
    },
    {
      agentId: "agent_bbbb", host: "Generic MCP", hostTier: "declared", roleId: null,
      resumeCalls: null, effectDensity: 0.2, reworkRate: 0, contentionCaused: 0,
      scopeAdherence: null, n: 8, thin: false,
    },
  ]));
  assert.match(text, /agent_aaaa.*observed.*n=10/u);
  assert.match(text, /agent_bbbb.*declared.*n=8/u);
  assert.match(text, /observed work, not worker quality/u);
});

test("performance refuses comparison across tiers with no single score", () => {
  const text = renderPerformance(reportOf([
    {
      agentId: "agent_aaaa", host: "Claude Code", hostTier: "observed", roleId: null,
      resumeCalls: 3, effectDensity: 0.5, reworkRate: 0, contentionCaused: 0,
      scopeAdherence: null, n: 10, thin: false,
    },
  ]));
  assert.doesNotMatch(text, /score/u);
  assert.match(text, /\[Claude Code \/ observed\]/u);
});

test("thin sample prints 'too thin to compare'", () => {
  const text = renderPerformance(reportOf([
    {
      agentId: "agent_aaaa", host: "Claude Code", hostTier: "observed", roleId: null,
      resumeCalls: 1, effectDensity: 1, reworkRate: 0, contentionCaused: 0,
      scopeAdherence: null, n: 2, thin: true,
    },
  ]));
  assert.match(text, new RegExp(`too thin to compare \\(n=2 < ${PERFORMANCE_MIN_SAMPLE}\\)`, "u"));
});
