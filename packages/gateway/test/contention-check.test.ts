import assert from "node:assert/strict";
import { test } from "node:test";
import type { InFlightCall } from "patchmesh-recorder";
import { filterContentionCalls, renderContentionCheck } from "../src/index.js";

function call(overrides: Partial<InFlightCall> = {}): InFlightCall {
  return {
    at: "2026-08-31T11:59:50.000Z",
    agentId: "agent_7a1033a6-93c4-46e2-a83c-c471f26765c2",
    hostToolName: "Edit",
    operation: null,
    filePath: "src/auth.ts",
    runningForMs: 10_000,
    ...overrides,
  };
}

// --- filterContentionCalls ---

test("filterContentionCalls matches by filePath", () => {
  const calls = [
    call({ filePath: "src/auth.ts" }),
    call({ filePath: "src/clean.ts" }),
  ];
  assert.equal(filterContentionCalls(calls, "src/auth.ts").length, 1);
  assert.equal(filterContentionCalls(calls, "src/auth.ts")[0]!.filePath, "src/auth.ts");
});

test("filterContentionCalls matches by operation when filePath is null", () => {
  const calls = [
    call({ operation: "pnpm check", filePath: null }),
    call({ operation: "git status", filePath: null }),
  ];
  assert.equal(filterContentionCalls(calls, "pnpm check").length, 1);
  assert.equal(filterContentionCalls(calls, "pnpm check")[0]!.operation, "pnpm check");
});

test("filterContentionCalls returns empty for no match", () => {
  const calls = [call({ filePath: "src/auth.ts" })];
  assert.equal(filterContentionCalls(calls, "src/missing.ts").length, 0);
});

test("filterContentionCalls matches operation when filePath is set but does not match path", () => {
  const calls = [
    call({ filePath: "src/other.ts", operation: "Edit src/other.ts" }),
  ];
  assert.equal(filterContentionCalls(calls, "Edit src/other.ts").length, 1);
});

test("filterContentionCalls matches operation when filePath does not match path", () => {
  const calls = [
    call({ filePath: "src/other.ts", operation: "pnpm check" }),
  ];
  assert.equal(filterContentionCalls(calls, "pnpm check").length, 1);
});

test("filterContentionCalls handles empty list", () => {
  assert.equal(filterContentionCalls([], "src/any.ts").length, 0);
});

// --- renderContentionCheck ---

test("renderContentionCheck returns 'No agents' message when empty", () => {
  const text = renderContentionCheck([], "src/clean.ts");
  assert.equal(text, "No agents currently modifying `src/clean.ts`.");
});

test("renderContentionCheck formats a single contention call", () => {
  const calls = [call({ agentId: "agent_abc", hostToolName: "Edit", runningForMs: 30_000 })];
  const text = renderContentionCheck(calls, "src/auth.ts");
  assert.ok(text.includes("agent_abc"), `expected agent id: ${text}`);
  assert.ok(text.includes("Edit"), `expected tool name: ${text}`);
  assert.ok(text.includes("30s"), `expected seconds: ${text}`);
  assert.ok(text.includes("src/auth.ts"), `expected path: ${text}`);
  assert.ok(text.includes("still running"), `expected running indicator: ${text}`);
});

test("renderContentionCheck formats multiple contention calls", () => {
  const calls = [
    call({ agentId: "agent_a", hostToolName: "Edit", runningForMs: 10_000 }),
    call({ agentId: "agent_b", hostToolName: "Bash", runningForMs: 5_000 }),
  ];
  const text = renderContentionCheck(calls, "src/file.ts");
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.includes("agent_a"));
  assert.ok(lines[1]!.includes("agent_b"));
});

test("renderContentionCheck uses 'unidentified agent' when agentId is null", () => {
  const calls = [call({ agentId: null })];
  const text = renderContentionCheck(calls, "src/auth.ts");
  assert.ok(text.includes("unidentified agent"), `expected fallback: ${text}`);
});

test("renderContentionCheck rounds sub-second calls to 0s", () => {
  const calls = [call({ runningForMs: 499 })];
  const text = renderContentionCheck(calls, "src/auth.ts");
  assert.ok(text.includes("0s"), `expected 0s: ${text}`);
});
