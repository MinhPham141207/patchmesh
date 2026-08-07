# PatchMesh Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the roadmap's Phase 0 as a language-neutral, mechanically validated corpus of protocol contracts, security rules, golden scenarios, and benchmark definitions without pulling Phase 1 runtime work forward.

**Architecture:** Normative Markdown defines semantics, JSON Schema Draft 2020-12 files define data shapes, and JSON/NDJSON fixtures define replayable examples. A dependency-free Node validator checks the declared schema subset, cross-file invariants, negative fixtures, redaction, and scenario completeness; it does not implement PatchMesh runtime behavior.

**Tech Stack:** Markdown, JSON Schema Draft 2020-12 subset, JSON, NDJSON, Node.js 24 built-ins, `node:test`, PowerShell, Git

---

## Execution Preconditions

- Execute this plan from an isolated worktree created with
  `superpowers:using-git-worktrees`.
- Read `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`,
  `docs/TERMINOLOGY.md`, `docs/LIFECYCLE.md`, and `docs/AGENTS.md` before editing.
- Treat `docs/ROADMAP.md` as the phase authority and
  `docs/superpowers/specs/2026-08-06-phase-0-foundation-design.md` as the approved
  design authority.
- Do not add a root `package.json`, `pnpm-workspace.yaml`, `packages/`, `apps/`, a
  database, an adapter, a daemon, or product CLI code.
- Run `knowl_query` with the focused subject before each task area as required by the
  repository memory workflow. Verified host hooks own lifecycle; do not start a
  manual Knowl task loop.

## File Responsibility Map

### Normative protocol and security documents

- Create: `docs/protocol/identities.md` — identity derivation, equality, path
  normalization, integration-target snapshots, and resource-version roles.
- Create: `docs/protocol/events.md` — event envelope v1, payload discrimination,
  causality, source ordering, idempotency, and attribution correction.
- Create: `docs/protocol/coordination.md` — findings, decisions, action/directive
  capability matrix, and replay-safe delivery state.
- Create: `docs/protocol/validity.md` — independent task execution and work-product
  validity projections with transition guards.
- Create: `docs/protocol/evidence-and-coverage.md` — dependency provenance,
  observation evidence, gap propagation, and degraded behavior.
- Create: `docs/protocol/replay-equivalence.md` — canonical snapshots and equivalence
  rules for incremental, cold, duplicate, and out-of-order processing.
- Create: `docs/THREAT_MODEL.md` — local identity, event integrity, path, redaction,
  trust-boundary, mitigation, residual-risk, and fixture mapping.

### Versioned data contracts

- Create: `schemas/phase0/v1/identities.schema.json` — IDs, version domains, target
  snapshots, logical resources, and resource versions.
- Create: `schemas/phase0/v1/event-envelope.schema.json` — closed v1 event envelope.
- Create: `schemas/phase0/v1/event-payloads.schema.json` — payloads used by the Phase
  0 scenario corpus.
- Create: `schemas/phase0/v1/dependency.schema.json` — versioned dependency evidence
  with structured provenance observations.
- Create: `schemas/phase0/v1/graph.schema.json` — canonical graph snapshot.
- Create: `schemas/phase0/v1/finding.schema.json` — deterministic finding records.
- Create: `schemas/phase0/v1/decision.schema.json` — decision and delivery records.
- Create: `schemas/phase0/v1/task-validity.schema.json` — work-product validity
  records and transition evidence.
- Create: `schemas/phase0/v1/coverage.schema.json` — observation coverage and gaps.
- Create: `schemas/phase0/v1/scenario-manifest.schema.json` — scenario inputs,
  expected outputs, variants, target phase, and expected failure.
- Create: `schemas/phase0/v1/benchmark-workloads.schema.json` — benchmark definition
  metadata and workload shapes.

### Golden and negative fixtures

- Create corpus under: `fixtures/scenarios/v1/relevant-exported-contract/` — relevant candidate
  signature-change scenario and all expected projections.
- Create corpus under: `fixtures/scenarios/v1/irrelevant-concurrent-change/` — irrelevant change
  control scenario and all expected projections.
- Create corpus under: `fixtures/scenarios/v1/opaque-shell-degraded/` — intercepted request,
  post-effect verification, and explicit coverage gap.
- Create corpus under: `fixtures/scenarios/v1/late-attribution/` — nullable attribution followed
  by immutable correction.
- Create corpus under: `fixtures/scenarios/v1/duplicate-and-out-of-order/` — canonical,
  duplicate, and valid out-of-order variants.
- Create corpus under: `fixtures/scenarios/v1/conflicting-duplicate-id/` — deterministic
  integrity failure before projection.
- Create corpus under: `fixtures/invalid/v1/` — path, domain, transition, coverage, schema,
  reference, and synthetic-secret negative fixtures.

### Validator and tests

- Create: `tools/phase0/validate.mjs` — repository validator entry point.
- Create: `tools/phase0/lib/diagnostics.mjs` — stable diagnostics, sorting, and exit
  codes.
- Create: `tools/phase0/lib/canonical-json.mjs` — canonical JSON and SHA-256 digest.
- Create: `tools/phase0/lib/schema.mjs` — supported JSON Schema subset and local
  `$ref` resolution.
- Create: `tools/phase0/lib/corpus.mjs` — artifact discovery and JSON/NDJSON loading.
- Create: `tools/phase0/lib/domain.mjs` — identity, event, state, phase, coverage, and
  equivalence invariants.
- Create: `tools/phase0/lib/secrets.mjs` — prohibited key/value detection and
  diagnostic redaction.
- Create: `tools/phase0/diagnostics.test.mjs` — diagnostic and canonicalization unit
  tests.
- Create: `tools/phase0/schema.test.mjs` — schema-subset and `$ref` unit tests.
- Create: `tools/phase0/domain.test.mjs` — domain-invariant unit tests.
- Create: `tools/phase0/corpus.test.mjs` — positive/negative corpus integration tests.

### Benchmarks and canonical documentation

- Create: `benchmarks/phase0/README.md` — measurement protocols and result-record
  requirements.
- Create: `benchmarks/phase0/workloads.json` — versioned interception, replay, and
  detector-quality workload definitions.
- Modify: `docs/TERMINOLOGY.md` — canonical identity, version, validity, action,
  directive, provenance, and coverage terms.
- Modify: `docs/ARCHITECTURE.md` — link normative contracts and remove duplicate or
  conflicting field lists.
- Modify: `docs/LIFECYCLE.md` — separate execution/validity and align event/delivery
  state.
- Modify: `docs/ROADMAP.md` — link Phase 0 evidence without changing phase scope.
- Modify: `docs/AGENTS.md` — require the contracts and validator for future protocol
  changes.
- Modify: `docs/CLI.md` — keep examples illustrative and align nullable attribution
  and target-relative terminology.
- Modify: `README.md` — link the Phase 0 corpus while preserving planned status.

## Stable Test Commands

Use these exact commands throughout the plan:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

The first command must report all tests passing. The second must print
`Phase 0 corpus valid` and exit `0`. The third must produce no output.

### Task 1: Build deterministic validator primitives

**Files:**
- Create: `tools/phase0/diagnostics.test.mjs`
- Create: `tools/phase0/lib/diagnostics.mjs`
- Create: `tools/phase0/lib/canonical-json.mjs`
- Create: `tools/phase0/validate.mjs`

- [ ] **Step 1: Write the failing diagnostics and canonical JSON tests**

Create `tools/phase0/diagnostics.test.mjs` with:

```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalDigest, canonicalize } from './lib/canonical-json.mjs';
import {
  EXIT_CONTRACT_INVALID,
  EXIT_OK,
  EXIT_TOOL_FAILURE,
  diagnostic,
  formatDiagnostics,
  sortDiagnostics,
} from './lib/diagnostics.mjs';

test('canonicalize sorts object keys recursively and preserves array order', () => {
  assert.equal(
    canonicalize({ z: 1, a: { y: true, b: ['second', 'first'] } }),
    '{"a":{"b":["second","first"],"y":true},"z":1}',
  );
});

test('canonicalDigest is stable for objects with different insertion order', () => {
  assert.equal(canonicalDigest({ b: 2, a: 1 }), canonicalDigest({ a: 1, b: 2 }));
});

test('canonicalize rejects non-JSON numbers', () => {
  assert.throws(() => canonicalize({ bad: Number.NaN }), /finite JSON number/);
});

test('diagnostics sort by path, pointer, and code and never include a rejected value', () => {
  const diagnostics = sortDiagnostics([
    diagnostic('PHASE0_ID_CONFLICT', 'z.json', '/eventId', 'conflicting event ID'),
    diagnostic('PHASE0_SCHEMA_INVALID', 'a.json', '/payload', 'invalid payload'),
    diagnostic('PHASE0_REFERENCE_MISSING', 'a.json', '/causationId', 'missing event'),
  ]);

  assert.deepEqual(
    diagnostics.map(({ code }) => code),
    ['PHASE0_REFERENCE_MISSING', 'PHASE0_SCHEMA_INVALID', 'PHASE0_ID_CONFLICT'],
  );
  assert.equal(
    formatDiagnostics(diagnostics),
    [
      'PHASE0_REFERENCE_MISSING a.json/causationId: missing event',
      'PHASE0_SCHEMA_INVALID a.json/payload: invalid payload',
      'PHASE0_ID_CONFLICT z.json/eventId: conflicting event ID',
    ].join('\n'),
  );
});

test('validator exit codes are stable', () => {
  assert.deepEqual(
    { EXIT_OK, EXIT_CONTRACT_INVALID, EXIT_TOOL_FAILURE },
    { EXIT_OK: 0, EXIT_CONTRACT_INVALID: 1, EXIT_TOOL_FAILURE: 2 },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails for the missing modules**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`tools/phase0/lib/canonical-json.mjs` or `diagnostics.mjs`.

- [ ] **Step 3: Implement canonical JSON and diagnostics**

Create `tools/phase0/lib/canonical-json.mjs` with:

```javascript
import { createHash } from 'node:crypto';

function encode(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON requires a finite JSON number');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(encode).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(value[key])}`);
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalize(value) {
  return encode(value);
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
```

Create `tools/phase0/lib/diagnostics.mjs` with:

```javascript
export const EXIT_OK = 0;
export const EXIT_CONTRACT_INVALID = 1;
export const EXIT_TOOL_FAILURE = 2;

export function diagnostic(code, path, pointer, message) {
  return Object.freeze({ code, path, pointer, message });
}

export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.pointer.localeCompare(right.pointer)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));
}

export function formatDiagnostics(diagnostics) {
  return sortDiagnostics(diagnostics)
    .map(({ code, path, pointer, message }) => `${code} ${path}${pointer}: ${message}`)
    .join('\n');
}
```

Create `tools/phase0/validate.mjs` with this initial entry point:

```javascript
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  EXIT_OK,
  EXIT_TOOL_FAILURE,
  formatDiagnostics,
} from './lib/diagnostics.mjs';

export function parseArgs(args) {
  if (args.length === 0) return { root: process.cwd() };
  if (args.length === 2 && args[0] === '--root') return { root: args[1] };
  throw new Error('usage: node tools/phase0/validate.mjs [--root <path>]');
}

export async function validateRepository() {
  return [];
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { root } = parseArgs(args);
    const diagnostics = await validateRepository(root);
    if (diagnostics.length > 0) {
      process.stderr.write(`${formatDiagnostics(diagnostics)}\n`);
      return 1;
    }
    process.stdout.write('Phase 0 corpus valid\n');
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`PHASE0_VALIDATOR_FAILURE: ${error.message}\n`);
    return EXIT_TOOL_FAILURE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
```

- [ ] **Step 4: Run the primitive tests and smoke-test the entry point**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs
node tools/phase0/validate.mjs
```

Expected: five tests pass, then the entry point prints `Phase 0 corpus valid` and
exits `0`.

- [ ] **Step 5: Commit the validator primitives**

```powershell
git add tools/phase0/diagnostics.test.mjs tools/phase0/lib/diagnostics.mjs tools/phase0/lib/canonical-json.mjs tools/phase0/validate.mjs
git commit -m "test: establish phase 0 validator primitives"
```

### Task 2: Implement the declared JSON Schema subset

**Files:**
- Create: `tools/phase0/schema.test.mjs`
- Create: `tools/phase0/lib/schema.mjs`
- Modify: `tools/phase0/validate.mjs`

- [ ] **Step 1: Write failing tests for schema validation and local references**

Create `tools/phase0/schema.test.mjs` with:

```javascript
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalDigest } from './lib/canonical-json.mjs';
import { CorpusContractError, safeChild } from './lib/corpus.mjs';
import {
  createSchemaRegistry,
  validateInstance,
  validateSchemaDocuments,
} from './lib/schema.mjs';

const identitySchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://patchmesh.dev/schemas/test/identity.schema.json',
  $defs: {
    id: { type: 'string', pattern: '^id_[a-z]+$' },
  },
  type: 'object',
  properties: {
    id: { $ref: '#/$defs/id' },
    state: { enum: ['ready', 'done'] },
  },
  required: ['id', 'state'],
  additionalProperties: false,
};

test('validates the supported object, local ref, pattern, and enum keywords', () => {
  const registry = createSchemaRegistry([
    { path: 'identity.schema.json', schema: identitySchema },
  ]);
  assert.deepEqual(validateSchemaDocuments(registry), []);
  assert.deepEqual(
    validateInstance(identitySchema.$id, { id: 'id_alpha', state: 'ready' }, registry),
    [],
  );
});

test('reports required, additional-property, pattern, and enum violations', () => {
  const registry = createSchemaRegistry([
    { path: 'identity.schema.json', schema: identitySchema },
  ]);
  const diagnostics = validateInstance(
    identitySchema.$id,
    { id: 'wrong', state: 'unknown', extra: true },
    registry,
    'fixture.json',
  );
  assert.deepEqual(
    diagnostics.map(({ code, pointer }) => [code, pointer]),
    [
      ['PHASE0_SCHEMA_INVALID', '/extra'],
      ['PHASE0_SCHEMA_INVALID', '/id'],
      ['PHASE0_SCHEMA_INVALID', '/state'],
    ],
  );
});

test('rejects an unsupported schema keyword', () => {
  const schema = { ...identitySchema, title: 'not in the Phase 0 subset' };
  const registry = createSchemaRegistry([{ path: 'bad.schema.json', schema }]);
  assert.equal(
    validateSchemaDocuments(registry)[0].code,
    'PHASE0_SCHEMA_KEYWORD_UNSUPPORTED',
  );
});

test('rejects missing and escaping refs', () => {
  const missing = {
    $schema: identitySchema.$schema,
    $id: 'https://patchmesh.dev/schemas/test/missing.schema.json',
    $ref: './absent.schema.json',
  };
  const escaping = {
    $schema: identitySchema.$schema,
    $id: 'https://patchmesh.dev/schemas/test/escaping.schema.json',
    $ref: '../../../outside.schema.json',
  };
  const registry = createSchemaRegistry([
    { path: 'missing.schema.json', schema: missing },
    { path: 'escaping.schema.json', schema: escaping },
  ]);
  assert.deepEqual(
    validateSchemaDocuments(registry).map(({ code }) => code),
    ['PHASE0_REFERENCE_MISSING', 'PHASE0_REFERENCE_MISSING'],
  );
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```powershell
node --test tools/phase0/schema.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/phase0/lib/schema.mjs`.

- [ ] **Step 3: Implement the schema registry and validator**

Create `tools/phase0/lib/schema.mjs` with the implementation below. It uses this exact
registry shape:

```javascript
{
  byId: Map<string, { path: string, schema: object }>,
  documents: Array<{ path: string, schema: object }>
}
```

```javascript
import { canonicalize } from './canonical-json.mjs';
import { diagnostic, sortDiagnostics } from './diagnostics.mjs';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'uniqueItems', 'enum', 'const',
  'oneOf', 'format', 'pattern', 'minimum',
]);

function pointerSegment(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function schemaChildren(schema) {
  const children = [];
  for (const keyword of ['$defs', 'properties']) {
    if (schema[keyword] && typeof schema[keyword] === 'object') {
      for (const key of Object.keys(schema[keyword]).sort()) {
        children.push([`${keyword}/${pointerSegment(key)}`, schema[keyword][key]]);
      }
    }
  }
  if (schema.items && typeof schema.items === 'object') children.push(['items', schema.items]);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    children.push(['additionalProperties', schema.additionalProperties]);
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((child, index) => children.push([`oneOf/${index}`, child]));
  }
  return children;
}

function resolvePointer(value, fragment) {
  if (fragment === '' || fragment === '#') return value;
  if (!fragment.startsWith('#/')) return undefined;
  return fragment.slice(2).split('/').reduce((current, encoded) => {
    if (current === undefined || current === null) return undefined;
    const key = decodeURIComponent(encoded).replaceAll('~1', '/').replaceAll('~0', '~');
    return current[key];
  }, value);
}

function resolveRef(ref, currentId, registry) {
  const url = new URL(ref, currentId);
  const fragment = url.hash;
  url.hash = '';
  const document = registry.byId.get(url.href);
  if (!document) return undefined;
  const schema = resolvePointer(document.schema, fragment);
  if (!schema || typeof schema !== 'object') return undefined;
  return { id: `${url.href}${fragment}`, document, schema };
}

export function createSchemaRegistry(documents) {
  const byId = new Map();
  for (const document of documents) {
    if (document.schema && typeof document.schema.$id === 'string' && !byId.has(document.schema.$id)) {
      byId.set(document.schema.$id, document);
    }
  }
  return { byId, documents: [...documents] };
}

export function validateSchemaDocuments(registry) {
  const diagnostics = [];
  const ids = new Map();

  function inspect(schema, document, pointer, currentId, refStack) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      diagnostics.push(diagnostic(
        'PHASE0_SCHEMA_INVALID', document.path, pointer, 'schema node must be an object',
      ));
      return;
    }
    for (const keyword of Object.keys(schema).sort()) {
      if (!SUPPORTED.has(keyword)) {
        diagnostics.push(diagnostic(
          'PHASE0_SCHEMA_KEYWORD_UNSUPPORTED',
          document.path,
          `${pointer}/${pointerSegment(keyword)}`,
          'schema keyword is outside the Phase 0 subset',
        ));
      }
    }
    if (typeof schema.$ref === 'string') {
      const resolved = resolveRef(schema.$ref, currentId, registry);
      if (!resolved) {
        diagnostics.push(diagnostic(
          'PHASE0_REFERENCE_MISSING', document.path, `${pointer}/$ref`, 'schema reference does not resolve',
        ));
      } else if (refStack.has(resolved.id)) {
        diagnostics.push(diagnostic(
          'PHASE0_REFERENCE_MISSING', document.path, `${pointer}/$ref`, 'cyclic schema reference is unsupported',
        ));
      } else {
        inspect(
          resolved.schema,
          resolved.document,
          '',
          resolved.document.schema.$id,
          new Set([...refStack, resolved.id]),
        );
      }
    }
    for (const [suffix, child] of schemaChildren(schema)) {
      inspect(child, document, `${pointer}/${suffix}`, currentId, refStack);
    }
  }

  for (const document of [...registry.documents].sort((a, b) => a.path.localeCompare(b.path))) {
    const { schema } = document;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, '', 'schema document must be an object'));
      continue;
    }
    if (schema.$schema !== DIALECT) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, '/$schema', 'schema dialect must be Draft 2020-12'));
    }
    if (typeof schema.$id !== 'string') {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, '/$id', 'schema requires an absolute $id'));
      continue;
    }
    if (ids.has(schema.$id)) {
      diagnostics.push(diagnostic('PHASE0_ID_CONFLICT', document.path, '/$id', 'schema ID is duplicated'));
    } else {
      ids.set(schema.$id, document.path);
    }
    inspect(schema, document, '', schema.$id, new Set([schema.$id]));
  }
  return sortDiagnostics(diagnostics);
}

function typeMatches(type, value) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return false;
}

function instanceDiagnostics(schema, value, context, pointer, currentId, refStack) {
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, currentId, context.registry);
    if (!resolved) {
      return [diagnostic('PHASE0_REFERENCE_MISSING', context.path, pointer, 'schema reference does not resolve')];
    }
    if (refStack.has(resolved.id)) {
      return [diagnostic('PHASE0_REFERENCE_MISSING', context.path, pointer, 'cyclic schema reference is unsupported')];
    }
    return instanceDiagnostics(
      resolved.schema,
      value,
      context,
      pointer,
      resolved.document.schema.$id,
      new Set([...refStack, resolved.id]),
    );
  }

  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((branch) =>
      instanceDiagnostics(branch, value, context, pointer, currentId, new Set(refStack)));
    if (results.filter((result) => result.length === 0).length !== 1) {
      return [diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'value must match exactly one schema branch')];
    }
    return [];
  }

  const diagnostics = [];
  if (typeof schema.type === 'string' && !typeMatches(schema.type, value)) {
    return [diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, `value must have type ${schema.type}`)];
  }
  if ('const' in schema && canonicalize(value) !== canonicalize(schema.const)) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'value does not match const'));
  }
  if (Array.isArray(schema.enum)
      && !schema.enum.some((item) => canonicalize(item) === canonicalize(value))) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'value is outside enum'));
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string'
      && !new RegExp(schema.pattern, 'u').test(value)) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'string does not match pattern'));
  }
  if (typeof value === 'string' && schema.format === 'uuid'
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'string must be a lowercase UUID'));
  }
  if (typeof value === 'string' && schema.format === 'date-time'
      && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
          || Number.isNaN(Date.parse(value)))) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'string must be RFC 3339 UTC'));
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'number is below minimum'));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        diagnostics.push(diagnostic(
          'PHASE0_SCHEMA_INVALID', context.path, `${pointer}/${pointerSegment(required)}`, 'required property is missing',
        ));
      }
    }
    for (const key of Object.keys(value).sort()) {
      const childPointer = `${pointer}/${pointerSegment(key)}`;
      if (Object.hasOwn(properties, key)) {
        diagnostics.push(...instanceDiagnostics(
          properties[key], value[key], context, childPointer, currentId, new Set(refStack),
        ));
      } else if (schema.additionalProperties === false) {
        diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, childPointer, 'additional property is forbidden'));
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'array has too few items'));
    }
    if (schema.uniqueItems === true) {
      const encoded = value.map(canonicalize);
      if (new Set(encoded).size !== encoded.length) {
        diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, pointer, 'array items must be unique'));
      }
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => diagnostics.push(...instanceDiagnostics(
        schema.items, item, context, `${pointer}/${index}`, currentId, new Set(refStack),
      )));
    }
  }
  return diagnostics;
}

export function validateInstance(schemaId, value, registry, path = '<memory>') {
  const hashIndex = schemaId.indexOf('#');
  const baseId = hashIndex === -1 ? schemaId : schemaId.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : schemaId.slice(hashIndex);
  const document = registry.byId.get(baseId);
  const schema = document && resolvePointer(document.schema, fragment);
  if (!document || !schema) {
    return [diagnostic('PHASE0_REFERENCE_MISSING', path, '', 'root schema does not resolve')];
  }
  return sortDiagnostics(instanceDiagnostics(
    schema,
    value,
    { path, registry },
    '',
    document.schema.$id,
    new Set([schemaId]),
  ));
}
```

Implement the validator with these explicit rules:

```text
SUPPORTED KEYWORDS
$schema, $id, $ref, $defs, type, properties, required, additionalProperties,
items, minItems, uniqueItems, enum, const, oneOf, format, pattern, minimum

TYPE RULES
object  -> non-null object and not an array
array   -> Array.isArray(value)
string  -> typeof value === "string"
integer -> Number.isInteger(value)
number  -> finite JavaScript number
boolean -> typeof value === "boolean"
null    -> value === null

FORMAT RULES
uuid      -> lowercase RFC 4122 textual form
date-time -> RFC 3339 UTC ending in Z and parseable by Date.parse

REFERENCE RULES
- Resolve a fragment-only ref against the current schema.
- Resolve another Phase 0 schema by its absolute $id plus optional JSON pointer.
- Decode ~1 and ~0 in JSON pointer segments.
- Reject refs whose resolved $id is absent from registry.byId.
- Reject a ref cycle encountered while validating schema definitions.

ONE-OF RULE
Exactly one branch must validate. Zero or multiple matching branches emit one
PHASE0_SCHEMA_INVALID diagnostic at the current pointer.
```

For every violation, call `diagnostic(...)` from `diagnostics.mjs`; never include the
invalid value in the message. Traverse object properties in sorted key order and call
`sortDiagnostics(...)` before returning. This behavior is fully asserted by Step 1;
do not add implicit coercion, defaults, remote fetches, or unsupported keywords.

- [ ] **Step 4: Replace the validator stub with schema-file discovery**

In `tools/phase0/validate.mjs`, replace `validateRepository()` with:

```javascript
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  createSchemaRegistry,
  validateSchemaDocuments,
} from './lib/schema.mjs';

async function schemaFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? schemaFiles(path) : [path];
    }));
  return nested.flat().filter((path) => path.endsWith('.schema.json'));
}

export async function validateRepository(root) {
  const rootDirectory = join(root, 'schemas', 'phase0', 'v1');
  const files = await schemaFiles(rootDirectory);
  const documents = await Promise.all(files.map(async (path) => ({
    path: relative(root, path).replaceAll('\\', '/'),
    schema: JSON.parse(await readFile(path, 'utf8')),
  })));
  return validateSchemaDocuments(createSchemaRegistry(documents));
}
```

Keep the existing imports, `parseArgs`, `main`, and direct-execution guard. The entry
point will fail with exit `2` until Task 3 creates `schemas/phase0/v1`; that is expected
between tasks and must not be hidden.

- [ ] **Step 5: Run the schema tests**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs
```

Expected: nine tests pass.

- [ ] **Step 6: Commit the schema engine**

```powershell
git add tools/phase0/schema.test.mjs tools/phase0/lib/schema.mjs tools/phase0/validate.mjs
git commit -m "feat: validate phase 0 schema subset"
```

### Task 3: Define canonical identities and resource versions

**Files:**
- Create: `docs/protocol/identities.md`
- Create: `schemas/phase0/v1/identities.schema.json`
- Modify: `tools/phase0/schema.test.mjs`

- [ ] **Step 1: Add a failing identity-schema contract test**

Append to `tools/phase0/schema.test.mjs`:

