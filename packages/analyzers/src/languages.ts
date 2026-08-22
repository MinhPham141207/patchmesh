import type { SupportedLanguage } from "./types.js";

/**
 * Single source of truth for extension-to-language mapping.
 *
 * This lives in the analyzer package rather than in a runtime adapter so every
 * caller classifies a source file identically. An extension absent from this map
 * is `unsupported`, which produces degraded coverage rather than a guessed parse.
 */
const languagesByExtension: ReadonlyMap<string, SupportedLanguage> = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
]);

/**
 * Classifies a source file by extension. The extension is matched
 * case-insensitively and must include its leading dot.
 */
export function languageForExtension(extension: string): SupportedLanguage | "unsupported" {
  return languagesByExtension.get(extension.toLowerCase()) ?? "unsupported";
}

/** Every extension this build can analyze, sorted for stable reporting. */
export function supportedExtensions(): readonly string[] {
  return [...languagesByExtension.keys()].sort((left, right) => left.localeCompare(right));
}
