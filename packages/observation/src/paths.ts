import { createHash } from "node:crypto";
import type { RepositoryId, ResourceId } from "patchmesh-protocol";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeLogicalPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("logical path must be non-empty");
  }

  const normalized = input.normalize("NFC");
  if (
    normalized.includes("\u0000") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error("logical path must be repository-relative and slash-separated");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("logical path contains an invalid segment");
  }

  return segments.join("/");
}

export function fileResourceId(repositoryId: RepositoryId, locator: string): ResourceId {
  const path = normalizeLogicalPath(locator);
  const digest = sha256(JSON.stringify([repositoryId, "file", path]));
  return `res_${digest}`;
}
