import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { Source } from "@patchmesh/protocol";
import { normalizeLogicalPath } from "./paths.js";
import { sanitizeDiagnostic } from "./redaction.js";
import type {
  ObservationBoundary,
  ObservationCapture,
  ObservationContext,
  ObservationGap,
  ObservationSnapshot,
  ObservedFileState,
} from "./types.js";

const execFile = promisify(execFileCallback);

export interface NodeObservationOptions {
  readonly source: Source;
}

interface GitMetadata {
  readonly commonDirectory: string | null;
  readonly administrativeDirectory: string | null;
  readonly revision: string | null;
  readonly gaps: readonly ObservationGap[];
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gap(kind: ObservationGap["kind"], scope: string, reason: string): ObservationGap {
  return { kind, scope, reason: sanitizeDiagnostic(reason) };
}

async function gitValue(root: string, ...args: string[]): Promise<string | null> {
  try {
    const result = await execFile("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function captureGitMetadata(root: string): Promise<GitMetadata> {
  const commonDirectoryValue = await gitValue(root, "rev-parse", "--git-common-dir");
  const administrativeDirectoryValue = await gitValue(root, "rev-parse", "--git-dir");
  const revision = await gitValue(root, "rev-parse", "HEAD");
  const commonDirectory = commonDirectoryValue ? resolve(root, commonDirectoryValue) : null;
  const administrativeDirectory = administrativeDirectoryValue
    ? resolve(root, administrativeDirectoryValue)
    : null;
  const gaps: ObservationGap[] = [];
  if (commonDirectory === null || administrativeDirectory === null || revision === null) {
    gaps.push(gap("unverified", "git", "Git repository metadata is unavailable"));
  }
  return { commonDirectory, administrativeDirectory, revision, gaps };
}

function toLogicalPath(root: string, absolutePath: string): string {
  const relativePath = relative(root, absolutePath).split(sep).join("/");
  return normalizeLogicalPath(relativePath);
}

async function captureFiles(root: string): Promise<{
  readonly files: ReadonlyMap<string, ObservedFileState>;
  readonly gaps: readonly ObservationGap[];
}> {
  const files = new Map<string, ObservedFileState>();
  const gaps: ObservationGap[] = [];

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      gaps.push(gap("unverified", "filesystem", "A workspace directory could not be read"));
      return;
    }

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (relativePath === ".git" || relativePath.startsWith(".git/")) continue;

      let stats;
      try {
        stats = await lstat(absolutePath);
      } catch {
        gaps.push(gap("unverified", "filesystem", "A workspace path could not be inspected"));
        continue;
      }

      if (stats.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      let logicalPath: string;
      try {
        logicalPath = toLogicalPath(root, absolutePath);
      } catch {
        gaps.push(gap("unverified", "filesystem", "A path is outside the logical workspace contract"));
        continue;
      }

      if (stats.isSymbolicLink()) {
        try {
          const target = await readlink(absolutePath);
          files.set(logicalPath, {
            contentHash: sha256(`symlink:${target}`),
            gitBlob: null,
            fileKind: "symlink",
          });
        } catch {
          gaps.push(gap("unverified", logicalPath, "A symbolic link target could not be observed"));
        }
        continue;
      }

      if (!stats.isFile()) {
        gaps.push(gap("unverified", logicalPath, "A workspace entry has an unsupported file type"));
        continue;
      }

      try {
        const gitBlob = await gitValue(root, "hash-object", "--", relativePath);
        files.set(logicalPath, {
          contentHash: sha256(await readFile(absolutePath)),
          gitBlob,
          fileKind: "file",
        });
      } catch {
        gaps.push(gap("unverified", logicalPath, "A file content hash could not be computed"));
      }
    }
  }

  await visit(root);
  return { files, gaps };
}

export class NodeObservationBoundary implements ObservationBoundary {
  readonly source: Source;

  constructor(options: NodeObservationOptions) {
    this.source = options.source;
  }

  async captureBefore(context: ObservationContext): Promise<ObservationCapture> {
    return this.capture(context);
  }

  async captureAfter(context: ObservationContext): Promise<ObservationCapture> {
    return this.capture(context);
  }

  private async capture(context: ObservationContext): Promise<ObservationCapture> {
    const root = resolve(context.workspaceRoot);
    const [git, files] = await Promise.all([
      captureGitMetadata(root),
      captureFiles(root),
    ]);
    const snapshot: ObservationSnapshot = {
      repository: {
        commonDirectory: git.commonDirectory,
        revision: git.revision,
      },
      worktree: {
        administrativeDirectory: git.administrativeDirectory,
      },
      files: files.files,
    };
    return {
      snapshot,
      gaps: [...git.gaps, ...files.gaps],
      outOfBandChanges: [],
    };
  }
}
