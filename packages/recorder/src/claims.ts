import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Claim {
  readonly agentId: string;
  readonly paths: readonly string[];
  readonly started: string;
  readonly expires: string;
}

export interface ClaimOptions {
  readonly worktreeRoot: string;
  readonly directory?: string;
  readonly agentId: string;
  readonly paths: readonly string[];
  readonly ttlSeconds?: number;
}

export interface ReadClaimsOptions {
  readonly worktreeRoot: string;
  readonly directory?: string;
}

export interface ReleaseClaimsOptions {
  readonly worktreeRoot: string;
  readonly directory?: string;
  readonly agentId: string;
  readonly paths: readonly string[];
}

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 1800;
const CLAIMS_DIR = "claims";

export function claimsDirectory(worktreeRoot: string, directory?: string): string {
  return join(worktreeRoot, directory ?? ".patchmesh", CLAIMS_DIR);
}

function sanitizeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return DEFAULT_TTL_SECONDS;
  return Math.max(1, Math.min(MAX_TTL_SECONDS, Math.floor(ttlSeconds)));
}

function claimFilePath(worktreeRoot: string, agentId: string, directory?: string): string {
  return join(claimsDirectory(worktreeRoot, directory), `${sanitizeAgentId(agentId)}.json`);
}

function readClaimFile(filePath: string): Claim | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.agentId === "string" &&
      Array.isArray(parsed.paths) &&
      typeof parsed.started === "string" &&
      typeof parsed.expires === "string"
    ) {
      return {
        agentId: parsed.agentId,
        paths: parsed.paths as readonly string[],
        started: parsed.started,
        expires: parsed.expires,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function claimFile(options: ClaimOptions): Claim {
  const { worktreeRoot, directory, agentId, paths } = options;
  const ttlSeconds = clampTtl(options.ttlSeconds);
  const dir = claimsDirectory(worktreeRoot, directory);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const now = new Date();
  const claim: Claim = {
    agentId,
    paths: [...paths],
    started: now.toISOString(),
    expires: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };

  const filePath = claimFilePath(worktreeRoot, agentId, directory);
  writeFileSync(filePath, JSON.stringify(claim, null, 2), "utf8");
  return claim;
}

export function readActiveClaims(options: ReadClaimsOptions): readonly Claim[] {
  const dir = claimsDirectory(options.worktreeRoot, options.directory);
  if (!existsSync(dir)) return [];

  const now = Date.now();
  const claims: Claim[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const claim = readClaimFile(join(dir, entry));
    if (claim === null) continue;
    if (new Date(claim.expires).getTime() <= now) continue;
    claims.push(claim);
  }

  return claims;
}

export function releaseClaims(options: ReleaseClaimsOptions): void {
  const { worktreeRoot, directory, agentId, paths } = options;
  const filePath = claimFilePath(worktreeRoot, agentId, directory);
  const existing = readClaimFile(filePath);
  if (existing === null) return;

  const pathSet = new Set(paths);
  const remaining = existing.paths.filter((p) => !pathSet.has(p));

  if (remaining.length === 0) {
    unlinkSync(filePath);
  } else {
    const updated: Claim = { ...existing, paths: remaining };
    writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf8");
  }
}

export function cleanupExpiredClaims(options: ReadClaimsOptions): number {
  const dir = claimsDirectory(options.worktreeRoot, options.directory);
  if (!existsSync(dir)) return 0;

  let removed = 0;
  const now = Date.now();

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    const claim = readClaimFile(filePath);
    if (claim === null) {
      unlinkSync(filePath);
      removed++;
      continue;
    }
    if (new Date(claim.expires).getTime() <= now) {
      unlinkSync(filePath);
      removed++;
    }
  }

  return removed;
}
