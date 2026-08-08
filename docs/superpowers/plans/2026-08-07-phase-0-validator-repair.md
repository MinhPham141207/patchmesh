# Phase 0 Validator Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen the existing Phase 0 contract validator so it rejects incomplete or contradictory artifacts, bind dependency edges and validity transitions to their supporting evidence, discriminate event payloads by type, require the exact benchmark workload sets, scan every loaded artifact for secrets, and complete the Phase 0 verification process before retaining the roadmap completion marker — without adding any Phase 1 runtime surface.

**Architecture:** The Phase 0 validator is a dependency-free Node module under `tools/phase0/` that loads JSON Schema Draft 2020-12 documents from `schemas/phase0/v1/`, golden and negative fixtures from `fixtures/`, and benchmark definitions from `benchmarks/phase0/`. Repairs extend the existing schema and domain libraries plus the `validate.mjs` entry point. Every repaired invariant is backed by a focused unit test and at least one negative fixture that must surface its declared `PHASE0_*` error.

**Tech Stack:** Node.js built-ins, `node:test`, JSON Schema Draft 2020-12 subset, JSON/NDJSON, PowerShell, Git. No new dependencies.

## Global Constraints

From `docs/superpowers/specs/2026-08-07-phase-0-validator-repair-design.md` and `docs/AGENTS.md`:

- Do not add Phase 1 TypeScript/pnpm workspace, runtime adapter, gateway, daemon, SQLite store, projection engine, or product CLI.
- Do not populate or convert empty local `apps/` or `packages/` directories.
- Changes are limited to Phase 0 schemas, validator libraries, tests, fixtures, this plan, and completion documentation.
- Contract-invalid input produces sorted `PHASE0_*` diagnostics and exit code `1`.
- Invocation, filesystem, or validator implementation failures that cannot be represented as a contract diagnostic remain exit code `2`.
- Diagnostics never echo rejected values or secret contents.
- Every behavior change requires a regression test plus a negative fixture where the invariant is expressible.
- Run `node tools/phase0/validate.mjs` before committing; do not commit unless explicitly requested.
- Verified host hooks own the Knowl lifecycle; do not start a manual task loop.

---

## File Responsibility Map

- Modify: `tools/phase0/lib/domain.mjs` — add `validateManifestSemantics`, edge-to-event dependency binding, validity transition guards, exact interception-operation benchmark check.
- Verify: `tools/phase0/lib/canonical-json.mjs` — reuse `canonicalize` and `canonicalDigest`; no change is required.
- Modify: `tools/phase0/validate.mjs` — catch `CorpusContractError` at entry to emit exit `1` diagnostics; apply `canonicalSnapshot` to variant bundle comparison; schema-validate and secret-scan variant expected artifacts; call `validateManifestSemantics`.
- Modify: `schemas/phase0/v1/event-envelope.schema.json` — split the envelope `payload` into 13 discriminant `oneOf` branches keyed by `eventType`.
- Modify: `schemas/phase0/v1/decision.schema.json` — make `target` and `delivery.target` use nullable `agentId`/`taskId`.
- Modify: `tools/phase0/domain.test.mjs` — add regression tests for each repaired invariant.
- Modify: `tools/phase0/schema.test.mjs` — add tests for discriminated envelope branches and nullable decision targets.
- Modify: `tools/phase0/corpus.test.mjs` — update positive/negative corpus counts and add declared-error entries for new negative fixtures.
- Create: negative fixtures under `fixtures/invalid/v1/` for each repaired rule that can be expressed as a corpus artifact.
- Modify: `docs/superpowers/plans/2026-08-06-phase-0-foundation.md` — append the repair reconciliation note after final verification.
- Verify: `docs/ROADMAP.md` — keep `Status: Complete` after final verification; do not change the status text.

---

## Execution Preconditions

- Execute from an isolated worktree created with `superpowers:using-git-worktrees`.
- Read `docs/AGENTS.md`, `docs/THREAT_MODEL.md`, `docs/protocol/*.md`, and `docs/superpowers/specs/2026-08-07-phase-0-validator-repair-design.md` before editing.
- Treat the repair spec as the design authority and `docs/ROADMAP.md` as the phase authority.
- Confirm the baseline before Task 1: `node tools/phase0/validate.mjs` prints `Phase 0 corpus valid` and exits `0`; running `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs` passes with 28 tests.

---

## Task 1: Manifest Semantics

**Files:**
- Modify: `tools/phase0/lib/domain.mjs` (add `validateManifestSemantics`)
- Modify: `tools/phase0/validate.mjs` (call `validateManifestSemantics`)
- Modify: `tools/phase0/domain.test.mjs` (tests for positive-without-expected, negative-without-error)
- Create: `fixtures/invalid/v1/positive-without-expected/manifest.json`, `events.ndjson`
- Create: `fixtures/invalid/v1/negative-without-error/manifest.json`, `events.ndjson`
- Modify: `tools/phase0/corpus.test.mjs` (counts and expected-error map)
- Test: `tools/phase0/domain.test.mjs`

**Interfaces:**
- Consumes: `scenario.manifest` shape from `scenario-manifest.schema.json`.
- Produces: `validateManifestSemantics(manifest, manifestPath)` returning a `diagnostic[]`:
  - `kind === 'positive'` and `manifest.expected === null` → `PHASE0_SCHEMA_INVALID` at `/expected`, `'positive manifest must declare expected projections'`.
  - `kind === 'negative'` and `manifest.expectedError === null` → `PHASE0_SCHEMA_INVALID` at `/expectedError`, `'negative manifest must declare a primary error code'`.
  - `kind === 'negative'` and `manifest.expected === null` is permitted (derived outputs may be omitted when validation stops before projection).

- [x] **Step 1: Write the failing unit test**

Append to `tools/phase0/domain.test.mjs`:

```js
import { validateManifestSemantics } from './lib/domain.mjs';

test('manifest semantics reject a positive projection without expected outputs', () => {
  const manifest = { schemaVersion: 1, scenarioId: 'scenario_positive_without_expected', title: 'missing expected', targetPhase: 1, kind: 'positive', eventsFile: 'events.ndjson', expected: null, variants: [], expectedError: null };
  const diagnostics = validateManifestSemantics(manifest, 'fixtures/invalid/v1/positive-without-expected/manifest.json');
  assert.equal(diagnostics[0].code, 'PHASE0_SCHEMA_INVALID');
  assert.equal(diagnostics[0].pointer, '/expected');
});

test('manifest semantics reject a negative fixture without a declared error', () => {
  const manifest = { schemaVersion: 1, scenarioId: 'scenario_negative_without_error', title: 'missing error', targetPhase: 1, kind: 'negative', eventsFile: 'events.ndjson', expected: null, variants: [], expectedError: null };
  const diagnostics = validateManifestSemantics(manifest, 'fixtures/invalid/v1/negative-without-error/manifest.json');
  assert.equal(diagnostics[0].code, 'PHASE0_SCHEMA_INVALID');
  assert.equal(diagnostics[0].pointer, '/expectedError');
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tools/phase0/domain.test.mjs`
Expected: FAIL with `validateManifestSemantics is not a function`.

- [x] **Step 3: Implement `validateManifestSemantics`**

Add to `tools/phase0/lib/domain.mjs` (after the existing helpers, before `validateScenarioDomain`):

```js
export function validateManifestSemantics(manifest, manifestPath) {
  const diagnostics = [];
  if (manifest.kind === 'positive' && manifest.expected === null)
    diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/expected', 'positive manifest must declare expected projections', manifestPath));
  if (manifest.kind === 'negative' && manifest.expectedError === null)
    diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/expectedError', 'negative manifest must declare a primary error code', manifestPath));
  return sortDiagnostics(diagnostics);
}
```

Note: `issue(code, pointer, message, path)` already exists at `domain.mjs:10`. Import or reference `manifestPath` as the diagnostic `path`.

- [x] **Step 4: Wire the call into the validator**

In `tools/phase0/validate.mjs`, `validateOneScenario` currently spreads schema, secrets, event, expected, domain, and variant diagnostics. Insert the manifest-semantic call immediately after the manifest schema validation:

```js
function validateOneScenario(scenario, registry) {
  return sortDiagnostics([
    ...validateInstance(schemaId('scenario-manifest'), scenario.manifest, registry, `${scenario.directory}/manifest.json`),
    ...validateManifestSemantics(scenario.manifest, `${scenario.directory}/manifest.json`),
    ...machineSecrets(scenario),
    ...eventSchemas(scenario, registry),
    ...expectedSchemas(scenario, registry),
    ...expectedEventCopies(scenario),
    ...validateScenarioDomain(scenario),
    ...variants(scenario),
  ]);
}
```

Add `validateManifestSemantics` to the import from `./lib/domain.mjs`.

- [x] **Step 5: Create the negative fixtures**

`fixtures/invalid/v1/positive-without-expected/manifest.json`:

