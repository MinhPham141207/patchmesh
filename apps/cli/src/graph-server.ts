import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GraphFilters, ReadServices, RecapResult } from "patchmesh-query";
import { buildGraphSiteModel, type GraphSiteModel } from "./graph-model.js";
import {
  boundGraphSiteModel,
  buildAgentsLens,
  buildEventsLens,
  buildFilesLens,
  buildMapLens,
  buildNowLens,
} from "./console-model.js";
import { CONSOLE_PAGE_HTML } from "./console-page.js";
import { GRAPH_PAGE_HTML } from "./graph-page.js";

export interface GraphServerOptions {
  readonly services: ReadServices;
  readonly filters: GraphFilters;
  readonly ledger: string;
  /** Loopback port to bind. Zero asks the OS for a free one, which is the default. */
  readonly port?: number;
  /**
   * Reads the recap the Now lens leads with. Injected rather than imported because a recap
   * opens the store itself and needs the worktree root, which only the command knows. Absent,
   * the lens still answers with counts - it just cannot describe recent tasks.
   */
  readonly readRecap?: () => RecapResult;
}

export interface GraphServer {
  readonly url: string;
  /** Resolves once the server stops, so the caller can hold the process open until then. */
  readonly closed: Promise<void>;
  close(): void;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // Every page is regenerated from the ledger on request; a cached copy would show
    // yesterday's work after a reload, which is the one thing this view must never do.
    "cache-control": "no-store",
  });
  response.end(body);
}

/** The lens routes. All serve the same document; the page reads the path to pick its lens. */
const CONSOLE_ROUTES = new Set(["/", "/index.html", "/agents", "/events", "/files", "/map"]);

/**
 * Serve the PatchMesh console as a local page.
 *
 * Bound to `127.0.0.1` rather than `0.0.0.0`: a ledger names every file an agent touched in a
 * private repository, and nothing about running a report implies publishing that to the
 * network the machine happens to be on.
 *
 * Models are built per request rather than captured at launch, so a reload after an agent
 * session shows the new work. Each lens builds only what it needs - the Now lens never
 * touches the work-graph projection, so the landing page costs a windowed read rather than
 * the most expensive query in the product.
 */
export function startGraphServer(options: GraphServerOptions): Promise<GraphServer> {
  // Built at most once per request, and only by the lenses that actually need a projection.
  const graphModel = (): GraphSiteModel => buildGraphSiteModel(options.services, options.filters, options.ledger);

  const json = (response: ServerResponse, build: () => unknown): void => {
    try {
      send(response, 200, "application/json", JSON.stringify(build()));
    } catch (error) {
      send(response, 500, "application/json", JSON.stringify({
        error: error instanceof Error ? error.message : "unreadable ledger",
      }));
    }
  };

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";

    if (path === "/api/now.json") {
      json(response, () => buildNowLens(
        options.services,
        options.ledger,
        options.readRecap === undefined ? null : options.readRecap(),
      ));
      return;
    }
    if (path === "/api/agents.json") { json(response, () => buildAgentsLens(graphModel())); return; }
    if (path === "/api/files.json") { json(response, () => buildFilesLens(graphModel())); return; }
    if (path === "/api/map.json") { json(response, () => buildMapLens(graphModel())); return; }
    if (path === "/api/events.json") { json(response, () => buildEventsLens(options.services)); return; }

    // Bounded, unlike the bare `JSON.stringify` this used to be. It grew 315 KB -> 1.76 MB in
    // two days on this repository, because whole change histories were serialized for every
    // file on every request. See `boundGraphSiteModel`.
    if (path === "/graph.json") { json(response, () => boundGraphSiteModel(graphModel())); return; }

    // The node-link explorer, kept reachable at its own route. The console's Map lens is the
    // successor for the overview; this stays for the shape of a small, already-narrowed graph.
    if (path === "/graph") {
      send(response, 200, "text/html; charset=utf-8", GRAPH_PAGE_HTML);
      return;
    }
    if (CONSOLE_ROUTES.has(path)) {
      send(response, 200, "text/html; charset=utf-8", CONSOLE_PAGE_HTML);
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "not found\n");
  });

  return new Promise<GraphServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      const closed = new Promise<void>((done) => server.once("close", () => done()));
      resolve({
        url,
        closed,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/**
 * What the terminal says while the console is being served.
 *
 * The command prints the address and stops there. It deliberately does not launch a browser:
 * a command that seizes the screen decides for the user where to look, and on Windows the
 * launched tab lands behind the terminal anyway, so the "convenience" reads as a failure.
 * The URL goes on its own line because every terminal worth using makes that clickable.
 */
export function renderConsoleBanner(url: string, ledger: string, lens = ""): string {
  return [
    `PatchMesh console at ${url}${lens}`,
    `Reading ${ledger}`,
    "",
    "Lenses: /  /agents  /events  /files  /map",
    "The page re-reads the ledger on reload, so it stays current while you work.",
    "Press Ctrl+C to stop serving.",
    "",
  ].join("\n");
}

/** Kept for the `graph` command, which now lands on the Map lens rather than the node-link page. */
export function renderGraphServerBanner(url: string, ledger: string): string {
  return [
    `Work map at ${url}/map`,
    `Reading ${ledger}`,
    "",
    "The map is an agents x files matrix; the node-link explorer is at /graph.",
    "Open the link above when you want it. The page re-reads the ledger on reload,",
    "so it stays current while you work. Press Ctrl+C to stop serving.",
    "",
  ].join("\n");
}
