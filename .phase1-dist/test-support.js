import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectWorkGraph, } from "@patchmesh/storage";
export async function withTemporaryDirectory(prefix, run) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    try {
        return await run(directory);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
export async function withTemporaryDatabase(run) {
    return withTemporaryDirectory("patchmesh-m7-db-", (directory) => run(join(directory, "events.sqlite")));
}
export function stableDigest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function appendEvents(store, events) {
    for (const event of events)
        store.append(event);
}
export function replaySnapshot(store) {
    const replay = store.replay();
    const graph = projectWorkGraph(store.read());
    return {
        orderedEvents: replay.orderedEvents,
        orderedEventDigest: stableDigest(replay.orderedEvents),
        graphSnapshot: graph.snapshot,
        graphSnapshotDigest: stableDigest(graph.snapshot),
        sourceSequenceGaps: replay.sourceSequenceGaps,
    };
}
export function assertNoPhase2Output(events) {
    const forbidden = new Set([
        "finding.created",
        "decision.created",
        "validity.changed",
        "decision.delivery.changed",
    ]);
    for (const event of events) {
        if (forbidden.has(event.eventType)) {
            throw new Error(`Phase 2 event was emitted: ${event.eventType}`);
        }
    }
}
//# sourceMappingURL=test-support.js.map