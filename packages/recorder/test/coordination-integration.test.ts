import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimFile, readActiveClaims, claimsDirectory, cleanupExpiredClaims } from "../src/claims.js";
import {
  MAX_RETRIES,
  incrementRetry,
  readRetryState,
  shouldAllow,
  cleanupRetryFiles,
} from "../src/leader.js";
import { agentIdForSession } from "../src/identity.js";
import { emitAdvisory, emitPostWriteAdvisory } from "../src/bin.js";
import { PENDING_DIR } from "../src/sidecar.js";

function worktree(): string {
  const root = join(tmpdir(), `patchmesh-coord-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root);
  return root;
}

function preToolUsePayload(filePath: string, sessionId?: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: `tu_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    session_id: sessionId ?? `sess_${Math.random().toString(36).slice(2)}`,
    tool_input: { file_path: filePath },
  };
}

function postToolUsePayload(filePath: string, toolName = "Edit", sessionId?: string): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_use_id: `tu_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    session_id: sessionId ?? `sess_${Math.random().toString(36).slice(2)}`,
    tool_input: { file_path: filePath },
  };
}

function captureStdout(fn: () => void): string {
  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout;
}

test("PreToolUse denies on contention when retry < MAX_RETRIES", () => {
  const root = worktree();
  try {
    // Agent A claims src/auth.ts
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/auth.ts"] });

    // Agent B tries to edit src/auth.ts
    const payload = preToolUsePayload("src/auth.ts");

    const stdout = captureStdout(() => emitAdvisory(root, payload));

    // Should have denied
    assert.ok(stdout.includes('"permissionDecision":"deny"'), `Expected deny in output: ${stdout}`);
    assert.ok(stdout.includes("Contention detected"), `Expected contention message: ${stdout}`);
    assert.ok(stdout.includes("Retry 1/3"), `Expected retry count: ${stdout}`);

    // Retry state should be incremented for the agent derived from session_id
    const sessionId = payload.session_id as string;
    const agentId = agentIdForSession(sessionId);
    const retryState = readRetryState({ worktreeRoot: root, path: "src/auth.ts", agentId });
    assert.ok(retryState !== null);
    assert.equal(retryState!.retryCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse allows when retry >= MAX_RETRIES (fail-open)", () => {
  const root = worktree();
  try {
    // Agent A claims src/auth.ts
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/auth.ts"] });

    // Agent B has already retried MAX_RETRIES times
    const agentId = "test_agent_b";
    for (let i = 0; i < MAX_RETRIES; i++) {
      incrementRetry({ worktreeRoot: root, path: "src/auth.ts", agentId });
    }

    // Verify shouldAllow returns true
    assert.equal(shouldAllow({ worktreeRoot: root, path: "src/auth.ts", agentId }), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse allows when no contention exists", () => {
  const root = worktree();
  try {
    const payload = preToolUsePayload("src/clean.ts");
    const stdout = captureStdout(() => emitAdvisory(root, payload));

    // Should not have denied (no output means allow)
    assert.ok(!stdout.includes("deny"), `Expected no deny: ${stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse auto-releases claims for Edit tool", () => {
  const root = worktree();
  try {
    const filePath = "src/release.ts";
    const sessionId = "release_session";

    // Create a claim using the agentId derived from session_id
    const actualAgentId = agentIdForSession(sessionId);
    claimFile({ worktreeRoot: root, agentId: actualAgentId, paths: [filePath] });
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1);

    // Simulate PostToolUse for Edit
    const payload = postToolUsePayload(filePath, "Edit", sessionId);
    emitPostWriteAdvisory(root, payload);

    // Claim should be released
    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 0, "Claim should be released after Edit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse auto-releases claims for Write tool", () => {
  const root = worktree();
  try {
    const filePath = "src/write.ts";
    const sessionId = "write_session";

    const actualAgentId = agentIdForSession(sessionId);
    claimFile({ worktreeRoot: root, agentId: actualAgentId, paths: [filePath] });
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1);

    // Simulate PostToolUse for Write
    const payload = postToolUsePayload(filePath, "Write", sessionId);
    emitPostWriteAdvisory(root, payload);

    // Claim should be released
    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 0, "Claim should be released after Write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse does not release claims for Bash tool", () => {
  const root = worktree();
  try {
    const agentId = "agent_bash";
    const filePath = "src/bash.ts";

    // Create a claim
    claimFile({ worktreeRoot: root, agentId, paths: [filePath] });
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1);

    // Simulate PostToolUse for Bash
    const payload = postToolUsePayload(filePath, "Bash");
    emitPostWriteAdvisory(root, payload);

    // Claim should still exist (Bash doesn't auto-release)
    const active = readActiveClaims({ worktreeRoot: root });
    assert.equal(active.length, 1, "Claim should not be released for Bash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionEnd cleans up expired claims and retry files", () => {
  const root = worktree();
  try {
    const claimsDir = claimsDirectory(root);
    mkdirSync(claimsDir, { recursive: true });

    // Create expired claim
    writeFileSync(
      join(claimsDir, "agent_expired.json"),
      JSON.stringify({
        agentId: "agent_expired",
        paths: ["old.ts"],
        started: "2026-01-01T00:00:00Z",
        expires: "2026-01-01T00:00:01Z",
      }),
    );

    // Create active claim
    claimFile({ worktreeRoot: root, agentId: "agent_active", paths: ["active.ts"] });

    // Create stale retry file in the correct directory (cleanupRetryFiles looks in .patchmesh/pending)
    const retryDir = join(root, ".patchmesh", "pending");
    mkdirSync(retryDir, { recursive: true });
    writeFileSync(
      join(retryDir, "retry_stale.json"),
      JSON.stringify({
        path: "src/stale.ts",
        agentId: "agent_old",
        retryCount: 1,
        lastDeniedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      }),
    );

    // Verify before cleanup
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1);
    assert.ok(existsSync(join(retryDir, "retry_stale.json")));

    // Call cleanup functions directly (as emitSessionEndCleanup would)
    cleanupExpiredClaims({ worktreeRoot: root });
    cleanupRetryFiles({ worktreeRoot: root });

    // Verify after cleanup
    assert.equal(readActiveClaims({ worktreeRoot: root }).length, 1, "Active claim should remain");
    assert.ok(!existsSync(join(retryDir, "retry_stale.json")), "Stale retry should be removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse deny output includes correct hookEventName", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/test.ts"] });

    const payload = preToolUsePayload("src/test.ts");
    const stdout = captureStdout(() => emitAdvisory(root, payload));

    // Verify JSON structure
    const output = JSON.parse(stdout.trim());
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(typeof output.hookSpecificOutput.permissionDecisionReason === "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse writes sidecar for PostToolUse on deny", () => {
  const root = worktree();
  try {
    claimFile({ worktreeRoot: root, agentId: "agent_a", paths: ["src/sidecar.ts"] });

    const toolUseId = `tu_sidecar_${Date.now()}`;
    const payload = {
      ...preToolUsePayload("src/sidecar.ts"),
      tool_use_id: toolUseId,
    };

    captureStdout(() => emitAdvisory(root, payload));

    // Sidecar should exist
    const pendingDir = join(root, ".patchmesh", PENDING_DIR);
    const sidecarFiles = readdirSync(pendingDir).filter((f) => f.endsWith(".json") && !f.startsWith("retry_"));
    assert.ok(sidecarFiles.length > 0, "Sidecar should be written for PostToolUse");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
