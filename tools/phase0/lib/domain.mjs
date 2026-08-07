import { canonicalDigest, canonicalize } from './canonical-json.mjs';
import { diagnostic, sortDiagnostics } from './diagnostics.mjs';

const ACTIONS_BY_PHASE = new Map([[0, new Set()], [1, new Set(['record'])], [2, new Set(['record', 'notify', 'request_recheck', 'mark_possibly_stale', 'request_revalidation'])], [3, new Set(['record', 'notify', 'request_recheck', 'mark_possibly_stale', 'request_revalidation'])]]);
const DIRECTIVES_BY_PHASE = new Map([[0, new Set()], [1, new Set(['allow'])], [2, new Set(['allow', 'allow_with_notice'])], [3, new Set(['allow', 'allow_with_notice'])]]);
const VALIDITY_TRANSITIONS = new Map([
  ['unassessed->valid', new Set(['validation_passed'])], ['unassessed->possibly_stale', new Set(['dependency_impact'])], ['valid->possibly_stale', new Set(['dependency_impact'])],
  ['possibly_stale->revalidating', new Set(['validation_started'])], ['revalidating->valid', new Set(['validation_passed'])], ['revalidating->stale', new Set(['validation_failed', 'deterministic_proof'])], ['revalidating->possibly_stale', new Set(['validation_inconclusive', 'validation_interrupted', 'target_superseded'])],
]);
const issue = (code, pointer, message, path = '<domain>') => diagnostic(code, path, pointer, message);
const producerKey = (event) => `${event.source.kind}:${event.source.sourceId}:${event.source.instanceId}`;

function uniqueEvents(events) {
  const byId = new Map(); const diagnostics = [];
  for (const event of events) {
    const digest = canonicalDigest(event); const previous = byId.get(event.eventId);
    if (!previous) byId.set(event.eventId, { event, digest });
    else if (previous.digest !== digest) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}`, 'event ID has conflicting canonical content'));
  }
  return { diagnostics, events: [...byId.values()].map(({ event }) => event) };
}
function visit(value, pointer, callback) {
  if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${pointer}/${index}`, callback));
  if (!value || typeof value !== 'object') return;
  callback(value, pointer);
  for (const key of Object.keys(value).sort()) visit(value[key], `${pointer}/${key}`, callback);
}
function versionValueIsValid(version) {
  if (version.kind === 'deleted') return version.value === null;
  if (typeof version.value !== 'string') return false;
  if (version.kind === 'git_commit' || version.kind === 'git_blob') return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(version.value);
  if (version.kind === 'content_hash' || version.kind === 'symbol_signature') return /^sha256:[0-9a-f]{64}$/u.test(version.value);
  return (version.kind === 'schema_version' || version.kind === 'api_version') && /^\S(?:.*\S)?$/u.test(version.value);
}
function eventRefs(value, pointer, eventById, diagnostics) {
  const singular = new Set(['requestEventId', 'resultEventId', 'targetEventId']);
  const plural = new Set(['evidenceEventIds', 'effectEventIds', 'eventIds']);
  visit(value, pointer, (record, at) => {
    for (const key of singular) if (typeof record[key] === 'string' && !eventById.has(record[key])) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `${at}/${key}`, 'referenced event is absent'));
    for (const key of plural) for (const [index, id] of (record[key] ?? []).entries()) if (!eventById.has(id)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `${at}/${key}/${index}`, 'referenced event is absent'));
  });
}
function versionEvidence(value, pointer, eventById, diagnostics) {
  visit(value, pointer, (record, at) => {
    if (!record.domain || !record.resourceId || !Object.hasOwn(record, 'value')) return;
    if (!versionValueIsValid(record)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/value`, 'resource-version value does not match declared kind'));
    for (const id of record.evidenceEventIds ?? []) {
      const event = eventById.get(id); if (!event) continue;
      if (event.repositoryId !== record.domain.repositoryId || event.workspaceId !== record.domain.workspaceId || event.worktreeId !== record.domain.worktreeId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/domain`, 'resource-version domain differs from evidence event'));
    }
  });
}

