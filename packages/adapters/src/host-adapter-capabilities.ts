import { createHash } from "node:crypto";

/**
 * Declares only capabilities a named host runtime can prove. A false capability
 * must keep the associated M7 evidence path unavailable rather than inferred.
 */
export interface HostAdapterCapabilities {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly adapterVersion: string;
  readonly wrapsToolExecution: boolean;
  readonly authoritativeIdentity: boolean;
  readonly taskLifecycle: boolean;
  readonly exactReportedEffects: boolean;
  readonly integrationTargetSnapshot: boolean;
  readonly concurrentWorktreeObservation: boolean;
  readonly observedReadVersion: boolean;
  readonly dependentWriteToken: boolean;
}

export type HostAdapterCapabilityDigest = `sha256:${string}`;

export function digestHostAdapterCapabilities(capabilities: HostAdapterCapabilities): HostAdapterCapabilityDigest {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(capabilities).sort(([left], [right]) => left.localeCompare(right))));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
