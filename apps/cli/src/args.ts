import type { DecisionDelivery, DecisionId, EventType, FindingId, FindingFeedback } from "@patchmesh/protocol";
import { ReadServiceError, type AgentFilters, type EventListQuery, type GraphFilters } from "@patchmesh/query";

export type CommandName = "status" | "agents" | "events" | "graph" | "overlaps" | "stale" | "explain" | "feedback" | "delivery";

export interface ParsedArgs {
  readonly command: CommandName;
  readonly databasePath: string | null;
  readonly json: boolean;
  readonly raw: boolean;
  readonly follow: boolean;
  readonly agentFilters: AgentFilters;
  readonly eventQuery: EventListQuery;
  readonly graphFilters: GraphFilters;
  readonly decisionId: DecisionId | null;
  readonly feedback: {
    readonly findingId: FindingId;
    readonly decisionId: DecisionId | null;
    readonly disposition: FindingFeedback["disposition"];
    readonly useful: boolean | null;
    readonly reason: string | null;
  } | null;
  readonly delivery: {
    readonly decisionId: DecisionId;
    readonly state: DecisionDelivery["state"];
  } | null;
}

const commands = new Set<CommandName>(["status", "agents", "events", "graph", "overlaps", "stale", "explain", "feedback", "delivery"]);
const eventTypes = new Set<EventType>([
  "tool.requested", "tool.completed", "file.read", "file.changed", "symbol.read",
  "symbol.changed", "task.completed", "dependency.changed", "attribution.corrected",
  "finding.created", "finding.feedback.created", "write.dependent", "decision.created", "validity.changed", "decision.delivery.changed",
]);
const dispositions = new Set<FindingFeedback["disposition"]>(["dismissed", "acknowledged", "not_affected", "already_handled", "needs_more_information"]);
const deliveryStates = new Set<DecisionDelivery["state"]>(["pending", "delivered", "acknowledged", "failed"]);

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
  let decisionId: DecisionId | null = null;
  let findingId: FindingId | null = null;
  let feedbackDecisionId: DecisionId | null = null;
  let disposition: FindingFeedback["disposition"] | null = null;
  let useful: boolean | null = null;
  let reason: string | null = null;
  let deliveryDecisionId: DecisionId | null = null;
  let deliveryState: DecisionDelivery["state"] | null = null;

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === undefined) throw new ReadServiceError("usage", "option is missing");
    if (command === "explain" && index === 1 && !option.startsWith("--")) {
      decisionId = option as DecisionId;
      continue;
    }
    if (command === "feedback" && index === 1 && !option.startsWith("--")) {
      findingId = option as FindingId;
      continue;
    }
    if (command === "delivery" && index === 1 && !option.startsWith("--")) {
      deliveryDecisionId = option as DecisionId;
      continue;
    }
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
    if (option === "--decision" && command === "feedback") { feedbackDecisionId = value(argv, index, option) as DecisionId; index += 1; continue; }
    if (option === "--disposition" && command === "feedback") {
      const valueForOption = value(argv, index, option) as FindingFeedback["disposition"];
      if (!dispositions.has(valueForOption)) throw new ReadServiceError("usage", "unknown feedback disposition");
      disposition = valueForOption;
      index += 1;
      continue;
    }
    if (option === "--useful" && command === "feedback") {
      const valueForOption = value(argv, index, option);
      if (valueForOption !== "true" && valueForOption !== "false") throw new ReadServiceError("usage", "useful must be true or false");
      useful = valueForOption === "true";
      index += 1;
      continue;
    }
    if (option === "--reason" && command === "feedback") { reason = value(argv, index, option); index += 1; continue; }
    if (option === "--state" && command === "delivery") {
      const valueForOption = value(argv, index, option) as DecisionDelivery["state"];
      if (!deliveryStates.has(valueForOption)) throw new ReadServiceError("usage", "unknown delivery state");
      deliveryState = valueForOption;
      index += 1;
      continue;
    }
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
  if (command === "explain" && decisionId === null) throw new ReadServiceError("usage", "explain requires a decision ID");
  if (command === "feedback" && findingId === null) throw new ReadServiceError("usage", "feedback requires a finding ID");
  if (command === "feedback" && disposition === null) throw new ReadServiceError("usage", "feedback requires a disposition");
  if (command === "delivery" && deliveryDecisionId === null) throw new ReadServiceError("usage", "delivery requires a decision ID");
  if (command === "delivery" && deliveryState === null) throw new ReadServiceError("usage", "delivery requires a state");
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
    decisionId,
    feedback: command === "feedback" ? {
      findingId: findingId!,
      decisionId: feedbackDecisionId,
      disposition: disposition!,
      useful,
      reason,
    } : null,
    delivery: command === "delivery" ? { decisionId: deliveryDecisionId!, state: deliveryState! } : null,
  };
}
