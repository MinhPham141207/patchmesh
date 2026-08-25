import { existsSync } from "node:fs";
import { agentIdForSession } from "./identity.js";
import { readInFlightCalls } from "./inflight.js";
import { readRecentWrites, readWatermark, watermarkPathFor, type RecentWrite } from "./recent-writes.js";

/**
 * PM-02 option A: an advisory that a different agent has a call in flight touching the same
 * file. Computed at two points, on the same matching logic, because they reach different
 * audiences:
 *
 * - `PreToolUse`, before the edit happens (`computeContentionAdvisory`). This is the moment
 *   PM-02 actually wants -- a warning before the write. But the host's only documented
 *   channels for reaching Claude's own context on `PreToolUse` are `deny` and `ask`, and both
 *   block, which PM-02 rules out until this advisory has a measured false-positive rate. So
 *   this stage's output (`permissionDecision: "allow"` + a reason) is confirmed non-blocking
 *   but only confirmed to reach the *user's* transcript, not the model.
 * - `PostToolUse`, right after the write (`computePostWriteAdvisory`). One call later than
 *   intended, but `additionalContext` is documented as valid here and is delivered into the
 *   current turn, so this is the stage that actually reaches the agent. "You just wrote a
 *   file another agent is currently in" is weaker than a warning before the write, but it is
 *   still something the status quo (Stop-time ingest, or a voluntary MCP call) does not say
 *   while it is still true.
 *
 * Because only one of the two stages is confirmed to reach the model, there is no double
 * warning of the *agent* even when both fire for the same call: `PreToolUse`'s reason is
 * transcript-only as far as the docs establish, so `PostToolUse`'s `additionalContext` is the
 * only one an agent ever actually reads. See `bin.ts` and
 * `docs/problems/PM-02-no-intervention-point.md` for the full reasoning.
 *
 * Scoped to `Edit`/`Write` only, at both stages. `tool_input.file_path` is the one thing
 * those two host tools declare that names the resource unambiguously; `Bash` and everything
 * else are opaque by the project's own measurement (~90% of recorded `Bash` calls carry no
 * path), and parsing a path out of command text is the M7 ban this project holds. An opaque
 * call is treated as unknown here -- never as safe, and never as contended.
 */

const ADVISORY_HOST_TOOLS = new Set(["Edit", "Write"]);

/** Which hook fired: decides both what the payload is expected to look like and how the message is framed. */
type AdvisoryStage = "PreToolUse" | "PostToolUse";

/** What was observed: a specific other call, still running, on this path. */
export interface ContentionAdvisory {
  readonly path: string;
  readonly agentId: string | null;
  readonly hostToolName: string;
  readonly runningForMs: number;
  /**
   * States what was observed, not what it implies. Same file does not mean same work: two
   * agents can be in the same file for unrelated reasons, so the message never claims a
   * conflict, only that another call is in flight there.
   */
  readonly message: string;
  /**
   * Set only when this fact came from the recent-write side of the predicate (not from an
   * in-flight collision). The consumer advances the cursor after the message reaches stdout,
   * so each fact is delivered once per session; `bin.ts` owns that advance.
   */
  readonly delivery?: DeliveredFact | undefined;
}

/** Where a delivered fact lives and how far to move the session's read cursor past it. */
export interface DeliveredFact {
  readonly cursorPath: string;
  readonly advanceTo: string;
}

