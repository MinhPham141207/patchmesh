# Agent Evidence Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a committed `.evidence/` execution journal that records agent and subagent hook activity as ordered, redacted, replayable JSONL and produces deterministic validation and benchmark reports.

**Architecture:** A dependency-free recorder reads one normalized hook payload from stdin, validates and redacts it, and appends one immutable event to `.evidence/trace/<runId>.jsonl`. A small trace store owns per-run locking and idempotency; separate validator, summary, and benchmark commands consume the raw trace without changing PatchMesh's public event protocol.

**Tech Stack:** Node.js ESM, `node:fs/promises`, `node:crypto`, `node:test`, JSON Schema documents, repository-relative paths, and the existing root npm/pnpm scripts.

## Global Constraints

- Use a local execution journal rather than changing the public PatchMesh normalized event protocol.
- Store one newline-delimited JSON trace per run at `.evidence/trace/<runId>.jsonl`.
- Keep `result` bounded and redacted; never store prompts, hidden reasoning, credentials, tokens, cookies, private keys, or complete environment maps.
- Never copy requested paths into `derivedEffect.changedPaths` without post-tool observation data.
- Preserve per-run order with a monotonic `sequence`; timestamps do not establish cross-run causality.
- Events are append-only; identical duplicate delivery is a no-op and conflicting event IDs are rejected.
- Recorder failures return `accepted: false` diagnostics and exit successfully so hooks cannot block the observed operation.
- Temporary locks and state live under ignored `.evidence/.locks/` and `.evidence/.state/` directories.
- Generated traces and deterministic reports are committed artifacts.
- Do not modify the existing unrelated Phase 2 worktree changes.

---

### Task 1: Define the trace contract and pure normalization

**Files:**
- Create: `.evidence/config.json`
- Create: `.evidence/trace-event.schema.json`
- Create: `.evidence/run-manifest.schema.json`
- Create: `tools/evidence/lib/types.mjs`
- Create: `tools/evidence/lib/canonical.mjs`
- Create: `tools/evidence/lib/redact.mjs`
- Create: `tools/evidence/lib/normalize.mjs`
- Create: `tools/evidence/lib/validate.mjs`
- Test: `tools/evidence/normalization.test.mjs`
- Test: `tools/evidence/validation.test.mjs`

**Interfaces:**
- `normalizeHookPayload(payload, context, options) -> NormalizedTraceInput` produces the event fields without assigning `sequence`.
- `redactValue(value, options) -> { value, redacted, digest }` bounds strings and recursively redacts secret-like object keys.
- `createEventId({ runId, action, sourceEventId, toolCallId, payloadDigest }) -> string` returns a deterministic `trace_` identifier without persisting the source identity.
- `canonicalJson(value) -> string` sorts object keys recursively and emits stable JSON for hashing and duplicate comparison.
- `validateTraceEvent(event) -> readonly Diagnostic[]` returns deterministic path/message diagnostics and never throws for malformed external values.
- `validateRunManifest(manifest) -> readonly Diagnostic[]` validates the manifest shape, counts, and digest fields.

- [ ] **Step 1: Write failing contract tests**

Create a valid input fixture and assert normalization preserves the required fields:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeHookPayload } from "./lib/normalize.mjs";

test("normalizes a completed tool with explicit effects", () => {
  const event = normalizeHookPayload({
    action: "tool.completed",
    sourceEventId: "hook-1",
    agentId: "agent-a",
    taskId: "task-a",
    worktreeId: "worktree-a",
    toolCallId: "tool-a",
    paths: ["D:\\repo\\src\\api.ts"],
    result: { status: "succeeded", durationMs: 12, exitCode: 0, output: "ok" },
    derivedEffect: { status: "verified", changedPaths: ["src/api.ts"], confidence: 1, gaps: [] },
  }, { runId: "run-a", repositoryRoot: "D:\\repo", now: "2026-08-10T00:00:00.000Z" });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.action, "tool.completed");
  assert.deepEqual(event.paths, ["src/api.ts"]);
  assert.equal(event.result.output, undefined);
  assert.equal(event.result.outputDigest.startsWith("sha256:"), true);
  assert.equal(event.derivedEffect.status, "verified");
});

