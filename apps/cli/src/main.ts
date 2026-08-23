#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDaemon, type PatchMeshDaemon } from "patchmesh-daemon";
import {
  findOverlappingWork,
  ReadServiceError,
  recapRecentWork,
  type OverlapOptions,
  type OverlapResult,
  type ReadServices,
  type RecapOptions,
  type RecapResult,
  type StatusView,
} from "patchmesh-query";
import type { EventType } from "patchmesh-protocol";
import { findWorktreeRoot, ledgerPathFor } from "patchmesh-recorder";
import { parseArgs, usageText, type ParsedArgs } from "./args.js";
import { renderGraphServerBanner, startGraphServer, type GraphServer, type GraphServerOptions } from "./graph-server.js";
import { diagnose, renderDoctor } from "./doctor.js";
import { initializeRepository, renderInit } from "./init.js";
import {
  renderAgents,
  renderDecisionExplanation,
  renderDetectorUnavailable,
  renderDeliveryResponse,
  renderEvents,
  renderFeedbackResponse,
  renderFindings,
  renderGraph,
  renderOverlaps,
  renderPrune,
  renderRecap,
  renderStatus,
} from "./render.js";

export interface CliDependencies {
  readonly services: ReadServices;
  readonly feedbackWriter?: Pick<PatchMeshDaemon, "respondToFinding">;
  readonly deliveryWriter?: Pick<PatchMeshDaemon, "respondToDecisionDelivery">;
  /** Retention writer. Injected like the others so the command is testable without a store. */
  readonly pruner?: Pick<PatchMeshDaemon, "prune">;
  readonly signal?: AbortSignal;
  /**
   * Which checkout the ledger describes. `overlaps` resolves repository identity from it, so
   * the command answers about the repository the user is standing in rather than about a
   * database path. Tests inject it; the binary derives it from the working directory.
   */
  readonly worktreeRoot?: string;
  /**
   * Reads overlapping work. Injected like the writers above so the CLI stays testable without
   * a real checkout and a real ledger on disk - `overlaps` is the one report that does not go
   * through `ReadServices`, because the work-graph projection cannot answer it.
   */
  readonly readOverlaps?: (options: OverlapOptions) => OverlapResult;
  /** Reads a recap. Injected for the same reason as `readOverlaps`: it opens the store itself. */
  readonly readRecap?: (options: RecapOptions) => RecapResult;
  /**
   * Starts the work-graph site. Injected so a test can drive the real server on an ephemeral
   * port without the command reaching for the user's browser.
   */
  readonly serveGraph?: (options: GraphServerOptions) => Promise<GraphServer>;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set by commands that keep running after they have printed. `main` waits on it before
   * closing the store, so the served page can keep answering from a live ledger rather than
   * from a snapshot taken at launch.
   */
  readonly hold?: Promise<void>;
}

/** Stop serving when the process is interrupted, so Ctrl+C ends the command rather than the run. */
function stopOnAbort(signal: AbortSignal, server: GraphServer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { server.close(); resolve(); return; }
    signal.addEventListener("abort", () => { server.close(); resolve(); }, { once: true });
  });
}

function exitCode(error: ReadServiceError): number {
  return error.code === "usage" ? 2 : error.code === "unavailable" ? 3 : 4;
}

/**
 * The event types each graph-backed detector needs before it can find anything.
 *
 * Both were built against the MCP-proxy path, where a call declares which read it depended on
 * and which contract it changed. A host-hook recorder observes neither: a read leaves no trace
 * on disk to find, and nothing in a hook payload declares a dependency. Checking counts is not
 * a heuristic - it is asking whether the inputs the detector is typed against were ever
 * recorded at all.
 */
const DETECTOR_EVIDENCE = {
  stale: ["file.read", "write.dependent"],
  contracts: ["symbol.changed", "dependency.changed"],
} as const satisfies Record<string, readonly EventType[]>;

function missingDetectorEvidence(command: "stale" | "contracts", status: StatusView): readonly string[] {
  return DETECTOR_EVIDENCE[command].filter((eventType) => (status.eventTypeCounts[eventType] ?? 0) === 0);
}

