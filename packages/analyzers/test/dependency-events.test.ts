import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveDependencyChangedEvents,
  deriveEvidenceFacts,
  type SourceAnalysisInput,
} from "../src/index.js";

function input(resourceId: string, locator: string, content: string, sourceEventId: string): SourceAnalysisInput {
  return {
    resource: { resourceId, repositoryId: "repo_11111111-1111-4111-8111-111111111111", kind: "file", locator },
    version: {
      resourceId,
      domain: {
        repositoryId: "repo_11111111-1111-4111-8111-111111111111",
        workspaceId: "ws_11111111-1111-4111-8111-111111111111",
        worktreeId: "wt_11111111-1111-4111-8111-111111111111",
      },
      kind: "content_hash",
      value: `sha256:${locator}`,
      evidenceEventIds: [sourceEventId],
    },
    content,
    language: "typescript",
    sourceEventIds: [sourceEventId],
    analyzer: { analyzerId: "analyzer_typescript", version: "1" },
    configuration: { parser: "typescript" },
    integrationTarget: "main",
  };
}

const context = {
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
  agentId: "agent_agent-a",
  taskId: "task_task-a",
  correlationId: "corr_00000000000000000000000000000002",
  source: { kind: "analyzer" as const, sourceId: "source_typescript", instanceId: "11111111-1111-4111-8111-111111111111" },
  timestamp: "2026-08-09T00:00:00.000Z",
  sourceSequenceStart: 10,
};

test("emits a static dependency only for an explicitly resolved import and contract", () => {
  const contractFacts = deriveEvidenceFacts(input(`res_${"a".repeat(64)}`, "src/contracts.ts", "export interface Account { id: string }", "evt_00000000000000000000000000000001"));
  const consumerFacts = deriveEvidenceFacts(input(`res_${"b".repeat(64)}`, "src/consumer.ts", 'import { Account } from "./contracts";\nexport const value: Account = { id: "1" };', "evt_00000000000000000000000000000002"));
  const event = deriveDependencyChangedEvents([{
    consumer: consumerFacts.consumerImports[0]!,
    contract: contractFacts.exportedContracts[0]!,
  }], ["evt_00000000000000000000000000000003"], context)[0];

  assert.equal(event?.eventType, "dependency.changed");
  assert.equal(event?.causationId, "evt_00000000000000000000000000000002");
  assert.equal(event?.payload.dependency.observations[0]?.kind, "statically_observed");
  assert.equal(event?.payload.dependency.dependentResourceId, consumerFacts.source.resource.resourceId);
  assert.equal(event?.payload.dependency.dependencyResourceId, contractFacts.exportedContracts[0]?.resource.resourceId);
});

test("requires durable IDs for every resolved dependency", () => {
  assert.throws(() => deriveDependencyChangedEvents([], ["evt_00000000000000000000000000000003"], context));
});