```javascript
import { readFile } from 'node:fs/promises';

test('the Phase 0 identity schema accepts scoped versions and rejects unsafe paths', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../../schemas/phase0/v1/identities.schema.json', import.meta.url),
    'utf8',
  ));
  const registry = createSchemaRegistry([
    { path: 'schemas/phase0/v1/identities.schema.json', schema },
  ]);

  const version = {
    resourceId: `res_${'1'.repeat(64)}`,
    domain: {
      repositoryId: 'repo_11111111-1111-4111-8111-111111111111',
      workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
      worktreeId: 'wt_33333333-3333-4333-8333-333333333333',
    },
    kind: 'symbol_signature',
    value: `sha256:${'a'.repeat(64)}`,
    evidenceEventIds: ['evt_00000000000000000000000000000001'],
  };

  assert.deepEqual(validateInstance(
    `${schema.$id}#/$defs/resourceVersion`,
    version,
    registry,
    'version.json',
  ), []);
  for (const unsafePath of ['../secrets.txt', 'C:/secrets.txt', 'trailing/']) {
    assert.equal(validateInstance(
      `${schema.$id}#/$defs/logicalPath`,
      unsafePath,
      registry,
      'path.json',
    )[0].code, 'PHASE0_SCHEMA_INVALID');
  }
});
```

- [ ] **Step 2: Run the identity test to verify it fails**

Run:

```powershell
node --test tools/phase0/schema.test.mjs
```

Expected: FAIL with `ENOENT` for
`schemas/phase0/v1/identities.schema.json`.

- [ ] **Step 3: Write the normative identity document**

Create `docs/protocol/identities.md` with these exact sections and rules:

````markdown
# PatchMesh Identity and Resource-Version Protocol

> **Status:** Phase 0 normative contract. No runtime implementation exists yet.

## Authority and scope

This document defines identity equality and version scope for the initial one-repository,
multiple-worktree PatchMesh slice. `docs/TERMINOLOGY.md` owns public vocabulary;
the versioned schema owns machine shape; this document owns derivation and comparison.

## Repository identity

`repositoryId` is an opaque PatchMesh-generated identity. Its V1 wire form is `repo_`
followed by a lowercase RFC 4122 UUID. A future initializer generates it once and
persists it in PatchMesh-owned metadata below the Git common directory returned by
`git rev-parse --git-common-dir`.

- Linked worktrees share one repository ID.
- Moving a checkout does not change the ID.
- Separate clones receive separate IDs.
- Remote URLs, filesystem roots, branches, and commits never derive the ID.
- Cross-clone association requires an explicit future operation.

## Worktree and workspace identity

`worktreeId` is opaque; its V1 wire form is `wt_` followed by a lowercase RFC 4122
UUID. It identifies one Git worktree independently of its path. A future initializer
persists it beneath that worktree's Git administrative directory.

`workspaceId` is opaque; its V1 wire form is `ws_` followed by a lowercase RFC 4122
UUID. It identifies one filesystem and execution context. Multiple workspaces may
refer to one worktree. Workspace and worktree IDs are never aliases.

## Integration targets

An integration-target definition contains a stable ID, repository ID, kind, and
locator. Kinds are `branch`, `revision`, and `candidate_aggregate`.

`integrationTargetId` is opaque and stable; it is not derived from the locator. In V1
it begins with `target_`. Every evaluation pins an immutable target snapshot containing
the resolved base commit and an ordered list of candidate IDs. Compute the snapshot
digest over the closed canonical JSON object `{ integrationTargetId, repositoryId,
kind, locator, baseCommit, candidateIds }`, excluding the derived `targetSnapshotId`
and `digest` fields. The snapshot ID is `snapshot_` plus that digest. Moving a branch
or changing candidate membership or order creates a new snapshot.

Validity evidence always names a snapshot. A mutable branch name alone is insufficient.

## Logical resources

A logical resource belongs to one repository and has kind `file`, `symbol`, `api`,
`schema`, or `test`. Its ID is `res_` plus the SHA-256 digest of the canonical tuple:

```text
[repositoryId, resourceKind, normalizedLocator]
```

Equivalent resources in linked worktrees share a logical ID. Absolute workspace
roots never participate. A rename creates a new resource ID and a separate rename
relationship; content similarity does not imply identity continuity.

## Logical path normalization

Paths are UTF-8, Unicode NFC, repository-relative, slash-separated, and
case-preserving. Tracked files use Git's recorded spelling.

Reject a path containing an absolute prefix, backslash, NUL byte, empty segment,
`.` segment, or `..` segment. Reject case-folding collisions instead of silently
merging identities. Preserve a symlink's logical path and record target evidence
separately; never silently dereference outside the repository.

## Version domains and resource versions

A version domain is the tuple of repository, workspace, and worktree IDs. No resource
version is globally current.

A resource version contains a resource ID, version domain, version kind, value, and
observation evidence. V1 kinds are:

| Kind | Value |
| --- | --- |
| `git_commit` | lowercase Git object ID |
| `git_blob` | lowercase Git object ID |
| `content_hash` | `sha256:` plus 64 lowercase hexadecimal characters |
| `symbol_signature` | `sha256:` plus 64 lowercase hexadecimal characters |
| `schema_version` | non-empty declared schema version |
| `api_version` | non-empty declared API version |
| `deleted` | `null` |

Dirty or uncommitted content uses `content_hash`. Deletion uses `deleted`; it is not
represented by a missing record.

## Version roles

`observed`, `candidate`, `target`, `integrated`, and `current` describe a version's
role in an explicit comparison against a target snapshot. They are not global
namespaces. `Read Version` is a prose alias for `Observed Version` and is not a schema
field.

Cross-worktree impact compares an observed version and candidate version against a
named target snapshot. A stale read inside one domain does not by itself prove stale
work against another domain.

## Equality and rejection rules

- IDs compare as exact strings after schema validation.
- Equivalent Git object values do not make different logical resources equal.
- A resource and version domain must use the same repository ID.
- A target snapshot and compared resource must use the same repository ID.
- Empty strings and synthetic unknown IDs are invalid; nullable schema fields express
  absence explicitly.
````

- [ ] **Step 4: Create the identity schema**

Create `schemas/phase0/v1/identities.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/identities.schema.json",
  "$defs": {
    "repositoryId": {
      "type": "string",
      "pattern": "^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "worktreeId": {
      "type": "string",
      "pattern": "^wt_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "workspaceId": {
      "type": "string",
      "pattern": "^ws_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    "agentId": {
      "oneOf": [
        { "type": "string", "pattern": "^agent_[a-z0-9][a-z0-9._-]{0,63}$" },
        { "type": "null" }
      ]
    },
    "taskId": {
      "oneOf": [
        { "type": "string", "pattern": "^task_[a-z0-9][a-z0-9._-]{0,63}$" },
        { "type": "null" }
      ]
    },
    "eventId": {
      "type": "string",
      "pattern": "^evt_[0-9a-f]{32}$"
    },
    "resourceId": {
      "type": "string",
      "pattern": "^res_[0-9a-f]{64}$"
    },
    "targetId": {
      "type": "string",
      "pattern": "^target_[a-z0-9][a-z0-9._-]{0,127}$"
    },
    "targetSnapshotId": {
      "type": "string",
      "pattern": "^snapshot_[0-9a-f]{64}$"
    },
    "logicalPath": {
      "type": "string",
      "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*//)(?!.*\/$)[^\\u0000]+$"
    },
    "versionDomain": {
      "type": "object",
      "properties": {
        "repositoryId": { "$ref": "#/$defs/repositoryId" },
        "workspaceId": { "$ref": "#/$defs/workspaceId" },
        "worktreeId": { "$ref": "#/$defs/worktreeId" }
      },
      "required": ["repositoryId", "workspaceId", "worktreeId"],
      "additionalProperties": false
    },
    "integrationTarget": {
      "type": "object",
      "properties": {
        "integrationTargetId": { "$ref": "#/$defs/targetId" },
        "repositoryId": { "$ref": "#/$defs/repositoryId" },
        "kind": { "enum": ["branch", "revision", "candidate_aggregate"] },
        "locator": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" }
      },
      "required": ["integrationTargetId", "repositoryId", "kind", "locator"],
      "additionalProperties": false
    },
    "targetSnapshot": {
      "type": "object",
      "properties": {
        "targetSnapshotId": { "$ref": "#/$defs/targetSnapshotId" },
        "integrationTargetId": { "$ref": "#/$defs/targetId" },
        "repositoryId": { "$ref": "#/$defs/repositoryId" },
        "kind": { "enum": ["branch", "revision", "candidate_aggregate"] },
        "locator": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
        "baseCommit": { "type": "string", "pattern": "^[0-9a-f]{40}([0-9a-f]{24})?$" },
        "candidateIds": {
          "type": "array",
          "items": { "type": "string", "pattern": "^candidate_[0-9a-f]{64}$" },
          "uniqueItems": true
        },
        "digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
      },
      "required": [
        "targetSnapshotId",
        "integrationTargetId",
        "repositoryId",
        "kind",
        "locator",
        "baseCommit",
        "candidateIds",
        "digest"
      ],
      "additionalProperties": false
    },
    "logicalResource": {
      "type": "object",
      "properties": {
        "resourceId": { "$ref": "#/$defs/resourceId" },
        "repositoryId": { "$ref": "#/$defs/repositoryId" },
        "kind": { "enum": ["file", "symbol", "api", "schema", "test"] },
        "locator": { "$ref": "#/$defs/logicalPath" }
      },
      "required": ["resourceId", "repositoryId", "kind", "locator"],
      "additionalProperties": false
    },
    "resourceVersion": {
      "type": "object",
      "properties": {
        "resourceId": { "$ref": "#/$defs/resourceId" },
        "domain": { "$ref": "#/$defs/versionDomain" },
        "kind": {
          "enum": [
            "git_commit",
            "git_blob",
            "content_hash",
            "symbol_signature",
            "schema_version",
            "api_version",
            "deleted"
          ]
        },
        "value": {
          "oneOf": [
            { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
            { "type": "null" }
          ]
        },
        "evidenceEventIds": {
          "type": "array",
          "items": { "$ref": "#/$defs/eventId" },
          "minItems": 1,
          "uniqueItems": true
        }
      },
      "required": ["resourceId", "domain", "kind", "value", "evidenceEventIds"],
      "additionalProperties": false
    }
  }
}
```

The domain validator in Task 6 will enforce `deleted -> value: null`, non-deleted
versions having a string value, target-snapshot digest equality, and same-repository
references. Keeping those cross-field rules outside this schema avoids unsupported
conditional JSON Schema keywords.

- [ ] **Step 5: Run the identity contract tests and repository schema check**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs
node tools/phase0/validate.mjs
```

Expected: ten tests pass and the validator prints `Phase 0 corpus valid`.

- [ ] **Step 6: Commit the identity contract**

```powershell
git add docs/protocol/identities.md schemas/phase0/v1/identities.schema.json tools/phase0/schema.test.mjs
git commit -m "docs: define phase 0 identity contracts"
```

### Task 4: Define event envelope v1 and observation payloads

**Files:**
- Create: `docs/protocol/events.md`
- Create: `schemas/phase0/v1/event-payloads.schema.json`
- Create: `schemas/phase0/v1/event-envelope.schema.json`
- Modify: `tools/phase0/schema.test.mjs`

- [ ] **Step 1: Add failing event-envelope tests**

Append to `tools/phase0/schema.test.mjs`:

```javascript
test('event envelope v1 requires nullable attribution and a closed payload', async () => {
  const files = ['identities', 'event-payloads', 'event-envelope'];
  const documents = await Promise.all(files.map(async (name) => ({
    path: `schemas/phase0/v1/${name}.schema.json`,
    schema: JSON.parse(await readFile(
      new URL(`../../schemas/phase0/v1/${name}.schema.json`, import.meta.url),
      'utf8',
    )),
  })));
  const registry = createSchemaRegistry(documents);
  const envelopeId = documents[2].schema.$id;
  const event = {
    schemaVersion: 1,
    eventId: 'evt_00000000000000000000000000000001',
    eventType: 'tool.requested',
    source: {
      kind: 'gateway',
      sourceId: 'source_gateway',
      instanceId: '11111111-1111-4111-8111-111111111111'
    },
    timestamp: '2026-08-06T00:00:00.000Z',
    repositoryId: 'repo_11111111-1111-4111-8111-111111111111',
    workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
    worktreeId: 'wt_33333333-3333-4333-8333-333333333333',
    agentId: 'agent_b',
    taskId: null,
    correlationId: 'corr_00000000000000000000000000000001',
    causationId: null,
    sourceSequence: 0,
    payload: {
      toolName: 'read_file',
      operation: 'read exported authenticate symbol',
      targetResourceId: `res_${'1'.repeat(64)}`,
      opaque: false
    }
  };

  assert.deepEqual(validateInstance(envelopeId, event, registry, 'event.json'), []);
  assert.equal(validateInstance(
    envelopeId,
    { ...event, schemaVersion: 2 },
    registry,
    'event.json',
  )[0].code, 'PHASE0_SCHEMA_INVALID');
  const { taskId, ...withoutTaskId } = event;
  assert.equal(validateInstance(
    envelopeId,
    withoutTaskId,
    registry,
    'event.json',
  )[0].pointer, '/taskId');
});
```

- [ ] **Step 2: Run the event test to verify it fails**

Run:

```powershell
node --test tools/phase0/schema.test.mjs
```

Expected: FAIL with `ENOENT` for `event-payloads.schema.json` or
`event-envelope.schema.json`.

- [ ] **Step 3: Write the normative event protocol**

Create `docs/protocol/events.md` with:

````markdown
# PatchMesh Event Protocol V1

> **Status:** Phase 0 normative contract. No event collector or store exists yet.

## Envelope

Every event contains `schemaVersion`, `eventId`, `eventType`, `source`, `timestamp`,
`repositoryId`, `workspaceId`, `worktreeId`, nullable `agentId`, nullable `taskId`,
`correlationId`, nullable `causationId`, nullable `sourceSequence`, and `payload`.

`schemaVersion` is exactly integer `1`. An unknown version is rejected with
`PHASE0_SCHEMA_UNSUPPORTED`; readers never guess a compatible version. Envelope and
payload objects are closed, and `eventType` selects exactly one payload definition.

## Source and time

`source` records a component kind, stable producer ID, and process-instance UUID.
`sourceSequence` is ordered only inside that process instance. A gap degrades coverage
but does not create a synthetic event or causal edge.

`timestamp` is an RFC 3339 UTC observation time. Timestamp order, source order, and
causal order are distinct. Wall-clock time never establishes causality.

## Correlation and causation

`correlationId` groups one originating operation and its effects, findings, and
decisions. Root events use `causationId: null`. Every derived event names its single
direct trigger. Multiple supporting facts are listed in payload `evidenceEventIds`;
they do not turn `causationId` into an array.

Incremental processing may buffer a missing causal parent. A bounded replay with an
unresolved parent fails with `PHASE0_REFERENCE_MISSING`.

## Idempotency and integrity

Compute event content equality as SHA-256 over RFC 8785 canonical JSON.

- Same `eventId` and same digest: no-op.
- Same `eventId` and different digest: `PHASE0_ID_CONFLICT`.
- Producer retry: reuse the original ID.
- Stored events: immutable and append-only.

## Attribution

`agentId` and `taskId` are always present and may be null. Null means attribution was
unavailable at observation time; it is not a synthetic unknown entity.

`attribution.corrected` records the target event, corrected agent/task values, reason,
and evidence. It changes projection attribution without changing original bytes.

## V1 observation event types

| Event type | Payload definition | Meaning |
| --- | --- | --- |
| `tool.requested` | `toolRequested` | Intent durably recorded before execution |
| `tool.completed` | `toolCompleted` | Tool outcome and linked effect events |
| `file.read` | `resourceObserved` | File version observed |
| `file.changed` | `resourceChanged` | File version changed |
| `symbol.read` | `resourceObserved` | Symbol version observed |
| `symbol.changed` | `resourceChanged` | Symbol version changed |
| `task.completed` | `taskCompleted` | Work product completed against a target |
| `dependency.changed` | `dependencyChanged` | Evidence-backed dependency edge added or changed |
| `attribution.corrected` | `attributionCorrected` | Later immutable attribution correction |

Coordination and validity event payloads are defined with their domain contracts.

## Ordering and replay

Projectors use explicit causal references and idempotent entity IDs. They may delay an
event whose declared prerequisite is absent. Source sequence is diagnostic evidence,
not a substitute for causality. Valid out-of-order delivery converges when all parents
arrive; an unresolved reference at end of replay is an error.
````

- [ ] **Step 4: Create the observation payload schema**

Create `schemas/phase0/v1/event-payloads.schema.json` with `$schema` and `$id` set to
the Phase 0 URI pattern and these closed `$defs`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/event-payloads.schema.json",
  "$defs": {
    "toolRequested": {
      "type": "object",
      "properties": {
        "toolName": { "enum": ["read_file", "edit_file", "run_shell", "run_test", "git_commit"] },
        "operation": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
        "targetResourceId": {
          "oneOf": [
            { "$ref": "./identities.schema.json#/$defs/resourceId" },
            { "type": "null" }
          ]
        },
        "opaque": { "type": "boolean" }
      },
      "required": ["toolName", "operation", "targetResourceId", "opaque"],
      "additionalProperties": false
    },
    "toolCompleted": {
      "type": "object",
      "properties": {
        "requestEventId": { "$ref": "./identities.schema.json#/$defs/eventId" },
        "outcome": { "enum": ["succeeded", "failed", "interrupted"] },
        "exitCode": {
          "oneOf": [
            { "type": "integer" },
            { "type": "null" }
          ]
        },
        "effectEventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "uniqueItems": true
        }
      },
      "required": ["requestEventId", "outcome", "exitCode", "effectEventIds"],
      "additionalProperties": false
    },
    "resourceObserved": {
      "type": "object",
      "properties": {
        "resource": { "$ref": "./identities.schema.json#/$defs/logicalResource" },
        "version": { "$ref": "./identities.schema.json#/$defs/resourceVersion" },
        "access": { "enum": ["read", "execute"] }
      },
      "required": ["resource", "version", "access"],
      "additionalProperties": false
    },
    "resourceChanged": {
      "type": "object",
      "properties": {
        "resource": { "$ref": "./identities.schema.json#/$defs/logicalResource" },
        "beforeVersion": {
          "oneOf": [
            { "$ref": "./identities.schema.json#/$defs/resourceVersion" },
            { "type": "null" }
          ]
        },
        "afterVersion": { "$ref": "./identities.schema.json#/$defs/resourceVersion" },
        "changeKind": { "enum": ["created", "modified", "deleted", "renamed"] }
      },
      "required": ["resource", "beforeVersion", "afterVersion", "changeKind"],
      "additionalProperties": false
    },
    "taskCompleted": {
      "type": "object",
      "properties": {
        "workProductId": { "type": "string", "pattern": "^work_[0-9a-f]{32}$" },
        "baseRevision": { "type": "string", "pattern": "^[0-9a-f]{40}([0-9a-f]{24})?$" },
        "targetSnapshotId": { "$ref": "./identities.schema.json#/$defs/targetSnapshotId" },
        "resourceIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/resourceId" },
          "minItems": 1,
          "uniqueItems": true
        }
      },
      "required": ["workProductId", "baseRevision", "targetSnapshotId", "resourceIds"],
      "additionalProperties": false
    },
    "dependencyChanged": {
      "type": "object",
      "properties": {
        "dependency": { "$ref": "./dependency.schema.json" }
      },
      "required": ["dependency"],
      "additionalProperties": false
    },
    "attributionCorrected": {
      "type": "object",
      "properties": {
        "targetEventId": { "$ref": "./identities.schema.json#/$defs/eventId" },
        "attributedAgentId": { "$ref": "./identities.schema.json#/$defs/agentId" },
        "attributedTaskId": { "$ref": "./identities.schema.json#/$defs/taskId" },
        "reason": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
        "evidenceEventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "minItems": 1,
          "uniqueItems": true
        }
      },
      "required": [
        "targetEventId",
        "attributedAgentId",
        "attributedTaskId",
        "reason",
        "evidenceEventIds"
      ],
      "additionalProperties": false
    }
  }
}
```

- [ ] **Step 5: Create the closed event envelope schema**

Create `schemas/phase0/v1/event-envelope.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/event-envelope.schema.json",
  "type": "object",
  "properties": {
    "schemaVersion": { "const": 1 },
    "eventId": { "$ref": "./identities.schema.json#/$defs/eventId" },
    "eventType": {
      "enum": [
        "tool.requested",
        "tool.completed",
        "file.read",
        "file.changed",
        "symbol.read",
        "symbol.changed",
        "task.completed",
        "dependency.changed",
        "attribution.corrected"
      ]
    },
    "source": {
      "type": "object",
      "properties": {
        "kind": { "enum": ["gateway", "adapter", "watcher", "analyzer", "core"] },
        "sourceId": { "type": "string", "pattern": "^source_[a-z0-9][a-z0-9._-]{0,63}$" },
        "instanceId": { "type": "string", "format": "uuid" }
      },
      "required": ["kind", "sourceId", "instanceId"],
      "additionalProperties": false
    },
    "timestamp": { "type": "string", "format": "date-time" },
    "repositoryId": { "$ref": "./identities.schema.json#/$defs/repositoryId" },
    "workspaceId": { "$ref": "./identities.schema.json#/$defs/workspaceId" },
    "worktreeId": { "$ref": "./identities.schema.json#/$defs/worktreeId" },
    "agentId": { "$ref": "./identities.schema.json#/$defs/agentId" },
    "taskId": { "$ref": "./identities.schema.json#/$defs/taskId" },
    "correlationId": { "type": "string", "pattern": "^corr_[0-9a-f]{32}$" },
    "causationId": {
      "oneOf": [
        { "$ref": "./identities.schema.json#/$defs/eventId" },
        { "type": "null" }
      ]
    },
    "sourceSequence": {
      "oneOf": [
        { "type": "integer", "minimum": 0 },
        { "type": "null" }
      ]
    },
    "payload": {
      "oneOf": [
        { "$ref": "./event-payloads.schema.json#/$defs/toolRequested" },
        { "$ref": "./event-payloads.schema.json#/$defs/toolCompleted" },
        { "$ref": "./event-payloads.schema.json#/$defs/resourceObserved" },
        { "$ref": "./event-payloads.schema.json#/$defs/resourceChanged" },
        { "$ref": "./event-payloads.schema.json#/$defs/taskCompleted" },
        { "$ref": "./event-payloads.schema.json#/$defs/dependencyChanged" },
        { "$ref": "./event-payloads.schema.json#/$defs/attributionCorrected" }
      ]
    }
  },
  "required": [
    "schemaVersion",
    "eventId",
    "eventType",
    "source",
    "timestamp",
    "repositoryId",
    "workspaceId",
    "worktreeId",
    "agentId",
    "taskId",
    "correlationId",
    "causationId",
    "sourceSequence",
    "payload"
  ],
  "additionalProperties": false
}
```

- [ ] **Step 6: Run event and schema validation**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs
node tools/phase0/validate.mjs
```

Expected: eleven tests pass and the validator prints `Phase 0 corpus valid`.

- [ ] **Step 7: Commit event protocol v1**

```powershell
git add docs/protocol/events.md schemas/phase0/v1/event-payloads.schema.json schemas/phase0/v1/event-envelope.schema.json tools/phase0/schema.test.mjs
git commit -m "docs: define phase 0 event protocol"
```

### Task 5: Define coordination, validity, provenance, coverage, and graph contracts

**Files:**
- Create: `docs/protocol/coordination.md`
- Create: `docs/protocol/validity.md`
- Create: `docs/protocol/evidence-and-coverage.md`
- Create: `schemas/phase0/v1/coverage.schema.json`
- Create: `schemas/phase0/v1/dependency.schema.json`
- Create: `schemas/phase0/v1/finding.schema.json`
- Create: `schemas/phase0/v1/decision.schema.json`
- Create: `schemas/phase0/v1/task-validity.schema.json`
- Create: `schemas/phase0/v1/graph.schema.json`
- Modify: `schemas/phase0/v1/event-payloads.schema.json`
- Modify: `schemas/phase0/v1/event-envelope.schema.json`
- Modify: `docs/protocol/events.md`
- Modify: `tools/phase0/schema.test.mjs`

- [ ] **Step 1: Write failing state-schema tests**

Append to `tools/phase0/schema.test.mjs`:

```javascript
test('decision and validity schemas keep action, directive, and validity distinct', async () => {
  const names = [
    'identities',
    'coverage',
    'finding',
    'decision',
    'task-validity',
    'dependency',
  ];
  const documents = await Promise.all(names.map(async (name) => ({
    path: `schemas/phase0/v1/${name}.schema.json`,
    schema: JSON.parse(await readFile(
      new URL(`../../schemas/phase0/v1/${name}.schema.json`, import.meta.url),
      'utf8',
    )),
  })));
  const registry = createSchemaRegistry(documents);
  const decision = {
    decisionId: 'decision_00000000000000000000000000000001',
    findingId: 'finding_00000000000000000000000000000001',
    target: { agentId: 'agent_b', taskId: 'task_consumer' },
    coordinationAction: 'request_revalidation',
    gatewayDirective: 'allow_with_notice',
    reason: 'candidate signature differs from the observed signature',
    evidenceEventIds: ['evt_00000000000000000000000000000001'],
    confidence: 1,
    confidenceBand: 'high',
    policy: { policyId: 'policy_exported_contract', version: '1' },
    expectedResponse: 'affected',
    coverageIds: ['coverage_00000000000000000000000000000001'],
    state: 'active',
    deliveries: []
  };
  assert.deepEqual(validateInstance(
    documents[3].schema.$id,
    decision,
    registry,
    'decision.json',
  ), []);
  assert.equal(validateInstance(
    documents[3].schema.$id,
    { ...decision, gatewayDirective: 'pause' },
    registry,
    'decision.json',
  )[0].pointer, '/gatewayDirective');
});
```

- [ ] **Step 2: Run the state-schema test to verify it fails**

Run:

```powershell
node --test tools/phase0/schema.test.mjs
```

Expected: FAIL with `ENOENT` for `coverage.schema.json`.

- [ ] **Step 3: Write the coordination contract**

Create `docs/protocol/coordination.md` with:

````markdown
# PatchMesh Coordination Contract

> **Status:** Phase 0 normative contract. Coordination remains planned and report-only.

## Finding and decision separation

An event is an immutable fact. A finding is a deterministic interpretation of facts.
A decision is a versioned policy result for one finding. A gateway directive is the
instruction for one tool call and is not the coordination action for affected work.

Every finding names its detector and version, evidence events, dependency path,
confidence, severity, coverage evidence, and affected resource or task.

Every decision names its source finding, target, `coordinationAction`,
`gatewayDirective`, reason, evidence, confidence and band, policy and version,
expected response, coverage, and state.

## Roadmap capability matrix

| Phase | Coordination actions | Gateway directives |
| --- | --- | --- |
| 0 | No runtime emission; target fixtures only | No runtime emission |
| 1 | `record` | `allow` |
| 2 | `record`, `notify`, `request_recheck`, `mark_possibly_stale`, `request_revalidation` | `allow`, `allow_with_notice` |
| 3 | Same action set as Phase 2; validation events update validity | `allow`, `allow_with_notice` |
| 4 | Only actions scheduled by a future Phase 4 design | `allow`, `allow_with_notice`, opt-in `delay`, opt-in `reject` |

Canonical actions not scheduled above remain vocabulary only. Phase 0 fixtures declare
the target phase they specify. A target Phase 0–3 fixture cannot contain `delay` or
`reject`.

## Delivery state

Decision state and delivery state are separate. One decision may have multiple
targeted deliveries. Delivery states are `pending`, `delivered`, `acknowledged`, and
`failed`.

`deliveryId` is stable for one decision and target. Duplicate delivery or
acknowledgment events are no-ops. Replay rebuilds delivery state without sending a
message or enforcing a directive.

Retry schedules, expiry, override, and crash-time redispatch are not Phase 0 behavior.
A failed delivery remains recorded until a later roadmap phase defines handling.

## Expected responses

Targets may respond `affected`, `not_affected`, `already_handled`, or
`needs_more_information`. A response is evidence; it does not mutate the original
finding or decision.
````

- [ ] **Step 4: Write the validity contract**

Create `docs/protocol/validity.md` with:

````markdown
# PatchMesh Work-Product Validity Contract

