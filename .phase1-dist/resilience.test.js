import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageError, SqliteEventStore } from "@patchmesh/storage";
import { buildGoldenEvents, buildReplayCorpus, conflictingDuplicate, missingCausalReference, } from "./fixtures.js";
import { appendEvents, replaySnapshot, stableDigest, withTemporaryDatabase, } from "./test-support.js";
test("restart preserves immutable events and replay projection digests", async () => {
    await withTemporaryDatabase(async (databasePath) => {
        const first = SqliteEventStore.open(databasePath);
        appendEvents(first, buildGoldenEvents());
        const before = replaySnapshot(first);
        const bytesBefore = stableDigest(first.read());
        first.close();
        const second = SqliteEventStore.open(databasePath);
        try {
            const after = replaySnapshot(second);
            assert.equal(stableDigest(second.read()), bytesBefore);
            assert.equal(after.orderedEventDigest, before.orderedEventDigest);
            assert.equal(after.graphSnapshotDigest, before.graphSnapshotDigest);
        }
        finally {
            second.close();
        }
    });
});
test("conflicting duplicate event IDs fail deterministically", async () => {
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            const event = buildReplayCorpus(1)[0];
            if (event === undefined)
                throw new Error("expected replay event");
            store.append(event);
            assert.throws(() => store.append(conflictingDuplicate(event)), (error) => error instanceof StorageError && error.code === "PHASE0_ID_CONFLICT");
        }
        finally {
            store.close();
        }
    });
});
test("missing causal references fail without a partial replay result", async () => {
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            const completion = buildGoldenEvents()[2];
            if (completion === undefined || completion.eventType !== "tool.completed") {
                throw new Error("expected tool completion fixture");
            }
            store.append(missingCausalReference(completion));
            assert.throws(() => store.replay(), (error) => error instanceof StorageError && error.code === "PHASE0_REFERENCE_MISSING");
        }
        finally {
            store.close();
        }
    });
});
test("source-sequence gaps remain explicit degraded coverage", async () => {
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            const events = buildReplayCorpus(3);
            appendEvents(store, [events[0], events[2]]);
            const snapshot = replaySnapshot(store);
            assert.deepEqual(snapshot.sourceSequenceGaps[0]?.missingRanges, [{ from: 1, to: 1 }]);
            assert.ok(snapshot.graphSnapshot.coverage.some((entry) => entry.presentation === "degraded"));
        }
        finally {
            store.close();
        }
    });
});
//# sourceMappingURL=resilience.test.js.map