import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  agentIdForSession,
  appendJournalEntry,
  computeContentionAdvisory,
  computePostWriteAdvisory,
  computeTurnStartAdvisory,
  journalPathFor,
} from "../src/index.js";
import { emitAdvisory, emitPostWriteAdvisory, emitTurnStartAdvisory } from "../src/bin.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const OTHER_SESSION = "7a1033a6-93c4-46e2-a83c-c471f26765c2";
const OWN_SESSION = "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17";
const NOW = () => new Date("2026-08-24T12:00:30.000Z");

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-advisory-"));
  mkdirSync(join(root, ".git"));
  return root;
}

/** Seed the journal with an in-flight (started, unfinished) call from some session. */
function seedInFlight(
  root: string,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  at: string,
): void {
  appendJournalEntry(
    journalPathFor(root, ".patchmesh"),
    {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_use_id: `call_${sessionId}_${at}`,
      tool_name: toolName,
      tool_input: toolInput,
    },
    at,
  );
}

/** Seed the journal with a completed (PostToolUse) write from some session. */
function seedWrite(root: string, session: string, path: string, at: string): void {
  appendJournalEntry(
    journalPathFor(root, ".patchmesh"),
    {
      hook_event_name: "PostToolUse",
      session_id: session,
      tool_name: "Edit",
      tool_use_id: `done-${Math.random()}`,
      tool_input: { file_path: path },
      tool_response: {},
    },
    at,
  );
}

function preToolUsePayload(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_use_id: "call_current",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function postToolUsePayload(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_use_id: "call_current",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: {},
  };
}