> **Status:** Phase 0 normative contract. Phase 3 implements targeted revalidation.

## Separate projections

Task execution state answers whether assigned work is queued, running, completed,
failed, or cancelled. Work-product validity answers whether a specific completed
artifact is supported by current evidence against a target snapshot. `completed` is
never a synonym for `valid`.

V1 validity states are `unassessed`, `valid`, `possibly_stale`, `revalidating`, and
`stale`.

## Allowed transitions and guards

| From | To | Required guard |
| --- | --- | --- |
| `unassessed` | `valid` | successful recorded validation against the named target snapshot |
| `unassessed` | `possibly_stale` | evidence-backed dependency impact |
| `valid` | `possibly_stale` | new evidence-backed dependency impact |
| `possibly_stale` | `revalidating` | named work product, validation command, and target snapshot |
| `revalidating` | `valid` | successful result for the current target snapshot |
| `revalidating` | `stale` | failed validation or explicit deterministic proof |
| `revalidating` | `possibly_stale` | inconclusive, interrupted, or superseded validation |

A result for an obsolete target snapshot remains evidence but cannot transition the
current record. Reworked output creates a new work-product validity record. State
corrections are new immutable events.

## Required validity evidence

A record includes task and work-product IDs, execution state, validity state, base
revision, target snapshot, observed dependency versions, validation records,
coverage IDs, and evidence event IDs. Each validation record includes the exact
command, outcome, target snapshot, and result event.
````

- [ ] **Step 5: Write the provenance and coverage contract**

Create `docs/protocol/evidence-and-coverage.md` with:

````markdown
# PatchMesh Dependency Evidence and Observability Coverage

> **Status:** Phase 0 normative contract. Coverage is evidence, not a global boolean.

## Dependency provenance

Every dependency edge names logical endpoints, applicable versions, evidence events,
and one or more provenance observations. Canonical provenance is `declared`,
`statically_observed`, `dynamically_observed`, or `semantically_inferred`.

Each provenance observation names its producer and rule or analyzer version. Semantic
inference alone cannot produce a disruptive gateway directive.

## Coverage modes

Canonical modes are `intercepted`, `verified`, `inferred`, and `unknown`.
`intercepted` describes a request observed before execution. `verified` describes an
effect confirmed after execution. They are orthogonal and may both apply.

A coverage record is scoped to an operation or relationship and contains modes,
evidence events, and explicit gaps. Findings and decisions reference coverage records;
coverage from unrelated activity cannot upgrade them.

## Derived presentation state

Presentation is `sufficient`, `degraded`, or `unknown` for the stated question. Any
relevant `unknown` gap prevents `sufficient`. `inferred` cannot replace required
interception or verification. `unknown` with no direct evidence presents `unknown`.

## Opaque operations

An opaque shell request may be intercepted while its effects are verified later by
filesystem, Git, process, or test evidence. Unverified effect classes remain explicit
gaps. PatchMesh must not claim complete pre-write observation for an opaque command.
````

- [ ] **Step 6: Create dependency, coverage, and finding schemas**

Create `schemas/phase0/v1/dependency.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/dependency.schema.json",
  "$defs": {
    "provenanceObservation": {
      "type": "object",
      "properties": {
        "kind": {
          "enum": ["declared", "statically_observed", "dynamically_observed", "semantically_inferred"]
        },
        "producer": {
          "type": "object",
          "properties": {
            "sourceId": { "type": "string", "pattern": "^source_[a-z0-9][a-z0-9._-]{0,63}$" },
            "version": { "type": "string", "pattern": "^\\S+$" }
          },
          "required": ["sourceId", "version"],
          "additionalProperties": false
        },
        "rule": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "ruleId": { "type": "string", "pattern": "^rule_[a-z0-9][a-z0-9._-]{0,63}$" },
                "version": { "type": "string", "pattern": "^\\S+$" }
              },
              "required": ["ruleId", "version"],
              "additionalProperties": false
            },
            { "type": "null" }
          ]
        },
        "evidenceEventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "minItems": 1,
          "uniqueItems": true
        }
      },
      "required": ["kind", "producer", "rule", "evidenceEventIds"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "dependencyId": { "type": "string", "pattern": "^dep_[0-9a-f]{32}$" },
    "dependentResourceId": { "$ref": "./identities.schema.json#/$defs/resourceId" },
    "dependencyResourceId": { "$ref": "./identities.schema.json#/$defs/resourceId" },
    "dependentVersion": { "$ref": "./identities.schema.json#/$defs/resourceVersion" },
    "dependencyVersion": { "$ref": "./identities.schema.json#/$defs/resourceVersion" },
    "observations": {
      "type": "array",
      "items": { "$ref": "#/$defs/provenanceObservation" },
      "minItems": 1,
      "uniqueItems": true
    },
    "evidenceEventIds": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
      "minItems": 1,
      "uniqueItems": true
    }
  },
  "required": [
    "dependencyId",
    "dependentResourceId",
    "dependencyResourceId",
    "dependentVersion",
    "dependencyVersion",
    "observations",
    "evidenceEventIds"
  ],
  "additionalProperties": false
}
```

The two version records must name their corresponding endpoint resource IDs. Each
observation always names a versioned producer; `rule` is non-null for analyzer/rule
output and may be null only when the producer has no applicable rule. Task 6 enforces
these cross-field rules and evidence references.

Create `schemas/phase0/v1/coverage.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/coverage.schema.json",
  "$defs": {
    "coverageId": { "type": "string", "pattern": "^coverage_[0-9a-f]{32}$" },
    "gap": {
      "type": "object",
      "properties": {
        "kind": { "enum": ["bypassed", "opaque", "missing_sequence", "unattributed", "unverified"] },
        "scope": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
        "reason": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
        "evidenceEventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "uniqueItems": true
        }
      },
      "required": ["kind", "scope", "reason", "evidenceEventIds"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "coverageId": { "$ref": "#/$defs/coverageId" },
    "scope": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
    "modes": {
      "type": "array",
      "items": { "enum": ["intercepted", "verified", "inferred", "unknown"] },
      "minItems": 1,
      "uniqueItems": true
    },
    "evidenceEventIds": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
      "uniqueItems": true
    },
    "gaps": {
      "type": "array",
      "items": { "$ref": "#/$defs/gap" }
    },
    "presentation": { "enum": ["sufficient", "degraded", "unknown"] }
  },
  "required": ["coverageId", "scope", "modes", "evidenceEventIds", "gaps", "presentation"],
  "additionalProperties": false
}
```

Create `schemas/phase0/v1/finding.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/finding.schema.json",
  "type": "object",
  "properties": {
    "findingId": { "type": "string", "pattern": "^finding_[0-9a-f]{32}$" },
    "findingType": {
      "enum": ["same_symbol_overlap", "stale_read_before_write", "exported_contract_invalidation"]
    },
    "status": { "enum": ["open", "dismissed", "resolved"] },
    "subjectResourceId": { "$ref": "./identities.schema.json#/$defs/resourceId" },
    "affectedTaskId": { "$ref": "./identities.schema.json#/$defs/taskId" },
    "dependencyIds": {
      "type": "array",
      "items": { "type": "string", "pattern": "^dep_[0-9a-f]{32}$" },
      "uniqueItems": true
    },
    "evidenceEventIds": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
      "minItems": 1,
      "uniqueItems": true
    },
    "confidence": { "type": "number", "minimum": 0 },
    "confidenceBand": { "enum": ["low", "medium", "high"] },
    "severity": { "enum": ["info", "warning", "critical"] },
    "coverageIds": {
      "type": "array",
      "items": { "$ref": "./coverage.schema.json#/$defs/coverageId" },
      "minItems": 1,
      "uniqueItems": true
    },
    "detector": {
      "type": "object",
      "properties": {
        "detectorId": { "type": "string", "pattern": "^detector_[a-z0-9][a-z0-9._-]{0,63}$" },
        "version": { "type": "string", "pattern": "^\\S+$" }
      },
      "required": ["detectorId", "version"],
      "additionalProperties": false
    }
  },
  "required": [
    "findingId",
    "findingType",
    "status",
    "subjectResourceId",
    "affectedTaskId",
    "dependencyIds",
    "evidenceEventIds",
    "confidence",
    "confidenceBand",
    "severity",
    "coverageIds",
    "detector"
  ],
  "additionalProperties": false
}
```

- [ ] **Step 7: Create decision and validity schemas**

Create `schemas/phase0/v1/decision.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/decision.schema.json",
  "$defs": {
    "target": {
      "type": "object",
      "properties": {
        "agentId": { "$ref": "./identities.schema.json#/$defs/agentId" },
        "taskId": { "$ref": "./identities.schema.json#/$defs/taskId" }
      },
      "required": ["agentId", "taskId"],
      "additionalProperties": false
    },
    "delivery": {
      "type": "object",
      "properties": {
        "deliveryId": { "type": "string", "pattern": "^delivery_[0-9a-f]{32}$" },
        "target": { "$ref": "#/$defs/target" },
        "state": { "enum": ["pending", "delivered", "acknowledged", "failed"] },
        "eventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "uniqueItems": true
        }
      },
      "required": ["deliveryId", "target", "state", "eventIds"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "decisionId": { "type": "string", "pattern": "^decision_[0-9a-f]{32}$" },
    "findingId": { "type": "string", "pattern": "^finding_[0-9a-f]{32}$" },
    "target": { "$ref": "#/$defs/target" },
    "coordinationAction": {
      "enum": [
        "record",
        "notify",
        "request_recheck",
        "assign_owner",
        "redirect",
        "pause",
        "mark_possibly_stale",
        "mark_stale",
        "request_revalidation",
        "create_follow_up_task",
        "escalate"
      ]
    },
    "gatewayDirective": { "enum": ["allow", "allow_with_notice", "delay", "reject"] },
    "reason": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
    "evidenceEventIds": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
      "minItems": 1,
      "uniqueItems": true
    },
    "confidence": { "type": "number", "minimum": 0 },
    "confidenceBand": { "enum": ["low", "medium", "high"] },
    "policy": {
      "type": "object",
      "properties": {
        "policyId": { "type": "string", "pattern": "^policy_[a-z0-9][a-z0-9._-]{0,63}$" },
        "version": { "type": "string", "pattern": "^\\S+$" }
      },
      "required": ["policyId", "version"],
      "additionalProperties": false
    },
    "expectedResponse": {
      "enum": ["affected", "not_affected", "already_handled", "needs_more_information"]
    },
    "coverageIds": {
      "type": "array",
      "items": { "$ref": "./coverage.schema.json#/$defs/coverageId" },
      "minItems": 1,
      "uniqueItems": true
    },
    "state": { "enum": ["active", "resolved"] },
    "deliveries": {
      "type": "array",
      "items": { "$ref": "#/$defs/delivery" }
    }
  },
  "required": [
    "decisionId",
    "findingId",
    "target",
    "coordinationAction",
    "gatewayDirective",
    "reason",
    "evidenceEventIds",
    "confidence",
    "confidenceBand",
    "policy",
    "expectedResponse",
    "coverageIds",
    "state",
    "deliveries"
  ],
  "additionalProperties": false
}
```

Create `schemas/phase0/v1/task-validity.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/task-validity.schema.json",
  "$defs": {
    "state": { "enum": ["unassessed", "valid", "possibly_stale", "revalidating", "stale"] },
    "transition": {
      "type": "object",
      "properties": {
        "from": { "$ref": "#/$defs/state" },
        "to": { "$ref": "#/$defs/state" },
        "reason": {
          "enum": [
            "validation_passed",
            "dependency_impact",
            "validation_started",
            "validation_failed",
            "deterministic_proof",
            "validation_inconclusive",
            "validation_interrupted",
            "target_superseded"
          ]
        },
        "targetSnapshotId": { "$ref": "./identities.schema.json#/$defs/targetSnapshotId" },
        "evidenceEventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "minItems": 1,
          "uniqueItems": true
        }
      },
      "required": ["from", "to", "reason", "targetSnapshotId", "evidenceEventIds"],
      "additionalProperties": false
    },
    "validation": {
      "type": "object",
      "properties": {
        "command": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
        "outcome": { "enum": ["started", "passed", "failed", "inconclusive", "interrupted"] },
        "targetSnapshotId": { "$ref": "./identities.schema.json#/$defs/targetSnapshotId" },
        "resultEventId": { "$ref": "./identities.schema.json#/$defs/eventId" }
      },
      "required": ["command", "outcome", "targetSnapshotId", "resultEventId"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "validityId": { "type": "string", "pattern": "^validity_[0-9a-f]{32}$" },
    "taskId": { "type": "string", "pattern": "^task_[a-z0-9][a-z0-9._-]{0,63}$" },
    "workProductId": { "type": "string", "pattern": "^work_[0-9a-f]{32}$" },
    "executionState": { "enum": ["completed", "failed", "cancelled"] },
    "validityState": { "$ref": "#/$defs/state" },
    "baseRevision": { "type": "string", "pattern": "^[0-9a-f]{40}([0-9a-f]{24})?$" },
    "targetSnapshotId": { "$ref": "./identities.schema.json#/$defs/targetSnapshotId" },
    "observedDependencies": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/resourceVersion" },
      "uniqueItems": true
    },
    "validations": {
      "type": "array",
      "items": { "$ref": "#/$defs/validation" }
    },
    "coverageIds": {
      "type": "array",
      "items": { "$ref": "./coverage.schema.json#/$defs/coverageId" },
      "uniqueItems": true
    },
    "evidenceEventIds": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
      "uniqueItems": true
    },
    "lastTransition": {
      "oneOf": [
        { "$ref": "#/$defs/transition" },
        { "type": "null" }
      ]
    }
  },
  "required": [
    "validityId",
    "taskId",
    "workProductId",
    "executionState",
    "validityState",
    "baseRevision",
    "targetSnapshotId",
    "observedDependencies",
    "validations",
    "coverageIds",
    "evidenceEventIds",
    "lastTransition"
  ],
  "additionalProperties": false
}
```

- [ ] **Step 8: Create the canonical graph schema**

Create `schemas/phase0/v1/graph.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/graph.schema.json",
  "$defs": {
    "node": {
      "type": "object",
      "properties": {
        "nodeId": { "type": "string", "pattern": "^node_[0-9a-f]{32}$" },
        "kind": { "enum": ["agent", "task", "resource", "work_product", "target_snapshot", "finding", "decision"] },
        "entityId": { "type": "string", "pattern": "^\\S+$" }
      },
      "required": ["nodeId", "kind", "entityId"],
      "additionalProperties": false
    },
    "edge": {
      "type": "object",
      "properties": {
        "edgeId": { "type": "string", "pattern": "^edge_[0-9a-f]{32}$" },
        "kind": { "enum": ["depends_on", "observed", "produced", "affects", "derived_from", "targets"] },
        "fromNodeId": { "type": "string", "pattern": "^node_[0-9a-f]{32}$" },
        "toNodeId": { "type": "string", "pattern": "^node_[0-9a-f]{32}$" },
        "dependency": {
          "oneOf": [
            { "$ref": "./dependency.schema.json" },
            { "type": "null" }
          ]
        },
        "evidenceEventIds": {
          "type": "array",
          "items": { "$ref": "./identities.schema.json#/$defs/eventId" },
          "uniqueItems": true
        }
      },
      "required": ["edgeId", "kind", "fromNodeId", "toNodeId", "dependency", "evidenceEventIds"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "resources": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/logicalResource" },
      "uniqueItems": true
    },
    "nodes": { "type": "array", "items": { "$ref": "#/$defs/node" }, "uniqueItems": true },
    "edges": { "type": "array", "items": { "$ref": "#/$defs/edge" }, "uniqueItems": true },
    "targetSnapshots": {
      "type": "array",
      "items": { "$ref": "./identities.schema.json#/$defs/targetSnapshot" },
      "uniqueItems": true
    }
  },
  "required": ["resources", "nodes", "edges", "targetSnapshots"],
  "additionalProperties": false
}
```

Every graph lists full logical resource records in `resources`, so resource-node
`entityId` values and digest identities are verifiable even when no observation event
carries that resource. Task 6 requires `dependency` to be non-null exactly for a
`depends_on` edge and requires that nested record to match one
`dependency.changed` event by canonical digest; every other edge uses
`dependency: null`.

- [ ] **Step 9: Add coordination payloads to the event protocol**

Add these `$defs` to `event-payloads.schema.json`:

```json
"findingCreated": {
  "type": "object",
  "properties": { "finding": { "$ref": "./finding.schema.json" } },
  "required": ["finding"],
  "additionalProperties": false
},
"decisionCreated": {
  "type": "object",
  "properties": { "decision": { "$ref": "./decision.schema.json" } },
  "required": ["decision"],
  "additionalProperties": false
},
"validityChanged": {
  "type": "object",
  "properties": {
    "record": { "$ref": "./task-validity.schema.json" },
    "transition": { "$ref": "./task-validity.schema.json#/$defs/transition" }
  },
  "required": ["record", "transition"],
  "additionalProperties": false
},
"decisionDeliveryChanged": {
  "type": "object",
  "properties": {
    "decisionId": { "type": "string", "pattern": "^decision_[0-9a-f]{32}$" },
    "delivery": { "$ref": "./decision.schema.json#/$defs/delivery" }
  },
  "required": ["decisionId", "delivery"],
  "additionalProperties": false
}
```

Add these values to `event-envelope.schema.json`'s `eventType` enum:

```json
"finding.created",
"decision.created",
"validity.changed",
"decision.delivery.changed"
```

Add these refs to its payload `oneOf`:

```json
{ "$ref": "./event-payloads.schema.json#/$defs/findingCreated" },
{ "$ref": "./event-payloads.schema.json#/$defs/decisionCreated" },
{ "$ref": "./event-payloads.schema.json#/$defs/validityChanged" },
{ "$ref": "./event-payloads.schema.json#/$defs/decisionDeliveryChanged" }
```

Also add the four event types and payload-definition names to the table in
`docs/protocol/events.md`.

- [ ] **Step 10: Run all schema checks**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: twelve tests pass, the corpus validator passes, and `git diff --check`
prints nothing.

- [ ] **Step 11: Commit the state contracts**

```powershell
git add docs/protocol/events.md docs/protocol/coordination.md docs/protocol/validity.md docs/protocol/evidence-and-coverage.md schemas/phase0/v1/dependency.schema.json schemas/phase0/v1/coverage.schema.json schemas/phase0/v1/finding.schema.json schemas/phase0/v1/decision.schema.json schemas/phase0/v1/task-validity.schema.json schemas/phase0/v1/graph.schema.json schemas/phase0/v1/event-payloads.schema.json schemas/phase0/v1/event-envelope.schema.json tools/phase0/schema.test.mjs
git commit -m "docs: define phase 0 state contracts"
```

### Task 6: Implement corpus loading and cross-contract domain validation

**Files:**
- Create: `schemas/phase0/v1/scenario-manifest.schema.json`
- Create: `tools/phase0/domain.test.mjs`
- Create: `tools/phase0/lib/corpus.mjs`
- Create: `tools/phase0/lib/domain.mjs`

- [ ] **Step 1: Write failing domain-invariant tests**

Create `tools/phase0/domain.test.mjs` with:

```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalDigest } from './lib/canonical-json.mjs';
import {
  canonicalSnapshot,
  validateCoverageRecords,
  validateDecisionCapabilities,
  validateDecisionDeliveryEvents,
  validateEventSet,
  validateIdentityRecords,
  validateScenarioDomain,
  validateSequenceCoverage,
  validateValidityRecords,
} from './lib/domain.mjs';

const baseEvent = {
  schemaVersion: 1,
  eventId: 'evt_00000000000000000000000000000001',
  eventType: 'tool.requested',
  source: {
    kind: 'gateway',
    sourceId: 'source_gateway',
    instanceId: '11111111-1111-4111-8111-111111111111'
  },
  timestamp: '2026-08-06T00:00:00.000Z',
  repositoryId: 'repo_11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws_22222222-2222-4222-8222-222222222222',
  worktreeId: 'wt_33333333-3333-4333-8333-333333333333',
  agentId: 'agent_a',
  taskId: 'task_producer',
  correlationId: 'corr_00000000000000000000000000000001',
  causationId: null,
  sourceSequence: 0,
  payload: {
    toolName: 'edit_file',
    operation: 'change exported signature',
    targetResourceId: `res_${'1'.repeat(64)}`,
    opaque: false
  }
};

test('identical duplicates are no-ops and conflicting duplicates fail integrity', () => {
  assert.deepEqual(validateEventSet([baseEvent, structuredClone(baseEvent)]), []);
  const conflict = structuredClone(baseEvent);
  conflict.payload.operation = 'different content';
  assert.equal(validateEventSet([baseEvent, conflict])[0].code, 'PHASE0_ID_CONFLICT');
});

test('a child inherits correlation from its causal parent', () => {
  const child = {
    ...structuredClone(baseEvent),
    eventId: 'evt_00000000000000000000000000000002',
    causationId: baseEvent.eventId,
    correlationId: 'corr_ffffffffffffffffffffffffffffffff',
    sourceSequence: 1
  };
  assert.equal(validateEventSet([baseEvent, child])[0].code, 'PHASE0_SCHEMA_INVALID');
});

test('source-sequence gaps require an exact degraded coverage gap', () => {
  const skipped = {
    ...structuredClone(baseEvent),
    eventId: 'evt_00000000000000000000000000000002',
    causationId: baseEvent.eventId,
    sourceSequence: 2,
  };
  const scope = `source:${baseEvent.source.kind}:${baseEvent.source.sourceId}:${baseEvent.source.instanceId}:sequence:1`;
  assert.equal(
    validateSequenceCoverage([baseEvent, skipped], [])[0].code,
    'PHASE0_COVERAGE_OVERCLAIMED',
  );
  assert.deepEqual(validateSequenceCoverage([baseEvent, skipped], [{
    presentation: 'degraded',
    gaps: [{ kind: 'missing_sequence', scope }],
  }]), []);
});

test('scenario references fail with repository-relative diagnostic paths', () => {
  const completion = {
    ...structuredClone(baseEvent),
    eventType: 'tool.completed',
    causationId: 'evt_ffffffffffffffffffffffffffffffff',
    payload: {
      requestEventId: 'evt_ffffffffffffffffffffffffffffffff',
      outcome: 'succeeded',
      exitCode: 0,
      effectEventIds: [],
    },
  };
  const diagnostics = validateScenarioDomain({
    directory: 'fixtures/invalid/v1/unit-reference',
    manifest: { targetPhase: 1 },
    events: [{ line: 1, value: completion }],
    expected: null,
  });
  assert.equal(diagnostics[0].code, 'PHASE0_REFERENCE_MISSING');
  assert.equal(diagnostics[0].path, 'fixtures/invalid/v1/unit-reference');
});

test('artifact loading rejects a real-path escape through a directory link', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'patchmesh-phase0-'));
  try {
    const scenario = join(root, 'scenario');
    const outside = join(root, 'outside');
    await mkdir(scenario);
    await mkdir(outside);
    await writeFile(join(outside, 'value.json'), '{}\n', 'utf8');
    try {
      await symlink(outside, join(scenario, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('directory links are unavailable on this host');
        return;
      }
      throw error;
    }
    await assert.rejects(
      safeChild(root, scenario, 'escape/value.json', '/eventsFile'),
      (error) => error instanceof CorpusContractError
        && error.diagnostic.code === 'PHASE0_SCHEMA_INVALID'
        && !error.diagnostic.path.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logical resource and target snapshot digests are deterministic', () => {
  const repositoryId = 'repo_11111111-1111-4111-8111-111111111111';
  const integrationTargetId = 'target_84382d24e7e9d1442e40dd3c53b1d963b79434955dd909fe4d86bf9c891261a0';
  const records = {
    resources: [{
      resourceId: 'res_c0375c9ba513eb7029ccce578c9b58dc6debded701c5afd9708102a3acec3a8b',
      repositoryId,
      kind: 'symbol',
      locator: 'src/auth.ts#typescript:function:authenticate'
    }],
    targetSnapshots: [{
      targetSnapshotId: 'snapshot_bb7d60fbf9da67062adc152cdf0e8a1ad15542c354f2caf14fa63fd0fea3fe87',
      integrationTargetId,
      repositoryId,
      kind: 'branch',
      locator: 'refs/heads/main',
      baseCommit: '1111111111111111111111111111111111111111',
      candidateIds: [],
      digest: 'bb7d60fbf9da67062adc152cdf0e8a1ad15542c354f2caf14fa63fd0fea3fe87'
    }]
  };
  assert.deepEqual(validateIdentityRecords(records), []);
  records.targetSnapshots[0].digest = 'f'.repeat(64);
  assert.equal(validateIdentityRecords(records)[0].code, 'PHASE0_SCHEMA_INVALID');
});

test('logical resource locators are NFC and reject case-folding collisions', () => {
  const repositoryId = 'repo_11111111-1111-4111-8111-111111111111';
  const resource = (locator) => ({
    resourceId: `res_${canonicalDigest([repositoryId, 'file', locator.normalize('NFC')])}`,
    repositoryId,
    kind: 'file',
    locator,
  });
  assert.equal(
    validateIdentityRecords({ resources: [resource('src/cafe\u0301.ts')] })[0].code,
    'PHASE0_SCHEMA_INVALID',
  );
  assert.equal(
    validateIdentityRecords({ resources: [resource('src/Auth.ts'), resource('src/auth.ts')] })[0].code,
    'PHASE0_ID_CONFLICT',
  );
});

test('resource-version values match their declared kind', () => {
  const event = structuredClone(baseEvent);
  event.eventType = 'symbol.read';
  event.payload = {
    resource: {
      resourceId: `res_${'1'.repeat(64)}`,
      repositoryId: event.repositoryId,
      kind: 'symbol',
      locator: 'src/auth.ts#typescript:function:authenticate',
    },
    version: {
      resourceId: `res_${'1'.repeat(64)}`,
      domain: {
        repositoryId: event.repositoryId,
        workspaceId: event.workspaceId,
        worktreeId: event.worktreeId,
      },
      kind: 'symbol_signature',
      value: 'not-a-sha256-value',
      evidenceEventIds: [event.eventId],
    },
    access: 'read',
  };
  assert.equal(validateEventSet([event])[0].code, 'PHASE0_SCHEMA_INVALID');
});

test('Phase 2 rejects unscheduled action and disruptive directive', () => {
  const decision = {
    coordinationAction: 'pause',
    gatewayDirective: 'reject'
  };
  assert.deepEqual(
    validateDecisionCapabilities([decision], 2).map(({ code }) => code),
    ['PHASE0_SCHEMA_INVALID', 'PHASE0_SCHEMA_INVALID'],
  );
  assert.equal(
    validateDecisionCapabilities([], 4)[0].code,
    'PHASE0_SCHEMA_INVALID',
  );
});

test('decision delivery is idempotent and follows guarded state order', () => {
  const target = { agentId: 'agent_b', taskId: 'task_consumer' };
  const pending = {
    eventId: 'evt_00000000000000000000000000000011',
    payload: {
      decisionId: 'decision_00000000000000000000000000000001',
      delivery: {
        deliveryId: 'delivery_00000000000000000000000000000001',
        target,
        state: 'pending',
        eventIds: ['evt_00000000000000000000000000000011']
      }
    }
  };
  const delivered = {
    eventId: 'evt_00000000000000000000000000000012',
    payload: {
      decisionId: pending.payload.decisionId,
      delivery: {
        ...pending.payload.delivery,
        state: 'delivered',
        eventIds: [pending.eventId, 'evt_00000000000000000000000000000012']
      }
    }
  };
  const acknowledged = {
    eventId: 'evt_00000000000000000000000000000013',
    payload: {
      decisionId: pending.payload.decisionId,
      delivery: {
        ...pending.payload.delivery,
        state: 'acknowledged',
        eventIds: [
          pending.eventId,
          delivered.eventId,
          'evt_00000000000000000000000000000013'
        ]
      }
    }
  };

  assert.deepEqual(
    validateDecisionDeliveryEvents([pending, structuredClone(pending), delivered, acknowledged]),
    [],
  );
  assert.equal(
    validateDecisionDeliveryEvents([pending, acknowledged])[0].code,
    'PHASE0_TRANSITION_INVALID',
  );
  const moved = structuredClone(delivered);
  moved.eventId = 'evt_00000000000000000000000000000014';
  moved.payload.decisionId = 'decision_00000000000000000000000000000002';
  moved.payload.delivery.eventIds = [pending.eventId, moved.eventId];
  assert.equal(
    validateDecisionDeliveryEvents([pending, moved])[0].code,
    'PHASE0_ID_CONFLICT',
  );
});

test('validity transitions enforce state and reason guards', () => {
  const record = {
    validityState: 'stale',
    lastTransition: {
      from: 'possibly_stale',
      to: 'stale',
      reason: 'dependency_impact',
      targetSnapshotId: `snapshot_${'1'.repeat(64)}`,
      evidenceEventIds: ['evt_00000000000000000000000000000001']
    }
  };
  assert.equal(
    validateValidityRecords([record])[0].code,
    'PHASE0_TRANSITION_INVALID',
  );
  const obsolete = {
    executionState: 'completed',
    validityState: 'valid',
    targetSnapshotId: `snapshot_${'1'.repeat(64)}`,
    validations: [{
      command: 'node --test',
      outcome: 'passed',
      targetSnapshotId: `snapshot_${'2'.repeat(64)}`,
      resultEventId: 'evt_00000000000000000000000000000002',
    }],
    lastTransition: {
      from: 'revalidating',
      to: 'valid',
      reason: 'validation_passed',
      targetSnapshotId: `snapshot_${'1'.repeat(64)}`,
      evidenceEventIds: ['evt_00000000000000000000000000000002'],
    },
  };
  assert.equal(
    validateValidityRecords([obsolete])[0].code,
    'PHASE0_TRANSITION_INVALID',
  );
});

test('relevant gaps cannot present sufficient coverage', () => {
  const coverage = {
    coverageId: 'coverage_00000000000000000000000000000001',
    scope: 'shell effects',
    modes: ['intercepted', 'unknown'],
    evidenceEventIds: ['evt_00000000000000000000000000000001'],
    gaps: [{
      kind: 'opaque',
      scope: 'prospective writes',
      reason: 'shell command is opaque before execution',
      evidenceEventIds: ['evt_00000000000000000000000000000001']
    }],
    presentation: 'sufficient'
  };
  assert.equal(
    validateCoverageRecords([coverage])[0].code,
    'PHASE0_COVERAGE_OVERCLAIMED',
  );
});

test('canonical snapshots sort entity arrays by stable ID', () => {
  const value = canonicalSnapshot({
    findings: [{ findingId: 'finding_b' }, { findingId: 'finding_a' }],
    coverage: [{ coverageId: 'coverage_b' }, { coverageId: 'coverage_a' }],
  });
  assert.deepEqual(value.findings.map(({ findingId }) => findingId), ['finding_a', 'finding_b']);
  assert.deepEqual(value.coverage.map(({ coverageId }) => coverageId), ['coverage_a', 'coverage_b']);
});
```

