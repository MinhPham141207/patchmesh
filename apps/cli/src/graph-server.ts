import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GraphFilters, ReadServices } from "patchmesh-query";
import { buildGraphSiteModel } from "./graph-model.js";
import { GRAPH_PAGE_HTML } from "./graph-page.js";

export interface GraphServerOptions {
  readonly services: ReadServices;
  readonly filters: GraphFilters;
  readonly ledger: string;
  /** Loopback port to bind. Zero asks the OS for a free one, which is the default. */
  readonly port?: number;
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
    // The page is regenerated from the ledger on every request; a cached copy would show
    // yesterday's work after a reload, which is the one thing this view must never do.
    "cache-control": "no-store",
  });
  response.end(body);
}

/**
 * Serve the work graph as a local page.
 *
 * Bound to `127.0.0.1` rather than `0.0.0.0`: a ledger names every file an agent touched in a
 * private repository, and nothing about `patchmesh graph` implies publishing that to the
 * network the machine happens to be on.
 *
 * The model is rebuilt per request rather than captured at launch, so a browser reload after
 * an agent session shows the new work. The projection is one pass over the ledger, which is
 * around a second on a few thousand events — cheap enough to pay on a reload, and the reason
 * the page fetches it once rather than polling.
 */
export function startGraphServer(options: GraphServerOptions): Promise<GraphServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/graph.json") {
      try {
        send(response, 200, "application/json", JSON.stringify(buildGraphSiteModel(options.services, options.filters, options.ledger)));
      } catch (error) {
        send(response, 500, "application/json", JSON.stringify({ error: error instanceof Error ? error.message : "unreadable ledger" }));
      }
      return;
    }
    if (path === "/" || path === "/index.html") {
      send(response, 200, "text/html; charset=utf-8", GRAPH_PAGE_HTML);
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
 * What the terminal says while the page is being served.
 *
 * The command prints the address and stops there. It deliberately does not launch a browser:
 * a command that seizes the screen decides for the user where to look, and on Windows the
 * launched tab lands behind the terminal anyway, so the "convenience" reads as a failure.
 * The URL goes on its own line because every terminal worth using makes that clickable.
 */
export function renderGraphServerBanner(url: string, ledger: string): string {
  return [
    `Work graph at ${url}`,
    `Reading ${ledger}`,
    "",
    "Open the link above when you want it. The page re-reads the ledger on reload,",
    "so it stays current while you work. Press Ctrl+C to stop serving.",
    "",
  ].join("\n");
}
