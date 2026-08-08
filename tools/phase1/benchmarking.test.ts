import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deterministicShuffle,
  overheadNs,
  percentile,
  requireMatchingDigests,
  summarize,
} from "./benchmarking.js";

test("percentile uses deterministic nearest-rank selection", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.95), 4);
  assert.deepEqual(summarize([4, 1, 3, 2]), { p50: 2, p95: 4 });
});

test("metrics reject invalid samples and calculate overhead", () => {
  assert.throws(() => percentile([], 0.5), /at least one sample/);
  assert.throws(() => percentile([1, Number.NaN], 0.5), /finite/);
  assert.throws(() => percentile([1], 1.1), /probability/);
  assert.equal(overheadNs(10, 14), 4);
});

test("deterministic shuffle is stable for a seed and preserves values", () => {
  const first = deterministicShuffle([1, 2, 3, 4, 5], 17);
  assert.deepEqual(first, deterministicShuffle([1, 2, 3, 4, 5], 17));
  assert.deepEqual([...first].sort((left, right) => left - right), [1, 2, 3, 4, 5]);
});

test("snapshot digest agreement rejects mismatched successful variants", () => {
  assert.doesNotThrow(() => requireMatchingDigests(["same", "same"]));
  assert.throws(() => requireMatchingDigests(["same", "different"]), /snapshot digests/);
});
