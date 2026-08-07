import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalDigest, canonicalize } from './lib/canonical-json.mjs';
import { EXIT_CONTRACT_INVALID, EXIT_OK, EXIT_TOOL_FAILURE, diagnostic, formatDiagnostics, sortDiagnostics } from './lib/diagnostics.mjs';
import { findSecretDiagnostics } from './lib/secrets.mjs';

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
