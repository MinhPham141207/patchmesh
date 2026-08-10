# Agent Evidence Traces

`.evidence/` is the committed local execution journal for agent and subagent
runs. Each run is an append-only JSONL file at
`.evidence/trace/<runId>.jsonl`. Run manifests and summaries are derived from
that file and never replace it.

## Record A Hook Event

The recorder reads one JSON object from stdin. Runtime hooks provide attribution
through the payload when available or through environment variables.

```text
printf '%s\n' '{"action":"tool.completed","toolCallId":"tool-1"}' |
  PATCHMESH_EVIDENCE_ROOT=.evidence \
  PATCHMESH_RUN_ID=run-example \
  PATCHMESH_AGENT_ID=agent-example \
  node tools/evidence/record.mjs
```

Supported environment fallbacks are:

- `PATCHMESH_EVIDENCE_ROOT`
- `PATCHMESH_RUN_ID`
- `PATCHMESH_AGENT_ID`
- `PATCHMESH_TASK_ID`
- `PATCHMESH_WORKTREE_ID`
- `PATCHMESH_PARENT_RUN_ID`
- `PATCHMESH_PARENT_TASK_ID`
- `PATCHMESH_REPOSITORY_ROOT`

The payload may contain `action`, `sourceEventId`, `timestamp`, attribution
fields, `toolCallId`, `paths`, `resources`, `result`, and `derivedEffect`.
Runtime-specific Codex, OpenCode, or future hook translators should only map
their native payload into these fields. They should not write trace files or
implement trace ordering themselves.

## PatchMesh Production Bridge

When the runtime caller has just awaited `McpProxy.execute`, it may attach an
explicit `patchmesh` bridge object before invoking `record.mjs`:

```json
{
  "action": "tool.completed",
  "toolCallId": "tool-1",
  "patchmesh": {
    "result": {
      "execution": { "outcome": "succeeded", "exitCode": 0 },
      "completedEventId": "evt_<id>",
      "coverage": {
        "presentation": "sufficient",
        "gaps": []
      },
      "observationDiagnostics": [],
      "analysisDiagnostics": []
    },
    "events": [
      {
        "eventId": "evt_<id>",
        "eventType": "tool.completed",
        "payload": { "effectEventIds": ["evt_<file-change-id>"] }
      },
      {
        "eventId": "evt_<file-change-id>",
        "eventType": "file.changed",
        "payload": {
          "resource": { "resourceId": "res_<id>", "kind": "file", "locator": "src/api.ts" },
          "beforeVersion": {},
          "afterVersion": {},
          "changeKind": "modified"
        }
      }
    ]
  }
}
```

`record.mjs` removes the bridge object before storage. Only `file.changed`
events explicitly linked from the persisted `tool.completed.effectEventIds`
array can populate `derivedEffect`. Missing completion/effect evidence remains
`unknown`; coverage gaps produce `degraded`; requested hook paths are never
copied into observed effect paths.

The recorder emits a bounded JSON result with `accepted`, `duplicate`,
`eventId`, `tracePath`, and `diagnostic`. Malformed input, lock contention, and
write failures exit successfully with `accepted: false` so an evidence failure
cannot block the observed agent operation.

## Privacy And Coverage

- Paths inside the configured repository become repository-relative.
- External paths are represented by short digests.
- Output is never stored directly; a SHA-256 digest is retained instead.
- Secret-shaped keys such as `token`, `password`, `secret`, `authorization`,
  `cookie`, `api_key`, and `private_key` are redacted.
- Prompts, hidden reasoning, credentials, and complete environment maps are not
  recorded.
- Requested paths are not treated as changed paths.
- Missing post-tool observation is recorded as `derivedEffect.status: "unknown"`
  with an explicit gap.

## Validate And Summarize

Validate one trace:

```text
node tools/evidence/validate-trace.mjs .evidence/trace/run-example.jsonl
```

Validate all traces:

```text
node tools/evidence/validate-trace.mjs --all .evidence/trace
```

Generate a deterministic summary:

```text
node tools/evidence/summarize-trace.mjs run-example
```

The summary is written to `.evidence/reports/run-example.summary.json`. It
contains event and action counts, result and effect coverage, redaction counts,
gap counts, and trace/manifest digests.

## Benchmarks

Run the evidence tests and benchmark definitions through the root scripts:

```text
corepack pnpm evidence:test
corepack pnpm evidence:validate
corepack pnpm evidence:benchmark
```

Benchmark reports retain raw elapsed samples, failures, event count, trace size,
redaction count, unknown-effect count, summary time, and environment metadata:
definition version, workload ID, timestamp, Git commit, OS, architecture, CPU,
memory, Node version, warm-up count, and measured count. No percentile is
treated as reproducible evidence without its raw samples and sample count.
