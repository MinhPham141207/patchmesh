export type HostId = "claude-code" | "opencode" | "generic-mcp";
export type CoverageTier = "observed" | "session" | "declared";

/**
 * The host-agnostic shape every adapter normalizes its own envelopes into.
 *
 * Two distinct host-declared identifiers matter and must not be merged: `delegateId` names the
 * call itself (Claude's `tool_use_id`), while `subagentId` - when present - names the delegate
 * that made this call, which is what ties a subagent's stream back to its spawn.
 */
export interface HostRecord {
  readonly stage: "pre" | "post" | "turn" | "stop";
  readonly sessionId: string;
  readonly hostToolName: string;
  readonly input: unknown;
  readonly response: unknown;
  readonly delegateId: string | null;
  readonly delegateType: string | null;
  /** Present only on a call a subagent made (Claude's `agent_id`). */
  readonly subagentId?: string | null;
}

export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly tier: CoverageTier;
  /** Envelope -> normalized record. Null for an envelope this host does not own. */
  parse(envelope: unknown): HostRecord | null;
}
