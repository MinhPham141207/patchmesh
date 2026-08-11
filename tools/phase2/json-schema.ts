type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(root: unknown, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")];
  }, root);
}

function typeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateNode(schema: JsonSchema, value: unknown, root: JsonSchema, path: string, diagnostics: string[], stack: ReadonlySet<string>): void {
  if (typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#")) { diagnostics.push(`${path}: external schema reference is unsupported`); return; }
    if (stack.has(schema.$ref)) { diagnostics.push(`${path}: cyclic schema reference is unsupported`); return; }
    const resolved = pointer(root, schema.$ref);
    if (!isRecord(resolved)) { diagnostics.push(`${path}: schema reference does not resolve`); return; }
    validateNode(resolved, value, root, path, diagnostics, new Set([...stack, schema.$ref]));
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isRecord);
    if (!branches.some((branch) => { const branchDiagnostics: string[] = []; validateNode(branch, value, root, path, branchDiagnostics, stack); return branchDiagnostics.length === 0; })) diagnostics.push(`${path}: value does not match any schema branch`);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter(isRecord);
    const matches = branches.filter((branch) => { const branchDiagnostics: string[] = []; validateNode(branch, value, root, path, branchDiagnostics, stack); return branchDiagnostics.length === 0; }).length;
    if (matches !== 1) diagnostics.push(`${path}: value must match exactly one schema branch`);
    return;
  }
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) { diagnostics.push(`${path}: value has the wrong type`); return; }
  if (Object.hasOwn(schema, "const") && !sameJson(value, schema.const)) diagnostics.push(`${path}: value does not match const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) diagnostics.push(`${path}: value is outside enum`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) diagnostics.push(`${path}: string is too short`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) diagnostics.push(`${path}: string does not match pattern`);
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || Number.isNaN(Date.parse(value)))) diagnostics.push(`${path}: string is not an RFC 3339 UTC date-time`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) diagnostics.push(`${path}: number is below minimum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) diagnostics.push(`${path}: number is below exclusive minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) diagnostics.push(`${path}: number is above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) diagnostics.push(`${path}: array has too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) diagnostics.push(`${path}: array has too many items`);
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) diagnostics.push(`${path}: array items are not unique`);
    if (isRecord(schema.items)) value.forEach((item, index) => validateNode(schema.items as JsonSchema, item, root, `${path}/${index}`, diagnostics, stack));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) diagnostics.push(`${path}/${key}: required property is missing`);
    for (const [key, child] of Object.entries(value)) {
      if (isRecord(properties[key])) validateNode(properties[key] as JsonSchema, child, root, `${path}/${key}`, diagnostics, stack);
      else if (schema.additionalProperties === false) diagnostics.push(`${path}/${key}: additional property is forbidden`);
    }
  }
}

export function validateJsonSchemaInstance(schema: unknown, value: unknown): readonly string[] {
  if (!isRecord(schema)) return ["/: schema must be an object"];
  const diagnostics: string[] = [];
  validateNode(schema, value, schema, "", diagnostics, new Set());
  return diagnostics.sort((left, right) => left.localeCompare(right));
}
