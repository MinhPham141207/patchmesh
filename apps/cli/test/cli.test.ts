import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventId, ProtocolEvent } from "patchmesh-protocol";
import type { ReadServices, StatusView } from "patchmesh-query";
import type { WorkGraphSnapshot } from "patchmesh-storage";
import { runCli, main } from "../src/main.js";
import { initializeRepository, renderInit } from "../src/init.js";

const status: StatusView = {
  health: "degraded",
  store: { state: "open", replayable: true },
  eventCount: 0,
  eventTypeCounts: {} as StatusView["eventTypeCounts"],
  agentCount: 0,
  taskCount: 0,
  nullAttributionEventCount: 0,
  coverage: { presentation: "degraded", modes: ["unknown"], gaps: [] },
  errorCategory: null,
};

const emptyGraph: WorkGraphSnapshot = { nodes: [], edges: [], coverage: [] };
// Files were observed changing but none was shared: "nothing contested" rather than the
// distinct answer "nothing was seen, so nothing can be assessed".
const emptyOverlaps = () => ({ overlaps: [], truncated: 0, logicalPath: null, filesObserved: 3, sequential: 0 });
/** A worktree root and a reader, so `overlaps` never needs a real checkout under test. */
const overlapDeps = { worktreeRoot: "/repo", readOverlaps: emptyOverlaps };
/**
 * Status reporting that every detector's inputs were recorded.
 *
 * `stale` and `contracts` now decline to answer when the evidence they are typed against was
 * never recorded, so a test about findings has to say the evidence exists or it will be
 * testing the refusal instead.
 */
const evidenceRecorded = {
  ...status,
  eventTypeCounts: {
    "file.read": 1,
    "write.dependent": 1,
    "symbol.changed": 1,
    "dependency.changed": 1,
  } as unknown as StatusView["eventTypeCounts"],
};
const services = {
  getStatus: () => status,
  listAgents: () => ({ agents: [] }),
  listEvents: () => ({ events: [], nextCursor: null, hasMore: false }),
  getGraph: () => ({ snapshot: emptyGraph, filters: {}, coverageWarnings: [] }),
  listFindings: () => ({ findings: [], coverageWarnings: [] }),
  explainDecision: () => ({
    decision: {
      decision: {
        decisionId: "decision_cli",
        findingId: "finding_cli",
        coordinationAction: "record",
        gatewayDirective: "allow",
        state: "active",
        evidenceEventIds: [],
      },
      deliveries: [],
      feedback: [{
        eventId: "evt_00000000000000000000000000000009",
        feedback: { feedbackId: "feedback_cli", disposition: "acknowledged" },
      }],
      eventIds: [],
    },
    finding: null,
    coverageWarnings: [],
  }),
  followEvents: async function* () {},
} as unknown as ReadServices;

const dependencies = { services };

test("rejects unscheduled commands with usage exit code", async () => {
  const result = await runCli(["watch"], dependencies);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unsupported command/i);
});

test("an unsupported command names the available commands instead of dead-ending", async () => {
  const result = await runCli(["watch"], dependencies);

  assert.equal(result.exitCode, 2);
  for (const command of ["status", "overlaps", "stale", "contracts", "explain", "feedback", "delivery"]) {
    assert.match(result.stderr, new RegExp(`\\b${command}\\b`), `usage should mention ${command}`);
  }
});

test("help is a successful command and states the report-only boundary", async () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const result = await runCli(argv, dependencies);
    assert.equal(result.exitCode, 0, `${argv[0]} should succeed`);
    assert.match(result.stdout, /Usage: patchmesh/);
    assert.match(result.stdout, /report-only/i);
    assert.equal(result.stderr, "");
  }
});

