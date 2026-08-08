import type { EventType } from "@patchmesh/protocol";
import { ReadServiceError, type AgentFilters, type EventListQuery, type GraphFilters } from "@patchmesh/query";

export type CommandName = "status" | "agents" | "events" | "graph";

export interface ParsedArgs {
  readonly command: CommandName;
  readonly databasePath: string | null;
  readonly json: boolean;
  readonly raw: boolean;
  readonly follow: boolean;
  readonly agentFilters: AgentFilters;
  readonly eventQuery: EventListQuery;
  readonly graphFilters: GraphFilters;
}

const commands = new Set<CommandName>(["status", "agents", "events", "graph"]);
const eventTypes = new Set<EventType>([
  "tool.requested", "tool.completed", "file.read", "file.changed", "symbol.read",
  "symbol.changed", "task.completed", "dependency.changed", "attribution.corrected",
  "finding.created", "decision.created", "validity.changed", "decision.delivery.changed",
]);

function value(argv: readonly string[], index: number, option: string): string {
  const result = argv[index + 1];
  if (result === undefined || result.startsWith("--")) throw new ReadServiceError("usage", `${option} requires a value`);
  return result;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const commandValue = argv[0];
  if (commandValue === undefined || !commands.has(commandValue as CommandName)) {
    throw new ReadServiceError("usage", `unsupported command: ${commandValue ?? ""}`);
  }
  const command = commandValue as CommandName;
  let databasePath: string | null = null;
  let json = false;
  let raw = false;
  let follow = false;
  let agentId: AgentFilters["agentId"];
  let taskId: AgentFilters["taskId"];
  let eventType: EventType | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let limit: number | undefined;
  let cursor: EventListQuery["cursor"];
  let resourceId: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) throw new ReadServiceError("usage", "option is missing");
    if (option === "--json") { json = true; continue; }
    if (option === "--raw" && command === "events") { raw = true; continue; }
    if (option === "--follow" && command === "events") { follow = true; continue; }
    if (option === "--database") { databasePath = value(argv, index, option); index += 1; continue; }
    if (option === "--agent") { agentId = value(argv, index, option) as AgentFilters["agentId"]; index += 1; continue; }
    if (option === "--task") {
      const task = value(argv, index, option);
      taskId = task === "null" ? null : task as AgentFilters["taskId"];
      index += 1;
      continue;
    }
    if (option === "--resource" && command === "graph") { resourceId = value(argv, index, option); index += 1; continue; }
    if (option === "--type" && command === "events") {
      const type = value(argv, index, option);
      if (!eventTypes.has(type as EventType)) throw new ReadServiceError("usage", `unknown event type: ${type}`);
      eventType = type as EventType;
      index += 1;
      continue;
    }
    if (["--since", "--until", "--cursor"].includes(option) && command === "events") {
      const optionValue = value(argv, index, option);
      if (option === "--since") since = optionValue;
      if (option === "--until") until = optionValue;
      if (option === "--cursor") cursor = optionValue as EventListQuery["cursor"];
      index += 1;
      continue;
    }
    if (option === "--limit" && command === "events") {
      const parsed = Number(value(argv, index, option));
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ReadServiceError("usage", "limit must be a positive integer");
      limit = parsed;
      index += 1;
      continue;
    }
    throw new ReadServiceError("usage", `unsupported option: ${option}`);
  }

  if (command === "agents" && (raw || follow)) throw new ReadServiceError("usage", "unsupported agents option");
  if (command !== "events" && (raw || follow || eventType !== undefined || since !== undefined || until !== undefined || limit !== undefined || cursor !== undefined)) {
    throw new ReadServiceError("usage", "event options require the events command");
  }
  return {
    command,
    databasePath,
    json,
    raw,
    follow,
    agentFilters: { ...(agentId === undefined ? {} : { agentId }), ...(taskId === undefined ? {} : { taskId }) },
    eventQuery: {
      ...(agentId === undefined ? {} : { agentId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(eventType === undefined ? {} : { eventType }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    },
    graphFilters: {
      ...(agentId === undefined ? {} : { agentId }),
      ...(taskId === undefined || taskId === null ? {} : { taskId }),
      ...(resourceId === undefined ? {} : { resourceId }),
    },
  };
}