test("fires on genuine cross-agent contention: a different agent's in-flight Edit on the same path", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-24T12:00:00.000Z");

    const advisory = computeContentionAdvisory({
      worktreeRoot: root,
      payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
      now: NOW,
    });

    assert.notEqual(advisory, null);
    assert.equal(advisory!.path, "src/shared.ts");
    assert.equal(advisory!.hostToolName, "Edit");
    assert.equal(advisory!.runningForMs, 30_000);
    assert.equal(advisory!.agentId, agentIdForSession(OTHER_SESSION));
    // Says what was observed, not what it concludes: no "conflict", states the call is still
    // running and names how long, and disclaims that same file does not mean same work.
    assert.match(advisory!.message, /has a call in flight/u);
    assert.match(advisory!.message, /30s ago/u);
    assert.match(advisory!.message, /Same file does not mean same work/u);
    assert.doesNotMatch(advisory!.message, /conflict/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fires on Write the same way it fires on Edit", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Write", { file_path: "src/new.ts" }, "2026-08-24T12:00:20.000Z");

    const advisory = computeContentionAdvisory({
      worktreeRoot: root,
      payload: preToolUsePayload(OWN_SESSION, "Write", { file_path: "src/new.ts" }),
      now: NOW,
    });

    assert.notEqual(advisory, null);
    assert.equal(advisory!.hostToolName, "Write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not fire for the agent's own in-flight calls", () => {
  const root = worktree();
  try {
    // The same session already has an unfinished call on this path (e.g. a subagent's call,
    // or this bin.ts invocation's own just-journalled entry).
    seedInFlight(root, OWN_SESSION, "Edit", { file_path: "src/mine.ts" }, "2026-08-24T12:00:00.000Z");

    const advisory = computeContentionAdvisory({
      worktreeRoot: root,
      payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/mine.ts" }),
      now: NOW,
    });

    assert.equal(advisory, null, "an agent must not rediscover its own in-flight work as a collision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not fire on opaque Bash, even when another agent is genuinely contending on the path", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-24T12:00:00.000Z");

    // Bash never carries a reliable path (the M7 ban on inferring one from command text), so
    // it must be treated as unknown even when the command text happens to name the contested
    // file verbatim.
    const advisory = computeContentionAdvisory({
      worktreeRoot: root,
      payload: preToolUsePayload(OWN_SESSION, "Bash", { command: "cat src/shared.ts" }),
      now: NOW,
    });

    assert.equal(advisory, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not fire outside PreToolUse, and does not fire without a declared path", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-24T12:00:00.000Z");

    assert.equal(
      computeContentionAdvisory({
        worktreeRoot: root,
        payload: { ...preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }), hook_event_name: "PostToolUse" },
        now: NOW,
      }),
      null,
    );
    assert.equal(
      computeContentionAdvisory({
        worktreeRoot: root,
        payload: preToolUsePayload(OWN_SESSION, "Edit", {}),
        now: NOW,
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thrown advisory does not propagate: emitAdvisory swallows it and returns normally", () => {
  const throwing: typeof computeContentionAdvisory = () => {
    throw new Error("boom");
  };
  // Must not throw. This is the guarantee `bin.ts` relies on to keep the journal write, which
  // always runs before `emitAdvisory` is called, from ever being undone by an advisory failure.
  assert.doesNotThrow(() => emitAdvisory("/does/not/matter", { hook_event_name: "PreToolUse" }, throwing));
});

test("end to end: the hook binary still journals the call when the advisory path fails or finds nothing", () => {
  const root = worktree();
  try {
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/solo.ts" })),
      cwd: root,
      encoding: "utf8",
    });
    // No contention was seeded, so nothing is printed -- silence is the common case.
    assert.equal(output, "");
    const journalled = readFileSync(journalPathFor(root, ".patchmesh"), "utf8");
    assert.match(journalled, /src\/solo\.ts|solo\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: the hook binary emits a non-blocking allow with the advisory reason on genuine contention", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, new Date().toISOString());

    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" })),
      cwd: root,
      encoding: "utf8",
    });

    assert.notEqual(output.trim(), "");
    const parsed = JSON.parse(output.trim()) as {
      hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    // Non-blocking: "allow" is the only permissionDecision this binary ever emits.
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "allow");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /has a call in flight/u);

    // The call that triggered the advisory is itself journalled too -- recording happened
    // first, and the advisory did not replace it.
    const journalled = readFileSync(journalPathFor(root, ".patchmesh"), "utf8");
    const lines = journalled.trim().split("\n");
    assert.ok(lines.length >= 2, "the seeded call and this call are both on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: no advisory output when the call in flight belongs to the same agent", () => {
  const root = worktree();
  try {
    seedInFlight(root, OWN_SESSION, "Edit", { file_path: "src/shared.ts" }, new Date().toISOString());

    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" })),
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(output, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- PostToolUse: the delivery channel. `additionalContext` is documented as reaching Claude's
// own context on `PostToolUse`, unlike `PreToolUse`'s `allow` reason, which the host only
// confirms reaches the user's transcript. Same matching logic, one hook later.

test("PostToolUse: fires on genuine cross-agent contention on the path just written", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-24T12:00:00.000Z");

    const advisory = computePostWriteAdvisory({
      worktreeRoot: root,
      payload: postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
      now: NOW,
    });

    assert.notEqual(advisory, null);
    assert.equal(advisory!.path, "src/shared.ts");
    assert.equal(advisory!.agentId, agentIdForSession(OTHER_SESSION));
    // Honest about the write already having happened, not framed as a warning before the fact.
    assert.match(advisory!.message, /has a call in flight/u);
    assert.match(advisory!.message, /You just wrote `src\/shared\.ts` too/u);
    assert.match(advisory!.message, /Same file does not mean same work/u);
    assert.doesNotMatch(advisory!.message, /conflict/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse: does not fire for the agent's own in-flight calls", () => {
  const root = worktree();
  try {
    seedInFlight(root, OWN_SESSION, "Edit", { file_path: "src/mine.ts" }, "2026-08-24T12:00:00.000Z");

    const advisory = computePostWriteAdvisory({
      worktreeRoot: root,
      payload: postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/mine.ts" }),
      now: NOW,
    });

    assert.equal(advisory, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse: does not fire on opaque Bash", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-24T12:00:00.000Z");

    const advisory = computePostWriteAdvisory({
      worktreeRoot: root,
      payload: postToolUsePayload(OWN_SESSION, "Bash", { command: "cat src/shared.ts" }),
      now: NOW,
    });

    assert.equal(advisory, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse: does not fire on a PreToolUse payload, and computeContentionAdvisory does not fire on a PostToolUse payload", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, "2026-08-24T12:00:00.000Z");

    assert.equal(
      computePostWriteAdvisory({
        worktreeRoot: root,
        payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
        now: NOW,
      }),
      null,
    );
    assert.equal(
      computeContentionAdvisory({
        worktreeRoot: root,
        payload: postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
        now: NOW,
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thrown post-write advisory does not propagate: emitPostWriteAdvisory swallows it and returns normally", () => {
  const throwing: typeof computePostWriteAdvisory = () => {
    throw new Error("boom");
  };
  assert.doesNotThrow(() => emitPostWriteAdvisory("/does/not/matter", { hook_event_name: "PostToolUse" }, throwing));
});

test("end to end: PostToolUse still journals the call when the advisory path fails or finds nothing", () => {
  const root = worktree();
  try {
    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/solo.ts" })),
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(output, "");
    const journalled = readFileSync(journalPathFor(root, ".patchmesh"), "utf8");
    assert.match(journalled, /solo\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: PostToolUse emits additionalContext with the advisory on genuine contention, exactly once", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, new Date().toISOString());

    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" })),
      cwd: root,
      encoding: "utf8",
    });

    const lines = output.trim().split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, "exactly one hook-output line -- no double warning of the agent");
    const parsed = JSON.parse(lines[0]!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(parsed.hookSpecificOutput.additionalContext, /has a call in flight/u);
    assert.match(parsed.hookSpecificOutput.additionalContext, /You just wrote/u);

    const journalled = readFileSync(journalPathFor(root, ".patchmesh"), "utf8");
    const journalLines = journalled.trim().split("\n");
    assert.ok(journalLines.length >= 2, "the seeded call and this call are both on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: no PostToolUse advisory output when the call in flight belongs to the same agent", () => {
  const root = worktree();
  try {
    seedInFlight(root, OWN_SESSION, "Edit", { file_path: "src/shared.ts" }, new Date().toISOString());

    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" })),
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(output, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: a PreToolUse invocation never also emits the PostToolUse shape", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/shared.ts" }, new Date().toISOString());

    const output = execFileSync(process.execPath, [binPath], {
      input: JSON.stringify(preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" })),
      cwd: root,
      encoding: "utf8",
    });

    const lines = output.trim().split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function turnStartPayload(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt: "carry on with the refactor",
  };
}

test("turn start names the files another agent already has in flight", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/a.ts" }, "2026-08-24T12:00:00.000Z");
    seedInFlight(root, OTHER_SESSION, "Write", { file_path: "src/b.ts" }, "2026-08-24T12:00:10.000Z");

    const advisory = computeTurnStartAdvisory({
      worktreeRoot: root,
      payload: turnStartPayload(OWN_SESSION),
      now: NOW,
    });

    assert.notEqual(advisory, null);
    assert.deepEqual([...advisory!.paths].sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(advisory!.withheld, 0);
    assert.match(advisory!.message, /src\/a\.ts/);
    assert.match(advisory!.message, /Same file does not mean same work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn start is silent when nothing is in flight", () => {
  const root = worktree();
  try {
    assert.equal(
      computeTurnStartAdvisory({ worktreeRoot: root, payload: turnStartPayload(OWN_SESSION), now: NOW }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn start never reports the agent's own in-flight work", () => {
  const root = worktree();
  try {
    seedInFlight(root, OWN_SESSION, "Edit", { file_path: "src/mine.ts" }, "2026-08-24T12:00:00.000Z");
    assert.equal(
      computeTurnStartAdvisory({ worktreeRoot: root, payload: turnStartPayload(OWN_SESSION), now: NOW }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn start leaves out opaque Bash rather than guessing which file it is in", () => {
  const root = worktree();
  try {
    seedInFlight(
      root,
      OTHER_SESSION,
      "Bash",
      { command: "sed -i 's/x/y/' src/secret.ts" },
      "2026-08-24T12:00:00.000Z",
    );
    assert.equal(
      computeTurnStartAdvisory({ worktreeRoot: root, payload: turnStartPayload(OWN_SESSION), now: NOW }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn start reports what it withheld once the list runs long", () => {
  const root = worktree();
  try {
    for (let index = 0; index < 8; index += 1) {
      seedInFlight(
        root,
        OTHER_SESSION,
        "Edit",
        { file_path: `src/f${index}.ts` },
        `2026-08-24T12:00:0${index}.000Z`,
      );
    }
    const advisory = computeTurnStartAdvisory({
      worktreeRoot: root,
      payload: turnStartPayload(OWN_SESSION),
      now: NOW,
    });
    assert.notEqual(advisory, null);
    assert.equal(advisory!.paths.length, 8);
    assert.equal(advisory!.withheld, 3);
    assert.match(advisory!.message, /3 further path\(s\) not named/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn start does not fire on the tool-call stages, and they do not fire on it", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/a.ts" }, "2026-08-24T12:00:00.000Z");
    const payload = turnStartPayload(OWN_SESSION);
    assert.equal(computeContentionAdvisory({ worktreeRoot: root, payload, now: NOW }), null);
    assert.equal(computePostWriteAdvisory({ worktreeRoot: root, payload, now: NOW }), null);

    const edit = preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/a.ts" });
    assert.equal(computeTurnStartAdvisory({ worktreeRoot: root, payload: edit, now: NOW }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing turn-start advisory cannot escape emitTurnStartAdvisory", () => {
  const root = worktree();
  try {
    assert.doesNotThrow(() => {
      emitTurnStartAdvisory(root, turnStartPayload(OWN_SESSION), () => {
        throw new Error("advisory exploded");
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the binary emits UserPromptSubmit additionalContext and still journals the turn", () => {
  const root = worktree();
  try {
    seedInFlight(root, OTHER_SESSION, "Edit", { file_path: "src/a.ts" }, new Date().toISOString());
    const payload = turnStartPayload(OWN_SESSION);
    const stdout = execFileSync(process.execPath, [binPath], {
      cwd: root,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

    const emitted = JSON.parse(stdout.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(emitted.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(emitted.hookSpecificOutput.additionalContext, /src\/a\.ts/);

    const journal = readFileSync(journalPathFor(root, ".patchmesh"), "utf8");
    assert.match(journal, /UserPromptSubmit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Recent cross-agent writes: the replacement predicate. The in-flight view only sees an
// agent caught mid-call (~1.9s); these stages also fire when a different session *completed*
// a write to the path inside the recent window and this session has not been told yet.

test("PreToolUse fires when another session recently wrote the path", () => {
  const root = worktree();
  try {
    seedWrite(root, OTHER_SESSION, "src/shared.ts", "2026-08-24T11:56:00.000Z");
    const advisory = computeContentionAdvisory({
      worktreeRoot: root,
      payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    assert.match(advisory?.message ?? "", /wrote `src\/shared\.ts` 4 minutes ago/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same fact is delivered once — the second look is silent", () => {
  const root = worktree();
  try {
    seedWrite(root, OTHER_SESSION, "src/shared.ts", "2026-08-24T11:56:00.000Z");
    const options = {
      worktreeRoot: root,
      payload: preToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    };
    assert.ok(computeContentionAdvisory(options) !== null);
    assert.equal(computeContentionAdvisory(options), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse framing adds the just-written clause", () => {
  const root = worktree();
  try {
    seedWrite(root, OTHER_SESSION, "src/shared.ts", "2026-08-24T11:58:30.000Z");
    const advisory = computePostWriteAdvisory({
      worktreeRoot: root,
      payload: postToolUsePayload(OWN_SESSION, "Edit", { file_path: "src/shared.ts" }),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    assert.match(advisory?.message ?? "", /You just wrote `src\/shared\.ts` too\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn-start names recent cross-agent paths once each", () => {
  const root = worktree();
  try {
    seedWrite(root, OTHER_SESSION, "src/a.ts", "2026-08-24T11:50:00.000Z");
    seedWrite(root, "third", "src/b.ts", "2026-08-24T11:55:00.000Z");
    const advisory = computeTurnStartAdvisory({
      worktreeRoot: root,
      payload: turnStartPayload(OWN_SESSION),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    });
    assert.deepEqual([...advisory?.paths ?? []].sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(computeTurnStartAdvisory({
      worktreeRoot: root,
      payload: turnStartPayload(OWN_SESSION),
      now: () => new Date("2026-08-24T12:00:05.000Z"),
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