test("every detector finding type is reachable from a CLI command", async () => {
  const requested: string[] = [];
  const recordingServices = {
    ...services,
    getStatus: () => evidenceRecorded,
    listFindings: (filters: { readonly findingType: string }) => {
      requested.push(filters.findingType);
      return { findings: [], coverageWarnings: [] };
    },
  } as unknown as ReadServices;

  for (const command of ["overlaps", "stale", "contracts"]) {
    const result = await runCli([command], { services: recordingServices, ...overlapDeps });
    assert.equal(result.exitCode, 0, `${command} should succeed`);
  }

  // Every detector's output must still be reachable from some command; output no command
  // surfaces is unreachable coordination output. `overlaps` is no longer one of them - it is
  // answered from observed file changes rather than from a derived finding.
  assert.deepEqual(requested, [
    "stale_read_before_write",
    "exported_contract_invalidation",
  ]);
});

test("write commands report what was recorded and name an idempotent replay", async () => {
  const inserted = { status: "inserted", event: { eventId: "evt_new" } };
  const duplicate = { status: "duplicate", event: { eventId: "evt_new" } };

  const first = await runCli(["delivery", "decision_a", "--state", "delivered"], {
    services,
    deliveryWriter: { respondToDecisionDelivery: () => inserted },
  } as never);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /DECISION DELIVERY/);
  assert.match(first.stdout, /decision_a/);
  assert.match(first.stdout, /State: delivered/);
  assert.match(first.stdout, /Outcome: recorded/);
  assert.match(first.stdout, /evt_new/);

  const replay = await runCli(["delivery", "decision_a", "--state", "delivered"], {
    services,
    deliveryWriter: { respondToDecisionDelivery: () => duplicate },
  } as never);
  assert.equal(replay.exitCode, 0, "an identical replay is not a failure");
  assert.match(replay.stdout, /already recorded/);

  const feedback = await runCli(["feedback", "finding_a", "--disposition", "dismissed"], {
    services,
    feedbackWriter: { respondToFinding: () => inserted },
  } as never);
  assert.equal(feedback.exitCode, 0);
  assert.match(feedback.stdout, /FINDING FEEDBACK/);
  assert.match(feedback.stdout, /Disposition: dismissed/);
});

test("write commands keep machine output unchanged under --json", async () => {
  const result = await runCli(["delivery", "decision_a", "--state", "failed", "--json"], {
    services,
    deliveryWriter: { respondToDecisionDelivery: () => ({ status: "inserted", event: { eventId: "evt_j" } }) },
  } as never);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: "inserted", event: { eventId: "evt_j" } });
});

test("findings commands surface coverage warnings alongside an empty result", async () => {
  const degradedServices = {
    ...services,
    getStatus: () => evidenceRecorded,
    listFindings: () => ({
      findings: [],
      coverageWarnings: [{ kind: "unverified", scope: "write.dependent" }],
    }),
  } as unknown as ReadServices;

  const result = await runCli(["contracts"], { services: degradedServices });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /No findings/);
  assert.match(result.stdout, /Coverage gap: unverified write\.dependent/);
});

test("graph JSON output is stable and contains no Phase 2 fields", async () => {
  const first = await runCli(["graph", "--json"], dependencies);
  const second = await runCli(["graph", "--json"], dependencies);

  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout.includes("findings"), false);
  assert.equal(first.stdout.includes("validity"), false);
});

test("degraded status remains a successful reporting result", async () => {
  const result = await runCli(["status", "--json"], dependencies);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).health, "degraded");
});

test("events JSON renders one stable redacted page record", async () => {
  const event = { eventId: "evt_cli" as EventId, eventType: "file.read" } as ProtocolEvent;
  const eventServices = {
    ...services,
    listEvents: () => ({ events: [event], nextCursor: event.eventId, hasMore: false }),
  } as unknown as ReadServices;
  const result = await runCli(["events", "--json"], { services: eventServices });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).events[0], event);
});

