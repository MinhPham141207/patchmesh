import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  ActiveWork,
  ActiveWorkOptions,
  AcknowledgeMessageOptions,
  InboxOptions,
  InboxResult,
  InboxRow,
  MarkDeliveredOptions,
  OverlapOptions,
  OverlapResult,
  RecapOptions,
  RecapResult,
  SendMailOptions,
} from "patchmesh-query";
import type { RecallOptions, RecallResult } from "./recall.js";
import { measurementPathFor } from "./measure.js";

export interface GatewayOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath?: string | undefined;
}

/**
 * The MCP surface PatchMesh exposes back to agents.
 *
 * This is the first thing the ledger does *for* an agent rather than for a person reading a
 * CLI afterwards. It is read-only and advisory by construction: PatchMesh is report-only, so
 * nothing here can pause, reject, or redirect the caller.
 */
/**
 * The version this build actually is, read from the package manifest beside it.
 *
 * It was a literal, so the handshake kept announcing 0.1.0 to every client no matter which
 * release was running. Falls back rather than throwing: an unreadable manifest is not a reason
 * to refuse to serve, and "0.0.0" is visibly wrong in a way a stale real version is not.
 */
function serverVersion(): string {
  try {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The packages that actually read the ledger, loaded once on first `tools/call` rather than at
 * construction.
 *
 * `patchmesh-recorder`, `patchmesh-query`, and this module's own `./recall.js` (which pulls in
 * both, plus `patchmesh-storage`) cost roughly 500-800ms combined to import. A client that only
 * ever sends `initialize` and `tools/list` -- the median session, measured against the ledger --
 * was paying that in full for work it never asked for, on top of the MCP SDK's own ~1s. This is
 * the same shape `patchmesh-protocol`'s eager validator compilation was fixed for once already:
 * a low-level package's import cost is multiplied by every consumer, so work only some callers
 * need belongs behind first use, not at module scope. Memoized so three tools sharing one
 * process pay the cost once, on whichever call comes first, not once each.
 */
let heavy:
  | Promise<{
      readonly ledgerPathFor: (worktreeRoot: string) => string;
      readonly ledgerDirectory: string;
      readonly freshenLedger: (options: { worktreeRoot: string; ledgerPath: string }) => Promise<unknown>;
      readonly recallRecentActivity: (options: RecallOptions) => RecallResult;
      readonly renderRecall: (result: RecallResult, requestedPath: string | undefined) => string;
      readonly findOverlappingWork: (options: OverlapOptions) => OverlapResult;
      readonly renderOverlap: (result: OverlapResult, requestedPath: string | undefined) => string;
      readonly recapRecentWork: (options: RecapOptions) => RecapResult;
      readonly renderRecap: (result: RecapResult, agent: string | undefined) => string;
      readonly readActiveWork: (options: ActiveWorkOptions) => ActiveWork;
      readonly renderActiveWork: (result: ActiveWork) => string;
      readonly sendMail: (options: SendMailOptions) => { readonly messageId: string };
      readonly readInbox: (options: InboxOptions) => InboxResult;
      readonly idShortener: (ids: Iterable<string>) => (id: string) => string;
      readonly markDelivered: (options: MarkDeliveredOptions) => void;
      readonly renderUntrustedMessage: (row: InboxRow, shortFrom: string) => string;
      readonly recordMailboxMarkFailure: (options: {
        readonly answersPath: string;
        readonly source: "session_start" | "mcp";
        readonly agentId: string;
        readonly messageIds: readonly string[];
      }) => void;
      readonly acknowledgeMessage: (
        options: AcknowledgeMessageOptions,
      ) => { readonly ok: boolean; readonly reason?: string };
      readonly readInFlightCalls: (
        options: import("patchmesh-recorder").ReadInFlightOptions,
      ) => readonly import("patchmesh-recorder").InFlightCall[];
    }>
  | undefined;

function loadHeavy(): NonNullable<typeof heavy> {
  heavy ??= Promise.all([
    import("patchmesh-recorder"),
    import("patchmesh-query"),
    import("./recall.js"),
    import("./mailbox-inject.js"),
  ]).then(([recorder, query, recall, mailboxInject]) => ({
    ledgerPathFor: recorder.ledgerPathFor,
    ledgerDirectory: recorder.LEDGER_DIRECTORY,
    // Every tool drains the journal before reading. Free when there is nothing waiting; see
    // `freshenLedger` for why a report answers about now rather than about the last Stop.
    freshenLedger: recorder.freshenLedger,
    recallRecentActivity: recall.recallRecentActivity,
    renderRecall: recall.renderRecall,
    findOverlappingWork: query.findOverlappingWork,
    renderOverlap: query.renderOverlap,
    recapRecentWork: query.recapRecentWork,
    renderRecap: query.renderRecap,
    readActiveWork: query.readActiveWork,
    renderActiveWork: query.renderActiveWork,
    sendMail: query.sendMail,
    readInbox: query.readInbox,
    idShortener: query.idShortener,
    markDelivered: query.markDelivered,
    renderUntrustedMessage: mailboxInject.renderUntrustedMessage,
    recordMailboxMarkFailure: mailboxInject.recordMailboxMarkFailure,
    acknowledgeMessage: query.acknowledgeMessage,
    readInFlightCalls: recorder.readInFlightCalls,
  }));
  return heavy;
}

export function createGatewayServer(options: GatewayOptions): McpServer {
  const server = new McpServer({ name: "patchmesh", version: serverVersion() });

  server.registerTool(
    "patchmesh_recent_activity",
    {
      title: "Recent agent activity",
      description:
        "**Call this before your first edit to a file, with that file's `path`.** It answers " +
        "whether another agent or subagent has been in the file recently, who, when, and under " +
        "which task - which is not recoverable from the file's contents or from git, because " +
        "work in flight has not been committed yet. Also worth a call before picking up a task " +
        "somebody may already be doing. Costs one small answer; the alternative is discovering " +
        "the collision after both edits exist. Reports history only - it does not judge whether " +
        "two agents conflict, and the ledger records which file was touched, not what changed " +
        "inside it. Answers identify workers by a shortened id; pass `excludeAgentId` with your " +
        "own agent id, which the PatchMesh session-start context names, to leave your own calls " +
        "out.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Repository-relative or absolute file path. Omit for the whole repository."),
        withinMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How far back to look. Defaults to 240."),
        limit: z.number().int().positive().optional().describe("Maximum calls to return, capped at 100."),
        excludeAgentId: z
          .string()
          .optional()
          .describe("Omit this agent's own calls, so a caller does not rediscover its own work."),
      },
    },
    async ({ path, withinMinutes, limit, excludeAgentId }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        await modules.freshenLedger({ worktreeRoot: options.worktreeRoot, ledgerPath });
        const result = modules.recallRecentActivity({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          path,
          withinMinutes,
          limit,
          excludeAgentId,
        });
        const text = modules.renderRecall(result, path);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        // Advisory tools fail soft. A recall that cannot answer must not become an error the
        // calling agent has to reason about - it just means it learned nothing this time.
        const reason = error instanceof Error ? error.message : "unknown failure";
        const text = `No PatchMesh ledger available (${reason}).`;
        return { content: [{ type: "text" as const, text }] };
      }
    },
  );

  server.registerTool(
    "patchmesh_active_work",
    {
      title: "Who is working right now",
      description:
        "**Call this when you are about to start, resume, or hand off work, and want to know " +
        "whether you are alone in this repository.** It answers two things together, because " +
        "they are one question: which calls other workers have running *right now*, read live " +
        "from the journal rather than the ledger - and whether recording is actually working, " +
        "so you know what an empty answer is worth. Every other PatchMesh tool reports history, " +
        "where \"nothing found\" and \"nothing recorded\" look identical; this one separates " +
        "them. A `recording` verdict means silence is real silence. A `stale` verdict means no " +
        "absence reported by any of these tools should be trusted. Pass `excludeAgentId` with " +
        "your own agent id, which the PatchMesh session-start context names, to leave your own " +
        "running calls out.",
      inputSchema: {
        withinMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Window used to judge whether recording is live. Defaults to 240."),
        excludeAgentId: z
          .string()
          .optional()
          .describe("Omit this agent's own running calls, so a caller does not see itself as company."),
      },
    },
    async ({ withinMinutes, excludeAgentId }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        await modules.freshenLedger({ worktreeRoot: options.worktreeRoot, ledgerPath });
        const result = modules.readActiveWork({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          withinMinutes,
          excludeAgentId,
        });
        return { content: [{ type: "text" as const, text: modules.renderActiveWork(result) }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        return { content: [{ type: "text" as const, text: `No PatchMesh ledger available (${reason}).` }] };
      }
    },
  );

  server.registerTool(
    "patchmesh_overlapping_work",
    {
      title: "Overlapping work",
      description:
        "**Call this before starting a batch of edits, and before continuing work another agent " +
        "may already have moved.** It names the files more than one worker changed recently, " +
        "from observed filesystem changes rather than from what a tool call claimed. Ask it " +
        "with no arguments to survey the repository, or with `path` for one file. " +
        "Only counts tasks from different agents, subagents or worktrees - " +
        "one agent's own consecutive turns are sequence, not contention - and only where the " +
        "earlier writer was still working when the later one wrote, which each answer states " +
        "along with how recently it had been seen. Reports history only: two workers touching " +
        "one file may be collaboration, a rebase, or divergence, and the ledger holds paths and " +
        "content hashes, not intent, so it does not decide which.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Repository-relative or absolute file path. Omit for the whole repository."),
        withinMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How far back to look. Defaults to 240."),
        limit: z.number().int().positive().optional().describe("Maximum files to return, capped at 100."),
        taskId: z
          .string()
          .optional()
          .describe("Only report overlaps this task is part of, to ask about your own work."),
      },
    },
    async ({ path, withinMinutes, limit, taskId }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        await modules.freshenLedger({ worktreeRoot: options.worktreeRoot, ledgerPath });
        const result = modules.findOverlappingWork({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          path,
          withinMinutes,
          limit,
          taskId,
        });
        const text = modules.renderOverlap(result, path);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        const text = `No PatchMesh ledger available (${reason}).`;
        return { content: [{ type: "text" as const, text }] };
      }
    },
  );

  server.registerTool(
    "patchmesh_recap",
    {
      title: "Recap recent work",
      description:
        "A compact summary of what recent tasks did in this repository - who worked, for how " +
        "long, which files they changed, and what they committed - so a fresh agent resumes " +
        "instead of re-deriving it by reading the tree. A listed commit landed while that task " +
        "was running, which is a fact about timing, not a statement of the task's purpose. " +
        "Reports what was done, not what it means: a changed file is not a finished intention. " +
        "**Call this when you need history the session-start context did not cover** - a longer " +
        "window with `withinMinutes`, one worker with `agent`, or more tasks with `limit`. The " +
        "injected recap covers the last day at a depth of five tasks; anything past that edge " +
        "is only available here.",
      inputSchema: {
        agent: z.string().optional().describe("Narrow to one agent's work. Omit for every agent."),
        withinMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How far back to summarize. Defaults to 1440, one day."),
        limit: z.number().int().positive().optional().describe("Maximum tasks to describe, capped at 25."),
      },
    },
    async ({ agent, withinMinutes, limit }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        await modules.freshenLedger({ worktreeRoot: options.worktreeRoot, ledgerPath });
        const result = modules.recapRecentWork({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          agent,
          withinMinutes,
          limit,
        });
        const text = modules.renderRecap(result, agent);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        const text = `No PatchMesh ledger available (${reason}).`;
        return { content: [{ type: "text" as const, text }] };
      }
    },
  );

  server.registerTool(
    "patchmesh_send",
    {
      title: "Send a mailbox message",
      description:
        "Send a message to another agent working in this repository, or broadcast one to all " +
        "of them. Messages live in the PatchMesh ledger: the recipient sees them on session " +
        "start or via `patchmesh_inbox`, they expire after `expiresAt` (7 days by default), " +
        "and they can be answered with `patchmesh_ack`. Validation rejects rather than clamps " +
        "- an error result here means your mail was **not** sent, so fix the named field and " +
        "resend. The server cannot know who is calling, so `from` is required.",
      inputSchema: {
        to: z
          .string()
          .describe('Recipient: an `agent_<id>`, or the literal `broadcast` for every agent.'),
        kind: z
          .enum(["notice", "handoff", "question", "claim"])
          .describe("What the message is: a notice, a handoff, a question, or a claim of ownership."),
        subject: z
          .string()
          .describe("Subject line. Required, trimmed non-empty, at most 200 characters."),
        body: z.string().describe("Message body, plain text, at most 2048 characters."),
        refs: z
          .array(z.string())
          .optional()
          .describe(
            "Repository-relative paths this message is about; at most 20, duplicates rejected. " +
              "Absolute paths and traversal are rejected.",
          ),
        expiresAt: z
          .string()
          .optional()
          .describe("ISO timestamp after which the message expires. Must be in the future; defaults to now plus 7 days."),
        from: z
          .string()
          .describe("Your agent id as the session-start context named it."),
      },
    },
    async ({ to, kind, subject, body, refs, expiresAt, from }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        const { messageId } = modules.sendMail({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          from,
          to,
          kind,
          subject,
          body,
          refs,
          expiresAt,
        });
        return { content: [{ type: "text" as const, text: `Message ${messageId} recorded in the PatchMesh ledger.` }] };
      } catch (error) {
        // A caller must learn its mail was not sent: validation failures come back as error
        // results naming the rejected field, never as an advisory "no ledger" notice.
        return errorResult(`Message not sent: ${failureReason(error)}`);
      }
    },
  );

  server.registerTool(
    "patchmesh_inbox",
    {
      title: "Read your mailbox",
      description:
        "Read mail addressed to you - direct messages and broadcasts - from other agents in " +
        "this repository. Newest first, capped at 20 with a withheld count; expired mail is " +
        "hidden. Every returned row is marked delivered to you (`mcp_pull`), so the next pull " +
        "returns only new mail - save anything you still need. Omit `agent` to see broadcasts " +
        "only. Answer a message with `patchmesh_ack`.",
      inputSchema: {
        agent: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Your agent id as the session-start context named it. Omit for broadcasts-only " +
              "audience; delivery cannot be attributed without it.",
          ),
      },
    },
    async ({ agent }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        await modules.freshenLedger({ worktreeRoot: options.worktreeRoot, ledgerPath });
        // No agent means broadcast-only audience: readInbox matches direct mail by equality.
        const result = modules.readInbox({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          agent: agent ?? "",
        });
        if (agent !== undefined && result.rows.length > 0) {
          try {
            modules.markDelivered({
              worktreeRoot: options.worktreeRoot,
              ledgerPath,
              byAgentId: agent,
              channel: "mcp_pull",
              messageIds: result.rows.map((row) => row.messageId),
            });
          } catch (error) {
            // Mark-after-answer is at-least-once: a failed mark redelivers next pull, which
            // beats losing mail, so the built answer returns regardless -- but the failure is
            // not silent. Same trail the session-start path writes, same tool name.
            modules.recordMailboxMarkFailure({
              answersPath: measurementPathFor(options.worktreeRoot, modules.ledgerDirectory),
              source: "mcp",
              agentId: agent,
              messageIds: result.rows.map((row) => row.messageId),
            });
          }
        }
        const shorten = modules.idShortener(result.rows.map((row) => row.fromAgentId ?? "unknown"));
        return {
          content: [{
            type: "text" as const,
            text: renderInbox(result, shorten, modules.renderUntrustedMessage),
          }],
        };
      } catch (error) {
        // Advisory tools fail soft. An inbox that cannot answer must not become an error the
        // calling agent has to reason about - it just means it learned nothing this time.
        return errorResult(`No PatchMesh ledger available (${failureReason(error)}).`, false);
      }
    },
  );

  server.registerTool(
    "patchmesh_ack",
    {
      title: "Acknowledge a message",
      description:
        "Tell the sender what you did about a mailbox message: `read` (you saw it - having " +
        "seen a message is not agreeing to it), `accepted`, or `declined`. The message must " +
        "exist and be unexpired; acknowledging again appends another event rather than " +
        "updating anything. The server cannot know who is calling, so `from` is required.",
      inputSchema: {
        messageId: z
          .string()
          .describe("The `msg_` id from the inbox row you are answering."),
        disposition: z
          .enum(["read", "accepted", "declined"])
          .describe("`read` if you only saw it; `accepted` or `declined` for a handoff or request."),
        note: z.string().optional().describe("Optional note to the sender, at most 512 characters."),
        from: z
          .string()
          .describe("Your agent id as the session-start context named it."),
      },
    },
    async ({ messageId, disposition, note, from }) => {
      try {
        const modules = await loadHeavy();
        const ledgerPath = options.ledgerPath ?? modules.ledgerPathFor(options.worktreeRoot);
        await modules.freshenLedger({ worktreeRoot: options.worktreeRoot, ledgerPath });
        const result = modules.acknowledgeMessage({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          byAgentId: from,
          messageId,
          disposition,
          note,
        });
        if (!result.ok) {
          // A refused ack must reach the caller as an error: acknowledging nothing would
          // forge agreement out of a typo.
          return errorResult(`Acknowledgement refused: ${result.reason}`);
        }
        return {
          content: [{ type: "text" as const, text: `Message ${messageId} acknowledged (${disposition}).` }],
        };
      } catch (error) {
        return errorResult(`Acknowledgement failed: ${failureReason(error)}`);
      }
    },
  );

  server.registerTool(
    "patchmesh_contention_check",
    {
      title: "Check file contention",
      description:
        "**Call this before editing a file to check if another agent is currently modifying it.** " +
        "Returns in-flight calls from other agents touching the same path, plus recent completed " +
        "writes. This is the voluntary version of the automatic hook-based warning: use it when " +
        "you want to check before the hook fires, or for paths not covered by Edit/Write hooks.",
      inputSchema: {
        path: z.string().describe("Repository-relative or absolute file path to check."),
        excludeAgentId: z
          .string()
          .optional()
          .describe("Omit this agent's own calls, so a caller does not see itself as contention."),
      },
    },
    async ({ path, excludeAgentId }) => {
      try {
        const modules = await loadHeavy();
        const inFlight = modules.readInFlightCalls({
          worktreeRoot: options.worktreeRoot,
          excludeAgentId,
        });
        const contentions = inFlight.filter(
          (call) => call.filePath === path || call.operation === path,
        );
        const text = contentions.length === 0
          ? `No agents currently modifying \`${path}\`.`
          : contentions
              .map((c) => {
                const agent = c.agentId ?? "unidentified agent";
                const seconds = Math.max(Math.round(c.runningForMs / 1000), 0);
                return `- ${agent}: ${c.hostToolName} on \`${path}\` (${seconds}s ago, still running)`;
              })
              .join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        return { content: [{ type: "text" as const, text: `No PatchMesh data available (${reason}).` }] };
      }
    },
  );

  return server;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}

function errorResult(text: string, isError = true): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: "text", text }], isError };
}

/**
 * One row per message, its body wrapped in the same untrusted-message delimiters the
 * session-start injection uses.
 *
 * The wrapping is not decoration: a message body is other-agent text, and without the delimiters
 * it reaches the calling agent's context indistinguishable from tool output -- a forged
 * "--- end untrusted message" line inside a body could end the trust boundary early. The same
 * `renderUntrustedMessage` builds both surfaces, so the format cannot drift between them.
 */
function renderInbox(
  result: InboxResult,
  shorten: (id: string) => string,
  renderUntrusted: (row: InboxRow, shortFrom: string) => string,
): string {
  const header =
    `${result.rows.length} message(s); ${result.withheld} withheld, ${result.expired} expired.`;
  if (result.rows.length === 0) return header;
  const blocks = result.rows.map((row) => {
    const lines = [
      `${row.messageId} (${row.broadcast ? "broadcast" : "direct"})`,
      renderUntrusted(row, shorten(row.fromAgentId ?? "unknown")),
    ];
    if (row.refs.length > 0) lines.push(`Refs: ${row.refs.join(", ")}`);
    return lines.join("\n");
  });
  return [header, ...blocks].join("\n\n");
}
