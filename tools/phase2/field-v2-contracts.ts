import { readFile, lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HostAdapterCapabilities } from "patchmesh-adapters";
import { digestHostAdapterCapabilities } from "patchmesh-adapters";
import { parseEvent, validateEventSet, type ProtocolEvent } from "patchmesh-protocol";
import { canonicalSha256, type FieldDetector, type Sha256Digest } from "./gate-definitions.js";
import { validateJsonSchemaInstance } from "./json-schema.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonRecord = Record<string, unknown>;

export interface FieldCaseIndexV2 {
  readonly schemaVersion: 2;
  readonly corpusVersion: string;
  readonly cases: readonly {
    readonly caseId: string;
    readonly detector: FieldDetector;
    readonly inputPath: string;
    readonly inputDigest: Sha256Digest;
    readonly labelPath: string;
    readonly labelDigest: Sha256Digest;
    readonly scenarioFamily: string;
    readonly holdout: true;
  }[];
}

export interface FieldInputV2 {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly source: "real_production_adapter";
  readonly repositoryDomain: string;
  readonly adapter: HostAdapterCapabilities;
  readonly adapterCapabilityDigest: Sha256Digest;
  readonly integrationTargetSnapshotId: string;
  readonly detector: FieldDetector;
  readonly target: { readonly resourceId: string; readonly affectedTaskId: string | null };
  readonly protocolEvents: readonly ProtocolEvent[];
  readonly protocolEventSetDigest: Sha256Digest;
  readonly limitations: readonly string[];
}

export interface FieldLabelV2 {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly expectedFinding: boolean;
  readonly reviewerId: string;
  readonly reviewedAt: string;
  readonly rationale: string;
  readonly labelPolicyVersion: string;
  readonly collectorId: string;
}

export interface GeneratedFieldOutputV2 {
  readonly schemaVersion: 2;
  readonly caseId: string;
  readonly detector: FieldDetector;
  readonly detectorVersion: string;
  readonly codeCommit: string;
  readonly inputDigest: Sha256Digest;
  readonly observedFinding: boolean;
  readonly predictedProbability: number;
  readonly matchingFindingIds: readonly string[];
  readonly allFindingDigest: Sha256Digest;
  readonly diagnostics: readonly string[];
}

export interface LoadedFieldCaseV2 {
  readonly index: FieldCaseIndexV2["cases"][number];
  readonly input: FieldInputV2;
  readonly label: FieldLabelV2;
}

