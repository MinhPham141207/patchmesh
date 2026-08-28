# Contract-Breaking Fixtures

Minimal TypeScript before/after pairs for `exported_contract_invalidation`.

| Scenario | Contract file | Change | Expected |
|---|---|---|---|
| A — function-signature | `api.ts` `authenticate(user: User)` → `authenticate(user: User, options?)` | Optional param added | Breaking per detector when `breaking:true` is set by compatibility layer |
| B — interface-field | `types.ts` `Config { apiKey }` removed | Required field removed | Breaking |
| C — schema-type | `schema.ts` `Result { error? }` added | Optional field added | Additive; detector expects `breaking:true` from scenario wiring, not analyzer inference alone |

Each scenario has `before/` and `after/` directories with `api.ts|types.ts|schema.ts` (contract) + `consumer.ts` (imports contract).

All files are standalone TypeScript, no external dependencies.
