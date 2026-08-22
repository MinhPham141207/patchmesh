/**
 * Publish the workspace to npm in dependency order.
 *
 * The order is not alphabetical and not the workspace's own listing order: a package must be on
 * the registry before anything that depends on it, or an install landing in the window between
 * two publishes resolves a dependency that does not exist yet. It is written down here rather
 * than rederived per release, because getting it wrong produces a broken install rather than a
 * failed command.
 *
 * `pnpm publish` is required over `npm publish`: only pnpm rewrites `workspace:*` into the real
 * version. An npm-packed tarball ships that specifier verbatim and 404s for every consumer.
 *
 * Usage:
 *   node tools/release/publish.mjs --dry-run   # verify without publishing
 *   node tools/release/publish.mjs             # publish for real
 */
import { execFileSync } from "node:child_process";

/** Topological: every entry depends only on entries above it. */
const ORDER = [
  "packages/protocol",
  "packages/storage",
  "packages/observation",
  "packages/analyzers",
  "packages/recorder",
  "packages/query",
  "packages/core",
  "apps/daemon",
  "packages/gateway",
  "apps/cli",
];

const dryRun = process.argv.includes("--dry-run");

// Publishing an unbuilt or stale `dist` is the one mistake this script cannot detect
// afterwards, so the build is part of the release rather than a step someone remembers.
execFileSync("corepack", ["pnpm", "build"], { stdio: "inherit", shell: process.platform === "win32" });

for (const directory of ORDER) {
  const args = ["pnpm", "publish", "--access", "public", "--no-git-checks"];
  if (dryRun) args.push("--dry-run");
  process.stdout.write(`\n=== ${directory}${dryRun ? " (dry run)" : ""} ===\n`);
  execFileSync("corepack", args, {
    cwd: directory,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

process.stdout.write(`\n${dryRun ? "Dry run complete." : "Published."} ${ORDER.length} package(s).\n`);