- [ ] **Step 2: Run domain tests to verify they fail**

Run:

```powershell
node --test tools/phase0/domain.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/phase0/lib/domain.mjs`.

- [ ] **Step 3: Create the scenario-manifest schema**

Create `schemas/phase0/v1/scenario-manifest.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/scenario-manifest.schema.json",
  "$defs": {
    "expectedOutputs": {
      "type": "object",
      "properties": {
        "graph": { "$ref": "./identities.schema.json#/$defs/logicalPath" },
        "findings": { "$ref": "./identities.schema.json#/$defs/logicalPath" },
        "decisions": { "$ref": "./identities.schema.json#/$defs/logicalPath" },
        "validity": { "$ref": "./identities.schema.json#/$defs/logicalPath" },
        "coverage": { "$ref": "./identities.schema.json#/$defs/logicalPath" }
      },
      "required": ["graph", "findings", "decisions", "validity", "coverage"],
      "additionalProperties": false
    },
    "variant": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        "eventsFile": { "$ref": "./identities.schema.json#/$defs/logicalPath" },
        "equivalentTo": { "type": "string", "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
        "expected": { "$ref": "#/$defs/expectedOutputs" }
      },
      "required": ["name", "eventsFile", "equivalentTo", "expected"],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "schemaVersion": { "const": 1 },
    "scenarioId": { "type": "string", "pattern": "^scenario_[a-z0-9]+(?:_[a-z0-9]+)*$" },
    "title": { "type": "string", "pattern": "^\\S(?:.*\\S)?$" },
    "targetPhase": { "enum": [0, 1, 2, 3] },
    "kind": { "enum": ["positive", "negative"] },
    "eventsFile": { "$ref": "./identities.schema.json#/$defs/logicalPath" },
    "expected": {
      "oneOf": [
        { "$ref": "#/$defs/expectedOutputs" },
        { "type": "null" }
      ]
    },
    "variants": {
      "type": "array",
      "items": { "$ref": "#/$defs/variant" },
      "uniqueItems": true
    },
    "expectedError": {
      "oneOf": [
        {
          "enum": [
            "PHASE0_SCHEMA_INVALID",
            "PHASE0_SCHEMA_UNSUPPORTED",
            "PHASE0_SCHEMA_KEYWORD_UNSUPPORTED",
            "PHASE0_REFERENCE_MISSING",
            "PHASE0_ID_CONFLICT",
            "PHASE0_TRANSITION_INVALID",
            "PHASE0_COVERAGE_OVERCLAIMED",
            "PHASE0_SECRET_PATTERN"
          ]
        },
        { "type": "null" }
      ]
    }
  },
  "required": [
    "schemaVersion",
    "scenarioId",
    "title",
    "targetPhase",
    "kind",
    "eventsFile",
    "expected",
    "variants",
    "expectedError"
  ],
  "additionalProperties": false
}
```

- [ ] **Step 4: Implement deterministic artifact loading**

Create `tools/phase0/lib/corpus.mjs` with:

```javascript
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { diagnostic } from './diagnostics.mjs';

function normalized(path) {
  return path.replaceAll('\\', '/');
}

export class CorpusContractError extends Error {
  constructor(value) {
    super(value.message);
    this.name = 'CorpusContractError';
    this.diagnostic = value;
  }
}

function contractError(root, path, pointer, message) {
  return new CorpusContractError(diagnostic(
    'PHASE0_SCHEMA_INVALID',
    normalized(relative(root, path)),
    pointer,
    message,
  ));
}

export async function safeChild(root, directory, child, pointer) {
  const base = resolve(directory);
  const target = resolve(directory, child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw contractError(root, join(directory, 'manifest.json'), pointer, 'artifact path escapes scenario directory');
  }
  let realBase;
  let realTarget;
  try {
    [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw contractError(root, target, '', 'required scenario artifact is missing');
    }
    throw error;
  }
  if (realTarget !== realBase && !realTarget.startsWith(`${realBase}${sep}`)) {
    throw contractError(root, join(directory, 'manifest.json'), pointer, 'artifact real path escapes scenario directory');
  }
  return target;
}

export async function walkFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const groups = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(path) : [path];
    }));
  return groups.flat();
}

export async function readJson(root, path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw contractError(root, path, '', 'invalid JSON');
    }
    if (error.code === 'ENOENT') {
      throw contractError(root, path, '', 'required JSON artifact is missing');
    }
    throw error;
  }
}

export async function readNdjson(root, path) {
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw contractError(root, path, '', 'required NDJSON artifact is missing');
    }
    throw error;
  }
  const records = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue;
    try {
      records.push({ line: index + 1, value: JSON.parse(line) });
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw contractError(root, path, `/line/${index + 1}`, 'invalid NDJSON');
      }
      throw error;
    }
  }
  return records;
}

export async function discoverScenarioDirectories(root, relativeDirectory) {
  const parent = join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function loadScenario(root, directory) {
  const manifest = await readJson(root, join(directory, 'manifest.json'));
  const loadExpected = async (paths, pointer = '/expected') => ({
    graph: await readJson(root, await safeChild(root, directory, paths.graph, `${pointer}/graph`)),
    findings: await readJson(root, await safeChild(root, directory, paths.findings, `${pointer}/findings`)),
    decisions: await readJson(root, await safeChild(root, directory, paths.decisions, `${pointer}/decisions`)),
    validity: await readJson(root, await safeChild(root, directory, paths.validity, `${pointer}/validity`)),
    coverage: await readJson(root, await safeChild(root, directory, paths.coverage, `${pointer}/coverage`)),
  });
  const events = await readNdjson(root, await safeChild(root, directory, manifest.eventsFile, '/eventsFile'));
  const expected = manifest.expected === null ? null : await loadExpected(manifest.expected);
  const variants = await Promise.all(manifest.variants.map(async (variant) => ({
    name: variant.name,
    equivalentTo: variant.equivalentTo,
    events: await readNdjson(root, await safeChild(root, directory, variant.eventsFile, `/variants/${variant.name}/eventsFile`)),
    expected: await loadExpected(variant.expected, `/variants/${variant.name}/expected`),
  })));
  return {
    directory: normalized(relative(root, directory)),
    manifest,
    events,
    expected,
    variants,
  };
}
```

`readNdjson` retains one-based line numbers for diagnostics. JSON/NDJSON syntax,
missing required artifacts, lexical escapes, and real-path/symlink escapes become
`CorpusContractError` values carrying sanitized `PHASE0_SCHEMA_INVALID` diagnostics;
they are contract-invalid exit-1 results, not raw exception text or tool failures. A
negative manifest may return `expected: null`; every loaded artifact's real path stays
inside its scenario directory.

- [ ] **Step 5: Implement domain invariants**

Create `tools/phase0/lib/domain.mjs` and export the five functions imported by the
tests plus `validateScenarioDomain(scenario)`.

Put the imports first, followed by these exact constant maps:

```javascript
import { canonicalDigest, canonicalize } from './canonical-json.mjs';
import { diagnostic, sortDiagnostics } from './diagnostics.mjs';

const ACTIONS_BY_PHASE = new Map([
  [0, new Set()],
  [1, new Set(['record'])],
  [2, new Set(['record', 'notify', 'request_recheck', 'mark_possibly_stale', 'request_revalidation'])],
  [3, new Set(['record', 'notify', 'request_recheck', 'mark_possibly_stale', 'request_revalidation'])],
]);

const DIRECTIVES_BY_PHASE = new Map([
  [0, new Set()],
  [1, new Set(['allow'])],
  [2, new Set(['allow', 'allow_with_notice'])],
  [3, new Set(['allow', 'allow_with_notice'])],
]);

const VALIDITY_TRANSITIONS = new Map([
  ['unassessed->valid', new Set(['validation_passed'])],
  ['unassessed->possibly_stale', new Set(['dependency_impact'])],
  ['valid->possibly_stale', new Set(['dependency_impact'])],
  ['possibly_stale->revalidating', new Set(['validation_started'])],
  ['revalidating->valid', new Set(['validation_passed'])],
  ['revalidating->stale', new Set(['validation_failed', 'deterministic_proof'])],
  ['revalidating->possibly_stale', new Set(['validation_inconclusive', 'validation_interrupted', 'target_superseded'])],
]);
```

After those constants, add this complete implementation:

```javascript
function issue(code, pointer, message, path = '<domain>') {
  return diagnostic(code, path, pointer, message);
}

function uniqueEvents(events) {
  const byId = new Map();
  const diagnostics = [];
  for (const event of events) {
    const digest = canonicalDigest(event);
    const previous = byId.get(event.eventId);
    if (!previous) {
      byId.set(event.eventId, { digest, event });
    } else if (previous.digest !== digest) {
      diagnostics.push(issue(
        'PHASE0_ID_CONFLICT',
        `/events/${event.eventId}`,
        `event ID ${event.eventId} has conflicting canonical content`,
      ));
    }
  }
  return { diagnostics, events: [...byId.values()].map(({ event }) => event) };
}

function visitObjects(value, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item) => visitObjects(item, visitor));
    return;
  }
  if (value && typeof value === 'object') {
    visitor(value);
    Object.values(value).forEach((item) => visitObjects(item, visitor));
  }
}

function versionValueIsValid(version) {
  if (version.kind === 'deleted') return version.value === null;
  if (typeof version.value !== 'string') return false;
  if (version.kind === 'git_commit' || version.kind === 'git_blob') {
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(version.value);
  }
  if (version.kind === 'content_hash' || version.kind === 'symbol_signature') {
    return /^sha256:[0-9a-f]{64}$/.test(version.value);
  }
  if (version.kind === 'schema_version' || version.kind === 'api_version') {
    return /^\S(?:.*\S)?$/.test(version.value);
  }
  return false;
}

function producerKey(event) {
  return `${event.source.kind}:${event.source.sourceId}:${event.source.instanceId}`;
}

export function validateSequenceCoverage(events, coverageRecords) {
  const diagnostics = [];
  const byProducer = new Map();
  for (const event of events) {
    if (event.sourceSequence === null) continue;
    const key = producerKey(event);
    const values = byProducer.get(key) ?? [];
    values.push(event.sourceSequence);
    byProducer.set(key, values);
  }
  const gaps = coverageRecords.flatMap((coverage) => coverage.gaps.map((gap) => ({
    presentation: coverage.presentation,
    ...gap,
  })));
  for (const [key, values] of [...byProducer].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...new Set(values)].sort((left, right) => left - right);
    for (let value = sorted[0]; value < sorted.at(-1); value += 1) {
      if (sorted.includes(value)) continue;
      const scope = `source:${key}:sequence:${value}`;
      const declared = gaps.some((gap) =>
        gap.kind === 'missing_sequence'
        && gap.scope === scope
        && (gap.presentation === 'degraded' || gap.presentation === 'unknown'));
      if (!declared) {
        diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${scope}`, 'source-sequence gap lacks degraded coverage evidence'));
      }
    }
  }
  return sortDiagnostics(diagnostics);
}

export function validateEventSet(inputEvents) {
  const { diagnostics, events } = uniqueEvents(inputEvents);
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const sequences = new Map();
  const roots = new Map();

  for (const event of events) {
    if (event.causationId === event.eventId) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'event cannot cause itself'));
    } else if (event.causationId !== null) {
      const parent = byId.get(event.causationId);
      if (!parent) {
        diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/causationId`, 'causal parent is absent'));
      } else if (parent.correlationId !== event.correlationId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/correlationId`, 'child must inherit parent correlation ID'));
      } else if (producerKey(parent) === producerKey(event)
          && parent.sourceSequence !== null
          && event.sourceSequence !== null
          && event.sourceSequence <= parent.sourceSequence) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/sourceSequence`, 'causal child must advance its producer sequence'));
      }
    } else {
      const previousRoot = roots.get(event.correlationId);
      if (previousRoot && previousRoot !== event.eventId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'one correlation cannot have multiple roots'));
      } else {
        roots.set(event.correlationId, event.eventId);
      }
    }

    if (event.sourceSequence !== null) {
      const key = `${producerKey(event)}:${event.sourceSequence}`;
      const previous = sequences.get(key);
      if (previous && previous !== event.eventId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/sourceSequence`, 'source sequence is duplicated in one source instance'));
      } else {
        sequences.set(key, event.eventId);
      }
    }

    visitObjects(event.payload, (value) => {
      if (value.domain && value.resourceId && Object.hasOwn(value, 'value')) {
        if (value.domain.repositoryId !== event.repositoryId) {
          diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'resource version crosses repository domain'));
        }
        if (!versionValueIsValid(value)) {
          diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'resource-version value does not match its declared kind'));
        }
      }
      if (value.repositoryId && value.resourceId && value.repositoryId !== event.repositoryId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'logical resource crosses event repository'));
      }
    });

    if (event.eventType === 'attribution.corrected') {
      const target = byId.get(event.payload.targetEventId);
      if (!target) {
        diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/payload/targetEventId`, 'attribution target is absent'));
      } else if (target.repositoryId !== event.repositoryId
          || target.correlationId !== event.correlationId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/targetEventId`, 'attribution target crosses repository or correlation'));
      }
      if (event.payload.attributedAgentId === null && event.payload.attributedTaskId === null) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'attribution correction must supply an identity'));
      }
    }
    if (event.eventType === 'file.read' || event.eventType === 'symbol.read') {
      if (event.payload.resource.resourceId !== event.payload.version.resourceId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/version/resourceId`, 'observed version names another resource'));
      }
    }
    if (event.eventType === 'file.changed' || event.eventType === 'symbol.changed') {
      for (const version of [event.payload.beforeVersion, event.payload.afterVersion]) {
        if (version !== null && version.resourceId !== event.payload.resource.resourceId) {
          diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'changed version names another resource'));
        }
      }
    }
  }

  for (const event of events) {
    const seen = new Set([event.eventId]);
    let current = event;
    while (current.causationId !== null) {
      if (seen.has(current.causationId)) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'causal graph contains a cycle'));
        break;
      }
      seen.add(current.causationId);
      current = byId.get(current.causationId);
      if (!current) break;
    }
  }
  return sortDiagnostics(diagnostics);
}

export function validateIdentityRecords({ resources = [], targetSnapshots = [] }) {
  const diagnostics = [];
  const foldedLocators = new Map();
  for (const resource of resources) {
    const normalizedLocator = resource.locator.normalize('NFC');
    const expected = `res_${canonicalDigest([
      resource.repositoryId,
      resource.kind,
      normalizedLocator,
    ])}`;
    if (resource.locator !== normalizedLocator) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/resources/${resource.resourceId}/locator`, 'logical resource locator must be Unicode NFC'));
    }
    const foldedKey = `${resource.repositoryId}:${normalizedLocator.toLowerCase()}`;
    const previousLocator = foldedLocators.get(foldedKey);
    if (previousLocator !== undefined && previousLocator !== normalizedLocator) {
      diagnostics.push(issue('PHASE0_ID_CONFLICT', `/resources/${resource.resourceId}/locator`, 'case-folding path collision is forbidden'));
    } else {
      foldedLocators.set(foldedKey, normalizedLocator);
    }
    if (resource.resourceId !== expected) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/resources/${resource.resourceId}`, 'logical resource digest does not match identity tuple'));
    }
  }
  for (const snapshot of targetSnapshots) {
    const digestInput = {
      integrationTargetId: snapshot.integrationTargetId,
      repositoryId: snapshot.repositoryId,
      kind: snapshot.kind,
      locator: snapshot.locator,
      baseCommit: snapshot.baseCommit,
      candidateIds: snapshot.candidateIds,
    };
    const expectedDigest = canonicalDigest(digestInput);
    if (snapshot.digest !== expectedDigest
        || snapshot.targetSnapshotId !== `snapshot_${expectedDigest}`) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/targetSnapshots/${snapshot.targetSnapshotId}/digest`, 'target snapshot digest is invalid'));
    }
  }
  return sortDiagnostics(diagnostics);
}

export function validateDecisionCapabilities(decisions, phase) {
  const diagnostics = [];
  const actions = ACTIONS_BY_PHASE.get(phase);
  const directives = DIRECTIVES_BY_PHASE.get(phase);
  if (!actions || !directives) {
    return [issue('PHASE0_SCHEMA_INVALID', '/targetPhase', 'target phase is outside the Phase 0 contract range')];
  }
  for (const [index, decision] of decisions.entries()) {
    if (!actions.has(decision.coordinationAction)) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/coordinationAction`, 'action is unavailable in target phase'));
    }
    if (!directives.has(decision.gatewayDirective)) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/gatewayDirective`, 'directive is unavailable in target phase'));
    }
    if (typeof decision.confidence === 'number'
        && (decision.confidence < 0 || decision.confidence > 1)) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/confidence`, 'confidence must be within zero and one'));
    }
    if (decision.target
        && decision.target.agentId === null
        && decision.target.taskId === null) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/target`, 'decision target requires agent or task'));
    }
  }
  return sortDiagnostics(diagnostics);
}

export function validateDecisionDeliveryEvents(inputEvents) {
  const { diagnostics, events } = uniqueEvents(inputEvents);
  const byDelivery = new Map();
  const allowed = new Map([
    ['pending', new Set(['pending', 'delivered', 'failed'])],
    ['delivered', new Set(['delivered', 'acknowledged'])],
    ['acknowledged', new Set(['acknowledged'])],
    ['failed', new Set(['failed'])],
  ]);

  for (const event of events) {
    const delivery = event.payload.delivery;
    const previous = byDelivery.get(delivery.deliveryId);
    if (!previous) {
      if (delivery.state !== 'pending') {
        diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/deliveries/${delivery.deliveryId}`, 'delivery must begin pending'));
      }
    } else {
      if (previous.decisionId !== event.payload.decisionId) {
        diagnostics.push(issue('PHASE0_ID_CONFLICT', `/deliveries/${delivery.deliveryId}/decisionId`, 'delivery moved to another decision'));
      }
      if (canonicalize(previous.delivery.target) !== canonicalize(delivery.target)) {
        diagnostics.push(issue('PHASE0_ID_CONFLICT', `/deliveries/${delivery.deliveryId}/target`, 'delivery target changed'));
      }
      if (!allowed.get(previous.delivery.state).has(delivery.state)) {
        diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/deliveries/${delivery.deliveryId}/state`, 'delivery transition is invalid'));
      }
      const expectedHistory = [...previous.delivery.eventIds, event.eventId];
      if (canonicalize(expectedHistory) !== canonicalize(delivery.eventIds)) {
        diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/deliveries/${delivery.deliveryId}/eventIds`, 'delivery history must append exactly the current event'));
      }
    }
    if (delivery.eventIds.at(-1) !== event.eventId) {
      diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/deliveries/${delivery.deliveryId}/eventIds`, 'delivery history must end with current event'));
    }
    byDelivery.set(delivery.deliveryId, {
      decisionId: event.payload.decisionId,
      delivery,
    });
  }
  return sortDiagnostics(diagnostics);
}

export function validateValidityRecords(records) {
  const diagnostics = [];
  const outcomeByReason = new Map([
    ['validation_started', 'started'],
    ['validation_passed', 'passed'],
    ['validation_failed', 'failed'],
    ['validation_inconclusive', 'inconclusive'],
    ['validation_interrupted', 'interrupted'],
  ]);
  for (const [index, record] of records.entries()) {
    const transition = record.lastTransition;
    if (transition === null) {
      if (record.validityState !== 'unassessed') {
        diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'only unassessed may omit an initial transition'));
      }
      continue;
    }
    const reasons = VALIDITY_TRANSITIONS.get(`${transition.from}->${transition.to}`);
    if (!reasons || !reasons.has(transition.reason)
        || record.validityState !== transition.to) {
      diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'validity transition or guard is invalid'));
    }
    if (record.validityState !== 'unassessed' && record.executionState !== 'completed') {
      diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/executionState`, 'assessed validity requires a completed work product'));
    }
    const expectedOutcome = outcomeByReason.get(transition.reason);
    if (expectedOutcome) {
      const validation = (record.validations ?? []).find((candidate) =>
        candidate.outcome === expectedOutcome
        && candidate.targetSnapshotId === record.targetSnapshotId
        && transition.evidenceEventIds.includes(candidate.resultEventId));
      if (!validation || transition.targetSnapshotId !== record.targetSnapshotId) {
        diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/validations`, 'transition lacks a matching current-target validation result'));
      }
    } else if (transition.reason === 'target_superseded') {
      const obsolete = (record.validations ?? []).find((candidate) =>
        candidate.targetSnapshotId !== record.targetSnapshotId
        && transition.evidenceEventIds.includes(candidate.resultEventId));
      if (!obsolete) {
        diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/validations`, 'superseded transition requires an obsolete-target result'));
      }
    } else if (transition.targetSnapshotId !== record.targetSnapshotId) {
      diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition/targetSnapshotId`, 'transition must name the current target snapshot'));
    }
  }
  return sortDiagnostics(diagnostics);
}

export function validateCoverageRecords(records) {
  const diagnostics = [];
  for (const [index, record] of records.entries()) {
    const direct = record.modes.includes('intercepted') || record.modes.includes('verified');
    if (record.presentation === 'sufficient'
        && (record.gaps.length > 0 || record.modes.includes('unknown') || !direct)) {
      diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${index}/presentation`, 'relevant gap cannot present sufficient coverage'));
    }
    if (record.presentation === 'degraded'
        && record.gaps.length === 0 && !record.modes.includes('unknown')) {
      diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${index}/presentation`, 'degraded coverage requires an explicit gap or unknown mode'));
    }
    if (record.presentation === 'unknown' && direct) {
      diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${index}/presentation`, 'direct evidence cannot present wholly unknown coverage'));
    }
  }
  return sortDiagnostics(diagnostics);
}

function stableIndex(items, idKey, pointer, diagnostics) {
  const result = new Map();
  for (const [index, item] of items.entries()) {
    const id = item[idKey];
    if (result.has(id)) {
      diagnostics.push(issue('PHASE0_ID_CONFLICT', `${pointer}/${index}/${idKey}`, `${idKey} must be unique`));
    } else {
      result.set(id, item);
    }
  }
  return result;
}

function visitPointers(value, pointer, visitor) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitPointers(item, `${pointer}/${index}`, visitor));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visitor(value, pointer);
  for (const key of Object.keys(value).sort()) {
    visitPointers(value[key], `${pointer}/${key}`, visitor);
  }
}

function validateEventReferenceTree(value, pointer, eventById, diagnostics) {
  const singular = new Set(['requestEventId', 'resultEventId', 'targetEventId']);
  const plural = new Set(['evidenceEventIds', 'effectEventIds', 'eventIds']);
  visitPointers(value, pointer, (record, recordPointer) => {
    for (const key of singular) {
      if (typeof record[key] === 'string' && !eventById.has(record[key])) {
        diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `${recordPointer}/${key}`, 'referenced event is absent'));
      }
    }
    for (const key of plural) {
      for (const [index, id] of (record[key] ?? []).entries()) {
        if (!eventById.has(id)) {
          diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `${recordPointer}/${key}/${index}`, 'referenced event is absent'));
        }
      }
    }
  });
}

function validateVersionEvidence(value, pointer, eventById, diagnostics) {
  visitPointers(value, pointer, (record, recordPointer) => {
    if (!record.domain || !record.resourceId || !Object.hasOwn(record, 'value')) return;
    for (const id of record.evidenceEventIds ?? []) {
      const evidence = eventById.get(id);
      if (!evidence) continue;
      if (evidence.repositoryId !== record.domain.repositoryId
          || evidence.workspaceId !== record.domain.workspaceId
          || evidence.worktreeId !== record.domain.worktreeId) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${recordPointer}/domain`, 'resource-version domain differs from its evidence event'));
      }
    }
  });
}

