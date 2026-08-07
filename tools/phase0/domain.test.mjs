import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalDigest, canonicalize } from './lib/canonical-json.mjs';
import { validateBenchmarkDefinitions, validateCoverageRecords, validateDecisionCapabilities, validateDecisionDeliveryEvents, validateEventSet, validateIdentityRecords, validateManifestSemantics, validateScenarioDomain, validateSequenceCoverage, validateValidityRecords, canonicalSnapshot } from './lib/domain.mjs';

const base = { schemaVersion: 1, eventId: 'evt_00000000000000000000000000000001', eventType: 'tool.requested', source: { kind: 'gateway', sourceId: 'source_gateway', instanceId: '11111111-1111-4111-8111-111111111111' }, timestamp: '2026-08-06T00:00:00.000Z', repositoryId: 'repo_11111111-1111-4111-8111-111111111111', workspaceId: 'ws_22222222-2222-4222-8222-222222222222', worktreeId: 'wt_33333333-3333-4333-8333-333333333333', agentId: 'agent_a', taskId: 'task_a', correlationId: 'corr_00000000000000000000000000000001', causationId: null, sourceSequence: 0, payload: { toolName: 'edit_file', operation: 'change', targetResourceId: null, opaque: false } };
test('identical duplicates are no-ops and conflicting duplicates fail', () => { assert.deepEqual(validateEventSet([base, structuredClone(base)]), []); const conflict = structuredClone(base); conflict.payload.operation = 'different'; assert.equal(validateEventSet([base, conflict])[0].code, 'PHASE0_ID_CONFLICT'); });
test('source sequence is scoped by producer kind, source ID, and instance ID', () => { const other = { ...structuredClone(base), eventId: 'evt_00000000000000000000000000000002', source: { ...base.source, kind: 'adapter', sourceId: 'source_adapter' }, causationId: base.eventId, sourceSequence: 0 }; assert.deepEqual(validateEventSet([base, other]), []); });
test('sequence gaps require a degraded gap with the complete producer scope', () => { const skipped = { ...structuredClone(base), eventId: 'evt_00000000000000000000000000000002', sourceSequence: 2, causationId: null, correlationId: 'corr_00000000000000000000000000000002' }; assert.equal(validateSequenceCoverage([base, skipped], [])[0].code, 'PHASE0_COVERAGE_OVERCLAIMED'); assert.deepEqual(validateSequenceCoverage([base, skipped], [{ presentation: 'degraded', gaps: [{ kind: 'missing_sequence', scope: 'source:gateway:source_gateway:11111111-1111-4111-8111-111111111111:sequence:1' }] }]), []); });
test('embedded validity is checked even when a scenario has no expected projection', () => { const record = { validityId: 'validity_00000000000000000000000000000001', taskId: 'task_a', workProductId: 'work_00000000000000000000000000000001', executionState: 'completed', validityState: 'stale', baseRevision: '1111111111111111111111111111111111111111', targetSnapshotId: `snapshot_${'1'.repeat(64)}`, observedDependencies: [], validations: [], coverageIds: [], evidenceEventIds: [base.eventId], lastTransition: { from: 'possibly_stale', to: 'stale', reason: 'dependency_impact', targetSnapshotId: `snapshot_${'1'.repeat(64)}`, evidenceEventIds: [base.eventId] } }; const event = { ...structuredClone(base), eventType: 'validity.changed', payload: { record, transition: record.lastTransition } }; assert.equal(validateScenarioDomain({ directory: 'fixtures/invalid/v1/invalid-transition', manifest: { targetPhase: 1 }, events: [{ line: 1, value: event }], expected: null })[0].code, 'PHASE0_TRANSITION_INVALID'); });
test('coverage cannot claim sufficient presentation over a relevant gap', () => { assert.equal(validateCoverageRecords([{ coverageId: 'coverage_00000000000000000000000000000001', scope: 'shell', modes: ['intercepted', 'unknown'], evidenceEventIds: [base.eventId], gaps: [{ kind: 'opaque', scope: 'effects', reason: 'opaque', evidenceEventIds: [base.eventId] }], presentation: 'sufficient' }])[0].code, 'PHASE0_COVERAGE_OVERCLAIMED'); });
test('phase capabilities reject disruptive directives and unscheduled actions', () => { assert.equal(validateDecisionCapabilities([{ coordinationAction: 'pause', gatewayDirective: 'reject' }], 2).length, 2); });
test('phase capabilities reject a decision target with both identities null', () => { const diagnostics = validateDecisionCapabilities([{ coordinationAction: 'record', gatewayDirective: 'allow', target: { agentId: null, taskId: null } }], 1); assert.equal(diagnostics[0].code, 'PHASE0_SCHEMA_INVALID'); assert.equal(diagnostics[0].pointer, '/decisions/0/target'); });

