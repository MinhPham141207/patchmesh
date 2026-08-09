import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveSourceFacts, type SourceAnalysisInput } from "../src/index.js";

const input = (
  content: string,
  language: SourceAnalysisInput["language"] = "typescript",
): SourceAnalysisInput => ({
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
    evidenceEventIds: ["evt_00000000000000000000000000000002"],
  },
  content,
  language,
  sourceEventIds: [
    "evt_00000000000000000000000000000002",
    "evt_00000000000000000000000000000001",
    "evt_00000000000000000000000000000002",
  ],
  analyzer: { analyzerId: "analyzer_typescript", version: "1" },
  configuration: { moduleResolution: "node16", parser: "typescript" },
  integrationTarget: "main",
});

test("preserves deterministic source-event provenance with parsed facts", () => {
  const facts = deriveSourceFacts(input("export function api(): void {}"));

  assert.deepEqual(facts.sourceEventIds, [
    "evt_00000000000000000000000000000001",
    "evt_00000000000000000000000000000002",
  ]);
  assert.deepEqual(facts.symbols.map((symbol) => symbol.name), ["api"]);
  assert.equal(facts.version.value, "sha256:source");
  assert.deepEqual(facts.configuration, { moduleResolution: "node16", parser: "typescript" });
  assert.equal(facts.integrationTarget, "main");
});

test("preserves degraded evidence without producing symbols or imports", () => {
  const facts = deriveSourceFacts(input("puts 'x'", "unsupported"));

  assert.equal(facts.coverage.reason, "unsupported_language");
  assert.deepEqual(facts.symbols, []);
  assert.deepEqual(facts.imports, []);
});