test("redacts secret keys and bounds output", () => {
  const event = normalizeHookPayload({
    action: "tool.completed",
    result: { status: "succeeded", output: "token=super-secret".repeat(100) },
  }, { runId: "run-a", repositoryRoot: null, now: "2026-08-10T00:00:00.000Z" });

  assert.equal(JSON.stringify(event).includes("super-secret"), false);
  assert.equal(JSON.stringify(event).includes("token="), false);
  assert.equal(event.result.outputDigest.startsWith("sha256:"), true);
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `node --test "tools/evidence/*test.mjs"`

Expected: FAIL because the evidence modules and schemas do not exist.

- [ ] **Step 3: Implement canonical JSON, redaction, and normalization**

Implement the minimum behavior required by the tests:

- Sort object keys recursively before hashing.
- Use SHA-256 digests with the `sha256:` prefix.
- Set `.evidence/config.json` to `schemaVersion: 1`, `maxTextBytes: 4096`, `maxErrorBytes: 2048`, `maxArrayEntries: 128`, and `redactionPlaceholder: "[REDACTED]"`; limit captured text to these values and retain only its digest in `result`.
- Replace values under case-insensitive keys containing `token`, `password`, `secret`, `authorization`, `cookie`, `api_key`, or `private_key` with `[REDACTED]` before hashing or storing.
- Normalize Windows and POSIX separators, remove redundant segments, and make paths relative to `repositoryRoot` when the path is inside it.
- Set missing attribution and effect fields to `null`, empty arrays, or `unknown` with a concrete gap rather than inventing IDs.
- Produce the event shape documented in the spec, excluding runtime-only source fields from the stored event.

- [ ] **Step 4: Add and test the JSON schemas and validators**

Define required event properties for `schemaVersion`, `eventId`, `runId`, `sequence`, `timestamp`, attribution fields, `action`, `paths`, `resources`, `result`, and `derivedEffect`. Define nullable attribution values, status enums, confidence range `0..1`, and `additionalProperties: false` for stored event objects. Define the manifest fields used by later tasks.

Add assertions for missing fields, invalid timestamps, negative sequence values, confidence outside `0..1`, invalid result status, and invalid derived-effect status. Run:

```text
node --test "tools/evidence/*test.mjs"
```

Expected: all normalization and validation tests pass.

- [ ] **Step 5: Commit the contract layer**

```text
git add .evidence tools/evidence/lib tools/evidence/normalization.test.mjs tools/evidence/validation.test.mjs
git commit -m "feat: add evidence trace contract"
```

### Task 2: Implement ordered append, idempotency, and the hook recorder

**Files:**
- Create: `tools/evidence/lib/trace-store.mjs`
- Create: `tools/evidence/lib/recorder.mjs`
- Create: `tools/evidence/record.mjs`
- Test: `tools/evidence/trace-store.test.mjs`
- Test: `tools/evidence/recorder.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- `appendTraceEvent({ evidenceRoot, runId, event }) -> Promise<{ accepted: boolean, duplicate: boolean, event: object | null, tracePath: string, diagnostic: object | null }>` appends or deduplicates one event under a per-run lock.
- `recordHookPayload({ payload, env, now }) -> Promise<{ accepted: boolean, duplicate: boolean, eventId: string | null, tracePath: string | null, diagnostic: object | null }>` resolves context, normalizes the payload, and delegates storage.
- CLI stdin contract: `node tools/evidence/record.mjs` reads exactly one JSON payload and writes one bounded JSON result to stdout.

- [ ] **Step 1: Write failing storage tests**

Cover append order and duplicate behavior:

```js
test("appends events in sequence order and ignores identical delivery", async () => {
  const first = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(1) });
  const duplicate = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(1) });
  const second = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(2) });

  assert.equal(first.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(second.event.sequence, 2);
  assert.equal((await readFile(first.tracePath, "utf8")).trim().split("\n").length, 2);
});

