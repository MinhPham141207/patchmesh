#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon, type PatchMeshDaemon } from "patchmesh-daemon";
import {
  acknowledgeMessage,
  findOverlappingWork,
  measureAdoption,
  measureTimeToResume,
  ReadServiceError,
  readInbox,
  recapRecentWork,
  renderAdoption,
  renderResumeMetrics,
  sendMail,
  treatmentBoundaryFrom,
  undeliveredCount,
  type OverlapOptions,
  type OverlapResult,
  type ReadServices,
  type RecapOptions,
  type RecapResult,
  type StatusView,
} from "patchmesh-query";
import type { EventType } from "patchmesh-protocol";
import { findWorktreeRoot, freshenLedger, ledgerPathFor, LEDGER_DIRECTORY } from "patchmesh-recorder";
import { commands, parseArgs, usageText, type CommandName, type ParsedArgs } from "./args.js";
import { renderConsoleBanner, renderGraphServerBanner, startGraphServer, type GraphServer, type GraphServerOptions } from "./graph-server.js";
import { collapseEvents } from "./console-model.js";
import { diagnose, renderDoctor } from "./doctor.js";
import { initializeRepository, renderInit } from "./init.js";
import {
  renderAckResponse,
  renderAgents,
  renderDecisionExplanation,
  renderDetectorUnavailable,
  renderDeliveryResponse,
  renderEvents,
  renderEventCalls,
  TERMINAL_CALL_ROWS,
  renderFeedbackResponse,
  renderFindings,
  renderGraph,
  renderInbox,
  renderMessageSent,
  renderOverlaps,
  renderPrune,
  renderRecap,
  renderStatus,
} from "./render.js";

export interface CliDependencies {
  readonly services: ReadServices;
  readonly feedbackWriter?: Pick<PatchMeshDaemon, "respondToFinding">;
  readonly deliveryWriter?: Pick<PatchMeshDaemon, "respondToDecisionDelivery">;
  /** Retention writer. Injected like the others so the command is testable without a store. */
  readonly pruner?: Pick<PatchMeshDaemon, "prune">;
  readonly signal?: AbortSignal;
  /**
   * Which checkout the ledger describes. `overlaps` resolves repository identity from it, so
   * the command answers about the repository the user is standing in rather than about a
   * database path. Tests inject it; the binary derives it from the working directory.
   */
  readonly worktreeRoot?: string;
  /**
   * Reads overlapping work. Injected like the writers above so the CLI stays testable without
   * a real checkout and a real ledger on disk - `overlaps` is the one report that does not go
   * through `ReadServices`, because the work-graph projection cannot answer it.
   */
  readonly readOverlaps?: (options: OverlapOptions) => OverlapResult;
  /** Reads a recap. Injected for the same reason as `readOverlaps`: it opens the store itself. */
  readonly readRecap?: (options: RecapOptions) => RecapResult;
  /**
   * Starts the work-graph site. Injected so a test can drive the real server on an ephemeral
   * port without the command reaching for the user's browser.
   */
  readonly serveGraph?: (options: GraphServerOptions) => Promise<GraphServer>;
  /**
   * Reads a piped message body for `send`. Injected like the readers above so tests never
   * touch the process's own stdin. The default reads stdin only when it is not a TTY, so an
   * interactive `send` that forgot `--body` fails fast instead of hanging on an EOF that
   * will never come.
   */
  readonly readStdin?: () => Promise<string>;
}

/** The default body reader: piped stdin verbatim; an interactive terminal reads as empty. */
function readPipedStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.once("end", () => resolve(data));
    // A partial read is not a body: sending half a handoff would read as sent while meaning
    // something else, so the error surfaces as a usage failure instead.
    process.stdin.once("error", (error) => {
      reject(new ReadServiceError("usage", `could not read the piped message body: ${String(error)}`));
    });
  });
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set by commands that keep running after they have printed. `main` waits on it before
   * closing the store, so the served page can keep answering from a live ledger rather than
   * from a snapshot taken at launch.
   */
  readonly hold?: Promise<void>;
}

/** Stop serving when the process is interrupted, so Ctrl+C ends the command rather than the run. */
function stopOnAbort(signal: AbortSignal, server: GraphServer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { server.close(); resolve(); return; }
    signal.addEventListener("abort", () => { server.close(); resolve(); }, { once: true });
  });
}

