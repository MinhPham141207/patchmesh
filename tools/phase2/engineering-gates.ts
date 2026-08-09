import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeObservationBoundary } from "../../packages/observation/dist/index.js";

const tiers = [
  { name: "small", files: 1_000, p95Ms: 250 },
  { name: "medium", files: 10_000, p95Ms: 1_500 },
  { name: "large", files: 50_000, p95Ms: 5_000 },
] as const;

function percentile(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

async function measureTier(tier: (typeof tiers)[number]): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `patchmesh-m0-${tier.name}-`));
  try {
    for (let index = 0; index < tier.files; index += 1) {
      const directory = join(root, `d${Math.floor(index / 100)}`);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `f${index}.txt`), "phase-2 observation benchmark\n");
    }
    const boundary = new NodeObservationBoundary({
      source: { kind: "watcher", sourceId: "source_m0_benchmark", instanceId: "00000000-0000-4000-8000-000000000010" },
    });
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      await boundary.captureBefore({ workspaceRoot: root, repositoryId: "repo_00000000-0000-4000-8000-000000000010", workspaceId: "ws_00000000-0000-4000-8000-000000000010", worktreeId: "wt_00000000-0000-4000-8000-000000000010" });
      samples.push(performance.now() - started);
    }
    const p95 = percentile(samples);
    console.log(JSON.stringify({ tier: tier.name, files: tier.files, samplesMs: samples, p95Ms: p95, budgetMs: tier.p95Ms, accepted: p95 <= tier.p95Ms }));
    if (p95 > tier.p95Ms) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

for (const tier of tiers) await measureTier(tier);
