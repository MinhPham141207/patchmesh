# Codex–PatchMesh Integration

## Status

Approved design; implementation pending user review of this document.

## Problem

Codex already loads project hooks from `.codex/hooks.json`, but those hooks currently
invoke Knowl only. PatchMesh is not registered as a Codex MCP server, and its recorder
does not understand Codex hook envelopes. Codex work therefore does not enter the local
PatchMesh ledger, and Codex cannot query the ledger through MCP.

## Goals

- Record Codex tool activity in the repository's PatchMesh ledger.
- Expose the existing PatchMesh MCP tools to Codex.
- Preserve all existing Knowl hooks and their ordering.
- Keep recording fail-open: PatchMesh failure must not fail a Codex action.
- Reuse the existing journal, redaction, ingest, gateway, and query paths.
- Keep event schemas and core detection logic unchanged.

## Non-goals

- Recording hidden model reasoning or full prompts/responses.
- Intercepting or blocking Codex tool calls.
- Replacing Knowl hooks.
- Adding a daemon, queue, or new transport.
- Claiming filesystem-effect coverage beyond what Codex hooks actually expose.

## Design

### MCP registration

Register one stdio server named `patchmesh` in the Codex configuration. It launches the
existing `packages/gateway/dist/bin.js` (or the installed `patchmesh-mcp` binary) with the
current worktree as its root. The gateway remains the sole MCP implementation; no Codex-
specific query code is added.

### Codex hook relay

Add a small runtime adapter under `packages/recorder` that accepts Codex hook JSON on
stdin, selects only tool lifecycle events, and translates them to the recorder's existing
Claude-shaped journal envelope:

- Codex session/run identity → `session_id`.
- Codex tool identity/name/input/result → `tool_use_id`, `tool_name`, `tool_input`,
  `tool_response`.
- Codex working directory → `cwd`.
- Hook event → `hook_event_name` (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, or
  `Stop`) when the host exposes an equivalent.
- `patchmesh_host: "codex"` stamps provenance before redaction.

Unknown or unsupported Codex hook events are ignored and exit zero. The relay never writes
the journal directly; it invokes the production recorder binary so redaction, advisory
behavior, journal locking, and future recorder fixes stay in one path.

### Hook wiring

Extend `.codex/hooks.json` additively. Existing Knowl entries remain unchanged; PatchMesh
entries run beside them for the supported Codex lifecycle events. Session termination invokes
the existing ingest binary so pending journal entries reach the SQLite ledger.

The adapter must preserve Codex's hook stdout contract. Recorder diagnostics go to stderr;
any PatchMesh advisory is emitted only when the Codex event supports a non-blocking context
channel. No advisory may alter the observed tool result.

### Failure and security behavior

- Invalid JSON, unsupported shapes, missing identity, missing worktree, and recorder errors
  fail open and return zero.
- Input passes through the existing whitelist redactor before the first journal write.
- Prompts, responses, credentials, and hidden reasoning are not copied wholesale.
- Codex-specific identity is treated as untrusted host metadata; no identity is inferred from
  transcript text or filesystem paths.
- Unsupported event classes are reported as degraded observability, not silently described as
  complete coverage.

## Data flow

```text
Codex hook
  → Codex relay
  → existing patchmesh-record
  → redacted journal.ndjson
  → existing patchmesh-ingest on Stop
  → SQLite ledger
  → existing PatchMesh MCP gateway
```

## Validation

- Unit tests for Codex envelope parsing, identity extraction, tool normalization, and
  unsupported-event handling.
- Recorder integration test proving a Codex-shaped payload produces a valid event pair with
  `source_codex_hook` provenance and survives ingest.
- Hook configuration test proving Knowl entries remain and PatchMesh entries are additive.
- MCP handshake test proving the `patchmesh` server exposes the existing tool set.
- Run focused recorder/CLI tests, then the repository's `pnpm check`.

## Known ceiling

Codex hook payloads do not necessarily expose a distinct pre-tool event, post-tool result,
subagent identity, or filesystem effect for every action. The adapter records only fields
actually present and leaves the resulting coverage degraded where evidence is absent.
