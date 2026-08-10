# Agent Evidence Trace Design

## Status

Approved design for a local, repository-level execution journal. This is not a
replacement for the PatchMesh normalized event protocol and does not add a
public runtime adapter contract.

## Goal

Create a committed `.evidence/` artifact that records agent and subagent
execution in order, with enough structured evidence to support reproducible
tests and build benchmarks.

The first slice is runtime-agnostic at its core. Runtime hooks send one JSON
payload to a dependency-free recorder. The recorder normalizes the payload,
redacts sensitive content, and appends one immutable JSONL event to the run
trace.

## Decisions

- Use a local execution journal rather than changing the public PatchMesh event
  protocol.
- Store one newline-delimited JSON trace per run at
  `.evidence/trace/<runId>.jsonl`.
- Use a hook recorder rather than requiring every agent to wrap tool calls in a
  TypeScript API.
- Commit generated traces as audit artifacts.
- Store bounded, redacted result metadata rather than raw tool output or
  arguments.
- Record unknown effects explicitly instead of inferring effects from requested
  paths or commands.
- Fail open: trace failures must not block the observed agent operation.

## Scope

### In scope

- A versioned trace event schema and run manifest schema.
- A portable stdin-based recorder command.
- Per-run ordering, stable event IDs, duplicate handling, and subagent links.
- Path and resource normalization.
- Redaction and bounded result capture.
- A deterministic trace validator and summarizer.
- Tests for lifecycle, failures, redaction, ordering, and malformed input.
- Benchmark reporting for recorder and trace quality.
- Hook integration documentation.

### Out of scope

- Replacing the PatchMesh event store or work graph.
- Storing prompts, hidden model reasoning, credentials, or full environment
  values.
- Inferring causal order across independent runs from timestamps.
- Filesystem or Git observation inside the recorder itself.
- Enforcing, pausing, or rejecting agent operations.
- A dashboard or database-backed trace query service.

## Trace Layout

```text
.evidence/
  README.md
  config.json
  trace-event.schema.json
  run-manifest.schema.json
  trace/
    <runId>.jsonl
  runs/
    <runId>.manifest.json
  reports/
    <runId>.summary.json
```

Trace files and deterministic reports are committed. Temporary lock and state
files are not committed. The recorder creates missing directories as needed.

The trace is authoritative for raw local execution evidence. A summary is a
derived convenience artifact and must be reproducible from the trace.

## Event Contract

Each JSONL line is one object with these required fields:

```json
{
  "schemaVersion": 1,
  "eventId": "trace_<stable-id>",
  "runId": "run_<stable-id>",
  "sequence": 1,
  "timestamp": "2026-08-10T00:00:00.000Z",
  "agentId": "agent-a",
  "taskId": "task-a",
  "worktreeId": "worktree-a",
  "toolCallId": "tool-call-a",
  "parentRunId": null,
  "parentTaskId": null,
  "action": "tool.completed",
  "paths": ["packages/core/src/index.ts"],
  "resources": [
    { "kind": "file", "id": "packages/core/src/index.ts", "version": null }
  ],
  "result": {
    "status": "succeeded",
    "durationMs": 12,
    "exitCode": 0,
    "errorClass": null,
    "outputDigest": "sha256:<hex>"
  },
  "derivedEffect": {
    "status": "unknown",
    "changedPaths": [],
    "resourceChanges": [],
    "confidence": 0,
    "gaps": ["post-tool effect observation was unavailable"]
  }
}
```

`agentId`, `taskId`, `worktreeId`, `toolCallId`, and parent identifiers are
nullable when the runtime does not provide them, but the fields are always
present. The recorder must not invent attribution IDs. `runId`, `eventId`, and
`sequence` are recorder-owned.

Supported action names include:

- `session.start`
- `subagent.start`
- `tool.requested`
- `tool.completed`
- `tool.failed`
- `tool.interrupted`
- `session.stop`
- `subagent.stop`
- `trace.error`

The action field remains an open string so new runtimes can add lifecycle
actions without changing the storage mechanism. The schema validates the
shape and known status values, while the validator can warn on unknown action
names.

## Ordering and Idempotency

Ordering is guaranteed within one run by `sequence`. The recorder uses a
runtime-supplied sequence when trustworthy; otherwise it allocates the next
sequence under a per-run lock. A lock-protected counter or equivalent state is
temporary and excluded from committed artifacts.

Events are appended, never rewritten. Re-delivery with the same `eventId` and
same canonical content is a no-op. Reuse of an `eventId` with different content
is a validation failure and produces a trace error without replacing the
original event.

Separate runs are related by `parentRunId`, `parentTaskId`, and explicit event
references when supplied. Timestamps are metadata only and do not establish
cross-run causality.

The run manifest contains:

- `schemaVersion` and recorder version;
- `runId`, optional parent run/task IDs, and attribution IDs;
- repository, workspace, and worktree information;
- start/end timestamps and final status;
- event count, sequence range, and trace digest;
- recorder errors and observability gaps.