async function renderCommand(
  parsed: ParsedArgs,
  services: ReadServices,
  feedbackWriter: CliDependencies["feedbackWriter"],
  deliveryWriter: CliDependencies["deliveryWriter"],
  pruner: CliDependencies["pruner"],
  worktreeRoot: string | null,
  readOverlaps: (options: OverlapOptions) => OverlapResult,
  readRecap: (options: RecapOptions) => RecapResult,
  signal?: AbortSignal,
): Promise<string> {
  if (parsed.command === "help") return `${usageText()}\n`;
  if (parsed.command === "init") {
    if (worktreeRoot === null) throw new ReadServiceError("usage", "init must be run inside a git repository");
    return renderInit(
      initializeRepository({
        worktreeRoot,
        installHooks: parsed.init.hooks,
        updateGitignore: parsed.init.gitignore,
        force: parsed.init.force,
      }),
      parsed.json,
    );
  }
  if (parsed.command === "prune") {
    if (pruner === undefined) throw new ReadServiceError("unavailable", "prune requires a writable event store");
    if (parsed.olderThanDays === null) throw new ReadServiceError("usage", "prune requires --older-than <days>");
    const cutoff = new Date(Date.now() - parsed.olderThanDays * 24 * 60 * 60_000);
    return renderPrune(pruner.prune({ olderThan: cutoff }), cutoff, parsed.json);
  }
  if (parsed.command === "recap") {
    if (worktreeRoot === null) {
      throw new ReadServiceError("unavailable", "recap needs a git worktree; run it inside the repository the ledger describes");
    }
    // The same answer `patchmesh_recap` gives an agent, given to the person. It was reachable
    // only over MCP, which meant the surface the product leads with could not be run by the
    // user reading the README that recommends it.
    return renderRecap(
      readRecap({
        worktreeRoot,
        ledgerPath: parsed.databasePath ?? "",
        ...(parsed.agentFilters.agentId === undefined ? {} : { agent: parsed.agentFilters.agentId }),
        ...(parsed.withinMinutes === null ? {} : { withinMinutes: parsed.withinMinutes }),
        ...(parsed.recapLimit === null ? {} : { limit: parsed.recapLimit }),
      }),
      parsed.agentFilters.agentId ?? undefined,
      parsed.json,
    );
  }
  if (parsed.command === "status") return renderStatus(services.getStatus(), parsed.json);
  if (parsed.command === "agents") return renderAgents(services.listAgents(parsed.agentFilters), parsed.json);
  if (parsed.command === "graph") return renderGraph(services.getGraph(parsed.graphFilters), parsed.json);
  if (parsed.command === "overlaps") {
    if (worktreeRoot === null) {
      throw new ReadServiceError("unavailable", "overlaps needs a git worktree; run it inside the repository the ledger describes");
    }
    return renderOverlaps(
      readOverlaps({
        worktreeRoot,
        ledgerPath: parsed.databasePath ?? "",
        path: parsed.graphFilters.resourceId,
        withinMinutes: parsed.withinMinutes ?? undefined,
      }),
      parsed.json,
    );
  }
  if (parsed.command === "stale" || parsed.command === "contracts") {
    const missing = missingDetectorEvidence(parsed.command, services.getStatus());
    if (missing.length > 0) return renderDetectorUnavailable(parsed.command, missing, parsed.json);
    const findingType = parsed.command === "stale" ? "stale_read_before_write" : "exported_contract_invalidation";
    return renderFindings(services.listFindings({ findingType }), parsed.json);
  }
  if (parsed.command === "explain") return renderDecisionExplanation(services.explainDecision(parsed.decisionId!), parsed.json);
  if (parsed.command === "feedback") {
    if (feedbackWriter === undefined) throw new ReadServiceError("unavailable", "finding feedback writer is unavailable");
    const feedback = parsed.feedback!;
    const result = feedbackWriter.respondToFinding({
      ...feedback,
      actor: {
        agentId: parsed.agentFilters.agentId ?? null,
        taskId: parsed.agentFilters.taskId ?? null,
      },
    });
    return renderFeedbackResponse(result, feedback.findingId, feedback.disposition, parsed.json);
  }
  if (parsed.command === "delivery") {
    if (deliveryWriter === undefined) throw new ReadServiceError("unavailable", "decision delivery writer is unavailable");
    const delivery = parsed.delivery!;
    const result = deliveryWriter.respondToDecisionDelivery(delivery);
    return renderDeliveryResponse(result, delivery.decisionId, delivery.state, parsed.json);
  }
  if (!parsed.follow) return renderEvents(services.listEvents(parsed.eventQuery), parsed.json);
  let output = "";
  for await (const page of services.followEvents(parsed.eventQuery, signal)) output += renderEvents(page, parsed.json);
  return output;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  try {
    const parsed = parseArgs(argv);
    const worktreeRoot = dependencies.worktreeRoot ?? findWorktreeRoot(process.cwd());
    // Handled before `renderCommand` because it is the one report whose exit code carries the
    // answer. Every other command exits 0 when it successfully reports bad news; a health check
    // that did the same could not be used to gate anything.
    if (parsed.command === "doctor") {
      const report = diagnose({ worktreeRoot });
      return { exitCode: report.healthy ? 0 : 3, stdout: renderDoctor(report, parsed.json), stderr: "" };
    }
    // Serving is handled before `renderCommand` because it is the one command that outlives
    // its own output: it returns a handle the caller has to hold, not a rendered string.
    if (parsed.command === "graph" && parsed.graphOutput.mode === "site") {
      const ledger = parsed.databasePath ?? "";
      const server = await (dependencies.serveGraph ?? startGraphServer)({
        services: dependencies.services,
        filters: parsed.graphFilters,
        ledger,
        ...(parsed.graphOutput.port === null ? {} : { port: parsed.graphOutput.port }),
      });
      return {
        exitCode: 0,
        stdout: renderGraphServerBanner(server.url, ledger),
        stderr: "",
        hold: dependencies.signal === undefined
          ? server.closed
          : Promise.race([server.closed, stopOnAbort(dependencies.signal, server)]),
      };
    }
    return {
      exitCode: 0,
      stdout: await renderCommand(
        parsed,
        dependencies.services,
        dependencies.feedbackWriter,
        dependencies.deliveryWriter,
        dependencies.pruner,
        worktreeRoot,
        dependencies.readOverlaps ?? findOverlappingWork,
        dependencies.readRecap ?? recapRecentWork,
        dependencies.signal,
      ),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof ReadServiceError) return { exitCode: exitCode(error), stdout: "", stderr: `${error.message}\n` };
    return { exitCode: 4, stdout: "", stderr: "PatchMesh command failed\n" };
  }
}

