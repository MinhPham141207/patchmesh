import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentId,
  CorrelationId,
  EventId,
  RepositoryId,
  ResourceId,
  TaskId,
  WorkspaceId,
  WorktreeId,
} from "patchmesh-protocol";

/**
 * Deterministic UUID in the shape the Phase 0 identity schema requires: version nibble
 * in 1-5 and variant nibble in 8-b. Derived rather than random so the same checkout
 * always reports the same repository, workspace, and worktree across hook invocations.
 */
function deterministicUuid(namespace: string, name: string): string {
  const digest = createHash("sha256").update(`${namespace}\u0000${name}`).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function createEventId(): EventId {
  return `evt_${randomHex(32)}` as EventId;
}

export function createCorrelationId(): CorrelationId {
  return `corr_${randomHex(32)}` as CorrelationId;
}

function randomHex(length: number): string {
  const bytes = Math.ceil(length / 2);
  return createHash("sha256")
    .update(`${process.pid}:${process.hrtime.bigint()}:${Math.random()}`)
    .digest("hex")
    .slice(0, length);
}

export interface RepositoryIdentity {
  /** Absolute path of the working tree the hook fired in. */
  readonly worktreeRoot: string;
  readonly repositoryId: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly worktreeId: WorktreeId;
}

/**
 * Resolve the working tree containing `startDirectory` by walking up to the nearest
 * `.git`. Filesystem only: a hook runs on every tool call, so it must not spawn git.
 */
export function findWorktreeRoot(startDirectory: string): string | null {
  let current = resolve(startDirectory);
  for (;;) {
    try {
      statSync(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * A linked worktree stores `gitdir: <common>/worktrees/<name>`. Reducing that back to
 * the common directory lets sibling worktrees of one repository share a repositoryId,
 * which is what makes cross-worktree comparison possible later.
 */
function repositoryKey(worktreeRoot: string): string {
  const gitPath = join(worktreeRoot, ".git");
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return worktreeRoot;
  }
  // Key on the common git directory in both branches: a primary worktree's own `.git`
  // directory is the same location a linked worktree's `gitdir:` pointer resolves back
  // to, so sibling worktrees of one repository agree on repositoryId.
  if (stat.isDirectory()) return gitPath;
  try {
    const contents = readFileSync(gitPath, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/u.exec(contents);
    if (match === null) return worktreeRoot;
    const gitdir = resolve(worktreeRoot, match[1]!.trim());
    const marker = `${separatorNormalized(gitdir)}`;
    const worktreesIndex = marker.lastIndexOf("/worktrees/");
    return worktreesIndex === -1 ? gitdir : marker.slice(0, worktreesIndex);
  } catch {
    return worktreeRoot;
  }
}

function separatorNormalized(value: string): string {
  return value.split("\\").join("/");
}

/**
 * Reduce a path to one spelling before it is hashed into an identity.
 *
 * Different spellings of the same directory must not become different worktrees. This was
 * observed in real recorded data: hook invocations reporting `D:\patchmesh` and
 * `d:\patchmesh` produced two worktree identities for one checkout, which would make a
 * single agent look like two agents in two worktrees and corrupt cross-worktree overlap
 * comparison. `realpathSync.native` returns the casing the filesystem actually holds and
 * also resolves symlinks and 8.3 short names; the drive-letter fallback covers a path that
 * cannot be resolved (a deleted or not-yet-created directory).
 */
function canonicalPath(value: string): string {
  const absolute = resolve(value);
  let resolved = absolute;
  try {
    resolved = realpathSync.native(absolute);
  } catch {
    // Keep the resolved-but-unverified path rather than failing identity derivation.
  }
  return resolved.replace(/^([a-z]):/u, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

/** Canonical path reduced further to the separator-independent form that gets hashed. */
function identityKey(value: string): string {
  return separatorNormalized(canonicalPath(value));
}

export function resolveRepositoryIdentity(worktreeRoot: string): RepositoryIdentity {
  const canonicalWorktree = identityKey(worktreeRoot);
  const canonicalRepository = identityKey(repositoryKey(worktreeRoot));
  return {
    worktreeRoot: canonicalPath(worktreeRoot),
    repositoryId: `repo_${deterministicUuid("patchmesh:repository", canonicalRepository)}` as RepositoryId,
    // One checkout is one workspace in S1. A multi-checkout workspace needs its own
    // grouping decision and must not be guessed from a path.
    workspaceId: `ws_${deterministicUuid("patchmesh:workspace", canonicalWorktree)}` as WorkspaceId,
    worktreeId: `wt_${deterministicUuid("patchmesh:worktree", canonicalWorktree)}` as WorktreeId,
  };
}

/** Reduce a host identifier to the `[a-z0-9][a-z0-9._-]{0,63}` body both id patterns share. */
function slugForIdentity(value: string): string | null {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-").replace(/^[^a-z0-9]+/u, "");
  return slug === "" ? null : slug.slice(0, 64);
}

/** `agent_[a-z0-9][a-z0-9._-]{0,63}` - host session identifiers are slugged into it. */
export function agentIdForSession(sessionId: string): AgentId | null {
  const slug = slugForIdentity(sessionId);
  return slug === null ? null : (`agent_${slug}` as AgentId);
}

/**
 * Identity for one subagent run inside a session.
 *
 * A subagent shares its parent's host session, so the session alone cannot name it - that is
 * exactly why every call collapsed onto one `agentId` before attribution existed. The host's
 * own delegate id distinguishes it: measured against real traffic it is unique per run, so two
 * concurrent subagents of the same type still receive different identities. The session prefix
 * is kept in the readable part so `patchmesh agents` groups a family visibly.
 */
export function subagentIdFor(sessionId: string, delegateId: string): AgentId | null {
  const sessionSlug = slugForIdentity(sessionId);
  const delegateSlug = slugForIdentity(delegateId);
  if (sessionSlug === null || delegateSlug === null) return null;
  return `agent_${sessionSlug.slice(0, 8)}.sub.${delegateSlug.slice(0, 40)}` as AgentId;
}

/**
 * Identity for the unit of work one delegated run performs.
 *
 * The spawning call and every call the resulting subagent makes carry this same id, which is
 * what turns two independently recorded streams into one attributable task. The host's own id
 * is slugged rather than hashed so a recorded task stays greppable against host diagnostics.
 */
export function taskIdForDelegate(delegateId: string): TaskId | null {
  const slug = slugForIdentity(delegateId);
  return slug === null ? null : (`task_${slug}` as TaskId);
}

/**
 * Identity for the unit of work one user request creates.
 *
 * Delegated runs already had a task; ordinary top-level work had none, so 464 of 478 recorded
 * events carried a null task and every recall answer read "(no task)". A turn is the honest
 * unit: one thing the user asked for, from the prompt that opened it until the agent stops.
 * That is also the unit duplicate-work detection needs, because two attempts at the same
 * request become separable from two steps of one request.
 *
 * The host's own prompt identifier is preferred and slugged rather than hashed, so a recorded
 * task stays greppable against host diagnostics. When the host declares none, the session and
 * the marker's own timestamp derive one - stable for every call in that turn because both
 * inputs are fixed once the turn opens.
 */
export function taskIdForTurn(sessionId: string, promptId: string | null, at: string): TaskId | null {
  if (promptId !== null) {
    const slug = slugForIdentity(promptId);
    if (slug !== null) return `task_${slug}` as TaskId;
  }
  const sessionSlug = slugForIdentity(sessionId);
  if (sessionSlug === null) return null;
  const digest = createHash("sha256").update(`${sessionId}\u0000${at}`).digest("hex").slice(0, 12);
  return `task_turn.${sessionSlug.slice(0, 8)}.${digest}` as TaskId;
}

/**
 * Resource identity for one repository-relative path.
 *
 * Kept byte-identical to `fileResourceId` in `patchmesh-observation`, which is what the
 * adapters, the observation package and the Phase 0 corpus all derive; change both together.
 * `resource-id.test.ts` pins the two together so the duplication cannot drift silently.
 *
 * The formula is duplicated rather than imported for the same reason redaction is: this module
 * is loaded by the per-tool-call hook binary, and reaching the shared implementation means
 * importing a package barrel that the hot path cannot afford.
 *
 * An earlier derivation hashed `repositoryId + NUL + path` here alone. Nothing detected it,
 * because no query ever compared a recorded call against an observed effect - the recorder had
 * no effects to compare. Observing the filesystem is what made the divergence reachable: the
 * same file would have had two identities, and a change would never have joined the call that
 * made it. Callers pass an already-normalized `logicalPathFor` result, so normalization here
 * is only the NFC folding the shared implementation also applies.
 */
export function resourceIdForPath(repositoryId: RepositoryId, logicalPath: string): ResourceId {
  const path = logicalPath.normalize("NFC");
  const digest = createHash("sha256")
    .update(JSON.stringify([repositoryId, "file", path]), "utf8")
    .digest("hex");
  return `res_${digest}` as ResourceId;
}

/**
 * Convert a host-reported path into the repository-relative POSIX form the Phase 0
 * `logicalPath` pattern accepts, or null when it cannot be expressed there - outside the
 * worktree, or a traversal. Null means degraded coverage, never a guessed resource.
 */
export function logicalPathFor(worktreeRoot: string, candidate: string): string | null {
  if (candidate.trim() === "") return null;
  const absolute = isAbsolute(candidate) ? candidate : resolve(worktreeRoot, candidate);
  const relativePath = separatorNormalized(relative(resolve(worktreeRoot), absolute));
  if (relativePath === "" || relativePath.startsWith("../") || relativePath === "..") return null;
  if (isAbsolute(relativePath) || /^[A-Za-z]:/u.test(relativePath)) return null;
  if (relativePath.endsWith("/") || relativePath.includes("//")) return null;
  if (relativePath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (relativePath.includes("\u0000")) return null;
  return relativePath;
}

export { deterministicUuid };
