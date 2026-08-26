import { sourceIdForHost } from "../source.js";
import { claudeCodeAdapter } from "./claude-code.js";
import type { CoverageTier, HostAdapter, HostId } from "./types.js";

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
const COVERAGE_BY_SOURCE_ID: Readonly<Record<string, CoverageTier>> = {
  [sourceIdForHost("claude-code")]: claudeCodeAdapter.tier,
  [sourceIdForHost("opencode")]: "observed",
  ["source_generic_mcp"]: "declared",
};

export function tierForSourceId(sourceId: string): CoverageTier | null {
  return Object.hasOwn(COVERAGE_BY_SOURCE_ID, sourceId) ? COVERAGE_BY_SOURCE_ID[sourceId]! : null;
}

export type { CoverageTier, HostAdapter, HostId, HostRecord } from "./types.js";