const detectors = new Set<FieldDetector>(["same_symbol_overlap", "stale_read_before_write", "exported_contract_invalidation"]);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const caseIdPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const repositoryDomainPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const capabilityKeys = [
  "schemaVersion", "runtime", "runtimeVersion", "adapterVersion", "wrapsToolExecution", "authoritativeIdentity",
  "taskLifecycle", "exactReportedEffects", "integrationTargetSnapshot", "concurrentWorktreeObservation",
  "observedReadVersion", "dependentWriteToken",
] as const;

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(record).length !== expected.size || Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains missing or unknown properties`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !digestPattern.test(value)) throw new Error(`${label} must be a canonical SHA-256 digest`);
  return value as Sha256Digest;
}

function detector(value: unknown, label: string): FieldDetector {
  if (typeof value !== "string" || !detectors.has(value as FieldDetector)) throw new Error(`${label} is not a supported detector`);
  return value as FieldDetector;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return [...value] as string[];
}

function parseCapabilities(value: unknown): HostAdapterCapabilities {
  const record = asRecord(value, "field input adapter");
  exactKeys(record, capabilityKeys, "field input adapter");
  if (record.schemaVersion !== 1) throw new Error("field input adapter schemaVersion must be 1");
  for (const key of ["runtime", "runtimeVersion", "adapterVersion"] as const) nonEmptyString(record[key], `field input adapter ${key}`);
  for (const key of capabilityKeys.slice(4)) if (typeof record[key] !== "boolean") throw new Error(`field input adapter ${key} must be boolean`);
  return value as HostAdapterCapabilities;
}

export function parseFieldCaseIndexV2(value: unknown): FieldCaseIndexV2 {
  const record = asRecord(value, "field case index v2");
  exactKeys(record, ["schemaVersion", "corpusVersion", "cases"], "field case index v2");
  if (record.schemaVersion !== 2) throw new Error("field case index schemaVersion must be 2");
  const corpusVersion = nonEmptyString(record.corpusVersion, "field case index corpusVersion");
  if (!Array.isArray(record.cases)) throw new Error("field case index cases must be an array");
  const cases = record.cases.map((value, index) => {
    const entry = asRecord(value, `field case index case ${index}`);
    exactKeys(entry, ["caseId", "detector", "inputPath", "inputDigest", "labelPath", "labelDigest", "scenarioFamily", "holdout"], `field case index case ${index}`);
    if (entry.holdout !== true) throw new Error(`field case index case ${index} holdout must be true`);
    return {
      caseId: nonEmptyString(entry.caseId, `field case index case ${index} caseId`),
      detector: detector(entry.detector, `field case index case ${index} detector`),
      inputPath: nonEmptyString(entry.inputPath, `field case index case ${index} inputPath`),
      inputDigest: digest(entry.inputDigest, `field case index case ${index} inputDigest`),
      labelPath: nonEmptyString(entry.labelPath, `field case index case ${index} labelPath`),
      labelDigest: digest(entry.labelDigest, `field case index case ${index} labelDigest`),
      scenarioFamily: nonEmptyString(entry.scenarioFamily, `field case index case ${index} scenarioFamily`),
      holdout: true as const,
    };
  });
  return { schemaVersion: 2, corpusVersion, cases };
}

export function parseFieldInputV2(value: unknown): FieldInputV2 {
  const record = asRecord(value, "field input v2");
  exactKeys(record, ["schemaVersion", "caseId", "source", "repositoryDomain", "adapter", "adapterCapabilityDigest", "integrationTargetSnapshotId", "detector", "target", "protocolEvents", "protocolEventSetDigest", "limitations"], "field input v2");
  if (record.schemaVersion !== 2 || record.source !== "real_production_adapter") throw new Error("field input has an unsupported schema or source");
  const target = asRecord(record.target, "field input target");
  exactKeys(target, ["resourceId", "affectedTaskId"], "field input target");
  if (target.affectedTaskId !== null && typeof target.affectedTaskId !== "string") throw new Error("field input affectedTaskId must be a string or null");
  if (!Array.isArray(record.protocolEvents)) throw new Error("field input protocolEvents must be an array");
  const events = record.protocolEvents.map((event, index) => {
    const parsed = parseEvent(event);
    if (parsed.value === null) throw new Error(`field input protocol event ${index} is invalid`);
    return parsed.value;
  });
  return {
    schemaVersion: 2,
    caseId: nonEmptyString(record.caseId, "field input caseId"),
    source: "real_production_adapter",
    repositoryDomain: nonEmptyString(record.repositoryDomain, "field input repositoryDomain"),
    adapter: parseCapabilities(record.adapter),
    adapterCapabilityDigest: digest(record.adapterCapabilityDigest, "field input adapterCapabilityDigest"),
    integrationTargetSnapshotId: nonEmptyString(record.integrationTargetSnapshotId, "field input integrationTargetSnapshotId"),
    detector: detector(record.detector, "field input detector"),
    target: { resourceId: nonEmptyString(target.resourceId, "field input target resourceId"), affectedTaskId: target.affectedTaskId as string | null },
    protocolEvents: events,
    protocolEventSetDigest: digest(record.protocolEventSetDigest, "field input protocolEventSetDigest"),
    limitations: stringArray(record.limitations, "field input limitations"),
  };
}

export function parseFieldLabelV2(value: unknown): FieldLabelV2 {
  const record = asRecord(value, "field label v2");
  exactKeys(record, ["schemaVersion", "caseId", "expectedFinding", "reviewerId", "reviewedAt", "rationale", "labelPolicyVersion", "collectorId"], "field label v2");
  if (record.schemaVersion !== 2 || typeof record.expectedFinding !== "boolean") throw new Error("field label has an unsupported schema or expectedFinding");
  return {
    schemaVersion: 2,
    caseId: nonEmptyString(record.caseId, "field label caseId"),
    expectedFinding: record.expectedFinding,
    reviewerId: nonEmptyString(record.reviewerId, "field label reviewerId"),
    reviewedAt: nonEmptyString(record.reviewedAt, "field label reviewedAt"),
    rationale: nonEmptyString(record.rationale, "field label rationale"),
    labelPolicyVersion: nonEmptyString(record.labelPolicyVersion, "field label labelPolicyVersion"),
    collectorId: nonEmptyString(record.collectorId, "field label collectorId"),
  };
}

export function parseGeneratedFieldOutputV2(value: unknown): GeneratedFieldOutputV2 {
  const record = asRecord(value, "generated field output v2");
  exactKeys(record, ["schemaVersion", "caseId", "detector", "detectorVersion", "codeCommit", "inputDigest", "observedFinding", "predictedProbability", "matchingFindingIds", "allFindingDigest", "diagnostics"], "generated field output v2");
  if (record.schemaVersion !== 2 || typeof record.observedFinding !== "boolean") throw new Error("generated field output has an unsupported schema or observedFinding");
  if (typeof record.predictedProbability !== "number" || !Number.isFinite(record.predictedProbability)) throw new Error("generated field output predictedProbability must be finite");
  return {
    schemaVersion: 2,
    caseId: nonEmptyString(record.caseId, "generated field output caseId"),
    detector: detector(record.detector, "generated field output detector"),
    detectorVersion: nonEmptyString(record.detectorVersion, "generated field output detectorVersion"),
    codeCommit: nonEmptyString(record.codeCommit, "generated field output codeCommit"),
    inputDigest: digest(record.inputDigest, "generated field output inputDigest"),
    observedFinding: record.observedFinding,
    predictedProbability: record.predictedProbability,
    matchingFindingIds: stringArray(record.matchingFindingIds, "generated field output matchingFindingIds"),
    allFindingDigest: digest(record.allFindingDigest, "generated field output allFindingDigest"),
    diagnostics: stringArray(record.diagnostics, "generated field output diagnostics"),
  };
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function safeArtifactPath(value: string, approvedRoot: string, suffix: string): boolean {
  if (isAbsolute(value) || value !== value.normalize("NFC") || value.includes("\\") || value.startsWith("./")) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
  return value.startsWith(`${approvedRoot}/`) && value.endsWith(suffix);
}

export function validateFieldCaseIndexV2(value: FieldCaseIndexV2): readonly string[] {
  const diagnostics: string[] = [];
  if (value.corpusVersion.trim().length === 0) diagnostics.push("field case index corpusVersion is required");
  const caseIds = value.cases.map((entry) => entry.caseId);
  const inputPaths = value.cases.map((entry) => entry.inputPath);
  const labelPaths = value.cases.map((entry) => entry.labelPath);
  if (duplicates(caseIds)) diagnostics.push("field case index case IDs must be unique");
  if (duplicates(inputPaths)) diagnostics.push("field case index input paths must be unique");
  if (duplicates(labelPaths)) diagnostics.push("field case index label paths must be unique");
  for (const entry of value.cases) {
    if (!caseIdPattern.test(entry.caseId)) diagnostics.push(`${entry.caseId}: invalid case ID`);
    if (!safeArtifactPath(entry.inputPath, ".evidence/corpus/field-v2/inputs", `/${entry.caseId}.json`)) diagnostics.push(`${entry.caseId}: input path is not canonical or confined`);
    if (!safeArtifactPath(entry.labelPath, ".evidence/corpus/field-v2/labels", `/${entry.caseId}.json`)) diagnostics.push(`${entry.caseId}: label path is not canonical or confined`);
  }
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

export function validateFieldInputV2(value: FieldInputV2): readonly string[] {
  const diagnostics: string[] = [];
  if (!caseIdPattern.test(value.caseId)) diagnostics.push(`${value.caseId}: invalid case ID`);
  if (!repositoryDomainPattern.test(value.repositoryDomain) || value.repositoryDomain.startsWith("repo_") || value.repositoryDomain.includes(":") || value.repositoryDomain.includes("/") || value.repositoryDomain.includes("\\")) diagnostics.push(`${value.caseId}: repositoryDomain must be a non-reversible corpus alias`);
  if (digestHostAdapterCapabilities(value.adapter) !== value.adapterCapabilityDigest) diagnostics.push(`${value.caseId}: adapter capability digest does not match adapter`);
  if (canonicalSha256(value.protocolEvents as unknown as Json) !== value.protocolEventSetDigest) diagnostics.push(`${value.caseId}: protocol event-set digest does not match events`);
  if (value.protocolEvents.length === 0) diagnostics.push(`${value.caseId}: protocolEvents must not be empty`);
  const eventDiagnostics = validateEventSet(value.protocolEvents);
  if (eventDiagnostics.length > 0) diagnostics.push(`${value.caseId}: protocol event set is invalid`);
  if (value.protocolEvents.some((event) => event.repositoryId === value.repositoryDomain)) diagnostics.push(`${value.caseId}: repositoryDomain must not expose a raw repository ID`);
  if (duplicates(value.limitations)) diagnostics.push(`${value.caseId}: limitations must be unique`);
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

export function validateFieldLabelV2(value: FieldLabelV2): readonly string[] {
  const diagnostics: string[] = [];
  if (!caseIdPattern.test(value.caseId)) diagnostics.push(`${value.caseId}: invalid case ID`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value.reviewedAt) || Number.isNaN(Date.parse(value.reviewedAt))) diagnostics.push(`${value.caseId}: reviewedAt must be an RFC 3339 UTC date-time`);
  if (value.reviewerId === value.collectorId) diagnostics.push(`${value.caseId}: reviewerId must differ from collectorId`);
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

export function validateGeneratedFieldOutputV2(value: GeneratedFieldOutputV2): readonly string[] {
  const diagnostics: string[] = [];
  if (!caseIdPattern.test(value.caseId)) diagnostics.push(`${value.caseId}: invalid case ID`);
  if (!/^[a-f0-9]{40,64}$/u.test(value.codeCommit)) diagnostics.push(`${value.caseId}: codeCommit must identify an exact revision`);
  if (value.predictedProbability < 0 || value.predictedProbability > 1) diagnostics.push(`${value.caseId}: predictedProbability must be between zero and one`);
  if (duplicates(value.matchingFindingIds)) diagnostics.push(`${value.caseId}: matchingFindingIds must be unique`);
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

async function confinedFile(root: string, path: string, approvedRoot: string): Promise<string> {
  if (!safeArtifactPath(path, approvedRoot, ".json")) throw new Error(`${path}: artifact path is not canonical or confined`);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  const rootRelative = relative(absoluteRoot, absolute);
  if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) throw new Error(`${path}: artifact path escapes repository`);
  let current = absoluteRoot;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`${path}: symbolic-link artifacts are not allowed`);
  }
  return absolute;
}

async function readCanonicalArtifact<T>(
  root: string,
  path: string,
  approvedRoot: string,
  schemaName: string,
  parse: (value: unknown) => T,
): Promise<readonly [T, Sha256Digest]> {
  const absolute = await confinedFile(root, path, approvedRoot);
  const value = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  const schemaPath = `.evidence/schema/${schemaName}.schema.json`;
  const schemaAbsolute = await confinedFile(root, schemaPath, ".evidence/schema");
  const schema = JSON.parse(await readFile(schemaAbsolute, "utf8")) as unknown;
  const schemaDiagnostics = validateJsonSchemaInstance(schema, value);
  if (schemaDiagnostics.length > 0) throw new Error(`${path}: JSON-schema validation failed: ${schemaDiagnostics.join("; ")}`);
  const parsed = parse(value);
  return [parsed, canonicalSha256(parsed as unknown as Json)];
}

export async function loadFieldCaseBundleV2(indexPath: string, root = process.cwd()): Promise<readonly LoadedFieldCaseV2[]> {
  if (indexPath.replaceAll("\\", "/") !== ".evidence/corpus/field-v2/corpus.json") throw new Error("field case index path must be .evidence/corpus/field-v2/corpus.json");
  const [index] = await readCanonicalArtifact(root, indexPath, ".evidence/corpus/field-v2", "field-case-index.v2", parseFieldCaseIndexV2);
  const indexDiagnostics = validateFieldCaseIndexV2(index);
  if (indexDiagnostics.length > 0) throw new Error(indexDiagnostics.join("; "));
  const loaded: LoadedFieldCaseV2[] = [];
  for (const entry of index.cases) {
    const [input, inputDigest] = await readCanonicalArtifact(root, entry.inputPath, ".evidence/corpus/field-v2/inputs", "field-input.v2", parseFieldInputV2);
    const [label, labelDigest] = await readCanonicalArtifact(root, entry.labelPath, ".evidence/corpus/field-v2/labels", "field-label.v2", parseFieldLabelV2);
    const diagnostics = [...validateFieldInputV2(input), ...validateFieldLabelV2(label)];
    if (inputDigest !== entry.inputDigest) diagnostics.push(`${entry.caseId}: input digest does not match canonical input`);
    if (labelDigest !== entry.labelDigest) diagnostics.push(`${entry.caseId}: label digest does not match canonical label`);
    if (input.caseId !== entry.caseId || label.caseId !== entry.caseId) diagnostics.push(`${entry.caseId}: case IDs do not match the index`);
    if (input.detector !== entry.detector) diagnostics.push(`${entry.caseId}: detector does not match the index`);
    if (diagnostics.length > 0) throw new Error(diagnostics.sort((left, right) => left.localeCompare(right)).join("; "));
    loaded.push({ index: entry, input, label });
  }
  return loaded;
}

export async function loadGeneratedFieldOutputV2(
  path: string,
  expected: { readonly caseId: string; readonly detector: FieldDetector; readonly inputDigest: Sha256Digest },
  root = process.cwd(),
): Promise<GeneratedFieldOutputV2> {
  const [output] = await readCanonicalArtifact(root, path, ".evidence/field-output", "generated-field-output.v2", parseGeneratedFieldOutputV2);
  const diagnostics = [...validateGeneratedFieldOutputV2(output)];
  if (output.caseId !== expected.caseId || output.detector !== expected.detector || output.inputDigest !== expected.inputDigest) diagnostics.push(`${expected.caseId}: generated output does not match its input contract`);
  if (diagnostics.length > 0) throw new Error(diagnostics.sort((left, right) => left.localeCompare(right)).join("; "));
  return output;
}
