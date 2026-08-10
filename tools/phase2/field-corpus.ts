import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

type TraceValidator = (events: readonly unknown[], manifest: unknown) => { readonly valid: boolean; readonly diagnostics: readonly { readonly code: string; readonly path: string; readonly message: string }[] };

export type FieldDetector = "same_symbol_overlap" | "stale_read_before_write" | "exported_contract_invalidation";
export type FieldCase = {
  readonly caseId: string;
  readonly caseKind: "trace_integrity" | "detector_quality";
  readonly tracePaths: readonly string[];
  readonly scenario: string;
  readonly detector: FieldDetector | null;
  readonly expectedFinding: boolean | null;
  readonly observedFinding: boolean | null;
  readonly confidence: number | null;
  readonly reviewerId: string;
  readonly reviewedAt: string;
  readonly coverage: "sufficient" | "degraded" | "unknown";
  readonly limitations: readonly string[];
  /** Digest of the validated, canonicalized trace bundle used as replay input. */
  readonly replayDigest: `sha256:${string}`;
  /** A persisted detector result, required for detector-quality cases. */
  readonly detectorOutputPath: string | null;
  readonly detectorOutputDigest: `sha256:${string}` | null;
  readonly holdout: boolean;
};

export interface FieldCorpus {
  readonly schemaVersion: 1;
  readonly corpusVersion: "field-v1";
  readonly evidenceKind: "field_review";
  readonly cases: readonly FieldCase[];
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const objectValue = value as { readonly [key: string]: Json };
    return `{${Object.keys(objectValue).sort((left, right) => left.localeCompare(right)).map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isSafeTracePath(value: string): boolean {
  return !isAbsolute(value) && value.replaceAll("\\", "/").startsWith(".evidence/trace/") && !value.split(/[\\/]/u).includes("..");
}

function isSafeOutputPath(value: string): boolean {
  return !isAbsolute(value) && value.replaceAll("\\", "/").startsWith(".evidence/field-output/") && !value.split(/[\\/]/u).includes("..");
}

export function validateFieldCorpus(corpus: FieldCorpus): readonly string[] {
  const diagnostics: string[] = [];
  if (corpus.schemaVersion !== 1) diagnostics.push("schemaVersion must be 1");
  if (corpus.corpusVersion !== "field-v1") diagnostics.push("corpusVersion must be field-v1");
  if (corpus.evidenceKind !== "field_review") diagnostics.push("evidenceKind must be field_review");
  if (!Array.isArray(corpus.cases)) diagnostics.push("cases must be an array");
  const caseIds = new Set<string>();
  for (const entry of corpus.cases) {
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(entry.caseId)) diagnostics.push(`${entry.caseId}: invalid case ID`);
    if (caseIds.has(entry.caseId)) diagnostics.push(`duplicate case ID: ${entry.caseId}`);
    caseIds.add(entry.caseId);
    if (entry.tracePaths.length === 0) diagnostics.push(`${entry.caseId}: tracePaths must not be empty`);
    if (new Set(entry.tracePaths).size !== entry.tracePaths.length) diagnostics.push(`${entry.caseId}: tracePaths must be unique`);
    for (const tracePath of entry.tracePaths) if (!isSafeTracePath(tracePath)) diagnostics.push(`${entry.caseId}: trace path must stay under .evidence/trace`);
    if (entry.scenario.length === 0 || entry.reviewerId.length === 0) diagnostics.push(`${entry.caseId}: scenario and reviewer ID are required`);
    if (!Number.isFinite(Date.parse(entry.reviewedAt))) diagnostics.push(`${entry.caseId}: reviewedAt must be an ISO date-time`);
    if (!isDigest(entry.replayDigest)) diagnostics.push(`${entry.caseId}: replay digest is invalid`);
    if (entry.caseKind === "trace_integrity") {
      if (entry.detector !== null || entry.expectedFinding !== null || entry.observedFinding !== null || entry.confidence !== null || entry.detectorOutputPath !== null || entry.detectorOutputDigest !== null) {
        diagnostics.push(`${entry.caseId}: trace-integrity cases cannot carry detector labels or output artifacts`);
      }
      continue;
    }
    if (entry.detector === null || entry.expectedFinding === null || entry.observedFinding === null || entry.confidence === null) diagnostics.push(`${entry.caseId}: detector-quality cases require labels and confidence`);
    if (!Number.isFinite(entry.confidence) || (entry.confidence !== null && (entry.confidence < 0 || entry.confidence > 1))) diagnostics.push(`${entry.caseId}: confidence must be between zero and one`);
    if (entry.coverage !== "sufficient") diagnostics.push(`${entry.caseId}: detector-quality cases require sufficient coverage`);
    if (!entry.holdout) diagnostics.push(`${entry.caseId}: detector-quality cases must be reviewed holdouts`);
    if (entry.detectorOutputPath === null || !isSafeOutputPath(entry.detectorOutputPath)) diagnostics.push(`${entry.caseId}: detector output must stay under .evidence/field-output`);
    if (entry.detectorOutputDigest === null || !isDigest(entry.detectorOutputDigest)) diagnostics.push(`${entry.caseId}: detector output digest is required`);
  }
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

function asFieldCorpus(value: unknown): FieldCorpus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("field corpus must be an object");
  const record = value as Record<string, unknown>;
  const permitted = new Set(["schemaVersion", "corpusVersion", "evidenceKind", "cases"]);
  if (Object.keys(record).some((key) => !permitted.has(key))) throw new Error("field corpus contains unknown properties");
  if (!Array.isArray(record.cases)) throw new Error("field corpus cases must be an array");
  for (const entry of record.cases) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("field corpus case must be an object");
    const required = ["caseId", "caseKind", "tracePaths", "scenario", "detector", "expectedFinding", "observedFinding", "confidence", "reviewerId", "reviewedAt", "coverage", "limitations", "replayDigest", "detectorOutputPath", "detectorOutputDigest", "holdout"];
    if (required.some((key) => !(key in entry)) || Object.keys(entry).some((key) => !required.includes(key))) throw new Error("field corpus case does not match field-corpus-v1 schema");
  }
  return value as FieldCorpus;
}

async function traceDigestFor(root: string, tracePath: string): Promise<`sha256:${string}`> {
  const absoluteTracePath = resolve(root, tracePath);
  if (relative(root, absoluteTracePath).startsWith("..")) throw new Error(`trace path escapes repository: ${tracePath}`);
  const events = (await readFile(absoluteTracePath, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Json);
  const digest = sha256(canonicalJson(events));
  const manifestPath = join(dirname(dirname(absoluteTracePath)), "runs", `${basename(absoluteTracePath, ".jsonl")}.manifest.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { traceDigest?: unknown };
  // The evidence tools are plain ESM, so their runtime module has no TypeScript declaration file.
  // @ts-expect-error -- validated at runtime by the tool package's own tests.
  const summaryModule = await import("../evidence/lib/summary.mjs") as unknown as { readonly validateTrace: TraceValidator };
  const validation = summaryModule.validateTrace(events, manifest);
  if (!validation.valid) throw new Error(`${tracePath}: trace validation failed: ${validation.diagnostics.map((item) => item.code).join(", ")}`);
  if (manifest.traceDigest !== digest) throw new Error(`${tracePath}: trace manifest digest does not match trace`);
  return digest;
}

