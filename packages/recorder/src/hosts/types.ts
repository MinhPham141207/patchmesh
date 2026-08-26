export type HostId = "claude-code" | "opencode" | "generic-mcp";
export type CoverageTier = "observed" | "session" | "declared";

/** The host-agnostic shape every adapter normalizes its own envelopes into. */
export interface HostRecord {
  readonly stage: "pre" | "post" | "turn" | "stop";
  readonly sessionId: string;
  readonly hostToolName: string;
  readonly input: unknown;
  readonly response: unknown;
  readonly delegateId: string | null;
  readonly delegateType: string | null;
}

export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly tier: CoverageTier;
  /** Envelope -> normalized record. Null for an envelope this host does not own. */
  parse(envelope: unknown): HostRecord | null;
}