/** Drop the one newline a shell pipe appends, so `echo hi | send ...` (no --body) sends "hi". */
function trimTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function exitCode(error: ReadServiceError): number {
  return error.code === "usage" ? 2 : error.code === "unavailable" ? 3 : 4;
}

/**
 * The event types each graph-backed detector needs before it can find anything.
 *
 * Both were built against the MCP-proxy path, where a call declares which read it depended on
 * and which contract it changed. A host-hook recorder observes neither: a read leaves no trace
 * on disk to find, and nothing in a hook payload declares a dependency. Checking counts is not
 * a heuristic - it is asking whether the inputs the detector is typed against were ever
 * recorded at all.
 */
const DETECTOR_EVIDENCE = {
  stale: ["file.read", "write.dependent"],
  contracts: ["symbol.changed", "dependency.changed"],
} as const satisfies Record<string, readonly EventType[]>;

function missingDetectorEvidence(command: "stale" | "contracts", status: StatusView): readonly string[] {
  return DETECTOR_EVIDENCE[command].filter((eventType) => (status.eventTypeCounts[eventType] ?? 0) === 0);
}

async function renderCommand(
  parsed: ParsedArgs,
  services: ReadServices,
  feedbackWriter: CliDependencies["feedbackWriter"],
  deliveryWriter: CliDependencies["deliveryWriter"],
  pruner: CliDependencies["pruner"],
  worktreeRoot: string | null,
  readOverlaps: (options: OverlapOptions) => OverlapResult,
  readRecap: (options: RecapOptions) => RecapResult,
  readStdin: () => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  if (parsed.command === "help") return `${usageText()}\n`;
  if (parsed.command === "init") {
    if (worktreeRoot === null) throw new ReadServiceError("usage", "init must be run inside a git repository");
    return renderInit(
      initializeRepository({
        worktreeRoot,
        installHooks: parsed.init.hooks,
        updateGitignore: parsed.init.gitignore,
        force: parsed.init.force,
      }),
      parsed.json,
    );
  }
  if (parsed.command === "prune") {
    if (pruner === undefined) throw new ReadServiceError("unavailable", "prune requires a writable event store");
    if (parsed.olderThanDays === null) throw new ReadServiceError("usage", "prune requires --older-than <days>");
    const cutoff = new Date(Date.now() - parsed.olderThanDays * 24 * 60 * 60_000);
    return renderPrune(pruner.prune({ olderThan: cutoff }), cutoff, parsed.json);
  }
  if (parsed.command === "recap") {
    if (worktreeRoot === null) {
      throw new ReadServiceError("unavailable", "recap needs a git worktree; run it inside the repository the ledger describes");
    }
    if (parsed.recapMetrics) {
      // Measured here rather than through `ReadServices` for the same reason as recap itself:
      // it opens the store directly, and the work-graph projection cannot answer it.
      // The treatment boundary is the hook's first injection, which only the measurement file
      // records -- the session-start binary reads and never writes an event. Derived here and
      // passed in, so the query package stays a reader of the ledger and nothing else.
      let treatmentSince: string | null = null;
      try {
        treatmentSince = treatmentBoundaryFrom(
          readFileSync(join(worktreeRoot, LEDGER_DIRECTORY, "answers.ndjson"), "utf8"),
        );
      } catch {
        // Nothing injected yet, or no measurement file: there is no treatment arm to split off.
      }
      // Suppressed when the caller asked for one explicit cohort: they are already looking at a
      // single arm, and splitting that arm again would compare it against its own remainder.
      const cohortRequested = parsed.eventQuery.since !== undefined || parsed.eventQuery.until !== undefined;
      const metrics = measureTimeToResume({
        ledgerPath: parsed.databasePath ?? "",
        ...(parsed.agentFilters.agentId === undefined ? {} : { agent: parsed.agentFilters.agentId }),
        ...(parsed.eventQuery.since === undefined ? {} : { since: parsed.eventQuery.since }),
        ...(parsed.eventQuery.until === undefined ? {} : { until: parsed.eventQuery.until }),
        ...(treatmentSince === null || cohortRequested ? {} : { treatmentSince }),
      });
      // Adoption rides along with the resume metric because they answer one question between
      // them: whether the push surface is carrying sessions, and whether any session ever
      // chose to ask. Either number alone can be read as success.
      const adoption = measureAdoption({ ledgerPath: parsed.databasePath ?? "" });
      return parsed.json
        ? `${JSON.stringify({ ...metrics, adoption })}\n`
        : `${renderResumeMetrics(metrics)}\n\n${renderAdoption(adoption)}\n`;
    }
    // The same answer `patchmesh_recap` gives an agent, given to the person. It was reachable
    // only over MCP, which meant the surface the product leads with could not be run by the
    // user reading the README that recommends it.
    return renderRecap(
      readRecap({
        worktreeRoot,
        ledgerPath: parsed.databasePath ?? "",
        ...(parsed.agentFilters.agentId === undefined ? {} : { agent: parsed.agentFilters.agentId }),
        ...(parsed.withinMinutes === null ? {} : { withinMinutes: parsed.withinMinutes }),
        ...(parsed.recapLimit === null ? {} : { limit: parsed.recapLimit }),
      }),
      parsed.agentFilters.agentId ?? undefined,
      parsed.json,
    );
  }
  // The undelivered count is computed here rather than folded into `StatusView`: it needs the
  // ledger path, which `ReadServices` does not carry (it reads through an injected reader), and
  // `undeliveredCount` fails soft to zero on an unreadable ledger like every other count.
  if (parsed.command === "status") {
    return renderStatus(services.getStatus(), undeliveredCount(parsed.databasePath ?? ""), parsed.json);
  }
  if (parsed.command === "agents") return renderAgents(services.listAgents(parsed.agentFilters), parsed.json);
  if (parsed.command === "graph") return renderGraph(services.getGraph(parsed.graphFilters), parsed.json);
  if (parsed.command === "overlaps") {
    if (worktreeRoot === null) {
      throw new ReadServiceError("unavailable", "overlaps needs a git worktree; run it inside the repository the ledger describes");
    }
    return renderOverlaps(
      readOverlaps({
        worktreeRoot,
        ledgerPath: parsed.databasePath ?? "",
        path: parsed.graphFilters.resourceId,
        withinMinutes: parsed.withinMinutes ?? undefined,
      }),
      parsed.json,
    );
  }
  if (parsed.command === "stale" || parsed.command === "contracts") {
    const missing = missingDetectorEvidence(parsed.command, services.getStatus());
    if (missing.length > 0) return renderDetectorUnavailable(parsed.command, missing, parsed.json);
    const findingType = parsed.command === "stale" ? "stale_read_before_write" : "exported_contract_invalidation";
    return renderFindings(services.listFindings({ findingType }), parsed.json, parsed.command);
  }
  if (parsed.command === "explain") return renderDecisionExplanation(services.explainDecision(parsed.decisionId!), parsed.json);
  if (parsed.command === "feedback") {
    if (feedbackWriter === undefined) throw new ReadServiceError("unavailable", "finding feedback writer is unavailable");
    const feedback = parsed.feedback!;
    const result = feedbackWriter.respondToFinding({
      ...feedback,
      actor: {
        agentId: parsed.agentFilters.agentId ?? null,
        taskId: parsed.agentFilters.taskId ?? null,
      },
    });
    return renderFeedbackResponse(result, feedback.findingId, feedback.disposition, parsed.json);
  }
  if (parsed.command === "delivery") {
    if (deliveryWriter === undefined) throw new ReadServiceError("unavailable", "decision delivery writer is unavailable");
    const delivery = parsed.delivery!;
    const result = deliveryWriter.respondToDecisionDelivery(delivery);
    return renderDeliveryResponse(result, delivery.decisionId, delivery.state, parsed.json);
  }
  if (parsed.command === "send") {
    if (worktreeRoot === null) {
      throw new ReadServiceError("unavailable", "send needs a git worktree; run it inside the repository the ledger describes");
    }
    const send = parsed.send!;
    // No `--body` means the body arrives on stdin -- piped only. A terminal reads as empty,
    // and sendMail rejects the empty body rather than sending blank mail.
    const body = send.body ?? trimTrailingNewline(await readStdin());
    const result = sendMail({
      worktreeRoot,
      ledgerPath: parsed.databasePath ?? "",
      from: send.from ?? parsed.agentFilters.agentId ?? null,
      to: send.to,
      kind: send.kind,
      subject: send.subject,
      body,
      ...(send.refs.length === 0 ? {} : { refs: send.refs }),
      ...(send.expiresAt === null ? {} : { expiresAt: send.expiresAt }),
    });
    return renderMessageSent(result, { to: send.to, kind: send.kind, subject: send.subject }, parsed.json);
  }
  if (parsed.command === "inbox") {
    // No `--agent` is a real audience here, not a missing argument: it asks for broadcasts
    // only, which is what a person with no session identity can still usefully read.
    const inbox = parsed.inbox!;
    const result = readInbox({
      worktreeRoot: worktreeRoot ?? "",
      ledgerPath: parsed.databasePath ?? "",
      agent: parsed.agentFilters.agentId ?? "",
      includeDelivered: inbox.includeDelivered,
    });
    return renderInbox(result, parsed.agentFilters.agentId, parsed.json);
  }
  if (parsed.command === "ack") {
    if (worktreeRoot === null) {
      throw new ReadServiceError("unavailable", "ack needs a git worktree; run it inside the repository the ledger describes");
    }
    const ack = parsed.ack!;
    const byAgentId = ack.from ?? parsed.agentFilters.agentId;
    if (byAgentId === null || byAgentId === undefined) {
      throw new ReadServiceError("usage", "ack requires attribution; pass --from <agent-id>");
    }
    const disposition = ack.disposition ?? "read";
    const result = acknowledgeMessage({
      worktreeRoot,
      ledgerPath: parsed.databasePath ?? "",
      byAgentId,
      messageId: ack.messageId,
      disposition,
      ...(ack.note === null ? {} : { note: ack.note }),
    });
    if (!result.ok) {
      throw new ReadServiceError("usage", result.reason ?? "the message could not be acknowledged");
    }
    return renderAckResponse(ack.messageId, disposition, ack.note, parsed.json);
  }
  // The default text mode answers with calls, not records: bounded, newest first, readable.
  // `--raw` and `--json` keep the per-event page, which is what scripts and follow read.
  if (!parsed.follow) {
    if (parsed.raw || parsed.json) return renderEvents(services.listEvents(parsed.eventQuery), parsed.json);
    const { limit: _limit, ...filters } = parsed.eventQuery;
    const page = services.listEvents(filters);
    return renderEventCalls(collapseEvents(page.events, parsed.eventQuery.limit ?? TERMINAL_CALL_ROWS));
  }
  let output = "";
  for await (const page of services.followEvents(parsed.eventQuery, signal)) output += renderEvents(page, parsed.json);
  return output;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<CliResult> {
  try {
    const parsed = parseArgs(argv);
    const worktreeRoot = dependencies.worktreeRoot ?? findWorktreeRoot(process.cwd());
    // Handled before `renderCommand` because it is the one report whose exit code carries the
    // answer. Every other command exits 0 when it successfully reports bad news; a health check
    // that did the same could not be used to gate anything.
    if (parsed.command === "doctor") {
      const report = diagnose({ worktreeRoot });
      return { exitCode: report.healthy ? 0 : 3, stdout: renderDoctor(report, parsed.json), stderr: "" };
    }
    // Reports answer about now, so the journal is drained before they read. Deliberately after
    // `doctor`, which is the one command whose subject *is* the undrained journal: freshening
    // first would erase the backlog it exists to report.
    if (worktreeRoot !== null && REPORT_ONLY.has(parsed.command) && ownsLedger(worktreeRoot, parsed.databasePath)) {
      // Effects observed too: a person asking `overlaps` once wants the filesystem walked,
      // and can afford it. The MCP tools deliberately do not - see `freshenLedger`.
      await freshenLedger({ worktreeRoot, ledgerPath: ledgerPathFor(worktreeRoot), observeEffects: true });
    }
    // Serving is handled before `renderCommand` because these are the commands that outlive
    // their own output: they return a handle the caller has to hold, not a rendered string.
    // `console` and `graph` are one server on one port - the console's Map lens is where
    // `graph` now lands, so two commands never mean two ports.
    const serves = parsed.command === "console" || (parsed.command === "graph" && parsed.graphOutput.mode === "site");
    if (serves) {
      const ledger = parsed.databasePath ?? "";
      const readRecap = dependencies.readRecap ?? recapRecentWork;
      const server = await (dependencies.serveGraph ?? startGraphServer)({
        services: dependencies.services,
        filters: parsed.graphFilters,
        ledger,
        ...(parsed.graphOutput.port === null ? {} : { port: parsed.graphOutput.port }),
        // The Now lens leads with a recap, which opens the store itself and needs the
        // worktree root. Outside a checkout it is simply absent, and the lens answers with
        // counts alone rather than failing.
        ...(worktreeRoot === null ? {} : { readRecap: () => readRecap({ worktreeRoot, ledgerPath: ledger }) }),
      });
      return {
        exitCode: 0,
        stdout: parsed.command === "console"
          ? renderConsoleBanner(server.url, ledger)
          : renderGraphServerBanner(server.url, ledger),
        stderr: "",
        hold: dependencies.signal === undefined
          ? server.closed
          : Promise.race([server.closed, stopOnAbort(dependencies.signal, server)]),
      };
    }
    return {
      exitCode: 0,
      stdout: await renderCommand(
        parsed,
        dependencies.services,
        dependencies.feedbackWriter,
        dependencies.deliveryWriter,
        dependencies.pruner,
        worktreeRoot,
        dependencies.readOverlaps ?? findOverlappingWork,
        dependencies.readRecap ?? recapRecentWork,
        dependencies.readStdin ?? readPipedStdin,
        dependencies.signal,
      ),
      stderr: "",
    };
  } catch (error) {
    if (error instanceof ReadServiceError) return { exitCode: exitCode(error), stdout: "", stderr: `${error.message}\n` };
    return { exitCode: 4, stdout: "", stderr: "PatchMesh command failed\n" };
  }
}

/** Commands that answer without reading the ledger, so they must not require one. */
function needsNoStore(argv: readonly string[]): boolean {
  const command = argv[0];
  // `doctor` belongs here for the same reason `init` does, and more strongly: it is the
  // command you run *because* the ledger is missing, so gating it behind one would refuse to
  // answer exactly the question it exists for.
  // A word that is not a command at all belongs here too, and so does no word: neither can
  // need a ledger. `--help` and `-h` fall through the same door, since they are not commands
  // either. Resolving a database first meant `patchmesh frobnicate` outside a repository
  // complained about the missing repository instead of about the typo the user made.
  if (command === undefined || !commands.has(command as CommandName)) return true;
  return command === "init" || command === "doctor" || command === "help";
}

/**
 * Commands that only report, so an absent ledger is an answer rather than a failure.
 *
 * The write commands are deliberately absent: `feedback` and `delivery` append events, and a
 * missing store means they recorded nothing. Exiting 0 there would report success for work
 * that did not happen.
 */
const REPORT_ONLY = new Set(["status", "recap", "agents", "events", "console", "graph", "overlaps", "stale", "contracts", "explain"]);

/**
 * Whether the database this command was pointed at is the repository's own ledger.
 *
 * Freshening drains the live journal, and a journal belongs to exactly one repository.
 * `--database` can name anything -- a fixture, a copy, another checkout's ledger -- and
 * draining this repository's in-flight calls into one of those would write them somewhere
 * they do not belong *and* consume them, so they could never reach the ledger that wanted
 * them. A report pointed at a foreign database therefore reads it exactly as it finds it.
 */
function ownsLedger(worktreeRoot: string, databasePath: string | null | undefined): boolean {
  if (databasePath === null || databasePath === undefined || databasePath === "") return true;
  try {
    const same = (left: string, right: string): boolean =>
      process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
    return same(resolve(databasePath), resolve(ledgerPathFor(worktreeRoot)));
  } catch {
    // Cannot tell whose it is, so do not write to it.
    return false;
  }
}

/**
 * What a repository looks like before it has been worked in.
 *
 * The first thing a new user runs is `patchmesh status`, and before this the first thing
 * PatchMesh said to them was `database is unavailable` — which reads as a broken tool rather
 * than an empty one. Nothing has gone wrong: the recorder creates the ledger on its first
 * write, so no file is the honest state of a repository whose agent has not run yet.
 */
function renderNoLedger(path: string, json: boolean): string {
  if (json) return `${JSON.stringify({ ledger: path, exists: false, events: 0 })}\n`;
  return [
    `No ledger at ${path} yet, so nothing has been recorded.`,
    "",
    "If you have not run `patchmesh init` in this repository, run it and restart the agent",
    "session so it loads the hooks. If you have, work normally and come back — the recorder",
    "creates the ledger on the first tool call it sees.",
    "",
  ].join("\n");
}

/**
 * Read services for a command that never reads. Every method throws rather than returning an
 * empty answer, so a command routed here by mistake fails loudly instead of reporting nothing.
 */
function unavailableServices(): ReadServices {
  const unavailable = (): never => {
    throw new ReadServiceError("unavailable", "this command does not read the event store");
  };
  return new Proxy({} as ReadServices, { get: () => unavailable });
}

/**
 * Which ledger to read, defaulting to the one this repository owns.
 *
 * The recorder writes to `<worktree>/.patchmesh/ledger.db` and nowhere else -- the path is a
 * convention, not a configurable. Requiring `--database` on every invocation made the user
 * retype a value that has exactly one correct answer, and got it wrong whenever they ran the
 * command from a subdirectory. `--database` still wins when given, because reading a ledger
 * copied from somewhere else is a real thing to want.
 */
function databasePath(argv: readonly string[]): string {
  const index = argv.indexOf("--database");
  const explicit = index === -1 ? undefined : argv[index + 1];
  if (explicit !== undefined) return explicit;

  const worktreeRoot = findWorktreeRoot(process.cwd());
  if (worktreeRoot === null) {
    throw new ReadServiceError(
      "usage",
      "not inside a git repository, so there is no ledger to default to; pass --database <path>",
    );
  }
  return ledgerPathFor(worktreeRoot);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let daemon: PatchMeshDaemon | null = null;
  try {
    // `init` and `help` run before there is anything to read, so neither may be gated behind
    // an event store that init itself is the reason the user does not have yet.
    if (needsNoStore(argv)) {
      const result = await runCli(argv, { services: unavailableServices() });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      return result.exitCode;
    }
    const ledgerPath = databasePath(argv);
    // Freshened here as well as inside `runCli`, because "there is no ledger" is decided before
    // `runCli` is ever called, and on a fresh install that verdict is wrong: the recorder
    // creates the ledger on its first *drain*, so a repository whose hooks have been running
    // all session has a journal full of calls and no database yet. Without this, the first
    // report a new user runs says nothing has been recorded while the evidence sits next to it
    // -- which is the exact confusion `renderNoLedger` was written to clear up.
    //
    // The second freshen inside `runCli` then costs one `existsSync`, because this one drained.
    if (REPORT_ONLY.has(argv[0] ?? "")) {
      const worktreeRoot = findWorktreeRoot(process.cwd());
      if (worktreeRoot !== null && ownsLedger(worktreeRoot, ledgerPath)) {
        await freshenLedger({ worktreeRoot, ledgerPath, observeEffects: true });
      }
    }
    if (!existsSync(ledgerPath) && REPORT_ONLY.has(argv[0] ?? "")) {
      process.stdout.write(renderNoLedger(ledgerPath, argv.includes("--json")));
      return 0;
    }
    // Hand the resolved path back to the parser rather than only to the daemon. `overlaps`
    // reads `parsed.databasePath` on its own, so defaulting in one place and not the other
    // would leave it opening the empty string while every other command worked.
    const resolvedArgv = argv.includes("--database") ? argv : [...argv, "--database", ledgerPath];
    daemon = createDaemon({ databasePath: ledgerPath });
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    const result = await runCli(resolvedArgv, {
      services: daemon.services,
      feedbackWriter: daemon,
      deliveryWriter: daemon,
      pruner: daemon,
      signal: controller.signal,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.hold !== undefined) await result.hold;
    process.removeListener("SIGINT", onInterrupt);
    return result.exitCode;
  } catch (error) {
    const result = error instanceof ReadServiceError
      ? { exitCode: exitCode(error), message: `${error.message}\n` }
      : { exitCode: 4, message: "PatchMesh command failed\n" };
    process.stderr.write(result.message);
    return result.exitCode;
  } finally {
    daemon?.close();
  }
}

/**
 * Was this module run as the program, rather than imported by a test?
 *
 * Compared against the *resolved* path of `argv[1]`, not its literal value. A global install
 * puts a symlink on `PATH` -- `npm link` always, and a package manager's global store often --
 * so `argv[1]` is the link while `import.meta.url` is what it points at. Comparing the two
 * strings made every symlinked install exit 0 with no output at all: the CLI loaded, decided
 * it was a library, and returned.
 */
function runAsProgram(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // `argv[1]` did not resolve to a file on disk, so this is not that file.
    return false;
  }
}

if (runAsProgram()) {
  const code = await main();
  process.exitCode = code;
}
