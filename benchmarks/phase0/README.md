# PatchMesh Phase 0 Benchmark Definitions

> **Status:** Measurement definitions only. No benchmark implementation, result, or acceptance threshold exists in Phase 0.

Every future result records definition version, workload ID, timestamp, Git commit, OS, architecture, CPU, memory, Node version, warm-up count, measured sample count, raw observations, failures, and derived statistics. A percentile without raw observations and sample count is not reproducible evidence.

## Interception latency

Run paired direct baseline and gateway-observed operations in the same process and environment. Warm up before measurement, retain failures, record every pair, and derive p50/p95 from sorted overhead samples. The workloads isolate routing, a deterministic small-file read, and opaque shell invocation.

## Replay

Generate deterministic corpus expansions at 1,000, 10,000, and 100,000 events. Measure canonical, duplicate, and valid out-of-order variants. Record elapsed time, events per second, peak memory, failures, and canonical snapshot digest. Variants must agree on the digest before timing is compared.

## Detector quality

Use a later Phase 2 labeled corpus with relevant and irrelevant cases for each detector. Match findings by detector, subject resource, affected task, and evidence path. Record TP, FP, TN, FN, precision, and recall independently per detector.

Phase 0 defines no measured result or threshold. Phase 1 records interception and replay baselines; Phase 2 records detector baselines before accepting any authority increase.
