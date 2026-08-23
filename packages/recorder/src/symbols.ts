import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  deriveDependencyChangedEvents,
  deriveEvidenceFacts,
  deriveSymbolChangedEvents,
  languageForExtension,
  resolveLocalContractDependencies,
  type DerivedEvidenceFacts,
  type SourceAnalysisInput,
  type SymbolEventContext,
} from "patchmesh-analyzers";
import type {
  EventId,
  FileChangedEvent,
  ProtocolEvent,
  ResourceVersion,
  Source,
  SymbolChangedEvent,
} from "patchmesh-protocol";
import type { RepositoryIdentity } from "./identity.js";

/**
 * Turn observed file changes into symbol-level changes, by parsing the file off disk.
 *
 * Thirteen of the protocol's sixteen event types had never been produced, and that single fact
 * was the ceiling on every detector: `contracts` is typed against `symbol.changed` and
 * `dependency.changed`, so it could never report anything however well it was written. This is
 * the cheapest half of lifting that ceiling, and it is cheap because the hard part already
 * existed — `patchmesh-analyzers` parses TypeScript and Python, extracts exported signatures,
 * and compares them for compatibility. It was only ever wired to the proxied `McpProxy` path,
 * which does not run. See docs/problems/PM-05.
 *
 * **Why this is not requested-path inference.** The M7 constraint bans deriving what a call
 * touched from the text of the call. Nothing here reads a command. It reads a file that the
 * filesystem observation already proved changed, and parses its actual contents. That is direct
 * observation of the same kind as the change event itself.
 *
 * **Why it lives here rather than in `effects.ts`.** Keeping it in its own module keeps
 * `patchmesh-analyzers` out of any import chain that `bin.ts` can reach. That binary runs on
 * every tool call and its header forbids importing anything heavier than Node builtins; a
 * parser reached transitively would tax every call in the session. This module is imported only
 * by the drain, which pays its costs once per turn and has a 60s budget.
 */

/**
 * Files larger than this are skipped rather than parsed.
 *
 * The drain is not on the agent's critical path, but it is not unbounded either, and a
 * generated bundle or a checked-in dataset can be megabytes of one line. Skipping is the right
 * failure: a symbol event that never appears costs a detector some input, while a drain that
 * times out loses the whole turn's observations.
 */
const MAX_ANALYZED_BYTES = 512 * 1024;

/**
 * The target these facts were derived against.
 *
 * The proxied path binds analysis to an immutable integration-target snapshot, because there it
 * is deciding whether a *proposed* change is compatible with a target. A hook recorder is only
 * ever describing the working tree as it actually is, so there is one target and naming it
 * honestly is better than inventing a snapshot identity that nothing produced.
 */
const INTEGRATION_TARGET = "worktree";

const ANALYZER = { analyzerId: "patchmesh-recorder-ingest", version: "1" } as const;

