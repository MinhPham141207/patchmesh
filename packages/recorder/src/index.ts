export { buildHookEvents, HookRecordingError, normalizeOperation } from "./hook.js";
export type { BuildHookEventsOptions, HookPayload, RecordedPair } from "./hook.js";
export {
  agentIdForSession,
  createCorrelationId,
  createEventId,
  deterministicUuid,
  findWorktreeRoot,
  ledgerRootFor,
  logicalPathFor,
  resolveRepositoryIdentity,
  resourceIdForPath,
  subagentIdFor,
  taskIdForDelegate,
  taskIdForTurn,
} from "./identity.js";
export type { RepositoryIdentity } from "./identity.js";
export { ingestJournal, recordTurnEffects } from "./ingest.js";
export { freshenLedger, FRESHEN_MAX_ENTRIES } from "./freshen.js";
export type { FreshenLedgerOptions, FreshenOutcome, FreshenResult } from "./freshen.js";
export { attributionFieldsOf, resolveAttribution, SPAWN_TOOL_NAMES } from "./attribution.js";
export type { AttributionInput, CallAttribution } from "./attribution.js";
export type {
  IngestJournalOptions,
  IngestResult,
  RecordTurnEffectsOptions,
  RecordTurnEffectsResult,
} from "./ingest.js";
export { ignoredByRepository, observationRequestId, observeTurnEffects, readSnapshot, writeSnapshot } from "./effects.js";
export type { ObserveTurnEffectsOptions, StoredSnapshot, TurnEffects } from "./effects.js";
// Exported so the version-drift guard can be tested directly. Racing a real drain against a
// second write cannot test it: when the snapshot happens to catch the newer content, analyzing
// that content is correct, so the test would be asserting a coin flip.
export { deriveAnalysisEvents, latestSymbolVersions } from "./symbols.js";
export type { SymbolDerivationOptions } from "./symbols.js";
export {
  appendJournalEntry,
  JOURNAL_FILENAME,
  JOURNAL_VERSION,
  journalPathFor,
  parseJournalLine,
} from "./journal.js";
export type { JournalEntry } from "./journal.js";
export { redactHookPayload, redactText } from "./redact.js";
export { resolveProvenanceHost, resolveSourceHost, sourceIdForHost } from "./source.js";
export { hostForSourceId, resolveHostAdapter, tierForSourceId, codexAdapter, normalizeCodexTool, parseCodexEnvelope } from "./hosts/index.js";
export type { CoverageTier, HostId, HostProvenance } from "./hosts/index.js";
export {
  LEDGER_DIRECTORY,
  LEDGER_FILENAME,
  ledgerPathFor,
  recordHook,
  SNAPSHOT_FILENAME,
  snapshotPathFor,
} from "./record.js";
export type { RecordHookOptions, RecordHookResult } from "./record.js";
export { isRecognizedHostTool, normalizeTool } from "./tool-mapping.js";
export {
  isCallStart,
  isTurnMarker,
  readTurnState,
  TURN_STATE_FILENAME,
  TURN_STATE_TTL_MS,
  TURN_STATE_VERSION,
  turnFieldsOf,
  turnStatePathFor,
  writeTurnState,
} from "./turn.js";
export type { OpenTurn, TurnFields } from "./turn.js";
export type { NormalizedTool } from "./tool-mapping.js";
export { readInFlightCalls } from "./inflight.js";
export type { InFlightCall, ReadInFlightOptions } from "./inflight.js";
export { computeContentionAdvisory, computePostWriteAdvisory, computeTurnStartAdvisory } from "./advisory.js";
export type { ComputeAdvisoryOptions, ContentionAdvisory, TurnStartAdvisory } from "./advisory.js";
export { main as codexRelayMain, translateCodexPayload } from "./codex-relay.js";
export { writePendingAdvisory, readAndDeletePendingAdvisory, cleanupPendingAdvisories, PENDING_DIR } from "./sidecar.js";
export type { PendingAdvisory } from "./sidecar.js";
export {
  claimFile,
  claimsDirectory,
  cleanupExpiredClaims,
  readActiveClaims,
  releaseClaims,
} from "./claims.js";
export type { Claim, ClaimOptions, ReadClaimsOptions, ReleaseClaimsOptions } from "./claims.js";
export {
  checkContention,
  incrementRetry,
  readRetryState,
  shouldAllow,
  MAX_RETRIES,
} from "./leader.js";
export type { ContentionCheckOptions, ContentionResult, RetryOptions, RetryState } from "./leader.js";
