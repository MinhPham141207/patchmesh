import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkGraphProjector, projectWorkGraph, SqliteEventStore } from "@patchmesh/storage";
import { buildGoldenEvents, duplicateVariant, outOfOrderVariant, } from "./fixtures.js";
import { appendEvents, assertNoPhase2Output, replaySnapshot, stableDigest, withTemporaryDatabase, } from "./test-support.js";
test("golden observation-only cross-worktree stream projects graph state without findings", async () => {
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            const events = buildGoldenEvents();
            appendEvents(store, events);
            const snapshot = replaySnapshot(store);
            assert.equal(snapshot.sourceSequenceGaps.length, 0);
            assert.ok(snapshot.graphSnapshot.nodes.some((node) => node.kind === "agent"));
            assert.ok(snapshot.graphSnapshot.nodes.some((node) => node.kind === "task"));
            assert.ok(snapshot.graphSnapshot.nodes.some((node) => node.kind === "resource"));
            assert.ok(snapshot.graphSnapshot.edges.some((edge) => edge.kind === "reads"));
            assert.ok(snapshot.graphSnapshot.edges.some((edge) => edge.kind === "changes"));
            assert.ok(snapshot.graphSnapshot.nodes.some((node) => node.kind === "resource" && node.resource.locator === "src/contracts.ts#calculateTotal"));
            assertNoPhase2Output(store.read());
        }
        finally {
            store.close();
        }
    });
});
test("canonical, duplicate, and valid out-of-order streams converge", async () => {
    const events = buildGoldenEvents();
    const snapshots = [];
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            appendEvents(store, events);
            snapshots.push(replaySnapshot(store).graphSnapshotDigest);
        }
        finally {
            store.close();
        }
    });
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            for (const [index, event] of duplicateVariant(events).entries()) {
                const result = store.append(event);
                assert.equal(result.status, index % 2 === 0 ? "inserted" : "duplicate");
            }
            snapshots.push(replaySnapshot(store).graphSnapshotDigest);
        }
        finally {
            store.close();
        }
    });
    await withTemporaryDatabase(async (databasePath) => {
        const store = SqliteEventStore.open(databasePath);
        try {
            appendEvents(store, outOfOrderVariant(events));
            snapshots.push(replaySnapshot(store).graphSnapshotDigest);
        }
        finally {
            store.close();
        }
    });
    assert.deepEqual(new Set(snapshots).size, 1);
});
test("incremental and clean graph projection snapshots are byte-equivalent", () => {
    const events = buildGoldenEvents();
    const projector = new WorkGraphProjector();
    for (const event of events)
        projector.process(event);
    assert.equal(stableDigest(projector.snapshot()), stableDigest(projectWorkGraph(events).snapshot));
});
//# sourceMappingURL=golden.test.js.map