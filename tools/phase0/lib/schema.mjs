import { canonicalize } from './canonical-json.mjs';
import { diagnostic, sortDiagnostics } from './diagnostics.mjs';

const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'type', 'properties', 'required',
  'additionalProperties', 'items', 'minItems', 'uniqueItems', 'enum', 'const',
  'oneOf', 'format', 'pattern', 'minimum',
]);

const pointerSegment = (value) => value.replaceAll('~', '~0').replaceAll('/', '~1');

function children(schema) {
  const result = [];
  for (const keyword of ['$defs', 'properties']) {
    if (schema[keyword] && typeof schema[keyword] === 'object') {
      for (const key of Object.keys(schema[keyword]).sort()) result.push([`${keyword}/${pointerSegment(key)}`, schema[keyword][key]]);
    }
  }
  if (schema.items && typeof schema.items === 'object') result.push(['items', schema.items]);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') result.push(['additionalProperties', schema.additionalProperties]);
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((child, index) => result.push([`oneOf/${index}`, child]));
  return result;
}

function pointer(value, fragment) {
  if (fragment === '' || fragment === '#') return value;
  if (!fragment.startsWith('#/')) return undefined;
  return fragment.slice(2).split('/').reduce((current, encoded) => {
    if (current === undefined || current === null) return undefined;
    return current[decodeURIComponent(encoded).replaceAll('~1', '/').replaceAll('~0', '~')];
  }, value);
}

function resolveRef(ref, currentId, registry) {
  const url = new URL(ref, currentId);
  const fragment = url.hash;
  url.hash = '';
  const document = registry.byId.get(url.href);
  const schema = document && pointer(document.schema, fragment);
  return schema && typeof schema === 'object' ? { id: `${url.href}${fragment}`, document, schema } : undefined;
}

export function createSchemaRegistry(documents) {
  const byId = new Map();
  for (const document of documents) if (document.schema?.$id && !byId.has(document.schema.$id)) byId.set(document.schema.$id, document);
  return { byId, documents: [...documents] };
}

export function validateSchemaDocuments(registry) {
  const diagnostics = [];
  const ids = new Map();
  function inspect(schema, document, at, currentId, stack) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, at, 'schema node must be an object'));
      return;
    }
    for (const keyword of Object.keys(schema).sort()) if (!SUPPORTED.has(keyword)) {
      diagnostics.push(diagnostic('PHASE0_SCHEMA_KEYWORD_UNSUPPORTED', document.path, `${at}/${pointerSegment(keyword)}`, 'schema keyword is outside the Phase 0 subset'));
    }
    if (typeof schema.$ref === 'string') {
      const resolved = resolveRef(schema.$ref, currentId, registry);
      if (!resolved) diagnostics.push(diagnostic('PHASE0_REFERENCE_MISSING', document.path, `${at}/$ref`, 'schema reference does not resolve'));
      else if (stack.has(resolved.id)) diagnostics.push(diagnostic('PHASE0_REFERENCE_MISSING', document.path, `${at}/$ref`, 'cyclic schema reference is unsupported'));
      else inspect(resolved.schema, resolved.document, '', resolved.document.schema.$id, new Set([...stack, resolved.id]));
    }
    for (const [suffix, child] of children(schema)) inspect(child, document, `${at}/${suffix}`, currentId, stack);
  }
  for (const document of [...registry.documents].sort((a, b) => a.path.localeCompare(b.path))) {
    const schema = document.schema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, '', 'schema document must be an object')); continue; }
    if (schema.$schema !== DIALECT) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, '/$schema', 'schema dialect must be Draft 2020-12'));
    if (typeof schema.$id !== 'string' || !/^https?:\/\//u.test(schema.$id)) { diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', document.path, '/$id', 'schema requires an absolute $id')); continue; }
    if (ids.has(schema.$id)) diagnostics.push(diagnostic('PHASE0_ID_CONFLICT', document.path, '/$id', 'schema ID is duplicated')); else ids.set(schema.$id, document.path);
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

function instance(schema, value, context, at, currentId, stack) {
  if (typeof schema.$ref === 'string') {
    const resolved = resolveRef(schema.$ref, currentId, context.registry);
    if (!resolved) return [diagnostic('PHASE0_REFERENCE_MISSING', context.path, at, 'schema reference does not resolve')];
    if (stack.has(resolved.id)) return [diagnostic('PHASE0_REFERENCE_MISSING', context.path, at, 'cyclic schema reference is unsupported')];
    return instance(resolved.schema, value, context, at, resolved.document.schema.$id, new Set([...stack, resolved.id]));
  }
  const diagnostics = [];
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => instance(branch, value, context, at, currentId, new Set(stack)).length === 0).length;
    if (matches !== 1) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'value must match exactly one schema branch'));
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, `value must have type ${schema.type}`));
    return diagnostics;
  }
  if ('const' in schema && canonicalize(value) !== canonicalize(schema.const)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'value does not match const'));
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => canonicalize(item) === canonicalize(value))) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'value is outside enum'));
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'string does not match pattern'));
  if (typeof value === 'string' && schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'string must be a lowercase UUID'));
  if (typeof value === 'string' && schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || Number.isNaN(Date.parse(value)))) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'string must be RFC 3339 UTC'));
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'number is below minimum'));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, `${at}/${pointerSegment(required)}`, 'required property is missing'));
    for (const key of Object.keys(value).sort()) {
      const child = `${at}/${pointerSegment(key)}`;
      if (Object.hasOwn(schema.properties ?? {}, key)) diagnostics.push(...instance(schema.properties[key], value[key], context, child, currentId, new Set(stack)));
      else if (schema.additionalProperties === false) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, child, 'additional property is forbidden'));
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'array has too few items'));
    if (schema.uniqueItems === true && new Set(value.map(canonicalize)).size !== value.length) diagnostics.push(diagnostic('PHASE0_SCHEMA_INVALID', context.path, at, 'array items must be unique'));
    if (schema.items) value.forEach((item, index) => diagnostics.push(...instance(schema.items, item, context, `${at}/${index}`, currentId, new Set(stack))));
  }
  return diagnostics;
}

export function validateInstance(schemaId, value, registry, path = '<memory>') {
  const split = schemaId.indexOf('#');
  const base = split < 0 ? schemaId : schemaId.slice(0, split);
  const fragment = split < 0 ? '' : schemaId.slice(split);
  const document = registry.byId.get(base);
  const schema = document && pointer(document.schema, fragment);
  if (!document || !schema) return [diagnostic('PHASE0_REFERENCE_MISSING', path, '', 'root schema does not resolve')];
  return sortDiagnostics(instance(schema, value, { path, registry }, '', document.schema.$id, new Set([schemaId])));
}
