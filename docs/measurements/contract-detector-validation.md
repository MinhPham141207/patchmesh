# Contract Detector Validation

## Test Scenarios

### Scenario A: Function Signature Change
- **Before:** `authenticate(user: User): Promise<string>`
- **After:** `authenticate(user: User, options?: { timeout?: number }): Promise<string>`
- **Breaking:** Optional param added
- **Finding:** Produced with confidence 0.95, analyzer `exportedContracts` diff detected

### Scenario B: Interface + Function Signature Change
- **Before:** `createConfig(apiUrl: string, apiKey: string): Config` where `Config { apiKey }`
- **After:** `createConfig(apiUrl: string): Config` where `Config` without `apiKey`
- **Breaking:** Required param removed (function signature changes, interface field removed)
- **Finding:** Produced with confidence 0.95

### Scenario C: Function Signature Change (representative of schema change)
- **Before:** `process(input: string): string`
- **After:** `process(input: string, strict: boolean): string`
- **Breaking:** Required param added
- **Finding:** Produced with confidence 0.95

> Note: Analyzer's `export interface` signature elides the body (`export interface Config`), so pure interface field changes without a companion function signature change are not observable via `deriveEvidenceFacts`. Fixtures for B and C include a function whose signature captures the breaking change. A dedicated `contract-compatibility` layer is needed to classify interface-body diffs.

## Evidence Quality

| Metric | Result |
|--------|--------|
| Evidence event IDs per finding | ≥ 2 |
| Coverage IDs per finding | ≥ 1 |
| Coverage status | sufficient |
| Confidence | 0.95 |
| Dependency link | present |
| Reason | non-empty (>10 chars) |

Verified in `packages/core/test/contract-invalidation-e2e.test.ts` — each scenario asserts all rows.

## Files

- Protocol fixtures: `packages/protocol/test/fixtures/contract-breaking/`
- Helper: `packages/protocol/test/fixtures/contract-breaking.ts` (`loadContractScenarios()`)
- Unit tests: `packages/core/test/contract-invalidation-e2e.test.ts`
- Integration tests: deferred (CLI drain→query pipeline requires journal/ledger wiring; tracked for follow-up)

## Validation Command

```
corepack pnpm --filter patchmesh-core test   # 38 pass
corepack pnpm --filter patchmesh-protocol test  # 36 pass
```
