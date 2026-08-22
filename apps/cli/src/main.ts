import { pathToFileURL } from "node:url";
import { createDaemon, type PatchMeshDaemon } from "@patchmesh/daemon";
import {
  findOverlappingWork,
  ReadServiceError,
  type OverlapOptions,
  type OverlapResult,
  type ReadServices,
  type StatusView,
} from "@patchmesh/query";
import type { EventType } from "@patchmesh/protocol";
import { findWorktreeRoot } from "@patchmesh/recorder";
import { parseArgs, usageText, type ParsedArgs } from "./args.js";
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
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
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
  return command === "init" || command === "help" || command === "--help" || command === "-h";
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

function databasePath(argv: readonly string[]): string {
  const index = argv.indexOf("--database");
  const path = index === -1 ? undefined : argv[index + 1];
  if (path === undefined) throw new ReadServiceError("usage", "--database is required");
  return path;
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
    daemon = createDaemon({ databasePath: databasePath(argv) });
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    const result = await runCli(argv, {
      services: daemon.services,
      feedbackWriter: daemon,
      deliveryWriter: daemon,
      pruner: daemon,
      signal: controller.signal,
    });
    process.removeListener("SIGINT", onInterrupt);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exitCode = code;
}