export interface ComputeAdvisoryOptions {
  readonly worktreeRoot: string;
  /**
   * The already-redacted hook payload -- the same shape `readInFlightCalls` reads back from
   * the journal, so a path compared here is compared on equal terms with what is on disk.
   */
  readonly payload: Record<string, unknown>;
  readonly directory?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Render what was observed, honestly. "Agent X has a call in flight that touched this file
 * 12s ago" is the bar: it says what happened, not what it means. It never says "conflict" --
 * that is a conclusion this module has no basis for, since it only ever compares one path
 * string against another. The `PostToolUse` framing adds one further fact -- that the write
 * this hook fired for already happened -- rather than pretending it is still a warning
 * before the fact.
 */
function renderMessage(
  stage: AdvisoryStage,
  path: string,
  hostToolName: string,
  agentId: string | null,
  runningForMs: number,
): string {
  const seconds = Math.max(Math.round(runningForMs / 1000), 0);
  const agentLabel = agentId ?? "an unidentified agent";
  const observation =
    `${agentLabel} has a call in flight (${hostToolName}) that started touching \`${path}\` `
    + `${seconds}s ago and has not finished.`;
  const afterTheFact = stage === "PostToolUse" ? ` You just wrote \`${path}\` too.` : "";
  return `${observation}${afterTheFact} Same file does not mean same work.`;
}

/**
 * Render a completed write by another session, observed minutes -- not seconds -- ago. The
 * honest tense changes with the fact: nothing is "in flight" here, the write already
 * finished. The `PostToolUse` framing adds the same clause as above: the write this hook
 * fired for also happened, so both sides are on disk now.
 */
function renderRecentWriteMessage(stage: AdvisoryStage, path: string, agentId: string | null, agoMs: number): string {
  const minutes = Math.max(Math.round(agoMs / 60_000), 1);
  const agentLabel = agentId ?? "an unidentified agent";
  const noun = minutes === 1 ? "minute" : "minutes";
  const observation = `${agentLabel} wrote \`${path}\` ${minutes} ${noun} ago.`;
  const afterTheFact = stage === "PostToolUse" ? ` You just wrote \`${path}\` too.` : "";
  return `${observation}${afterTheFact} Same file does not mean same work.`;
}

/**
 * Read this session's delivery cursor and the unreported recent writes past it.
 *
 * A cursor that did not exist before this call was just armed by `readWatermark` at `now`,
 * which would filter out every write in the window -- so on that first contact the window is
 * consulted whole. From the second look on, only entries strictly newer than the watermark
 * count; each fact is delivered once per session because `bin.ts` advances the watermark
 * after the message reaches stdout.
 */
function unreportedRecentWrites(
  options: ComputeAdvisoryOptions,
  sessionId: string,
): { readonly writes: readonly RecentWrite[]; readonly cursorPath: string } {
  const now = (options.now ?? (() => new Date()))();
  const cursorPath = watermarkPathFor(options.worktreeRoot, options.directory ?? ".patchmesh", sessionId);
  const cursorExisted = existsSync(cursorPath);
  const watermark = readWatermark(cursorPath, now.toISOString());
  const writes = readRecentWrites({
    worktreeRoot: options.worktreeRoot,
    directory: options.directory,
    now: options.now,
    excludeSessionId: sessionId,
    sinceIso: cursorExisted ? watermark : undefined,
  });
  return { writes, cursorPath };
}

/**
 * Null unless this is a call of the given `stage` on `Edit`/`Write` whose path is also named
 * by a different agent's still-running call. Excludes the caller's own agent, derived from its
 * own `session_id` exactly as the recorder derives it elsewhere, so an agent never rediscovers
 * its own in-flight work as a collision.
 */
function computeAdvisoryFor(stage: AdvisoryStage, options: ComputeAdvisoryOptions): ContentionAdvisory | null {
  const payload = options.payload;
  if (stringField(payload, "hook_event_name") !== stage) return null;

  const hostToolName = stringField(payload, "tool_name");
  if (hostToolName === null || !ADVISORY_HOST_TOOLS.has(hostToolName)) return null;

  const toolInput = isRecord(payload["tool_input"]) ? payload["tool_input"] : {};
  const path = stringField(toolInput, "file_path");
  if (path === null) return null;

  const sessionId = stringField(payload, "session_id");
  const ownAgentId = sessionId === null ? null : agentIdForSession(sessionId);

  const inFlight = readInFlightCalls({
    worktreeRoot: options.worktreeRoot,
    directory: options.directory,
    now: options.now,
    excludeAgentId: ownAgentId ?? undefined,
  });

  const collision = inFlight.find((call) => call.operation === path);
  if (collision !== undefined) {
    return {
      path,
      agentId: collision.agentId,
      hostToolName: collision.hostToolName,
      runningForMs: collision.runningForMs,
      message: renderMessage(stage, path, collision.hostToolName, collision.agentId, collision.runningForMs),
    };
  }

  // Nothing in flight right now; the honest next question is who wrote here lately and whether
  // this session was told. Facts are delivered once per session through the cursor.
  if (sessionId === null) return null;
  const { writes, cursorPath } = unreportedRecentWrites(options, sessionId);
  const write = writes.find((candidate) => candidate.path === path);
  if (write === undefined) return null;

  const agoMs = (options.now ?? (() => new Date()))().getTime() - new Date(write.at).getTime();
  return {
    path,
    agentId: write.agentId,
    hostToolName: write.hostToolName,
    runningForMs: agoMs,
    message: renderRecentWriteMessage(stage, path, write.agentId, agoMs),
    delivery: { cursorPath, advanceTo: write.at },
  };
}

/**
 * The `PreToolUse` stage. See the module doc for why its output is confirmed non-blocking but
 * not confirmed to reach the agent.
 */
export function computeContentionAdvisory(options: ComputeAdvisoryOptions): ContentionAdvisory | null {
  return computeAdvisoryFor("PreToolUse", options);
}

/**
 * The `PostToolUse` stage, one call later than `PreToolUse` but delivered via
 * `additionalContext`, which is documented as reaching Claude's own context in the current
 * turn. This is what actually warns the agent today.
 */
export function computePostWriteAdvisory(options: ComputeAdvisoryOptions): ContentionAdvisory | null {
  return computeAdvisoryFor("PostToolUse", options);
}

/**
 * How many contested paths a turn-start notice names before it summarises the rest.
 *
 * A turn-start advisory is unsolicited context spent on every prompt, so it has to stay small
 * enough to be read. Five is the point where the list still scans as a list; past that it
 * reads as a wall and the reader skips it, which costs more than saying less would have.
 */
const TURN_START_PATH_LIMIT = 5;

/** What another agent was observed to be in, at the moment this turn began. */
export interface TurnStartAdvisory {
  /** Distinct paths other agents have in flight or recently finished, most recent first. */
  readonly paths: readonly string[];
  /** Paths that matched but were not named, so the notice can say what it withheld. */
  readonly withheld: number;
  readonly agents: readonly string[];
  readonly message: string;
  /**
   * Set only when some named paths came from the recent-write side; `bin.ts` advances this
   * cursor after the notice reaches stdout so each fact is delivered once per session.
   */
  readonly delivery?: DeliveredFact | undefined;
}

/**
 * Render the turn-start notice.
 *
 * Two conventions this repository holds are load-bearing here. It reports what it withheld,
 * because a truncated list that does not say it is truncated reads as the whole truth. And it
 * states an observation rather than a conclusion: another agent having a file open is not a
 * collision, and this module cannot tell the difference.
 */
function renderTurnStartMessage(paths: readonly string[], withheld: number, agents: readonly string[]): string {
  const named = paths.slice(0, TURN_START_PATH_LIMIT);
  const lines = named.map((path) => `- \`${path}\``);
  const agentCount = agents.length;
  const subject = agentCount === 1 ? "Another agent has" : `${agentCount} other agents have`;
  const withheldNote = withheld > 0 ? `\n(${withheld} further path(s) not named.)` : "";
  return (
    `${subject} work in flight or just finished in this repository, in:\n`
    + `${lines.join("\n")}${withheldNote}\n`
    + "Same file does not mean same work. This is what was observed at the start of this turn, "
    + "not a claim that anything is contested."
  );
}

/**
 * The `UserPromptSubmit` stage: what other agents are already inside, before this turn has
 * made its first tool call.
 *
 * This is the only advisory stage that runs genuinely *before* a write, which is what PM-02
 * asks for and what `PreToolUse` cannot deliver -- see the module doc. It pays for that by
 * being coarser: `UserPromptSubmit` carries no `tool_input`, so there is no path to match
 * against and the notice is repository-wide rather than about one file.
 *
 * Only in-flight calls whose host tool names a path are reported. An opaque `Bash` call tells
 * us nothing about which file it is in, and guessing from its command text is the inference
 * this project bans -- so it is left out rather than reported as a path it might not touch.
 * Recent completed writes join them through the delivery cursor, so a write that finished
 * minutes ago still reaches the next turn instead of vanishing with its 1.9s window.
 *
 * Returns null when nothing is in flight and nothing recent went unreported. Silence is
 * deliberate: a notice on every turn saying
 * there are no collisions is the permanently-degraded mistake PM-12 already paid for, in a new
 * costume. An advisory that always fires stops being read.
 */
export function computeTurnStartAdvisory(options: ComputeAdvisoryOptions): TurnStartAdvisory | null {
  const payload = options.payload;
  if (stringField(payload, "hook_event_name") !== "UserPromptSubmit") return null;

  const sessionId = stringField(payload, "session_id");
  const ownAgentId = sessionId === null ? null : agentIdForSession(sessionId);

  const inFlight = readInFlightCalls({
    worktreeRoot: options.worktreeRoot,
    directory: options.directory,
    now: options.now,
    excludeAgentId: ownAgentId ?? undefined,
  });

  const paths: string[] = [];
  const agents = new Set<string>();
  for (const call of inFlight) {
    if (!ADVISORY_HOST_TOOLS.has(call.hostToolName)) continue;
    const path = call.operation;
    if (path === null) continue;
    if (!paths.includes(path)) paths.push(path);
    agents.add(call.agentId ?? "an unidentified agent");
  }

  // Merge what other sessions finished writing inside the recent window and this session has
  // not been told about yet -- the same cursor/watermark pattern as the content stages, but
  // repository-wide since a turn start has no path of its own to match against.
  let delivery: DeliveredFact | undefined;
  if (sessionId !== null) {
    const { writes, cursorPath } = unreportedRecentWrites(options, sessionId);
    for (const write of writes) {
      if (!paths.includes(write.path)) paths.push(write.path);
      agents.add(write.agentId ?? "an unidentified agent");
    }
    if (writes.length > 0) delivery = { cursorPath, advanceTo: writes[0]!.at };
  }
  if (paths.length === 0) return null;

  const withheld = Math.max(paths.length - TURN_START_PATH_LIMIT, 0);
  const agentList = [...agents];
  return {
    paths,
    withheld,
    agents: agentList,
    message: renderTurnStartMessage(paths, withheld, agentList),
    delivery,
  };
}
