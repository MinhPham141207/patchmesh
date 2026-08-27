import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = readFileSync(new URL("../../../.codex/config.toml", import.meta.url), "utf8");
const hooks = JSON.parse(readFileSync(new URL("../../../.codex/hooks.json", import.meta.url), "utf8")) as {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
};

function commands(event: string): string[] {
  return (hooks.hooks?.[event] ?? []).flatMap((entry) => (entry.hooks ?? []).flatMap((hook) => hook.command ?? []));
}

test("Codex config preserves Knowl and adds PatchMesh recording", () => {
  assert.match(config, /\[mcp_servers\.knowl\]/u);
  assert.match(config, /\[mcp_servers\.patchmesh\]/u);
  assert.match(config, /command = "node"/u);
  assert.match(config, /D:\/patchmesh\/packages\/gateway\/dist\/bin\.js/u);
  assert.match(config, /args = \[ "D:\/patchmesh\/packages\/gateway\/dist\/bin\.js", "D:\/patchmesh" \]/u);

  assert.ok(commands("SessionStart").includes("knowl.cmd agent-hook codex SessionStart --json"));
  assert.ok(commands("PostToolUse").includes("knowl.cmd agent-hook codex PostToolUse --json"));
  assert.ok(commands("PostToolUseFailure").includes("knowl.cmd agent-hook codex PostToolUseFailure --json"));
  assert.ok(commands("Stop").includes("knowl.cmd agent-hook codex Stop --json"));

  const relay = "node D:/patchmesh/packages/recorder/dist/codex-relay.js";
  assert.ok(commands("PostToolUse").includes(`${relay} PostToolUse`));
  assert.ok(commands("PostToolUseFailure").includes(`${relay} PostToolUseFailure`));
  const ingest = "node D:/patchmesh/packages/recorder/dist/ingest-bin.js D:/patchmesh";
  assert.ok(commands("Stop").includes(ingest));
  assert.ok(commands("SessionEnd").includes(ingest));
});
