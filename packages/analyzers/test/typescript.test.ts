import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSource, type SourceAnalysisInput } from "../src/index.js";

const input = (content: string, language: SourceAnalysisInput["language"] = "typescript"): SourceAnalysisInput => ({
  resource: { resourceId: `res_${"a".repeat(64)}`, repositoryId: "repo_11111111-1111-4111-8111-111111111111", kind: "file", locator: "src/api.ts" },
  version: { resourceId: `res_${"a".repeat(64)}`, domain: { repositoryId: "repo_11111111-1111-4111-8111-111111111111", workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId: "wt_11111111-1111-4111-8111-111111111111" }, kind: "content_hash", value: "sha256:source", evidenceEventIds: ["evt_00000000000000000000000000000001"] },
  content,
  language,
  sourceEventIds: ["evt_00000000000000000000000000000001"],
  analyzer: { analyzerId: "analyzer_typescript", version: "1" },
  configuration: { moduleResolution: "node16", parser: "typescript" },
  integrationTarget: "main",
});

test("extracts exported symbols and imports deterministically", () => {
  const result = analyzeSource(input('import { user, type Account } from "./accounts";\nexport function authenticate(user: string): boolean { return true; }\nconst local = 1;'));
  assert.equal(result.coverage.status, "sufficient");
  assert.equal(result.integrationTarget, "main");
  assert.deepEqual(result.symbols.map((symbol) => [symbol.name, symbol.exported]), [["authenticate", true], ["local", false]]);
  assert.deepEqual(result.imports, [{ specifier: "./accounts", importedNames: ["Account", "user"] }]);
});

test("degrades unsupported and structurally ambiguous source", () => {
  assert.equal(analyzeSource(input("puts 'x'", "unsupported")).coverage.reason, "unsupported_language");
  assert.equal(analyzeSource(input("export function broken() {")).coverage.reason, "ambiguous_parse");
});
