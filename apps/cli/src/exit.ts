import { existsSync, readFileSync, writeFileSync, rmSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownsCommand } from "./init.js";

const OWNED_MCP_KEY = "patchmesh";
const OPENCODE_PLUGIN = "patchmesh.mjs";

export interface ExitOptions {
  readonly worktreeRoot: string;
  readonly yes: boolean;
}

export interface ExitStep {
  readonly outcome: "removed" | "unchanged";
  readonly detail: string;
}

export interface ExitResult {
  readonly steps: readonly ExitStep[];
  readonly dryRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removePatchmeshHooks(worktreeRoot: string): ExitStep {
  const settingsPath = join(worktreeRoot, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) {
    return { outcome: "unchanged", detail: ".claude/settings.local.json not found" };
  }

  const settings = readJson(settingsPath);
  const hooks = isRecord(settings["hooks"]) ? settings["hooks"] as Record<string, unknown> : null;
  if (hooks === null) {
    return { outcome: "unchanged", detail: "no hooks in .claude/settings.local.json" };
  }

  let removedAny = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const filtered = groups.filter((group) => {
      if (!isRecord(group) || !Array.isArray(group["hooks"])) return true;
      const hasOurs = (group["hooks"] as unknown[]).some(
        (hook) => isRecord(hook) && typeof hook["command"] === "string" && ownsCommand(hook["command"]),
      );
      if (hasOurs) { removedAny = true; return false; }
      return true;
    });
    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  if (!removedAny) {
    return { outcome: "unchanged", detail: "no PatchMesh hooks in .claude/settings.local.json" };
  }

  const remainingKeys = Object.keys(settings).filter((key) => key !== "hooks");
  const hasContent = Object.keys(hooks).length > 0 || remainingKeys.length > 0;
  if (!hasContent) {
    unlinkSync(settingsPath);
    return { outcome: "removed", detail: "removed .claude/settings.local.json (empty after removal)" };
  }

  writeJson(settingsPath, { ...settings, hooks });
  return { outcome: "removed", detail: "removed PatchMesh hooks from .claude/settings.local.json" };
}

function removeMcpEntry(worktreeRoot: string): ExitStep {
  const configPath = join(worktreeRoot, ".mcp.json");
  if (!existsSync(configPath)) {
    return { outcome: "unchanged", detail: ".mcp.json not found" };
  }

  const config = readJson(configPath);
  const servers = isRecord(config["mcpServers"]) ? config["mcpServers"] as Record<string, unknown> : null;
  if (servers === null || servers[OWNED_MCP_KEY] === undefined) {
    return { outcome: "unchanged", detail: "no patchmesh entry in .mcp.json" };
  }

  delete servers[OWNED_MCP_KEY];
  const otherTopLevelKeys = Object.keys(config).filter((key) => key !== "mcpServers");
  if (Object.keys(servers).length === 0 && otherTopLevelKeys.length === 0) {
    unlinkSync(configPath);
    return { outcome: "removed", detail: "removed .mcp.json (empty after removal)" };
  }

  writeJson(configPath, { ...config, mcpServers: servers });
  return { outcome: "removed", detail: "removed patchmesh entry from .mcp.json" };
}

function removeOpenCodePlugin(worktreeRoot: string): ExitStep {
  const pluginPath = join(worktreeRoot, ".opencode", "plugins", OPENCODE_PLUGIN);
  if (!existsSync(pluginPath)) {
    return { outcome: "unchanged", detail: "OpenCode plugin not found" };
  }

  unlinkSync(pluginPath);

  const pluginsDir = join(worktreeRoot, ".opencode", "plugins");
  try {
    const remaining = readdirSync(pluginsDir);
    if (remaining.length === 0) {
      rmSync(pluginsDir);
      return { outcome: "removed", detail: "removed OpenCode plugin and empty plugins directory" };
    }
  } catch {
    // directory read failed — leave it
  }

  return { outcome: "removed", detail: "removed OpenCode plugin" };
}

function removePatchmeshDir(worktreeRoot: string): ExitStep {
  const dirPath = join(worktreeRoot, ".patchmesh");
  if (!existsSync(dirPath)) {
    return { outcome: "unchanged", detail: ".patchmesh/ not found" };
  }

  rmSync(dirPath, { recursive: true, force: true });
  return { outcome: "removed", detail: "removed .patchmesh/ (ledger, journal, session data)" };
}

function removeGitignoreEntry(worktreeRoot: string): ExitStep {
  const ignorePath = join(worktreeRoot, ".gitignore");
  if (!existsSync(ignorePath)) {
    return { outcome: "unchanged", detail: ".gitignore not found" };
  }

  const content = readFileSync(ignorePath, "utf8");
  const lines = content.split(/\r?\n/u);
  const patchmeshComment = "# PatchMesh ledger, journal and snapshot";
  const patchmeshEntry = ".patchmesh/";

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== patchmeshComment && trimmed !== patchmeshEntry;
  });

  if (filtered.length === lines.length) {
    return { outcome: "unchanged", detail: "no .patchmesh/ entry in .gitignore" };
  }

  const result = filtered.join("\n");
  if (result.trim() === "") {
    unlinkSync(ignorePath);
    return { outcome: "removed", detail: "removed .gitignore (empty after removal)" };
  }

  writeFileSync(ignorePath, result, "utf8");
  return { outcome: "removed", detail: "removed .patchmesh/ entry from .gitignore" };
}

