import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeToolFor, parseForHost, resolveHostAdapter, tierForSourceId } from "../src/hosts/index.js";
import { normalizeTool } from "../src/tool-mapping.js";

const opencodeCaptures = JSON.parse(
  readFileSync(new URL("./fixtures/opencode/captured-parts.json", import.meta.url), "utf8"),
) as Array<{ sessionId: string; envelope: Record<string, unknown> }>;

test("unknown host falls back to claude-code", () => {
  assert.equal(resolveHostAdapter("nonsense").id, "claude-code");
});

test("generic-mcp resolves as a declared-tier adapter that owns no hook envelopes", () => {
  const generic = resolveHostAdapter("generic-mcp");
  assert.equal(generic.id, "generic-mcp");
  assert.equal(generic.tier, "declared");
  assert.equal(
    generic.parse({
      session_id: "s1", hook_event_name: "PostToolUse",
      tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: {},
    }),
    null, // gateway-recorded participation never arrives as a host hook envelope
  );
});

test("tiers resolve from recorded source ids", () => {
  assert.equal(tierForSourceId("source_claude_code_hook"), "observed");
  assert.equal(tierForSourceId("source_opencode_hook"), "observed");
  assert.equal(tierForSourceId("source_generic_mcp"), "declared");
  assert.equal(tierForSourceId("source_unknown_thing"), null);
});

test("claude adapter parses its own envelope and rejects others", () => {
  const claude = resolveHostAdapter("claude-code");
  const record = claude.parse({
    session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: {},
  });
  assert.equal(record?.hostToolName, "Edit");
  assert.equal(claude.parse({ tool: "edit" }), null); // an OpenCode-shaped envelope is not Claude's
});

test("claude tool mapping is unchanged after extraction", () => {
  assert.equal(normalizeTool("Edit", null).toolName, "edit_file");
  assert.equal(normalizeTool("Bash", "git commit -m x").toolName, "git_commit");
});

test("opencode adapter parses every real captured envelope and claude claims none", () => {
  const opencode = resolveHostAdapter("opencode");
  assert.equal(opencode.id, "opencode");
  assert.equal(opencode.tier, "observed");
  const claude = resolveHostAdapter("claude-code");
  assert.ok(opencodeCaptures.length > 0);
  for (const capture of opencodeCaptures) {
    const record = opencode.parse(capture.envelope);
    assert.notEqual(record, null);
    assert.equal(record!.sessionId, capture.sessionId); // identity comes from `sessionID`
    assert.equal(record!.stage, "post"); // captures are rendered in tool.execute.after shape
    assert.equal(record!.delegateId, capture.envelope["callID"]); // per-call attribution
    assert.equal(claude.parse(capture.envelope), null); // Claude does not claim OpenCode envelopes
  }
});

test("opencode adapter rejects envelopes that are not its shape", () => {
  const opencode = resolveHostAdapter("opencode");
  // A Claude-shaped envelope is not OpenCode's.
  assert.equal(
    opencode.parse({
      session_id: "s1", hook_event_name: "PostToolUse",
      tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: {},
    }),
    null,
  );
  // Neither a record without the identifying fields...
  assert.equal(opencode.parse({ type: "tool.execute.after" }), null);
  // ...nor a bash call whose `sessionID` is missing.
  assert.equal(opencode.parse({ type: "tool.execute.after", tool: "bash", input: { command: "ls" } }), null);
});

test("opencode tool table maps the closed vocabulary from the captured names", () => {
  assert.equal(normalizeToolFor("opencode", "bash", "git commit -m x").toolName, "git_commit");
  assert.equal(normalizeToolFor("opencode", "bash", "echo hi").toolName, "run_shell");
  assert.equal(normalizeToolFor("opencode", "edit", null).toolName, "edit_file");
  assert.equal(normalizeToolFor("opencode", "edit", null).pathProperty, "filePath");
  assert.equal(normalizeToolFor("opencode", "write", null).toolName, "edit_file");
  assert.equal(normalizeToolFor("opencode", "write", null).pathProperty, "filePath");
  for (const read of ["read", "grep", "glob"]) {
    assert.equal(normalizeToolFor("opencode", read, null).toolName, "read_file");
  }
  assert.deepEqual(normalizeToolFor("opencode", "something-unknown", null), {
    toolName: "other", pathProperty: null, opaque: true,
  });
});

test("parsing for a host follows envelope shape without giving up provenance or fail-loud", () => {
  const claudeShaped = {
    session_id: "s1", hook_event_name: "PostToolUse",
    tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: {},
  };
  // The OpenCode integration journals Claude-hook-shaped translated payloads, so they must
  // still parse when the provenance host is opencode...
  assert.equal(parseForHost("opencode", claudeShaped)?.hostToolName, "Edit");
  // ...while an OpenCode-shaped envelope parses under its own host.
  assert.equal(
    parseForHost("opencode", opencodeCaptures[0]!.envelope)?.hostToolName,
    opencodeCaptures[0]!.envelope["tool"],
  );
  // A declared-tier host owns no envelopes: nothing is parsed on its behalf.
  assert.equal(parseForHost("generic-mcp", claudeShaped), null);
});
