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
 * Publishing is resumable. An account with 2FA enabled takes a one-time password that expires
 * in about thirty seconds, and ten sequential publishes can outlive it, so a half-finished
 * release is the expected failure rather than an unlucky one. Every package already on the
 * registry at this version is skipped, which makes re-running with a fresh code finish the job
 * instead of failing on "cannot publish over an existing version".
 *
 * Usage:
 *   node tools/release/publish.mjs --dry-run        # verify without publishing
 *   node tools/release/publish.mjs                  # publish (no 2FA, or a bypass token)
 *   node tools/release/publish.mjs --otp=123456     # publish with a one-time password
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const otp = process.argv.find((argument) => argument.startsWith("--otp="))?.slice("--otp=".length);
const shell = process.platform === "win32";

/** Whether this exact name and version is already on the registry, so a rerun can skip it. */
function alreadyPublished(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe", shell });
    return true;
  } catch {
    // `npm view` exits non-zero for a name or version that does not exist, which is the
    // ordinary case on a first release rather than a failure worth reporting.
    return false;
  }
}

// Publishing an unbuilt or stale `dist` is the one mistake this script cannot detect
// afterwards, so the build is part of the release rather than a step someone remembers.
//
// `--no-build` exists for one case: a one-time password is already ticking. The build takes
// longer than the code lives, so spending the window on it is how a 2FA release ends up
// half-published. Build first, then run with the code.
if (!process.argv.includes("--no-build")) {
  execFileSync("corepack", ["pnpm", "build"], { stdio: "inherit", shell });
}

const published = [];
const skipped = [];

for (const directory of ORDER) {
  const manifest = JSON.parse(readFileSync(new URL(`../../${directory}/package.json`, import.meta.url), "utf8"));
  const label = `${manifest.name}@${manifest.version}`;

  if (!dryRun && alreadyPublished(manifest.name, manifest.version)) {
    process.stdout.write(`\n=== ${label} — already on the registry, skipping ===\n`);
    skipped.push(label);
    continue;
  }

  const args = ["pnpm", "publish", "--access", "public", "--no-git-checks"];
  if (dryRun) args.push("--dry-run");
  if (otp !== undefined) args.push(`--otp=${otp}`);
  process.stdout.write(`\n=== ${label}${dryRun ? " (dry run)" : ""} ===\n`);
  try {
    execFileSync("corepack", args, { cwd: directory, stdio: "inherit", shell });
  } catch {
    // Name what got through before stopping. Without it, a one-time password that expired
    // halfway leaves the operator guessing which half of the release actually landed.
    process.stdout.write(`\nStopped at ${label}. Published ${published.length}: ${published.join(", ") || "none"}.\n`);
    process.stdout.write("Re-run with a fresh --otp to continue; published packages are skipped.\n");
    process.exit(1);
  }
  published.push(label);
}

const done = dryRun ? "Dry run complete." : `Published ${published.length}, skipped ${skipped.length} already on the registry.`;
process.stdout.write(`\n${done}\n`);