function validateDependencyRecord(dependency, pointer, resourceById, eventById, diagnostics) {
  if (dependency.dependentVersion.resourceId !== dependency.dependentResourceId
      || dependency.dependencyVersion.resourceId !== dependency.dependencyResourceId) {
    diagnostics.push(issue('PHASE0_SCHEMA_INVALID', pointer, 'dependency endpoint versions must name their logical endpoints'));
  }
  for (const key of ['dependentResourceId', 'dependencyResourceId']) {
    if (!resourceById.has(dependency[key])) {
      diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `${pointer}/${key}`, 'dependency endpoint resource is absent'));
    }
  }
  for (const [index, observation] of dependency.observations.entries()) {
    if (observation.kind !== 'declared' && observation.rule === null) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${pointer}/observations/${index}/rule`, 'observed or inferred provenance requires a versioned rule'));
    }
  }
  validateEventReferenceTree(dependency, pointer, eventById, diagnostics);
  validateVersionEvidence(dependency, pointer, eventById, diagnostics);
}

function intersects(left, right) {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

const ARRAY_ID_KEYS = new Map([
  ['resources', 'resourceId'],
  ['nodes', 'nodeId'],
  ['edges', 'edgeId'],
  ['targetSnapshots', 'targetSnapshotId'],
  ['findings', 'findingId'],
  ['decisions', 'decisionId'],
  ['deliveries', 'deliveryId'],
  ['validity', 'validityId'],
  ['coverage', 'coverageId'],
]);

export function canonicalSnapshot(value, parentKey = '') {
  if (Array.isArray(value)) {
    const result = value.map((item) => canonicalSnapshot(item));
    const idKey = ARRAY_ID_KEYS.get(parentKey);
    return idKey
      ? result.sort((left, right) => left[idKey].localeCompare(right[idKey]))
      : result;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      canonicalSnapshot(value[key], key),
    ]));
  }
  return value;
}

export function validateScenarioDomain(scenario) {
  const events = scenario.events.map(({ value }) => value);
  const diagnostics = [...validateEventSet(events)];
  const eventById = new Map();
  for (const event of events) if (!eventById.has(event.eventId)) eventById.set(event.eventId, event);
  const uniqueEventValues = [...eventById.values()];
  const repositories = new Set(uniqueEventValues.map(({ repositoryId }) => repositoryId));
  if (repositories.size > 1) {
    diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/events', 'one scenario cannot cross repository identities'));
  }

  const workspaces = new Map();
  const worktrees = new Map();
  for (const event of uniqueEventValues) {
    const workspace = workspaces.get(event.workspaceId);
    const association = `${event.repositoryId}:${event.worktreeId}`;
    if (workspace && workspace !== association) {
      diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/workspaceId`, 'workspace identity changed repository or worktree'));
    } else {
      workspaces.set(event.workspaceId, association);
    }
    const repository = worktrees.get(event.worktreeId);
    if (repository && repository !== event.repositoryId) {
      diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/worktreeId`, 'worktree identity changed repository'));
    } else {
      worktrees.set(event.worktreeId, event.repositoryId);
    }
    validateEventReferenceTree(event.payload, `/events/${event.eventId}/payload`, eventById, diagnostics);
    validateVersionEvidence(event.payload, `/events/${event.eventId}/payload`, eventById, diagnostics);

    if (event.eventType === 'tool.completed') {
      const request = eventById.get(event.payload.requestEventId);
      if (request && (request.eventType !== 'tool.requested'
          || request.correlationId !== event.correlationId
          || request.repositoryId !== event.repositoryId
          || request.workspaceId !== event.workspaceId
          || request.worktreeId !== event.worktreeId)) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/requestEventId`, 'tool completion does not match its request domain'));
      }
      for (const effectId of event.payload.effectEventIds) {
        const effect = eventById.get(effectId);
        if (effect && (effect.correlationId !== event.correlationId
            || effect.repositoryId !== event.repositoryId
            || effect.workspaceId !== event.workspaceId
            || effect.worktreeId !== event.worktreeId)) {
          diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/effectEventIds`, 'tool effect crosses request correlation or domain'));
        }
      }
      if (event.causationId !== event.payload.requestEventId
          && !event.payload.effectEventIds.includes(event.causationId)) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'tool completion must be caused by its request or declared effect'));
      }
    }
  }

  const graph = scenario.expected?.graph ?? { resources: [], nodes: [], edges: [], targetSnapshots: [] };
  const declaredResourceById = stableIndex(graph.resources ?? [], 'resourceId', '/graph/resources', diagnostics);
  const resourceById = new Map(declaredResourceById);
  for (const event of uniqueEventValues) {
    visitObjects(event.payload, (value) => {
      if (!value.resourceId || !value.repositoryId || !value.kind || !value.locator) return;
      const previous = resourceById.get(value.resourceId);
      if (previous && canonicalize(previous) !== canonicalize(value)) {
        diagnostics.push(issue('PHASE0_ID_CONFLICT', `/resources/${value.resourceId}`, 'logical resource content conflicts across artifacts'));
      } else if (!previous) {
        resourceById.set(value.resourceId, value);
      }
    });
  }
  const targetById = stableIndex(graph.targetSnapshots ?? [], 'targetSnapshotId', '/graph/targetSnapshots', diagnostics);
  diagnostics.push(...validateIdentityRecords({
    resources: [...resourceById.values()],
    targetSnapshots: [...targetById.values()],
  }));
  for (const resource of resourceById.values()) {
    if (!repositories.has(resource.repositoryId)) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/resources/${resource.resourceId}/repositoryId`, 'resource repository is outside the scenario'));
    }
  }
  for (const snapshot of targetById.values()) {
    if (!repositories.has(snapshot.repositoryId)) {
      diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/targetSnapshots/${snapshot.targetSnapshotId}/repositoryId`, 'target snapshot repository is outside the scenario'));
    }
  }

  const dependencyEvents = uniqueEventValues.filter(({ eventType }) => eventType === 'dependency.changed');
  const dependencyById = stableIndex(
    dependencyEvents.map(({ payload }) => payload.dependency),
    'dependencyId',
    '/dependencies',
    diagnostics,
  );
  for (const dependency of dependencyById.values()) {
    validateDependencyRecord(dependency, `/dependencies/${dependency.dependencyId}`, resourceById, eventById, diagnostics);
  }

  const embeddedDecisions = uniqueEventValues
    .filter(({ eventType }) => eventType === 'decision.created')
    .map(({ payload }) => payload.decision);
  const embeddedValidity = uniqueEventValues
    .filter(({ eventType }) => eventType === 'validity.changed')
    .map(({ payload }) => payload.record);
  const deliveryEvents = uniqueEventValues.filter(({ eventType }) => eventType === 'decision.delivery.changed');
  diagnostics.push(...validateDecisionCapabilities(embeddedDecisions, scenario.manifest.targetPhase));
  diagnostics.push(...validateValidityRecords(embeddedValidity));
  diagnostics.push(...validateDecisionDeliveryEvents(deliveryEvents));
  diagnostics.push(...validateSequenceCoverage(uniqueEventValues, scenario.expected?.coverage ?? []));

  const validityHistory = new Map();
  const validityByWorkProduct = new Map();
  for (const event of uniqueEventValues.filter(({ eventType }) => eventType === 'validity.changed')) {
    const { record, transition } = event.payload;
    if (canonicalize(record.lastTransition) !== canonicalize(transition)) {
      diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/events/${event.eventId}/payload/transition`, 'event transition must equal record lastTransition'));
    }
    const previous = validityHistory.get(record.validityId);
    if (previous && (previous.taskId !== record.taskId
        || previous.workProductId !== record.workProductId
        || transition.from !== previous.validityState)) {
      diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/payload/record`, 'validity identity or transition continuity changed'));
    }
    const priorValidity = validityByWorkProduct.get(record.workProductId);
    if (priorValidity && priorValidity !== record.validityId) {
      diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/payload/record/workProductId`, 'one work product has multiple validity identities'));
    }
    validityHistory.set(record.validityId, record);
    validityByWorkProduct.set(record.workProductId, record.validityId);
  }

  if (scenario.expected) {
    const findingById = stableIndex(scenario.expected.findings, 'findingId', '/findings', diagnostics);
    const decisionById = stableIndex(scenario.expected.decisions, 'decisionId', '/decisions', diagnostics);
    const validityById = stableIndex(scenario.expected.validity, 'validityId', '/validity', diagnostics);
    const coverageById = stableIndex(scenario.expected.coverage, 'coverageId', '/coverage', diagnostics);
    const nodeById = stableIndex(graph.nodes, 'nodeId', '/graph/nodes', diagnostics);
    stableIndex(graph.edges, 'edgeId', '/graph/edges', diagnostics);
    const deliveries = scenario.expected.decisions.flatMap(({ deliveries: values }) => values);
    stableIndex(deliveries, 'deliveryId', '/decisions/deliveries', diagnostics);

    diagnostics.push(...validateDecisionCapabilities(scenario.expected.decisions, scenario.manifest.targetPhase));
    diagnostics.push(...validateValidityRecords(scenario.expected.validity));
    diagnostics.push(...validateCoverageRecords(scenario.expected.coverage));
    validateEventReferenceTree(scenario.expected, '/expected', eventById, diagnostics);
    validateVersionEvidence(scenario.expected, '/expected', eventById, diagnostics);

    const agentIds = new Set([
      ...uniqueEventValues.flatMap((event) => [event.agentId]).filter(Boolean),
      ...graph.nodes.filter(({ kind }) => kind === 'agent').map(({ entityId }) => entityId),
    ]);
    const taskIds = new Set([
      ...uniqueEventValues.flatMap((event) => [event.taskId]).filter(Boolean),
      ...graph.nodes.filter(({ kind }) => kind === 'task').map(({ entityId }) => entityId),
    ]);
    const completedWorkProductIds = new Set(uniqueEventValues
      .filter(({ eventType }) => eventType === 'task.completed')
      .map(({ payload }) => payload.workProductId));
    const workProductIds = new Set(completedWorkProductIds);
    for (const decision of scenario.expected.decisions) {
      if (decision.target.agentId && !agentIds.has(decision.target.agentId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/target/agentId`, 'target agent is absent'));
      if (decision.target.taskId && !taskIds.has(decision.target.taskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/target/taskId`, 'target task is absent'));
      const finding = findingById.get(decision.findingId);
      if (!finding) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/findingId`, 'source finding is absent'));
      for (const id of decision.coverageIds) {
        if (!coverageById.has(id)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/coverageIds`, 'coverage record is absent'));
      }
      if (finding && finding.coverageIds.some((id) => !decision.coverageIds.includes(id))) {
        diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/decisions/${decision.decisionId}/coverageIds`, 'decision dropped source-finding coverage evidence'));
      }
      for (const delivery of decision.deliveries) {
        if (canonicalize(delivery.target) !== canonicalize(decision.target)) {
          diagnostics.push(issue('PHASE0_ID_CONFLICT', `/decisions/${decision.decisionId}/deliveries/${delivery.deliveryId}/target`, 'delivery target differs from decision target'));
        }
      }
    }
    for (const event of deliveryEvents) {
      const decision = decisionById.get(event.payload.decisionId)
        ?? embeddedDecisions.find(({ decisionId }) => decisionId === event.payload.decisionId);
      if (!decision) {
        diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/payload/decisionId`, 'delivery decision is absent'));
      } else if (canonicalize(event.payload.delivery.target) !== canonicalize(decision.target)) {
        diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/payload/delivery/target`, 'delivery event target differs from decision target'));
      }
    }

    for (const finding of scenario.expected.findings) {
      if (!resourceById.has(finding.subjectResourceId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/subjectResourceId`, 'finding subject resource is absent'));
      if (finding.affectedTaskId !== null && !taskIds.has(finding.affectedTaskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/affectedTaskId`, 'affected task is absent'));
      for (const id of finding.dependencyIds) if (!dependencyById.has(id)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/dependencyIds`, 'finding dependency is absent'));
      for (const id of finding.coverageIds) {
        const coverage = coverageById.get(id);
        if (!coverage) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/coverageIds`, 'finding coverage is absent'));
        else if (!intersects(finding.evidenceEventIds, coverage.evidenceEventIds)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/findings/${finding.findingId}/coverageIds`, 'finding coverage is unrelated to finding evidence'));
      }
    }

    for (const decision of scenario.expected.decisions) {
      for (const id of decision.coverageIds) {
        const coverage = coverageById.get(id);
        if (coverage && !intersects(decision.evidenceEventIds, coverage.evidenceEventIds)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/decisions/${decision.decisionId}/coverageIds`, 'decision coverage is unrelated to decision evidence'));
      }
    }
    for (const validity of scenario.expected.validity) {
      if (!completedWorkProductIds.has(validity.workProductId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/workProductId`, 'validity work product has no completion event'));
      workProductIds.add(validity.workProductId);
      if (!taskIds.has(validity.taskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/taskId`, 'validity task is absent'));
      if (!targetById.has(validity.targetSnapshotId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/targetSnapshotId`, 'validity target snapshot is absent'));
      for (const id of validity.coverageIds) {
        const coverage = coverageById.get(id);
        if (!coverage) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/coverageIds`, 'coverage record is absent'));
        else if (!intersects(validity.evidenceEventIds, coverage.evidenceEventIds)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/validity/${validity.validityId}/coverageIds`, 'validity coverage is unrelated to validity evidence'));
      }
      for (const version of validity.observedDependencies) if (!resourceById.has(version.resourceId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/observedDependencies`, 'observed dependency resource is absent'));
      for (const validation of validity.validations) if (!targetById.has(validation.targetSnapshotId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/validations`, 'validation target snapshot is absent'));
      if (validity.lastTransition !== null && !targetById.has(validity.lastTransition.targetSnapshotId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${validity.validityId}/lastTransition/targetSnapshotId`, 'transition target snapshot is absent'));
    }

    for (const event of uniqueEventValues.filter(({ eventType }) => eventType === 'task.completed')) {
      if (!targetById.has(event.payload.targetSnapshotId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/payload/targetSnapshotId`, 'task target snapshot is absent'));
      for (const id of event.payload.resourceIds) if (!resourceById.has(id)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/payload/resourceIds`, 'task resource is absent'));
    }

    const entities = new Map([
      ['agent', agentIds],
      ['task', taskIds],
      ['resource', new Set(declaredResourceById.keys())],
      ['work_product', workProductIds],
      ['target_snapshot', new Set(targetById.keys())],
      ['finding', new Set(findingById.keys())],
      ['decision', new Set(decisionById.keys())],
    ]);
    for (const node of graph.nodes) {
      if (!entities.get(node.kind).has(node.entityId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/nodes/${node.nodeId}/entityId`, 'graph node entity is absent'));
    }
    const edgeKinds = new Map([
      ['depends_on', ['resource', 'resource']],
      ['observed', [['agent', 'task'], ['resource']]],
      ['produced', ['task', 'work_product']],
      ['affects', ['finding', 'task']],
      ['derived_from', ['decision', 'finding']],
      ['targets', ['decision', ['agent', 'task', 'target_snapshot']]],
    ]);
    for (const edge of graph.edges) {
      const from = nodeById.get(edge.fromNodeId);
      const to = nodeById.get(edge.toNodeId);
      if (!from || !to) {
        diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}`, 'graph edge endpoint is absent'));
        continue;
      }
      const expectedKinds = edgeKinds.get(edge.kind);
      const fromKinds = Array.isArray(expectedKinds[0]) ? expectedKinds[0] : [expectedKinds[0]];
      const toKinds = Array.isArray(expectedKinds[1]) ? expectedKinds[1] : [expectedKinds[1]];
      if (!fromKinds.includes(from.kind) || !toKinds.includes(to.kind)) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/graph/edges/${edge.edgeId}/kind`, 'edge endpoints do not match edge kind'));
      }
      if (edge.kind === 'depends_on') {
        if (edge.dependency === null) {
          diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/dependency`, 'depends_on edge requires dependency evidence'));
        } else {
          const source = dependencyById.get(edge.dependency.dependencyId);
          if (!source || canonicalize(source) !== canonicalize(edge.dependency)
              || from.entityId !== edge.dependency.dependentResourceId
              || to.entityId !== edge.dependency.dependencyResourceId) {
            diagnostics.push(issue('PHASE0_ID_CONFLICT', `/graph/edges/${edge.edgeId}/dependency`, 'graph dependency differs from its event record or endpoints'));
          }
        }
      } else if (edge.dependency !== null) {
        diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/graph/edges/${edge.edgeId}/dependency`, 'non-dependency edge must use null dependency'));
      }
    }

    for (const coverage of scenario.expected.coverage) {
      const evidence = coverage.evidenceEventIds.map((id) => eventById.get(id)).filter(Boolean);
      if (coverage.modes.includes('intercepted')
          && !evidence.some(({ eventType }) => eventType === 'tool.requested')) {
        diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${coverage.coverageId}/modes`, 'intercepted mode lacks request evidence'));
      }
      if (coverage.modes.includes('verified')
          && !evidence.some(({ eventType }) => ['tool.completed', 'file.read', 'file.changed', 'symbol.read', 'symbol.changed'].includes(eventType))) {
        diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${coverage.coverageId}/modes`, 'verified mode lacks observation or effect evidence'));
      }
    }
  }
  const path = scenario.directory;
  return sortDiagnostics(diagnostics.map((value) => value.path === '<domain>'
    ? diagnostic(value.code, path, value.pointer, value.message)
    : value));
}
```

Implement these rules without implicit repair:

1. `validateEventSet` deduplicates identical events by canonical digest, emits
   `PHASE0_ID_CONFLICT` for conflicting content, verifies every `causationId` exists,
   requires a child to inherit its parent's correlation ID, rejects self-causation,
   and checks source sequence uniqueness per `{kind, sourceId, instanceId}` producer
   instance.
2. `validateIdentityRecords` recomputes `resourceId` as SHA-256 of canonical
   `[repositoryId, kind, NFC locator]` and recomputes the target snapshot digest from
   the closed snapshot object without `targetSnapshotId` or `digest`. The resource ID,
   prefixed snapshot ID, and digest must match. `integrationTargetId` is opaque and is
   checked only for valid syntax and stable references.
3. A resource, its version domain, target snapshot, and event envelope use one
   repository ID. Resource-version values obey the exact per-kind formats from the
   identity protocol; resource/version IDs must agree.
4. `attribution.corrected` references an existing event and supplies at least one
   non-null corrected identity.
5. `validateDecisionCapabilities` uses the manifest's target phase. Phase 4 is not
   accepted by Phase 0 corpus validation because its action policy is undesigned.
6. Confidence values must be in `[0, 1]` even though the supported schema subset has
   no `maximum` keyword.
7. A decision target must contain a non-null agent or task ID.
8. `validateValidityRecords` allows `lastTransition: null` only for an initial
   `unassessed` record. Otherwise it uses `VALIDITY_TRANSITIONS` and requires
   `record.validityState === lastTransition.to`.
9. `validateCoverageRecords` emits `PHASE0_COVERAGE_OVERCLAIMED` when `sufficient`
   has any gap or `unknown` mode, or when `unknown` presentation has direct
   `intercepted` or `verified` evidence.
10. `canonicalSnapshot` recursively sorts object keys and sorts arrays named `nodes`,
   `edges`, `targetSnapshots`, `findings`, `decisions`, `deliveries`, `validity`, and
   `coverage` by their stable ID property. It preserves event and candidate order.
11. `validateDecisionDeliveryEvents` deduplicates byte-equivalent delivery events,
    requires one stable target per delivery ID, and permits only
    `pending -> delivered -> acknowledged` or `pending -> failed`. A duplicate state
    event is a no-op; replay validation never sends a message.
12. `validateScenarioDomain` combines all applicable checks and returns sorted
    diagnostics.

Use `diagnostic`, `sortDiagnostics`, `canonicalDigest`, and `canonicalize` from the
existing modules. Messages name the violated rule and stable ID but never echo payload
values.

- [ ] **Step 6: Run the domain tests and schema validator**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs
node tools/phase0/validate.mjs
```

Expected: twenty-five tests pass and the current schema corpus remains valid (or one
link-confinement test is explicitly skipped only when the host forbids directory
links).

- [ ] **Step 7: Commit corpus and domain validation**

```powershell
git add schemas/phase0/v1/scenario-manifest.schema.json tools/phase0/domain.test.mjs tools/phase0/lib/corpus.mjs tools/phase0/lib/domain.mjs
git commit -m "feat: validate phase 0 domain invariants"
```

### Task 7: Add relevant and irrelevant golden scenarios

**Files:**
- Create: `tools/phase0/corpus.test.mjs`
- Modify: `tools/phase0/validate.mjs`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/manifest.json`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/events.ndjson`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/expected-graph.json`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/expected-findings.json`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/expected-decisions.json`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/expected-validity.json`
- Create: `fixtures/scenarios/v1/relevant-exported-contract/expected-coverage.json`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/manifest.json`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/events.ndjson`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/expected-graph.json`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/expected-findings.json`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/expected-decisions.json`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/expected-validity.json`
- Create: `fixtures/scenarios/v1/irrelevant-concurrent-change/expected-coverage.json`

- [ ] **Step 1: Write a failing corpus integration test**

Create `tools/phase0/corpus.test.mjs` with:

```javascript
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadPhase0Corpus, validatePhase0Corpus } from './validate.mjs';

test('relevant and irrelevant golden scenarios are complete and valid', async () => {
  const corpus = await loadPhase0Corpus(new URL('../..', import.meta.url));
  const ids = corpus.positiveScenarios.map(({ manifest }) => manifest.scenarioId);
  assert.deepEqual(
    ids.filter((id) => [
      'scenario_irrelevant_concurrent_change',
      'scenario_relevant_exported_contract',
    ].includes(id)).sort(),
    ['scenario_irrelevant_concurrent_change', 'scenario_relevant_exported_contract'],
  );
  assert.deepEqual(await validatePhase0Corpus(corpus), []);

  const relevant = corpus.positiveScenarios.find(
    ({ manifest }) => manifest.scenarioId === 'scenario_relevant_exported_contract',
  );
  assert.equal(relevant.expected.findings.length, 1);
  assert.equal(relevant.expected.decisions[0].coordinationAction, 'request_revalidation');
  assert.equal(relevant.expected.decisions[0].gatewayDirective, 'allow_with_notice');
  assert.equal(relevant.expected.decisions[0].deliveries[0].state, 'acknowledged');
  assert.equal(relevant.expected.validity[0].validityState, 'possibly_stale');

  const irrelevant = corpus.positiveScenarios.find(
    ({ manifest }) => manifest.scenarioId === 'scenario_irrelevant_concurrent_change',
  );
  assert.deepEqual(irrelevant.expected.findings, []);
  assert.deepEqual(irrelevant.expected.decisions, []);
  assert.equal(irrelevant.expected.validity[0].validityState, 'unassessed');
});
```

- [ ] **Step 2: Run the corpus test to verify it fails**

Run:

```powershell
node --test tools/phase0/corpus.test.mjs
```

Expected: FAIL because `loadPhase0Corpus` is not exported or the fixture directories
do not exist.

- [ ] **Step 3: Use one exact identity set across both scenarios**

Use these values verbatim in both scenario directories:

```text
repositoryId: repo_11111111-1111-4111-8111-111111111111
producer worktreeId: wt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
producer workspaceId: ws_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
consumer worktreeId: wt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
consumer workspaceId: ws_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
integrationTargetId: target_84382d24e7e9d1442e40dd3c53b1d963b79434955dd909fe4d86bf9c891261a0
base targetSnapshotId: snapshot_bb7d60fbf9da67062adc152cdf0e8a1ad15542c354f2caf14fa63fd0fea3fe87
base target digest: bb7d60fbf9da67062adc152cdf0e8a1ad15542c354f2caf14fa63fd0fea3fe87
candidate targetSnapshotId: snapshot_c618b284d547a3d866a9f42a3faa578f4feab8259437c376a5538dcd23562f88
candidate target digest: c618b284d547a3d866a9f42a3faa578f4feab8259437c376a5538dcd23562f88
candidateId: candidate_77da495c18b095d91131eba596a644add6d0535ead8fa03cd5d935440362ee57
baseCommit: 1111111111111111111111111111111111111111
authenticate symbol resourceId: res_c0375c9ba513eb7029ccce578c9b58dc6debded701c5afd9708102a3acec3a8b
createSession symbol resourceId: res_6b967ca968e10ea05d94e7ad7adf88b3e97b339c9a64a30e8f3ccab1ae6df030
notes file resourceId: res_d1890eb43a141d85832d190c48af9667a56270ee9f5d340759bffce468fbc7af
observed signature value: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
candidate signature value: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
consumer createSession signature value: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
```

The base target snapshot uses an empty `candidateIds` array. The candidate target
snapshot uses the single candidate ID above. Their digest input is the closed object
of `integrationTargetId`, `repositoryId`, `kind: "branch"`,
`locator: "refs/heads/main"`, `baseCommit`, and ordered `candidateIds`.

- [ ] **Step 4: Create both manifests**

Create `fixtures/scenarios/v1/relevant-exported-contract/manifest.json`:

```json
{
  "schemaVersion": 1,
  "scenarioId": "scenario_relevant_exported_contract",
  "title": "Candidate exported-contract change affects an observed consumer",
  "targetPhase": 2,
  "kind": "positive",
  "eventsFile": "events.ndjson",
  "expected": {
    "graph": "expected-graph.json",
    "findings": "expected-findings.json",
    "decisions": "expected-decisions.json",
    "validity": "expected-validity.json",
    "coverage": "expected-coverage.json"
  },
  "variants": [],
  "expectedError": null
}
```

Create `fixtures/scenarios/v1/irrelevant-concurrent-change/manifest.json`:

```json
{
  "schemaVersion": 1,
  "scenarioId": "scenario_irrelevant_concurrent_change",
  "title": "Concurrent change outside the observed dependency path is irrelevant",
  "targetPhase": 2,
  "kind": "positive",
  "eventsFile": "events.ndjson",
  "expected": {
    "graph": "expected-graph.json",
    "findings": "expected-findings.json",
    "decisions": "expected-decisions.json",
    "validity": "expected-validity.json",
    "coverage": "expected-coverage.json"
  },
  "variants": [],
  "expectedError": null
}
```

- [ ] **Step 5: Write the relevant event log with exact causal structure**

Write one compact JSON object per line in
`fixtures/scenarios/v1/relevant-exported-contract/events.ndjson`. Use timestamps from
`2026-08-06T00:00:01.000Z` through `2026-08-06T00:00:15.000Z` and these exact rows:

| Event ID suffix | Type | Source | Agent/task | Correlation | Cause | Required payload |
| --- | --- | --- | --- | --- | --- | --- |
| `01` | `tool.requested` | gateway B sequence 0 | `agent_b` / `task_consumer` | `corr_00000000000000000000000000000001` | null | read `authenticate`, target authenticate resource, `opaque: false` |
| `02` | `symbol.read` | adapter B sequence 0 | `agent_b` / `task_consumer` | `corr_00000000000000000000000000000001` | event 01 | authenticate logical resource and observed signature version in consumer domain |
| `03` | `tool.completed` | gateway B sequence 1 | `agent_b` / `task_consumer` | `corr_00000000000000000000000000000001` | event 02 | request 01 succeeded with effect event 02 |
| `04` | `dependency.changed` | analyzer B sequence 0 | `agent_b` / `task_consumer` | `corr_00000000000000000000000000000001` | event 02 | nested dependency `dep_00000000000000000000000000000001`: createSession consumer signature depends on authenticate observed consumer signature; one `statically_observed` observation from `source_analyzer` version `1`, rule `rule_typescript_import` version `1`, evidence event 02; record evidence events 02/04 |
| `05` | `task.completed` | adapter B sequence 1 | `agent_b` / `task_consumer` | `corr_00000000000000000000000000000001` | event 04 | `work_00000000000000000000000000000001`, base commit, base snapshot, createSession resource |
| `06` | `tool.requested` | gateway A sequence 0 | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | null | edit `authenticate`, target authenticate resource, `opaque: false` |
| `07` | `symbol.changed` | adapter A sequence 0 | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 06 | authenticate changes from observed signature in producer domain to candidate signature in producer domain |
| `08` | `tool.completed` | gateway A sequence 1 | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 07 | request 06 succeeded with effect event 07 |
| `09` | `finding.created` | core sequence 0 in producer workspace | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 07 | the exact finding from `expected-findings.json` |
| `0a` | `decision.created` | core sequence 1 in producer workspace | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 09 | the decision from `expected-decisions.json` with initial `deliveries: []` |
| `0b` | `validity.changed` | core sequence 2 in producer workspace | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 0a | the exact record and transition from `expected-validity.json` |
| `0c` | `decision.delivery.changed` | core sequence 3 in producer workspace | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 0a | delivery 01 for Agent B becomes `pending` with event list `[0c]` |
| `0d` | `decision.delivery.changed` | core sequence 4 in producer workspace | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 0c | delivery 01 becomes `delivered` with event list `[0c, 0d]` |
| `0e` | `decision.delivery.changed` | core sequence 5 in producer workspace | `agent_a` / `task_producer` | `corr_00000000000000000000000000000002` | event 0d | delivery 01 becomes `acknowledged` with event list `[0c, 0d, 0e]` |

Use `evt_` plus 32 hexadecimal digits for event IDs and `corr_` plus 32 hexadecimal
digits for correlations. Because `sourceSequence` is scoped to one producer process,
use these distinct process-instance UUIDs; never reuse a UUID merely because two
producers run in the same workspace:

| Producer process | `source.instanceId` |
| --- | --- |
| gateway B | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1` |
| adapter B | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2` |
| analyzer B | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3` |
| gateway A | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1` |
| adapter A | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2` |
| core in producer workspace | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3` |

Every resource version's `evidenceEventIds` names the event that observed or changed
it. Reuse these process IDs consistently in the irrelevant control scenario; process
IDs may repeat across separate scenario logs because each log is an independent store.

- [ ] **Step 6: Write the relevant expected finding, decision, validity, and coverage**

Create `expected-findings.json` as a one-element array:

```json
[
  {
    "findingId": "finding_00000000000000000000000000000001",
    "findingType": "exported_contract_invalidation",
    "status": "open",
    "subjectResourceId": "res_c0375c9ba513eb7029ccce578c9b58dc6debded701c5afd9708102a3acec3a8b",
    "affectedTaskId": "task_consumer",
    "dependencyIds": ["dep_00000000000000000000000000000001"],
    "evidenceEventIds": [
      "evt_00000000000000000000000000000002",
      "evt_00000000000000000000000000000004",
      "evt_00000000000000000000000000000007"
    ],
    "confidence": 1,
    "confidenceBand": "high",
    "severity": "warning",
    "coverageIds": ["coverage_00000000000000000000000000000001"],
    "detector": { "detectorId": "detector_exported_contract", "version": "1" }
  }
]
```

Create `expected-decisions.json` as a one-element array:

```json
[
  {
    "decisionId": "decision_00000000000000000000000000000001",
    "findingId": "finding_00000000000000000000000000000001",
    "target": { "agentId": "agent_b", "taskId": "task_consumer" },
    "coordinationAction": "request_revalidation",
    "gatewayDirective": "allow_with_notice",
    "reason": "candidate authenticate signature differs from the consumer's observed signature",
    "evidenceEventIds": [
      "evt_00000000000000000000000000000002",
      "evt_00000000000000000000000000000004",
      "evt_00000000000000000000000000000007"
    ],
    "confidence": 1,
    "confidenceBand": "high",
    "policy": { "policyId": "policy_exported_contract", "version": "1" },
    "expectedResponse": "affected",
    "coverageIds": ["coverage_00000000000000000000000000000001"],
    "state": "active",
    "deliveries": [
      {
        "deliveryId": "delivery_00000000000000000000000000000001",
        "target": { "agentId": "agent_b", "taskId": "task_consumer" },
        "state": "acknowledged",
        "eventIds": [
          "evt_0000000000000000000000000000000c",
          "evt_0000000000000000000000000000000d",
          "evt_0000000000000000000000000000000e"
        ]
      }
    ]
  }
]
```

Create `expected-validity.json` as a one-element array. Use
`validity_00000000000000000000000000000001`, `task_consumer`,
`work_00000000000000000000000000000001`, execution
`completed`, validity `possibly_stale`, the candidate target snapshot, the observed
authenticate version, no validations,
`coverage_00000000000000000000000000000001`, evidence events 02/04/07/0b,
and this transition:

```json
{
  "from": "unassessed",
  "to": "possibly_stale",
  "reason": "dependency_impact",
  "targetSnapshotId": "snapshot_c618b284d547a3d866a9f42a3faa578f4feab8259437c376a5538dcd23562f88",
  "evidenceEventIds": [
    "evt_00000000000000000000000000000002",
    "evt_00000000000000000000000000000004",
    "evt_00000000000000000000000000000007"
  ]
}
```

Create `expected-coverage.json`:

```json
[
  {
    "coverageId": "coverage_00000000000000000000000000000001",
    "scope": "authenticate observation and candidate change",
    "modes": ["intercepted", "verified"],
    "evidenceEventIds": [
      "evt_00000000000000000000000000000001",
      "evt_00000000000000000000000000000002",
      "evt_00000000000000000000000000000006",
      "evt_00000000000000000000000000000007"
    ],
    "gaps": [],
    "presentation": "sufficient"
  }
]
```

- [ ] **Step 7: Write the relevant graph snapshot**

Create `expected-graph.json` with full logical resource records for authenticate and
createSession in its top-level `resources` array, then seven nodes for `agent_b`, `task_consumer`, the
authenticate resource, createSession resource,
`work_00000000000000000000000000000001`,
`finding_00000000000000000000000000000001`, and
`decision_00000000000000000000000000000001`. Use node IDs
`node_00000000000000000000000000000001` through
`node_00000000000000000000000000000007` in that order.

Add these exact edges with IDs `edge_00000000000000000000000000000001`
through `edge_00000000000000000000000000000006`:

| Kind | From | To | `dependency` | Evidence |
| --- | --- | --- | --- | --- |
| `observed` | agent node | authenticate node | null | event 02 |
| `depends_on` | createSession node | authenticate node | exact nested dependency record from event 04 | events 02 and 04 |
| `produced` | task node | work-product node | null | event 05 |
| `affects` | finding node | task node | null | events 02, 04, 07 |
| `derived_from` | decision node | finding node | null | event 09 |
| `targets` | decision node | task node | null | event 0a |

Include both exact base and candidate target snapshots from Step 3 in
`targetSnapshots`, sorted by snapshot ID.

- [ ] **Step 8: Write the irrelevant control log and outputs**

In `irrelevant-concurrent-change/events.ndjson`, reuse relevant events 01 through 05,
then add a producer `tool.requested`, `file.changed`, and `tool.completed` sequence for
`docs/notes.md` using event IDs ending `06`, `07`, and `08`, correlation
`corr_00000000000000000000000000000002`, and
the notes resource ID. The file change uses a `content_hash` before value of
`sha256:` plus 64 `c` characters and after value of `sha256:` plus 64 `d` characters.
Do not add finding, decision, or validity-change events.

Set `expected-findings.json` and `expected-decisions.json` to `[]`.

Create one `unassessed` validity record in `expected-validity.json` for
`task_consumer` and `work_00000000000000000000000000000001` against the base target
snapshot. Use the observed
authenticate dependency, no validations, evidence events 02/04/05, coverage ID
`coverage_00000000000000000000000000000002`, and `lastTransition: null`.

Create `expected-coverage.json` with one sufficient record
`coverage_00000000000000000000000000000002`, modes
`intercepted` and `verified`, evidence events 01/02/06/07, and no gaps.

Create `expected-graph.json` with authenticate, createSession, and notes logical records
in `resources`; nodes for agent B, agent A, task consumer, authenticate, createSession,
work product, and notes; and exactly four edges: agent B `observed` authenticate
(event 02), createSession `depends_on` authenticate with the exact nested dependency
record from event 04, task consumer `produced` the work product (event 05), and agent A
`observed` the notes change (event 07). Non-dependency edges use `dependency: null`.
Include the base target snapshot and no finding or decision nodes.

- [ ] **Step 9: Wire schema and domain validation into the repository entry point**

Export `loadPhase0Corpus(root)` and `validatePhase0Corpus(corpus)` from
`tools/phase0/validate.mjs`.

`loadPhase0Corpus` must:

1. load every `*.schema.json` below `schemas/phase0/v1`;
2. create one schema registry;
3. discover positive scenario directories below `fixtures/scenarios/v1`;
4. load each scenario through `loadScenario`;
5. return `{ registry, positiveScenarios, negativeFixtures: [], benchmarks: null }`.

`validatePhase0Corpus` must:

1. validate schema documents;
2. validate each manifest against `scenario-manifest.schema.json`;
3. validate every event against `event-envelope.schema.json`;
4. enforce this event-to-payload map:

```javascript
const PAYLOAD_REF_BY_EVENT_TYPE = new Map([
  ['tool.requested', 'toolRequested'],
  ['tool.completed', 'toolCompleted'],
  ['file.read', 'resourceObserved'],
  ['file.changed', 'resourceChanged'],
  ['symbol.read', 'resourceObserved'],
  ['symbol.changed', 'resourceChanged'],
  ['task.completed', 'taskCompleted'],
  ['dependency.changed', 'dependencyChanged'],
  ['attribution.corrected', 'attributionCorrected'],
  ['finding.created', 'findingCreated'],
  ['decision.created', 'decisionCreated'],
  ['validity.changed', 'validityChanged'],
  ['decision.delivery.changed', 'decisionDeliveryChanged'],
]);
```

5. validate graph, every finding, every decision, every validity record, and every
   coverage record against its schema;
6. verify finding and validity event payloads exactly match corresponding expected
   records by canonical digest;
7. verify `decision.created` matches expected stable decision fields with initial
   `deliveries: []`, fold `decision.delivery.changed` events through guarded delivery
   state, and compare the folded deliveries with the expected final decision;
8. run `validateScenarioDomain`;
9. return sorted diagnostics.

Change `validateRepository(root)` to load and validate this corpus. Keep validator
exceptions on exit `2`; contract diagnostics exit `1`.

- [ ] **Step 10: Run the two-scenario corpus**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: all tests pass, the validator prints `Phase 0 corpus valid`, and the diff
check is clean.

- [ ] **Step 11: Commit the core golden scenarios**

```powershell
git add tools/phase0/corpus.test.mjs tools/phase0/validate.mjs fixtures/scenarios/v1/relevant-exported-contract fixtures/scenarios/v1/irrelevant-concurrent-change
git commit -m "test: add phase 0 golden contract scenarios"
```

### Task 8: Add the threat model, degraded mode, late attribution, and security negatives

**Files:**
- Create: `docs/THREAT_MODEL.md`
- Create: `tools/phase0/lib/secrets.mjs`
- Modify: `tools/phase0/diagnostics.test.mjs`
- Modify: `tools/phase0/corpus.test.mjs`
- Modify: `tools/phase0/validate.mjs`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/manifest.json`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/events.ndjson`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/expected-graph.json`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/expected-findings.json`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/expected-decisions.json`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/expected-validity.json`
- Create: `fixtures/scenarios/v1/opaque-shell-degraded/expected-coverage.json`
- Create: `fixtures/scenarios/v1/late-attribution/manifest.json`
- Create: `fixtures/scenarios/v1/late-attribution/events.ndjson`
- Create: `fixtures/scenarios/v1/late-attribution/expected-graph.json`
- Create: `fixtures/scenarios/v1/late-attribution/expected-findings.json`
- Create: `fixtures/scenarios/v1/late-attribution/expected-decisions.json`
- Create: `fixtures/scenarios/v1/late-attribution/expected-validity.json`
- Create: `fixtures/scenarios/v1/late-attribution/expected-coverage.json`
- Create: `fixtures/invalid/v1/path-traversal/manifest.json`
- Create: `fixtures/invalid/v1/path-traversal/events.ndjson`
- Create: `fixtures/invalid/v1/cross-domain-reference/manifest.json`
- Create: `fixtures/invalid/v1/cross-domain-reference/events.ndjson`
- Create: `fixtures/invalid/v1/invalid-transition/manifest.json`
- Create: `fixtures/invalid/v1/invalid-transition/events.ndjson`
- Create: `fixtures/invalid/v1/coverage-overclaim/manifest.json`
- Create: `fixtures/invalid/v1/coverage-overclaim/events.ndjson`
- Create: `fixtures/invalid/v1/coverage-overclaim/expected-graph.json`
- Create: `fixtures/invalid/v1/coverage-overclaim/expected-findings.json`
- Create: `fixtures/invalid/v1/coverage-overclaim/expected-decisions.json`
- Create: `fixtures/invalid/v1/coverage-overclaim/expected-validity.json`
- Create: `fixtures/invalid/v1/coverage-overclaim/expected-coverage.json`
- Create: `fixtures/invalid/v1/unsupported-schema/manifest.json`
- Create: `fixtures/invalid/v1/unsupported-schema/events.ndjson`
- Create: `fixtures/invalid/v1/missing-reference/manifest.json`
- Create: `fixtures/invalid/v1/missing-reference/events.ndjson`
- Create: `fixtures/invalid/v1/synthetic-secret/manifest.json`
- Create: `fixtures/invalid/v1/synthetic-secret/events.ndjson`

- [ ] **Step 1: Write failing secret and security-corpus tests**

Append to `tools/phase0/diagnostics.test.mjs`:

```javascript
import { findSecretDiagnostics } from './lib/secrets.mjs';

test('secret diagnostics identify location without echoing the value', () => {
  const value = { headers: { authorization: 'Bearer synthetic-value-for-test' } };
  const diagnostics = findSecretDiagnostics(value, 'fixture.json');
  assert.equal(diagnostics[0].code, 'PHASE0_SECRET_PATTERN');
  assert.equal(diagnostics[0].pointer, '/headers/authorization');
  assert.doesNotMatch(formatDiagnostics(diagnostics), /synthetic-value-for-test/);
});
```

Append to `tools/phase0/corpus.test.mjs`:

```javascript
test('degraded, attribution, and expected-negative fixtures are enforced', async () => {
  const corpus = await loadPhase0Corpus(new URL('../..', import.meta.url));
  const positiveIds = corpus.positiveScenarios.map(({ manifest }) => manifest.scenarioId);
  assert.ok(positiveIds.includes('scenario_opaque_shell_degraded'));
  assert.ok(positiveIds.includes('scenario_late_attribution'));
  const expectedNegativeIds = new Set([
    'scenario_invalid_path_traversal',
    'scenario_invalid_cross_domain',
    'scenario_invalid_transition',
    'scenario_invalid_coverage',
    'scenario_unsupported_schema',
    'scenario_missing_reference',
    'scenario_synthetic_secret',
  ]);
  assert.equal(
    corpus.negativeFixtures.filter(({ manifest }) =>
      expectedNegativeIds.has(manifest.scenarioId)).length,
    expectedNegativeIds.size,
  );
  assert.deepEqual(await validatePhase0Corpus(corpus), []);

  const opaque = corpus.positiveScenarios.find(
    ({ manifest }) => manifest.scenarioId === 'scenario_opaque_shell_degraded',
  );
  assert.equal(opaque.expected.coverage[0].presentation, 'degraded');
  assert.deepEqual(opaque.expected.coverage[0].modes, ['intercepted', 'verified', 'unknown']);

  const attribution = corpus.positiveScenarios.find(
    ({ manifest }) => manifest.scenarioId === 'scenario_late_attribution',
  );
  assert.equal(attribution.events[0].value.agentId, null);
  assert.equal(attribution.events[0].value.taskId, null);
  assert.equal(attribution.events[1].value.eventType, 'attribution.corrected');
});
```

- [ ] **Step 2: Run the tests to verify missing security behavior**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/corpus.test.mjs
```

Expected: FAIL for missing `secrets.mjs` and missing scenario directories.

- [ ] **Step 3: Implement secret-key and secret-value detection**

Create `tools/phase0/lib/secrets.mjs` with:

```javascript
import { diagnostic, sortDiagnostics } from './diagnostics.mjs';

const SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'password',
  'passwd',
  'privatekey',
  'secret',
  'token',
]);