export function validateSequenceCoverage(events, coverageRecords) {
  const diagnostics = []; const byProducer = new Map();
  for (const event of events) if (event.sourceSequence !== null) {
    const values = byProducer.get(producerKey(event)) ?? []; values.push(event.sourceSequence); byProducer.set(producerKey(event), values);
  }
  const gaps = coverageRecords.flatMap((coverage) => (coverage.gaps ?? []).map((gap) => ({ ...gap, presentation: coverage.presentation })));
  for (const [key, values] of byProducer) {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    for (let value = 0; value <= sorted.at(-1); value += 1) if (!sorted.includes(value)) {
      const scope = `source:${key}:sequence:${value}`;
      if (!gaps.some((gap) => gap.kind === 'missing_sequence' && gap.scope === scope && ['degraded', 'unknown'].includes(gap.presentation))) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${scope}`, 'source-sequence gap lacks degraded coverage evidence'));
    }
  }
  return sortDiagnostics(diagnostics);
}

export function validateEventSet(inputEvents) {
  const { diagnostics, events } = uniqueEvents(inputEvents); const byId = new Map(events.map((event) => [event.eventId, event])); const sequences = new Map(); const roots = new Map();
  for (const event of events) {
    if (event.causationId === event.eventId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'event cannot cause itself'));
    else if (event.causationId !== null) {
      const parent = byId.get(event.causationId);
      if (!parent) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/causationId`, 'causal parent is absent'));
      else {
        if (parent.correlationId !== event.correlationId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/correlationId`, 'child must inherit parent correlation ID'));
        if (producerKey(parent) === producerKey(event) && parent.sourceSequence !== null && event.sourceSequence !== null && event.sourceSequence <= parent.sourceSequence) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/sourceSequence`, 'causal child must advance its producer sequence'));
      }
    } else {
      const root = roots.get(event.correlationId); if (root && root !== event.eventId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'one correlation cannot have multiple roots')); else roots.set(event.correlationId, event.eventId);
    }
    if (event.sourceSequence !== null) {
      const key = `${producerKey(event)}:${event.sourceSequence}`; const previous = sequences.get(key);
      if (previous && previous !== event.eventId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/sourceSequence`, 'source sequence is duplicated in one producer instance')); else sequences.set(key, event.eventId);
    }
    visit(event.payload, `/events/${event.eventId}/payload`, (value, at) => {
      if (value.domain && value.resourceId && Object.hasOwn(value, 'value') && value.domain.repositoryId !== event.repositoryId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/domain`, 'resource version crosses repository domain'));
      if (value.domain && value.resourceId && Object.hasOwn(value, 'value') && !versionValueIsValid(value)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/value`, 'resource-version value does not match declared kind'));
      if (value.repositoryId && value.resourceId && value.repositoryId !== event.repositoryId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/repositoryId`, 'logical resource crosses event repository'));
    });
    if (event.eventType === 'attribution.corrected') {
      const target = byId.get(event.payload.targetEventId);
      if (!target) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/payload/targetEventId`, 'attribution target is absent'));
      else if (target.repositoryId !== event.repositoryId || target.correlationId !== event.correlationId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/targetEventId`, 'attribution target crosses repository or correlation'));
      if (event.payload.attributedAgentId === null && event.payload.attributedTaskId === null) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'attribution correction must supply an identity'));
    }
    if (['file.read', 'symbol.read'].includes(event.eventType) && event.payload.resource.resourceId !== event.payload.version.resourceId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/version/resourceId`, 'observed version names another resource'));
    if (['file.changed', 'symbol.changed'].includes(event.eventType)) for (const version of [event.payload.beforeVersion, event.payload.afterVersion]) if (version && version.resourceId !== event.payload.resource.resourceId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload`, 'changed version names another resource'));
  }
  for (const event of events) { const seen = new Set([event.eventId]); let current = event; while (current.causationId !== null) { if (seen.has(current.causationId)) { diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'causal graph contains a cycle')); break; } seen.add(current.causationId); current = byId.get(current.causationId); if (!current) break; } }
  return sortDiagnostics(diagnostics);
}

