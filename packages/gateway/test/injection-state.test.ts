import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimInjection, digestOf, injectionStatePathFor, REPEAT_SUPPRESSION_MS } from "../src/injection-state.js";

function statePath(): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "patchmesh-injection-"));
  return { root, path: join(root, ".patchmesh", "session-start.json") };
}

const CONTEXT = "## PatchMesh - what previous sessions did here\n\nsome recap";

test("the first injection into a session is always claimed", () => {
  const { root, path } = statePath();
  try {
    assert.equal(claimInjection(path, "session-1", CONTEXT), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same context seconds later is suppressed", () => {
  const { root, path } = statePath();
  try {
    const at = new Date("2026-08-24T10:00:00.000Z");
    assert.equal(claimInjection(path, "session-1", CONTEXT, at), true);
    // The observed failure: 45 of 81 gaps between hook fires were under a minute, and the
    // shortest was 0.46 seconds. Those repeats are noise, and each one used to be counted as
    // an answer PatchMesh had returned.
    const halfASecondLater = new Date(at.getTime() + 460);
    assert.equal(claimInjection(path, "session-1", CONTEXT, halfASecondLater), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same context long afterwards is injected again", () => {
  const { root, path } = statePath();
  try {
    const at = new Date("2026-08-24T10:00:00.000Z");
    assert.equal(claimInjection(path, "session-1", CONTEXT, at), true);
    // A compact or a resume an hour later is exactly when an agent has lost its context and
    // most needs it back. Suppressing on digest alone would withhold it precisely then.
    const later = new Date(at.getTime() + REPEAT_SUPPRESSION_MS + 1);
    assert.equal(claimInjection(path, "session-1", CONTEXT, later), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("different context in the same session is never suppressed", () => {
  const { root, path } = statePath();
  try {
    const at = new Date("2026-08-24T10:00:00.000Z");
    assert.equal(claimInjection(path, "session-1", CONTEXT, at), true);
    const moved = new Date(at.getTime() + 1_000);
    assert.equal(claimInjection(path, "session-1", `${CONTEXT}\nand another task`, moved), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two sessions do not suppress each other", () => {
  const { root, path } = statePath();
  try {
    const at = new Date("2026-08-24T10:00:00.000Z");
    assert.equal(claimInjection(path, "session-1", CONTEXT, at), true);
    // Identical bytes, different session: the second session has never seen them.
    assert.equal(claimInjection(path, "session-2", CONTEXT, new Date(at.getTime() + 100)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host that declares no session always gets its context", () => {
  const { root, path } = statePath();
  try {
    assert.equal(claimInjection(path, null, CONTEXT), true);
    assert.equal(claimInjection(path, null, CONTEXT), true);
    assert.equal(claimInjection(path, "", CONTEXT), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable or foreign state file costs a duplicate, never an injection", () => {
  const { root, path } = statePath();
  try {
    claimInjection(path, "session-1", CONTEXT);
    writeFileSync(path, "{ this is not json", "utf8");
    // Failing open is the only safe direction: a duplicate costs context, a suppressed first
    // injection costs the entire point of the hook.
    assert.equal(claimInjection(path, "session-1", CONTEXT), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the state file is bounded and records the digest it suppressed on", () => {
  const { root, path } = statePath();
  try {
    for (let index = 0; index < 40; index += 1) {
      claimInjection(path, `session-${index}`, `${CONTEXT} ${index}`, new Date(1_000_000 + index * 1_000));
    }
    const state = JSON.parse(readFileSync(path, "utf8")) as { sessions: Record<string, { digest: string }> };
    const sessions = Object.keys(state.sessions);
    // A host that opens many sessions must not grow this file forever.
    assert.equal(sessions.length, 32);
    // The most recent survive; the oldest are the ones worth forgetting.
    assert.ok(sessions.includes("session-39"));
    assert.ok(!sessions.includes("session-0"));
    assert.equal(state.sessions["session-39"]?.digest, digestOf(`${CONTEXT} 39`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the state file sits beside the ledger", () => {
  assert.equal(
    injectionStatePathFor("/repo", ".patchmesh"),
    join("/repo", ".patchmesh", "session-start.json"),
  );
});
