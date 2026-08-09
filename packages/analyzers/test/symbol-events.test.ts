import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveEvidenceFacts,
  deriveSymbolChangedEvents,
  type SourceAnalysisInput,
} from "../src/index.js";

const input: SourceAnalysisInput = {
  resource: {
    resourceId: `res_${"a".repeat(64)}`,
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    kind: "file",
    locator: "src/api.ts",
  },
  version: {
    resourceId: `res_${"a".repeat(64)}`,
    domain: {
      repositoryId: "repo_11111111-1111-4111-8111-111111111111",
      workspaceId: "ws_11111111-1111-4111-8111-111111111111",
      worktreeId: "wt_11111111-1111-4111-8111-111111111111",
    },
    kind: "content_hash",
    value: "sha256:source",
    evidenceEventIds: ["evt_00000000000000000000000000000001"],
  },
  content: "export function api(): void {}",
  language: "typescript",
  sourceEventIds: ["evt_00000000000000000000000000000001"],
  analyzer: { analyzerId: "analyzer_typescript", version: "1" },
  configuration: { parser: "typescript" },
  integrationTarget: "main",
};

const context = {
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
  agentId: "agent_agent-a",
  taskId: "task_task-a",
  correlationId: "corr_00000000000000000000000000000001",
  source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-09T00:00:00.000Z",
  sourceSequenceStart: 10,
};

test("turns derived symbols into causally attributable change events", () => {
  const facts = deriveEvidenceFacts(input);
  const events = deriveSymbolChangedEvents(facts, ["evt_00000000000000000000000000000002"], context);

  assert.equal(events[0]?.eventType, "symbol.changed");
  assert.equal(events[0]?.causationId, input.sourceEventIds[0]);
  assert.equal(events[0]?.correlationId, context.correlationId);
  assert.equal(events[0]?.sourceSequence, 10);
  assert.equal(events[0]?.payload.resource.kind, "symbol");
  assert.equal(events[0]?.payload.afterVersion.kind, "symbol_signature");
});

test("requires one durable event ID per derived symbol", () => {
  assert.throws(() => deriveSymbolChangedEvents(deriveEvidenceFacts(input), [], context));
});