export function validateIdentityRecords({ resources = [], targetSnapshots = [] }) {
  const diagnostics = []; const folded = new Map();
  for (const resource of resources) {
    const normalized = resource.locator.normalize('NFC'); const expected = `res_${canonicalDigest([resource.repositoryId, resource.kind, normalized])}`;
    if (resource.locator !== normalized) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/resources/${resource.resourceId}/locator`, 'logical resource locator must be Unicode NFC'));
    const key = `${resource.repositoryId}:${normalized.toLowerCase()}`; if (folded.has(key) && folded.get(key) !== normalized) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/resources/${resource.resourceId}/locator`, 'case-folding path collision is forbidden')); else folded.set(key, normalized);
    if (resource.resourceId !== expected) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/resources/${resource.resourceId}`, 'logical resource digest does not match identity tuple'));
  }
  for (const snapshot of targetSnapshots) {
    const input = { integrationTargetId: snapshot.integrationTargetId, repositoryId: snapshot.repositoryId, kind: snapshot.kind, locator: snapshot.locator, baseCommit: snapshot.baseCommit, candidateIds: snapshot.candidateIds }; const digest = canonicalDigest(input);
    if (snapshot.digest !== digest || snapshot.targetSnapshotId !== `snapshot_${digest}`) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/targetSnapshots/${snapshot.targetSnapshotId}/digest`, 'target snapshot digest is invalid'));
  }
  return sortDiagnostics(diagnostics);
}
export function validateDecisionCapabilities(decisions, phase) {
  const diagnostics = []; const actions = ACTIONS_BY_PHASE.get(phase); const directives = DIRECTIVES_BY_PHASE.get(phase);
  if (!actions || !directives) return [issue('PHASE0_SCHEMA_INVALID', '/targetPhase', 'target phase is outside the Phase 0 contract range')];
  for (const [index, decision] of decisions.entries()) {
    if (!actions.has(decision.coordinationAction)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/coordinationAction`, 'action is unavailable in target phase'));
    if (!directives.has(decision.gatewayDirective)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/gatewayDirective`, 'directive is unavailable in target phase'));
    if (typeof decision.confidence === 'number' && (decision.confidence < 0 || decision.confidence > 1)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/confidence`, 'confidence must be within zero and one'));
    if (decision.target && !decision.target.agentId && !decision.target.taskId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/decisions/${index}/target`, 'decision target requires agent or task'));
  }
  return sortDiagnostics(diagnostics);
}
export function validateDecisionDeliveryEvents(inputEvents) {
  const { diagnostics, events } = uniqueEvents(inputEvents); const byDelivery = new Map(); const allowed = new Map([['pending', new Set(['pending', 'delivered', 'failed'])], ['delivered', new Set(['delivered', 'acknowledged'])], ['acknowledged', new Set(['acknowledged'])], ['failed', new Set(['failed'])]]);
  for (const event of events) { const { delivery } = event.payload; if (delivery.target.agentId === null && delivery.target.taskId === null) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/deliveries/${delivery.deliveryId}/target`, 'delivery target requires agent or task')); const previous = byDelivery.get(delivery.deliveryId); if (!previous) { if (delivery.state !== 'pending') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/deliveries/${delivery.deliveryId}`, 'delivery must begin pending')); } else { if (previous.decisionId !== event.payload.decisionId || canonicalize(previous.delivery.target) !== canonicalize(delivery.target)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/deliveries/${delivery.deliveryId}`, 'delivery identity or target changed')); if (!allowed.get(previous.delivery.state)?.has(delivery.state)) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/deliveries/${delivery.deliveryId}/state`, 'delivery transition is invalid')); if (canonicalize([...previous.delivery.eventIds, event.eventId]) !== canonicalize(delivery.eventIds)) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/deliveries/${delivery.deliveryId}/eventIds`, 'delivery history must append exactly the current event')); } if (delivery.eventIds.at(-1) !== event.eventId) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/deliveries/${delivery.deliveryId}/eventIds`, 'delivery history must end with current event')); byDelivery.set(delivery.deliveryId, { decisionId: event.payload.decisionId, delivery }); }
  return sortDiagnostics(diagnostics);
}
export function validateValidityRecords(records, eventById = new Map()) {
  const diagnostics = []; const outcome = new Map([['validation_started', 'started'], ['validation_passed', 'passed'], ['validation_failed', 'failed'], ['validation_inconclusive', 'inconclusive'], ['validation_interrupted', 'interrupted']]);
  for (const [index, record] of records.entries()) {
    const transition = record.lastTransition;
    if (transition === null) {
      if (record.validityState !== 'unassessed') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'only unassessed may omit an initial transition'));
      continue;
    }
    const reasons = VALIDITY_TRANSITIONS.get(`${transition.from}->${transition.to}`);
    const targetMismatch = transition.reason !== 'target_superseded' && transition.targetSnapshotId !== record.targetSnapshotId;
    const deterministicProofResurrection = transition.reason === 'deterministic_proof' && transition.to === 'valid' && record.validityState === transition.to;
    if ((!reasons?.has(transition.reason) || record.validityState !== transition.to) && !deterministicProofResurrection) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'validity transition or guard is invalid'));
    if (record.validityState !== 'unassessed' && record.executionState !== 'completed') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/executionState`, 'assessed validity requires a completed work product'));
    if (targetMismatch) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'transition target must equal the current record target'));
    if (transition.reason === 'dependency_impact' && !(transition.evidenceEventIds ?? []).some((id) => eventById.get(id)?.eventType === 'dependency.changed')) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'dependency impact evidence must include a dependency.changed event'));
    if (transition.reason === 'deterministic_proof' && transition.to === 'valid') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/lastTransition`, 'deterministic proof cannot make an obsolete target current'));
    const expected = outcome.get(transition.reason);
    if (expected) {
      if (!targetMismatch) {
        const match = record.validations.find((candidate) => candidate.outcome === expected && candidate.targetSnapshotId === record.targetSnapshotId && transition.evidenceEventIds.includes(candidate.resultEventId));
        if (!match) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/validations`, 'transition lacks a matching current-target validation result'));
      }
    } else if (transition.reason === 'dependency_impact') {
      if (record.validityState !== 'possibly_stale') diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}`, 'dependency impact must produce possibly_stale'));
    } else if (transition.reason === 'target_superseded') {
      if (!record.validations.some((candidate) => candidate.targetSnapshotId !== record.targetSnapshotId && transition.evidenceEventIds.includes(candidate.resultEventId))) diagnostics.push(issue('PHASE0_TRANSITION_INVALID', `/validity/${index}/validations`, 'superseded transition requires an obsolete-target result'));
    }
  }
  return sortDiagnostics(diagnostics);
}
export function validateCoverageRecords(records) {
  const diagnostics = []; for (const [index, record] of records.entries()) { const direct = record.modes.includes('intercepted') || record.modes.includes('verified'); if (record.presentation === 'sufficient' && (record.gaps.length || record.modes.includes('unknown') || !direct)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${index}/presentation`, 'relevant gap cannot present sufficient coverage')); if (record.presentation === 'degraded' && !record.gaps.length && !record.modes.includes('unknown')) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${index}/presentation`, 'degraded coverage requires an explicit gap or unknown mode')); if (record.presentation === 'unknown' && direct) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/coverage/${index}/presentation`, 'direct evidence cannot present wholly unknown coverage')); }
  return sortDiagnostics(diagnostics);
}
function stableIndex(items, idKey, at, diagnostics) { const result = new Map(); for (const [index, item] of items.entries()) { if (result.has(item[idKey])) diagnostics.push(issue('PHASE0_ID_CONFLICT', `${at}/${index}/${idKey}`, `${idKey} must be unique`)); else result.set(item[idKey], item); } return result; }
const ARRAY_ID_KEYS = new Map([['resources', 'resourceId'], ['nodes', 'nodeId'], ['edges', 'edgeId'], ['targetSnapshots', 'targetSnapshotId'], ['findings', 'findingId'], ['decisions', 'decisionId'], ['deliveries', 'deliveryId'], ['validity', 'validityId'], ['coverage', 'coverageId']]);
export function canonicalSnapshot(value, parentKey = '') { if (Array.isArray(value)) { const result = value.map((item) => canonicalSnapshot(item)); const idKey = ARRAY_ID_KEYS.get(parentKey); return idKey ? result.sort((a, b) => a[idKey].localeCompare(b[idKey])) : result; } if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSnapshot(value[key], key)])); return value; }
export function canonicalEventSet(events) { const diagnostics = validateEventSet(events); if (diagnostics.length) return { diagnostics, canonical: null }; const byId = new Map(); for (const event of events) if (!byId.has(event.eventId)) byId.set(event.eventId, event); return { diagnostics: [], canonical: canonicalize([...byId.values()].sort((a, b) => a.eventId.localeCompare(b.eventId))) }; }

function validateDependency(dependency, at, resources, eventById, diagnostics) {
  if (dependency.dependentVersion.resourceId !== dependency.dependentResourceId || dependency.dependencyVersion.resourceId !== dependency.dependencyResourceId) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', at, 'dependency endpoint versions must name their logical endpoints'));
  for (const key of ['dependentResourceId', 'dependencyResourceId']) if (!resources.has(dependency[key])) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `${at}/${key}`, 'dependency endpoint resource is absent'));
  for (const [index, observation] of dependency.observations.entries()) if (observation.kind !== 'declared' && observation.rule === null) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/observations/${index}/rule`, 'observed or inferred provenance requires a versioned rule'));
  eventRefs(dependency, at, eventById, diagnostics); versionEvidence(dependency, at, eventById, diagnostics);
}
function intersects(a, b) { const set = new Set(a); return b.some((item) => set.has(item)); }