test("overlaps answers from observed changes, not from the work-graph projection", async () => {
  // It used to read `same_symbol_overlap` findings. On a hook-recorded ledger that projection
  // yields no overlaps at all, so the command a user runs was the one that could not answer.
  let sawFindingsCall = false;
  const watchedServices = {
    ...services,
    listFindings: () => {
      sawFindingsCall = true;
      return { findings: [], coverageWarnings: [] };
    },
  } as unknown as ReadServices;

  const overlaps = await runCli(["overlaps"], { services: watchedServices, ...overlapDeps });

  assert.equal(overlaps.exitCode, 0);
  assert.equal(sawFindingsCall, false, "overlaps must not go through the finding list");
  assert.match(overlaps.stdout, /No two workers changed the same file at once/);
});

test("a detector whose evidence was never recorded says so instead of reporting no findings", async () => {
  // Silence and inability are different answers. The stub status has no event-type counts, so
  // neither detector's inputs exist - which is exactly the state of a hook-recorded ledger.
  for (const command of ["stale", "contracts"]) {
    const result = await runCli([command], dependencies);
    assert.equal(result.exitCode, 0, `${command} is report-only and must not fail`);
    assert.match(result.stdout, /can be derived from this event store/);
    assert.match(result.stdout, /Missing evidence:/);
  }
});

test("explain requires an ID and renders a report-only decision", async () => {
  const missing = await runCli(["explain"], dependencies);
  const result = await runCli(["explain", "decision_cli"], dependencies);

  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /requires a decision ID/i);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /DECISION EXPLANATION/);
  assert.match(result.stdout, /Directive: allow/);
  assert.match(result.stdout, /Feedback: evt_00000000000000000000000000000009 feedback_cli acknowledged/);
});