```json
{"schemaVersion":1,"scenarioId":"scenario_positive_without_expected","title":"Positive scenarios must declare expected projections","targetPhase":1,"kind":"positive","eventsFile":"events.ndjson","expected":null,"variants":[],"expectedError":null}
```

`fixtures/invalid/v1/positive-without-expected/events.ndjson` (single minimal event; the validator must reject at manifest semantics before reaching event-level checks for this fixture's declared error):

```ndjson
{"schemaVersion":1,"eventId":"evt_0000000000000000000000000000000a","eventType":"tool.requested","source":{"kind":"gateway","sourceId":"source_gateway","instanceId":"11111111-1111-4111-8111-111111111111"},"timestamp":"2026-08-06T00:00:00.000Z","repositoryId":"repo_11111111-1111-4111-8111-111111111111","workspaceId":"ws_22222222-2222-4222-8222-222222222222","worktreeId":"wt_33333333-3333-4333-8333-333333333333","agentId":"agent_a","taskId":"task_a","correlationId":"corr_0000000000000000000000000000000a","causationId":null,"sourceSequence":0,"payload":{"toolName":"read_file","operation":"read","targetResourceId":null,"opaque":false}}
```

`fixtures/invalid/v1/negative-without-error/manifest.json`:

```json
{"schemaVersion":1,"scenarioId":"scenario_negative_without_error","title":"Negative fixtures must declare a primary error","targetPhase":1,"kind":"negative","eventsFile":"events.ndjson","expected":null,"variants":[],"expectedError":null}
```

`fixtures/invalid/v1/negative-without-error/events.ndjson`: copy the same single event line as the positive fixture, with `eventId` and `correlationId` set to `...0000000b` to keep IDs unique across fixtures.

- [x] **Step 6: Update `corpus.test.mjs` counts and the expected-error map**

In `tools/phase0/corpus.test.mjs`, the assertion at line 7 currently expects `positiveScenarios.length === 5` and `negativeFixtures.length === 8`. After this task there are still 5 positive scenarios; negative fixtures become 10. Update:

```js
assert.equal(corpus.positiveScenarios.length, 5);
assert.equal(corpus.negativeFixtures.length, 10);
```

Extend the `expected` map at line 9 with:

```js
['scenario_positive_without_expected', 'PHASE0_SCHEMA_INVALID'],
['scenario_negative_without_error', 'PHASE0_SCHEMA_INVALID'],
```

- [x] **Step 7: Run all tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Expected: all tests pass.

Run: `node tools/phase0/validate.mjs`
Expected: `Phase 0 corpus valid` and exit `0`.

- [x] **Step 8: Review the scope**

Run: `git diff --stat HEAD`
Expected: only `tools/phase0/lib/domain.mjs`, `tools/phase0/validate.mjs`, the two new test-related lines in `tools/phase0/domain.test.mjs`, `tools/phase0/corpus.test.mjs`, and the two new fixture directories.

- [x] **Step 9: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 1 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 2: Corpus Failure Diagnostics

**Files:**
- Modify: `tools/phase0/validate.mjs` (make schema-document loading use `readJson`; catch `CorpusContractError` at entry; box other failures)
- Verify: `tools/phase0/lib/corpus.mjs` (reuse its existing sanitized `CorpusContractError` path for malformed or missing JSON)
- Modify: `tools/phase0/diagnostics.test.mjs` (entry-point error mapping test)
- Test: `tools/phase0/diagnostics.test.mjs`

**Interfaces:**
- Consumes: `CorpusContractError` from `./lib/corpus.mjs` with `error.diagnostic: { code, path, pointer, message }`.
- Produces: `main` exits `EXIT_CONTRACT_INVALID` (`1`) when a `CorpusContractError` is caught and prints `formatDiagnostics([error.diagnostic])`. Other `Error` instances still map to `EXIT_TOOL_FAILURE` (`2`) with `PHASE0_VALIDATOR_FAILURE: <message>`.

- [x] **Step 1: Write the failing entry-point test**

Add `main` from `./validate.mjs` and `fileURLToPath` from `node:url` to the imports in `tools/phase0/diagnostics.test.mjs`, then append:

```js
test('a corpus contract error surfaces as PHASE0_* exit code 1, not a tool failure', async () => {
  const root = fileURLToPath(new URL('../../docs/superpowers/plans/', import.meta.url));
  let captured = '';
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { captured += chunk; return true; };
  try {
    const code = await main(['--root', root]);
    assert.equal(code, EXIT_CONTRACT_INVALID);
  } finally {
    process.stderr.write = original;
  }
  assert.match(captured, /^PHASE0_SCHEMA_INVALID /u);
  assert.doesNotMatch(captured, /PHASE0_VALIDATOR_FAILURE/u);
  assert.doesNotMatch(captured, /[A-Za-z]:\\/u);
});
```

The selected root has no Phase 0 benchmark artifact, so the existing `readJson` helper deterministically raises `CorpusContractError` without requiring a repository mutation.

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tools/phase0/diagnostics.test.mjs`
Expected: FAIL because the current entry point maps `CorpusContractError` to `EXIT_TOOL_FAILURE` and prints `PHASE0_VALIDATOR_FAILURE`.

- [x] **Step 3: Implement the entry-point handler**

In `tools/phase0/validate.mjs`, remove the now-unused `readFile` import, change `loadSchemas` to parse each schema with `readJson(root, path)` instead of `JSON.parse(await readFile(path, 'utf8'))`, then import `CorpusContractError` and split the `main` try block:

```js
async function loadSchemas(root) {
  const files = (await walkFiles(join(root, 'schemas', 'phase0', 'v1'))).filter((path) => path.endsWith('.schema.json'));
  const documents = await Promise.all(files.map(async (path) => ({ path: normalized(relative(root, path)), schema: await readJson(root, path) })));
  return createSchemaRegistry(documents);
}
```

```js
import { CorpusContractError } from './lib/corpus.mjs';

export async function main(args = process.argv.slice(2)) {
  try {
    const { root } = parseArgs(args);
    const diagnostics = await validateRepository(root);
    if (diagnostics.length) { process.stderr.write(`${formatDiagnostics(diagnostics)}\n`); return EXIT_CONTRACT_INVALID; }
    process.stdout.write('Phase 0 corpus valid\n');
    return EXIT_OK;
  } catch (error) {
    if (error instanceof CorpusContractError) {
      process.stderr.write(`${formatDiagnostics([error.diagnostic])}\n`);
      return EXIT_CONTRACT_INVALID;
    }
    process.stderr.write(`PHASE0_VALIDATOR_FAILURE: ${error.message}\n`);
    return EXIT_TOOL_FAILURE;
  }
}
```

- [x] **Step 4: Add malformed-schema coverage**

Add `mkdtemp`, `mkdir`, `rm`, and `writeFile` to the `node:fs/promises` imports and add `join` and `tmpdir` from `node:path`/`node:os`. Then append this test:

```js
test('a malformed schema document is a contract failure with a sanitized path', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'phase0-invalid-schema-'));
  let captured = '';
  const original = process.stderr.write.bind(process.stderr);
  try {
    await mkdir(join(temporaryRoot, 'schemas', 'phase0', 'v1'), { recursive: true });
    await writeFile(join(temporaryRoot, 'schemas', 'phase0', 'v1', 'example.schema.json'), '{', 'utf8');
    process.stderr.write = (chunk) => { captured += chunk; return true; };
    assert.equal(await main(['--root', temporaryRoot]), EXIT_CONTRACT_INVALID);
  } finally {
    process.stderr.write = original;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  assert.match(captured, /^PHASE0_SCHEMA_INVALID /u);
  assert.doesNotMatch(captured, /PHASE0_VALIDATOR_FAILURE/u);
  assert.doesNotMatch(captured, /[A-Za-z]:\\/u);
});
```

This verifies that schema JSON failures use the same sanitized contract path as corpus JSON failures.

- [x] **Step 5: Run all tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all tests pass; validator prints `Phase 0 corpus valid` and exits `0`.

- [x] **Step 6: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 2 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 3: Nullable Decision Targets

**Files:**
- Modify: `schemas/phase0/v1/decision.schema.json` (`target` and `delivery.target` use nullable identities)
- Modify: `tools/phase0/lib/domain.mjs` (the existing `validateDecisionCapabilities` already rejects both-null; ensure the guard reads nullable fields)
- Create: `fixtures/invalid/v1/empty-decision-target/manifest.json`, `events.ndjson`
- Modify: `tools/phase0/schema.test.mjs` (nullable target test, both-null rejection)
- Modify: `tools/phase0/corpus.test.mjs` (counts and expected-error map)
- Test: `tools/phase0/schema.test.mjs`

**Interfaces:**
- Consumes: `identities.schema.json#/$defs/agentId` and `#/$defs/taskId` (both already `oneOf` string|null).
- Produces: `decision.schema.json#/$defs/target` with `agentId` and `taskId` both nullable; domain rejects a target where both are null with `PHASE0_SCHEMA_INVALID` at `/decisions/<index>/target` (existing message: `'decision target requires agent or task'`).

