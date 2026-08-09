import process from 'node:process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXIT_CONTRACT_INVALID, EXIT_OK, EXIT_TOOL_FAILURE, diagnostic, formatDiagnostics, sortDiagnostics } from './lib/diagnostics.mjs';
import { canonicalDigest, canonicalize } from './lib/canonical-json.mjs';
import { CorpusContractError, discoverScenarioDirectories, loadScenario, readJson, walkFiles } from './lib/corpus.mjs';
import { canonicalEventSet, canonicalSnapshot, validateBenchmarkDefinitions, validateManifestSemantics, validateScenarioDomain } from './lib/domain.mjs';
import { createSchemaRegistry, validateInstance, validateSchemaDocuments } from './lib/schema.mjs';
import { findSecretDiagnostics } from './lib/secrets.mjs';

const BASE = 'https://patchmesh.dev/schemas/phase0/v1';
const PAYLOAD_REF_BY_EVENT_TYPE = new Map([
  ['tool.requested', 'toolRequested'], ['tool.completed', 'toolCompleted'], ['file.read', 'resourceObserved'], ['file.changed', 'resourceChanged'], ['symbol.read', 'resourceObserved'], ['symbol.changed', 'resourceChanged'], ['task.completed', 'taskCompleted'], ['dependency.changed', 'dependencyChanged'], ['attribution.corrected', 'attributionCorrected'], ['finding.created', 'findingCreated'], ['decision.created', 'decisionCreated'], ['validity.changed', 'validityChanged'], ['decision.delivery.changed', 'decisionDeliveryChanged'],
]);
const schemaId = (name) => `${BASE}/${name}.schema.json`;
const rootPath = (root) => root instanceof URL ? fileURLToPath(root) : resolve(root);
const normalized = (value) => value.replaceAll('\\', '/');