function isBoundDetectorOutput(value: unknown, entry: FieldCase): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as Record<string, unknown>;
  return output.detector === entry.detector
    && output.expectedFinding === entry.expectedFinding
    && output.observedFinding === entry.observedFinding
    && output.confidence === entry.confidence;
}

async function verifyArtifacts(corpus: FieldCorpus, root: string): Promise<readonly string[]> {
  const diagnostics: string[] = [];
  for (const entry of corpus.cases) {
    try {
      const traces = await Promise.all([...entry.tracePaths].sort((left, right) => left.localeCompare(right)).map(async (tracePath) => ({ tracePath, digest: await traceDigestFor(root, tracePath) })));
      if (sha256(canonicalJson(traces)) !== entry.replayDigest) diagnostics.push(`${entry.caseId}: replay digest does not match validated trace bundle`);
      if (entry.caseKind === "detector_quality" && entry.detectorOutputPath !== null && entry.detectorOutputDigest !== null) {
        const outputPath = resolve(root, entry.detectorOutputPath);
        if (relative(root, outputPath).startsWith("..")) throw new Error(`detector output path escapes repository: ${entry.detectorOutputPath}`);
        const outputContent = await readFile(outputPath, "utf8");
        if (sha256(outputContent) !== entry.detectorOutputDigest) diagnostics.push(`${entry.caseId}: detector output digest does not match artifact`);
        try {
          if (!isBoundDetectorOutput(JSON.parse(outputContent), entry)) diagnostics.push(`${entry.caseId}: detector output does not match reviewed detector labels and confidence`);
        } catch {
          diagnostics.push(`${entry.caseId}: detector output is not valid JSON`);
        }
      }
    } catch (error) {
      diagnostics.push(`${entry.caseId}: artifact validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return diagnostics.sort((left, right) => left.localeCompare(right));
}

export async function loadFieldCorpus(path: string, root = process.cwd()): Promise<FieldCorpus> {
  const corpus = asFieldCorpus(JSON.parse(await readFile(resolve(path), "utf8")));
  const diagnostics = [...validateFieldCorpus(corpus), ...await verifyArtifacts(corpus, root)];
  if (diagnostics.length > 0) throw new Error(diagnostics.join("; "));
  return corpus;
}