- [x] **Step 1: Write the failing schema test**

Append to `tools/phase0/schema.test.mjs`:

```js
test('decision targets accept agent-only, task-only, or both but never neither', async () => {
  const names = ['identities', 'coverage', 'finding', 'decision'];
  const documents = await Promise.all(names.map(async (name) => ({ path: name, schema: JSON.parse(await readFile(new URL(`../../schemas/phase0/v1/${name}.schema.json`, import.meta.url), 'utf8')) })));
  const registry = createSchemaRegistry(documents);
  const base = { decisionId: 'decision_00000000000000000000000000000001', findingId: 'finding_00000000000000000000000000000001', target: { agentId: 'agent_b', taskId: 'task_consumer' }, coordinationAction: 'request_revalidation', gatewayDirective: 'allow_with_notice', reason: 'change', evidenceEventIds: ['evt_00000000000000000000000000000001'], confidence: 1, confidenceBand: 'high', policy: { policyId: 'policy_x', version: '1' }, expectedResponse: 'affected', coverageIds: ['coverage_00000000000000000000000000000001'], state: 'active', deliveries: [] };
  assert.deepEqual(validateInstance(documents[3].schema.$id, { ...base, target: { agentId: 'agent_b', taskId: null } }, registry), []);
  assert.deepEqual(validateInstance(documents[3].schema.$id, { ...base, target: { agentId: null, taskId: 'task_consumer' } }, registry), []);
  assert.deepEqual(validateInstance(documents[3].schema.$id, { ...base, target: { agentId: null, taskId: null } }, registry), []);
});
```

