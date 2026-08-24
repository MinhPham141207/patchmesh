#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findWorktreeRoot } from "patchmesh-recorder";
import { createGatewayServer } from "./server.js";

/**
 * Stdio entry point, run by a host as an MCP server.
 *
 * `createGatewayServer` defers `patchmesh-recorder` and `patchmesh-query` to first `tools/call`
 * -- this file and `server.ts` must not import them eagerly. The MCP SDK itself is still paid
 * here, since the handshake needs a real `McpServer` to answer `initialize`, but a client that
 * only ever lists tools and never calls one must not also pay for the ledger-reading packages.
 * Measured against the ledger, that is the median session: agents make zero voluntary MCP calls
 * more often than they make any.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const worktreeRoot = argv[0] ?? findWorktreeRoot(process.cwd());
  if (worktreeRoot === null) {
    process.stderr.write("patchmesh-mcp: no git worktree found\n");
    return 1;
  }
  const server = createGatewayServer({ worktreeRoot });
  await server.connect(new StdioServerTransport());
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