test("feedback records an immutable response through the supplied writer", async () => {
  let received: unknown = null;
  const result = await runCli([
    "feedback", "finding_cli", "--disposition", "dismissed", "--useful", "true",
    "--reason", "handled", "--agent", "agent_cli", "--task", "task_cli",
  ], {
    services,
    feedbackWriter: {
      respondToFinding(input) {
        received = input;
        return { status: "inserted", event: { eventId: "evt_feedback" } as never };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    result.stdout,
    "FINDING FEEDBACK\nFinding: finding_cli\nDisposition: dismissed\nOutcome: recorded\nEvent: evt_feedback\n",
  );
  assert.deepEqual(received, {
    findingId: "finding_cli",
    decisionId: null,
    disposition: "dismissed",
    useful: true,
    reason: "handled",
    actor: { agentId: "agent_cli", taskId: "task_cli" },
  });
});

test("feedback rejects malformed input and unavailable writers", async () => {
  const missingDisposition = await runCli(["feedback", "finding_cli"], dependencies);
  const unavailable = await runCli(["feedback", "finding_cli", "--disposition", "acknowledged"], dependencies);

  assert.equal(missingDisposition.exitCode, 2);
  assert.match(missingDisposition.stderr, /disposition/i);
  assert.equal(unavailable.exitCode, 3);
});

test("delivery records an immutable decision delivery state through the supplied writer", async () => {
  let received: unknown = null;
  const result = await runCli(["delivery", "decision_cli", "--state", "delivered", "--json"], {
    services,
    deliveryWriter: {
      respondToDecisionDelivery(input) {
        received = input;
        return { status: "inserted", event: {} as never };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: "inserted", event: {} });
  assert.deepEqual(received, { decisionId: "decision_cli", state: "delivered" });
});

test("delivery rejects missing, malformed, and unavailable writer inputs", async () => {
  const missingId = await runCli(["delivery", "--state", "delivered"], dependencies);
  const invalidState = await runCli(["delivery", "decision_cli", "--state", "sent"], dependencies);
  const unavailable = await runCli(["delivery", "decision_cli", "--state", "delivered"], dependencies);

  assert.equal(missingId.exitCode, 2);
  assert.match(missingId.stderr, /decision ID/i);
  assert.equal(invalidState.exitCode, 2);
  assert.match(invalidState.stderr, /delivery state/i);
  assert.equal(unavailable.exitCode, 3);
});

test("init wires the recorder without disturbing another tool's hooks", () => {
  // A repository is more likely to have hooks from other tools than to have none, so merging
  // beside what is already there is the normal case. Clobbering one would be a worse failure
  // than not installing at all, because it breaks something that was working.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-"));
  try {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "othertool hook" }] }] },
      }),
      "utf8",
    );
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");

    const result = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg" });
    assert.equal(result.steps.every((step) => step.outcome !== "skipped"), true);

    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")) as {
      permissions: unknown;
      hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    };
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] }, "unrelated settings survive");
    const preToolUse = settings.hooks["PreToolUse"]!.flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.equal(preToolUse.includes("othertool hook"), true, "another tool's hook must survive");
    // Asserted by ownership rather than by one spelling: the command form now depends on how
    // PatchMesh was installed - a relative node_modules path, a bare bin name on the PATH, or
    // an absolute path in a checkout - and this fixture's packageRoot does not exist, so it
    // resolves to the global form.
    assert.equal(
      preToolUse.some((command) => /recorder\/dist\/bin\.js|patchmesh-record/u.test(command.replaceAll("\\", "/"))),
      true,
      "PatchMesh's own recorder hook must be wired, in whichever form this install calls for",
    );
    // In-flight visibility, the record of work done, and the turn boundary that gives work a
    // task all come from different host events; missing one silently degrades attribution.
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
      assert.ok(settings.hooks[event], `${event} must be wired`);
    }
    // The one hook that reads. Without it PatchMesh records thousands of events and answers
    // nothing, because nothing in an agent's loop ever chooses to ask. See docs/problems/PM-01.
    assert.ok(settings.hooks["SessionStart"], "SessionStart must be wired");
    const sessionStart = settings.hooks["SessionStart"]!.flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.equal(
      sessionStart.some((command) => /gateway\/dist\/session-start-bin\.js|patchmesh-session-start/u.test(command.replaceAll("\\", "/"))),
      true,
      "the read-side hook resolves to the gateway binary, in whichever form this install calls for",
    );
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.patchmesh\/$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init run twice changes nothing the second time", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-"));
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: "/pkg" });
    const again = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg" });
    assert.deepEqual(
      again.steps.map((step) => step.outcome),
      ["unchanged", "unchanged", "unchanged"],
      "a configured repository reports itself configured rather than being rewritten",
    );
    assert.match(renderInit(again, false), /Already configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init respects opting out of hooks and gitignore", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-"));
  try {
    const result = initializeRepository({
      worktreeRoot: root,
      packageRoot: "/pkg",
      installHooks: false,
      updateGitignore: false,
    });
    assert.deepEqual(result.steps.map((step) => step.outcome), ["skipped", "skipped", "skipped"]);
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), false);
    assert.equal(existsSync(join(root, ".gitignore")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune requires an explicit retention cutoff", async () => {
  // Deleting history is not something to do because a flag was forgotten.
  const result = await runCli(["prune"], { services, pruner: { prune: () => ({ removed: 0, retained: 0 }) } });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--older-than/);
});

