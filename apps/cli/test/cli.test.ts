import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { EventId, ProtocolEvent } from "patchmesh-protocol";
import type { ReadServices, StatusView } from "patchmesh-query";
import { SqliteEventStore, type WorkGraphSnapshot } from "patchmesh-storage";
import { appendJournalEntry, journalPathFor, LEDGER_DIRECTORY, ledgerPathFor } from "patchmesh-recorder";
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
const emptyOverlaps = () => ({ overlaps: [], live: [], truncated: 0, logicalPath: null, filesObserved: 3, sequential: 0 });
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

test("an unsupported command names the available commands and points at help", async () => {
  const result = await runCli(["watch"], dependencies);

  assert.equal(result.exitCode, 2);
  for (const command of ["status", "overlaps", "stale", "contracts", "explain", "feedback", "delivery"]) {
    assert.match(result.stderr, new RegExp(`\\b${command}\\b`), `the hint should mention ${command}`);
  }
  assert.match(result.stderr, /Run 'patchmesh help'/);
  // The hint replaces the usage dump rather than prefixing it: the point is that the wrong
  // word stays readable, which it is not under forty lines of options.
  assert.ok(!result.stderr.includes("Usage: patchmesh"), "the hint should not reprint the whole usage");
});

test("an unsupported option points at help too", async () => {
  const result = await runCli(["status", "--nope"], dependencies);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unsupported option: --nope/);
  assert.match(result.stderr, /Run 'patchmesh help'/);
});

test("no command at all prints the full usage", async () => {
  const result = await runCli([], dependencies);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Usage: patchmesh/);
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
  // Intent unchanged - an empty result must still surface what the detector could not see.
  // The presentation changed deliberately: the verdict leads, and the gaps sit under it as a
  // caveat on that verdict rather than above it as a wall to read past.
  assert.match(result.stdout, /No exported-contract invalidation findings\./);
  assert.match(result.stdout, /absence of evidence/);
  assert.match(result.stdout, /unverified write\.dependent/);
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

test("init --host opencode installs the plugin once", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-opencode-"));
  try {
    const first = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode" });
    const pluginPath = join(root, ".opencode", "plugins", "patchmesh.mjs");
    assert.equal(existsSync(pluginPath), true);
    assert.equal(
      first.steps.find((step) => step.detail.includes("OpenCode"))?.outcome,
      "created",
      "the first run reports the plugin as created",
    );

    const contents = readFileSync(pluginPath, "utf8");
    const again = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode" });
    assert.equal(again.steps.some((step) => step.outcome === "unchanged"), true, "a second run reports unchanged");
    assert.equal(again.steps.some((step) => step.outcome === "created"), false, "a second run installs nothing twice");
    assert.equal(readFileSync(pluginPath, "utf8"), contents, "a second run leaves the file byte-identical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the generated plugin spawns the resolved recorder binary", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-opencode-"));
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode" });
    const plugin = readFileSync(join(root, ".opencode", "plugins", "patchmesh.mjs"), "utf8");
    // Provenance rides on every event, so the plugin must stamp its host explicitly even
    // though the recorder's default is Claude Code.
    assert.match(plugin, /--host opencode/);
    assert.match(plugin, /bin\.js/, "the recorder reference must name a dist binary");
    // Only the after-stage is relayed: a before-relay journals a fabricated completion
    // before the call runs and double-records every call.
    assert.doesNotMatch(plugin, /tool\.execute\.before/u);
    // OpenCode loads plugins under Bun and Node alike, so nothing beyond node builtins may
    // be assumed - not even this repository's own packages.
    for (const specifier of [...plugin.matchAll(/^import .* from "(.+?)";$/gmu)].map((match) => match[1]!)) {
      assert.match(specifier, /^node:/u, `only node builtins may be imported, found ${specifier}`);
    }
    // Recording may cost time; it must never break a tool call.
    assert.match(plugin, /catch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the generated plugin resolves repo-relative binaries against the repository root", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-opencode-"));
  const markerEnv = "PM_PLUGIN_TEST_MARKER";
  const previousMarker = process.env[markerEnv];
  try {
    // The dependency branch, where the plugin's binary reference is repo-relative and its
    // correctness rests entirely on repoRoot()'s URL arithmetic.
    const recorderBin = join(root, "node_modules", "patchmesh-recorder", "dist", "bin.js");
    mkdirSync(dirname(recorderBin), { recursive: true });
    writeFileSync(
      recorderBin,
      "require('fs').writeFileSync(process.env['PM_PLUGIN_TEST_MARKER'], 'recorded');\n",
      "utf8",
    );
    initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode" });

    // Executed, not regex-matched: a source match is exactly what let repoRoot() pop one
    // segment too many and land outside the repository while every test stayed green. The
    // fixture recorder writes a marker only if the spawn actually reached it through the
    // plugin's own path resolution.
    const plugin = await import(pathToFileURL(join(root, ".opencode", "plugins", "patchmesh.mjs")).href);
    const hooks = (await plugin.PatchMeshPlugin()) as Record<string, (input: unknown) => void>;
    const marker = join(root, "marker.txt");
    process.env[markerEnv] = marker;
    hooks["tool.execute.after"]({ tool: "probe" });

    assert.equal(existsSync(marker), true, "the plugin must reach the recorder relative to the repository root");
  } finally {
    if (previousMarker === undefined) delete process.env[markerEnv];
    else process.env[markerEnv] = previousMarker;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a differing OpenCode plugin is left alone until --force", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-opencode-"));
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode" });
    const pluginPath = join(root, ".opencode", "plugins", "patchmesh.mjs");
    writeFileSync(pluginPath, "// hand-edited\n", "utf8");

    const rerun = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode" });
    // Overwriting a plugin someone else wrote or edited would silently discard their wiring,
    // so a differing file is named out loud rather than replaced.
    assert.equal(rerun.steps.find((step) => step.detail.includes("OpenCode"))?.outcome, "warning");
    assert.equal(readFileSync(pluginPath, "utf8"), "// hand-edited\n", "nothing was overwritten without --force");

    const forced = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "opencode", force: true });
    assert.equal(forced.steps.find((step) => step.detail.includes("OpenCode"))?.outcome, "updated");
    assert.notEqual(readFileSync(pluginPath, "utf8"), "// hand-edited\n");
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

