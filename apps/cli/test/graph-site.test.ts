import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventId, ProtocolEvent } from "patchmesh-protocol";
import type { ReadServices } from "patchmesh-query";
import type { WorkGraphSnapshot } from "patchmesh-storage";
import { buildGraphSiteModel, parentAgentId } from "../src/graph-model.js";
import { startGraphServer } from "../src/graph-server.js";
import { runCli } from "../src/main.js";

/**
 * A ledger in which two agents changed one file and a shell command changed another without
 * saying who ran it - the two shapes the text rendering could not distinguish and the page
 * exists to make visible.
 */
function fixture(): { readonly services: ReadServices; readonly snapshot: WorkGraphSnapshot } {
  const version = (value: string) => ({
    resourceId: "res_auth",
    domain: { repositoryId: "repo_1", workspaceId: "ws_1", worktreeId: "wt_1" },
    kind: "content_hash",
    value,
    evidenceEventIds: [],
  });
  const snapshot = {
    nodes: [
      { kind: "agent", nodeId: "agent:agent_alpha", agentId: "agent_alpha", evidenceEventIds: [] },
      { kind: "agent", nodeId: "agent:agent_alpha.sub.zz", agentId: "agent_alpha.sub.zz", evidenceEventIds: [] },
      { kind: "task", nodeId: "task:task_1", taskId: "task_1", evidenceEventIds: [], completionEventIds: [], workProductIds: [] },
      { kind: "task", nodeId: "task:task_2", taskId: "task_2", evidenceEventIds: [], completionEventIds: [], workProductIds: [] },
      {
        kind: "resource",
        nodeId: "resource:res_auth",
        resource: { resourceId: "res_auth", repositoryId: "repo_1", kind: "file", locator: "src/auth.ts" },
        evidenceEventIds: [],
      },
      {
        kind: "resource",
        nodeId: "resource:res_lock",
        resource: { resourceId: "res_lock", repositoryId: "repo_1", kind: "file", locator: "pnpm-lock.yaml" },
        evidenceEventIds: [],
      },
      { kind: "version", nodeId: "version:v1", version: version("1111111111"), evidenceEventIds: [] },
      { kind: "version", nodeId: "version:v2", version: version("2222222222"), evidenceEventIds: [] },
    ],
    edges: [
      {
        edgeId: "e0", kind: "performs", fromNodeId: "agent:agent_alpha", toNodeId: "task:task_1",
        evidenceEventIds: ["evt_0"], attribution: { agentId: "agent_alpha", taskId: "task_1" },
      },
      {
        edgeId: "e1", kind: "changes", fromNodeId: "task:task_1", toNodeId: "resource:res_auth",
        evidenceEventIds: ["evt_1"], attribution: { agentId: "agent_alpha", taskId: "task_1" },
        changeKind: "modified", beforeVersionId: null, afterVersionId: "version:v1",
      },
      {
        edgeId: "e2", kind: "changes", fromNodeId: "task:task_2", toNodeId: "resource:res_auth",
        evidenceEventIds: ["evt_2"], attribution: { agentId: "agent_alpha.sub.zz", taskId: "task_2" },
        changeKind: "modified", beforeVersionId: "version:v1", afterVersionId: "version:v2",
      },
      {
        edgeId: "e3", kind: "changes", fromNodeId: null, toNodeId: "resource:res_lock",
        evidenceEventIds: ["evt_3"], attribution: { agentId: null, taskId: null },
        changeKind: "created", afterVersionId: "version:v2",
      },
    ],
    coverage: [],
  } as unknown as WorkGraphSnapshot;

  const events = ["evt_1", "evt_2", "evt_3"].map((eventId, index) => ({
    eventId: eventId as EventId,
    timestamp: `2026-08-2${index + 1}T10:00:00.000Z`,
  })) as unknown as readonly ProtocolEvent[];

  const services = {
    getGraph: () => ({ snapshot, filters: {}, coverageWarnings: [{ kind: "opaque", scope: "evt_3", reason: "not enumerable", evidenceEventIds: [] }] }),
    listEvents: () => ({ events, nextCursor: null, hasMore: false }),
  } as unknown as ReadServices;

  return { services, snapshot };
}

test("the model collapses versions into the history of the file they belong to", () => {
  const model = buildGraphSiteModel(fixture().services, {}, "/repo/.patchmesh/ledger.db");

  // Two thirds of the projection's nodes are versions; a content hash is not a thing to
  // navigate to, it is a thing to read once a file has been picked.
  assert.equal(model.files.length, 2);
  const auth = model.files.find((file) => file.path === "src/auth.ts")!;
  assert.equal(auth.changes.length, 2);
  assert.deepEqual(auth.changes.map((change) => change.after), ["1111111111", "2222222222"]);
  assert.equal(auth.changes[0]?.before, null);
  assert.equal(auth.changes[1]?.before, "1111111111");
  // Ordered oldest first, so the panel can read it as a history.
  assert.ok((auth.changes[0]?.at ?? "") < (auth.changes[1]?.at ?? ""));
});

test("the model names the files more than one agent changed", () => {
  const model = buildGraphSiteModel(fixture().services, {}, "/ledger");

  assert.equal(model.counts.contested, 1);
  const auth = model.files.find((file) => file.path === "src/auth.ts")!;
  assert.deepEqual(auth.changedBy, ["agent_alpha", "agent_alpha.sub.zz"]);
  const lock = model.files.find((file) => file.path === "pnpm-lock.yaml")!;
  assert.deepEqual(lock.changedBy, []);
});

