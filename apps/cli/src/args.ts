import type { DecisionDelivery, DecisionId, EventType, FindingId, FindingFeedback } from "patchmesh-protocol";
import { ReadServiceError, type AgentFilters, type EventListQuery, type GraphFilters } from "patchmesh-query";

export type CommandName = "init" | "doctor" | "prune" | "status" | "recap" | "agents" | "events" | "graph" | "overlaps" | "stale" | "contracts" | "explain" | "feedback" | "delivery" | "help";

export interface ParsedArgs {
  readonly command: CommandName;
  readonly databasePath: string | null;
  readonly json: boolean;
  readonly raw: boolean;
  readonly follow: boolean;
  readonly agentFilters: AgentFilters;
  readonly eventQuery: EventListQuery;
  readonly graphFilters: GraphFilters;
  /**
   * How `graph` should answer. `site` serves the explorer and is the default, because a
   * thousand rows of nodes and edges is a data dump rather than an answer; `text` and `json`
   * stay reachable for a pipe.
   */
  readonly graphOutput: { readonly mode: "site" | "text" | "json"; readonly port: number | null };
  readonly decisionId: DecisionId | null;
  /** How far back `overlaps` and `recap` look, in minutes. Null uses the query's own default. */
  readonly withinMinutes: number | null;
  /** How many tasks `recap` describes. Null uses the recap's own default. */
  readonly recapLimit: number | null;
  /**
   * `recap --metrics`: report time-to-resume instead of the recap itself.
   *
   * It lives under `recap` rather than as its own command because it measures exactly what
   * recap is for — the orientation a resumed session pays for — and a separate command would
   * invite reading the two as unrelated numbers.
   */
  readonly recapMetrics: boolean;
  readonly init: { readonly hooks: boolean; readonly gitignore: boolean; readonly force: boolean };
  /** Retention cutoff for `prune`, in days. Null means the command was not asked for one. */
  readonly olderThanDays: number | null;
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

const commands = new Set<CommandName>(["init", "doctor", "prune", "status", "recap", "agents", "events", "graph", "overlaps", "stale", "contracts", "explain", "feedback", "delivery", "help"]);
const eventTypes = new Set<EventType>([
  "tool.requested", "tool.completed", "file.read", "file.changed", "symbol.read",
  "symbol.changed", "task.completed", "dependency.changed", "attribution.corrected",
  "evidence.derived",
  "finding.created", "finding.feedback.created", "write.dependent", "decision.created", "validity.changed", "decision.delivery.changed",
]);
const dispositions = new Set<FindingFeedback["disposition"]>(["dismissed", "acknowledged", "not_affected", "already_handled", "needs_more_information"]);
const deliveryStates = new Set<DecisionDelivery["state"]>(["pending", "delivered", "acknowledged", "failed"]);

export function usageText(): string {
  return [
    "Usage: patchmesh <command> [options]",
    "",
    "Setup:",
    "  init                       Wire PatchMesh into this repository (--force, --no-hooks,",
    "                             --no-gitignore)",
    "  doctor                     Check that recording is actually working here",
    "",
    "  prune --older-than <days> Delete events past a retention cutoff, keeping replay intact",
    "",
    "Report-only commands:",
    "  recap                      What previous sessions did (--within <minutes>, --limit <n>,",
    "                             --agent) — start here",
    "  recap --metrics            Calls an agent makes before its first change (time to resume)",
    "  status                     Store health, counts, and observation coverage",
    "  agents                     Observed agents and their tasks",
    "  events                     Durable event page (--raw, --follow, --type, --since,",
    "                             --until, --limit, --cursor)",
    "  graph                      Serve the work-graph explorer and print its link",
    "                             (--resource, --print, --port <n>)",
    "  overlaps                   Files more than one worker changed (--resource, --within)",
    "  stale                      Stale-read-before-write findings (needs proxy-recorded",
    "                             read and dependent-write evidence)",
    "  contracts                  Exported-contract invalidation findings (needs proxy-recorded",
    "                             symbol and dependency evidence)",
    "  explain <decision-id>      Full explanation for one decision",
    "",
    "Append-only response commands:",
    "  feedback <finding-id> --disposition <d> [--decision <id>] [--useful true|false]",
    "                             [--reason <text>]",
    "  delivery <decision-id> --state <pending|delivered|acknowledged|failed>",
    "",
    "Common options:",
    "  --database <path>          Event store to read (defaults to .patchmesh/ledger.db",
    "                             in this repository)",
    "  --json                     Machine-readable output",
    "  --agent <id>, --task <id|null>",
    "  --help, -h                 Show this message",
    "",
    "Dispositions: dismissed, acknowledged, not_affected, already_handled,",
    "              needs_more_information",
    "",
    "PatchMesh is report-only. No command pauses, rejects, or redirects an agent.",
  ].join("\n");
}

function value(argv: readonly string[], index: number, option: string): string {
  const result = argv[index + 1];
  if (result === undefined || result.startsWith("--")) throw new ReadServiceError("usage", `${option} requires a value`);
  return result;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const commandValue = argv[0] === "--help" || argv[0] === "-h" ? "help" : argv[0];
  if (commandValue === undefined || !commands.has(commandValue as CommandName)) {
    // Naming the available commands is the difference between a dead end and a
    // recoverable mistake; the exit code stays `usage` either way.
    throw new ReadServiceError(
      "usage",
      `unsupported command: ${commandValue ?? ""}\n${usageText()}`,
    );
  }
  const command = commandValue as CommandName;
  if (command === "help") {
    return {
      command,
      databasePath: null,
      withinMinutes: null,
      recapLimit: null,
      recapMetrics: false,
      olderThanDays: null,
      init: { hooks: true, gitignore: true, force: false },
      json: false,
      raw: false,
      follow: false,
      agentFilters: {},
      eventQuery: {},
      graphFilters: {},
      graphOutput: { mode: "site", port: null },
      decisionId: null,
      feedback: null,
      delivery: null,
    };
  }
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
  let withinMinutes: number | null = null;
  let recapLimit: number | null = null;
  let recapMetrics = false;
  let graphPrint = false;
  let graphPort: number | null = null;
  let initHooks = true;
  let initGitignore = true;
  let initForce = false;
  let olderThanDays: number | null = null;
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
    if (option === "--no-hooks" && command === "init") { initHooks = false; continue; }
    if (option === "--no-gitignore" && command === "init") { initGitignore = false; continue; }
    if (option === "--force" && command === "init") { initForce = true; continue; }
    if (option === "--older-than" && command === "prune") {
      const days = Number(value(argv, index, option));
      if (!Number.isInteger(days) || days < 0) throw new ReadServiceError("usage", "--older-than takes a whole number of days");
      olderThanDays = days;
      index += 1;
      continue;
    }
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
    if (option === "--resource" && (command === "graph" || command === "overlaps")) { resourceId = value(argv, index, option); index += 1; continue; }
    if (option === "--print" && command === "graph") { graphPrint = true; continue; }
    if (option === "--port" && command === "graph") {
      const port = Number(value(argv, index, option));
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ReadServiceError("usage", "--port takes a whole number between 0 and 65535");
      graphPort = port;
      index += 1;
      continue;
    }
    if (option === "--within" && (command === "overlaps" || command === "recap")) {
      const minutes = Number(value(argv, index, option));
      if (!Number.isInteger(minutes) || minutes <= 0) throw new ReadServiceError("usage", "--within takes a positive whole number of minutes");
      withinMinutes = minutes;
      index += 1;
      continue;
    }
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
    // `recap --metrics` takes the same two bounds, but means something different by them: they
    // select sessions by when each one started, not events by when they happened. See
    // `ResumeMetricsOptions.since`.
    if (["--since", "--until"].includes(option) && command === "recap") {
      const optionValue = value(argv, index, option);
      if (option === "--since") since = optionValue;
      if (option === "--until") until = optionValue;
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
    if (option === "--metrics" && command === "recap") { recapMetrics = true; continue; }
    if (option === "--limit" && command === "recap") {
      const parsed = Number(value(argv, index, option));
      if (!Number.isInteger(parsed) || parsed <= 0) throw new ReadServiceError("usage", "--limit takes a positive whole number of tasks");
      recapLimit = parsed;
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
  if (command === "recap" && !recapMetrics && (since !== undefined || until !== undefined)) {
    throw new ReadServiceError("usage", "--since and --until apply to recap --metrics; use --within for a recap");
  }
  if (command !== "events" && (raw || follow || eventType !== undefined || limit !== undefined || cursor !== undefined)) {
    throw new ReadServiceError("usage", "event options require the events command");
  }
  if (command !== "events" && command !== "recap" && (since !== undefined || until !== undefined)) {
    throw new ReadServiceError("usage", "event options require the events command");
  }
  return {
    command,
    databasePath,
    withinMinutes,
    recapLimit,
    recapMetrics,
    olderThanDays,
    init: { hooks: initHooks, gitignore: initGitignore, force: initForce },
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
    graphOutput: {
      mode: json ? "json" : graphPrint ? "text" : "site",
      port: graphPort,
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
