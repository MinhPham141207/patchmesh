export function percentile(samples, probability) {
    if (samples.length === 0)
        throw new Error("percentile requires at least one sample");
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("percentile probability must be between 0 and 1");
    }
    if (samples.some((sample) => !Number.isFinite(sample))) {
        throw new Error("percentile samples must be finite");
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
    const value = sorted[index];
    if (value === undefined)
        throw new Error("percentile selected no sample");
    return value;
}
export function summarize(samples) {
    return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}
export function overheadNs(baselineNs, observedNs) {
    if (!Number.isFinite(baselineNs) || !Number.isFinite(observedNs)) {
        throw new Error("benchmark durations must be finite");
    }
    return observedNs - baselineNs;
}
export function deterministicShuffle(values, seed) {
    if (!Number.isInteger(seed))
        throw new Error("shuffle seed must be an integer");
    const result = [...values];
    let state = (seed >>> 0) || 1;
    for (let index = result.length - 1; index > 0; index -= 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const swapIndex = state % (index + 1);
        const current = result[index];
        const swapped = result[swapIndex];
        result[index] = swapped;
        result[swapIndex] = current;
    }
    return result;
}
export function requireMatchingDigests(digests) {
    const first = digests[0];
    if (first === undefined)
        throw new Error("snapshot digests require at least one successful variant");
    if (digests.some((digest) => digest !== first)) {
        throw new Error("snapshot digests must match across successful variants");
    }
    return first;
}
//# sourceMappingURL=benchmarking.js.map