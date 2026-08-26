import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";

test("--verify parses for status only", () => {
  assert.equal(parseArgs(["status", "--verify"]).verify, true);
  assert.equal(parseArgs(["status"]).verify, undefined);
  assert.throws(() => parseArgs(["agents", "--verify"]), /unsupported option/u);
});

test("status --verify takes no value and composes with other flags", () => {
  const parsed = parseArgs(["status", "--verify", "--json"]);
  assert.equal(parsed.verify, true);
  assert.equal(parsed.json, true);
});
