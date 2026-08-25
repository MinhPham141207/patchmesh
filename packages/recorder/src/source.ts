/**
 * Which agent host this recorder runs under, resolved once per event stamp.
 *
 * PatchMesh records from more than one host (Claude Code today, an OpenCode install already
 * exists), so the `source_<host>_hook` provenance on every event must come from the
 * environment rather than a constant. An unset or malformed value falls back to the default
 * instead of minting a source id that later queries could not group on.
 */
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function resolveSourceHost(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env["PATCHMESH_HOST"];
  return requested !== undefined && SOURCE_ID_PATTERN.test(requested) ? requested : "claude-code";
}

/**
 * The `source_<host>_hook` provenance stamped onto every recorded event. Host names use
 * dashes (`claude-code`), source ids historically used underscores, so the default maps back
 * to `source_claude_code_hook`: a Claude-only install keeps emitting exactly what it always
 * emitted, and existing ledgers stay comparable without a migration.
 */
export function sourceIdForHost(host: string): string {
  return `source_${host.replaceAll("-", "_")}_hook`;
}
