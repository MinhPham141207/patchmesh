import type { ProtocolEvent } from "@patchmesh/protocol";
import { SqliteEventStore, type SourceSequenceGap, type WorkGraphSnapshot } from "@patchmesh/storage";
export declare function withTemporaryDirectory<T>(prefix: string, run: (directory: string) => Promise<T> | T): Promise<T>;
export declare function withTemporaryDatabase<T>(run: (databasePath: string) => Promise<T> | T): Promise<T>;
export declare function stableDigest(value: unknown): string;
export declare function appendEvents(store: SqliteEventStore, events: readonly ProtocolEvent[]): void;
export declare function replaySnapshot(store: SqliteEventStore): {
    readonly orderedEvents: readonly ProtocolEvent[];
    readonly orderedEventDigest: string;
    readonly graphSnapshot: WorkGraphSnapshot;
    readonly graphSnapshotDigest: string;
    readonly sourceSequenceGaps: readonly SourceSequenceGap[];
};
export declare function assertNoPhase2Output(events: readonly ProtocolEvent[]): void;
//# sourceMappingURL=test-support.d.ts.map