export interface SymbolDerivationOptions {
  readonly identity: RepositoryIdentity;
  readonly source: Source;
  /**
   * The events just built. Only `file.changed` members are parsed; anything else is ignored,
   * so the caller can hand over whatever the observation produced without pre-filtering.
   */
  readonly changes: readonly ProtocolEvent[];
  /**
   * Latest known version per symbol resource, so a symbol that already existed is reported as
   * modified against what it was rather than as created again.
   */
  readonly priorSymbolVersions: ReadonlyMap<string, ResourceVersion>;
  readonly now: () => string;
  readonly nextEventId: () => EventId;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Read the file only if it is still exactly what was observed.
 *
 * Between the snapshot diff and this parse the agent may have written again. Analyzing the
 * newer content and attributing it to the observed version would produce a symbol signature
 * that never existed at that version — a fabricated fact, which is worse than a missing one.
 * The hash comparison is what makes this observation rather than assumption.
 */
function contentMatchingObservedVersion(worktreeRoot: string, change: FileChangedEvent): string | null {
  const locator = change.payload.resource.locator;
  const absolute = join(worktreeRoot, locator);
  try {
    if (statSync(absolute).size > MAX_ANALYZED_BYTES) return null;
    const content = readFileSync(absolute);
    if (sha256(content) !== change.payload.afterVersion.value) return null;
    return content.toString("utf8");
  } catch {
    // Deleted, unreadable, or outside the worktree. All of them mean "no symbols to report".
    return null;
  }
}

export function deriveAnalysisEvents(options: SymbolDerivationOptions): readonly ProtocolEvent[] {
  const derived: ProtocolEvent[] = [];
  const timestamp = options.now();
  // Facts are kept per change so imports can be resolved across the whole batch afterwards.
  // A dependency is a relationship between two files, so it cannot be decided one file at a time.
  const analyzed: Array<{ change: FileChangedEvent; facts: DerivedEvidenceFacts }> = [];

  for (const candidate of options.changes) {
    if (candidate.eventType !== "file.changed") continue;
    const change: FileChangedEvent = candidate;
    if (change.payload.changeKind === "deleted") continue;
    const locator = change.payload.resource.locator;
    const language: SourceAnalysisInput["language"] = languageForExtension(extname(locator));
    if (language === "unsupported") continue;

    const content = contentMatchingObservedVersion(options.identity.worktreeRoot, change);
    if (content === null) continue;

    let facts;
    try {
      facts = deriveEvidenceFacts({
        resource: change.payload.resource,
        version: change.payload.afterVersion,
        content,
        language,
        sourceEventIds: [change.eventId],
        analyzer: ANALYZER,
        configuration: {},
        integrationTarget: INTEGRATION_TARGET,
      });
    } catch {
      // A parse this analyzer cannot complete is a gap in what is known, not a failed drain.
      continue;
    }
    // Degraded coverage means the analyzer could not stand behind the facts. Recording them
    // anyway would put unverified signatures in front of a detector that treats them as proof.
    if (facts.source.coverage.status === "degraded") continue;
    if (facts.symbols.length === 0) continue;

    const context: SymbolEventContext = {
      repositoryId: change.repositoryId,
      workspaceId: change.workspaceId,
      worktreeId: change.worktreeId,
      // The symbol change inherits the file change's attribution and correlation. It must:
      // a child has to share its parent's correlation, and the causal parent set below is the
      // `file.changed` event itself, which is the only thing that proves the file changed.
      agentId: change.agentId,
      taskId: change.taskId,
      correlationId: change.correlationId,
      source: options.source,
      timestamp,
      sourceSequenceStart: null,
    };

    analyzed.push({ change, facts });
    for (const event of deriveSymbolChangedEvents(facts, facts.symbols.map(() => options.nextEventId()), context)) {
      const before = options.priorSymbolVersions.get(event.payload.resource.resourceId);
      derived.push(before === undefined ? event : {
        ...event,
        payload: {
          ...event.payload,
          // A symbol seen before did not spring into existence; report what it was.
          beforeVersion: { ...event.payload.afterVersion, value: before.value, evidenceEventIds: before.evidenceEventIds },
          changeKind: "modified",
        },
      });
    }
  }

  // Dependencies resolve only among the files analyzed in this batch. An import into a file
  // that did not change has no fact set here to bind to, and inventing one would be exactly the
  // guess the resolver refuses to make -- it leaves unresolved imports unresolved on purpose.
  const resolved = resolveLocalContractDependencies(analyzed.map((entry) => entry.facts));
  const changeByEventId = new Map(analyzed.map((entry) => [entry.change.eventId, entry.change] as const));
  for (const dependency of resolved) {
    // Each dependency is caused by the *consumer* file's change, so it must carry that file's
    // correlation and attribution rather than a shared batch context. A child event in the
    // wrong correlation makes the whole set fail replay, which per-event validation cannot see.
    const consumerEventId = dependency.consumer.sourceFacts.sourceEventIds[0];
    const consumer = consumerEventId === undefined ? undefined : changeByEventId.get(consumerEventId);
    if (consumer === undefined) continue;
    derived.push(...deriveDependencyChangedEvents([dependency], [options.nextEventId()], {
      repositoryId: consumer.repositoryId,
      workspaceId: consumer.workspaceId,
      worktreeId: consumer.worktreeId,
      agentId: consumer.agentId,
      taskId: consumer.taskId,
      correlationId: consumer.correlationId,
      source: options.source,
      timestamp,
      sourceSequenceStart: null,
    }));
  }
  return derived;
}

/**
 * Latest recorded version per symbol resource, for filling in what a symbol used to be.
 *
 * Read from the events already in the ledger rather than tracked separately: the ledger is the
 * only thing that survives a restart, and a cache of this would be a second source of truth for
 * a fact the ledger already holds.
 */
export function latestSymbolVersions(events: readonly { eventType: string }[]): ReadonlyMap<string, ResourceVersion> {
  const latest = new Map<string, ResourceVersion>();
  for (const event of events) {
    if (event.eventType !== "symbol.changed") continue;
    const symbolEvent = event as unknown as SymbolChangedEvent;
    latest.set(symbolEvent.payload.resource.resourceId, symbolEvent.payload.afterVersion);
  }
  return latest;
}