/** A mailbox send, seeded straight into the ledger the way `sendMail` would leave it. */
let mailSequence = 0;
function sentMailEvent(messageId: string): ProtocolEvent {
  mailSequence += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_${String(mailSequence).padStart(32, "0")}` as EventId,
    eventType: "agent.message.sent",
    source: { kind: "gateway", sourceId: "source_patchmesh_mailbox", instanceId: "11111111-1111-4111-8111-111111111111" },
    timestamp: "2026-08-26T12:00:00.000Z",
    repositoryId: "repo_11111111-1111-4111-8111-111111111111",
    workspaceId: "ws_22222222-2222-4222-8222-222222222222",
    worktreeId: "wt_33333333-3333-4333-8333-333333333333",
    agentId: "agent_aaaa1111-2222-4333-8444-555555555555",
    taskId: null,
    correlationId: `corr_${String(mailSequence).padStart(32, "0")}`,
    causationId: null,
    sourceSequence: null,
    payload: {
      messageId,
      to: { kind: "broadcast", agentId: null },
      kind: "notice",
      subject: `subject ${messageId}`,
      body: `body ${messageId}`,
      refs: [],
      expiresAt: "2027-09-02T12:00:00.000Z",
    },
  } as unknown as ProtocolEvent;
}

test("status reports undelivered mailbox messages in text and --json", async () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-status-mail-"));
  const ledgerPath = join(root, ".patchmesh", "ledger.db");
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  const store = SqliteEventStore.open(ledgerPath);
  try {
    store.appendAtomic([sentMailEvent("msg_a".padEnd(36, "a")), sentMailEvent("msg_b".padEnd(36, "b"))]);
  } finally {
    store.close();
  }
  try {
    const text = await runCli(["status", "--database", ledgerPath], { ...overlapDeps, services });
    assert.equal(text.exitCode, 0);
    assert.match(text.stdout, /Undelivered messages: 2/);

    const json = await runCli(["status", "--json", "--database", ledgerPath], { ...overlapDeps, services });
    assert.equal(json.exitCode, 0);
    assert.equal((JSON.parse(json.stdout) as { undeliveredMessages?: number }).undeliveredMessages, 2);

    // No ledger named at all degrades to zero rather than an error, like every other count.
    const quiet = await runCli(["status"], { ...overlapDeps, services });
    assert.match(quiet.stdout, /Undelivered messages: 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("agents render host provenance and coverage tier beside every row", async () => {
  const agents = [
    { agentId: "agent_aaaa-1111-4111", taskIds: ["task_1"], eventCount: 10, eventTypeCounts: {}, coverage: [], host: { sourceId: "source_opencode_hook", displayName: "OpenCode", tier: "observed" } },
    { agentId: "agent_bbbb-2222-4222", taskIds: [], eventCount: 4, eventTypeCounts: {}, coverage: [], host: { sourceId: "source_something_else", displayName: null, tier: null } },
    { agentId: "agent_cccc-3333-4333", taskIds: [], eventCount: 1, eventTypeCounts: {}, coverage: [], host: { sourceId: "source_claude_code_hook", displayName: "Claude Code", tier: "observed" } },
  ];
  const result = await runCli(["agents"], {
    ...overlapDeps,
    services: { ...services, listAgents: () => ({ agents }) } as unknown as ReadServices,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /agent_aaaa-111 · OpenCode \(observed\)/);
  assert.match(result.stdout, /agent_cccc-333 · Claude Code \(observed\)/);
  // An unrecognized host is named as such rather than counted either way.
  assert.match(result.stdout, /agent_bbbb-222 · \(unrecognized host\)/);
});

test("status coverage line reports how many sources are observed", async () => {
  const observed: StatusView = {
    ...status,
    coverage: { presentation: "observational", covered: 1, total: 2, modes: [], gaps: [], sources: { observed: 2, total: 3 } },
  };
  const result = await runCli(["status"], {
    ...overlapDeps,
    services: { ...services, getStatus: () => observed } as unknown as ReadServices,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Coverage:.*2\/3 sources observed/);
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
  // Busiest first, not alphabetical: 569 events outrank 312.
  assert.match(lines[0] ?? "", /^agent_62225cb8/);
  assert.match(lines[1] ?? "", /agent_7a1033a6-93c4|agent_7a1033a6\b/);
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

/**
 * A gap list large enough that dumping it whole is the defect being tested.
 *
 * A hook-recorded ledger produces one opaque gap per shell command, so this is not a synthetic
 * extreme: the live store this was found on held 2,611 of them.
 */
function manyGaps(count: number): StatusView["coverage"]["gaps"] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: index % 2 === 0 ? "opaque" : "unattributed",
    scope: `tool:evt_${String(index).padStart(32, "0")}`,
    reason: "opaque operation effects are not prospectively enumerable",
    evidenceEventIds: [`evt_${String(index).padStart(32, "0")}`],
  })) as unknown as StatusView["coverage"]["gaps"];
}

test("status --json is bounded and says how much it withheld", async () => {
  const loaded: StatusView = {
    ...status,
    coverage: { presentation: "degraded", modes: ["unknown"], gaps: manyGaps(2611) },
  };
  const result = await runCli(["status", "--json"], {
    services: { ...services, getStatus: () => loaded } as unknown as ReadServices,
    ...overlapDeps,
  });

  assert.equal(result.exitCode, 0);
  // The bound is the point: an unbounded answer grows with the ledger forever, and `--json` is
  // the flag a programmatic consumer uses - the caller least able to cope with that.
  assert.ok(result.stdout.length < 20_000, `status --json was ${result.stdout.length} bytes`);

  const parsed = JSON.parse(result.stdout) as {
    coverage: { gaps: unknown[]; gapsTotal: number; gapsWithheld: number; gapsByKind: Record<string, number> };
  };
  assert.equal(parsed.coverage.gaps.length, 20);
  assert.equal(parsed.coverage.gapsTotal, 2611);
  assert.equal(parsed.coverage.gapsWithheld, 2591);
  // Counted by kind, so the total stays auditable without carrying the objects.
  assert.equal(parsed.coverage.gapsByKind.opaque! + parsed.coverage.gapsByKind.unattributed!, 2611);
});

test("a bounded json answer does not grow when the ledger does", async () => {
  const sizeFor = async (count: number): Promise<number> => {
    const loaded: StatusView = {
      ...status,
      coverage: { presentation: "degraded", modes: ["unknown"], gaps: manyGaps(count) },
    };
    const result = await runCli(["status", "--json"], {
      services: { ...services, getStatus: () => loaded } as unknown as ReadServices,
      ...overlapDeps,
    });
    return result.stdout.length;
  };

  const small = await sizeFor(50);
  const large = await sizeFor(50_000);
  // Only the counts differ, so the answer grows by the width of a number rather than by the
  // size of the store. This is what "bounded by construction" has to mean to be worth saying.
  assert.ok(large - small < 200, `grew ${large - small} bytes between 50 and 50,000 gaps`);
});

test("a detector that ran and found nothing leads with that, not with its coverage gaps", async () => {
  const withGaps = {
    findings: [],
    coverageWarnings: manyGaps(2411),
  } as unknown as ReturnType<ReadServices["listFindings"]>;

  const result = await runCli(["contracts"], {
    services: {
      ...services,
      getStatus: () => evidenceRecorded,
      listFindings: () => withGaps,
    } as unknown as ReadServices,
    ...overlapDeps,
  });

  assert.equal(result.exitCode, 0);
  const lines = result.stdout.trim().split("\n");
  // The question the reader asked is answered on line one. It used to be answered last, under
  // a bare table header and every coverage gap in the store.
  assert.match(lines[0]!, /^No exported-contract invalidation findings\./u);
  assert.ok(!result.stdout.includes("FINDING\tTYPE"), "no table header when there are no rows");
  // And the zero is qualified rather than presented as a clean bill of health.
  assert.match(result.stdout, /absence of evidence/u);
});

test("a detector that ran over complete coverage says so plainly", async () => {
  const clean = { findings: [], coverageWarnings: [] } as unknown as ReturnType<ReadServices["listFindings"]>;
  const result = await runCli(["contracts"], {
    services: { ...services, getStatus: () => evidenceRecorded, listFindings: () => clean } as unknown as ReadServices,
    ...overlapDeps,
  });

  assert.match(result.stdout, /^No exported-contract invalidation findings\./u);
  assert.match(result.stdout, /clean result/u);
  assert.ok(!result.stdout.includes("absence of evidence"), "a complete-coverage zero is not hedged");
});

/** A real checkout with one call sitting undrained in its journal, as a live session leaves it. */
function repositoryWithPendingCall(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-freshen-cli-"));
  execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
  appendJournalEntry(
    journalPathFor(root, LEDGER_DIRECTORY),
    {
      session_id: "3f1b9a0c-7d2e-4a55-9c31-8b6f0e2d4a17",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: join(root, "a.ts") },
      tool_response: {},
    },
    new Date().toISOString(),
  );
  return root;
}

test("a report drains its own repository's journal first, so it answers about now", async () => {
  // The bug this closes: ingest runs on `Stop`, so a session's own work reached the ledger only
  // after that session ended, and every report read the ledger. Measured on this repository, the
  // latest event was 14 hours behind a journal written to minutes earlier -- and `overlaps`
  // correctly reported no changes on a day of continuous work.
  const root = repositoryWithPendingCall();
  try {
    const journal = journalPathFor(root, LEDGER_DIRECTORY);
    assert.equal(existsSync(journal), true, "precondition: a call is waiting");

    const result = await runCli(["recap", "--database", ledgerPathFor(root)], {
      ...services,
      worktreeRoot: root,
      readRecap: () => ({ tasks: [], unattributed: 0, windowMinutes: 60, truncated: 0 }),
    } as unknown as Parameters<typeof runCli>[1]);

    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(journal), false, "the report drained what the hook had journalled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report pointed at somebody else's database leaves this repository's journal alone", async () => {
  // Draining consumes the journal. Doing that while reading a fixture, a copy, or another
  // checkout's ledger would write these calls where they do not belong *and* destroy them, so
  // they could never reach the ledger that wanted them. Reading a foreign database is read-only.
  const root = repositoryWithPendingCall();
  const elsewhere = mkdtempSync(join(tmpdir(), "patchmesh-foreign-"));
  try {
    const journal = journalPathFor(root, LEDGER_DIRECTORY);

    const result = await runCli(["recap", "--database", join(elsewhere, "someone-else.db")], {
      ...services,
      worktreeRoot: root,
      readRecap: () => ({ tasks: [], unattributed: 0, windowMinutes: 60, truncated: 0 }),
    } as unknown as Parameters<typeof runCli>[1]);

    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(journal), true, "the journal is untouched when the database is not ours");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a first report on a fresh install drains the journal instead of saying nothing was recorded", async () => {
  // The recorder creates the ledger on its first *drain*, so a repository whose hooks have been
  // running all session has a journal full of calls and no database yet. "There is no ledger"
  // is decided in `main` before `runCli` is reached, so without freshening there too, the very
  // first report a new user runs reports nothing recorded while the evidence sits beside it --
  // the exact confusion `renderNoLedger` exists to clear up.
  //
  // Caught by installing the packed tarballs into a clean repository and running them, not by
  // the suite: every test here had a ledger already.
  const root = repositoryWithPendingCall();
  const previousCwd = process.cwd();
  try {
    process.chdir(root);
    assert.equal(existsSync(ledgerPathFor(root)), false, "precondition: no ledger yet");

    const exitCode = await main(["recap"]);

    assert.equal(exitCode, 0);
    assert.equal(existsSync(ledgerPathFor(root)), true, "the report created the ledger by draining");
    assert.equal(existsSync(journalPathFor(root, LEDGER_DIRECTORY)), false, "and consumed the journal");
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

/** A checkout laid out like this monorepo, so `init` takes its `checkout` branch. */
function monorepoCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-checkout-"));
  for (const owner of ["recorder", "gateway"]) {
    mkdirSync(join(root, "packages", owner, "dist"), { recursive: true });
  }
  for (const [owner, binary] of [
    ["recorder", "bin.js"], ["recorder", "ingest-bin.js"],
    ["gateway", "session-start-bin.js"], ["gateway", "bin.js"],
  ] as const) {
    writeFileSync(join(root, "packages", owner, "dist", binary), "// stub\n", "utf8");
  }
  return root;
}

test("init wires a checkout against the repository, not against the machine it ran on", () => {
  // `.claude/settings.local.json` and `.mcp.json` are both tracked in this repository, so an
  // absolute path in either is per-developer churn that breaks for every other clone. The path
  // had been deleted by hand twice and come back both times, because only the file was ever
  // fixed and the writer that produces it was not.
  const root = monorepoCheckout();
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: root });

    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")) as {
      hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    };
    const commands = Object.values(settings.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)));

    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.ok(
        command.includes("$CLAUDE_PROJECT_DIR"),
        `hook command names the machine instead of the repository: ${command}`,
      );
      assert.ok(!/^[A-Za-z]:[\/]/u.test(command.replace(/^node "/u, "")), `absolute path in: ${command}`);
    }

    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as
      { mcpServers: Record<string, { args: readonly string[] }> };
    assert.deepEqual(mcp.mcpServers["patchmesh"]!.args, ["packages/gateway/dist/bin.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init keeps the absolute path when the checkout is wiring some other repository", () => {
  // The one case where naming the machine is right: `$CLAUDE_PROJECT_DIR` points at the
  // repository being wired, and PatchMesh does not live inside it, so nothing
  // repository-relative resolves.
  const checkout = monorepoCheckout();
  const target = mkdtempSync(join(tmpdir(), "patchmesh-target-"));
  try {
    initializeRepository({ worktreeRoot: target, packageRoot: checkout });

    const settings = JSON.parse(readFileSync(join(target, ".claude", "settings.local.json"), "utf8")) as {
      hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]>;
    };
    const commands = Object.values(settings.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)));

    assert.ok(commands.length > 0);
    assert.ok(
      commands.every((command) => command.includes(checkout) && !command.includes("$CLAUDE_PROJECT_DIR")),
      "a checkout outside the repository being wired has to name itself",
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("init --force replaces PatchMesh's wiring without discarding the rest of the entry", () => {
  // `--force` means "replace PatchMesh's own wiring", not "drop whatever else is configured
  // here". Re-running it in this repository silently removed `"tools": ["*"]` from PatchMesh's
  // own MCP entry - the additive rule this module opens with, broken by the one branch that
  // rewrites instead of merging.
  const root = monorepoCheckout();
  try {
    initializeRepository({ worktreeRoot: root, packageRoot: root });
    const configPath = join(root, ".mcp.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as
      { mcpServers: Record<string, Record<string, unknown>> };
    config.mcpServers["patchmesh"]!["tools"] = ["*"];
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

    initializeRepository({ worktreeRoot: root, packageRoot: root, force: true });

    const after = JSON.parse(readFileSync(configPath, "utf8")) as
      { mcpServers: Record<string, Record<string, unknown>> };
    assert.deepEqual(after.mcpServers["patchmesh"]!["tools"], ["*"], "a key init does not manage must survive");
    assert.deepEqual(after.mcpServers["patchmesh"]!["args"], ["packages/gateway/dist/bin.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --host codex installs the codex MCP server once", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-codex-"));
  try {
    const first = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "codex" });
    const configPath = join(root, ".mcp.json");
    assert.equal(existsSync(configPath), true);
    // .mcp.json is created by registerServer (the standard MCP server), so the Codex
    // entry is "updated" (added to an existing file) rather than "created".
    assert.equal(
      first.steps.find((step) => step.detail.includes("Codex"))?.outcome,
      "updated",
      "the first run reports the Codex server as updated (added to existing .mcp.json)",
    );

    const config = JSON.parse(readFileSync(configPath, "utf8")) as
      { mcpServers: Record<string, { command: string; args: readonly string[] }> };
    assert.ok(config.mcpServers["patchmesh-codex"], "Codex MCP server must be registered");
    assert.equal(config.mcpServers["patchmesh-codex"]!.type, "stdio");

    const again = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "codex" });
    assert.equal(again.steps.some((step) => step.outcome === "unchanged"), true, "a second run reports unchanged");
    assert.equal(again.steps.some((step) => step.outcome === "created"), false, "a second run installs nothing twice");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --host generic-mcp registers the mcp tools once", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-generic-"));
  try {
    const first = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "generic-mcp" });
    const configPath = join(root, ".mcp.json");
    assert.equal(existsSync(configPath), true);
    // .mcp.json is created by registerServer (the standard MCP server), so the generic-mcp
    // entry is "updated" (added to an existing file) rather than "created".
    assert.equal(
      first.steps.find((step) => step.detail.includes("Generic MCP"))?.outcome,
      "updated",
      "the first run reports the generic MCP tools as updated (added to existing .mcp.json)",
    );

    const config = JSON.parse(readFileSync(configPath, "utf8")) as
      { mcpServers: Record<string, { command: string; description?: string }> };
    assert.ok(config.mcpServers["patchmesh-generic-mcp"], "Generic MCP tools must be registered");
    assert.equal(config.mcpServers["patchmesh-generic-mcp"]!.type, "stdio");
    assert.equal(config.mcpServers["patchmesh-generic-mcp"]!.command, "patchmesh-mcp");
    assert.equal(
      config.mcpServers["patchmesh-generic-mcp"]!.description,
      "Self-reported participation for MCP-only hosts (declared tier)",
    );

    const again = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "generic-mcp" });
    assert.equal(again.steps.some((step) => step.outcome === "unchanged"), true, "a second run reports unchanged");
    assert.equal(again.steps.some((step) => step.outcome === "created"), false, "a second run installs nothing twice");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --host all installs for detected hosts", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-all-"));
  try {
    // Set up OpenCode presence (create .opencode directory)
    mkdirSync(join(root, ".opencode"), { recursive: true });

    const result = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "all" });

    // Should have Claude Code hooks, OpenCode plugin, Generic MCP tools
    const details = result.steps.map((s) => s.detail);
    assert.ok(details.some((d) => d.includes("Claude Code hooks")), "Claude Code hooks should be installed");
    assert.ok(details.some((d) => d.includes("OpenCode")), "OpenCode plugin should be installed");
    assert.ok(details.some((d) => d.includes("Generic MCP")), "Generic MCP tools should be installed");

    // Codex should not be detected (no .codex directory)
    assert.ok(!details.some((d) => d.includes("Codex")), "Codex should not be installed without .codex directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --host all detects codex when .codex directory exists", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-all-codex-"));
  try {
    // Set up Codex presence (create .codex directory)
    mkdirSync(join(root, ".codex"), { recursive: true });

    const result = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "all" });

    const details = result.steps.map((s) => s.detail);
    assert.ok(details.some((d) => d.includes("Claude Code hooks")), "Claude Code hooks should be installed");
    assert.ok(details.some((d) => d.includes("Codex")), "Codex MCP server should be installed");
    assert.ok(details.some((d) => d.includes("Generic MCP")), "Generic MCP tools should be installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --host all detects codex when codex.json exists", () => {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-init-all-codexjson-"));
  try {
    // Set up Codex presence (create codex.json)
    writeFileSync(join(root, "codex.json"), "{}", "utf8");

    const result = initializeRepository({ worktreeRoot: root, packageRoot: "/pkg", host: "all" });

    const details = result.steps.map((s) => s.detail);
    assert.ok(details.some((d) => d.includes("Codex")), "Codex MCP server should be installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init --host rejects unsupported host values", async () => {
  const result = await runCli(["init", "--host", "unsupported-host"], dependencies);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unsupported host: unsupported-host/);
});
