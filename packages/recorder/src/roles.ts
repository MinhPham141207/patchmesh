import type { RoleClaimMethod, RoleConfig, RoleDefinition } from "patchmesh-protocol";
import { roleById } from "patchmesh-protocol";

export const ROLE_ENV_VAR = "PATCHMESH_ROLE";

export interface ResolveRoleClaimOptions {
  readonly envRole?: string | undefined;
  readonly hostId?: string | undefined;
  readonly config: RoleConfig | null;
}

/**
 * Resolve a non-MCP role claim: `PATCHMESH_ROLE` env first, then the host
 * binding in the role config. The MCP claim lives in the ledger (first hit
 * wins there); this covers the other two methods for hook-time resolution.
 */
export function resolveRoleClaim(options: ResolveRoleClaimOptions): {
  readonly role: RoleDefinition;
  readonly method: RoleClaimMethod;
} | null {
  if (options.config === null) return null;
  const envRole = options.envRole?.trim();
  if (envRole !== undefined && envRole !== "") {
    const role = roleById(options.config, envRole);
    if (role !== null) return { role, method: "env" };
  }
  if (options.hostId !== undefined) {
    const binding = options.config.bindings.find((candidate) => candidate.host === options.hostId);
    if (binding !== undefined) {
      const role = roleById(options.config, binding.role);
      if (role !== null) return { role, method: "binding" };
    }
  }
  return null;
}
