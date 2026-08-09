import { type BenchmarkEnvironment, type InterceptionBenchmarkResult, type ReplayBenchmarkResult } from "./benchmarking.js";
interface BenchmarkReport {
    readonly schemaVersion: 1;
    readonly definitionVersion: string;
    readonly generatedAt: string;
    readonly environment: BenchmarkEnvironment;
    readonly interception: readonly InterceptionBenchmarkResult[];
    readonly replay: readonly ReplayBenchmarkResult[];
}
export declare function runBenchmarks(argv?: readonly string[]): Promise<BenchmarkReport>;
export {};
//# sourceMappingURL=benchmark.d.ts.map