async function loadSchemas(root) {
  const files = (await walkFiles(join(root, 'schemas', 'phase0', 'v1'))).filter((path) => path.endsWith('.schema.json'));
  const documents = await Promise.all(files.map(async (path) => ({ path: normalized(relative(root, path)), schema: await readJson(root, path) })));
  return createSchemaRegistry(documents);
}
export async function loadPhase0Corpus(input) {
  const root = rootPath(input); const registry = await loadSchemas(root);
  const scenarioDirectories = await discoverScenarioDirectories(root, 'fixtures/scenarios/v1'); const invalidDirectories = await discoverScenarioDirectories(root, 'fixtures/invalid/v1');
  const scenarios = await Promise.all(scenarioDirectories.map((directory) => loadScenario(root, directory))); const invalid = await Promise.all(invalidDirectories.map((directory) => loadScenario(root, directory)));
  return { root, registry, positiveScenarios: scenarios.filter(({ manifest }) => manifest.kind === 'positive'), negativeFixtures: [...scenarios.filter(({ manifest }) => manifest.kind === 'negative'), ...invalid].sort((a, b) => a.manifest.scenarioId.localeCompare(b.manifest.scenarioId)), benchmarks: await readJson(root, join(root, 'benchmarks', 'phase0', 'workloads.json')) };
}
function machineSecrets(scenario) {
  const diagnostics = [...findSecretDiagnostics(scenario.manifest, `${scenario.directory}/manifest.json`), ...scenario.events.flatMap(({ line, value }) => findSecretDiagnostics(value, `${scenario.directory}/events.ndjson:${line}`))];
  if (scenario.expected) diagnostics.push(...expectedBundleSecrets(scenario.expected, scenario.directory));
  for (const variant of scenario.variants) for (const { line, value } of variant.events) diagnostics.push(...findSecretDiagnostics(value, `${scenario.directory}/${variant.name}:${line}`));
  return diagnostics;
}
function expectedBundleSecrets(expected, basePath) {
  const diagnostics = [];
  for (const [name, value] of Object.entries(expected)) diagnostics.push(...findSecretDiagnostics(value, `${basePath}/expected-${name}.json`));
  return diagnostics;
}
function isExpectedBundle(expected) {
  return expected !== null && typeof expected === 'object' && !Array.isArray(expected) &&
    expected.graph !== null && typeof expected.graph === 'object' && !Array.isArray(expected.graph) &&
    ['findings', 'decisions', 'validity', 'coverage'].every((name) => Array.isArray(expected[name]));
}
function expectedBundleSchemas(expected, basePath, registry) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    return [diagnostic('PHASE0_SCHEMA_INVALID', basePath, '', 'expected projection bundle must be a non-null object')];
  }
  const diagnostics = [...validateInstance(schemaId('graph'), expected.graph, registry, `${basePath}/expected-graph.json`)];
  for (const [name, schema] of [['findings', 'finding'], ['decisions', 'decision'], ['validity', 'task-validity'], ['coverage', 'coverage']]) {
    if (!Array.isArray(expected[name])) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', `${basePath}/expected-${name}.json`, '', `expected ${name} must be an array`));
      continue;
    }
    for (const [index, value] of expected[name].entries()) diagnostics.push(...validateInstance(schemaId(schema), value, registry, `${basePath}/expected-${name}.json#/${index}`));
  }
  return diagnostics;
}
function expectedSchemas(scenario, registry) {
  return scenario.expected ? expectedBundleSchemas(scenario.expected, scenario.directory, registry) : [];
}
function eventSchemas(scenario, registry) {
  const diagnostics = []; const validEvents = [];
  for (const { line, value: event } of scenario.events) {
    const path = `${scenario.directory}/events.ndjson:${line}`;
    const eventDiagnostics = [];
    if (event === null || typeof event !== 'object' || Array.isArray(event)) eventDiagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', path, '', 'event must be a non-null object'));
    else if (event.schemaVersion !== 1) eventDiagnostics.push(diagnostic('PHASE0_SCHEMA_UNSUPPORTED', path, '/schemaVersion', 'event schema version is unsupported'));
    else {
      eventDiagnostics.push(...validateInstance(schemaId('event-envelope'), event, registry, path));
      const payload = PAYLOAD_REF_BY_EVENT_TYPE.get(event.eventType);
      if (!payload) eventDiagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', path, '/eventType', 'event type has no payload mapping'));
      else eventDiagnostics.push(...validateInstance(`${schemaId('event-payloads')}#/$defs/${payload}`, event.payload, registry, path));
    }
    diagnostics.push(...eventDiagnostics);
    if (eventDiagnostics.length === 0) validEvents.push({ line, value: event });
  }
  return { diagnostics, validEvents };
}
function expectedEventCopies(scenario) {
  if (!isExpectedBundle(scenario.expected)) return [];
  const diagnostics = []; const findings = new Map(scenario.expected.findings.map((value) => [value.findingId, value])); const decisions = new Map(scenario.expected.decisions.map((value) => [value.decisionId, value])); const validity = new Map(scenario.expected.validity.map((value) => [value.validityId, value]));
  for (const { value: event } of scenario.events) {
    if (event.eventType === 'finding.created') { const expected = findings.get(event.payload.finding.findingId); if (!expected || canonicalDigest(expected) !== canonicalDigest(event.payload.finding)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/events/${event.eventId}/payload/finding`, 'finding event differs from expected record')); }
    if (event.eventType === 'decision.created') { const expected = decisions.get(event.payload.decision.decisionId); const initial = expected && { ...expected, deliveries: [] }; if (!initial || canonicalDigest(initial) !== canonicalDigest(event.payload.decision)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/events/${event.eventId}/payload/decision`, 'decision event differs from expected initial record')); }
    if (event.eventType === 'validity.changed') { const expected = validity.get(event.payload.record.validityId); if (!expected || canonicalDigest(expected) !== canonicalDigest(event.payload.record) || canonicalDigest(event.payload.transition) !== canonicalDigest(expected.lastTransition)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/events/${event.eventId}/payload/record`, 'validity event differs from expected record')); }
  }
  const final = new Map(); for (const { value: event } of scenario.events.filter(({ value }) => value.eventType === 'decision.delivery.changed')) { const deliveries = final.get(event.payload.decisionId) ?? new Map(); deliveries.set(event.payload.delivery.deliveryId, event.payload.delivery); final.set(event.payload.decisionId, deliveries); }
  for (const decision of scenario.expected.decisions) { const actual = [...(final.get(decision.decisionId)?.values() ?? [])].sort((a, b) => a.deliveryId.localeCompare(b.deliveryId)); if (canonicalDigest(actual) !== canonicalDigest(decision.deliveries)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/decisions/${decision.decisionId}/deliveries`, 'folded delivery state differs from expected decision')); }
  return diagnostics;
}
function variants(scenario, registry) {
  const diagnostics = []; const canonical = canonicalEventSet(scenario.events.map(({ value }) => value)); diagnostics.push(...canonical.diagnostics);
  for (const variant of scenario.variants) { diagnostics.push(...expectedBundleSchemas(variant.expected, `${scenario.directory}/${variant.name}`, registry)); diagnostics.push(...expectedBundleSecrets(variant.expected, `${scenario.directory}/${variant.name}`)); if (variant.equivalentTo !== 'canonical') { diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/variants/${variant.name}/equivalentTo`, 'only canonical equivalence target is defined')); continue; } const candidate = canonicalEventSet(variant.events.map(({ value }) => value)); diagnostics.push(...candidate.diagnostics); if (candidate.canonical !== canonical.canonical) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/variants/${variant.name}/equivalentTo`, 'variant event set differs from canonical')); if (!isExpectedBundle(scenario.expected) || !isExpectedBundle(variant.expected)) continue; const bundle = canonicalize(canonicalSnapshot({ graph: scenario.expected.graph, findings: scenario.expected.findings, decisions: scenario.expected.decisions, validity: scenario.expected.validity, coverage: scenario.expected.coverage })); const variantBundle = canonicalize(canonicalSnapshot({ graph: variant.expected.graph, findings: variant.expected.findings, decisions: variant.expected.decisions, validity: variant.expected.validity, coverage: variant.expected.coverage })); if (variantBundle !== bundle) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', scenario.directory, `/variants/${variant.name}/equivalentTo`, 'variant expected snapshot differs from canonical')); }
  return diagnostics;
}
export function validateOneScenario(scenario, registry) {
  const eventSchemaResult = eventSchemas(scenario, registry); const schemaSafeScenario = eventSchemaResult.validEvents.length === scenario.events.length ? scenario : { ...scenario, events: eventSchemaResult.validEvents }; const expectedSafeScenario = isExpectedBundle(schemaSafeScenario.expected) ? schemaSafeScenario : { ...schemaSafeScenario, expected: null };
  return sortDiagnostics([...validateInstance(schemaId('scenario-manifest'), scenario.manifest, registry, `${scenario.directory}/manifest.json`), ...validateManifestSemantics(scenario.manifest, `${scenario.directory}/manifest.json`), ...machineSecrets(scenario), ...eventSchemaResult.diagnostics, ...expectedSchemas(scenario, registry), ...expectedEventCopies(expectedSafeScenario), ...validateScenarioDomain(expectedSafeScenario), ...variants(expectedSafeScenario, registry)]);
}
export async function validatePhase0Corpus(corpus) {
  const diagnostics = [...validateSchemaDocuments(corpus.registry)];
  for (const scenario of corpus.positiveScenarios) diagnostics.push(...validateOneScenario(scenario, corpus.registry));
  for (const fixture of corpus.negativeFixtures) { const actual = validateOneScenario(fixture, corpus.registry); const manifestPath = `${fixture.directory}/manifest.json`; const manifestDiagnostic = actual.find(({ path, pointer }) => path === manifestPath && ['/expected', '/expectedError'].includes(pointer)); const expectedError = fixture.manifest.expectedError ?? manifestDiagnostic?.code; if (actual.length === 0 || actual[0].code !== expectedError) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', manifestPath, '/expectedError', 'negative fixture did not produce its declared primary error')); }
  diagnostics.push(...validateInstance(schemaId('benchmark-workloads'), corpus.benchmarks, corpus.registry, 'benchmarks/phase0/workloads.json'), ...findSecretDiagnostics(corpus.benchmarks, 'benchmarks/phase0/workloads.json'), ...validateBenchmarkDefinitions(corpus.benchmarks));
  return sortDiagnostics(diagnostics);
}
export function parseArgs(args) { if (!args.length) return { root: process.cwd() }; if (args.length === 2 && args[0] === '--root') return { root: args[1] }; throw new Error('usage: node tools/phase0/validate.mjs [--root <path>]'); }
export async function validateRepository(root) { return validatePhase0Corpus(await loadPhase0Corpus(root)); }
export async function main(args = process.argv.slice(2)) { try { const { root } = parseArgs(args); const diagnostics = await validateRepository(root); if (diagnostics.length) { process.stderr.write(`${formatDiagnostics(diagnostics)}\n`); return EXIT_CONTRACT_INVALID; } process.stdout.write('Phase 0 corpus valid\n'); return EXIT_OK; } catch (error) { if (error instanceof CorpusContractError) { process.stderr.write(`${formatDiagnostics([error.diagnostic])}\n`); return EXIT_CONTRACT_INVALID; } process.stderr.write(`PHASE0_VALIDATOR_FAILURE: ${error.message}\n`); return EXIT_TOOL_FAILURE; } }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
