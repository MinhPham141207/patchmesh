/**
 * Copy the JSON Schema corpus into the package before it is built.
 *
 * `validation.ts` used to resolve `../../../schemas/` — the repository root — which works in a
 * checkout and is absent from a published tarball, so an installed `patchmesh-protocol` threw
 * ENOENT on first import. A package has to carry what it needs to run.
 *
 * The repository root stays the single source of truth: `tools/phase0/validate.mjs` and the
 * Phase 0 corpus read it directly, and this copy is a build output rather than a second copy to
 * keep in sync. It is gitignored for the same reason.
 */
import { cpSync, rmSync } from "node:fs";

const source = new URL("../../../schemas/", import.meta.url);
const target = new URL("../schemas/", import.meta.url);

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
