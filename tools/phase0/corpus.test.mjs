import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadPhase0Corpus, validateOneScenario, validatePhase0Corpus } from './validate.mjs';
import { validateScenarioDomain } from './lib/domain.mjs';

const root = new URL('../..', import.meta.url);
test('the complete positive and negative corpus validates', async () => { const corpus = await loadPhase0Corpus(root); assert.equal(corpus.positiveScenarios.length, 5); assert.equal(corpus.negativeFixtures.length, 19); assert.deepEqual(await validatePhase0Corpus(corpus), []); });
test('relevant, irrelevant, degraded, and attribution projections are explicit', async () => { const corpus = await loadPhase0Corpus(root); const relevant = corpus.positiveScenarios.find(({ manifest }) => manifest.scenarioId === 'scenario_relevant_exported_contract'); assert.equal(relevant.expected.findings.length, 1); assert.equal(relevant.expected.decisions[0].coordinationAction, 'request_revalidation'); assert.equal(relevant.expected.decisions[0].gatewayDirective, 'allow_with_notice'); assert.equal(relevant.expected.validity[0].validityState, 'possibly_stale'); const irrelevant = corpus.positiveScenarios.find(({ manifest }) => manifest.scenarioId === 'scenario_irrelevant_concurrent_change'); assert.deepEqual(irrelevant.expected.findings, []); const opaque = corpus.positiveScenarios.find(({ manifest }) => manifest.scenarioId === 'scenario_opaque_shell_degraded'); assert.equal(opaque.expected.coverage[0].presentation, 'degraded'); const attribution = corpus.positiveScenarios.find(({ manifest }) => manifest.scenarioId === 'scenario_late_attribution'); assert.equal(attribution.events[0].value.agentId, null); assert.equal(attribution.events[1].value.eventType, 'attribution.corrected'); });
test('negative fixtures declare stable primary error codes', async () => { const corpus = await loadPhase0Corpus(root); const expected = new Map([['scenario_empty_decision_target', 'PHASE0_SCHEMA_INVALID'], ['scenario_invalid_path_traversal', 'PHASE0_SCHEMA_INVALID'], ['scenario_invalid_cross_domain', 'PHASE0_SCHEMA_INVALID'], ['scenario_invalid_transition', 'PHASE0_TRANSITION_INVALID'], ['scenario_invalid_coverage', 'PHASE0_COVERAGE_OVERCLAIMED'], ['scenario_unsupported_schema', 'PHASE0_SCHEMA_UNSUPPORTED'], ['scenario_missing_reference', 'PHASE0_REFERENCE_MISSING'], ['scenario_synthetic_secret', 'PHASE0_SECRET_PATTERN'], ['scenario_variant_secret_in_expected', 'PHASE0_SECRET_PATTERN'], ['scenario_conflicting_duplicate_id', 'PHASE0_ID_CONFLICT'], ['scenario_positive_without_expected', 'PHASE0_SCHEMA_INVALID'], ['scenario_negative_without_error', 'PHASE0_SCHEMA_INVALID'], ['scenario_dependency_edge_mismatch', 'PHASE0_ID_CONFLICT'], ['scenario_dependency_impact_without_event', 'PHASE0_TRANSITION_INVALID'], ['scenario_transition_target_mismatch', 'PHASE0_TRANSITION_INVALID'], ['scenario_deterministic_proof_resurrects', 'PHASE0_TRANSITION_INVALID'], ['scenario_dependency_endpoint_mismatch', 'PHASE0_ID_CONFLICT'], ['scenario_empty_delivery_target', 'PHASE0_SCHEMA_INVALID'], ['scenario_malformed_event', 'PHASE0_SCHEMA_INVALID']]); assert.deepEqual(new Map(corpus.negativeFixtures.map(({ manifest }) => [manifest.scenarioId, manifest.expectedError ?? 'PHASE0_SCHEMA_INVALID'])), expected); });
test('every negative fixture produces its declared primary error as the first diagnostic', async () => {
  const corpus = await loadPhase0Corpus(root);
  for (const fixture of corpus.negativeFixtures) {
    const diagnostics = validateOneScenario(fixture, corpus.registry);
    assert.ok(diagnostics.length > 0, `${fixture.directory} produced no diagnostics`);
    const expectedError = fixture.manifest.expectedError ?? 'PHASE0_SCHEMA_INVALID';
    assert.equal(diagnostics[0].code, expectedError, `${fixture.directory} first diagnostic ${diagnostics[0].code} did not match declared ${expectedError}`);
  }
});
test('schema-invalid canonical events do not reach domain validation', async () => {
  const corpus = await loadPhase0Corpus(root);
  const fixture = corpus.negativeFixtures.find(({ manifest }) => manifest.scenarioId === 'scenario_malformed_event');
  let diagnostics;
  assert.doesNotThrow(() => { diagnostics = validateOneScenario(fixture, corpus.registry); });
  assert.equal(diagnostics[0].code, 'PHASE0_SCHEMA_INVALID');
  assert.ok(diagnostics.some(({ message }) => message === 'event must be a non-null object'));
  assert.doesNotMatch(diagnostics.map(({ message }) => message).join('\n'), /PHASE0_VALIDATOR_FAILURE/);
});
test('validity guard fixtures isolate their intended domain diagnostic', async () => {
  const corpus = await loadPhase0Corpus(root);
  const expected = new Map([
    ['scenario_dependency_impact_without_event', ['/validity/0/lastTransition', 'dependency impact evidence must include a dependency.changed event']],
    ['scenario_transition_target_mismatch', ['/validity/0/lastTransition', 'transition target must equal the current record target']],
    ['scenario_deterministic_proof_resurrects', ['/validity/0/lastTransition', 'deterministic proof cannot make an obsolete target current']],
  ]);
  for (const scenario of corpus.negativeFixtures.filter(({ manifest }) => expected.has(manifest.scenarioId))) {
    const diagnostics = validateScenarioDomain(scenario);
    assert.deepEqual(diagnostics.map(({ pointer, message }) => [pointer, message]), [expected.get(scenario.manifest.scenarioId)], scenario.manifest.scenarioId);
  }
});
test('replay variants declare canonical, duplicate, and out-of-order equivalence', async () => { const corpus = await loadPhase0Corpus(root); const replay = corpus.positiveScenarios.find(({ manifest }) => manifest.scenarioId === 'scenario_duplicate_and_out_of_order'); assert.deepEqual(replay.variants.map(({ name, equivalentTo }) => ({ name, equivalentTo })), [{ name: 'duplicates', equivalentTo: 'canonical' }, { name: 'out-of-order', equivalentTo: 'canonical' }]); });
test('variant expected artifacts are secret-scanned', async () => {
  const corpus = await loadPhase0Corpus(root);
  const fixture = corpus.negativeFixtures.find(({ manifest }) => manifest.scenarioId === 'scenario_variant_secret_in_expected');
  const diagnostics = validateOneScenario(fixture, corpus.registry);
  assert.ok(diagnostics.some((item) => item.code === 'PHASE0_SECRET_PATTERN' && item.path.endsWith('/canonical-variant/expected-coverage.json')));
});
test('benchmark definitions cover all Phase 0 measurement classes', async () => { const corpus = await loadPhase0Corpus(root); assert.equal(corpus.benchmarks.schemaVersion, 1); assert.deepEqual([...new Set(corpus.benchmarks.workloads.map(({ kind }) => kind))].sort(), ['detector_quality', 'interception_latency', 'replay']); assert.deepEqual(corpus.benchmarks.workloads.filter(({ kind }) => kind === 'detector_quality').map(({ detector }) => detector).sort(), ['exported_contract_invalidation', 'same_symbol_overlap', 'stale_read_before_write']); });
test('canonical documents link the contract corpus without claiming a released runtime', async () => { const required = new Map([['README.md', ['docs/protocol/identities.md', 'node tools/phase0/validate.mjs']], ['docs/ROADMAP.md', ['protocol/events.md', 'tools/phase0/validate.mjs']], ['docs/ARCHITECTURE.md', ['protocol/identities.md', 'protocol/replay-equivalence.md']], ['docs/LIFECYCLE.md', ['protocol/validity.md', 'attribution.corrected']], ['docs/TERMINOLOGY.md', ['protocol/evidence-and-coverage.md', 'targetSnapshotId']], ['docs/AGENTS.md', ['node tools/phase0/validate.mjs', 'Phase 0 may contain']], ['docs/CLI.md', ['protocol/events.md', 'immutable correction event']]]); for (const [path, fragments] of required) { const content = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'); for (const fragment of fragments) assert.match(content, new RegExp(fragment.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))); } });
