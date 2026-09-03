/**
 * Roles: named scopes of ownership an agent can claim.
 *
 * A role says which paths an agent owns (`owns` globs), which it may read
 * (`reads` globs), and where it hands work off (`handoffTo` role ids).
 * Bindings map a host id to a default role; an explicit claim (MCP tool or
 * `PATCHMESH_ROLE` env) always beats a binding. Unassigned agents get `null`,
 * never a default role they did not ask for.
 */

export interface RoleDefinition {
  readonly id: string;
  readonly purpose: string;
  readonly owns: readonly string[];
  readonly reads: readonly string[];
  readonly handoffTo: readonly string[];
}

export interface RoleBinding {
  readonly host: string;
  readonly role: string;
}

export interface RoleConfig {
  readonly version: 1;
  readonly roles: readonly RoleDefinition[];
  readonly bindings: readonly RoleBinding[];
}

export type RoleClaimMethod = "mcp" | "env" | "binding";

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Parse and validate an unknown value as a RoleConfig. Throws on any shape violation. */
export function parseRoleConfig(value: unknown): RoleConfig {
  if (typeof value !== "object" || value === null) throw new Error("role config must be an object");
  const root = value as Record<string, unknown>;
  if (root["version"] !== 1) throw new Error("role config version must be 1");
  if (!Array.isArray(root["roles"])) throw new Error("role config roles must be an array");
  const roles: RoleDefinition[] = (root["roles"] as unknown[]).map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`role config roles[${index}] must be an object`);
    }
    const role = entry as Record<string, unknown>;
    if (typeof role["id"] !== "string" || role["id"] === "") {
      throw new Error(`role config roles[${index}].id must be a non-empty string`);
    }
    if (typeof role["purpose"] !== "string") {
      throw new Error(`role config roles[${index}].purpose must be a string`);
    }
    for (const key of ["owns", "reads", "handoffTo"] as const) {
      if (!isStringArray(role[key])) {
        throw new Error(`role config roles[${index}].${key} must be a string array`);
      }
    }
    return {
      id: role["id"] as string,
      purpose: role["purpose"] as string,
      owns: role["owns"] as readonly string[],
      reads: role["reads"] as readonly string[],
      handoffTo: role["handoffTo"] as readonly string[],
    };
  });
  const ids = new Set(roles.map((role) => role.id));
  if (ids.size !== roles.length) throw new Error("role config role ids must be unique");
  const rawBindings = root["bindings"] ?? [];
  if (!Array.isArray(rawBindings)) throw new Error("role config bindings must be an array");
  const bindings: RoleBinding[] = rawBindings.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`role config bindings[${index}] must be an object`);
    }
    const binding = entry as Record<string, unknown>;
    if (typeof binding["host"] !== "string" || typeof binding["role"] !== "string") {
      throw new Error(`role config bindings[${index}] must have string host and role`);
    }
    if (!ids.has(binding["role"] as string)) {
      throw new Error(`role config bindings[${index}] names unknown role ${binding["role"] as string}`);
    }
    return { host: binding["host"] as string, role: binding["role"] as string };
  });
  return { version: 1, roles, bindings };
}

/** Find a role by id, or null when the config names no such role. */
export function roleById(config: RoleConfig, roleId: string): RoleDefinition | null {
  return config.roles.find((role) => role.id === roleId) ?? null;
}
