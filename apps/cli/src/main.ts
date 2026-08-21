import { pathToFileURL } from "node:url";
import { createDaemon, type PatchMeshDaemon } from "@patchmesh/daemon";
import { ReadServiceError, type ReadServices } from "@patchmesh/query";
import { parseArgs, usageText, type ParsedArgs } from "./args.js";
import {
  renderAgents,
  renderDecisionExplanation,
  renderDeliveryResponse,
  renderEvents,
  renderFeedbackResponse,
  renderFindings,
  renderGraph,
  renderStatus,
} from "./render.js";

export interface CliDependencies {
  readonly services: ReadServices;
  readonly feedbackWriter?: Pick<PatchMeshDaemon, "respondToFinding">;
  readonly deliveryWriter?: Pick<PatchMeshDaemon, "respondToDecisionDelivery">;
  readonly signal?: AbortSignal;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function exitCode(error: ReadServiceError): number {
  return error.code === "usage" ? 2 : error.code === "unavailable" ? 3 : 4;
}

async function renderCommand(
  parsed: ParsedArgs,
  services: ReadServices,
  feedbackWriter: CliDependencies["feedbackWriter"],
  deliveryWriter: CliDependencies["deliveryWriter"],
  signal?: AbortSignal,
): Promise<string> {
  if (parsed.command === "help") return `${usageText()}\n`;
  if (parsed.command === "status") return renderStatus(services.getStatus(), parsed.json);
  if (parsed.command === "agents") return renderAgents(services.listAgents(parsed.agentFilters), parsed.json);
  if (parsed.command === "graph") return renderGraph(services.getGraph(parsed.graphFilters), parsed.json);
  if (parsed.command === "overlaps") return renderFindings(services.listFindings({ findingType: "same_symbol_overlap" }), parsed.json);
  if (parsed.command === "stale") return renderFindings(services.listFindings({ findingType: "stale_read_before_write" }), parsed.json);
  if (parsed.command === "contracts") return renderFindings(services.listFindings({ findingType: "exported_contract_invalidation" }), parsed.json);
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
    return { exitCode: 0, stdout: await renderCommand(parsed, dependencies.services, dependencies.feedbackWriter, dependencies.deliveryWriter, dependencies.signal), stderr: "" };
  } catch (error) {
    if (error instanceof ReadServiceError) return { exitCode: exitCode(error), stdout: "", stderr: `${error.message}\n` };
    return { exitCode: 4, stdout: "", stderr: "PatchMesh command failed\n" };
  }
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
    daemon = createDaemon({ databasePath: databasePath(argv) });
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    const result = await runCli(argv, { services: daemon.services, feedbackWriter: daemon, deliveryWriter: daemon, signal: controller.signal });
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
