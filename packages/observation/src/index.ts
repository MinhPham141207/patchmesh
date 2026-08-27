export type {
  CoverageInput,
  EffectDiff,
} from "./effects.js";
export { deriveCoverage, diffSnapshots } from "./effects.js";
export type {
  DerivedCoverage,
  IncrementalObservationBoundary,
  ObservationBoundary,
  ObservationCapture,
  ObservationContext,
  ObservationDiagnostic,
  ObservationGap,
  ObservationGapKind,
  ObservationSnapshot,
  ObservationWindow,
  ObservationWindowResult,
  ObservedFileChange,
  ObservedFileState,
} from "./types.js";
export { fileResourceId, normalizeLogicalPath } from "./paths.js";
export { isIgnoredObservationPath, OBSERVATION_IGNORE_POLICY_VERSION } from "./ignore-policy.js";
export { sanitizeDiagnostic } from "./redaction.js";
export { NodeObservationBoundary } from "./node-observation.js";
export type { NodeObservationOptions } from "./node-observation.js";
export {
  ObservationSidecar,
  ObservationSidecarServerClient,
  ackObservationDrain,
  connectObservationSidecar,
  deterministicObservationDrainId,
  ensureObservationSidecar,
  requestObservationDrain,
  startObservationSidecarServer,
  startObservationSidecar,
  stopObservationSidecar,
} from "./sidecar.js";
export type { ObservationDrainResult, ObservationSidecarOptions, ObservationSidecarServer } from "./sidecar.js";
