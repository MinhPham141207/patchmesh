import { pathToFileURL } from "node:url";
import { createDaemon, type PatchMeshDaemon } from "@patchmesh/daemon";
import { ReadServiceError, type ReadServices } from "@patchmesh/query";
import { parseArgs, type ParsedArgs } from "./args.js";
import { renderAgents, renderEvents, renderGraph, renderStatus } from "./render.js";

export interface CliDependencies {
  readonly services: ReadServices;
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

async function renderCommand(parsed: ParsedArgs, services: ReadServices, signal?: AbortSignal): Promise<string> {
  if (parsed.command === "status") return renderStatus(services.getStatus(), parsed.json);
  if (parsed.command === "agents") return renderAgents(services.listAgents(parsed.agentFilters), parsed.json);
  if (parsed.command === "graph") return renderGraph(services.getGraph(parsed.graphFilters), parsed.json);
  if (!parsed.follow) return renderEvents(services.listEvents(parsed.eventQuery), parsed.json);
  let output = "";
  for await (const page of services.followEvents(parsed.eventQuery, signal)) output += renderEvents(page, parsed.json);
  return output;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  try {
    const parsed = parseArgs(argv);
    return { exitCode: 0, stdout: await renderCommand(parsed, dependencies.services, dependencies.signal), stderr: "" };
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
    const result = await runCli(argv, { services: daemon.services, signal: controller.signal });
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
