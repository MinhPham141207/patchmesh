import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest, canonicalize } from './lib/canonical-json.mjs';
import { EXIT_CONTRACT_INVALID, EXIT_OK, EXIT_TOOL_FAILURE, diagnostic, formatDiagnostics, sortDiagnostics } from './lib/diagnostics.mjs';
import { findSecretDiagnostics } from './lib/secrets.mjs';

async function runMain(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./validate.mjs', import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stderr: '', stdout: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ ...output, code }));
  });
}

function assertSanitizedContractFailure(result) {
  assert.equal(result.code, EXIT_CONTRACT_INVALID);
  assert.match(result.stderr, /^PHASE0_SCHEMA_INVALID /m);
  assert.doesNotMatch(result.stderr, /PHASE0_VALIDATOR_FAILURE/);
  assert.doesNotMatch(result.stderr, /[A-Za-z]:[\\/]/);
}

test('canonicalize sorts object keys recursively and preserves array order', () => assert.equal(canonicalize({ z: 1, a: { y: true, b: ['second', 'first'] } }), '{"a":{"b":["second","first"],"y":true},"z":1}'));
test('canonicalDigest is stable for objects with different insertion order', () => assert.equal(canonicalDigest({ b: 2, a: 1 }), canonicalDigest({ a: 1, b: 2 })));
test('canonicalize rejects non-JSON numbers', () => assert.throws(() => canonicalize({ bad: Number.NaN }), /finite JSON number/));
test('diagnostics sort by path, pointer, and code and never include rejected values', () => {
  const diagnostics = sortDiagnostics([diagnostic('PHASE0_ID_CONFLICT', 'z.json', '/eventId', 'conflicting event ID'), diagnostic('PHASE0_SCHEMA_INVALID', 'a.json', '/payload', 'invalid payload'), diagnostic('PHASE0_REFERENCE_MISSING', 'a.json', '/causationId', 'missing event')]);
  assert.deepEqual(diagnostics.map(({ code }) => code), ['PHASE0_REFERENCE_MISSING', 'PHASE0_SCHEMA_INVALID', 'PHASE0_ID_CONFLICT']);
  assert.equal(formatDiagnostics(diagnostics), 'PHASE0_REFERENCE_MISSING a.json/causationId: missing event\nPHASE0_SCHEMA_INVALID a.json/payload: invalid payload\nPHASE0_ID_CONFLICT z.json/eventId: conflicting event ID');
});
test('validator exit codes are stable', () => assert.deepEqual({ EXIT_OK, EXIT_CONTRACT_INVALID, EXIT_TOOL_FAILURE }, { EXIT_OK: 0, EXIT_CONTRACT_INVALID: 1, EXIT_TOOL_FAILURE: 2 }));
test('secret diagnostics identify location without echoing the value', () => {
  const diagnostics = findSecretDiagnostics({ headers: { authorization: 'Bearer synthetic-value-for-test' } }, 'fixture.json');
  assert.equal(diagnostics[0].code, 'PHASE0_SECRET_PATTERN');
  assert.equal(diagnostics[0].pointer, '/headers/authorization');
  assert.doesNotMatch(formatDiagnostics(diagnostics), /synthetic-value-for-test/);
});

test('missing benchmark root returns a sanitized contract diagnostic', async () => {
  const root = fileURLToPath(new URL('../../docs/superpowers/plans/', import.meta.url));
  assertSanitizedContractFailure(await runMain(['--root', root]));
});

test('malformed schema JSON returns a sanitized contract diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase0-validator-'));
  try {
    const schemaDirectory = join(root, 'schemas', 'phase0', 'v1');
    await mkdir(schemaDirectory, { recursive: true });
    await writeFile(join(schemaDirectory, 'malformed.schema.json'), '{', 'utf8');
    assertSanitizedContractFailure(await runMain(['--root', root]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('null canonical events return exit code 1 with a sanitized schema diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phase0-null-event-'));
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  try {
    await cp(join(repositoryRoot, 'schemas', 'phase0', 'v1'), join(root, 'schemas', 'phase0', 'v1'), { recursive: true });
    await cp(join(repositoryRoot, 'benchmarks', 'phase0'), join(root, 'benchmarks', 'phase0'), { recursive: true });
    const scenarioDirectory = join(root, 'fixtures', 'scenarios', 'v1', 'null-event');
    await mkdir(scenarioDirectory, { recursive: true });
    await writeFile(join(scenarioDirectory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, scenarioId: 'scenario_null_event', title: 'null event', targetPhase: 1, kind: 'positive', eventsFile: 'events.ndjson', expected: null, variants: [], expectedError: null }), 'utf8');
    await writeFile(join(scenarioDirectory, 'events.ndjson'), 'null\n', 'utf8');
    const result = await runMain(['--root', root]);
    assert.equal(result.code, EXIT_CONTRACT_INVALID);
    assert.match(result.stderr, /^PHASE0_SCHEMA_INVALID /m);
    assert.doesNotMatch(result.stderr, /PHASE0_VALIDATOR_FAILURE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
