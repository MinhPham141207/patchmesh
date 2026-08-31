import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendJournalEntry, journalPathFor } from "patchmesh-recorder";

const OTHER_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-contention-check-"));
  mkdirSync(join(root, ".patchmesh"));
  mkdirSync(join(root, ".git"));
  return root;
}

async function callTool(
  root: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(process.cwd(), "dist", "bin.js"), root],
  });
  const client = new Client({ name: "contention-check-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return (result.content as { type: string; text: string }[])[0]!.text;
  } finally {
    await client.close();
  }
}

test("patchmesh_contention_check is registered as an MCP tool", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const root = tmpDir();
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: [join(process.cwd(), "dist", "bin.js"), root],
    });
    const client = new Client({ name: "contention-check-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert.ok(names.includes("patchmesh_contention_check"), `expected tool in list: ${names.join(", ")}`);
    } finally {
      await client.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchmesh_contention_check returns in-flight calls from other agents", async () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_other_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.ts" },
    }, new Date().toISOString());

    const text = await callTool(root, "patchmesh_contention_check", { path: "src/auth.ts" });
    assert.ok(text.includes("src/auth.ts"), `expected path in output: ${text}`);
    assert.ok(!text.includes("No agents currently modifying"), `expected contention found: ${text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchmesh_contention_check reports no contention for an unmodified path", async () => {
  const root = tmpDir();
  try {
    const text = await callTool(root, "patchmesh_contention_check", { path: "src/clean.ts" });
    assert.ok(text.includes("No agents currently modifying"), `expected no contention: ${text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchmesh_contention_check excludes own agent's calls", async () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OWN_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_own_1",
      tool_name: "Edit",
      tool_input: { file_path: "src/self.ts" },
    }, new Date().toISOString());

    const text = await callTool(root, "patchmesh_contention_check", {
      path: "src/self.ts",
      excludeAgentId: "agent_3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
    });
    assert.ok(text.includes("No agents currently modifying"), `expected own call excluded: ${text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchmesh_contention_check matches by operation (command) when file_path is absent", async () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_cmd_1",
      tool_name: "Bash",
      tool_input: { command: "pnpm check" },
    }, new Date().toISOString());

    const text = await callTool(root, "patchmesh_contention_check", { path: "pnpm check" });
    assert.ok(!text.includes("No agents currently modifying"), `expected contention for command: ${text}`);
    assert.ok(text.includes("pnpm check"), `expected operation in output: ${text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchmesh_contention_check excludes its own calls by session id", async () => {
  const root = tmpDir();
  try {
    appendJournalEntry(journalPathFor(root, ".patchmesh"), {
      session_id: OTHER_SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_other_2",
      tool_name: "Edit",
      tool_input: { file_path: "src/shared.ts" },
    }, new Date().toISOString());

    const otherAgentId = "agent_7a1033a6-93c4-46e2-a83c-c471f26765c2";
    const text = await callTool(root, "patchmesh_contention_check", {
      path: "src/shared.ts",
      excludeAgentId: otherAgentId,
    });
    assert.ok(text.includes("No agents currently modifying"), `expected other agent excluded: ${text}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