const SECRET_VALUES = [
  /\bBearer\s+\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function escapePointer(segment) {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function findSecretDiagnostics(value, path) {
  const diagnostics = [];

  function visit(current, pointer) {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (current && typeof current === 'object') {
      for (const key of Object.keys(current).sort()) {
        const childPointer = `${pointer}/${escapePointer(key)}`;
        const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
        if (SECRET_KEYS.has(normalized) && current[key] !== '<redacted>') {
          diagnostics.push(diagnostic(
            'PHASE0_SECRET_PATTERN',
            path,
            childPointer,
            'prohibited secret-bearing key must contain <redacted>',
          ));
        } else {
          visit(current[key], childPointer);
        }
      }
      return;
    }
    if (typeof current === 'string' && SECRET_VALUES.some((pattern) => pattern.test(current))) {
      diagnostics.push(diagnostic(
        'PHASE0_SECRET_PATTERN',
        path,
        pointer,
        'prohibited secret-shaped value',
      ));
    }
  }

  visit(value, '');
  return sortDiagnostics(diagnostics);
}
```

The synthetic-secret negative fixture deliberately contains a fake bearer value. Do
not add a real credential or copy any environment value into a fixture.

- [ ] **Step 4: Write the threat model with a fixture traceability matrix**

Create `docs/THREAT_MODEL.md` with these sections:

```markdown
# PatchMesh Phase 0 Threat Model

> **Status:** Phase 0 normative security contract for planned local-first behavior.

## Scope and assets

Protect repository/worktree/workspace identity, event integrity, logical paths,
resource versions, dependency evidence, decisions, coverage claims, fixture data, and
validator diagnostics. Runtime sandboxing and remote multi-tenant security are outside
Phase 0.

## Actors and trust boundaries

Treat adapter, gateway, watcher, analyzer, shell/process output, filesystem metadata,
Git metadata, and imported fixture data as untrusted inputs. The local event store is
a future trust boundary, not an implemented capability. The validator reads only
repository artifacts and performs no network requests or tool execution.

## Local identity threats

- Spoofed or colliding repository, worktree, workspace, agent, or task identity.
- Identity instability after path moves or remote changes.
- Cross-repository resource or target references.

Mitigate with opaque persisted IDs, exact schema validation, explicit associations,
same-repository invariants, and collision rejection. Do not derive identity from a
remote URL or path.

## Event-integrity threats

- Conflicting retries under one event ID.
- Unsupported schema versions.
- Missing or forged causal references.
- Timestamp-based causal inference.
- Mutation disguised as attribution correction.

Mitigate with canonical digests, append-only correction events, exact version support,
reference validation, source-instance sequences, and replay equivalence.

## Path threats

- Absolute paths, traversal, backslashes, NUL bytes, case-folding collisions, and
  symlink escape.

Mitigate with repository-relative NFC paths, Git spelling for tracked paths, schema
rejection, explicit collision errors, and separate symlink target evidence. The
validator never follows artifact paths outside their scenario directory.

## Redaction threats

- Credentials in event payloads, shell output, environment values, fixtures, or
  diagnostics.
- Hidden model reasoning persisted as evidence.

Mitigate with prohibited key/value scans, synthetic-only negative values,
`<redacted>` valid values, non-echoing diagnostics, and an explicit ban on hidden
reasoning and full environment storage.

## Degraded-observation threats

Opaque and bypassed operations can make a report appear more authoritative than its
evidence. Preserve per-scope modes and gaps. Any relevant unknown gap prevents a
sufficient presentation. Opaque shell requests remain report-only.

## Residual risks

Phase 0 defines contracts, not OS sandboxing, event signatures, durable storage,
runtime authentication, or enforcement. These limitations remain explicit and cannot
be described as mitigated implementation behavior.

## Threat-to-fixture traceability

| Threat | Positive or negative fixture | Expected result |
| --- | --- | --- |
| Conflicting event retry | `conflicting-duplicate-id` | `PHASE0_ID_CONFLICT` |
| Unsupported envelope | `unsupported-schema` | `PHASE0_SCHEMA_UNSUPPORTED` |
| Missing causal parent | `missing-reference` | `PHASE0_REFERENCE_MISSING` |
| Repository escape | `path-traversal` | `PHASE0_SCHEMA_INVALID` |
| Cross-domain identity | `cross-domain-reference` | `PHASE0_SCHEMA_INVALID` |
| Invalid validity proof | `invalid-transition` | `PHASE0_TRANSITION_INVALID` |
| Coverage overclaim | `coverage-overclaim` | `PHASE0_COVERAGE_OVERCLAIMED` |
| Secret-shaped value | `synthetic-secret` | `PHASE0_SECRET_PATTERN` |
| Opaque effects | `opaque-shell-degraded` | valid corpus with degraded coverage |
| Missing attribution | `late-attribution` | valid immutable correction and convergent projection |
```

- [ ] **Step 5: Add the opaque-shell degraded scenario**

Create a positive manifest identical in structure to Task 7 with:

```json
{
  "schemaVersion": 1,
  "scenarioId": "scenario_opaque_shell_degraded",
  "title": "Opaque shell effects are verified after execution with degraded coverage",
  "targetPhase": 1,
  "kind": "positive",
  "eventsFile": "events.ndjson",
  "expected": {
    "graph": "expected-graph.json",
    "findings": "expected-findings.json",
    "decisions": "expected-decisions.json",
    "validity": "expected-validity.json",
    "coverage": "expected-coverage.json"
  },
  "variants": [],
  "expectedError": null
}
```

Its event log contains exactly:

Reuse the Task 7 producer IDs, including gateway A instance
`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1`; the watcher uses its own instance UUID
`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4`.

1. `tool.requested` for `run_shell`, operation `generate docs/notes.md`, null target,
   `opaque: true`, producer workspace, event/correlation suffix `21`, no cause;
2. `file.changed` from the watcher, event suffix `22`, cause `21`, same correlation,
   notes resource changing from 64 `c` hash characters to 64 `d` hash characters;
3. `tool.completed`, event suffix `23`, cause `22`, request `21`, succeeded, exit `0`,
   effect event `22`, and gateway source sequence `2` so the absent sequence `1` is
   explicit coverage evidence rather than a fabricated event.

Set findings, decisions, and validity to empty arrays. The graph contains the full
notes logical resource in `resources`, an agent A node, the notes resource node, and
one `observed` edge from agent A to notes with `dependency: null` and evidence event
22. Coverage is:

```json
[
  {
    "coverageId": "coverage_00000000000000000000000000000003",
    "scope": "opaque shell request and observed file effects",
    "modes": ["intercepted", "verified", "unknown"],
    "evidenceEventIds": [
      "evt_00000000000000000000000000000021",
      "evt_00000000000000000000000000000022",
      "evt_00000000000000000000000000000023"
    ],
    "gaps": [
      {
        "kind": "opaque",
        "scope": "prospective shell effects before execution",
        "reason": "the gateway cannot enumerate arbitrary shell effects before execution",
        "evidenceEventIds": ["evt_00000000000000000000000000000021"]
      },
      {
        "kind": "missing_sequence",
        "scope": "source:gateway:source_gateway:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1:sequence:1",
        "reason": "the gateway producer sequence skipped from zero to two",
        "evidenceEventIds": [
          "evt_00000000000000000000000000000021",
          "evt_00000000000000000000000000000023"
        ]
      }
    ],
    "presentation": "degraded"
  }
]
```

- [ ] **Step 6: Add the late-attribution scenario**

Create another positive manifest with ID `scenario_late_attribution`, Phase 1, the
standard five expected files, no variants, and no expected error.

Its log contains:

1. `file.read`, event/correlation suffix `31`, adapter B, `agentId: null`,
   `taskId: null`, createSession resource and a `content_hash` version whose value is
   `sha256:` plus 64 `e` characters;
2. `attribution.corrected`, event suffix `32`, adapter B sequence 1, attributed
   envelope `agent_b`/`task_consumer`, same correlation, cause event 31, payload target
   event 31, corrected IDs `agent_b` and `task_consumer`, reason
   `runtime registration arrived after observation`, and evidence event 31.

The final graph has the full createSession logical resource in `resources`, then agent
B, task consumer, and createSession nodes. It has two `observed` edges—agent B to the
resource and task consumer to the resource—both with `dependency: null` and evidence
events 31/32. Findings, decisions, and
validity are empty. Coverage ID `coverage_00000000000000000000000000000004`
has mode `verified`, events 31/32, no remaining
gaps, and `sufficient` presentation. The event log itself remains the proof that the
original attribution was null.

- [ ] **Step 7: Create all seven negative fixture manifests and cases**

Each directory under `fixtures/invalid/v1` contains `manifest.json` and
`events.ndjson`. Use `kind: "negative"`, no variants, and the listed error. Use
`expected: null` except for `coverage-overclaim`, whose manifest points to the five
expected files listed in this task so its invalid coverage record is representable and
reaches domain validation.

| Directory | Scenario ID | Mutation | Expected error |
| --- | --- | --- | --- |
| `path-traversal` | `scenario_invalid_path_traversal` | resource locator `../secrets.txt` | `PHASE0_SCHEMA_INVALID` |
| `cross-domain-reference` | `scenario_invalid_cross_domain` | event repository ID differs from resource version domain | `PHASE0_SCHEMA_INVALID` |
| `invalid-transition` | `scenario_invalid_transition` | `possibly_stale -> stale` for `dependency_impact` | `PHASE0_TRANSITION_INVALID` |
| `coverage-overclaim` | `scenario_invalid_coverage` | `sufficient` coverage with an opaque gap | `PHASE0_COVERAGE_OVERCLAIMED` |
| `unsupported-schema` | `scenario_unsupported_schema` | event `schemaVersion: 2` | `PHASE0_SCHEMA_UNSUPPORTED` |
| `missing-reference` | `scenario_missing_reference` | causation ID absent from log | `PHASE0_REFERENCE_MISSING` |
| `synthetic-secret` | `scenario_synthetic_secret` | operation contains `Bearer synthetic-value-for-test` | `PHASE0_SECRET_PATTERN` |

Use a minimal otherwise-valid event for each mutation. The invalid-transition event is
`validity.changed`; event-embedded validity is validated even when `expected` is null.
For `coverage-overclaim`, use empty graph/findings/decisions/validity outputs and one
schema-valid coverage record whose `presentation` is `sufficient` despite an opaque
gap. Its event log contains one otherwise-valid supporting event. No negative fixture
may reference a file outside its own directory.

- [ ] **Step 8: Discover negative fixtures and enforce their expected primary code**

Extend `loadPhase0Corpus` to discover `fixtures/invalid/v1` and load its directories
into `negativeFixtures`.

Extend `validatePhase0Corpus` as follows:

```text
positive scenario -> zero diagnostics required
negative fixture  -> at least one diagnostic required
negative fixture  -> first sorted primary diagnostic code equals manifest.expectedError
negative fixture  -> mismatch becomes PHASE0_SCHEMA_INVALID on /expectedError
```

Run `findSecretDiagnostics` on every parsed machine artifact before domain validation.
For the synthetic-secret fixture, its expected secret diagnostic is success for the
full corpus; a direct validation of that fixture still yields exit `1`.

Map event `schemaVersion !== 1` to `PHASE0_SCHEMA_UNSUPPORTED` before ordinary schema
validation so the error remains stable. Catch safe path-resolution failures and map
them to `PHASE0_SCHEMA_INVALID` rather than a validator exception.

- [ ] **Step 9: Run security, degraded-mode, and attribution verification**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: all tests pass, all seven negative fixtures fail for their declared reason,
the full corpus prints `Phase 0 corpus valid`, and the diff check is clean.

- [ ] **Step 10: Commit the security and degraded-mode corpus**

```powershell
git add docs/THREAT_MODEL.md tools/phase0/lib/secrets.mjs tools/phase0/diagnostics.test.mjs tools/phase0/corpus.test.mjs tools/phase0/validate.mjs fixtures/scenarios/v1/opaque-shell-degraded fixtures/scenarios/v1/late-attribution fixtures/invalid/v1
git commit -m "test: define phase 0 security and degraded modes"
```

### Task 9: Define replay equivalence, duplicates, out-of-order input, and integrity failure

**Files:**
- Create: `docs/protocol/replay-equivalence.md`
- Modify: `tools/phase0/corpus.test.mjs`
- Modify: `tools/phase0/validate.mjs`
- Modify: `tools/phase0/lib/domain.mjs`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/manifest.json`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/events.ndjson`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/events-duplicates.ndjson`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/events-out-of-order.ndjson`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/expected-graph.json`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/expected-findings.json`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/expected-decisions.json`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/expected-validity.json`
- Create: `fixtures/scenarios/v1/duplicate-and-out-of-order/expected-coverage.json`
- Create: `fixtures/scenarios/v1/conflicting-duplicate-id/manifest.json`
- Create: `fixtures/scenarios/v1/conflicting-duplicate-id/events.ndjson`

- [ ] **Step 1: Write failing replay-corpus assertions**

Append to `tools/phase0/corpus.test.mjs`:

```javascript
test('duplicate and out-of-order variants converge while conflicting IDs fail', async () => {
  const corpus = await loadPhase0Corpus(new URL('../..', import.meta.url));
  assert.equal(corpus.positiveScenarios.length, 5);
  assert.equal(corpus.negativeFixtures.length, 8);
  assert.deepEqual(await validatePhase0Corpus(corpus), []);

  const replay = corpus.positiveScenarios.find(
    ({ manifest }) => manifest.scenarioId === 'scenario_duplicate_and_out_of_order',
  );
  assert.deepEqual(
    replay.variants.map(({ name, equivalentTo }) => ({ name, equivalentTo })),
    [
      { name: 'duplicates', equivalentTo: 'canonical' },
      { name: 'out-of-order', equivalentTo: 'canonical' },
    ],
  );

  const conflict = corpus.negativeFixtures.find(
    ({ manifest }) => manifest.scenarioId === 'scenario_conflicting_duplicate_id',
  );
  assert.equal(conflict.manifest.expectedError, 'PHASE0_ID_CONFLICT');
});
```

- [ ] **Step 2: Run the replay test to verify it fails**

Run:

```powershell
node --test tools/phase0/corpus.test.mjs
```

Expected: FAIL because the positive and negative corpus counts remain four and seven.

- [ ] **Step 3: Write the replay-equivalence contract**

Create `docs/protocol/replay-equivalence.md` with:

````markdown
# PatchMesh Replay and Projection-Equivalence Contract

> **Status:** Phase 0 normative contract. Phase 1 implements storage and projection.

## Replay definition

Replay consumes a stored immutable event log and rebuilds derived state with all
external side effects disabled. Replay never reruns a tool, sends a decision, executes
a gateway directive, or mutates an original event.

Detector recomputation from observation-only events is a separate Phase 2 test mode.
It is not projection replay.

## Canonical projection snapshot

A snapshot contains graph nodes and edges, target snapshots, findings, decisions,
delivery state, validity records, and coverage records. Object keys use canonical JSON
order. Entity arrays sort by stable ID. Candidate lists and event logs preserve their
declared order. Transient processing timestamps, database row IDs, and delivery side
effects are excluded.

## Required equivalent executions

For each declared scenario, Phase 1 must prove byte-equivalent canonical snapshots for:

1. incremental processing in canonical event order;
2. cold replay of the complete stored log;
3. replay with identical duplicate events inserted; and
4. replay of a declared causally valid out-of-order permutation.

Phase 0 verifies two declared inputs to the future projector: each variant contains the
same unique event IDs and canonical event digests after identical duplicates are
removed, and each variant's declared expected outputs canonicalize to the same
projection snapshot digest. Phase 1 must additionally execute the projector through
each mode and prove that it produces that bound digest.

## Failure rules

- Identical duplicate ID and content is a no-op.
- Duplicate ID with different content is `PHASE0_ID_CONFLICT`.
- Missing causal references at the end of replay are `PHASE0_REFERENCE_MISSING`.
- Impossible validity transitions are `PHASE0_TRANSITION_INVALID`.
- A failed replay yields no partial success snapshot.
- Rebuilt delivery state never redispatches messages.
````

- [ ] **Step 4: Add the duplicate/out-of-order positive scenario**

Create this manifest:

```json
{
  "schemaVersion": 1,
  "scenarioId": "scenario_duplicate_and_out_of_order",
  "title": "Identical duplicates and valid out-of-order delivery converge",
  "targetPhase": 1,
  "kind": "positive",
  "eventsFile": "events.ndjson",
  "expected": {
    "graph": "expected-graph.json",
    "findings": "expected-findings.json",
    "decisions": "expected-decisions.json",
    "validity": "expected-validity.json",
    "coverage": "expected-coverage.json"
  },
  "variants": [
    {
      "name": "duplicates",
      "eventsFile": "events-duplicates.ndjson",
      "equivalentTo": "canonical",
      "expected": {
        "graph": "expected-graph.json",
        "findings": "expected-findings.json",
        "decisions": "expected-decisions.json",
        "validity": "expected-validity.json",
        "coverage": "expected-coverage.json"
      }
    },
    {
      "name": "out-of-order",
      "eventsFile": "events-out-of-order.ndjson",
      "equivalentTo": "canonical",
      "expected": {
        "graph": "expected-graph.json",
        "findings": "expected-findings.json",
        "decisions": "expected-decisions.json",
        "validity": "expected-validity.json",
        "coverage": "expected-coverage.json"
      }
    }
  ],
  "expectedError": null
}
```

The canonical log has exactly three producer-workspace events:

| Event | Type | Cause | Payload |
| --- | --- | --- | --- |
| `evt_00000000000000000000000000000041` | `tool.requested` | null | `edit_file` notes resource, non-opaque |
| `evt_00000000000000000000000000000042` | `file.changed` | event 41 | notes changes from 64 `c` hash characters to 64 `d` hash characters |
| `evt_00000000000000000000000000000043` | `tool.completed` | event 42 | request 41 succeeds with effect event 42 |

All share correlation `corr_00000000000000000000000000000041`; gateway source
sequence is 0 then 1 for events 41 and 43, watcher sequence is 0 for event 42.

`events-duplicates.ndjson` orders IDs `41, 41, 42, 43, 43` with exact byte-equivalent
duplicates. `events-out-of-order.ndjson` orders IDs `43, 42, 41` without changing any
event content.

Expected findings, decisions, and validity are empty. Expected graph contains the full
notes logical resource in `resources`, an agent A node, the notes resource node, and
one `observed` edge from agent A to notes with `dependency: null` and evidence event
42. Expected coverage ID
`coverage_00000000000000000000000000000005` is sufficient, has modes intercepted and
verified, events 41/42/43, and no gaps.

- [ ] **Step 5: Add the conflicting duplicate negative scenario**

Create `fixtures/scenarios/v1/conflicting-duplicate-id/manifest.json`:

```json
{
  "schemaVersion": 1,
  "scenarioId": "scenario_conflicting_duplicate_id",
  "title": "Conflicting content under one event ID is rejected",
  "targetPhase": 1,
  "kind": "negative",
  "eventsFile": "events.ndjson",
  "expected": null,
  "variants": [],
  "expectedError": "PHASE0_ID_CONFLICT"
}
```

Write two otherwise-valid `tool.requested` event lines with the exact same event ID,
source, time, identities, correlation, and sequence. The first operation is
`edit docs/notes.md`; the second is `delete docs/notes.md`. This payload difference
must be the only difference.

- [ ] **Step 6: Validate declared event-set equivalence**

Add `canonicalEventSet(events)` to `tools/phase0/lib/domain.mjs`. It must:

1. call `validateEventSet` and stop on conflicting duplicates;
2. keep one canonical event per ID;
3. sort by event ID;
4. return canonical JSON for the sorted array.

Use this exact implementation after `canonicalSnapshot`:

```javascript
export function canonicalEventSet(events) {
  const diagnostics = validateEventSet(events);
  if (diagnostics.length > 0) return { diagnostics, canonical: null };
  const byId = new Map();
  for (const event of events) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  const ordered = [...byId.values()].sort((left, right) => left.eventId.localeCompare(right.eventId));
  return { diagnostics: [], canonical: canonicalize(ordered) };
}
```

For each manifest variant, compare `canonicalEventSet(variant.events)` with the
canonical event set named by `equivalentTo`. Also canonicalize
`{ graph, findings, decisions, validity, coverage }` through `canonicalSnapshot` and
compare the variant's declared expected bundle with the canonical scenario bundle.
An event-set or snapshot mismatch emits `PHASE0_SCHEMA_INVALID` at
`/variants/<name>/equivalentTo`. This binds the Phase 1 projector obligation without
implementing a Phase 1 projection engine in Phase 0.

Change corpus discovery under `fixtures/scenarios/v1` to partition by manifest
`kind`: positive entries join `positiveScenarios`; negative entries join
`negativeFixtures`. Continue adding `fixtures/invalid/v1` entries to
`negativeFixtures`.

- [ ] **Step 7: Run replay and integrity verification**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: all tests pass, both equivalent variants pass, conflicting content produces
the expected negative result, and the full corpus is valid.

- [ ] **Step 8: Commit replay contracts and fixtures**

```powershell
git add docs/protocol/replay-equivalence.md tools/phase0/corpus.test.mjs tools/phase0/validate.mjs tools/phase0/lib/domain.mjs fixtures/scenarios/v1/duplicate-and-out-of-order fixtures/scenarios/v1/conflicting-duplicate-id
git commit -m "test: define phase 0 replay equivalence"
```

### Task 10: Define measurable benchmark protocols without inventing results

**Files:**
- Create: `benchmarks/phase0/README.md`
- Create: `benchmarks/phase0/workloads.json`
- Create: `schemas/phase0/v1/benchmark-workloads.schema.json`
- Modify: `tools/phase0/corpus.test.mjs`
- Modify: `tools/phase0/validate.mjs`
- Modify: `tools/phase0/lib/domain.mjs`

- [ ] **Step 1: Write a failing benchmark-definition test**

Append to `tools/phase0/corpus.test.mjs`:

```javascript
test('benchmark definitions cover latency, replay, and all initial detectors', async () => {
  const corpus = await loadPhase0Corpus(new URL('../..', import.meta.url));
  assert.equal(corpus.benchmarks.schemaVersion, 1);
  assert.deepEqual(
    [...new Set(corpus.benchmarks.workloads.map(({ kind }) => kind))].sort(),
    ['detector_quality', 'interception_latency', 'replay'],
  );
  assert.deepEqual(
    corpus.benchmarks.workloads
      .filter(({ kind }) => kind === 'detector_quality')
      .map(({ detector }) => detector)
      .sort(),
    ['exported_contract_invalidation', 'same_symbol_overlap', 'stale_read_before_write'],
  );
  assert.deepEqual(await validatePhase0Corpus(corpus), []);
});
```

- [ ] **Step 2: Run the benchmark test to verify it fails**

Run:

```powershell
node --test tools/phase0/corpus.test.mjs
```

Expected: FAIL because `corpus.benchmarks` is null.

- [ ] **Step 3: Create the benchmark workload schema**

Create `schemas/phase0/v1/benchmark-workloads.schema.json` with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://patchmesh.dev/schemas/phase0/v1/benchmark-workloads.schema.json",
  "$defs": {
    "interception": {
      "type": "object",
      "properties": {
        "workloadId": { "type": "string", "pattern": "^benchmark_interception_[a-z0-9_]+$" },
        "kind": { "const": "interception_latency" },
        "operation": { "enum": ["noop_route", "small_file_read", "opaque_shell"] },
        "baseline": { "const": "direct_operation" },
        "instrumented": { "const": "gateway_observation" },
        "warmupSamples": { "type": "integer", "minimum": 1 },
        "measuredSamples": { "type": "integer", "minimum": 1 },
        "metrics": {
          "type": "array",
          "items": { "enum": ["baseline_ns", "instrumented_ns", "overhead_ns", "p50_ns", "p95_ns", "failures"] },
          "minItems": 6,
          "uniqueItems": true
        }
      },
      "required": [
        "workloadId",
        "kind",
        "operation",
        "baseline",
        "instrumented",
        "warmupSamples",
        "measuredSamples",
        "metrics"
      ],
      "additionalProperties": false
    },
    "replay": {
      "type": "object",
      "properties": {
        "workloadId": { "type": "string", "pattern": "^benchmark_replay_[0-9]+$" },
        "kind": { "const": "replay" },
        "eventCount": { "enum": [1000, 10000, 100000] },
        "variants": {
          "type": "array",
          "items": { "enum": ["canonical", "duplicates", "out_of_order"] },
          "minItems": 3,
          "uniqueItems": true
        },
        "warmupRuns": { "type": "integer", "minimum": 1 },
        "measuredRuns": { "type": "integer", "minimum": 1 },
        "metrics": {
          "type": "array",
          "items": { "enum": ["elapsed_ns", "events_per_second", "peak_memory_bytes", "p50_ns", "p95_ns", "snapshot_digest", "failures"] },
          "minItems": 7,
          "uniqueItems": true
        }
      },
      "required": [
        "workloadId",
        "kind",
        "eventCount",
        "variants",
        "warmupRuns",
        "measuredRuns",
        "metrics"
      ],
      "additionalProperties": false
    },
    "detectorQuality": {
      "type": "object",
      "properties": {
        "workloadId": { "type": "string", "pattern": "^benchmark_detector_[a-z0-9_]+$" },
        "kind": { "const": "detector_quality" },
        "detector": {
          "enum": ["same_symbol_overlap", "stale_read_before_write", "exported_contract_invalidation"]
        },
        "corpusSource": { "const": "phase2_labeled_scenario_corpus" },
        "requiredLabels": {
          "type": "array",
          "items": { "enum": ["relevant", "irrelevant"] },
          "minItems": 2,
          "uniqueItems": true
        },
        "findingMatchFields": {
          "type": "array",
          "items": { "enum": ["detector", "subject_resource", "affected_task", "evidence_path"] },
          "minItems": 4,
          "uniqueItems": true
        },
        "metrics": {
          "type": "array",
          "items": { "enum": ["true_positive", "false_positive", "true_negative", "false_negative", "precision", "recall"] },
          "minItems": 6,
          "uniqueItems": true
        }
      },
      "required": [
        "workloadId",
        "kind",
        "detector",
        "corpusSource",
        "requiredLabels",
        "findingMatchFields",
        "metrics"
      ],
      "additionalProperties": false
    }
  },
  "type": "object",
  "properties": {
    "schemaVersion": { "const": 1 },
    "definitionVersion": { "const": "phase0-v1" },
    "environmentFields": {
      "type": "array",
      "items": {
        "enum": ["timestamp", "commit", "os", "architecture", "cpu", "memoryBytes", "nodeVersion"]
      },
      "minItems": 7,
      "uniqueItems": true
    },
    "workloads": {
      "type": "array",
      "items": {
        "oneOf": [
          { "$ref": "#/$defs/interception" },
          { "$ref": "#/$defs/replay" },
          { "$ref": "#/$defs/detectorQuality" }
        ]
      },
      "minItems": 9,
      "uniqueItems": true
    }
  },
  "required": ["schemaVersion", "definitionVersion", "environmentFields", "workloads"],
  "additionalProperties": false
}
```

- [ ] **Step 4: Write the measurement protocol**

Create `benchmarks/phase0/README.md` with:

```markdown
# PatchMesh Phase 0 Benchmark Definitions

> **Status:** Measurement definitions only. No benchmark implementation, result, or
> acceptance threshold exists in Phase 0.

## Result-record envelope

Every future result records definition version, workload ID, timestamp, Git commit,
OS, architecture, CPU, memory, Node version, warm-up count, measured sample count,
raw observations, failures, and derived statistics. A percentile without raw
observations and sample count is not reproducible evidence.

## Interception latency

Run each operation as a paired direct baseline and gateway-observed operation in the
same process and environment. Complete warm-up before measured samples. Record both
durations for every pair, calculate per-pair overhead, and derive p50 and p95 from the
sorted overhead samples. Failures remain in the result and are not discarded.

`noop_route` isolates routing overhead. `small_file_read` measures a deterministic
4 KiB temporary-file read. `opaque_shell` measures process invocation with no
filesystem mutation. Future implementations use temporary paths and perform no
network access.

## Replay

Generate deterministic expansions of the golden corpus at 1,000, 10,000, and 100,000
events. Measure cold canonical, duplicate, and valid out-of-order variants. Record
elapsed time, events per second, peak memory, failures, and canonical snapshot digest.
All variants must produce the same snapshot digest before their timing is comparable.

## Detector quality

Evaluate each detector against the Phase 2 labeled scenario corpus, which must contain
relevant and irrelevant cases for that detector. Match a finding by detector type,
subject resource, affected task, and evidence path. Record true positives, false
positives, true negatives, and false negatives, then calculate precision and recall
per detector. Never relabel the Phase 0 golden scenarios as detector cases they do not
actually represent, and never combine detectors into one headline score.

## Threshold ownership

Phase 0 defines no target value. Phase 1 records interception and replay baselines.
Phase 2 records detector baselines and explicitly accepts thresholds from measured
data before any later authority increase.
```

- [ ] **Step 5: Create the nine workload definitions**

Create `benchmarks/phase0/workloads.json` with:

```json
{
  "schemaVersion": 1,
  "definitionVersion": "phase0-v1",
  "environmentFields": [
    "timestamp",
    "commit",
    "os",
    "architecture",
    "cpu",
    "memoryBytes",
    "nodeVersion"
  ],
  "workloads": [
    {
      "workloadId": "benchmark_interception_noop_route",
      "kind": "interception_latency",
      "operation": "noop_route",
      "baseline": "direct_operation",
      "instrumented": "gateway_observation",
      "warmupSamples": 100,
      "measuredSamples": 1000,
      "metrics": ["baseline_ns", "instrumented_ns", "overhead_ns", "p50_ns", "p95_ns", "failures"]
    },
    {
      "workloadId": "benchmark_interception_small_file_read",
      "kind": "interception_latency",
      "operation": "small_file_read",
      "baseline": "direct_operation",
      "instrumented": "gateway_observation",
      "warmupSamples": 100,
      "measuredSamples": 1000,
      "metrics": ["baseline_ns", "instrumented_ns", "overhead_ns", "p50_ns", "p95_ns", "failures"]
    },
    {
      "workloadId": "benchmark_interception_opaque_shell",
      "kind": "interception_latency",
      "operation": "opaque_shell",
      "baseline": "direct_operation",
      "instrumented": "gateway_observation",
      "warmupSamples": 50,
      "measuredSamples": 500,
      "metrics": ["baseline_ns", "instrumented_ns", "overhead_ns", "p50_ns", "p95_ns", "failures"]
    },
    {
      "workloadId": "benchmark_replay_1000",
      "kind": "replay",
      "eventCount": 1000,
      "variants": ["canonical", "duplicates", "out_of_order"],
      "warmupRuns": 3,
      "measuredRuns": 10,
      "metrics": ["elapsed_ns", "events_per_second", "peak_memory_bytes", "p50_ns", "p95_ns", "snapshot_digest", "failures"]
    },
    {
      "workloadId": "benchmark_replay_10000",
      "kind": "replay",
      "eventCount": 10000,
      "variants": ["canonical", "duplicates", "out_of_order"],
      "warmupRuns": 3,
      "measuredRuns": 10,
      "metrics": ["elapsed_ns", "events_per_second", "peak_memory_bytes", "p50_ns", "p95_ns", "snapshot_digest", "failures"]
    },
    {
      "workloadId": "benchmark_replay_100000",
      "kind": "replay",
      "eventCount": 100000,
      "variants": ["canonical", "duplicates", "out_of_order"],
      "warmupRuns": 1,
      "measuredRuns": 5,
      "metrics": ["elapsed_ns", "events_per_second", "peak_memory_bytes", "p50_ns", "p95_ns", "snapshot_digest", "failures"]
    },
    {
      "workloadId": "benchmark_detector_same_symbol_overlap",
      "kind": "detector_quality",
      "detector": "same_symbol_overlap",
      "corpusSource": "phase2_labeled_scenario_corpus",
      "requiredLabels": ["relevant", "irrelevant"],
      "findingMatchFields": ["detector", "subject_resource", "affected_task", "evidence_path"],
      "metrics": ["true_positive", "false_positive", "true_negative", "false_negative", "precision", "recall"]
    },
    {
      "workloadId": "benchmark_detector_stale_read_before_write",
      "kind": "detector_quality",
      "detector": "stale_read_before_write",
      "corpusSource": "phase2_labeled_scenario_corpus",
      "requiredLabels": ["relevant", "irrelevant"],
      "findingMatchFields": ["detector", "subject_resource", "affected_task", "evidence_path"],
      "metrics": ["true_positive", "false_positive", "true_negative", "false_negative", "precision", "recall"]
    },
    {
      "workloadId": "benchmark_detector_exported_contract_invalidation",
      "kind": "detector_quality",
      "detector": "exported_contract_invalidation",
      "corpusSource": "phase2_labeled_scenario_corpus",
      "requiredLabels": ["relevant", "irrelevant"],
      "findingMatchFields": ["detector", "subject_resource", "affected_task", "evidence_path"],
      "metrics": ["true_positive", "false_positive", "true_negative", "false_negative", "precision", "recall"]
    }
  ]
}
```

- [ ] **Step 6: Validate benchmark completeness and prohibit result leakage**

Add `validateBenchmarkDefinitions(benchmarks)` to `domain.mjs`. It must require:

- exactly three interception operations;
- replay sizes 1,000, 10,000, and 100,000;
- all three replay variants at each size;
- all three initial detectors;
- both `relevant` and `irrelevant` required labels per detector;
- the four exact finding-match fields per detector;
- every required metric exactly once; and
- no property named `result`, `results`, `threshold`, `target`, `accepted`, or
  `baselineValue` anywhere in the definition.

Load `benchmarks/phase0/workloads.json` into `corpus.benchmarks`, validate it against
`benchmark-workloads.schema.json`, run the domain check, and include diagnostics in
`validatePhase0Corpus`.

At the end of this step, `tools/phase0/validate.mjs` must contain this complete entry
point and corpus orchestration:

```javascript
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXIT_CONTRACT_INVALID,
  EXIT_OK,
  EXIT_TOOL_FAILURE,
  diagnostic,
  formatDiagnostics,
  sortDiagnostics,
} from './lib/diagnostics.mjs';
import { canonicalDigest, canonicalize } from './lib/canonical-json.mjs';
import {
  discoverScenarioDirectories,
  loadScenario,
  readJson,
  walkFiles,
} from './lib/corpus.mjs';
import {
  canonicalEventSet,
  validateBenchmarkDefinitions,
  validateScenarioDomain,
} from './lib/domain.mjs';
import {
  createSchemaRegistry,
  validateInstance,
  validateSchemaDocuments,
} from './lib/schema.mjs';
import { findSecretDiagnostics } from './lib/secrets.mjs';

const BASE = 'https://patchmesh.dev/schemas/phase0/v1';
const PAYLOAD_REF_BY_EVENT_TYPE = new Map([
  ['tool.requested', 'toolRequested'],
  ['tool.completed', 'toolCompleted'],
  ['file.read', 'resourceObserved'],
  ['file.changed', 'resourceChanged'],
  ['symbol.read', 'resourceObserved'],
  ['symbol.changed', 'resourceChanged'],
  ['task.completed', 'taskCompleted'],
  ['dependency.changed', 'dependencyChanged'],
  ['attribution.corrected', 'attributionCorrected'],
  ['finding.created', 'findingCreated'],
  ['decision.created', 'decisionCreated'],
  ['validity.changed', 'validityChanged'],
  ['decision.delivery.changed', 'decisionDeliveryChanged'],
]);

function rootPath(root) {
  return root instanceof URL ? fileURLToPath(root) : resolve(root);
}

function normalized(path) {
  return path.replaceAll('\\', '/');
}

async function loadSchemas(root) {
  const files = (await walkFiles(join(root, 'schemas', 'phase0', 'v1')))
    .filter((path) => path.endsWith('.schema.json'));
  const documents = await Promise.all(files.map(async (path) => ({
    path: normalized(relative(root, path)),
    schema: JSON.parse(await readFile(path, 'utf8')),
  })));
  return createSchemaRegistry(documents);
}

export async function loadPhase0Corpus(rootInput) {
  const root = rootPath(rootInput);
  const registry = await loadSchemas(root);
  const scenarioDirectories = await discoverScenarioDirectories(root, 'fixtures/scenarios/v1');
  const invalidDirectories = await discoverScenarioDirectories(root, 'fixtures/invalid/v1');
  const scenarios = await Promise.all(scenarioDirectories.map((directory) =>
    loadScenario(root, directory)));
  const invalid = await Promise.all(invalidDirectories.map((directory) =>
    loadScenario(root, directory)));
  return {
    root,
    registry,
    positiveScenarios: scenarios.filter(({ manifest }) => manifest.kind === 'positive'),
    negativeFixtures: [
      ...scenarios.filter(({ manifest }) => manifest.kind === 'negative'),
      ...invalid,
    ].sort((left, right) => left.manifest.scenarioId.localeCompare(right.manifest.scenarioId)),
    benchmarks: await readJson(join(root, 'benchmarks', 'phase0', 'workloads.json')),
  };
}

function schemaId(name) {
  return `${BASE}/${name}.schema.json`;
}

function validateMachineSecrets(scenario) {
  const diagnostics = [];
  diagnostics.push(...findSecretDiagnostics(scenario.manifest, `${scenario.directory}/manifest.json`));
  for (const record of scenario.events) {
    diagnostics.push(...findSecretDiagnostics(
      record.value,
      `${scenario.directory}/events.ndjson:${record.line}`,
    ));
  }
  if (scenario.expected) {
    for (const [name, value] of Object.entries(scenario.expected)) {
      diagnostics.push(...findSecretDiagnostics(value, `${scenario.directory}/expected-${name}.json`));
    }
  }
  for (const variant of scenario.variants) {
    for (const record of variant.events) {
      diagnostics.push(...findSecretDiagnostics(
        record.value,
        `${scenario.directory}/${variant.name}:${record.line}`,
      ));
    }
  }
  return diagnostics;
}

function validateExpectedSchemas(scenario, registry) {
  if (!scenario.expected) return [];
  const diagnostics = [];
  diagnostics.push(...validateInstance(
    schemaId('graph'), scenario.expected.graph, registry, `${scenario.directory}/expected-graph.json`,
  ));
  for (const [name, schema] of [
    ['findings', 'finding'],
    ['decisions', 'decision'],
    ['validity', 'task-validity'],
    ['coverage', 'coverage'],
  ]) {
    scenario.expected[name].forEach((value, index) => diagnostics.push(...validateInstance(
      schemaId(schema),
      value,
      registry,
      `${scenario.directory}/expected-${name}.json#/${index}`,
    )));
  }
  return diagnostics;
}