The last assertion documents the schema accepting both-null so the domain layer can reject it; the actual domain rejection is covered by Step 4.

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tools/phase0/schema.test.mjs`
Expected: FAIL — the existing `target` requires both `agentId` and `taskId` to be non-null strings, so the agent-only/task-only/both-null cases produce `PHASE0_SCHEMA_INVALID`.

- [x] **Step 3: Make the target schema nullable**

In `schemas/phase0/v1/decision.schema.json`, replace the `target` definition:

```json
"target": { "type": "object", "properties": { "agentId": { "$ref": "./identities.schema.json#/$defs/agentId" }, "taskId": { "$ref": "./identities.schema.json#/$defs/taskId" } }, "required": ["agentId", "taskId"], "additionalProperties": false }
```

- [x] **Step 4: Add the domain rejection test**

Append to `tools/phase0/domain.test.mjs`:

```js
test('a decision target with neither agent nor task is rejected at domain level', () => {
  const decisions = [{ decisionId: 'decision_00000000000000000000000000000001', findingId: 'finding_00000000000000000000000000000001', target: { agentId: null, taskId: null }, coordinationAction: 'record', gatewayDirective: 'allow', reason: 'change', evidenceEventIds: [base.eventId], confidence: 0.5, confidenceBand: 'medium', policy: { policyId: 'policy_x', version: '1' }, expectedResponse: 'affected', coverageIds: ['coverage_00000000000000000000000000000001'], state: 'active', deliveries: [] }];
  const diagnostics = validateDecisionCapabilities(decisions, 1);
  assert.equal(diagnostics[0].code, 'PHASE0_SCHEMA_INVALID');
  assert.equal(diagnostics[0].pointer, '/decisions/0/target');
});
```

The existing `validateDecisionCapabilities` already contains the `if (decision.target && !decision.target.agentId && !decision.target.taskId)` branch at `domain.mjs:127`. With the schema now both nullable, the guard is reachable.

Also update the expected-projection reference checks in `validateScenarioDomain`: only check an agent reference when `decision.target.agentId !== null`, and only check a task reference when `decision.target.taskId !== null`. Keep the existing both-null domain diagnostic. Apply the same conditional rule to delivery targets through their equality check with the parent decision; do not treat a permitted null identity as a missing reference.

```js
if (decision.target.agentId !== null && !agentIds.has(decision.target.agentId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/target/agentId`, 'target agent is absent'));
if (decision.target.taskId !== null && !taskIds.has(decision.target.taskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/target/taskId`, 'target task is absent'));
```

- [x] **Step 5: Create the corpus negative fixture**

`fixtures/invalid/v1/empty-decision-target/manifest.json`:

```json
{"schemaVersion":1,"scenarioId":"scenario_empty_decision_target","title":"Decision target requires an agent, a task, or both","targetPhase":1,"kind":"negative","eventsFile":"events.ndjson","expected":null,"variants":[],"expectedError":"PHASE0_SCHEMA_INVALID"}
```

`fixtures/invalid/v1/empty-decision-target/events.ndjson`: a single `decision.created` event whose `payload.decision.target` is `{ "agentId": null, "taskId": null }` and otherwise satisfies the schema. Use `eventId` and `correlationId` distinct from other fixtures (e.g., `evt_...0000000c`, `corr_...0000000c`). The surrounding envelope must be a valid Phase 0 event, with `agentId: 'agent_a'`, `taskId: 'task_a'`, and a `decision` payload whose `coordinationAction: 'record'` and `gatewayDirective: 'allow'` are both Phase-1 legal. The domain check fires on the embedded decision via `validateDecisionCapabilities`.

- [x] **Step 6: Update `corpus.test.mjs`**

`negativeFixtures.length` is now `11`. Add `['scenario_empty_decision_target', 'PHASE0_SCHEMA_INVALID']` to the `expected` map.

- [x] **Step 7: Run tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; validator prints `Phase 0 corpus valid`.

- [x] **Step 8: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 3 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 4: Discriminated Event Envelope Payloads

**Files:**
- Modify: `schemas/phase0/v1/event-envelope.schema.json` (`payload` becomes 13 discriminant `oneOf` branches, one per `eventType`)
- Modify: `tools/phase0/schema.test.mjs` (payload/type mismatch rejection)
- Test: `tools/phase0/schema.test.mjs`

**Interfaces:**
- Consumes: the existing `event-payloads.schema.json` `$defs`.
- Produces: an envelope `payload` whose branch is selected by `eventType` const plus the matching payload def. The entry-point `PAYLOAD_REF_BY_EVENT_TYPE` map in `validate.mjs` remains as defense-in-depth and continues to produce the `PHASE0_SCHEMA_UNSUPPORTED` diagnostic for unsupported versions.

- [x] **Step 1: Write the failing test**

Append to `tools/phase0/schema.test.mjs`:

```js
test('the event envelope discriminates payload by eventType', async () => {
  const names = ['identities', 'event-payloads', 'event-envelope'];
  const documents = await Promise.all(names.map(async (name) => ({ path: `schemas/phase0/v1/${name}.schema.json`, schema: JSON.parse(await readFile(new URL(`../../schemas/phase0/v1/${name}.schema.json`, import.meta.url), 'utf8')) })));
  const registry = createSchemaRegistry(documents);
  const valid = { schemaVersion: 1, eventId: 'evt_00000000000000000000000000000001', eventType: 'tool.requested', source: { kind: 'gateway', sourceId: 'source_gateway', instanceId: '11111111-1111-4111-8111-111111111111' }, timestamp: '2026-08-06T00:00:00.000Z', repositoryId: 'repo_11111111-1111-4111-8111-111111111111', workspaceId: 'ws_22222222-2222-4222-8222-222222222222', worktreeId: 'wt_33333333-3333-4333-8333-333333333333', agentId: 'agent_b', taskId: null, correlationId: 'corr_00000000000000000000000000000001', causationId: null, sourceSequence: 0, payload: { toolName: 'read_file', operation: 'read', targetResourceId: null, opaque: false } };
  assert.deepEqual(validateInstance(documents[2].schema.$id, valid, registry), []);
  const mismatched = { ...valid, payload: { requestEventId: 'evt_00000000000000000000000000000001', outcome: 'succeeded', exitCode: 0, effectEventIds: [] } };
  assert.equal(validateInstance(documents[2].schema.$id, mismatched, registry)[0].code, 'PHASE0_SCHEMA_INVALID');
  const wrongType = { ...valid, eventType: 'tool.completed', payload: valid.payload };
  assert.equal(validateInstance(documents[2].schema.$id, wrongType, registry)[0].code, 'PHASE0_SCHEMA_INVALID');
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tools/phase0/schema.test.mjs`
Expected: FAIL — the current envelope `payload` accepts any of the 11 payload defs regardless of `eventType`, so the mismatched and wrongType cases pass validation.

- [x] **Step 3: Add 13 top-level discriminant branches**

In `schemas/phase0/v1/event-envelope.schema.json`, keep the existing top-level `properties.payload` declaration for the common payload shape, then add a top-level `oneOf` whose branches constrain the envelope's sibling `eventType` and `payload` properties. Do not place `eventType` inside the nested payload object. Use this exact structure for all 13 branches:

```json
"oneOf": [
  { "properties": { "eventType": { "const": "tool.requested" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/toolRequested" } } },
  { "properties": { "eventType": { "const": "tool.completed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/toolCompleted" } } },
  { "properties": { "eventType": { "const": "file.read" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/resourceObserved" } } },
  { "properties": { "eventType": { "const": "symbol.read" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/resourceObserved" } } },
  { "properties": { "eventType": { "const": "file.changed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/resourceChanged" } } },
  { "properties": { "eventType": { "const": "symbol.changed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/resourceChanged" } } },
  { "properties": { "eventType": { "const": "task.completed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/taskCompleted" } } },
  { "properties": { "eventType": { "const": "dependency.changed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/dependencyChanged" } } },
  { "properties": { "eventType": { "const": "attribution.corrected" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/attributionCorrected" } } },
  { "properties": { "eventType": { "const": "finding.created" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/findingCreated" } } },
  { "properties": { "eventType": { "const": "decision.created" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/decisionCreated" } } },
  { "properties": { "eventType": { "const": "validity.changed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/validityChanged" } } },
  { "properties": { "eventType": { "const": "decision.delivery.changed" }, "payload": { "$ref": "./event-payloads.schema.json#/$defs/decisionDeliveryChanged" } } }
]
```

The envelope's existing top-level `required` list continues to require `eventType` and `payload`, while the existing top-level `properties` block validates the other envelope fields. The branch schemas intentionally omit `additionalProperties`, so they constrain only the two discriminated sibling properties and do not reject the remaining envelope fields.

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tools/phase0/schema.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full corpus and confirm no regressions**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; `Phase 0 corpus valid`.

- [x] **Step 6: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 4 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 5: Graph Dependency Edge Binding

**Files:**
- Modify: `tools/phase0/lib/domain.mjs` (bind `depends_on` edge dependency to the indexed `dependency.changed` event content; require edge evidence to be present and to relate to the dependency record)
- Create: `fixtures/invalid/v1/dependency-edge-mismatch/manifest.json`, `events.ndjson`
- Modify: `tools/phase0/domain.test.mjs` (edge-binding unit test)
- Modify: `tools/phase0/corpus.test.mjs` (counts and expected-error map)
- Test: `tools/phase0/domain.test.mjs`

**Interfaces:**
- Consumes: the event set (`eventById`), `dependencies` map (keyed by `dependencyId`, built from `dependency.changed` events), and each graph `edges` entry.
- Produces: for every `kind === 'depends_on'` edge, the nested `edge.dependency` must match the canonical content of the `dependency.changed` event whose `dependencyId` equals `edge.dependency.dependencyId`; if no such event exists, emit `PHASE0_REFERENCE_MISSING` at `/graph/edges/<edgeId>/dependency`; if content mismatches, emit `PHASE0_ID_CONFLICT` at the same pointer; if `edge.evidenceEventIds` is empty or shares no element with the dependency record's `evidenceEventIds`, emit `PHASE0_REFERENCE_MISSING` at `/graph/edges/<edgeId>/evidenceEventIds`.

- [x] **Step 1: Write the failing unit test**

Append to `tools/phase0/domain.test.mjs`:

```js
test('a depends_on edge must match the dependency.changed event content and share evidence', () => {
  const dependency = { dependencyId: 'dep_00000000000000000000000000000001', dependentResourceId: `res_${'1'.repeat(64)}`, dependencyResourceId: `res_${'2'.repeat(64)}`, dependentVersion: { resourceId: `res_${'1'.repeat(64)}`, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'1'.repeat(64)}`, evidenceEventIds: [base.eventId] }, dependencyVersion: { resourceId: `res_${'2'.repeat(64)}`, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'2'.repeat(64)}`, evidenceEventIds: [base.eventId] }, observations: [{ kind: 'declared', producer: { sourceId: 'source_analyzer', version: '1' }, rule: null, evidenceEventIds: [base.eventId] }], evidenceEventIds: [base.eventId] };
  const depEvent = { ...structuredClone(base), eventType: 'dependency.changed', payload: { dependency } };
  const changedDependency = { ...structuredClone(dependency), observations: [{ kind: 'statically_observed', producer: { sourceId: 'source_analyzer', version: '1' }, rule: { ruleId: 'rule_dependency', version: '1' }, evidenceEventIds: [base.eventId] }] };
  const graph = { resources: [], nodes: [{ nodeId: 'node_00000000000000000000000000000001', kind: 'resource', entityId: dependency.dependencyResourceId }, { nodeId: 'node_00000000000000000000000000000002', kind: 'resource', entityId: dependency.dependentResourceId }], edges: [{ edgeId: 'edge_00000000000000000000000000000001', kind: 'depends_on', fromNodeId: 'node_00000000000000000000000000000002', toNodeId: 'node_00000000000000000000000000000001', dependency: changedDependency, evidenceEventIds: [base.eventId] }], targetSnapshots: [] };
  const diagnostics = validateScenarioDomain({ directory: 'fixtures/invalid/v1/dependency-edge-mismatch', manifest: { targetPhase: 1 }, events: [{ line: 1, value: depEvent }], expected: { graph, findings: [], decisions: [], validity: [], coverage: [] } });
  const codes = diagnostics.map((item) => item.code);
  assert.ok(codes.includes('PHASE0_ID_CONFLICT'), `expected PHASE0_ID_CONFLICT in ${JSON.stringify(codes)}`);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tools/phase0/domain.test.mjs`
Expected: FAIL — the current `validateScenarioDomain` validates `edge.dependency` internally but does not compare it to the `dependency.changed` event content, so the mismatched `changedDependency` is accepted.

- [x] **Step 3: Add the binding check**

In `tools/phase0/lib/domain.mjs`, after the `dependencies` map is built (`for (const dependency of dependencies.values()) validateDependency(...)`), augment the edge-validation loop. Replace the existing edge loop body at `domain.mjs:182` so that for `kind === 'depends_on'`:

```js
for (const edge of graph.edges) {
  const from = nodes.get(edge.fromNodeId); const to = nodes.get(edge.toNodeId);
  if (!from || !to) { diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}`, 'graph edge endpoint is absent')); continue; }
  const kinds = edgeKinds.get(edge.kind) ?? []; const valid = kinds.some(([a, b]) => from.kind === a && to.kind === b);
  if (!valid) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/graph/edges/${edge.edgeId}`, 'graph edge endpoint kinds are invalid'));
  if ((edge.kind === 'depends_on') !== (edge.dependency !== null)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/graph/edges/${edge.edgeId}/dependency`, 'only dependency edges may carry dependency provenance'));
  if (edge.kind === 'depends_on' && edge.dependency) {
    const eventDependency = dependencies.get(edge.dependency.dependencyId);
    if (!eventDependency) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/dependency`, 'depends_on edge references an absent dependency event'));
    else if (canonicalize(eventDependency) !== canonicalize(edge.dependency)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/graph/edges/${edge.edgeId}/dependency`, 'depends_on edge dependency differs from the dependency.changed event payload'));
   if ((edge.evidenceEventIds ?? []).length === 0) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/evidenceEventIds`, 'dependency edge must carry evidence'));
   else if (eventDependency && !intersects(edge.evidenceEventIds, eventDependency.evidenceEventIds)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/evidenceEventIds`, 'dependency edge evidence must relate to the dependency record evidence'));
  }
  if (edge.dependency) validateDependency(edge.dependency, `/graph/edges/${edge.edgeId}/dependency`, resourceById, eventById, diagnostics);
}
```

Ensure `canonicalize` is imported (it already is at the top of `domain.mjs`). `intersects` is defined locally at `domain.mjs:156`.

- [x] **Step 4: Create the corpus negative fixture**

`fixtures/invalid/v1/dependency-edge-mismatch/manifest.json`:

```json
{"schemaVersion":1,"scenarioId":"scenario_dependency_edge_mismatch","title":"A depends_on edge must match its dependency.changed event","targetPhase":2,"kind":"negative","eventsFile":"events.ndjson","expected":{"graph":"expected-graph.json","findings":"expected-findings.json","decisions":"expected-decisions.json","validity":"expected-validity.json","coverage":"expected-coverage.json"},"variants":[],"expectedError":"PHASE0_ID_CONFLICT"}
```

Create `events.ndjson` with one `dependency.changed` event whose own ID is `evt_...01`; every nested dependency/version/observation evidence list must contain that existing event ID, and the dependency record's `evidenceEventIds` must be `['evt_...01']`. Create `expected-graph.json` with two matching resource records, two resource nodes, and one `depends_on` edge. The edge must use `evidenceEventIds: ['evt_...01']` and the same `dependencyId`, endpoints, and versions as the event, but change the nested observation from the event (for example, use `kind: 'statically_observed'` with a valid `rule` object instead of the event's `kind: 'declared'` and `rule: null`). This keeps all references valid while making canonical dependency content differ and produces `PHASE0_ID_CONFLICT`. Provide minimal `expected-findings.json`, `expected-decisions.json`, `expected-validity.json`, and `expected-coverage.json` as `[]`; empty arrays satisfy their schemas.
Confirm `node tools/phase0/validate.mjs` reports the negative fixture's first diagnostic as `PHASE0_ID_CONFLICT` at `/graph/edges/<edgeId>/dependency`.

Note: because this fixture has `expected` non-null, the validator loads the expected files and runs expected-based domain checks. To keep the failure specifically the dependency-edge mismatch, ensure all other expected projections are schema-valid and reference-existent (empty findings/decisions/validity/coverage satisfy this).

- [x] **Step 5: Update `corpus.test.mjs`**

`negativeFixtures.length` is now `12`. Add `['scenario_dependency_edge_mismatch', 'PHASE0_ID_CONFLICT']` to the `expected` map.

- [x] **Step 6: Run tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; `Phase 0 corpus valid`.

- [x] **Step 7: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 5 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 6: Validity Transition Guards

**Files:**
- Modify: `tools/phase0/lib/domain.mjs` (`validateValidityRecords` strict guards)
- Create: `fixtures/invalid/v1/dependency-impact-without-event/manifest.json`, `events.ndjson`
- Create: `fixtures/invalid/v1/transition-target-mismatch/manifest.json`, `events.ndjson`
- Create: `fixtures/invalid/v1/deterministic-proof-resurrects/manifest.json`, `events.ndjson`
- Modify: `tools/phase0/domain.test.mjs` (unit tests for each guard)
- Modify: `tools/phase0/corpus.test.mjs` (counts and expected-error map)
- Test: `tools/phase0/domain.test.mjs`

**Interfaces:**
- Consumes: the record's `lastTransition`, `validations`, `targetSnapshotId`, and the event set.
- Produces, in `validateValidityRecords`:
  - For `transition.reason === 'dependency_impact'`, require at least one event in `transition.evidenceEventIds` whose `eventType === 'dependency.changed'`; otherwise `PHASE0_TRANSITION_INVALID` at `/validity/<index>/lastTransition` with `'dependency impact evidence must include a dependency.changed event'`.
  - For every transition except `reason === 'target_superseded'`, require `transition.targetSnapshotId === record.targetSnapshotId`; otherwise `PHASE0_TRANSITION_INVALID` at `/validity/<index>/lastTransition` with `'transition target must equal the current record target'`.
  - For `transition.reason === 'deterministic_proof'`, `transition.to` must not be `'valid'` (an obsolete target cannot be made current); otherwise `PHASE0_TRANSITION_INVALID` at `/validity/<index>/lastTransition` with `'deterministic proof cannot make an obsolete target current'`.

`validateValidityRecords` currently receives only the records, not the event set. Extend its signature to `validateValidityRecords(records, eventById = new Map())` so the dependency_impact evidence check can inspect `eventType`. Update both call sites in `validateScenarioDomain` (embedded events and expected records).

- [x] **Step 1: Write the failing unit tests**

Append to `tools/phase0/domain.test.mjs`:

```js
const snapshot = `snapshot_${'1'.repeat(64)}`;
const workProduct = 'work_00000000000000000000000000000001';
const depEvent = { ...structuredClone(base), eventId: 'evt_000000000000000000000000000000aa', eventType: 'dependency.changed', payload: { dependency: { dependencyId: 'dep_00000000000000000000000000000001', dependentResourceId: `res_${'1'.repeat(64)}`, dependencyResourceId: `res_${'2'.repeat(64)}`, dependentVersion: { resourceId: `res_${'1'.repeat(64)}`, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'1'.repeat(64)}`, evidenceEventIds: [base.eventId] }, dependencyVersion: { resourceId: `res_${'2'.repeat(64)}`, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'2'.repeat(64)}`, evidenceEventIds: [base.eventId] }, observations: [{ kind: 'declared', producer: { sourceId: 'source_analyzer', version: '1' }, rule: null, evidenceEventIds: [base.eventId] }], evidenceEventIds: [base.eventId] } } };
const eventById = new Map([['evt_000000000000000000000000000000aa', depEvent]]);

test('dependency_impact transitions require a dependency.changed evidence event', () => {
  const record = { validityId: 'validity_00000000000000000000000000000001', taskId: 'task_a', workProductId: workProduct, executionState: 'completed', validityState: 'possibly_stale', baseRevision: '1'.repeat(40), targetSnapshotId: snapshot, observedDependencies: [], validations: [], coverageIds: [], evidenceEventIds: [base.eventId], lastTransition: { from: 'valid', to: 'possibly_stale', reason: 'dependency_impact', targetSnapshotId: snapshot, evidenceEventIds: [base.eventId] } };
  const diagnostics = validateValidityRecords([record], eventById);
  assert.ok(diagnostics.some((item) => item.code === 'PHASE0_TRANSITION_INVALID' && /dependency.changed/.test(item.message)), JSON.stringify(diagnostics));
});

test('non-superseded transitions must target the current record target', () => {
  const other = `snapshot_${'2'.repeat(64)}`;
  const record = { validityId: 'validity_00000000000000000000000000000002', taskId: 'task_a', workProductId: workProduct, executionState: 'completed', validityState: 'valid', baseRevision: '1'.repeat(40), targetSnapshotId: snapshot, observedDependencies: [], validations: [{ command: 'test', outcome: 'passed', targetSnapshotId: snapshot, resultEventId: base.eventId }], coverageIds: [], evidenceEventIds: [base.eventId], lastTransition: { from: 'revalidating', to: 'valid', reason: 'validation_passed', targetSnapshotId: other, evidenceEventIds: [base.eventId] } };
  const diagnostics = validateValidityRecords([record], eventById);
  assert.ok(diagnostics.some((item) => item.message.includes('transition target must equal')), JSON.stringify(diagnostics));
});

test('a deterministic proof cannot make an obsolete target current', () => {
  const record = { validityId: 'validity_00000000000000000000000000000003', taskId: 'task_a', workProductId: workProduct, executionState: 'completed', validityState: 'valid', baseRevision: '1'.repeat(40), targetSnapshotId: snapshot, observedDependencies: [], validations: [], coverageIds: [], evidenceEventIds: [base.eventId], lastTransition: { from: 'revalidating', to: 'valid', reason: 'deterministic_proof', targetSnapshotId: snapshot, evidenceEventIds: [base.eventId] } };
  const diagnostics = validateValidityRecords([record], eventById);
  assert.ok(diagnostics.some((item) => item.message.includes('deterministic proof cannot make')), JSON.stringify(diagnostics));
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tools/phase0/domain.test.mjs`
Expected: FAIL — the three new tests fail because the guards are not implemented.

- [x] **Step 3: Extend `validateValidityRecords`**

Replace the function body in `tools/phase0/lib/domain.mjs`. The signature becomes `validateValidityRecords(records, eventById = new Map())`. After the existing transition-reason lookup, add three guards immediately following the existing `if (!reasons?.has(...) || record.validityState !== transition.to)` check:

```js
export function validateValidityRecords(records, eventById = new Map()) {
  const diagnostics = []; const outcome = new Map([['validation_started', 'started'], ['validation_passed', 'passed'], ['validation_failed', 'failed'], ['validation_inconclusive', 'inconclusive'], ['validation_interrupted', 'interrupted']]);
  for (const [index, record] of records.entries()) {
    const transition = record.lastTransition;
    if (transition === null) { if (record.validityState !== 'unassessed') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'only unassessed may omit an initial transition')); continue; }
    const reasons = VALIDITY_TRANSITIONS.get(`${transition.from}->${transition.to}`);
    if (!reasons?.has(transition.reason) || record.validityState !== transition.to) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'validity transition or guard is invalid'));
    if (record.validityState !== 'unassessed' && record.executionState !== 'completed') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/executionState`, 'assessed validity requires a completed work product'));
    if (transition.reason !== 'target_superseded' && transition.targetSnapshotId !== record.targetSnapshotId) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'transition target must equal the current record target'));
    if (transition.reason === 'dependency_impact' && !(transition.evidenceEventIds ?? []).some((id) => eventById.get(id)?.eventType === 'dependency.changed')) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'dependency impact evidence must include a dependency.changed event'));
    if (transition.reason === 'deterministic_proof' && transition.to === 'valid') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'deterministic proof cannot make an obsolete target current'));
    const expected = outcome.get(transition.reason);
    if (expected) { const match = record.validations.find((candidate) => candidate.outcome === expected && candidate.targetSnapshotId === record.targetSnapshotId && transition.evidenceEventIds.includes(candidate.resultEventId)); if (!match || transition.targetSnapshotId !== record.targetSnapshotId) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/validations`, 'transition lacks a matching current-target validation result')); }
    else if (transition.reason === 'dependency_impact') { if (record.validityState !== 'possibly_stale') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}`, 'dependency impact must produce possibly_stale')); }
    else if (transition.reason === 'target_superseded') { if (!record.validations.some((candidate) => candidate.targetSnapshotId !== record.targetSnapshotId && transition.evidenceEventIds.includes(candidate.resultEventId))) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/validations`, 'superseded transition requires an obsolete-target result')); }
  }
  return sortDiagnostics(diagnostics);
}
```

At the call sites in `validateScenarioDomain`, pass `eventById`:

```js
diagnostics.push(...validateValidityRecords(embeddedValidity, eventById));
...
diagnostics.push(...validateValidityRecords(expected.validity, eventById));
```

There is also a direct call in `domain.test.mjs:13` (`validateValidityRecords([{...}])`) that does not pass events; the default empty map keeps the existing `dependency_impact` rejection working because the new dependency_impact guard fires (no events ⇒ no dependency.changed ⇒ PHASE0_TRANSITION_INVALID). Confirm that test still asserts the existing reason-*`dependency_impact` failures at `possibly_stale→stale` (the new guard would actually fire first, producing `PHASE0_TRANSITION_INVALID`). The existing test expects only the code `PHASE0_TRANSITION_INVALID` — still satisfied. Re-run it to confirm no assertion text mismatch.

- [x] **Step 4: Create the three negative fixtures**

Each fixture declares `kind: 'negative'`, `expected: null`, and the listed `expectedError`. The events file contains a single `validity.changed` event whose transition violates one guard:

- `dependency-impact-without-event`: `transition.reason === 'dependency_impact'` and `transition.evidenceEventIds` lists an event that is not `dependency.changed`. Set `expectedError: 'PHASE0_TRANSITION_INVALID'`. The corpus entry must have at least one `dependency.changed` event OR none — easiest is no `dependency.changed` event, so the guard fires because no event in the evidence list is of the required type.
- `transition-target-mismatch`: `transition.reason === 'validation_passed'`, `transition.targetSnapshotId` differs from `record.targetSnapshotId`, and the `validations` array contains a matching result for `transition.targetSnapshotId`. Set `expectedError: 'PHASE0_TRANSITION_INVALID'`.
- `deterministic-proof-resurrects`: `transition.reason === 'deterministic_proof'`, `transition.to === 'valid'`. Set `expectedError: 'PHASE0_TRANSITION_INVALID'`.

Mirror the envelope shape of `fixtures/invalid/v1/invalid-transition/events.ndjson` but choose distinct `eventId` and `correlationId` (e.g. `...0000000d`, `...0000000e`, `...0000000f`). Make `record.executionState === 'completed'` and `record.validityState === transition.to` so the only failing reason is the targeted guard.

- [x] **Step 5: Update `corpus.test.mjs`**

`negativeFixtures.length` is now `15`. Add to the `expected` map:

```js
['scenario_dependency_impact_without_event', 'PHASE0_TRANSITION_INVALID'],
['scenario_transition_target_mismatch', 'PHASE0_TRANSITION_INVALID'],
['scenario_deterministic_proof_resurrects', 'PHASE0_TRANSITION_INVALID'],
```

- [x] **Step 6: Run tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; `Phase 0 corpus valid`.

- [x] **Step 7: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 6 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 7: Exact Benchmark Interception Operation Set

**Files:**
- Modify: `tools/phase0/lib/domain.mjs` (`validateBenchmarkDefinitions` asserts the exact three interception operations)
- Modify: `tools/phase0/domain.test.mjs` (mutation test)
- Test: `tools/phase0/domain.test.mjs`

**Interfaces:**
- Consumes: `corpus.benchmarks.workloads`.
- Produces: a `PHASE0_SCHEMA_INVALID` at `/workloads` with `'interception operation set is incomplete'` when the `interception_latency` workloads do not include exactly `{noop_route, small_file_read, opaque_shell}`.

- [x] **Step 1: Write the failing test**

Append to `tools/phase0/domain.test.mjs`:

```js
import { validateBenchmarkDefinitions } from './lib/domain.mjs';

test('benchmark interception operations must be exactly noop_route, small_file_read, and opaque_shell', () => {
  const make = (operations) => ({ schemaVersion: 1, definitionVersion: 'phase0-v1', environmentFields: ['timestamp', 'commit', 'os', 'architecture', 'cpu', 'memoryBytes', 'nodeVersion'], workloads: [
    ...operations.map((operation) => ({ workloadId: `benchmark_interception_${operation}`, kind: 'interception_latency', operation, baseline: 'direct_operation', instrumented: 'gateway_observation', warmupSamples: 10, measuredSamples: 100, metrics: ['baseline_ns', 'instrumented_ns', 'overhead_ns', 'p50_ns', 'p95_ns', 'failures'] })),
    ...[1000, 10000, 100000].map((eventCount) => ({ workloadId: `benchmark_replay_${eventCount}`, kind: 'replay', eventCount, variants: ['canonical', 'duplicates', 'out_of_order'], warmupRuns: 1, measuredRuns: 1, metrics: ['elapsed_ns', 'events_per_second', 'peak_memory_bytes', 'p50_ns', 'p95_ns', 'snapshot_digest', 'failures'] })),
    ...['same_symbol_overlap', 'stale_read_before_write', 'exported_contract_invalidation'].map((detector) => ({ workloadId: `benchmark_detector_${detector}`, kind: 'detector_quality', detector, corpusSource: 'phase2_labeled_scenario_corpus', requiredLabels: ['relevant', 'irrelevant'], findingMatchFields: ['detector', 'subject_resource', 'affected_task', 'evidence_path'], metrics: ['true_positive', 'false_positive', 'true_negative', 'false_negative', 'precision', 'recall'] })),
  ] });
  assert.deepEqual(validateBenchmarkDefinitions(make(['noop_route', 'small_file_read', 'opaque_shell'])), []);
  const diagnostics = validateBenchmarkDefinitions(make(['noop_route', 'noop_route', 'opaque_shell']));
  assert.equal(diagnostics[0].code, 'PHASE0_SCHEMA_INVALID');
  assert.equal(diagnostics[0].pointer, '/workloads');
  assert.match(diagnostics[0].message, /interception operation set/iu);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tools/phase0/domain.test.mjs`
Expected: FAIL — the existing validation only checks `latency.length === 3`, accepting the duplicate `noop_route` operation set.

- [x] **Step 3: Add the interception operation set check**

In `tools/phase0/lib/domain.mjs` `validateBenchmarkDefinitions`, after the existing replay and detector checks, insert:

```js
const operations = latency.map((item) => item.operation).sort();
if (JSON.stringify(operations) !== JSON.stringify(['noop_route', 'opaque_shell', 'small_file_read'].sort())) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/workloads', 'interception operation set is incomplete'));
```

- [x] **Step 4: Run tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; `Phase 0 corpus valid`.

- [x] **Step 5: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 7 files are modified. Do not commit unless explicitly requested.

---

## Task 8: Variant Expected Schema and Secret Scanning

**Files:**
- Modify: `tools/phase0/validate.mjs` (`variants` schema-validates and secret-scans variant expected artifacts; `machineSecrets` covers variant expected outputs)
- Create: `fixtures/invalid/v1/variant-secret-in-expected/manifest.json`, `events.ndjson`, `variant-events.ndjson`, canonical expected files, and a `canonical-variant/` directory containing the variant expected files
- Modify: `tools/phase0/corpus.test.mjs` (counts and expected-error map)
- Test: `tools/phase0/corpus.test.mjs`

**Interfaces:**
- Consumes: the existing `expectedSchemas` and `findSecretDiagnostics` helpers.
- Produces: every variant's expected outputs are validated against the same schemas as the canonical scenario and are secret-scanned; a secret in a variant expected file surfaces `PHASE0_SECRET_PATTERN` at `<scenario>/<variant>/<expected-file>`.

- [x] **Step 1: Write the failing fixture**

Create `fixtures/invalid/v1/variant-secret-in-expected/manifest.json`:

```json
{"schemaVersion":1,"scenarioId":"scenario_variant_secret_in_expected","title":"Variant expected artifacts are secret-scanned","targetPhase":2,"kind":"negative","eventsFile":"events.ndjson","expected":{"graph":"expected-graph.json","findings":"expected-findings.json","decisions":"expected-decisions.json","validity":"expected-validity.json","coverage":"expected-coverage.json"},"variants":[{"name":"canonical-variant","eventsFile":"variant-events.ndjson","equivalentTo":"canonical","expected":{"graph":"canonical-variant/expected-graph.json","findings":"canonical-variant/expected-findings.json","decisions":"canonical-variant/expected-decisions.json","validity":"canonical-variant/expected-validity.json","coverage":"canonical-variant/expected-coverage.json"}}],"expectedError":"PHASE0_SECRET_PATTERN"}
```

`events.ndjson` and `variant-events.ndjson`: the same single `tool.requested` event with the same event ID and content, so `canonicalEventSet` recognizes the variant as equivalent. The main `expected-*.json` files and every file under `canonical-variant/` are schema-valid minimal empty arrays plus a minimal graph. Put the same schema-valid coverage record in both `expected-coverage.json` and `canonical-variant/expected-coverage.json`; its `scope` contains the secret-shaped value:

```json
[{"coverageId":"coverage_00000000000000000000000000000001","scope":"Bearer synthetic-value-for-test","modes":["intercepted"],"evidenceEventIds":["evt_00000000000000000000000000000001"],"gaps":[],"presentation":"sufficient"}]
```

The `scope` value is valid under the coverage schema, but `findSecretDiagnostics` flags its `Bearer ...` value as `PHASE0_SECRET_PATTERN`, without introducing a competing schema or variant-equivalence diagnostic. The corpus assertion must additionally call `validateOneScenario` and assert that diagnostics include `PHASE0_SECRET_PATTERN` whose path contains `/canonical-variant/expected-coverage.json`, proving the variant artifact was scanned rather than relying only on the canonical artifact's matching secret.

- [x] **Step 2: Modify the validator to scan and schema-validate variant expected artifacts**

In `tools/phase0/validate.mjs`, extract a helper for schema-validating and secret-scanning an `expected` bundle against a path prefix:

```js
function expectedBundleSchemas(expected, basePath, registry) {
  const diagnostics = [...validateInstance(schemaId('graph'), expected.graph, registry, `${basePath}/graph`)];
  for (const [name, schema] of [['findings', 'finding'], ['decisions', 'decision'], ['validity', 'task-validity'], ['coverage', 'coverage']]) for (const [index, value] of expected[name].entries()) diagnostics.push(...validateInstance(schemaId(schema), value, registry, `${basePath}/${name}.json#/${index}`));
  return diagnostics;
}

function expectedBundleSecrets(expected, basePath) {
  const diagnostics = [];
  for (const [name, value] of Object.entries(expected)) diagnostics.push(...findSecretDiagnostics(value, `${basePath}/expected-${name}.json`));
  return diagnostics;
}
```

Refactor `expectedSchemas` to call `expectedBundleSchemas(scenario.expected, `${scenario.directory}/expected`, registry)` and `machineSecrets` to call `expectedBundleSecrets(scenario.expected, `${scenario.directory}`)` for the main scenario. In `variants`, after the equivalence check, add for each variant:

```js
diagnostics.push(...expectedBundleSchemas(variant.expected, `${scenario.directory}/${variant.name}/expected`, registry));
diagnostics.push(...expectedBundleSecrets(variant.expected, `${scenario.directory}/${variant.name}`));
```

The manifest paths above are relative to the scenario directory because `loadScenario` resolves variant expected files with `safeChild(root, directory, variant.expected.<name>, ...)`; do not invent a second variant directory in the loader. Then construct the bundle comparison for `variants()` using the existing `canonicalize` call; Task 9 replaces only that comparison with `canonicalSnapshot`.

- [x] **Step 3: Update `corpus.test.mjs`**

`negativeFixtures.length` is now `16`. Add `['scenario_variant_secret_in_expected', 'PHASE0_SECRET_PATTERN']` to the `expected` map. Export `validateOneScenario` from `tools/phase0/validate.mjs`, add it to the corpus-test import, and append this focused assertion:

```js
test('variant expected artifacts are secret-scanned', async () => {
  const corpus = await loadPhase0Corpus(root);
  const fixture = corpus.negativeFixtures.find(({ manifest }) => manifest.scenarioId === 'scenario_variant_secret_in_expected');
  const diagnostics = validateOneScenario(fixture, corpus.registry);
  assert.ok(diagnostics.some((item) => item.code === 'PHASE0_SECRET_PATTERN' && item.path.endsWith('/canonical-variant/expected-coverage.json')));
});
```

- [x] **Step 4: Run tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; `Phase 0 corpus valid`.

- [x] **Step 5: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 8 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 9: Canonical Projection Ordering

**Files:**
- Modify: `tools/phase0/validate.mjs` (`variants` bundle comparison uses `canonicalSnapshot`)
- Modify: `tools/phase0/domain.test.mjs` (snapshot ordering test)
- Test: `tools/phase0/domain.test.mjs`

**Interfaces:**
- Consumes: `canonicalSnapshot` from `./lib/domain.mjs` (already exported).
- Produces: variant bundle comparison digests the canonical-sorted bundle, so a variant whose projections list resources, nodes, edges, findings, decisions, validity, or coverage in a different order than the canonical scenario is treated as equivalent when the underlying sets are equal.

- [x] **Step 1: Write the failing test**

Append to `tools/phase0/domain.test.mjs`:

```js
test('canonicalSnapshot orders stable-ID arrays so variant bundles compare by set', () => {
  const bundleA = { graph: { resources: [{ resourceId: 'res_a' }, { resourceId: 'res_b' }], nodes: [], edges: [], targetSnapshots: [] }, findings: [{ findingId: 'finding_b' }, { findingId: 'finding_a' }], decisions: [], validity: [], coverage: [] };
  const bundleB = { graph: { resources: [{ resourceId: 'res_b' }, { resourceId: 'res_a' }], nodes: [], edges: [], targetSnapshots: [] }, findings: [{ findingId: 'finding_a' }, { findingId: 'finding_b' }], decisions: [], validity: [], coverage: [] };
  assert.equal(canonicalize(canonicalSnapshot(bundleA)), canonicalize(canonicalSnapshot(bundleB)));
  assert.notEqual(canonicalize(bundleA), canonicalize(bundleB));
});
```

`canonicalSnapshot` is already imported at the top of `domain.test.mjs`. `canonicalize` is already imported.

- [x] **Step 2: Run the test to verify it fails (or passes for the snapshot alone)**

Run: `node --test tools/phase0/domain.test.mjs`
Expected: this assertion passes because `canonicalSnapshot` already sorts stable-ID arrays. The test documents the property the validator must rely on in Step 3. (If it passes, proceed; the failing case is the validator comparison, fixed in Step 3.)

- [x] **Step 3: Use `canonicalSnapshot` for variant bundle comparison**

In `tools/phase0/validate.mjs` `variants`, replace the existing bundle construction:

```js
const bundle = canonicalize(canonicalSnapshot({ graph: scenario.expected?.graph, findings: scenario.expected?.findings, decisions: scenario.expected?.decisions, validity: scenario.expected?.validity, coverage: scenario.expected?.coverage }));
const variantBundle = canonicalize(canonicalSnapshot({ graph: variant.expected.graph, findings: variant.expected.findings, decisions: variant.expected.decisions, validity: variant.expected.validity, coverage: variant.expected.coverage }));
if (variantBundle !== bundle) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/variants/${variant.name}/equivalentTo`, 'variant expected snapshot differs from canonical'));
```

Import `canonicalSnapshot` from `./lib/domain.mjs` in `validate.mjs`.

- [x] **Step 4: Add a positive variant ordering test via the corpus**

Create `fixtures/scenarios/v1/duplicate-and-out-of-order/out-of-order/expected-graph.json` as a byte-for-byte copy of the canonical `expected-graph.json`, except reverse the two entries in its `nodes` array. Update only the `out-of-order` variant's manifest entry to use `"graph":"out-of-order/expected-graph.json"`; keep its findings, decisions, validity, and coverage paths unchanged. The underlying graph set is identical while its stable-ID array order differs, so the corpus validator must accept the variant after the `canonicalSnapshot` comparison is wired.

- [x] **Step 5: Run tests and the validator**

Run: `node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs`
Run: `node tools/phase0/validate.mjs`
Expected: all pass; `Phase 0 corpus valid`.

- [x] **Step 6: Review the task diff**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only Task 9 files are modified or untracked. Do not commit unless explicitly requested.

---

## Task 10: Completion Verification and Reconciliation

**Files:**
- Modify: `docs/superpowers/plans/2026-08-06-phase-0-foundation.md` (add a repair reconciliation line)
- Verify: `docs/ROADMAP.md` (keep `Status: Complete`; no scope change)
- Test: full Node suite, validator, negative-fixture assertions, hygiene checks, `git diff --check`.

**Interfaces:**
- Consumes: the foundation plan's checklist and `docs/ROADMAP.md` Phase 0 status line.
- Produces: a verified worktree where every automated check passes, the foundation plan records the repair completion, and the roadmap status remains `Complete — contract corpus and exit evidence verified`.

- [x] **Step 1: Run the complete Node test suite**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
```

Expected: all tests pass with no failures, skips, or todos.

- [x] **Step 2: Run the Phase 0 validator**

Run: `node tools/phase0/validate.mjs`
Expected: `Phase 0 corpus valid` and exit `0`.

- [x] **Step 3: Direct negative-fixture assertions for every declared error**

Use the `validateOneScenario` export added in Task 8, then append a corpus test in `tools/phase0/corpus.test.mjs` that validates each negative fixture directly. Do not use `validatePhase0Corpus` for this assertion: that function intentionally suppresses a negative fixture's expected diagnostics and emits only its aggregate mismatch diagnostic.

Change the corpus-test import to:

```js
import { loadPhase0Corpus, validateOneScenario, validatePhase0Corpus } from './validate.mjs';
```

```js
test('every negative fixture produces its declared primary error as the first diagnostic', async () => {
  const corpus = await loadPhase0Corpus(root);
  for (const fixture of corpus.negativeFixtures) {
    const diagnostics = validateOneScenario(fixture, corpus.registry);
    assert.ok(diagnostics.length > 0, `${fixture.directory} produced no diagnostics`);
    const expectedError = fixture.manifest.expectedError ?? 'PHASE0_SCHEMA_INVALID';
    assert.equal(diagnostics[0].code, expectedError, `${fixture.directory} first diagnostic ${diagnostics[0].code} did not match declared ${expectedError}`);
  }
});
```

Fixtures whose manifest intentionally omits `expectedError` use the same
`PHASE0_SCHEMA_INVALID` fallback as the corpus validator.

Run the suite again; expect pass. The direct per-fixture call avoids an O(n²) whole-corpus revalidation and tests the same diagnostic ordering used by the negative-fixture aggregate check.

- [x] **Step 4: JSON parsing, local-link, placeholder, and Phase 1 boundary checks**

Run the hygiene script from the foundation plan Task 12 Step 3 (lines 5997–6025 of `docs/superpowers/plans/2026-08-06-phase-0-foundation.md`):

```powershell
$jsonFiles = Get-ChildItem -Recurse -File schemas\phase0,fixtures,benchmarks\phase0 -Filter '*.json'
foreach ($file in $jsonFiles) { Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json | Out-Null }
$missingLinks = @()
$markdownFiles = Get-ChildItem -Recurse -File README.md,docs -Filter '*.md'
$repositoryRoot = (Get-Location).Path
foreach ($file in $markdownFiles) {
  $content = Get-Content -Raw -LiteralPath $file.FullName
  foreach ($match in [regex]::Matches($content, '\[[^\]]+\]\((?!https?://|#)([^)#]+)(?:#[^)]+)?\)')) {
    $link = $match.Groups[1].Value
    $linkPath = $link.Replace('/', [IO.Path]::DirectorySeparatorChar)
    if ($link -match '^(?:docs|schemas|fixtures|benchmarks|tools)(?:/|\\)|^README\.md$') {
      $target = Join-Path $repositoryRoot $linkPath
    } else {
      $target = Join-Path $file.DirectoryName $linkPath
      if (-not (Test-Path -LiteralPath $target) -and $link -match '^(?:protocol/|THREAT_MODEL\.md$|(?:ROADMAP|VISION|ARCHITECTURE|LIFECYCLE|TERMINOLOGY|AGENTS)\.md$)') {
        $target = Join-Path $repositoryRoot (Join-Path 'docs' $linkPath)
      }
    }
    if (-not (Test-Path -LiteralPath $target)) { $missingLinks += "$($file.FullName): $target" }
  }
}
if ($missingLinks.Count -gt 0) { $missingLinks; throw 'missing local Markdown links' }
$placeholderPattern = 'T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details'
$placeholderPaths = @('docs\protocol', 'docs\THREAT_MODEL.md', 'schemas\phase0', 'fixtures', 'benchmarks\phase0', 'tools\phase0')
$placeholderMatches = @(Get-ChildItem -Recurse -File $placeholderPaths | Select-String -Pattern $placeholderPattern)
if ($placeholderMatches.Count -gt 0) { $placeholderMatches; throw 'placeholder text remains' }
$forbiddenRuntimePaths = @(git ls-files -- 'package.json' 'pnpm-workspace.yaml' 'apps/**' 'packages/**')
if ($forbiddenRuntimePaths.Count -gt 0) { $forbiddenRuntimePaths; throw 'Phase 1 runtime surface was introduced' }
```

Expected: every JSON document parses, every local Markdown link resolves, the placeholder scan has no match, no tracked Phase 1 runtime file exists, and the script exits `0`. Existing empty `apps/` and `packages/` directories do not fail this check.

- [x] **Step 5: `git diff --check` and worktree review**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD
```

Expected: no whitespace errors; only the repair-affected files are listed.

- [x] **Step 6: Update the foundation plan reconciliation**

In `docs/superpowers/plans/2026-08-06-phase-0-foundation.md`, Task 12 Step 5 (line 6044), the ROADMAP already reads `**Status:** Complete — contract corpus and exit evidence verified.` Append a reconciliation note after the `Approved-Spec Traceability` section:

```markdown
## Repair Reconciliation (2026-08-07)

The Phase 0 validator repair plan at
`docs/superpowers/plans/2026-08-07-phase-0-validator-repair.md` strengthened the
manifest, dependency-edge, validity, decision-target, event-payload, benchmark,
secret-scan, and canonical-ordering invariants. After the repair, the Node test
suite and `node tools/phase0/validate.mjs` both pass, `git diff --check` is clean,
and the Phase 0 status line above remains `Complete — contract corpus and exit
evidence verified.` No commit was created unless explicitly requested.
```

Do not edit any other foundation-plan checklist lines retroactively; the repair's own plan tracks its tasks.

- [x] **Step 7: Confirm the Phase 0 roadmap status**

Run: `rg -n "^## Phase 0" docs/ROADMAP.md -A 2`
Expected: the `**Status:** Complete — contract corpus and exit evidence verified.` line is unchanged.

- [x] **Step 8: Final branch review**

Run:

```powershell
git status --short --branch
git log --oneline -15
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: every automated check passes, `git diff --check` is clean, and the working tree contains only intended repair changes. Do not require a clean tree or any commits; the global constraint is to leave changes uncommitted unless explicitly requested.

---

## Approved-Spec Traceability

| Approved design requirement | Implementing task |
| --- | --- |
| Reject positive scenarios without declared expected projections (Goal 1) | Task 1 |
| Bind graph dependency edges to the exact dependency event (`dependency.changed`) and require edge evidence (Goal 2) | Task 5 |
| Evidence-backed `dependency_impact`, current-target guards excluding `target_superseded`, deterministic-proof cannot resurrect (Goal 3) | Task 6 |
| Nullable decision/delivery targets with empty-target rejection (Goal 4) | Task 3 |
| Discriminated event envelope payload branches; defense-in-depth event map retained (Goal 5) | Task 4 |
| Exact interception operation set in benchmark validation (Goal 6) | Task 7 |
| `CorpusContractError` handled at entry as `PHASE0_*` exit code `1` with sanitized paths (Goal 7) | Task 2 |
| Canonical snapshot ordering for Projection bundles and variant comparison (Goal 8) | Task 9 |
| Secret-scan every loaded fixture artifact including variant expected outputs (Goal 8) | Task 8 |
| Regression tests and negative fixtures for every repaired invariant (Goal 9) | Tasks 1, 3, 5, 6, 7, 8 |
| Phase 0 verification process complete before retaining roadmap completion marker (Goal 10) | Task 10 |

## Final Fix Wave (2026-08-08)

The final whole-branch review identified three additional Important validator
gaps. The corpus now contains 19 negative fixtures, including:

| Final finding | Implementing files |
| --- | --- |
| Bind `depends_on` node entity IDs to the dependency endpoint IDs | `tools/phase0/lib/domain.mjs`, `tools/phase0/domain.test.mjs`, `fixtures/invalid/v1/dependency-endpoint-mismatch/` |
| Reject delivery targets whose agent and task IDs are both null without an expected projection | `tools/phase0/lib/domain.mjs`, `tools/phase0/domain.test.mjs`, `fixtures/invalid/v1/empty-delivery-target/` |
| Keep schema-invalid canonical events out of domain/variant validation and return contract diagnostics | `tools/phase0/validate.mjs`, `tools/phase0/corpus.test.mjs`, `fixtures/invalid/v1/malformed-event/` |

The corpus count and expected-error map in `tools/phase0/corpus.test.mjs` track
all three fixtures. No commit was created.

## M0 Gate Reconciliation (2026-08-08)

The Phase 0 validator repair now satisfies the Phase 1 M0 prerequisite gate. The
corpus validator, complete Node test suite, fixture expectations, redaction and
secret checks, JSON and Markdown hygiene checks, placeholder scan, and Phase 1
runtime boundary check are recorded in
`docs/PHASE_0_M0_EVIDENCE.md`. The M0 evidence is verified from the committed
repository tree; Phase 1 runtime work remains out of scope.

The repair work was intentionally left uncommitted until the user explicitly
authorized the M0 completion commit. That authorization has now been given.

## Non-Goals

Per the approved spec:

- No Phase 1 TypeScript/pnpm workspace.
- No runtime adapter, gateway, daemon, SQLite store, projection engine, or CLI.
- No new coordination behavior or Phase 4 enforcement semantics.
- No broad rewrite of the existing validator architecture.
- No repair commit was made before the explicit M0 completion authorization.
