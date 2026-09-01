import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readActiveClaims, type Claim } from "./claims.js";
import { readInFlightCalls, type InFlightCall } from "./inflight.js";

export interface ContentionCheckOptions {
  readonly worktreeRoot: string;
  readonly directory?: string;
  readonly path: string;
  readonly agentId?: string;
}

export interface ContentionResult {
  readonly hasContention: boolean;
  readonly claims: readonly Claim[];
  readonly inFlight: readonly InFlightCall[];
  readonly overlapping: boolean;
}

export interface RetryState {
  readonly path: string;
  readonly agentId: string;
  readonly retryCount: number;
  readonly lastDeniedAt: string;
}

export interface RetryOptions {
  readonly worktreeRoot: string;
  readonly directory?: string;
  readonly path: string;
  readonly agentId: string;
}

export const MAX_RETRIES = 3;

function retryDir(options: { worktreeRoot: string; directory?: string }): string {
  return join(options.worktreeRoot, options.directory ?? ".patchmesh", "pending");
}

function retryHash(path: string, agentId: string): string {
  return createHash("sha256").update(`${path}:${agentId}`).digest("hex").slice(0, 16);
}

function retryFilePath(options: RetryOptions): string {
  return join(retryDir(options), `retry_${retryHash(options.path, options.agentId)}.json`);
}

function readRetryFile(filePath: string): RetryState | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed.path === "string" &&
      typeof parsed.agentId === "string" &&
      typeof parsed.retryCount === "number" &&
      typeof parsed.lastDeniedAt === "string"
    ) {
      return {
        path: parsed.path,
        agentId: parsed.agentId,
        retryCount: parsed.retryCount,
        lastDeniedAt: parsed.lastDeniedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function checkContention(options: ContentionCheckOptions): ContentionResult {
  const { worktreeRoot, directory, path, agentId } = options;

  const claims = readActiveClaims({ worktreeRoot, directory }).filter(
    (c) => (agentId === undefined || c.agentId !== agentId) && c.paths.includes(path),
  );

  const inFlight = readInFlightCalls({ worktreeRoot, directory, excludeAgentId: agentId }).filter(
    (call) => call.filePath === path,
  );

  return {
    hasContention: claims.length > 0 || inFlight.length > 0,
    claims,
    inFlight,
    overlapping: claims.length > 0 || inFlight.length > 0,
  };
}

export function readRetryState(options: RetryOptions): RetryState | null {
  return readRetryFile(retryFilePath(options));
}

export function incrementRetry(options: RetryOptions): RetryState {
  const dir = retryDir(options);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = retryFilePath(options);
  const existing = readRetryFile(filePath);

  const state: RetryState = {
    path: options.path,
    agentId: options.agentId,
    retryCount: (existing?.retryCount ?? 0) + 1,
    lastDeniedAt: new Date().toISOString(),
  };

  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function shouldAllow(options: RetryOptions): boolean {
  const state = readRetryState(options);
  return state !== null && state.retryCount >= MAX_RETRIES;
}

export function cleanupRetryFiles(options: { worktreeRoot: string; directory?: string }): number {
  const dir = retryDir(options);
  if (!existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("retry_") || !entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    const state = readRetryFile(filePath);
    if (state === null) {
      unlinkSync(filePath);
      removed++;
      continue;
    }
    const age = Date.now() - new Date(state.lastDeniedAt).getTime();
    if (age > 30 * 60 * 1000) {
      unlinkSync(filePath);
      removed++;
    }
  }

  return removed;
}
