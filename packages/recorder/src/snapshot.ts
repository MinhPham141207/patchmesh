import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FileSnapshot {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mtime: string;
}

export interface SnapshotDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("md5").update(content).digest("hex");
}

function listTrackedFiles(worktreeRoot: string): string[] {
  try {
    const output = execSync("git ls-files", {
      cwd: worktreeRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function takeSnapshot(worktreeRoot: string): readonly FileSnapshot[] {
  const files = listTrackedFiles(worktreeRoot);
  const snapshots: FileSnapshot[] = [];

  for (const relPath of files) {
    const fullPath = join(worktreeRoot, relPath);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      snapshots.push({
        path: relPath,
        hash: hashFile(fullPath),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }

  return snapshots;
}

export function diffSnapshots(
  before: readonly FileSnapshot[],
  after: readonly FileSnapshot[],
): SnapshotDiff {
  const beforeMap = new Map(before.map((s) => [s.path, s]));
  const afterMap = new Map(after.map((s) => [s.path, s]));

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, snapshot] of afterMap) {
    const prev = beforeMap.get(path);
    if (prev === undefined) {
      added.push(path);
    } else if (prev.hash !== snapshot.hash) {
      modified.push(path);
    }
  }

  for (const [path] of beforeMap) {
    if (!afterMap.has(path)) {
      deleted.push(path);
    }
  }

  return { added, modified, deleted };
}
