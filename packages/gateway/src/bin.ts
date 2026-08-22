#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findWorktreeRoot } from "@patchmesh/recorder";
import { createGatewayServer } from "./server.js";

/**
 * Stdio entry point, run by a host as an MCP server.
 *
 * Unlike the recorder binaries this is not on the agent's tool-call path - it answers only
 * when an agent asks - so it can afford to import the protocol and storage packages.
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