test('decision delivery target requires an agent or task without an expected projection', () => {
  const event = { ...structuredClone(base), eventType: 'decision.delivery.changed', payload: { decisionId: 'decision_00000000000000000000000000000010', delivery: { deliveryId: 'delivery_00000000000000000000000000000010', target: { agentId: null, taskId: null }, state: 'pending', eventIds: [base.eventId] } } };
  assert.deepEqual(validateDecisionDeliveryEvents([event]).map(({ code, pointer, message }) => [code, pointer, message]), [
    ['PHASE0_SCHEMA_INVALID', '/deliveries/delivery_00000000000000000000000000000010/target', 'delivery target requires agent or task'],
  ]);
});
test('validity guards require a legal transition', () => { assert.equal(validateValidityRecords([{ validityState: 'stale', executionState: 'completed', lastTransition: { from: 'possibly_stale', to: 'stale', reason: 'dependency_impact', targetSnapshotId: `snapshot_${'1'.repeat(64)}`, evidenceEventIds: [base.eventId] } }])[0].code, 'PHASE0_TRANSITION_INVALID'); });
test('identity digests and NFC paths are deterministic', () => { const repositoryId = base.repositoryId; const locator = 'src/Auth.ts'; const resource = { resourceId: `res_${canonicalDigest([repositoryId, 'file', locator])}`, repositoryId, kind: 'file', locator }; assert.deepEqual(validateIdentityRecords({ resources: [resource], targetSnapshots: [] }), []); assert.deepEqual(canonicalSnapshot({ findings: [{ findingId: 'finding_b' }, { findingId: 'finding_a' }] }).findings.map((item) => item.findingId), ['finding_a', 'finding_b']); });
test('canonicalSnapshot sorts stable-ID arrays while raw canonicalize preserves their order', () => {
  const canonical = { nodes: [{ nodeId: 'node_a', kind: 'agent' }, { nodeId: 'node_b', kind: 'resource' }] };
  const variant = { nodes: [...canonical.nodes].reverse() };
  assert.notEqual(canonicalize(canonical), canonicalize(variant));
  assert.equal(canonicalize(canonicalSnapshot(canonical)), canonicalize(canonicalSnapshot(variant)));
});
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

test('a depends_on edge must match the dependency.changed event content and share evidence', () => {
  const dependentResourceId = `res_${canonicalDigest([base.repositoryId, 'file', 'dependent.ts'])}`;
  const dependencyResourceId = `res_${canonicalDigest([base.repositoryId, 'file', 'dependency.ts'])}`;
  const dependency = { dependencyId: 'dep_00000000000000000000000000000001', dependentResourceId, dependencyResourceId, dependentVersion: { resourceId: dependentResourceId, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'1'.repeat(64)}`, evidenceEventIds: [base.eventId] }, dependencyVersion: { resourceId: dependencyResourceId, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'2'.repeat(64)}`, evidenceEventIds: [base.eventId] }, observations: [{ kind: 'declared', producer: { sourceId: 'source_analyzer', version: '1' }, rule: null, evidenceEventIds: [base.eventId] }], evidenceEventIds: [base.eventId] };
  const depEvent = { ...structuredClone(base), eventType: 'dependency.changed', payload: { dependency } };
  const changedDependency = { ...structuredClone(dependency), observations: [{ kind: 'statically_observed', producer: { sourceId: 'source_analyzer', version: '1' }, rule: { ruleId: 'rule_dependency', version: '1' }, evidenceEventIds: [base.eventId] }] };
  const graph = { resources: [{ resourceId: dependency.dependentResourceId, repositoryId: base.repositoryId, kind: 'file', locator: 'dependent.ts' }, { resourceId: dependency.dependencyResourceId, repositoryId: base.repositoryId, kind: 'file', locator: 'dependency.ts' }], nodes: [{ nodeId: 'node_00000000000000000000000000000001', kind: 'resource', entityId: dependency.dependencyResourceId }, { nodeId: 'node_00000000000000000000000000000002', kind: 'resource', entityId: dependency.dependentResourceId }], edges: [{ edgeId: 'edge_00000000000000000000000000000001', kind: 'depends_on', fromNodeId: 'node_00000000000000000000000000000002', toNodeId: 'node_00000000000000000000000000000001', dependency: changedDependency, evidenceEventIds: [base.eventId] }], targetSnapshots: [] };
  const diagnostics = validateScenarioDomain({ directory: 'fixtures/invalid/v1/dependency-edge-mismatch', manifest: { targetPhase: 1 }, events: [{ line: 1, value: depEvent }], expected: { graph, findings: [], decisions: [], validity: [], coverage: [] } });
  const codes = diagnostics.map((item) => item.code);
  assert.ok(codes.includes('PHASE0_ID_CONFLICT'), `expected PHASE0_ID_CONFLICT in ${JSON.stringify(codes)}`);
});