/** Commands that answer without reading the ledger, so they must not require one. */
function needsNoStore(argv: readonly string[]): boolean {
  const command = argv[0];
  // `doctor` belongs here for the same reason `init` does, and more strongly: it is the
  // command you run *because* the ledger is missing, so gating it behind one would refuse to
  // answer exactly the question it exists for.
  return command === "init" || command === "doctor" || command === "help" || command === "--help" || command === "-h";
}

/**
 * Commands that only report, so an absent ledger is an answer rather than a failure.
 *
 * The write commands are deliberately absent: `feedback` and `delivery` append events, and a
 * missing store means they recorded nothing. Exiting 0 there would report success for work
 * that did not happen.
 */
const REPORT_ONLY = new Set(["status", "recap", "agents", "events", "graph", "overlaps", "stale", "contracts", "explain"]);

/**
 * What a repository looks like before it has been worked in.
 *
 * The first thing a new user runs is `patchmesh status`, and before this the first thing
 * PatchMesh said to them was `database is unavailable` — which reads as a broken tool rather
 * than an empty one. Nothing has gone wrong: the recorder creates the ledger on its first
 * write, so no file is the honest state of a repository whose agent has not run yet.
 */
function renderNoLedger(path: string, json: boolean): string {
  if (json) return `${JSON.stringify({ ledger: path, exists: false, events: 0 })}\n`;
  return [
    `No ledger at ${path} yet, so nothing has been recorded.`,
    "",
    "If you have not run `patchmesh init` in this repository, run it and restart the agent",
    "session so it loads the hooks. If you have, work normally and come back — the recorder",
    "creates the ledger on the first tool call it sees.",
    "",
  ].join("\n");
}

