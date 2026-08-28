import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { deriveEvidenceFacts } from "patchmesh-analyzers";
import { loadContractScenarios } from "../../protocol/test/fixtures/contract-breaking.js";

import {
  detectExportedContractInvalidation,
  type ConsumerContractDependencyEvidence,
  type ExportedContractChangeEvidence,
} from "../src/exported-contract-invalidation.js";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

for (const scenario of loadContractScenarios()) {
  test(`contract-invalidation e2e: ${scenario.name} — analyzer parses and detector fires`, () => {
    // Verify analyzer can parse both versions with sufficient coverage
    const domain = {
      repositoryId: "repo_11111111-1111-4111-8111-111111111111",
      workspaceId: "ws_11111111-1111-4111-8111-111111111111",
      worktreeId: "wt_11111111-1111-4111-8111-111111111111",
    };
    const targetSnapshot = {
      targetSnapshotId: `snapshot_${"a".repeat(64)}` as const,
      integrationTargetId: "target_main" as const,
      repositoryId: domain.repositoryId,
      kind: "branch" as const,
      locator: "main",
      baseCommit: "a".repeat(40),
      candidateIds: [] as string[],
      digest: "a".repeat(64),
    };

    const contractLocator = `src/${scenario.contractPath}`;
    const consumerLocator = "src/consumer.ts";

    // Derive facts for before contract
    const beforeFacts = deriveEvidenceFacts({
      resource: { resourceId: `res_${sha(contractLocator).slice(0, 64)}` as any, repositoryId: domain.repositoryId, kind: "file", locator: contractLocator },
      version: {
        resourceId: `res_${sha(contractLocator).slice(0, 64)}` as any,
        domain: { ...domain },
        kind: "content_hash" as const,
        value: `sha256:${sha(scenario.beforeContent)}`,
        evidenceEventIds: ["evt_00000000000000000000000000000001" as any],
      },
      content: scenario.beforeContent,
      language: "typescript",
      sourceEventIds: ["evt_00000000000000000000000000000001" as any],
      analyzer: { analyzerId: "test", version: "1" },
      configuration: {},
      integrationTarget: "worktree",
    });
    assert.equal(beforeFacts.source.coverage.status, "sufficient", `${scenario.name} before coverage`);
    assert.ok(beforeFacts.exportedContracts.length >= 1, `${scenario.name} before has exports`);

    const afterFacts = deriveEvidenceFacts({
      resource: { resourceId: `res_${sha(contractLocator).slice(0, 64)}` as any, repositoryId: domain.repositoryId, kind: "file", locator: contractLocator },
      version: {
        resourceId: `res_${sha(contractLocator).slice(0, 64)}` as any,
        domain: { ...domain },
        kind: "content_hash" as const,
        value: `sha256:${sha(scenario.afterContent)}`,
        evidenceEventIds: ["evt_00000000000000000000000000000002" as any],
      },
      content: scenario.afterContent,
      language: "typescript",
      sourceEventIds: ["evt_00000000000000000000000000000002" as any],
      analyzer: { analyzerId: "test", version: "1" },
      configuration: {},
      integrationTarget: "worktree",
    });
    assert.equal(afterFacts.source.coverage.status, "sufficient", `${scenario.name} after coverage`);

    // Signature must have changed between before/after
    const beforeSig = beforeFacts.exportedContracts[0]?.version.value;
    const afterSig = afterFacts.exportedContracts[0]?.version.value;
    // For scenario C, interface field addition may keep first export's sig same if multiple exports;
    // check any exported contract changed
    const anyChanged = beforeFacts.exportedContracts.some((b) =>
      afterFacts.exportedContracts.some((a) => a.resource.locator === b.resource.locator && a.version.value !== b.version.value),
    );
    // Allow scenario-a to have changed signature; for others at least one should differ
    // If not, still proceed — detector test below is the real assertion

    // Pick the exported contract that actually changed (first differs)
    let contract: typeof beforeFacts.exportedContracts[number] | undefined;
    let contractAfter: typeof afterFacts.exportedContracts[number] | undefined;
    for (const b of beforeFacts.exportedContracts) {
      const a = afterFacts.exportedContracts.find((c) => c.resource.locator === b.resource.locator);
      if (a && a.version.value !== b.version.value) { contract = b; contractAfter = a; break; }
    }
    // Fallback to first if no diff (should not happen after fixture fixes)
    contract ??= beforeFacts.exportedContracts[0]!;
    contractAfter ??= afterFacts.exportedContracts.find((c) => c.resource.locator === contract!.resource.locator) ?? afterFacts.exportedContracts[0]!;
    const beforeVersion = contract.version;
    const afterVersion = contractAfter.version;
    assert.notEqual(beforeVersion.value, afterVersion.value, `${scenario.name} exported signature should change`);

    const change: ExportedContractChangeEvidence = {
      eventId: "evt_00000000000000000000000000000001" as any,
      contractResourceId: contract.resource.resourceId,
      beforeVersion,
      afterVersion,
      breaking: true,
      coverageId: beforeFacts.coverageId,
      targetSnapshot: targetSnapshot as any,
    };

    const consumer: ConsumerContractDependencyEvidence = {
      eventId: "evt_00000000000000000000000000000003" as any,
      dependencyId: "dep_contract_consumer" as any,
      contractResourceId: contract.resource.resourceId,
      consumerResourceId: `res_${sha(consumerLocator).slice(0, 64)}` as any,
      affectedTaskId: "task_consumer" as any,
      observedContractVersion: beforeVersion,
      coverageId: afterFacts.coverageId,
      targetSnapshot: targetSnapshot as any,
    };

    const result = detectExportedContractInvalidation(change, consumer);
    assert.ok(result, `${scenario.name} should produce finding`);
    assert.equal(result!.findingType, "exported_contract_invalidation");
    assert.ok(result!.confidence >= 0.9, "confidence >= 0.9");
    assert.ok(result!.evidence.evidenceEventIds.length >= 2, "evidenceEventIds >=2");
    assert.ok(result!.evidence.coverageIds.length >= 1, "coverageIds >=1");
    assert.ok(typeof result!.reason === "string" && result!.reason.length > 10, "reason meaningful");
    assert.ok(result!.evidence.dependencyIds.length >= 1, "has dependency link");

    void anyChanged; void beforeSig; void afterSig;
  });
}

test("contract scenarios — loader returns 3", () => {
  const scenarios = loadContractScenarios();
  assert.equal(scenarios.length, 3);
  for (const s of scenarios) {
    assert.ok(s.beforeContent.length > 0);
    assert.ok(s.afterContent.length > 0);
    assert.ok(s.consumerBeforeContent.length > 0);
    assert.ok(s.consumerAfterContent.length > 0);
  }
});
