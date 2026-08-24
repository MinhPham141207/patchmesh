import { statSync } from "node:fs";
import type { ProtocolEvent } from "patchmesh-protocol";
import { SqliteEventStore, type EventQuery, type ReadOptions } from "./event-store.js";

/**
 * A windowed read that costs nothing when the ledger has not changed.
 *
 * The MCP gateway is a long-lived process, the ledger is append-only, and every tool call was
 * opening the database, reading the whole window, and closing it again. Three tool calls in
 * one agent turn re-read the same rows three times; the `SessionStart` hook reads a recap
 * window and a contention window that overlap almost completely.
 *
 * Freshness comes from the file's size and mtime rather than from a timer. Appending to the
 * ledger changes both, so a stale entry cannot outlive the write that invalidated it, and a
 * ledger nobody has written to serves from memory forever -- which is the common case while an
 * agent is asking questions rather than working.
 *
 * This is a cache, not a store: `patchmesh-record` and `patchmesh-ingest` are separate
 * short-lived processes, so nothing here can be the reason another process sees stale data.
 * In the CLI, where each command is its own process, it simply never hits.
 */
interface CacheEntry {
  readonly key: string;
  readonly events: readonly ProtocolEvent[];
}

/**
 * Small enough that a forgotten entry costs a re-read rather than memory.
 *
 * Three read tools plus the two windows the session-start hook asks for is five; eight leaves
 * room for a path-scoped variant of each without letting one long-lived server accumulate
 * every window anybody ever asked about.
 */
const MAX_ENTRIES = 8;

const entries: CacheEntry[] = [];

/**
 * Hits and misses, so a test can assert that the cache is actually being used.
 *
 * This is not decoration. The cache was wired into all three read tools and hit exactly never,
 * because the window boundary it was keyed on changed on every call -- and nothing failed,
 * nothing warned, and the only symptom was latency that looked normal. A counter is the
 * difference between "the cache is wired" and "the cache works".
 */
const stats = { hits: 0, misses: 0 };

export function eventCacheStats(): { readonly hits: number; readonly misses: number } {
  return { ...stats };
}

/** Size and mtime together: either one changing means the window may have new rows in it. */
function ledgerFingerprint(ledgerPath: string): string {
  try {
    const stats = statSync(ledgerPath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    // No file is a fingerprint too, and a distinct one from any file that exists. The read
    // below will fail in its own way; this only has to avoid serving somebody else's rows.
    return "absent";
  }
}

function cacheKey(ledgerPath: string, query: EventQuery, options: ReadOptions): string {
  return [
    ledgerPath,
    ledgerFingerprint(ledgerPath),
    options.validate === false ? "unchecked" : "checked",
    query.eventId ?? "",
    query.eventType ?? "",
    (query.eventTypes ?? []).join("+"),
    query.correlationId ?? "",
    query.causationId === undefined ? "" : (query.causationId ?? "null"),
    query.since ?? "",
  ].join("|");
}

/**
 * Read a window, serving a previous identical read when the ledger has not moved since.
 *
 * Callers that were doing `open` / `read` / `close` around one query should call this instead;
 * it does the same three things on a miss and none of them on a hit.
 */
export function readEventsCached(
  ledgerPath: string,
  query: EventQuery = {},
  options: ReadOptions = {},
): readonly ProtocolEvent[] {
  const key = cacheKey(ledgerPath, query, options);
  const hitIndex = entries.findIndex((entry) => entry.key === key);
  if (hitIndex !== -1) {
    // Most recently used last, so eviction drops the window nobody has asked about lately.
    const [hit] = entries.splice(hitIndex, 1);
    entries.push(hit!);
    stats.hits += 1;
    return hit!.events;
  }
  stats.misses += 1;

  const store = SqliteEventStore.open(ledgerPath);
  let events: readonly ProtocolEvent[];
  try {
    events = store.read(query, options);
  } finally {
    store.close();
  }

  entries.push({ key, events });
  while (entries.length > MAX_ENTRIES) entries.shift();
  return events;
}

/** Drop everything cached. Exported for tests, which write a ledger and read it back. */
export function clearEventCache(): void {
  entries.length = 0;
  stats.hits = 0;
  stats.misses = 0;
}

/**
 * How coarse a window boundary has to be before two identical questions can share a read.
 *
 * A relative window is computed as `now - withinMinutes`, to the millisecond, so no two calls
 * ever produce the same `since` and no two calls could ever share a cache entry. The cache was
 * wired into all three read tools and hit exactly never; a five-call probe of the live server
 * measured no speedup at all, because each call was a different key.
 *
 * Rounding the *read* boundary down to the minute makes repeated questions collide, and reads
 * a superset of what was asked for rather than a subset -- so the caller can still answer for
 * the exact boundary it was given. One minute against windows of four hours and one day is
 * below the resolution of any question either window is asked.
 */
const WINDOW_BUCKET_MS = 60_000;

/** Round down, so the widened read is always a superset of the window requested. */
function bucketedSince(since: string): string {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return since;
  return new Date(Math.floor(at / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS).toISOString();
}

/**
 * A relative window, read through the cache and answered to the exact boundary asked for.
 *
 * Reads from the bucket boundary at or before `since` -- which is shared by every call in the
 * same minute -- and then trims to `since` itself in memory. The rows a caller sees are
 * exactly the rows `read({ since })` would have returned; the difference is that the tenth
 * call in a minute costs a filter instead of a query.
 */
export function readWindowCached(
  ledgerPath: string,
  query: EventQuery & { readonly since: string },
  options: ReadOptions = {},
): readonly ProtocolEvent[] {
  const widened = readEventsCached(ledgerPath, { ...query, since: bucketedSince(query.since) }, options);
  // Filtered unconditionally rather than short-circuiting on the first row's timestamp. Rows
  // come back in insertion order, and a batched drain can insert an older event after a newer
  // one, so "the first row is inside the window" does not mean the rest are.
  return widened.filter((event) => event.timestamp >= query.since);
}