function dryCheckHooks(worktreeRoot: string): ExitStep {
  const settingsPath = join(worktreeRoot, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) {
    return { outcome: "unchanged", detail: ".claude/settings.local.json not found" };
  }
  const settings = readJson(settingsPath);
  const hooks = isRecord(settings["hooks"]) ? (settings["hooks"] as Record<string, unknown>) : null;
  if (hooks === null) {
    return { outcome: "unchanged", detail: "no hooks in .claude/settings.local.json" };
  }
  const hasOurs = Object.values(hooks).some((groups) => {
    if (!Array.isArray(groups)) return false;
    return (groups as unknown[]).some((group) => {
      if (!isRecord(group) || !Array.isArray(group["hooks"])) return false;
      return (group["hooks"] as unknown[]).some(
        (hook) => isRecord(hook) && typeof hook["command"] === "string" && ownsCommand(hook["command"]),
      );
    });
  });
  if (!hasOurs) {
    return { outcome: "unchanged", detail: "no PatchMesh hooks in .claude/settings.local.json" };
  }
  return { outcome: "removed", detail: "PatchMesh hooks from .claude/settings.local.json" };
}

function dryCheckMcp(worktreeRoot: string): ExitStep {
  const configPath = join(worktreeRoot, ".mcp.json");
  if (!existsSync(configPath)) {
    return { outcome: "unchanged", detail: ".mcp.json not found" };
  }
  const config = readJson(configPath);
  const servers = isRecord(config["mcpServers"]) ? (config["mcpServers"] as Record<string, unknown>) : null;
  if (servers === null || servers[OWNED_MCP_KEY] === undefined) {
    return { outcome: "unchanged", detail: "no patchmesh entry in .mcp.json" };
  }
  return { outcome: "removed", detail: "patchmesh entry from .mcp.json" };
}

function dryCheckGitignore(worktreeRoot: string): ExitStep {
  const ignorePath = join(worktreeRoot, ".gitignore");
  if (!existsSync(ignorePath)) {
    return { outcome: "unchanged", detail: ".gitignore not found" };
  }
  const content = readFileSync(ignorePath, "utf8");
  const lines = content.split(/\r?\n/u);
  const patchmeshComment = "# PatchMesh ledger, journal and snapshot";
  const patchmeshEntry = ".patchmesh/";
  const hasEntry = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === patchmeshComment || trimmed === patchmeshEntry;
  });
  if (!hasEntry) {
    return { outcome: "unchanged", detail: "no .patchmesh/ entry in .gitignore" };
  }
  return { outcome: "removed", detail: ".patchmesh/ entry from .gitignore" };
}

export function exitRepository(options: ExitOptions): ExitResult {
  const dryRun = !options.yes;
  const steps: ExitStep[] = [];

  if (dryRun) {
    steps.push(
      existsSync(join(options.worktreeRoot, ".patchmesh"))
        ? { outcome: "removed", detail: ".patchmesh/ (ledger, journal, session data)" }
        : { outcome: "unchanged", detail: ".patchmesh/ not found" },
      dryCheckHooks(options.worktreeRoot),
      dryCheckMcp(options.worktreeRoot),
      existsSync(join(options.worktreeRoot, ".opencode", "plugins", OPENCODE_PLUGIN))
        ? { outcome: "removed", detail: "OpenCode plugin" }
        : { outcome: "unchanged", detail: "OpenCode plugin not found" },
      dryCheckGitignore(options.worktreeRoot),
    );
  } else {
    steps.push(
      removePatchmeshDir(options.worktreeRoot),
      removePatchmeshHooks(options.worktreeRoot),
      removeMcpEntry(options.worktreeRoot),
      removeOpenCodePlugin(options.worktreeRoot),
      removeGitignoreEntry(options.worktreeRoot),
    );
  }

  return { steps, dryRun };
}

export function renderExit(result: ExitResult, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;

  const lines = result.steps.map((step) => {
    const mark = step.outcome === "removed" ? "[OK]" : "[==]";
    return `${mark} ${step.detail}`;
  });

  if (result.dryRun) {
    lines.push("", "Dry run. Pass --yes to proceed.", "");
  } else {
    const anyRemoved = result.steps.some((step) => step.outcome === "removed");
    lines.push(
      "",
      anyRemoved
        ? "PatchMesh has been removed from this repository."
        : "Already clean. Nothing to remove.",
      "",
      "To reinstall, run: patchmesh init",
      "",
    );
  }

  return lines.join("\n");
}
