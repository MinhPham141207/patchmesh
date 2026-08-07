import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { diagnostic } from './diagnostics.mjs';

const normalized = (value) => value.replaceAll('\\', '/');
export class CorpusContractError extends Error {
  constructor(value) { super(value.message); this.name = 'CorpusContractError'; this.diagnostic = value; }
}
function contractError(root, path, pointer, message) { return new CorpusContractError(diagnostic('PHASE0_SCHEMA_INVALID', normalized(relative(root, path)), pointer, message)); }

export async function safeChild(root, directory, child, pointer) {
  const base = resolve(directory); const target = resolve(directory, child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw contractError(root, join(directory, 'manifest.json'), pointer, 'artifact path escapes scenario directory');
  let realBase; let realTarget;
  try { [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]); }
  catch (error) { if (error.code === 'ENOENT') throw contractError(root, target, pointer, 'required scenario artifact is missing'); throw error; }
  if (realTarget !== realBase && !realTarget.startsWith(`${realBase}${sep}`)) throw contractError(root, join(directory, 'manifest.json'), pointer, 'artifact real path escapes scenario directory');
  return target;
}
export async function walkFiles(directory) {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const groups = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => { const path = join(directory, entry.name); return entry.isDirectory() ? walkFiles(path) : [path]; }));
  return groups.flat();
}
export async function readJson(root, path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw contractError(root, path, '', 'invalid JSON'); if (error.code === 'ENOENT') throw contractError(root, path, '', 'required JSON artifact is missing'); throw error; }
}
export async function readNdjson(root, path) {
  let content; try { content = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') throw contractError(root, path, '', 'required NDJSON artifact is missing'); throw error; }
  return content.split(/\r?\n/u).flatMap((line, index) => { if (!line.trim()) return []; try { return [{ line: index + 1, value: JSON.parse(line) }]; } catch (error) { if (error instanceof SyntaxError) throw contractError(root, path, `/line/${index + 1}`, 'invalid NDJSON'); throw error; } });
}
export async function discoverScenarioDirectories(root, relativeDirectory) {
  let entries; try { entries = await readdir(join(root, relativeDirectory), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, relativeDirectory, entry.name)).sort((a, b) => a.localeCompare(b));
}
export async function loadScenario(root, directory) {
  const manifest = await readJson(root, join(directory, 'manifest.json'));
  const loadExpected = async (paths, at = '/expected') => ({
    graph: await readJson(root, await safeChild(root, directory, paths.graph, `${at}/graph`)),
    findings: await readJson(root, await safeChild(root, directory, paths.findings, `${at}/findings`)),
    decisions: await readJson(root, await safeChild(root, directory, paths.decisions, `${at}/decisions`)),
    validity: await readJson(root, await safeChild(root, directory, paths.validity, `${at}/validity`)),
    coverage: await readJson(root, await safeChild(root, directory, paths.coverage, `${at}/coverage`)),
  });
  const events = await readNdjson(root, await safeChild(root, directory, manifest.eventsFile, '/eventsFile'));
  const expected = manifest.expected === null ? null : await loadExpected(manifest.expected);
  const variants = await Promise.all((manifest.variants ?? []).map(async (variant) => ({ name: variant.name, equivalentTo: variant.equivalentTo, events: await readNdjson(root, await safeChild(root, directory, variant.eventsFile, `/variants/${variant.name}/eventsFile`)), expected: await loadExpected(variant.expected, `/variants/${variant.name}/expected`) })));
  return { directory: normalized(relative(root, directory)), manifest, events, expected, variants };
}