test("prune reports what survived, not only what went", async () => {
  let asked: Date | null = null;
  const result = await runCli(["prune", "--older-than", "30"], {
    services,
    pruner: {
      prune: (options: { readonly olderThan: Date }) => {
        asked = options.olderThan;
        return { removed: 7, retained: 93 };
      },
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Removed 7 event\(s\)/);
  assert.match(result.stdout, /93 event\(s\) retained/);
  assert.notEqual(asked, null);
  // Thirty days back, not thirty days forward, and not "now".
  assert.ok((asked as unknown as Date).getTime() < Date.now());
});

test("status summarizes repeated coverage gaps instead of printing one line each", async () => {
  // A hook-recorded ledger produces one opaque gap per shell command, and shell commands are
  // most of what an agent runs. On this repository's own ledger that was 673 identical lines
  // against 9 lines of actual status.
  const gaps = Array.from({ length: 400 }, (_, index) => ({
    kind: "opaque" as const,
    scope: `tool:evt_${index}`,
    reason: "opaque operation effects are not prospectively enumerable",
    evidenceEventIds: [],
  }));
  const noisy = { ...status, coverage: { ...status.coverage, gaps } };
  const result = await runCli(["status"], {
    ...overlapDeps,
    services: { ...services, getStatus: () => noisy } as unknown as ReadServices,
  });

  assert.equal(result.exitCode, 0);
  const gapLines = result.stdout.split("\n").filter((line) => line.includes("Coverage gap"));
  assert.equal(gapLines.length, 1);
  assert.match(gapLines[0] ?? "", /opaque \(400\) opaque operation effects/);
});

test("a single coverage gap still names the scope that fell short", async () => {
  // Summarizing is only worth doing when there is repetition. With one gap the scope is the
  // informative half and collapsing it would lose the only pointer to what happened.
  const single = {
    ...status,
    coverage: {
      ...status.coverage,
      gaps: [{ kind: "unverified" as const, scope: "write.dependent", reason: "absent", evidenceEventIds: [] }],
    },
  };
  const result = await runCli(["status"], {
    ...overlapDeps,
    services: { ...services, getStatus: () => single } as unknown as ReadServices,
  });

  assert.match(result.stdout, /Coverage gap:\s+unverified write\.dependent/);
});

test("graph names resources by path and nests versions under the file they belong to", async () => {
  // `--print` because `graph` now serves the explorer by default; the text rendering it used
  // to produce is still reachable for a pipe and still has to name paths rather than hashes.
  // The node carries `resource.locator`; printing `resource:res_<sha256>` discarded data the
  // projection already held and made the command 1,145 lines of indistinguishable hex.
  const snapshot = {
    nodes: [
      {
        kind: "resource",
        nodeId: "resource:res_abc",
        resource: { resourceId: "res_abc", repositoryId: "repo_1", kind: "file", locator: "src/auth.ts" },
        evidenceEventIds: [],
      },
      {
        kind: "version",
        nodeId: "version:ver_abc",
        version: {
          resourceId: "res_abc",
          domain: { repositoryId: "repo_1", workspaceId: "ws_1", worktreeId: "wt_1" },
          kind: "content_hash",
          value: "2e6f071c34b02e949965758d4c5c4b97",
          evidenceEventIds: [],
        },
        evidenceEventIds: [],
      },
    ],
    edges: [{ edgeId: "edge_1", kind: "changes", fromNodeId: null, toNodeId: "resource:res_abc", evidenceEventIds: [] }],
    coverage: [],
  } as unknown as WorkGraphSnapshot;
  const result = await runCli(["graph", "--print"], {
    ...overlapDeps,
    services: {
      ...services,
      getGraph: () => ({ snapshot, filters: {}, coverageWarnings: [] }),
    } as unknown as ReadServices,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /WORK GRAPH \(1 resource, 1 version; 1 edge\(s\)\)/);
  assert.match(result.stdout, /resource\tsrc\/auth\.ts/);
  assert.match(result.stdout, /version\tsrc\/auth\.ts@2e6f071c/);
  assert.match(result.stdout, /unattributed\t->\tsrc\/auth\.ts\tchanges/);
  assert.equal(result.stdout.includes("res_abc"), false);
});

test("agents nests a subagent under the parent whose id it truncates", async () => {
  // The recorder names a subagent `<parentPrefix>.sub.<suffix>`, so the parent relationship is
  // recorded. The prefix is a truncation, so it has to resolve against the agents present -
  // sorting the ids as strings puts the subagents under an unrelated neighbour.
  const agents = [
    { agentId: "agent_62225cb8-9250-4387", taskIds: ["task_1"], eventCount: 569, eventTypeCounts: {}, coverage: [] },
    { agentId: "agent_7a1033a6.sub.aaa", taskIds: ["task_2"], eventCount: 2, eventTypeCounts: {}, coverage: [] },
    { agentId: "agent_7a1033a6-93c4-46e2", taskIds: ["task_3", null], eventCount: 312, eventTypeCounts: {}, coverage: [] },
  ];
  const result = await runCli(["agents"], {
    ...overlapDeps,
    services: { ...services, listAgents: () => ({ agents }) } as unknown as ReadServices,
  });

  assert.equal(result.exitCode, 0);
  const lines = result.stdout.split("\n").filter((line) => line.includes("agent_"));
  assert.match(lines[0] ?? "", /^agent_62225cb8/);
  assert.match(lines[1] ?? "", /^agent_7a1033a6-93c4/);
  assert.match(lines[2] ?? "", /^\s+↳ agent_7a1033a6\.sub\.aaa/);
  // An agent with work outside any task says so rather than reporting a bare count.
  assert.match(lines[1] ?? "", /1 \(\+unattributed\)/);
});

test("init writes a portable command when installed as a dependency", async () => {
  // `.mcp.json` is normally committed, so an absolute path into one machine's checkout breaks
  // the repository for everyone else. Verified against a real packed install before this test
  // existed: the published config must name paths the next clone can resolve.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-dep-"));
  try {
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules", "patchmesh-recorder", "dist"), { recursive: true });
    writeFileSync(join(root, "node_modules", "patchmesh-recorder", "dist", "bin.js"), "");

    initializeRepository({ worktreeRoot: root });
    const settings = readFileSync(join(root, ".claude", "settings.local.json"), "utf8");
    const mcp = readFileSync(join(root, ".mcp.json"), "utf8");

    assert.match(settings, /node_modules\/patchmesh-recorder\/dist\/bin\.js/);
    assert.match(mcp, /node_modules\/patchmesh-gateway\/dist\/bin\.js/);
    // No drive letter, no leading slash: nothing that only resolves on the machine that ran it.
    assert.equal(/[A-Za-z]:[\\/]/.test(settings + mcp), false, "config must not carry an absolute path");
    assert.equal(settings.includes("\\\\"), false, "config must not carry Windows separators");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report command on a repository with no ledger answers instead of failing", async () => {
  // The first thing a new user runs is `status`, and the first thing PatchMesh said back was
  // `database is unavailable` - a broken tool rather than an empty one. The recorder creates
  // the ledger on its first write, so no file is the honest pre-first-use state.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-cold-"));
  try {
    const missing = join(root, ".patchmesh", "ledger.db");
    const result = await main(["status", "--database", missing]);
    assert.equal(result, 0, "an empty repository is a successful report, not a failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a global install writes a command that resolves even with nothing on PATH", async () => {
  // `npm install -g patchmesh` links this package's bin and nothing else: the recorder and the
  // gateway are separate packages whose bins npm never links. The config written for that
  // install used to name bare binaries that were not there -- syntactically fine and completely
  // inert, because hooks fail open and exit 0. The code was present the whole time; only the
  // PATH entry was missing, so resolution finds what a guessed name could not.
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-global-"));
  const path = process.env["PATH"];
  try {
    mkdirSync(join(root, ".git"));
    // An empty PATH plus a packageRoot holding no build forces the `global` branch with no bare
    // name available, which is exactly the broken install being guarded against.
    process.env["PATH"] = "";
    const result = initializeRepository({ worktreeRoot: root, packageRoot: join(root, "absent") });

    assert.equal(result.steps.some((step) => step.outcome === "warning"), false,
      "the recorder resolves from this install, so there is nothing to warn about");

    const settings = readFileSync(join(root, ".claude", "settings.local.json"), "utf8");
    const mcp = readFileSync(join(root, ".mcp.json"), "utf8");

    // The point: every path written must name a file that exists, not a hopeful bare name.
    // Both configs are JSON, so the entries are read out rather than pattern-matched.
    const referenced = [settings, mcp]
      .flatMap((config) => [...JSON.stringify(JSON.parse(config)).matchAll(/[^"\\ ]+\.js/g)])
      .map((match) => match[0]);

    assert.ok(referenced.length > 0, "a global install with nothing on PATH must resolve real paths");
    for (const target of referenced) {
      assert.ok(existsSync(target), `command must point at a file that exists: ${target}`);
    }
  } finally {
    process.env["PATH"] = path;
    rmSync(root, { recursive: true, force: true });
  }
});
