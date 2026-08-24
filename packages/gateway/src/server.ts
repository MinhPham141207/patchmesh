import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OverlapOptions, OverlapResult, RecapOptions, RecapResult } from "patchmesh-query";
import type { RecallOptions, RecallResult } from "./recall.js";

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
      readonly recallRecentActivity: (options: RecallOptions) => RecallResult;
      readonly renderRecall: (result: RecallResult, requestedPath: string | undefined) => string;
      readonly findOverlappingWork: (options: OverlapOptions) => OverlapResult;
      readonly renderOverlap: (result: OverlapResult, requestedPath: string | undefined) => string;
      readonly recapRecentWork: (options: RecapOptions) => RecapResult;
      readonly renderRecap: (result: RecapResult, agent: string | undefined) => string;
    }>
  | undefined;

function loadHeavy(): NonNullable<typeof heavy> {
  heavy ??= Promise.all([
    import("patchmesh-recorder"),
    import("patchmesh-query"),
    import("./recall.js"),
  ]).then(([recorder, query, recall]) => ({
    ledgerPathFor: recorder.ledgerPathFor,
    recallRecentActivity: recall.recallRecentActivity,
    renderRecall: recall.renderRecall,
    findOverlappingWork: query.findOverlappingWork,
    renderOverlap: query.renderOverlap,
    recapRecentWork: query.recapRecentWork,
    renderRecap: query.renderRecap,
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

  return server;
}
