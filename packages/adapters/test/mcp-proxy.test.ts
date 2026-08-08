import assert from "node:assert/strict";
import { test } from "node:test";
import {
  McpProxy,
  type EventAppender,
  type McpCallContext,
  type McpToolCall,
} from "../src/index.js";

test("exposes the M3 proxy contract", async () => {
  const events: unknown[] = [];
  const eventStore: EventAppender = {
    append(input) {
      events.push(input);
      return { status: "inserted", event: input as never };
    },
  };
  const call: McpToolCall = {
    toolName: "read_file",
    operation: "read_file",
    targetResourceId: null,
    opaque: false,
  };
  const context: McpCallContext = {
    source: { kind: "adapter", sourceId: "mcp", instanceId: "instance-1" },
    repositoryId: "repo_demo",
    workspaceId: "ws_demo",
    worktreeId: "wt_demo",
    agentId: null,
    taskId: null,
    correlationId: "corr_call",
    causationId: null,
    requestSourceSequence: 1,
    completionSourceSequence: 2,
  };

  const result = await new McpProxy({ eventStore }).execute(
    call,
    context,
    async () => ({ outcome: "succeeded", value: "ok", exitCode: 0 }),
  );

  assert.equal(result.execution.outcome, "succeeded");
  assert.equal(events.length, 2);
});
