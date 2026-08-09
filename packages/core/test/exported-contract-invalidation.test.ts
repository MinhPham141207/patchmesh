import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectExportedContractInvalidation,
  type ConsumerContractDependencyEvidence,
  type ExportedContractChangeEvidence,
} from "../src/index.js";

const contractResourceId = `res_${"c".repeat(64)}`;
const domain = {
  repositoryId: "repo_11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_11111111-1111-4111-8111-111111111111",
  worktreeId: "wt_11111111-1111-4111-8111-111111111111",
};

const version = (value: string, eventId: string) => ({
  resourceId: contractResourceId,
  domain: { ...domain },
  kind: "content_hash" as const,
  value,
  evidenceEventIds: [eventId],
});

const change = (breaking = true): ExportedContractChangeEvidence => ({
  eventId: "evt_00000000000000000000000000000001",
  contractResourceId,
  beforeVersion: version("sha256:before", "evt_00000000000000000000000000000001"),
  afterVersion: version("sha256:after", "evt_00000000000000000000000000000002"),
  breaking,
  coverageId: "coverage_contract",
});

const consumer = (observed = "sha256:before"): ConsumerContractDependencyEvidence => ({
  eventId: "evt_00000000000000000000000000000003",
  dependencyId: "dep_contract_consumer",
  contractResourceId,
  consumerResourceId: `res_${"d".repeat(64)}`,
  affectedTaskId: "task_consumer",
  observedContractVersion: version(observed, "evt_00000000000000000000000000000003"),
  coverageId: "coverage_consumer",
});

test("reports a known consumer of a broken exported contract", () => {
  const result = detectExportedContractInvalidation(change(), consumer());

  assert.equal(result?.findingType, "exported_contract_invalidation");
  assert.equal(result?.evidence.affectedTaskId, "task_consumer");
  assert.deepEqual(result?.evidence.dependencyIds, ["dep_contract_consumer"]);
});

test("reports a known consumer that observed the contract in another worktree", () => {
  const crossWorktreeConsumer = consumer();
  const observedContractVersion = {
    ...crossWorktreeConsumer.observedContractVersion,
    domain: {
      ...crossWorktreeConsumer.observedContractVersion.domain,
      worktreeId: "wt_22222222-2222-4222-8222-222222222222",
    },
  };

  assert.equal(
    detectExportedContractInvalidation(change(), { ...crossWorktreeConsumer, observedContractVersion })?.findingType,
    "exported_contract_invalidation",
  );
});

test("does not report compatible changes or consumers on a different version", () => {
  assert.equal(detectExportedContractInvalidation(change(false), consumer()), null);
  assert.equal(detectExportedContractInvalidation(change(), consumer("sha256:other")), null);
});