/**
 * Read services for a command that never reads. Every method throws rather than returning an
 * empty answer, so a command routed here by mistake fails loudly instead of reporting nothing.
 */
function unavailableServices(): ReadServices {
  const unavailable = (): never => {
    throw new ReadServiceError("unavailable", "this command does not read the event store");
  };
  return new Proxy({} as ReadServices, { get: () => unavailable });
}

/**
 * Which ledger to read, defaulting to the one this repository owns.
 *
 * The recorder writes to `<worktree>/.patchmesh/ledger.db` and nowhere else -- the path is a
 * convention, not a configurable. Requiring `--database` on every invocation made the user
 * retype a value that has exactly one correct answer, and got it wrong whenever they ran the
 * command from a subdirectory. `--database` still wins when given, because reading a ledger
 * copied from somewhere else is a real thing to want.
 */
function databasePath(argv: readonly string[]): string {
  const index = argv.indexOf("--database");
  const explicit = index === -1 ? undefined : argv[index + 1];
  if (explicit !== undefined) return explicit;

  const worktreeRoot = findWorktreeRoot(process.cwd());
  if (worktreeRoot === null) {
    throw new ReadServiceError(
      "usage",
      "not inside a git repository, so there is no ledger to default to; pass --database <path>",
    );
  }
  return ledgerPathFor(worktreeRoot);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let daemon: PatchMeshDaemon | null = null;
  try {
    // `init` and `help` run before there is anything to read, so neither may be gated behind
    // an event store that init itself is the reason the user does not have yet.
    if (needsNoStore(argv)) {
      const result = await runCli(argv, { services: unavailableServices() });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return result.exitCode;
    }
    const ledgerPath = databasePath(argv);
    if (!existsSync(ledgerPath) && REPORT_ONLY.has(argv[0] ?? "")) {
      process.stdout.write(renderNoLedger(ledgerPath, argv.includes("--json")));
      return 0;
    }
    // Hand the resolved path back to the parser rather than only to the daemon. `overlaps`
    // reads `parsed.databasePath` on its own, so defaulting in one place and not the other
    // would leave it opening the empty string while every other command worked.
    const resolvedArgv = argv.includes("--database") ? argv : [...argv, "--database", ledgerPath];
    daemon = createDaemon({ databasePath: ledgerPath });
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    const result = await runCli(resolvedArgv, {
      services: daemon.services,
      feedbackWriter: daemon,
      deliveryWriter: daemon,
      pruner: daemon,
      signal: controller.signal,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.hold !== undefined) await result.hold;
    process.removeListener("SIGINT", onInterrupt);
    return result.exitCode;
  } catch (error) {
    const result = error instanceof ReadServiceError
      ? { exitCode: exitCode(error), message: `${error.message}\n` }
      : { exitCode: 4, message: "PatchMesh command failed\n" };
    process.stderr.write(result.message);
    return result.exitCode;
  } finally {
    daemon?.close();
  }
}

/**
 * Was this module run as the program, rather than imported by a test?
 *
 * Compared against the *resolved* path of `argv[1]`, not its literal value. A global install
 * puts a symlink on `PATH` -- `npm link` always, and a package manager's global store often --
 * so `argv[1]` is the link while `import.meta.url` is what it points at. Comparing the two
 * strings made every symlinked install exit 0 with no output at all: the CLI loaded, decided
 * it was a library, and returned.
 */
function runAsProgram(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // `argv[1]` did not resolve to a file on disk, so this is not that file.
    return false;
  }
}

if (runAsProgram()) {
  const code = await main();
  process.exitCode = code;
}
