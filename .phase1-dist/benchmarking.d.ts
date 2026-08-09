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
export declare function percentile(samples: readonly number[], probability: number): number;
export declare function summarize(samples: readonly number[]): {
    readonly p50: number;
    readonly p95: number;
};
export declare function overheadNs(baselineNs: number, observedNs: number): number;
export declare function deterministicShuffle<T>(values: readonly T[], seed: number): readonly T[];
export declare function requireMatchingDigests(digests: readonly string[]): string;
//# sourceMappingURL=benchmarking.d.ts.map