# PatchMesh Replay and Projection-Equivalence Contract

> **Status:** Phase 0 normative contract. Storage and projection are Phase 1 behavior.

Replay consumes the immutable event log and rebuilds derived state with all external
side effects disabled. It never reruns tools, sends decisions, executes directives, or
mutates event history. Detector recomputation is a separate later test mode.

Canonical snapshots contain graph nodes and edges, target snapshots, findings,
decisions, delivery state, validity, and coverage. Keys are canonical JSON; stable-ID
arrays are sorted. Each scenario declares equivalent canonical, duplicate, and valid
out-of-order inputs. Phase 0 checks unique event-set digest and expected snapshot
equivalence; Phase 1 must execute the projector and prove the same digest.

Conflicting duplicates, missing causal references, and impossible transitions are
deterministic failures and produce no partial success snapshot. Replay never dispatches
delivery state.
