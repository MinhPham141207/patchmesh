import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentId,
  AgentRoleClaimedEvent,
  EventId,
  ProtocolEvent,
  RoleClaimMethod,
  RoleConfig,
  RoleDefinition,
} from "patchmesh-protocol";
import { parseRoleConfig } from "patchmesh-protocol";
import {
  createCorrelationId,
  deterministicUuid,
  resolveRepositoryIdentity,
} from "patchmesh-recorder";
import { readEventsCached, SqliteEventStore } from "patchmesh-storage";
import { ReadServiceError } from "./types.js";

export const ROLES_FILENAME = "patchmesh.roles.json";

const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** Load `patchmesh.roles.json` from the worktree root. Null when absent; throws on invalid JSON. */
export function loadRoleConfig(worktreeRoot: string): RoleConfig | null {
  const path = join(worktreeRoot, ROLES_FILENAME);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new ReadServiceError("usage", `${ROLES_FILENAME} is not valid JSON`);
  }
  try {
    return parseRoleConfig(raw);
  } catch (error) {
    throw new ReadServiceError("usage", error instanceof Error ? error.message : "invalid role config");
  }
}

export interface ClaimRoleOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly agentId: string;
  readonly roleId: string;
  readonly method?: RoleClaimMethod | undefined;
  readonly now?: (() => Date) | undefined;
  readonly append?: ((events: readonly ProtocolEvent[]) => void) | undefined;
}

/**
 * Record an explicit role claim (`agent.role.claimed`). The role must exist in the
 * worktree's role config; an unknown role is rejected rather than stored.
 */
export function claimRole(options: ClaimRoleOptions): { roleId: string } {
  if (!ROLE_ID_PATTERN.test(options.agentId)) {
    throw new ReadServiceError("usage", "agentId must be an agent_<id>");
  }
  if (!ROLE_ID_PATTERN.test(options.roleId)) {
    throw new ReadServiceError("usage", "roleId must be a lowercase slug");
  }
  const config = loadRoleConfig(options.worktreeRoot);
  if (config === null) {
    throw new ReadServiceError("usage", `${ROLES_FILENAME} not found; create one before claiming a role`);
  }
  const role = config.roles.find((candidate) => candidate.id === options.roleId);
  if (role === undefined) {
    throw new ReadServiceError("usage", `unknown role ${options.roleId}`);
  }
  const method = options.method ?? "mcp";
  const now = (options.now ?? (() => new Date()))().toISOString();
  const identity = resolveRepositoryIdentity(options.worktreeRoot);
  const event: AgentRoleClaimedEvent = {
    schemaVersion: 1,
    eventId: `evt_${randomHex(32)}` as EventId,
    eventType: "agent.role.claimed",
    source: {
      kind: "gateway",
      sourceId: "source_patchmesh_roles",
      instanceId: deterministicUuid("patchmesh:roles", identity.repositoryId),
    },
    timestamp: now,
    repositoryId: identity.repositoryId,
    workspaceId: identity.workspaceId,
    worktreeId: identity.worktreeId,
    agentId: options.agentId as AgentId,
    taskId: null,
    correlationId: createCorrelationId(),
    causationId: null,
    sourceSequence: null,
    payload: { roleId: options.roleId, method },
  };
  if (options.append !== undefined) {
    options.append([event]);
  } else {
    const store = SqliteEventStore.open(options.ledgerPath);
    try {
      store.appendAtomic([event]);
    } finally {
      store.close();
    }
  }
  return { roleId: options.roleId };
}

function randomHex(length: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

export interface FindRoleOptions {
  readonly worktreeRoot: string;
  readonly ledgerPath: string;
  readonly agentId: string;
  readonly hostId?: string | undefined;
  readonly config?: RoleConfig | null | undefined;
}

/**
 * The role an agent holds: latest explicit `agent.role.claimed` wins, then the
 * host binding in the role config, else null for unassigned. Never invents a role.
 */
export function findRoleForAgent(options: FindRoleOptions): RoleDefinition | null {
  const config = options.config !== undefined ? options.config : loadRoleConfig(options.worktreeRoot);
  let events: readonly ProtocolEvent[] = [];
  try {
    events = readEventsCached(
      options.ledgerPath,
      { eventTypes: ["agent.role.claimed"] },
      { validate: false },
    );
  } catch {
    events = [];
  }
  let latest: string | null = null;
  for (const event of events) {
    if (event.eventType !== "agent.role.claimed") continue;
    if (event.agentId !== options.agentId) continue;
    latest = (event as AgentRoleClaimedEvent).payload.roleId;
  }
  if (config === null || config === undefined) {
    return null;
  }
  if (latest !== null) {
    return config.roles.find((role) => role.id === latest) ?? null;
  }
  if (options.hostId !== undefined) {
    const binding = config.bindings.find((candidate) => candidate.host === options.hostId);
    if (binding !== undefined) {
      return config.roles.find((role) => role.id === binding.role) ?? null;
    }
  }
  return null;
}

/** Match a repository-relative path against one glob (`**`, `*`, exact). */
function globMatches(glob: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//u, "");
  const escaped = glob
    .split("/")
    .map((segment) => {
      if (segment === "**") return "\u0000";
      return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    })
    .join("/")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`, "u").test(normalized);
}

/**
 * Whether a path falls inside a role's `owns` scope. A role with no `owns`
 * patterns owns nothing; matching is glob-based, not prefix-based.
 */
export function isWithinScope(role: RoleDefinition, filePath: string): boolean {
  return role.owns.some((pattern) => globMatches(pattern, filePath));
}

/** Match a single glob against a repository-relative path. Shared with performance scope math. */
export function globMatchesPath(glob: string, filePath: string): boolean {
  return globMatches(glob, filePath);
}

/**
 * What kind of overlap this is, by role scope.
 *
 * `contention` is the default: roles are advisory, so an unassigned worker or
 * a file both workers own is still contention, not an excuse. `boundary`
 * means a role-holding worker wrote outside its own `owns` scope -- a scope
 * violation riding along with the collision. `expected` is reserved for
 * handoff pairs and not produced yet.
 */
export type ContentionKind = "contention" | "boundary" | "expected";

export interface RoleScopeInput {
  readonly roleId: string | null;
  readonly owns: readonly string[];
}

export function classifyContention(options: {
  readonly earlier: RoleScopeInput | null;
  readonly later: RoleScopeInput | null;
  readonly logicalPath: string;
}): ContentionKind {
  const { earlier, later, logicalPath } = options;
  if (earlier === null || later === null) return "contention";
  if (earlier.roleId === null || later.roleId === null) return "contention";
  const earlierOwns = earlier.owns.some((pattern) => globMatches(pattern, logicalPath));
  const laterOwns = later.owns.some((pattern) => globMatches(pattern, logicalPath));
  if (!earlierOwns || !laterOwns) return "boundary";
  return "contention";
}