test("rejects an event ID reused with different canonical content", async () => {
  await appendTraceEvent({ evidenceRoot, runId: "run-a", event: event(1) });
  const result = await appendTraceEvent({ evidenceRoot, runId: "run-a", event: { ...event(1), action: "tool.failed" } });

  assert.equal(result.accepted, false);
  assert.match(result.diagnostic.message, /event ID conflict/);
});
```

- [ ] **Step 2: Run storage tests to verify RED**

Run: `node --test tools/evidence/trace-store.test.mjs`

Expected: FAIL because the trace store does not exist.

- [ ] **Step 3: Implement the locked append store**

Create `.evidence/trace`, `.evidence/.locks`, and `.evidence/.state` as needed. Acquire `<runId>.lock` with exclusive file creation, retry every 25 milliseconds for up to 2 seconds, then release it in a `finally` block. Under the lock:

1. Read existing JSONL lines and reject malformed existing lines.
2. Find an existing event with the same `eventId`.
3. Return a duplicate only when its canonical JSON matches.
4. Return an `accepted: false` conflict diagnostic without rewriting the file when content differs.
5. Assign `sequence` as one greater than the highest existing sequence when the normalized event does not already have one.
6. Append exactly one JSON line ending in `\n`.

Keep the lock and counter files under `.evidence/.locks/` and `.evidence/.state/`; add those directories to `.gitignore` without ignoring `.evidence/trace/`, `.evidence/runs/`, or `.evidence/reports/`.

- [ ] **Step 4: Write failing recorder and CLI tests**

Test environment fallback and fail-open behavior:

```js
test("records one hook payload with environment attribution", async () => {
  const result = await recordHookPayload({
    payload: { action: "tool.requested", toolCallId: "tool-a", paths: ["src/a.ts"] },
    env: { PATCHMESH_EVIDENCE_ROOT: evidenceRoot, PATCHMESH_RUN_ID: "run-a", PATCHMESH_AGENT_ID: "agent-a" },
    now: "2026-08-10T00:00:00.000Z",
  });

  assert.equal(result.accepted, true);
  const lines = (await readFile(result.tracePath, "utf8")).trim().split("\n");
  assert.equal(JSON.parse(lines[0]).agentId, "agent-a");
});

