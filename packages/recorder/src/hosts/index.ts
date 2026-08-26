import { sourceIdForHost } from "../source.js";
import { claudeCodeAdapter } from "./claude-code.js";
import type { CoverageTier, HostAdapter, HostId, HostProvenance } from "./types.js";

/**
 * The hosts this recorder knows how to parse. Adapters join as their tasks land; an
 * envelope from a host that is not listed here is not silently dropped - resolution falls
 * back to Claude Code, which is the only envelope shape recorded so far.
 */
const HOST_ADAPTERS: readonly HostAdapter[] = [claudeCodeAdapter];

export function resolveHostAdapter(host: string): HostAdapter {
  return HOST_ADAPTERS.find((adapter) => adapter.id === host) ?? claudeCodeAdapter;
}

// Coverage is a property of where an event came from, not of which adapters are compiled
// in yet, so every known host id is tiered here and each new adapter asserts its own row.
// A generic MCP server's calls arrive through the gateway without a hooking host, so its
// source id carries no `_hook` suffix and its coverage stays `declared` until effects are
// observed at the protocol level.
const HOSTS_BY_SOURCE_ID: Readonly<Record<string, HostProvenance>> = {
  [sourceIdForHost("claude-code")]: { displayName: claudeCodeAdapter.displayName, tier: claudeCodeAdapter.tier },
  [sourceIdForHost("opencode")]: { displayName: "OpenCode", tier: "observed" },
  ["source_generic_mcp"]: { displayName: "Generic MCP", tier: "declared" },
};

export function hostForSourceId(sourceId: string): HostProvenance | null {
  return Object.hasOwn(HOSTS_BY_SOURCE_ID, sourceId) ? HOSTS_BY_SOURCE_ID[sourceId]! : null;
}

export function tierForSourceId(sourceId: string): CoverageTier | null {
  return hostForSourceId(sourceId)?.tier ?? null;
}

export type { CoverageTier, HostAdapter, HostId, HostProvenance, HostRecord } from "./types.js";
