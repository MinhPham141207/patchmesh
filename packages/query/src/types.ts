import type {
  AgentId,
  DecisionId,
  EventId,
  EventType,
  FindingType,
  ProtocolEvent,
  TaskId,
} from "patchmesh-protocol";
import type { CoverageTier } from "patchmesh-recorder";
import type {
  EventQuery,
  DecisionView,
  FindingView,
  GraphNode,
  ProjectionCoverage,
  ProjectionCoverageGap,
  ProjectionCoverageMode,
  ReplayReducer,
  ReplayResult,
  SourceSequenceGap,
  WorkGraphSnapshot,
} from "patchmesh-storage";

export interface EventReader {
  read(query?: EventQuery): readonly ProtocolEvent[];
  replay<State>(reducer: ReplayReducer<State>): ReplayResult<State>;
}

export interface AgentFilters {
  readonly agentId?: AgentId;
  readonly taskId?: TaskId | null;
}

export interface EventListQuery {
  readonly agentId?: AgentId;
  readonly taskId?: TaskId | null;
  readonly eventType?: EventType;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly cursor?: EventId;
}

export interface GraphFilters {
  readonly agentId?: AgentId;
  readonly taskId?: TaskId;
  readonly resourceId?: string;
}

export interface FollowOptions extends Omit<EventListQuery, "cursor"> {
  readonly cursor?: EventId;
}

export interface StatusView {
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly store: { readonly state: "open" | "closed"; readonly replayable: boolean };
  readonly eventCount: number;
  readonly eventTypeCounts: Readonly<Record<EventType, number>>;
  readonly agentCount: number;
  readonly taskCount: number;
  readonly nullAttributionEventCount: number;
  /**
   * How much of the observed work carries evidence, as a count rather than a verdict.
   *
   * `presentation` deliberately does not say `degraded`. A hook-recorded ledger always has
   * some scope it cannot see into -- shell reads leave nothing on disk, and a few changes are
   * genuinely unattributable -- so a verdict keyed on "any gap at all" is `degraded` on day
   * one and stays there, which is a word that has stopped meaning anything by the time a real
   * problem needs it. `observational` names the permanent, correct, expected state; the
   * numbers below are what actually moves. Health is reserved for faults `doctor` would fail
   * on. See docs/problems/PM-12 and PM-08.
   */
  readonly coverage: {
    readonly presentation: "sufficient" | "observational" | "unknown";
    /** Coverage scopes carrying no gap. */
    readonly covered: number;
    /** Coverage scopes in total; `covered / total` is the rate worth watching over time. */
    readonly total: number;
    readonly modes: readonly ProjectionCoverageMode[];
    readonly gaps: readonly ProjectionCoverageGap[];
    /**
     * How many distinct recording sources are known hosts, split by whether they observe.
     *
     * Only observed-tier sources count toward observation: a declared-tier source is
     * participation the host announced, not work that was seen, so it widens `total` without
     * ever entering `observed`. A source id no host claims counts neither way -- it is not an
     * observation and not a declaration, and pretending otherwise would invent coverage.
     */
    readonly sources: {
      readonly observed: number;
      readonly total: number;
    };
  };
  readonly errorCategory: string | null;
}

/** Where one agent's events came from, resolved through the recorder's host registry. */
export interface AgentHostProvenance {
  /** The representative source id behind this agent's events; null when none was recorded. */
  readonly sourceId: string | null;
  /** Null for a source id no registered host claims; the renderer says `(unrecognized host)`. */
  readonly displayName: string | null;
  readonly tier: CoverageTier | null;
}

export interface AgentView {
  readonly agentId: AgentId;
  readonly taskIds: readonly (TaskId | null)[];
  readonly eventCount: number;
  readonly eventTypeCounts: Readonly<Partial<Record<EventType, number>>>;
  readonly coverage: readonly ProjectionCoverage[];
  readonly host: AgentHostProvenance;
}

export interface AgentsView {
  readonly agents: readonly AgentView[];
}

export interface EventPage {
  readonly events: readonly ProtocolEvent[];
  readonly nextCursor: EventId | null;
  readonly hasMore: boolean;
}

export interface GraphView {
  readonly snapshot: WorkGraphSnapshot;
  readonly filters: GraphFilters;
  readonly coverageWarnings: readonly ProjectionCoverageGap[];
}

export interface FindingListQuery {
  readonly findingType?: FindingType;
  readonly status?: FindingView["status"];
}

export interface FindingsView {
  readonly findings: readonly FindingView[];
  readonly coverageWarnings: readonly ProjectionCoverageGap[];
}

export interface DecisionExplanation {
  readonly decision: DecisionView;
  readonly finding: FindingView | null;
  readonly coverageWarnings: readonly ProjectionCoverageGap[];
}

export interface DaemonHealth {
  readonly health: StatusView["health"];
  readonly store: StatusView["store"];
  readonly errorCategory: string | null;
}

export type ReadServiceErrorCode = "usage" | "unavailable" | "replay" | "cursor";

export class ReadServiceError extends Error {
  readonly code: ReadServiceErrorCode;

  constructor(code: ReadServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReadServiceError";
    this.code = code;
  }
}

export interface ReadServices {
  getStatus(): StatusView;
  listAgents(filters?: AgentFilters): AgentsView;
  listEvents(query?: EventListQuery): EventPage;
  getGraph(filters?: GraphFilters): GraphView;
  listFindings(query?: FindingListQuery): FindingsView;
  explainDecision(decisionId: DecisionId): DecisionExplanation;
  followEvents(options: FollowOptions, signal?: AbortSignal): AsyncIterable<EventPage>;
}

export interface ReadServiceOptions {
  readonly reader: EventReader;
  /** Set by hosts reading a real ledger file, enabling the persisted projection checkpoint. */
  readonly ledgerPath?: string;
  /** Force full validated replay even when a checkpoint is available. */
  readonly verifyReplay?: boolean;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly pollIntervalMs?: number;
}

export type { GraphNode, SourceSequenceGap };
