import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  deriveEvidenceFacts,
  resolveLocalContractDependencies,
  type SourceAnalysisInput,
} from "../src/index.js";

function facts(
  locator: string,
  content: string,
  integrationTarget = "main",
  worktreeId = "wt_11111111-1111-4111-8111-111111111111",
) {
  const resourceId = `res_${createHash("sha256").update(locator).digest("hex")}`;
  const input: SourceAnalysisInput = {
    resource: {
      resourceId,
      repositoryId: "repo_11111111-1111-4111-8111-111111111111",
      kind: "file",
      locator,
    },
    version: {
      resourceId,
      domain: {
        repositoryId: "repo_11111111-1111-4111-8111-111111111111",
        workspaceId: "ws_11111111-1111-4111-8111-111111111111",
        worktreeId,
      },
      kind: "content_hash",
      value: `sha256:${locator}`,
      evidenceEventIds: ["evt_00000000000000000000000000000001"],
    },
    content,
    language: "typescript",
    sourceEventIds: ["evt_00000000000000000000000000000001"],
    analyzer: { analyzerId: "analyzer_typescript", version: "1" },
    configuration: { parser: "typescript" },
    integrationTarget,
  };
  return deriveEvidenceFacts(input);
}

test("resolves only a unique relative import in the same integration target", () => {
  const api = facts("src/api.ts", "export interface Account { id: string }");
  const consumer = facts("src/consumer.ts", 'import { Account } from "./api";\nexport function use(value: Account) {}');

  const resolved = resolveLocalContractDependencies([consumer, api]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.contract.resource.locator, "src/api.ts#Account");
  assert.equal(resolved[0]?.consumer.specifier, "./api");
});

test("resolves a consumer against a contract in another worktree", () => {
  const api = facts("src/api.ts", "export interface Account { id: string }", "main", "wt_22222222-2222-4222-8222-222222222222");
  const consumer = facts("src/consumer.ts", 'import { Account } from "./api";\nexport function use(value: Account) {}');

  const resolved = resolveLocalContractDependencies([consumer, api]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.contract.sourceFacts.version.domain.worktreeId, "wt_22222222-2222-4222-8222-222222222222");
});

test("retains every consumer of one exported contract", () => {
  const api = facts("src/api.ts", "export interface Account { id: string }");
  const firstConsumer = facts("src/consumer-a.ts", 'import { Account } from "./api";\nexport function useA(value: Account) {}');
  const secondConsumer = facts("src/consumer-b.ts", 'import { Account } from "./api";\nexport function useB(value: Account) {}');

  const resolved = resolveLocalContractDependencies([firstConsumer, secondConsumer, api]);

  assert.equal(resolved.length, 2);
  assert.deepEqual(
    resolved.map((entry) => entry.consumer.consumer.locator),
    ["src/consumer-a.ts", "src/consumer-b.ts"],
  );
});

test("does not resolve bare specifiers, missing symbols, or cross-target contracts", () => {
  const api = facts("src/api.ts", "export interface Account { id: string }");
  const otherTargetApi = facts("src/api.ts", "export interface Account { id: string }", "release");
  const bare = facts("src/bare.ts", 'import { Account } from "library";');
  const missing = facts("src/missing.ts", 'import { Missing } from "./api";');
  const crossTarget = facts("src/cross.ts", 'import { Account } from "./api";', "release");

  assert.deepEqual(resolveLocalContractDependencies([api, bare, missing]), []);
  assert.deepEqual(resolveLocalContractDependencies([api, crossTarget]), []);
  assert.equal(resolveLocalContractDependencies([otherTargetApi, crossTarget]).length, 1);
});

test("a TypeScript import naming its compiled output resolves to the source it comes from", () => {
  // Under NodeNext resolution a TypeScript file imports its sibling as `./api.js`, because the
  // specifier has to name the file that exists at runtime. The source on disk, and the file
  // whose contracts are recorded, is `api.ts`. Matching the specifier literally resolved
  // nothing in any project using the convention -- including this one -- so no dependency was
  // ever resolved and `dependency.changed` could never be emitted from real traffic.
  const api = facts("src/api.ts", "export interface Account { id: string }");
  const consumer = facts("src/consumer.ts", 'import { Account } from "./api.js";\nexport function use(value: Account) {}');

  const resolved = resolveLocalContractDependencies([consumer, api]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.contract.resource.locator, "src/api.ts#Account");
  assert.equal(resolved[0]?.consumer.specifier, "./api.js");
});

test("a literally present .js file still resolves to itself rather than to a same-named source", () => {
  // The mapping adds candidates, it does not replace the literal one: a project that really
  // does import a checked-in JavaScript file must keep resolving to that file.
  const api = facts("src/api.js", "export interface Account { id: string }");
  const consumer = facts("src/consumer.ts", 'import { Account } from "./api.js";\nexport function use(value: Account) {}');

  const resolved = resolveLocalContractDependencies([consumer, api]);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.contract.resource.locator, "src/api.js#Account");
});

test("an import that could be either a source or its compiled output is left unresolved", () => {
  // Both `api.ts` and `api.js` export the name. Two candidates is ambiguity, and the resolver's
  // whole contract is that it refuses to guess rather than inventing a dependency.
  const source = facts("src/api.ts", "export interface Account { id: string }");
  const compiled = facts("src/api.js", "export interface Account { id: string }");
  const consumer = facts("src/consumer.ts", 'import { Account } from "./api.js";\nexport function use(value: Account) {}');

  assert.equal(resolveLocalContractDependencies([consumer, source, compiled]).length, 0);
});
