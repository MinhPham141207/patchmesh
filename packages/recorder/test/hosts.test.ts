import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHostAdapter, tierForSourceId } from "../src/hosts/index.js";
import { normalizeTool } from "../src/tool-mapping.js";

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
