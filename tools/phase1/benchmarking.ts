export interface BenchmarkEnvironment {
  readonly timestamp: string;
  readonly commit: string;
  readonly os: string;
  readonly architecture: string;
  readonly cpu: string;
  readonly memoryBytes: number;
  readonly nodeVersion: string;
}

export interface BenchmarkFailure {
  readonly message: string;
}

export interface InterceptionSample {
  readonly baselineNs: number | null;
  readonly instrumentedNs: number | null;
  readonly overheadNs: number | null;
  readonly failure: BenchmarkFailure | null;
}

export interface InterceptionBenchmarkResult {
  readonly workloadId: string;
  readonly definitionVersion: string;
  readonly kind: "interception_latency";
  readonly operation: string;
  readonly warmupSamples: number;
  readonly measuredSamples: number;
  readonly samples: readonly InterceptionSample[];
  readonly p50Ns: number | null;
  readonly p95Ns: number | null;
  readonly failures: number;
  readonly environment: BenchmarkEnvironment;
}

export interface ReplaySample {
  readonly variant: "canonical" | "duplicates" | "out_of_order";
  readonly elapsedNs: number | null;
  readonly eventsPerSecond: number | null;
  readonly peakMemoryBytes: number | null;
  readonly snapshotDigest: string | null;
  readonly failure: BenchmarkFailure | null;
}

export interface ReplayBenchmarkResult {
  readonly workloadId: string;
  readonly definitionVersion: string;
  readonly kind: "replay";
  readonly eventCount: number;
  readonly warmupRuns: number;
  readonly measuredRuns: number;
  readonly samples: readonly ReplaySample[];
  readonly p50Ns: number | null;
  readonly p95Ns: number | null;
  readonly failures: number;
  readonly environment: BenchmarkEnvironment;
}

export function percentile(samples: readonly number[], probability: number): number {
  if (samples.length === 0) throw new Error("percentile requires at least one sample");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("percentile probability must be between 0 and 1");
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("percentile samples must be finite");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("percentile selected no sample");
  return value;
}

export function summarize(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

export function overheadNs(baselineNs: number, observedNs: number): number {
  if (!Number.isFinite(baselineNs) || !Number.isFinite(observedNs)) {
    throw new Error("benchmark durations must be finite");
  }
  return observedNs - baselineNs;
}

export function deterministicShuffle<T>(values: readonly T[], seed: number): readonly T[] {
  if (!Number.isInteger(seed)) throw new Error("shuffle seed must be an integer");
  const result = [...values];
  let state = (seed >>> 0) || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = result[index];
    const swapped = result[swapIndex];
    result[index] = swapped as T;
    result[swapIndex] = current as T;
  }
  return result;
}

export function requireMatchingDigests(digests: readonly string[]): string {
  const first = digests[0];
  if (first === undefined) throw new Error("snapshot digests require at least one successful variant");
  if (digests.some((digest) => digest !== first)) {
    throw new Error("snapshot digests must match across successful variants");
  }
  return first;
}
