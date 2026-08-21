import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LEDGER_DIRECTORY, ledgerPathFor } from "@patchmesh/recorder";
import { recallRecentActivity, renderRecall } from "./recall.js";

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
        return { content: [{ type: "text" as const, text: renderRecall(result, path) }] };
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

  return server;
}

export { LEDGER_DIRECTORY };