The manifest is derived or finalized from the trace and cannot override event
contents.

## Normalization and Redaction

- Prefer repository-relative paths.
- Normalize separators and remove redundant path segments.
- Redact or hash paths outside the repository when they can expose local
  usernames or unrelated machine details.
- Never persist prompts, hidden reasoning, credentials, tokens, cookies,
  private keys, or complete environment maps.
- Redact values associated with keys matching secret-like names such as
  `token`, `password`, `secret`, `authorization`, `cookie`, `api_key`, and
  `private_key`.
- Bound all captured text and retain a SHA-256 digest for useful comparison.
- Capture error class and a bounded, redacted error message only.

`result` contains status metadata: status, duration, exit code where available,
error class, and an output digest. It does not contain raw command output by
default.

`derivedEffect` is populated only from post-tool effect data supplied by a hook
or a later observer. If no verification is available, it uses `unknown`, zero
confidence, and an explicit gap. Requested paths are never copied into
`changedPaths` without an observation claim.

## Hook Data Flow

```text
Agent or subagent runtime
  -> lifecycle/tool hook payload
  -> node tools/evidence/record.mjs
  -> normalize and redact
  -> validate event
  -> append .evidence/trace/<runId>.jsonl
  -> derive/update run summary
```

The recorder reads exactly one hook payload from stdin per invocation. Runtime
integrations provide attribution through the payload or environment variables:

- `PATCHMESH_EVIDENCE_ROOT`
- `PATCHMESH_RUN_ID`
- `PATCHMESH_AGENT_ID`
- `PATCHMESH_TASK_ID`
- `PATCHMESH_WORKTREE_ID`
- `PATCHMESH_PARENT_RUN_ID`
- `PATCHMESH_PARENT_TASK_ID`

Codex, OpenCode, and future runtimes use small translators at the hook boundary
to produce the recorder input contract. Runtime-specific parsing does not leak
into the trace schema or PatchMesh core packages.

If input is malformed, the recorder returns an `accepted: false` diagnostic and
emits a redacted `trace.error` only when a valid run context is available. It
never writes the malformed raw payload. The hook process still exits
successfully so recorder failure cannot block the observed operation.

If the trace cannot be written, the recorder reports the failure to stderr and
returns an `accepted: false` diagnostic. The hook process still exits
successfully and must not fail the agent's underlying tool operation.

## Validation and Benchmarks

The validator checks:

- JSONL parsing and schema compliance;
- required fields and nullable attribution rules;
- strictly increasing per-run sequence values;
- duplicate event behavior and event ID conflicts;
- redaction of secret-like fields and bounded text;
- valid result and derived-effect status values;
- explicit gaps for unknown or degraded effects;
- manifest counts and trace digest consistency.

Tests include a golden parent/subagent run, successful and failed tools,
interrupted tools, duplicate delivery, malformed input, missing attribution,
path normalization, secret redaction, output bounding, and unknown effects.

The benchmark command consumes real JSONL traces and records:

- event count and trace size;
- recorder elapsed time and per-event latency;
- recorder failures and malformed inputs;
- redaction count;
- known versus unknown effect coverage;
- summary generation time;
- raw samples and environment metadata.

Benchmark output follows existing repository evidence rules: definition version,
workload ID, timestamp, Git commit, OS, architecture, CPU, memory, Node
version, warm-up count, measured sample count, raw observations, failures, and
derived statistics are retained. No percentile is accepted without raw samples
and sample count.

## Acceptance Criteria

The first implementation is accepted when:

1. A hook payload produces a valid committed JSONL event with all required
   fields.
2. Parent and subagent traces preserve local ordering and parent linkage.
3. Duplicate delivery is idempotent and conflicting event IDs are rejected.
4. Sensitive values and unbounded output are not written to trace artifacts.
5. Missing effect observation is explicit and never presented as a verified
   change.
6. The validator catches malformed, out-of-order, incomplete, and conflicting
   traces deterministically.
7. The benchmark command produces reproducible raw and derived evidence.
8. Recorder failures do not block the observed agent operation.
9. Tests, typechecks/builds, and `git diff --check` pass.

## Risks and Mitigations

- Hook runtimes may provide different payload shapes. Mitigation: keep runtime
  translators thin and test each supported fixture.
- Concurrent hook invocations may race sequence allocation. Mitigation: use a
  per-run lock and validate sequence monotonicity.
- Committed traces may contain sensitive local paths. Mitigation: normalize to
  repository-relative paths and redact external paths before append.
- A post-tool hook may not prove filesystem effects. Mitigation: report unknown
  effects with gaps and leave stronger observation to a separate boundary.
- A committed trace may become noisy. Mitigation: bound result data, keep one
  event per hook call, and generate summaries from immutable raw evidence.
