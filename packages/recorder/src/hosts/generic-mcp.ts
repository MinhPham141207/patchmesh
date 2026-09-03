import type { HostAdapter, HostCheck } from "./types.js";

/**
 * A stand-in for MCP-only hosts whose tool calls reach PatchMesh through a gateway rather
 * than a host hook, so no hook envelope is ever theirs to parse - gateway-recorded calls
 * arrive already recorded, and this adapter exists so the registry can name the host and
 * carry its `declared` coverage tier (self-participation, not observation).
 */
export const genericMcpAdapter: HostAdapter = {
  id: "generic-mcp",
  displayName: "Generic MCP",
  tier: "declared",
  parse: () => null,
  check(_worktreeRoot: string): HostCheck[] {
    return [{
      name: "generic-mcp",
      status: "ok",
      detail: "generic MCP calls record through their gateway as declared-tier participation"
        + " (self-reported; no effects are observed at the protocol level)",
    }];
  },
};