function validateEventSchemas(scenario, registry) {
  const diagnostics = [];
  for (const { line, value: event } of scenario.events) {
    const path = `${scenario.directory}/events.ndjson:${line}`;
    if (event.schemaVersion !== 1) {
      diagnostics.push(diagnostic(
        'PHASE0_SCHEMA_UNSUPPORTED', path, '/schemaVersion', 'event schema version is unsupported',
      ));
      continue;
    }
    diagnostics.push(...validateInstance(schemaId('event-envelope'), event, registry, path));
    const payloadName = PAYLOAD_REF_BY_EVENT_TYPE.get(event.eventType);
    if (!payloadName) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', path, '/eventType', 'event type has no payload mapping'));
    } else {
      diagnostics.push(...validateInstance(
        `${schemaId('event-payloads')}#/$defs/${payloadName}`,
        event.payload,
        registry,
        path,
      ));
    }
  }
  return diagnostics;
}

function validateExpectedEventCopies(scenario) {
  if (!scenario.expected) return [];
  const diagnostics = [];
  const findings = new Map(scenario.expected.findings.map((value) => [value.findingId, value]));
  const decisions = new Map(scenario.expected.decisions.map((value) => [value.decisionId, value]));
  const validity = new Map(scenario.expected.validity.map((value) => [value.validityId, value]));

  for (const { value: event } of scenario.events) {
    if (event.eventType === 'finding.created') {
      const expected = findings.get(event.payload.finding.findingId);
      if (!expected || canonicalDigest(expected) !== canonicalDigest(event.payload.finding)) {
        diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/events/${event.eventId}/payload/finding`, 'finding event differs from expected record'));
      }
    }
    if (event.eventType === 'decision.created') {
      const expected = decisions.get(event.payload.decision.decisionId);
      const initialExpected = expected ? { ...expected, deliveries: [] } : null;
      if (!initialExpected || canonicalDigest(initialExpected) !== canonicalDigest(event.payload.decision)) {
        diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/events/${event.eventId}/payload/decision`, 'decision event differs from expected initial record'));
      }
    }
    if (event.eventType === 'validity.changed') {
      const expected = validity.get(event.payload.record.validityId);
      if (!expected || canonicalDigest(expected) !== canonicalDigest(event.payload.record)
          || canonicalDigest(event.payload.transition) !== canonicalDigest(expected.lastTransition)) {
        diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/events/${event.eventId}/payload/record`, 'validity event differs from expected record'));
      }
    }
  }

  const finalDeliveriesByDecision = new Map();
  for (const { value: event } of scenario.events.filter(({ value }) =>
    value.eventType === 'decision.delivery.changed')) {
    const deliveries = finalDeliveriesByDecision.get(event.payload.decisionId) ?? new Map();
    deliveries.set(event.payload.delivery.deliveryId, event.payload.delivery);
    finalDeliveriesByDecision.set(event.payload.decisionId, deliveries);
  }
  for (const decision of scenario.expected.decisions) {
    const actual = [...(finalDeliveriesByDecision.get(decision.decisionId)?.values() ?? [])]
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    if (canonicalDigest(actual) !== canonicalDigest(decision.deliveries)) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/decisions/${decision.decisionId}/deliveries`, 'folded delivery state differs from expected decision'));
    }
  }
  return diagnostics;
}

function validateVariants(scenario) {
  const diagnostics = [];
  const canonical = canonicalEventSet(scenario.events.map(({ value }) => value));
  diagnostics.push(...canonical.diagnostics);
  for (const variant of scenario.variants) {
    if (variant.equivalentTo !== 'canonical') {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/variants/${variant.name}/equivalentTo`, 'only canonical equivalence target is defined'));
      continue;
    }
    const candidate = canonicalEventSet(variant.events.map(({ value }) => value));
    diagnostics.push(...candidate.diagnostics);
    if (candidate.canonical !== canonical.canonical) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/variants/${variant.name}/equivalentTo`, 'variant event set differs from canonical'));
    }
  }
  return diagnostics;
}

function validateOneScenario(scenario, registry) {
  return sortDiagnostics([
    ...validateInstance(
      schemaId('scenario-manifest'),
      scenario.manifest,
      registry,
      `${scenario.directory}/manifest.json`,
    ),
    ...validateMachineSecrets(scenario),
    ...validateEventSchemas(scenario, registry),
    ...validateExpectedSchemas(scenario, registry),
    ...validateExpectedEventCopies(scenario),
    ...validateScenarioDomain(scenario),
    ...validateVariants(scenario),
  ]);
}

export async function validatePhase0Corpus(corpus) {
  const diagnostics = [...validateSchemaDocuments(corpus.registry)];
  for (const scenario of corpus.positiveScenarios) {
    diagnostics.push(...validateOneScenario(scenario, corpus.registry));
  }
  for (const fixture of corpus.negativeFixtures) {
    const actual = validateOneScenario(fixture, corpus.registry);
    if (actual.length === 0 || actual[0].code !== fixture.manifest.expectedError) {
      diagnostics.push(diagnostic(
        'PHASE0_SCHEMA_INVALID',
        `${fixture.directory}/manifest.json`,
        '/expectedError',
        'negative fixture did not produce its declared primary error',
      ));
    }
  }
  diagnostics.push(...validateInstance(
    schemaId('benchmark-workloads'),
    corpus.benchmarks,
    corpus.registry,
    'benchmarks/phase0/workloads.json',
  ));
  diagnostics.push(...findSecretDiagnostics(corpus.benchmarks, 'benchmarks/phase0/workloads.json'));
  diagnostics.push(...validateBenchmarkDefinitions(corpus.benchmarks));
  return sortDiagnostics(diagnostics);
}

export function parseArgs(args) {
  if (args.length === 0) return { root: process.cwd() };
  if (args.length === 2 && args[0] === '--root') return { root: args[1] };
  throw new Error('usage: node tools/phase0/validate.mjs [--root <path>]');
}

export async function validateRepository(root) {
  return validatePhase0Corpus(await loadPhase0Corpus(root));
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { root } = parseArgs(args);
    const diagnostics = await validateRepository(root);
    if (diagnostics.length > 0) {
      process.stderr.write(`${formatDiagnostics(diagnostics)}\n`);
      return EXIT_CONTRACT_INVALID;
    }
    process.stdout.write('Phase 0 corpus valid\n');
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`PHASE0_VALIDATOR_FAILURE: ${error.message}\n`);
    return EXIT_TOOL_FAILURE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
```

- [ ] **Step 7: Run benchmark-definition verification**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: all tests pass, benchmark definitions validate without a result or
threshold, and the complete corpus remains valid.

- [ ] **Step 8: Commit benchmark definitions**

```powershell
git add benchmarks/phase0/README.md benchmarks/phase0/workloads.json schemas/phase0/v1/benchmark-workloads.schema.json tools/phase0/corpus.test.mjs tools/phase0/validate.mjs tools/phase0/lib/domain.mjs
git commit -m "docs: define phase 0 benchmark protocols"
```

### Task 11: Reconcile every canonical document with the Phase 0 contracts

**Files:**
- Modify: `docs/TERMINOLOGY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/LIFECYCLE.md`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/AGENTS.md`
- Modify: `docs/CLI.md`
- Modify: `README.md`
- Modify: `tools/phase0/corpus.test.mjs`
- Modify: `tools/phase0/validate.mjs`

- [ ] **Step 1: Capture the expected documentation failures**

Run:

```powershell
rg -n "docs/protocol/identities.md|docs/protocol/events.md|docs/THREAT_MODEL.md|tools/phase0/validate.mjs" README.md docs/ROADMAP.md docs/ARCHITECTURE.md docs/LIFECYCLE.md docs/TERMINOLOGY.md docs/AGENTS.md docs/CLI.md
```

Expected before reconciliation: the new normative artifacts are absent from at least
the roadmap, architecture, lifecycle, terminology, agent rules, and README.

- [ ] **Step 2: Make terminology authoritative and remove conflicting semantics**

Apply these exact changes to `docs/TERMINOLOGY.md`:

1. Under `### Repository`, add:

```markdown
The machine identity is an opaque `repositoryId` persisted in PatchMesh-owned Git
common-directory metadata. It is not derived from a remote URL, path, branch, or
commit. See [Identity and Resource-Version Protocol](protocol/identities.md).
```

2. Under `### Workspace`, add:

```markdown
`workspaceId` identifies the filesystem and execution context. It is distinct from
the worktree identity; multiple workspaces may refer to one worktree.
```

3. Under `### Worktree`, add:

```markdown
`worktreeId` is path-independent. Linked worktrees share a repository ID and retain
distinct worktree IDs.
```

4. Replace the `Read Version` definition with:

```markdown
### Read Version

A prose alias for **Observed Version**. Protocol schemas use `observed` and do not
define a separate read-version field.
```

5. Under `### Integration Target`, add that validity uses an immutable
`targetSnapshotId`, never only a moving branch name.

6. Under `### Observability Coverage`, add:

```markdown
Coverage records are scoped evidence. `intercepted` and `verified` are orthogonal.
A relevant gap derives `degraded` presentation, and `inferred` evidence cannot
silently substitute for direct observation. See
[Dependency Evidence and Observability Coverage](protocol/evidence-and-coverage.md).
```

7. Under `### Task Validity Record`, add:

```markdown
Task execution state and work-product validity are separate projections. `completed`
is an execution state; `valid`, `possibly_stale`, `revalidating`, and `stale` are
validity states for a named work product and target snapshot.
```

8. Replace the Decision required-field list with:

```markdown
A decision must include:

- Source finding
- Target agent or task
- Coordination action
- Gateway directive
- Reason
- Evidence
- Confidence and policy version
- Expected response
- Coverage evidence and gaps
```

9. Add direct links from Event, Decision, Task Validity Record, and Replay to their
normative documents in `docs/protocol/`.

- [ ] **Step 3: Point architecture at normative machine contracts**

In `docs/ARCHITECTURE.md`:

1. Replace the existing `Every event must include` field list and following ordering
paragraph with:

```markdown
Every stored event follows [Event Protocol V1](protocol/events.md) and its versioned
JSON Schema. The closed envelope includes explicit worktree identity, required
nullable agent/task attribution, source-instance sequencing, correlation, causation,
and one event-type-selected payload. Event ingestion is idempotent by event ID and
canonical content digest; timestamp, source, and causal order remain distinct.
```

2. At `Version domains and integration targets`, link
`protocol/identities.md` and state that evaluations pin immutable target snapshots.

3. After the recommended repository structure, add:

```markdown
Phase 0 contract artifacts live under `docs/protocol/`, `schemas/phase0/`,
`fixtures/`, `benchmarks/phase0/`, and `tools/phase0/`. They are implementation inputs,
not Phase 1 runtime packages.
```

4. Replace the one-line replay rule with a link to
`protocol/replay-equivalence.md` and name incremental, cold, duplicate, and valid
out-of-order equivalence.

5. Add `Expected validity` and `Expected coverage` to the scenario-definition list.

6. Link the Security Principles section to `THREAT_MODEL.md` and state that Phase 0
defines mitigations and residual risks but implements no sandbox or event signing.

- [ ] **Step 4: Separate execution, validity, decision, and delivery lifecycle state**

In `docs/LIFECYCLE.md`:

1. Retain `queued`, `assigned`, `running`, `waiting`, `blocked`, `paused`, `completed`,
`failed`, and `cancelled` as task execution states. Move `possibly_stale`, `stale`,
`revalidating`, and `valid` into a new `### Work-product validity` subsection.

2. Replace the existing validity invariant block with the exact transition table from
`docs/protocol/validity.md`, including `unassessed`, guard reasons, obsolete-target
handling, and new-record handling for reworked output.

3. In Tool Call Lifecycle Step 1, replace the task-only nullability sentence with:

```markdown
Every event contains required `agentId` and `taskId` fields whose values may be null
when attribution is unavailable. Later attribution is a new immutable
`attribution.corrected` event; the original event is never rewritten.
```

4. In Event Lifecycle, link `protocol/events.md` for idempotency, correlation,
causation, and ordering.

5. Replace the Decision Lifecycle diagram with:

```text
Finding evaluated
-> decision.created stored
-> targeted delivery pending
-> delivered | failed
-> acknowledged when a response arrives
-> decision resolved by a later event
```

Then state that decision state and delivery state are separate, duplicate delivery
events are idempotent, and replay never dispatches. Link `protocol/coordination.md`.

6. In Recovery Lifecycle, link `protocol/replay-equivalence.md` and explicitly disable
tool execution and decision delivery during projection replay.

- [ ] **Step 5: Add the Phase 0 evidence index without changing roadmap scope**

Immediately after the Phase 0 exit gates in `docs/ROADMAP.md`, add:

```markdown
**Evidence implementation:**

- identity and version rules: [`docs/protocol/identities.md`](protocol/identities.md);
- event envelope and ordering: [`docs/protocol/events.md`](protocol/events.md);
- action, directive, and delivery rules: [`docs/protocol/coordination.md`](protocol/coordination.md);
- validity invariants: [`docs/protocol/validity.md`](protocol/validity.md);
- provenance and coverage: [`docs/protocol/evidence-and-coverage.md`](protocol/evidence-and-coverage.md);
- replay equivalence: [`docs/protocol/replay-equivalence.md`](protocol/replay-equivalence.md);
- threat model: [`docs/THREAT_MODEL.md`](THREAT_MODEL.md);
- schemas, golden scenarios, benchmark definitions, and validator:
  `schemas/phase0/`, `fixtures/`, `benchmarks/phase0/`, and
  `tools/phase0/validate.mjs`.

These artifacts define and validate Phase 0 behavior. They do not implement Phase 1
runtime observation, storage, projections, or CLI commands.
```

Do not change the Phase 0 status yet. Task 12 changes it only after all exit checks
pass.

- [ ] **Step 6: Strengthen agent implementation guardrails**

In `docs/AGENTS.md`:

1. Add `docs/protocol/` and `docs/THREAT_MODEL.md` to Required Reading for protocol,
identity, event, validity, coverage, or security changes.
2. Replace the event required-field list with the exact Event Protocol V1 envelope,
including `worktreeId` and nullable `agentId`/`taskId`.
3. Add:

```markdown
Phase 0 contract changes must update normative Markdown, versioned schemas, affected
golden and negative fixtures, canonical documentation, and validator tests together.
Run `node tools/phase0/validate.mjs` before committing.
```

4. Add this phase boundary:

```markdown
Phase 0 may contain documentation, schemas, fixtures, benchmark definitions, and
dependency-free validation tooling. Do not introduce the TypeScript/pnpm product
workspace, adapters, storage, daemon, or CLI until Phase 1 work is explicitly started.
```

5. Add canonical digest conflict, unsafe path, cross-domain identity, and secret scan
checks to Security and Testing Rules.

- [ ] **Step 7: Keep CLI and README examples honest and synchronized**

In `docs/CLI.md`:

1. In the JSON-output contract, state that the eventual protocol envelope requires
`workspaceId`, `worktreeId`, nullable `agentId`, and nullable `taskId`; the existing
JSON block remains illustrative.
2. Replace any statement implying only task attribution may be unknown with:

```markdown
Unavailable agent or task attribution is represented by `null`. Later attribution is
an immutable correction event, not mutation of the original event.
```

3. Link the JSON-output section to `protocol/events.md` and the Secret Handling
section to `THREAT_MODEL.md`.
4. Do not add, remove, schedule, or implement a CLI command.

In `README.md`, add this item to the Documentation list:

```markdown
- [Phase 0 contracts](docs/protocol/identities.md) — versioned identities, events,
  coordination, validity, evidence, replay fixtures, security, and benchmark inputs
```

Add one sentence after the list:

```markdown
Run `node tools/phase0/validate.mjs` to verify the Phase 0 contract corpus. This is
development validation, not a released PatchMesh CLI.
```

Keep the README's documentation-first and planned-capability language unchanged.

- [ ] **Step 8: Add documentation synchronization assertions**

Append to `tools/phase0/corpus.test.mjs`:

```javascript
import { readFile } from 'node:fs/promises';

test('canonical documents link the Phase 0 contracts without claiming Phase 1', async () => {
  const root = new URL('../..', import.meta.url);
  const required = new Map([
    ['README.md', ['docs/protocol/identities.md', 'node tools/phase0/validate.mjs']],
    ['docs/ROADMAP.md', ['protocol/events.md', 'tools/phase0/validate.mjs']],
    ['docs/ARCHITECTURE.md', ['protocol/identities.md', 'protocol/replay-equivalence.md']],
    ['docs/LIFECYCLE.md', ['protocol/validity.md', 'attribution.corrected']],
    ['docs/TERMINOLOGY.md', ['protocol/evidence-and-coverage.md', 'targetSnapshotId']],
    ['docs/AGENTS.md', ['node tools/phase0/validate.mjs', 'Phase 0 may contain']],
    ['docs/CLI.md', ['protocol/events.md', 'immutable correction event']],
  ]);

  for (const [path, fragments] of required) {
    const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    for (const fragment of fragments) {
      assert.match(content, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }

  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /documentation-first/);
  assert.doesNotMatch(readme, /Phase 1 is implemented|PatchMesh CLI is released/);
});
```

If `readFile` is already imported in `corpus.test.mjs`, extend that import instead of
adding a duplicate declaration.

- [ ] **Step 9: Run documentation and corpus verification**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
rg -n "protocol/identities.md|protocol/events.md|THREAT_MODEL.md|tools/phase0/validate.mjs" README.md docs/ROADMAP.md docs/ARCHITECTURE.md docs/LIFECYCLE.md docs/TERMINOLOGY.md docs/AGENTS.md docs/CLI.md
git diff --check
```

Expected: tests and corpus validation pass; every canonical document has its required
link or validator contract; no command availability changed; diff check is clean.

- [ ] **Step 10: Commit canonical documentation reconciliation**

```powershell
git add README.md docs/ROADMAP.md docs/ARCHITECTURE.md docs/LIFECYCLE.md docs/TERMINOLOGY.md docs/AGENTS.md docs/CLI.md tools/phase0/corpus.test.mjs tools/phase0/validate.mjs
git commit -m "docs: reconcile canonical phase 0 contracts"
```

### Task 12: Prove every Phase 0 exit gate and mark the foundation complete

**Files:**
- Modify: `docs/ROADMAP.md`
- Verify only: every file created or modified by Tasks 1–11

- [ ] **Step 1: Run the complete automated suite from a clean task boundary**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
```

Expected: all tests pass, the validator prints exactly `Phase 0 corpus valid`, and the
diff check emits no output. Stop on any failure; do not update roadmap status.

- [ ] **Step 2: Prove scenario completeness and exact corpus membership**

Run:

```powershell
$positive = Get-ChildItem -Directory -LiteralPath 'fixtures\scenarios\v1' |
  Where-Object { (Get-Content -Raw -LiteralPath (Join-Path $_.FullName 'manifest.json') | ConvertFrom-Json).kind -eq 'positive' }
$negative = @(
  Get-ChildItem -Directory -LiteralPath 'fixtures\invalid\v1'
  Get-ChildItem -Directory -LiteralPath 'fixtures\scenarios\v1' |
    Where-Object { (Get-Content -Raw -LiteralPath (Join-Path $_.FullName 'manifest.json') | ConvertFrom-Json).kind -eq 'negative' }
)
$requiredPositive = @(
  'duplicate-and-out-of-order',
  'irrelevant-concurrent-change',
  'late-attribution',
  'opaque-shell-degraded',
  'relevant-exported-contract'
)
$requiredNegative = @(
  'conflicting-duplicate-id',
  'coverage-overclaim',
  'cross-domain-reference',
  'invalid-transition',
  'missing-reference',
  'path-traversal',
  'synthetic-secret',
  'unsupported-schema'
)
if (Compare-Object $requiredPositive ($positive.Name | Sort-Object)) { throw 'positive scenario set mismatch' }
if (Compare-Object $requiredNegative ($negative.Name | Sort-Object)) { throw 'negative fixture set mismatch' }
$requiredOutputs = @(
  'events.ndjson',
  'expected-graph.json',
  'expected-findings.json',
  'expected-decisions.json',
  'expected-validity.json',
  'expected-coverage.json'
)
foreach ($scenario in $positive) {
  foreach ($name in $requiredOutputs) {
    if (-not (Test-Path -LiteralPath (Join-Path $scenario.FullName $name))) {
      throw "missing $name in $($scenario.Name)"
    }
  }
}
```

Expected: no output and exit `0`.

- [ ] **Step 3: Prove schema, fixture, link, placeholder, and phase-boundary hygiene**

Run:

```powershell
$jsonFiles = Get-ChildItem -Recurse -File schemas\phase0,fixtures,benchmarks\phase0 -Filter '*.json'
foreach ($file in $jsonFiles) {
  Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json | Out-Null
}
$missingLinks = @()
$markdownFiles = Get-ChildItem -Recurse -File README.md,docs -Filter '*.md'
foreach ($file in $markdownFiles) {
  $content = Get-Content -Raw -LiteralPath $file.FullName
  foreach ($match in [regex]::Matches($content, '\[[^\]]+\]\((?!https?://|#)([^)#]+)(?:#[^)]+)?\)')) {
    $target = Join-Path $file.DirectoryName $match.Groups[1].Value
    if (-not (Test-Path -LiteralPath $target)) { $missingLinks += "$($file.FullName): $target" }
  }
}
if ($missingLinks.Count -gt 0) { $missingLinks; throw 'missing local Markdown links' }
$placeholderMatches = rg -n "T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details" docs\protocol docs\THREAT_MODEL.md schemas\phase0 fixtures benchmarks\phase0 tools\phase0
if ($LASTEXITCODE -eq 0) { $placeholderMatches; throw 'placeholder text remains' }
if ($LASTEXITCODE -ne 1) { throw 'placeholder scan failed' }
$forbiddenRuntimePaths = @('package.json', 'pnpm-workspace.yaml', 'packages', 'apps') |
  Where-Object { Test-Path -LiteralPath $_ }
if ($forbiddenRuntimePaths.Count -gt 0) { $forbiddenRuntimePaths; throw 'Phase 1 runtime surface was introduced' }
```

Expected: every JSON document parses, every local Markdown link resolves, the
placeholder scan has no match, no Phase 1 path exists, and the script exits `0`.

- [ ] **Step 4: Check every roadmap exit gate against concrete evidence**

Review and record these exact pass conditions in the task report:

| Phase 0 exit gate | Required evidence |
| --- | --- |
| Every scenario has events, graph, findings, decisions, and coverage | Step 2 plus manifests and expected files |
| No identity or nullability conflicts | identity/event schemas, schema tests, cross-domain negative fixture |
| Replay tests need no invented behavior | replay contract and canonical/duplicate/out-of-order manifest |
| Opaque shell and adapter limitations degrade explicitly | opaque-shell scenario and coverage-overclaim negative |
| Planned behavior is labeled consistently | Task 11 documentation test and README/CLI planned language |
| Threat model covers required risks | threat-to-fixture matrix and seven security negatives plus conflict scenario |
| Benchmarks are defined without fabricated measurements | benchmark schema, nine workload definitions, and result-leakage rule |

If any row lacks the named evidence, return to its owning task. Do not weaken the row
or mark the roadmap complete.

- [ ] **Step 5: Mark only Phase 0 complete**

In `docs/ROADMAP.md`, change the line immediately below `## Phase 0 — Foundation`
from:

```markdown
**Status:** Current
```

to:

```markdown
**Status:** Complete — contract corpus and exit evidence verified.
```

Do not change the document-level `Status: Planned`, because PatchMesh still has no
released runtime implementation. Do not alter Phase 1 or later status.

- [ ] **Step 6: Re-run all checks after the status change**

Run:

```powershell
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff --check
rg -n -A 2 "^## Phase 0" docs/ROADMAP.md
rg -n "documentation-first|no released implementation|target CLI behavior" README.md docs/ROADMAP.md docs/CLI.md
```

Expected: all automated checks pass; Phase 0 alone says Complete; repository and CLI
status still say documentation-first/planned with no released implementation.

- [ ] **Step 7: Review exact change scope**

Run:

```powershell
git status --short
git diff --stat HEAD
git diff --check HEAD
```

Expected: only `docs/ROADMAP.md` is uncommitted at this task boundary, the diff is the
single Phase 0 status line, and whitespace validation is clean.

- [ ] **Step 8: Commit the verified Phase 0 completion marker**

```powershell
git add docs/ROADMAP.md
git commit -m "docs: mark phase 0 foundation complete"
```

- [ ] **Step 9: Verify the final branch state**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -12
node --test tools/phase0/diagnostics.test.mjs tools/phase0/schema.test.mjs tools/phase0/domain.test.mjs tools/phase0/corpus.test.mjs
node tools/phase0/validate.mjs
git diff HEAD~12..HEAD --check
```

Expected: the worktree is clean; the Phase 0 task commits are visible; all tests and
corpus validation pass; the complete Phase 0 commit range has no whitespace errors.

## Approved-Spec Traceability

| Approved design requirement | Implementing task |
| --- | --- |
| Language-neutral boundary and no Phase 1 scaffolding | Preconditions, Tasks 11–12 |
| Repository/worktree/workspace/target/resource identity | Task 3 |
| Event v1, correlation, causation, ordering, idempotency, attribution | Tasks 4 and 6 |
| Separate action/directive vocabularies and phase capability | Tasks 5 and 6 |
| Separate task execution and work-product validity | Tasks 5 and 6 |
| Decision delivery state without Phase 4 retry policy | Tasks 5–7 |
| Dependency provenance and scoped coverage | Tasks 5, 6, and 8 |
| Replay and canonical projection equivalence | Task 9 |
| Local identity, event, path, and redaction threat model | Task 8 |
| Relevant and irrelevant golden scenarios | Task 7 |
| Degraded, late-attribution, duplicate, out-of-order, and conflict scenarios | Tasks 8–9 |
| Interception, replay, and detector-quality benchmark definitions | Task 10 |
| Dependency-free validator and stable diagnostics | Tasks 1–10 |
| Canonical-document synchronization | Task 11 |
| Every roadmap exit gate mechanically reviewed | Task 12 |

## Repair Reconciliation (2026-08-07)

The Phase 0 validator repair plan at
`docs/superpowers/plans/2026-08-07-phase-0-validator-repair.md` strengthened the
manifest, dependency-edge, validity, decision-target, event-payload, benchmark,
secret-scan, and canonical-ordering invariants. After the repair, the Node test
suite and `node tools/phase0/validate.mjs` both pass, `git diff --check` is clean,
and the Phase 0 status line above remains `Complete — contract corpus and exit
evidence verified.` No commit was created unless explicitly requested.
