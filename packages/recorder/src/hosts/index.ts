import { sourceIdForHost } from "../source.js";
import type { NormalizedTool } from "../tool-mapping.js";
import { claudeCodeAdapter, normalizeClaudeTool } from "./claude-code.js";
import { genericMcpAdapter } from "./generic-mcp.js";
import { normalizeOpencodeTool, opencodeAdapter } from "./opencode.js";
import type { CoverageTier, HostAdapter, HostId, HostProvenance, HostRecord } from "./types.js";

/**
 * The hosts this recorder knows how to parse. Adapters join as their tasks land; an
 * envelope from a host that is not listed here is not silently dropped - resolution falls
 * back to Claude Code, which is the only envelope shape recorded so far.
 */
const HOST_ADAPTERS: readonly HostAdapter[] = [claudeCodeAdapter, opencodeAdapter, genericMcpAdapter];

export function resolveHostAdapter(host: string): HostAdapter {
  return HOST_ADAPTERS.find((adapter) => adapter.id === host) ?? claudeCodeAdapter;
}

/**
 * Parses an envelope for the named host, keeping provenance (which host's source id the
 * call carries) separate from envelope shape (who can actually read it). An observed-tier
 * host may deliver its calls through another host's envelope - the current OpenCode
 * integration translates them into the Claude hook payload before they reach the journal -
 * so when the named adapter declines, another adapter that claims the envelope records it.
 * A declared-tier host has no hook envelopes of its own, so nothing is ever parsed on its
 * behalf: asking generic-mcp to read one fails loudly rather than misattributing it.
 */
export function parseForHost(hostId: string, envelope: unknown): HostRecord | null {
  const primary = resolveHostAdapter(hostId);
  const direct = primary.parse(envelope);
  if (direct !== null || primary.tier !== "observed") return direct;
  const claiming = HOST_ADAPTERS.find((adapter) => adapter.id !== primary.id && adapter.parse(envelope) !== null);
  return claiming?.parse(envelope) ?? null;
}

// Generic MCP has no hook envelopes of its own, so it has no tool table to delegate to:
// anything asked of it stays `other` opaque rather than being guessed.
const TOOL_NORMALIZERS: Readonly<Record<HostId, ((hostToolName: string, command: string | null) => NormalizedTool) | null>> = {
  "claude-code": normalizeClaudeTool,
  "opencode": normalizeOpencodeTool,
  "generic-mcp": null,
};

/** Maps a host's tool name onto the closed protocol vocabulary via that host's own table. */
export function normalizeToolFor(hostId: string, hostToolName: string, command: string | null): NormalizedTool {
  const normalize = TOOL_NORMALIZERS[hostId as HostId];
  return (normalize ?? (() => ({ toolName: "other", pathProperty: null, opaque: true })))(hostToolName, command);
}

// Coverage is a property of where an event came from, not of which adapters are compiled
// in yet, so every known host id is tiered here and each row is derived from its adapter,
// so a tier change cannot drift between the two. Generic MCP is the one exception to the
// key derivation: its calls arrive through the gateway without a hooking host, so its
// source id carries no `_hook` suffix and cannot come from `sourceIdForHost`.
const HOSTS_BY_SOURCE_ID: Readonly<Record<string, HostProvenance>> = {
  [sourceIdForHost("claude-code")]: { displayName: claudeCodeAdapter.displayName, tier: claudeCodeAdapter.tier },
  [sourceIdForHost("opencode")]: { displayName: opencodeAdapter.displayName, tier: opencodeAdapter.tier },
  ["source_generic_mcp"]: { displayName: genericMcpAdapter.displayName, tier: genericMcpAdapter.tier },
};

export function hostForSourceId(sourceId: string): HostProvenance | null {
  return Object.hasOwn(HOSTS_BY_SOURCE_ID, sourceId) ? HOSTS_BY_SOURCE_ID[sourceId]! : null;
}

export function tierForSourceId(sourceId: string): CoverageTier | null {
  return hostForSourceId(sourceId)?.tier ?? null;
}

export type { CoverageTier, HostAdapter, HostId, HostProvenance, HostRecord } from "./types.js";
