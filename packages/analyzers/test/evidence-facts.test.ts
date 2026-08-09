import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveEvidenceFacts, type SourceAnalysisInput } from "../src/index.js";

function input(content: string, language: SourceAnalysisInput["language"] = "typescript"): SourceAnalysisInput {
  return {
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
    content,
    language,
    sourceEventIds: ["evt_00000000000000000000000000000001"],
    analyzer: { analyzerId: "analyzer_typescript", version: "1" },
    configuration: { parser: "typescript" },
    integrationTarget: "main",
  };
}

test("derives deterministic symbol, contract, and consumer facts", () => {
  const source = 'import { Account } from "./accounts";\nexport function api(value: Account): void {}\nconst local = 1;';
  const first = deriveEvidenceFacts(input(source));
  const second = deriveEvidenceFacts(input(source));

  assert.deepEqual(first, second);
  assert.equal(first.coverageId, `coverage_${first.coverageId.slice("coverage_".length)}`);
  assert.deepEqual(first.symbols.map((symbol) => [symbol.resource.locator, symbol.version.kind]), [
    ["src/api.ts#api", "symbol_signature"],
    ["src/api.ts#local", "symbol_signature"],
  ]);
  assert.deepEqual(first.exportedContracts.map((symbol) => symbol.resource.locator), ["src/api.ts#api"]);
  assert.deepEqual(first.consumerImports.map((entry) => [entry.specifier, entry.importedNames]), [["./accounts", ["Account"]]]);
});

test("degraded source produces no symbol, contract, or consumer facts", () => {
  const facts = deriveEvidenceFacts(input("puts 'x'", "unsupported"));

  assert.equal(facts.source.coverage.status, "degraded");
  assert.deepEqual(facts.symbols, []);
  assert.deepEqual(facts.exportedContracts, []);
  assert.deepEqual(facts.consumerImports, []);
});