export function validateManifestSemantics(manifest, manifestPath) {
  const diagnostics = [];
  if (manifest.kind === 'positive' && manifest.expected === null) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/expected', 'positive manifest must declare expected projections', manifestPath));
  if (manifest.kind === 'negative' && manifest.expectedError === null) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/expectedError', 'negative manifest must declare a primary error code', manifestPath));
  return sortDiagnostics(diagnostics);
}

export function validateScenarioDomain(scenario) {
  const events = scenario.events.map(({ value }) => value); const diagnostics = [...validateEventSet(events)]; const eventSet = uniqueEvents(events).events; const eventById = new Map(eventSet.map((event) => [event.eventId, event]));
  const repositories = new Set(eventSet.map((event) => event.repositoryId)); if (repositories.size > 1) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/events', 'one scenario cannot cross repository identities'));
  const workspaces = new Map(); const worktrees = new Map();
  for (const event of eventSet) { const association = `${event.repositoryId}:${event.worktreeId}`; if (workspaces.has(event.workspaceId) && workspaces.get(event.workspaceId) !== association) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/workspaceId`, 'workspace identity changed repository or worktree')); else workspaces.set(event.workspaceId, association); if (worktrees.has(event.worktreeId) && worktrees.get(event.worktreeId) !== event.repositoryId) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/worktreeId`, 'worktree identity changed repository')); else worktrees.set(event.worktreeId, event.repositoryId); eventRefs(event.payload, `/events/${event.eventId}/payload`, eventById, diagnostics); versionEvidence(event.payload, `/events/${event.eventId}/payload`, eventById, diagnostics); }
  for (const event of eventSet) if (event.eventType === 'tool.completed') { const request = eventById.get(event.payload.requestEventId); if (request && (request.eventType !== 'tool.requested' || request.correlationId !== event.correlationId || request.repositoryId !== event.repositoryId || request.workspaceId !== event.workspaceId || request.worktreeId !== event.worktreeId)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/requestEventId`, 'tool completion does not match its request domain')); for (const id of event.payload.effectEventIds) { const effect = eventById.get(id); if (effect && (effect.correlationId !== event.correlationId || effect.repositoryId !== event.repositoryId || effect.workspaceId !== event.workspaceId || effect.worktreeId !== event.worktreeId)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/payload/effectEventIds`, 'tool effect crosses request correlation or domain')); } if (event.causationId !== event.payload.requestEventId && !event.payload.effectEventIds.includes(event.causationId)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/events/${event.eventId}/causationId`, 'tool completion must be caused by its request or declared effect')); }
  const graph = scenario.expected?.graph ?? { resources: [], nodes: [], edges: [], targetSnapshots: [] }; const resources = stableIndex(graph.resources ?? [], 'resourceId', '/graph/resources', diagnostics); const resourceById = new Map(resources);
  for (const event of eventSet) visit(event.payload, '', (value) => { if (value.resourceId && value.repositoryId && value.kind && value.locator) { const previous = resourceById.get(value.resourceId); if (previous && canonicalize(previous) !== canonicalize(value)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/resources/${value.resourceId}`, 'logical resource content conflicts across artifacts')); else resourceById.set(value.resourceId, value); } });
  const targets = stableIndex(graph.targetSnapshots ?? [], 'targetSnapshotId', '/graph/targetSnapshots', diagnostics); diagnostics.push(...validateIdentityRecords({ resources: [...resourceById.values()], targetSnapshots: [...targets.values()] }));
  for (const resource of resourceById.values()) if (!repositories.has(resource.repositoryId)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/resources/${resource.resourceId}/repositoryId`, 'resource repository is outside the scenario'));
  const dependencies = new Map(); for (const event of eventSet.filter((item) => item.eventType === 'dependency.changed')) { const dependency = event.payload.dependency; if (dependencies.has(dependency.dependencyId) && canonicalize(dependencies.get(dependency.dependencyId)) !== canonicalize(dependency)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/dependencies/${dependency.dependencyId}`, 'dependency content conflicts')); else dependencies.set(dependency.dependencyId, dependency); } for (const dependency of dependencies.values()) validateDependency(dependency, `/dependencies/${dependency.dependencyId}`, resourceById, eventById, diagnostics);
  const embeddedFindings = eventSet.filter((event) => event.eventType === 'finding.created').map((event) => event.payload.finding); const embeddedDecisions = eventSet.filter((event) => event.eventType === 'decision.created').map((event) => event.payload.decision); const embeddedValidity = eventSet.filter((event) => event.eventType === 'validity.changed').map((event) => event.payload.record); const deliveryEvents = eventSet.filter((event) => event.eventType === 'decision.delivery.changed');
  diagnostics.push(...validateDecisionCapabilities(embeddedDecisions, scenario.manifest.targetPhase), ...validateValidityRecords(embeddedValidity, eventById), ...validateDecisionDeliveryEvents(deliveryEvents), ...validateSequenceCoverage(eventSet, scenario.expected?.coverage ?? []));
  const expected = scenario.expected;
  if (!expected) return sortDiagnostics(diagnostics);
  const findings = stableIndex(expected.findings, 'findingId', '/findings', diagnostics); const decisions = stableIndex(expected.decisions, 'decisionId', '/decisions', diagnostics); const validity = stableIndex(expected.validity, 'validityId', '/validity', diagnostics); const coverage = stableIndex(expected.coverage, 'coverageId', '/coverage', diagnostics); const nodes = stableIndex(graph.nodes, 'nodeId', '/graph/nodes', diagnostics); stableIndex(graph.edges, 'edgeId', '/graph/edges', diagnostics);
  diagnostics.push(...validateDecisionCapabilities(expected.decisions, scenario.manifest.targetPhase), ...validateValidityRecords(expected.validity, eventById), ...validateCoverageRecords(expected.coverage)); eventRefs(expected, '/expected', eventById, diagnostics); versionEvidence(expected, '/expected', eventById, diagnostics);
  const agentIds = new Set([...eventSet.map((event) => event.agentId).filter(Boolean), ...graph.nodes.filter((node) => node.kind === 'agent').map((node) => node.entityId)]); const taskIds = new Set([...eventSet.map((event) => event.taskId).filter(Boolean), ...graph.nodes.filter((node) => node.kind === 'task').map((node) => node.entityId)]); const workProducts = new Set(eventSet.filter((event) => event.eventType === 'task.completed').map((event) => event.payload.workProductId));
  for (const finding of expected.findings) { if (!resourceById.has(finding.subjectResourceId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/subjectResourceId`, 'finding subject resource is absent')); if (finding.affectedTaskId && !taskIds.has(finding.affectedTaskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/affectedTaskId`, 'affected task is absent')); for (const id of finding.dependencyIds) if (!dependencies.has(id)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/dependencyIds`, 'finding dependency is absent')); for (const id of finding.coverageIds) { const record = coverage.get(id); if (!record) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/findings/${finding.findingId}/coverageIds`, 'finding coverage is absent')); else if (!intersects(finding.evidenceEventIds, record.evidenceEventIds)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/findings/${finding.findingId}/coverageIds`, 'finding coverage is unrelated to finding evidence')); } }
  for (const decision of expected.decisions) { if (!findings.has(decision.findingId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/findingId`, 'source finding is absent')); if (decision.target.agentId !== null && !agentIds.has(decision.target.agentId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/target/agentId`, 'target agent is absent')); if (decision.target.taskId !== null && !taskIds.has(decision.target.taskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/target/taskId`, 'target task is absent')); for (const id of decision.coverageIds) { const record = coverage.get(id); if (!record) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/decisions/${decision.decisionId}/coverageIds`, 'decision coverage is absent')); else if (!intersects(decision.evidenceEventIds, record.evidenceEventIds)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/decisions/${decision.decisionId}/coverageIds`, 'decision coverage is unrelated to decision evidence')); } for (const delivery of decision.deliveries) if (canonicalize(delivery.target) !== canonicalize(decision.target)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/decisions/${decision.decisionId}/deliveries/${delivery.deliveryId}/target`, 'delivery target differs from decision target')); }
  for (const record of expected.validity) { if (!workProducts.has(record.workProductId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${record.validityId}/workProductId`, 'validity work product has no completion event')); if (!taskIds.has(record.taskId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${record.validityId}/taskId`, 'validity task is absent')); if (!targets.has(record.targetSnapshotId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${record.validityId}/targetSnapshotId`, 'validity target snapshot is absent')); for (const id of record.coverageIds) { const item = coverage.get(id); if (!item) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/validity/${record.validityId}/coverageIds`, 'validity coverage is absent')); else if (!intersects(record.evidenceEventIds, item.evidenceEventIds)) diagnostics.push(issue('PHASE0_COVERAGE_OVERCLAIMED', `/validity/${record.validityId}/coverageIds`, 'validity coverage is unrelated to validity evidence')); } }
  const entitySets = new Map([['agent', agentIds], ['task', taskIds], ['resource', new Set(resources.keys())], ['work_product', workProducts], ['target_snapshot', new Set(targets.keys())], ['finding', new Set(findings.keys())], ['decision', new Set(decisions.keys())]]);
  for (const node of graph.nodes) if (!entitySets.get(node.kind)?.has(node.entityId)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/nodes/${node.nodeId}/entityId`, 'graph node entity is absent'));
  const edgeKinds = new Map([['depends_on', [['resource', 'resource']]], ['observed', [['agent', 'resource'], ['task', 'resource']]], ['produced', [['task', 'work_product']]], ['affects', [['finding', 'task']]], ['derived_from', [['decision', 'finding']]], ['targets', [['decision', 'agent'], ['decision', 'task'], ['decision', 'target_snapshot']]]]);
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId); const to = nodes.get(edge.toNodeId);
    if (!from || !to) { diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}`, 'graph edge endpoint is absent')); continue; }
    const kinds = edgeKinds.get(edge.kind) ?? []; const valid = kinds.some(([a, b]) => from.kind === a && to.kind === b);
    if (!valid) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/graph/edges/${edge.edgeId}`, 'graph edge endpoint kinds are invalid'));
    if ((edge.kind === 'depends_on') !== (edge.dependency !== null)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `/graph/edges/${edge.edgeId}/dependency`, 'only dependency edges may carry dependency provenance'));
     if (edge.kind === 'depends_on' && edge.dependency) {
       const eventDependency = dependencies.get(edge.dependency.dependencyId);
       if (from.entityId !== edge.dependency.dependentResourceId || to.entityId !== edge.dependency.dependencyResourceId) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/graph/edges/${edge.edgeId}/dependency`, 'depends_on edge endpoints must match dependency resource identities'));
       if (!eventDependency) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/dependency`, 'depends_on edge references an absent dependency event'));
      else if (canonicalize(eventDependency) !== canonicalize(edge.dependency)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/graph/edges/${edge.edgeId}/dependency`, 'depends_on edge dependency differs from the dependency.changed event payload'));
      if ((edge.evidenceEventIds ?? []).length === 0) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/evidenceEventIds`, 'dependency edge must carry evidence'));
      else if (eventDependency && !intersects(edge.evidenceEventIds, eventDependency.evidenceEventIds)) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/graph/edges/${edge.edgeId}/evidenceEventIds`, 'dependency edge evidence must relate to the dependency record evidence'));
    }
    if (edge.dependency) validateDependency(edge.dependency, `/graph/edges/${edge.edgeId}/dependency`, resourceById, eventById, diagnostics);
  }
  for (const event of eventSet.filter((item) => item.eventType === 'decision.delivery.changed')) { const decision = decisions.get(event.payload.decisionId) ?? embeddedDecisions.find((item) => item.decisionId === event.payload.decisionId); if (!decision) diagnostics.push(issue('PHASE0_REFERENCE_MISSING', `/events/${event.eventId}/payload/decisionId`, 'delivery decision is absent')); else if (canonicalize(event.payload.delivery.target) !== canonicalize(decision.target)) diagnostics.push(issue('PHASE0_ID_CONFLICT', `/events/${event.eventId}/payload/delivery/target`, 'delivery event target differs from decision target')); }
  return sortDiagnostics(diagnostics);
}

export function validateBenchmarkDefinitions(benchmarks) {
  const diagnostics = []; const forbidden = new Set(['result', 'results', 'threshold', 'target', 'accepted', 'baselineValue']); visit(benchmarks, '', (value, at) => { for (const key of Object.keys(value)) if (forbidden.has(key)) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', `${at}/${key}`, 'benchmark definitions cannot contain measured results or thresholds')); });
  const workloads = benchmarks.workloads ?? []; const latency = workloads.filter((item) => item.kind === 'interception_latency'); const replay = workloads.filter((item) => item.kind === 'replay'); const detector = workloads.filter((item) => item.kind === 'detector_quality'); if (latency.length !== 3 || replay.length !== 3 || detector.length !== 3) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/workloads', 'benchmark corpus must contain three workloads of each kind')); if (JSON.stringify(replay.map((item) => item.eventCount).sort((a, b) => a - b)) !== JSON.stringify([1000, 10000, 100000])) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/workloads', 'replay sizes are incomplete')); const detectors = detector.map((item) => item.detector).sort(); if (JSON.stringify(detectors) !== JSON.stringify(['exported_contract_invalidation', 'same_symbol_overlap', 'stale_read_before_write'])) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/workloads', 'detector workloads are incomplete')); const operations = latency.map((item) => item.operation).sort(); if (JSON.stringify(operations) !== JSON.stringify(['noop_route', 'opaque_shell', 'small_file_read'].sort())) diagnostics.push(issue('PHASE0_SCHEMA_INVALID', '/workloads', 'interception operation set is incomplete')); return sortDiagnostics(diagnostics);
}
