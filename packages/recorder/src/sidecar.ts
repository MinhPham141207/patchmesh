import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, renameSync, statSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

export const PENDING_DIR = "pending-advisories";

export interface PendingAdvisory {
  readonly path: string;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly runningForMs: number;
  readonly detectedAt: string;
}

export function pendingAdvisoryPath(pendingDir: string, toolUseId: string): string {
  return join(pendingDir, `${toolUseId}.json`);
}

export function writePendingAdvisory(pendingDir: string, toolUseId: string, advisory: PendingAdvisory): void {
  mkdirSync(pendingDir, { recursive: true });
  const filePath = pendingAdvisoryPath(pendingDir, toolUseId);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(advisory), "utf8");
  renameSync(tmpPath, filePath);
}

export function readAndDeletePendingAdvisory(pendingDir: string, toolUseId: string): PendingAdvisory | null {
  const filePath = pendingAdvisoryPath(pendingDir, toolUseId);
  const lockPath = `${filePath}.lock`;
  let lockFd: number | null = null;
  try {
    // Acquire exclusive lock (single attempt with stale detection)
    try {
      lockFd = openSync(lockPath, "wx");
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      // Check for stale lock (>5 minutes old)
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
          unlinkSync(lockPath);
          // Retry lock acquisition
          lockFd = openSync(lockPath, "wx");
        }
      } catch {}
      // If still no lock, treat as missing (another process is reading)
      if (lockFd === null) return null;
    }
    // Read and delete
    try {
      const content = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content) as PendingAdvisory;
      try { unlinkSync(filePath); } catch {}
      return parsed;
    } catch {
      return null;
    }
  } finally {
    if (lockFd !== null) {
      closeSync(lockFd);
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

export function cleanupPendingAdvisories(pendingDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(pendingDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try { unlinkSync(join(pendingDir, entry)); } catch {}
  }
}