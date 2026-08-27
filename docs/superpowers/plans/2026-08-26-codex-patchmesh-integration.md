# Codex–PatchMesh Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Record Codex hook activity in PatchMesh and expose the existing PatchMesh MCP gateway to Codex.

**Architecture:** Add a thin `codex` host adapter that parses Codex hook envelopes into the existing `HostRecord` shape and normalizes only observed tool names. Add a fail-open relay entrypoint that translates supported Codex hook payloads to the existing redacted recorder path. Keep MCP and lifecycle wiring local in `.codex`; preserve Knowl entries.

**Tech Stack:** TypeScript, Node built-ins, existing `packages/recorder` host registry/journal/ingest, Codex TOML/JSON configuration, Node test runner.

---

### Task 1: Codex host adapter

**Files:**
- Create: `packages/recorder/src/hosts/codex.ts`
- Modify: `packages/recorder/src/hosts/types.ts`
- Modify: `packages/recorder/src/hosts/index.ts`
- Modify: `packages/recorder/src/redact.ts`
- Modify: `packages/recorder/src/index.ts`
- Test: `packages/recorder/test/hosts.test.ts`

- [ ] **Step 1: Write failing parser and mapping tests**

Cover a Codex post-tool envelope using `session_id`/`conversation_id`/`thread_id`, `turn_id`/`generation_id`, `tool_name`/`toolName`, `tool_input`/`toolInput`, `tool_response`/`toolResponse`, and `cwd`; assert `read_file`, `apply_patch`, and `shell` normalize to `read_file`, `edit_file`, and `run_shell`. Assert unsupported lifecycle payloads return `null`.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern=Codex`

Expected: FAIL because `codexAdapter` and `HostId` support are absent.

- [ ] **Step 3: Implement the minimum adapter and registry wiring**

Parse only object envelopes with a non-empty session identity and tool identity. Prefer post-tool result fields; map `PreToolUse` to `pre`, `PostToolUse`/`PostToolUseFailure` to `post`, and ignore session/compaction/subagent lifecycle events. Preserve host-declared IDs without deriving identity from transcript text. Register `codex` as an observed-tier host, add its source provenance, and whitelist any translated fields required by the existing redactor.

- [ ] **Step 4: Run focused recorder tests**

Run: `corepack pnpm --filter patchmesh-recorder test`

Expected: PASS, including existing Claude/OpenCode host tests.

### Task 2: Codex hook relay

**Files:**
- Create: `packages/recorder/src/codex-relay.ts`
- Modify: `packages/recorder/src/index.ts`
- Modify: `packages/recorder/package.json`
- Test: `packages/recorder/test/codex.test.ts`

- [ ] **Step 1: Write failing relay tests**

Assert valid Codex tool payloads translate to the Claude-shaped fields consumed by `bin.js`, stamp `patchmesh_host: "codex"`, preserve `cwd`, and invoke the production recorder command. Assert unsupported events, malformed JSON, missing worktree identity, and recorder errors return exit code `0` without stdout diagnostics.

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern=relay`

Expected: FAIL because the relay entrypoint does not exist.

- [ ] **Step 3: Implement fail-open relay**

Read bounded stdin with Node built-ins, parse one JSON envelope, translate only supported Codex hook events, spawn `node dist/bin.js --host codex` with the translated JSON, forward no recorder stdout to Codex, and send diagnostics only to stderr when `PATCHMESH_RECORDER_DEBUG` is set. Export pure translation helpers for tests.

- [ ] **Step 4: Run the relay and recorder tests**

Run: `corepack pnpm --filter patchmesh-recorder test`

Expected: PASS.

### Task 3: Local Codex wiring

**Files:**
- Modify: `.codex/config.toml`
- Modify: `.codex/hooks.json`
- Test: `packages/recorder/test/codex-config.test.ts`

- [ ] **Step 1: Write failing configuration-preservation tests**

Parse both files and assert the existing Knowl commands remain. Assert `mcp_servers.patchmesh` runs `node D:/patchmesh/packages/gateway/dist/bin.js D:/patchmesh`. Assert PatchMesh commands are additive for `PostToolUse`, `PostToolUseFailure`, `Stop`, and `SessionEnd`.

- [ ] **Step 2: Run the configuration test and observe the expected failure**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern=configuration`

Expected: FAIL because the local Codex entries are absent.

- [ ] **Step 3: Add the minimal TOML/JSON entries**

Keep Knowl hook objects unchanged. Add the relay command beside Knowl for tool lifecycle events and `node D:/patchmesh/packages/recorder/dist/ingest-bin.js D:/patchmesh` for `Stop`/`SessionEnd`. Add the stdio MCP server block without changing gateway code.

- [ ] **Step 4: Run the configuration test**

Run: `corepack pnpm --filter patchmesh-recorder test -- --test-name-pattern=configuration`

Expected: PASS.

### Task 4: Build and live checks

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-codex-patchmesh-integration-design.md` only if implementation limits differ materially.

- [ ] **Step 1: Build recorder and gateway**

Run: `corepack pnpm --filter patchmesh-recorder --filter patchmesh-gateway build`

Expected: exit code `0`.

- [ ] **Step 2: Verify a Codex-shaped payload reaches the ledger**

Use a temporary git worktree, run the built relay with a representative `PostToolUse` payload, run `patchmesh-ingest`, then validate the resulting event set and assert `source_codex_hook` provenance.

- [ ] **Step 3: Verify MCP registration and handshake**

Run: `codex mcp list` and a stdio initialize/tools-list check against `node D:/patchmesh/packages/gateway/dist/bin.js D:/patchmesh`.

- [ ] **Step 4: Run the repository checks**

Run: `corepack pnpm check`

Expected: exit code `0`; report any unrelated pre-existing failure explicitly.
