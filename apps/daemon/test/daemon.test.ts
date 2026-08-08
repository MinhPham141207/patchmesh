import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import type { EventReader } from "@patchmesh/query";
import { ReadServiceError } from "@patchmesh/query";
import { createDaemon } from "../src/index.js";

const fixtureReader: EventReader = {
  read: () => [],
  replay: <State>(_reducer: { initialState(): State; apply(state: State, event: never): State }) => {
    throw new Error("fixture replay is not needed for composition");
  },
};

test("daemon composes public services without creating storage", () => {
  const daemon = createDaemon({ reader: fixtureReader });

  assert.equal(typeof daemon.services.getStatus, "function");
  assert.equal(daemon.health().store.state, "open");
  daemon.close();
  daemon.close();
});

test("daemon rejects a missing database without creating it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "patchmesh-m6-daemon-"));
  const databasePath = join(directory, "missing", "events.sqlite");
  try {
    assert.throws(
      () => createDaemon({ databasePath }),
      (error: unknown) => error instanceof ReadServiceError && error.code === "unavailable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
