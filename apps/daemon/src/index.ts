import { existsSync } from "node:fs";
import { createReadServices, ReadServiceError, type EventReader, type ReadServices } from "@patchmesh/query";
import { SqliteEventStore } from "@patchmesh/storage";

export interface DaemonOptions {
  readonly reader?: EventReader;
  readonly databasePath?: string;
}

export interface DaemonHealth {
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly store: { readonly state: "open" | "closed"; readonly replayable: boolean };
  readonly errorCategory: string | null;
}

export interface PatchMeshDaemon {
  readonly services: ReadServices;
  readonly health: () => DaemonHealth;
  close(): void;
}

export function createDaemon(options: DaemonOptions): PatchMeshDaemon {
  if (options.reader !== undefined && options.databasePath !== undefined) {
    throw new ReadServiceError("usage", "provide a reader or database path, not both");
  }
  if (options.reader === undefined && options.databasePath === undefined) {
    throw new ReadServiceError("unavailable", "an event reader or existing database path is required");
  }
  let store: SqliteEventStore | null = null;
  const reader = options.reader ?? (() => {
    if (options.databasePath === undefined || !existsSync(options.databasePath)) {
      throw new ReadServiceError("unavailable", "database is unavailable");
    }
    store = SqliteEventStore.open(options.databasePath);
    return store;
  })();
  const services = createReadServices({ reader });
  return {
    services,
    health: () => {
      const status = services.getStatus();
      return {
        health: status.health,
        store: status.store,
        errorCategory: status.errorCategory,
      };
    },
    close: () => {
      store?.close();
      store = null;
    },
  };
}