test('a depends_on edge must bind its node entities to dependency endpoints', () => {
  const dependentResourceId = `res_${canonicalDigest([base.repositoryId, 'file', 'dependent.ts'])}`;
  const dependencyResourceId = `res_${canonicalDigest([base.repositoryId, 'file', 'dependency.ts'])}`;
  const dependency = { dependencyId: 'dep_00000000000000000000000000000010', dependentResourceId, dependencyResourceId, dependentVersion: { resourceId: dependentResourceId, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'1'.repeat(64)}`, evidenceEventIds: [base.eventId] }, dependencyVersion: { resourceId: dependencyResourceId, domain: { repositoryId: base.repositoryId, workspaceId: base.workspaceId, worktreeId: base.worktreeId }, kind: 'content_hash', value: `sha256:${'2'.repeat(64)}`, evidenceEventIds: [base.eventId] }, observations: [{ kind: 'declared', producer: { sourceId: 'source_analyzer', version: '1' }, rule: null, evidenceEventIds: [base.eventId] }], evidenceEventIds: [base.eventId] };
  const depEvent = { ...structuredClone(base), eventType: 'dependency.changed', payload: { dependency } };
  const graph = { resources: [{ resourceId: dependentResourceId, repositoryId: base.repositoryId, kind: 'file', locator: 'dependent.ts' }, { resourceId: dependencyResourceId, repositoryId: base.repositoryId, kind: 'file', locator: 'dependency.ts' }], nodes: [{ nodeId: 'node_00000000000000000000000000000010', kind: 'resource', entityId: dependencyResourceId }, { nodeId: 'node_00000000000000000000000000000011', kind: 'resource', entityId: dependentResourceId }], edges: [{ edgeId: 'edge_00000000000000000000000000000010', kind: 'depends_on', fromNodeId: 'node_00000000000000000000000000000010', toNodeId: 'node_00000000000000000000000000000011', dependency, evidenceEventIds: [depEvent.eventId] }], targetSnapshots: [] };
  const diagnostics = validateScenarioDomain({ directory: 'fixtures/invalid/v1/dependency-endpoint-mismatch', manifest: { targetPhase: 1 }, events: [{ line: 1, value: depEvent }], expected: { graph, findings: [], decisions: [], validity: [], coverage: [] } });
  assert.deepEqual(diagnostics.map(({ code, pointer, message }) => [code, pointer, message]), [
    ['PHASE0_ID_CONFLICT', '/graph/edges/edge_00000000000000000000000000000010/dependency', 'depends_on edge endpoints must match dependency resource identities'],
  ]);
});

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
  assert.deepEqual(diagnostics.map(({ pointer, message }) => [pointer, message]), [
    ['/validity/0/lastTransition', 'transition target must equal the current record target'],
  ]);
});

test('a deterministic proof cannot make an obsolete target current', () => {
  const record = { validityId: 'validity_00000000000000000000000000000003', taskId: 'task_a', workProductId: workProduct, executionState: 'completed', validityState: 'valid', baseRevision: '1'.repeat(40), targetSnapshotId: snapshot, observedDependencies: [], validations: [], coverageIds: [], evidenceEventIds: [base.eventId], lastTransition: { from: 'revalidating', to: 'valid', reason: 'deterministic_proof', targetSnapshotId: snapshot, evidenceEventIds: [base.eventId] } };
  const diagnostics = validateValidityRecords([record], eventById);
  assert.deepEqual(diagnostics.map(({ pointer, message }) => [pointer, message]), [
    ['/validity/0/lastTransition', 'deterministic proof cannot make an obsolete target current'],
  ]);
});
