import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateEventSet } from "@patchmesh/protocol";
import { SqliteEventStore } from "@patchmesh/storage";
import {
  appendJournalEntry,
  buildHookEvents,
  ingestJournal,
  journalPathFor,
  redactHookPayload,
  resolveAttribution,
  subagentIdFor,
  taskIdForDelegate,
} from "../src/index.js";

const SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const DELEGATE = "a79bd1f2dafad824a";

function temporaryWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-attribution-"));
  mkdirSync(join(root, ".git"));
  return root;
}

test("a call the host stamped with an agent belongs to that agent", () => {
  const attribution = resolveAttribution({
    sessionId: SESSION,
    hostToolName: "Read",
    agentId: DELEGATE,
    spawnedAgentId: null,
  });
  assert.equal(attribution.agentId, subagentIdFor(SESSION, DELEGATE));
  assert.equal(attribution.taskId, taskIdForDelegate(DELEGATE));
  assert.notEqual(attribution.agentId, `agent_${SESSION}`);
});

test("the spawning call stays the parent's work but opens the subagent's task", () => {
  const attribution = resolveAttribution({
    sessionId: SESSION,
    hostToolName: "Agent",
    agentId: null,
    spawnedAgentId: DELEGATE,
  });
  assert.equal(attribution.agentId, `agent_${SESSION}`, "the parent issued the spawn");
  assert.equal(attribution.taskId, taskIdForDelegate(DELEGATE), "and it joins the subagent's stream");
});

test("an ordinary session call carries the session agent and no task", () => {
  const attribution = resolveAttribution({
    sessionId: SESSION,
    hostToolName: "Read",
    agentId: null,
    spawnedAgentId: null,
  });
  assert.equal(attribution.agentId, `agent_${SESSION}`);
  assert.equal(attribution.taskId, null);
});

test("two concurrent subagents of one type are distinct agents under distinct tasks", () => {
  // Both ids are real values observed from two Explore subagents spawned in one turn.
  const a = resolveAttribution({ sessionId: SESSION, hostToolName: "Bash", agentId: "a79bd1f2dafad824a", spawnedAgentId: null });
  const b = resolveAttribution({ sessionId: SESSION, hostToolName: "Bash", agentId: "aa7466e5435cd301e", spawnedAgentId: null });
  assert.notEqual(a.agentId, b.agentId);
  assert.notEqual(a.taskId, b.taskId);
  // Both still name the session in their readable prefix, so a family stays groupable.
  assert.ok(a.agentId!.startsWith(`agent_${SESSION.slice(0, 8)}.sub.`));
});

test("the redactor keeps the two identifiers the link is made of", () => {
  // Shapes taken from real payloads: `agent_id` on a subagent's call, `agentId` on the
  // spawn's response - alongside the response fields that must never be stored.
  const child = redactHookPayload({
    session_id: SESSION,
    tool_name: "Bash",
    tool_use_id: "toolu_x",
    agent_id: DELEGATE,
    agent_type: "Explore",
    tool_input: { command: "echo hi" },
    tool_response: { stdout: "hi", is_error: false },
  })!;
  assert.equal(child["agent_id"], DELEGATE);
  assert.equal(child["agent_type"], "Explore");
  assert.ok(!JSON.stringify(child).includes('"stdout"'));

  const spawn = redactHookPayload({
    session_id: SESSION,
    tool_name: "Agent",
    tool_use_id: "toolu_spawn",
    tool_input: { description: "probe", subagent_type: "Explore", prompt: "SECRET PROMPT BODY" },
    tool_response: { agentId: DELEGATE, agentType: "Explore", content: "SUBAGENT OUTPUT", totalTokens: 42 },
  })!;
  const response = spawn["tool_response"] as Record<string, unknown>;
  assert.equal(response["agentId"], DELEGATE);
  const serialized = JSON.stringify(spawn);
  assert.ok(!serialized.includes("SECRET PROMPT BODY"), "the spawn prompt must not be stored");
  assert.ok(!serialized.includes("SUBAGENT OUTPUT"), "the subagent's output must not be stored");
});

test("the spawn is recorded as spawn_subagent under both host names", () => {
  const root = temporaryWorktree();
  try {
    for (const hostToolName of ["Agent", "Task"]) {
      const { requested } = buildHookEvents({
        payload: {
          session_id: SESSION,
          tool_name: hostToolName,
          tool_input: { description: "probe", subagent_type: "Explore" },
          tool_response: { agentId: DELEGATE },
        },
        worktreeRoot: root,
      });
      assert.equal((requested.payload as { toolName: string }).toolName, "spawn_subagent", hostToolName);
      assert.equal(requested.taskId, taskIdForDelegate(DELEGATE), hostToolName);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ingest separates a subagent's work from its parent's end to end", () => {
  const root = temporaryWorktree();
  try {
    const journalPath = journalPathFor(root, ".patchmesh");
    // The order real traffic arrives in: a subagent's calls complete, then the spawn that
    // created it, because PostToolUse fires when a call finishes.
    const calls: Record<string, unknown>[] = [
      { tool_name: "Read", tool_input: { file_path: "src/server.ts" }, tool_response: {} },
      { tool_name: "Edit", tool_input: { file_path: "src/auth.ts" }, tool_response: {}, agent_id: DELEGATE, agent_type: "Explore" },
      { tool_name: "Agent", tool_input: { description: "probe" }, tool_response: { agentId: DELEGATE } },
    ];
    for (const call of calls) {
      appendJournalEntry(journalPath, { session_id: SESSION, ...call }, "2026-08-21T12:00:00.000Z");
    }

    const ledgerPath = join(root, ".patchmesh", "ledger.db");
    assert.equal(ingestJournal({ worktreeRoot: root, journalPath, ledgerPath }).ingested, 3);

    const store = SqliteEventStore.open(ledgerPath);
    try {
      const events = store.read();
      assert.deepEqual(validateEventSet(events), []);
      const byHostTool = new Map(
        events
          .filter((event) => event.eventType === "tool.requested")
          .map((event) => [(event.payload as { hostToolName: string }).hostToolName, event]),
      );

      const childAgent = subagentIdFor(SESSION, DELEGATE);
      const task = taskIdForDelegate(DELEGATE);

      assert.equal(byHostTool.get("Read")!.agentId, `agent_${SESSION}`);
      assert.equal(byHostTool.get("Read")!.taskId, null);

      assert.equal(byHostTool.get("Agent")!.agentId, `agent_${SESSION}`);
      assert.equal(byHostTool.get("Agent")!.taskId, task);

      // The point of the whole exercise: the subagent's edit is not the session's edit.
      assert.equal(byHostTool.get("Edit")!.agentId, childAgent);
      assert.equal(byHostTool.get("Edit")!.taskId, task);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
