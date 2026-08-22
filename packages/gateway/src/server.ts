import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LEDGER_DIRECTORY, ledgerPathFor } from "patchmesh-recorder";
import { measurementPathFor, recordAnswer } from "./measure.js";
import { findOverlappingWork, renderOverlap } from "patchmesh-query";
import { recallRecentActivity, renderRecall } from "./recall.js";
import { recapRecentWork, renderRecap } from "./recap.js";

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
export function createGatewayServer(options: GatewayOptions): McpServer {
  const ledgerPath = options.ledgerPath ?? ledgerPathFor(options.worktreeRoot);
  const measurementPath = measurementPathFor(options.worktreeRoot, LEDGER_DIRECTORY);
  const server = new McpServer({ name: "patchmesh", version: "0.1.0" });

  server.registerTool(
    "patchmesh_recent_activity",
    {
      title: "Recent agent activity",
      description:
        "What agents and subagents recently did in this repository, optionally narrowed to one " +
        "file. Use before editing a file another agent may be working on, to see who touched it, " +
        "when, and under which task. Reports history only - it does not judge whether two agents " +
        "conflict, and the ledger records which file was touched, not what changed inside it.",
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
    ({ path, withinMinutes, limit, excludeAgentId }) => {
      try {
        const result = recallRecentActivity({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          path,
          withinMinutes,
          limit,
          excludeAgentId,
        });
        const text = renderRecall(result, path);
        recordAnswer(measurementPath, {
          tool: "patchmesh_recent_activity",
          path,
          answerBytes: Buffer.byteLength(text, "utf8"),
          items: result.calls.length + result.changes.length + result.inFlight.length,
          withheld: result.truncated + result.truncatedChanges,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        // Advisory tools fail soft. A recall that cannot answer must not become an error the
        // calling agent has to reason about - it just means it learned nothing this time.
        const reason = error instanceof Error ? error.message : "unknown failure";
        return {
          content: [{ type: "text" as const, text: `No PatchMesh ledger available (${reason}).` }],
        };
      }
    },
  );

  server.registerTool(
    "patchmesh_overlapping_work",
    {
      title: "Overlapping work",
      description:
        "Files that more than one worker changed recently, based on observed filesystem changes " +
        "rather than on what a tool call named. Use before continuing work another agent may " +
        "already have moved. Only counts tasks from different agents, subagents or worktrees - " +
        "one agent's own consecutive turns are sequence, not contention - and only files this " +
        "repository tracks. Reports history only: two workers touching one file may be " +
        "collaboration, a rebase, or divergence, and the ledger holds paths and content hashes, " +
        "not intent, so it does not decide which.",
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
    ({ path, withinMinutes, limit, taskId }) => {
      try {
        const result = findOverlappingWork({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          path,
          withinMinutes,
          limit,
          taskId,
        });
        const text = renderOverlap(result, path);
        recordAnswer(measurementPath, {
          tool: "patchmesh_overlapping_work",
          path,
          answerBytes: Buffer.byteLength(text, "utf8"),
          items: result.overlaps.length,
          withheld: result.truncated,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        return {
          content: [{ type: "text" as const, text: `No PatchMesh ledger available (${reason}).` }],
        };
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
        "Reports what was done, not what it means: a changed file is not a finished intention.",
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
    ({ agent, withinMinutes, limit }) => {
      try {
        const result = recapRecentWork({
          worktreeRoot: options.worktreeRoot,
          ledgerPath,
          agent,
          withinMinutes,
          limit,
        });
        const text = renderRecap(result, agent);
        recordAnswer(measurementPath, {
          tool: "patchmesh_recap",
          answerBytes: Buffer.byteLength(text, "utf8"),
          items: result.tasks.length,
          withheld: result.truncated,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown failure";
        return {
          content: [{ type: "text" as const, text: `No PatchMesh ledger available (${reason}).` }],
        };
      }
    },
  );

  return server;
}

export { LEDGER_DIRECTORY };