test("malformed input returns a diagnostic without throwing", async () => {
  const result = await recordHookPayload({
    payload: { result: { status: "not-a-status" } },
    env: { PATCHMESH_EVIDENCE_ROOT: evidenceRoot, PATCHMESH_RUN_ID: "run-a" },
    now: "2026-08-10T00:00:00.000Z",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.diagnostic.code, "TRACE_INPUT_INVALID");
});
```

- [ ] **Step 5: Implement the recorder and fail-open CLI**

Resolve `PATCHMESH_EVIDENCE_ROOT` to the configured root, `PATCHMESH_RUN_ID` to the run ID, and the agent/task/worktree/parent values from environment only when the payload does not provide them. Compute the event ID from `sourceEventId` when present, otherwise from the run/action/tool identity and a stable payload digest. Do not persist `sourceEventId`.

The CLI must:

- read stdin once;
- parse one JSON object;
- print only a bounded `{ accepted, duplicate, eventId, tracePath, diagnostic }` result;
- write diagnostics to stderr without echoing raw payloads;
- exit with status `0` for valid events, malformed input, missing context, lock timeout, and write failure.

- [ ] **Step 6: Run focused recorder tests**

Run: `node --test tools/evidence/trace-store.test.mjs tools/evidence/recorder.test.mjs`

Expected: all storage and recorder tests pass, including conflict and fail-open cases.

- [ ] **Step 7: Commit the recorder**

```text
git add .gitignore tools/evidence/lib/trace-store.mjs tools/evidence/lib/recorder.mjs tools/evidence/record.mjs tools/evidence/trace-store.test.mjs tools/evidence/recorder.test.mjs
git commit -m "feat: add fail-open evidence recorder"
```

### Task 3: Add manifests, validation, and deterministic summaries

**Files:**
- Create: `tools/evidence/lib/manifest.mjs`
- Create: `tools/evidence/lib/summary.mjs`
- Create: `tools/evidence/validate-trace.mjs`
- Create: `tools/evidence/summarize-trace.mjs`
- Test: `tools/evidence/manifest.test.mjs`
- Test: `tools/evidence/summary.test.mjs`

**Interfaces:**
- `updateRunManifest({ evidenceRoot, runId, event }) -> Promise<RunManifest>` writes `.evidence/runs/<runId>.manifest.json` from the trace-derived state.
- `readTrace({ tracePath }) -> Promise<readonly TraceEvent[]>` parses JSONL without changing event order.
- `validateTrace(events, manifest) -> { valid: boolean, diagnostics: readonly Diagnostic[], stats: TraceStats }` checks all acceptance invariants.
- `summarizeTrace(events, manifest) -> TraceSummary` returns deterministic counts, status, attribution, effect coverage, gap counts, and trace digest.
- CLI `node tools/evidence/validate-trace.mjs <trace-path>` returns a machine-readable report and exits `0` only for valid trace input. `node tools/evidence/validate-trace.mjs --all .evidence/trace` validates every JSONL trace in the directory and exits `0` only when all traces are valid.
- CLI `node tools/evidence/summarize-trace.mjs <runId>` writes `.evidence/reports/<runId>.summary.json` from the trace and manifest.

- [ ] **Step 1: Write failing manifest and summary tests**

Assert that a two-event run produces stable counts and coverage:

```js
test("summary counts outcomes and explicit effect gaps", () => {
  const summary = summarizeTrace([
    event({ sequence: 1, action: "tool.requested", result: { status: "started" }, derivedEffect: unknownEffect() }),
    event({ sequence: 2, action: "tool.completed", result: { status: "succeeded" }, derivedEffect: unknownEffect() }),
  ], manifestFor("run-a"));

  assert.equal(summary.eventCount, 2);
  assert.equal(summary.completedToolCount, 1);
  assert.equal(summary.unknownEffectCount, 2);
  assert.equal(summary.effectCoverage, 0);
  assert.equal(summary.traceDigest.startsWith("sha256:"), true);
});

test("validator rejects sequence gaps and manifest count mismatches", () => {
  const result = validateTrace([event({ sequence: 2 })], manifestFor("run-a", { eventCount: 2 }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ["TRACE_SEQUENCE_INVALID", "TRACE_MANIFEST_MISMATCH"]);
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test tools/evidence/manifest.test.mjs tools/evidence/summary.test.mjs`

Expected: FAIL because manifest and summary functions do not exist.

- [ ] **Step 3: Implement manifest updates**

After each accepted event, update the manifest under the same run lock. Record schema and recorder versions, attribution, parent IDs, repository/workspace/worktree values, first and last timestamps, final status from `session.stop` or `subagent.stop`, event count, sequence range, trace digest, recorder errors, and observability gaps. Recompute counts from the JSONL trace rather than incrementing blindly so restart and duplicate delivery remain deterministic.

- [ ] **Step 4: Implement validation and summary projection**

Validate JSONL parsing, run ID consistency, strict sequence order starting at `1`, event IDs, required fields, canonical duplicate behavior, action warnings, result/effect statuses, confidence bounds, explicit unknown-effect gaps, and manifest count/digest consistency. Summaries must sort keys through `canonicalJson`, contain no timestamps generated during summarization, and include:

- total events and action counts;
- completed, failed, interrupted, and rejected tool counts;
- redaction count and bounded-output count;
- verified, inferred, degraded, and unknown effect counts;
- effect coverage as verified effects divided by effect-bearing post-tool events;
- gap counts by reason;
- trace and manifest digests.

- [ ] **Step 5: Implement the two CLI commands**

Make validation print JSON to stdout and human-readable diagnostics to stderr only when invalid. Support both one trace path and `--all <trace-directory>`. Make summarization refuse a missing or invalid trace, write the deterministic report atomically through a temporary file in `.evidence/.state/`, and rename it into `.evidence/reports/` after successful validation.

- [ ] **Step 6: Run focused validation tests**

Run: `node --test tools/evidence/manifest.test.mjs tools/evidence/summary.test.mjs tools/evidence/validation.test.mjs`

Expected: all validation, manifest, and summary tests pass.

- [ ] **Step 7: Commit the derived evidence layer**

```text
git add tools/evidence/lib/manifest.mjs tools/evidence/lib/summary.mjs tools/evidence/validate-trace.mjs tools/evidence/summarize-trace.mjs tools/evidence/manifest.test.mjs tools/evidence/summary.test.mjs
git commit -m "feat: add evidence trace validation and summaries"
```

### Task 4: Add benchmark reporting, hook documentation, and workspace commands

**Files:**
- Create: `.evidence/README.md`
- Create: `tools/evidence/benchmark.mjs`
- Create: `tools/evidence/benchmark.test.mjs`
- Create: `benchmarks/evidence/workloads.json`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- `loadEvidenceWorkloads(path) -> EvidenceWorkloadFile` reads versioned workload definitions.
- `runEvidenceBenchmark({ workload, fixtureTrace, iterations, warmup }) -> EvidenceBenchmarkReport` retains raw samples and derived statistics.
- CLI `node tools/evidence/benchmark.mjs --trace <path> --output <path>` writes one JSON report with environment metadata.
- Root scripts: `evidence:test`, `evidence:validate`, and `evidence:benchmark` invoke the dependency-free tools without building or changing PatchMesh package outputs.

- [ ] **Step 1: Write failing benchmark tests**

Test deterministic percentile and report shape using a temporary trace:

```js
test("benchmark report retains raw samples and deterministic percentiles", async () => {
  const report = await runEvidenceBenchmark({ fixtureTrace, iterations: 3, warmup: 1 });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.samples.length, 3);
  assert.equal(report.failures, 0);
  assert.equal(report.p50Ms <= report.p95Ms, true);
  assert.equal(report.environment.nodeVersion.startsWith("v"), true);
});
```

- [ ] **Step 2: Run the benchmark test to verify RED**

Run: `node --test tools/evidence/benchmark.test.mjs`

Expected: FAIL because workload definitions and benchmark runner do not exist.

- [ ] **Step 3: Implement evidence workload definitions and benchmark runner**

Create `benchmarks/evidence/workloads.json` with this exact initial definition:

```json
{
  "schemaVersion": 1,
  "definitionVersion": "evidence-v1",
  "workloads": [
    { "workloadId": "trace_summary_small", "traceGlob": "small", "warmupRuns": 2, "measuredRuns": 10 },
    { "workloadId": "trace_summary_parent_subagent", "traceGlob": "parent-subagent", "warmupRuns": 2, "measuredRuns": 10 },
    { "workloadId": "trace_summary_large", "traceGlob": "large", "warmupRuns": 1, "measuredRuns": 5 }
  ]
}
```

For each workload, warm up, run the requested sample count, retain every elapsed sample and failure, and derive p50/p95 with the repository's nearest-rank rule. Include `definitionVersion`, workload ID, timestamp, Git commit when available, OS, architecture, CPU, memory, Node version, warm-up count, measured count, raw observations, failures, trace size, event count, redaction count, unknown-effect count, and summary generation time. The `--all` mode discovers `.evidence/trace/*.jsonl`, maps filenames to the `traceGlob` values, and writes one report per workload under `.evidence/reports/`.

Never claim a benchmark acceptance threshold. The report is evidence for later decisions and must fail if successful variants disagree on the trace digest.

- [ ] **Step 4: Add hook documentation and safe artifact rules**

Document in `.evidence/README.md`:

```text
printf '%s\n' '{"action":"tool.completed","toolCallId":"tool-1"}' |
  PATCHMESH_EVIDENCE_ROOT=.evidence \
  PATCHMESH_RUN_ID=run-example \
  PATCHMESH_AGENT_ID=agent-example \
  node tools/evidence/record.mjs
```

Document the input payload fields, environment fallbacks, Codex/OpenCode translator boundary, parent/subagent linkage, fail-open behavior, path redaction, and commands for validation, summary generation, and benchmarking. Do not commit local runtime credentials or runtime-specific ignored configuration. Add `.evidence/.locks/`, `.evidence/.state/`, and benchmark temporary output locations to `.gitignore` while leaving trace, run manifest, report, schema, config, and documentation paths visible to Git.

- [ ] **Step 5: Add root scripts and run the benchmark tests**

Add:

```json
{
  "evidence:test": "node --test \"tools/evidence/*test.mjs\"",
  "evidence:validate": "node tools/evidence/validate-trace.mjs --all .evidence/trace",
  "evidence:benchmark": "node tools/evidence/benchmark.mjs --all --output .evidence/reports"
}
```

Run: `corepack pnpm evidence:test`

Expected: all evidence tests pass and no PatchMesh package build is required for the dependency-free tools.

- [ ] **Step 6: Commit the integration layer**

```text
git add .evidence/README.md benchmarks/evidence tools/evidence/benchmark.mjs tools/evidence/benchmark.test.mjs package.json .gitignore
git commit -m "feat: add evidence trace benchmarks"
```

### Task 5: Full verification and artifact review

**Files:**
- Review: `docs/superpowers/specs/2026-08-10-agent-evidence-trace-design.md`
- Review: `.evidence/trace/`
- Review: `.evidence/runs/`
- Review: `.evidence/reports/`

- [ ] **Step 1: Exercise one real parent/subagent hook sequence**

Use the recorder command for `session.start`, `subagent.start`, `tool.requested`, `tool.completed`, `tool.failed`, and `session.stop` payloads with distinct run IDs. Run the validator and summarizer against the resulting trace. Confirm that all required fields exist, sequences are strictly increasing per run, parent linkage is present, and unknown effects include explicit gaps.

- [ ] **Step 2: Run evidence tests and benchmark**

Run:

```text
corepack pnpm evidence:test
node tools/evidence/benchmark.mjs --trace .evidence/trace/<runId>.jsonl --output .evidence/reports/<runId>.benchmark.json
```

Expected: tests pass, the report retains raw samples, and trace/report digests are stable when rerun over unchanged input.

- [ ] **Step 3: Run the existing workspace verification**

Run:

```text
corepack pnpm test
corepack pnpm typecheck
node tools/phase0/validate.mjs
```

Expected: existing workspace builds, tests, typechecks, and Phase 0 validation remain green.

- [ ] **Step 4: Inspect scope and whitespace**

Run: `git diff --check` and `git status --short`

Expected: only evidence implementation, schemas/config/docs, benchmark definitions, and approved plan/spec artifacts are changed. Existing unrelated Phase 2 modifications remain untouched, and no lock/state files or raw secret material are present.

- [ ] **Step 5: Record the verified outcome**

Store one project-memory atom containing the implemented evidence recorder paths, exact verification commands, and any observed limitation. Do not store raw traces, command output, credentials, or temporary paths.