test("a change nobody claims is counted rather than dropped", () => {
  // A shell command that writes a file leaves a change with null attribution. Counting it
  // keeps the totals honest: the page shows a row for it instead of drawing a map whose
  // lines add up to less than the change count above them.
  const model = buildGraphSiteModel(fixture().services, {}, "/ledger");

  assert.equal(model.counts.unattributedChanges, 1);
  assert.equal(model.counts.changes, 3);
});

test("a subagent is attached to the agent whose id its prefix truncates", () => {
  const model = buildGraphSiteModel(fixture().services, {}, "/ledger");

  const sub = model.agents.find((agent) => agent.id === "agent_alpha.sub.zz")!;
  assert.equal(sub.parentId, "agent_alpha");
  assert.equal(model.agents.find((agent) => agent.id === "agent_alpha")!.parentId, null);
  assert.equal(parentAgentId("agent_alpha.sub.zz", ["agent_alpha"]), "agent_alpha");
  assert.equal(parentAgentId("agent_alpha.sub.zz", ["agent_beta"]), null);
});

test("coverage gaps are grouped instead of listed one per event", () => {
  const model = buildGraphSiteModel(fixture().services, {}, "/ledger");

  assert.deepEqual(model.gaps, [{ kind: "opaque", reason: "not enumerable", count: 1 }]);
});

test("the server answers with the page and with a model rebuilt per request", async () => {
  let reads = 0;
  const { services } = fixture();
  const counting = { ...services, getGraph: (filters?: unknown) => { reads += 1; return services.getGraph(filters as never); } } as ReadServices;
  const server = await startGraphServer({ services: counting, filters: {}, ledger: "/ledger", open: false });
  try {
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /PatchMesh work graph/);
    // Self-contained: a local page that reaches out to a CDN is a page that breaks offline.
    assert.equal(/<script src=|<link[^>]+href="http/.test(html), false);

    const first = await fetch(`${server.url}/graph.json`);
    assert.equal(first.status, 200);
    const model = await first.json() as { counts: { files: number } };
    assert.equal(model.counts.files, 2);

    await fetch(`${server.url}/graph.json`);
    // Rebuilt rather than captured at launch, so a reload after an agent session is current.
    assert.equal(reads, 2);

    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
  } finally {
    server.close();
  }
  await server.closed;
});

test("the server binds loopback only, because a ledger names a private repository's files", async () => {
  const server = await startGraphServer({ services: fixture().services, filters: {}, ledger: "/ledger", open: false });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    server.close();
  }
  await server.closed;
});

test("graph serves by default and holds until the server stops", async () => {
  const { services } = fixture();
  let started: { close: () => void } | null = null;
  const result = await runCli(["graph"], {
    services,
    worktreeRoot: "/repo",
    serveGraph: async (options) => {
      assert.equal(options.open, true);
      const server = await startGraphServer({ ...options, open: false });
      started = server;
      return server;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Work graph at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stdout, /Ctrl\+C/);
  assert.notEqual(result.hold, undefined);

  started!.close();
  await result.hold;
});

test("--no-open serves without reaching for a browser, and --port picks the binding", async () => {
  const { services } = fixture();
  let seen: { port?: number; open?: boolean } | null = null;
  const result = await runCli(["graph", "--no-open", "--port", "0"], {
    services,
    worktreeRoot: "/repo",
    serveGraph: async (options) => {
      seen = { ...(options.port === undefined ? {} : { port: options.port }), open: options.open };
      const server = await startGraphServer({ ...options, open: false });
      server.close();
      return server;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, { port: 0, open: false });
  await result.hold;
});

test("--json still prints the projection, so a pipe is unaffected by the page", async () => {
  const result = await runCli(["graph", "--json"], { services: fixture().services, worktreeRoot: "/repo" });

  assert.equal(result.exitCode, 0);
  assert.equal(result.hold, undefined);
  assert.equal(JSON.parse(result.stdout).snapshot.nodes.length, 8);
});

test("serving options are rejected on commands that cannot serve", async () => {
  const result = await runCli(["status", "--port", "8080"], { services: fixture().services, worktreeRoot: "/repo" });

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unsupported option: --port/);
});

test("the binary runs when PATH reaches it through a symlink", async (t) => {
  // A global install puts a link on PATH -- `npm link` always, a package manager's global
  // store often. Comparing `import.meta.url` to the literal `argv[1]` made the CLI decide it
  // was a library and exit 0 printing nothing, which reads exactly like a broken build.
  const { execFileSync, } = await import("node:child_process");
  const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");

  const entry = resolve(import.meta.dirname, "../dist/main.js");
  const root = mkdtempSync(join(tmpdir(), "patchmesh-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, "main.js");
  try {
    symlinkSync(entry, link, "file");
  } catch {
    return; // No permission to create symlinks on this host; the direct path is covered below.
  }

  const viaLink = execFileSync(process.execPath, [link, "help"], { encoding: "utf8" });
  const direct = execFileSync(process.execPath, [entry, "help"], { encoding: "utf8" });

  assert.match(viaLink, /Usage: patchmesh/);
  assert.equal(viaLink, direct);
});
