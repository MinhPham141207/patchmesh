import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeSource, languageForExtension, supportedExtensions, type SourceAnalysisInput } from "../src/index.js";

const input = (content: string, language: SourceAnalysisInput["language"] = "python"): SourceAnalysisInput => ({
  resource: { resourceId: `res_${"a".repeat(64)}`, repositoryId: "repo_11111111-1111-4111-8111-111111111111", kind: "file", locator: "src/api.py" },
  version: { resourceId: `res_${"a".repeat(64)}`, domain: { repositoryId: "repo_11111111-1111-4111-8111-111111111111", workspaceId: "ws_11111111-1111-4111-8111-111111111111", worktreeId: "wt_11111111-1111-4111-8111-111111111111" }, kind: "content_hash", value: "sha256:source", evidenceEventIds: ["evt_00000000000000000000000000000001"] },
  content,
  language,
  sourceEventIds: ["evt_00000000000000000000000000000001"],
  analyzer: { analyzerId: "analyzer_python", version: "1" },
  configuration: { parser: "python" },
  integrationTarget: "main",
});

test("extracts module-level Python symbols and imports deterministically", () => {
  const result = analyzeSource(input([
    "from .accounts import Account, load_user",
    "import os",
    "",
    "def authenticate(user: str) -> bool:",
    "    return True",
    "",
    "class Session:",
    "    def refresh(self):",
    "        return None",
    "",
    "_private = 1",
    "TIMEOUT = 30",
  ].join("\n")));

  assert.equal(result.coverage.status, "sufficient");
  assert.equal(result.integrationTarget, "main");
  // Asserted as a map rather than an ordered array: the analyzer sorts with
  // localeCompare, whose case ordering is locale-dependent.
  // `refresh` is indented, so it is a method rather than a module-level export.
  assert.deepEqual(
    Object.fromEntries(result.symbols.map((symbol) => [symbol.name, symbol.exported])),
    { Session: true, TIMEOUT: true, _private: false, authenticate: true },
  );
  assert.deepEqual(result.imports, [
    { specifier: ".accounts", importedNames: ["Account", "load_user"] },
    { specifier: "os", importedNames: [] },
  ]);
});

test("__all__ is authoritative over the underscore convention", () => {
  const result = analyzeSource(input([
    '__all__ = ["authenticate"]',
    "",
    "def authenticate():",
    "    return True",
    "",
    "def helper():",
    "    return False",
  ].join("\n")));

  assert.deepEqual(
    Object.fromEntries(result.symbols.map((symbol) => [symbol.name, symbol.exported])),
    { authenticate: true, helper: false },
  );
});

test("Python structure inside strings and comments is not treated as source", () => {
  const result = analyzeSource(input([
    '"""',
    "def documented_but_not_real():",
    '"""',
    "# def commented_out():",
    'MESSAGE = "def also_not_real()"',
    "",
    "def actual():",
    "    return 1",
  ].join("\n")));

  assert.deepEqual([...result.symbols.map((symbol) => symbol.name)].sort(), ["MESSAGE", "actual"]);
});

test("degrades ambiguous Python rather than guessing a parse", () => {
  // Unbalanced brackets.
  assert.equal(analyzeSource(input("def broken(:\n    return 1")).coverage.reason, "ambiguous_parse");
  // Mixed tab and space indentation is ambiguous under Python's own rules.
  assert.equal(
    analyzeSource(input("def a():\n\treturn 1\n\ndef b():\n    return 2")).coverage.reason,
    "ambiguous_parse",
  );
});

test("language detection covers every supported extension and rejects the rest", () => {
  assert.equal(languageForExtension(".ts"), "typescript");
  assert.equal(languageForExtension(".mts"), "typescript");
  assert.equal(languageForExtension(".cts"), "typescript");
  assert.equal(languageForExtension(".TSX"), "typescript");
  assert.equal(languageForExtension(".mjs"), "javascript");
  assert.equal(languageForExtension(".py"), "python");
  assert.equal(languageForExtension(".pyi"), "python");
  assert.equal(languageForExtension(".md"), "unsupported");
  assert.equal(languageForExtension(".rb"), "unsupported");

  assert.deepEqual(supportedExtensions(), [
    ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".pyi", ".ts", ".tsx",
  ]);
});
