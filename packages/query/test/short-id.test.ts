import assert from "node:assert/strict";
import { test } from "node:test";
import { shortIds } from "../src/index.js";

const A = "agent_3ed6292e-24ff-47e6-8c30-59719e4ba803";
const B = "agent_2478f630-4707-4f79-a9b9-448c934ddadb";

test("an id is shortened to the part that distinguishes it", () => {
  const table = shortIds([A, B, "task_ebc84efd-2815-430c-847d-49706c38b800"]);
  assert.equal(table.get(A), "agent_3ed6292e");
  assert.equal(table.get(B), "agent_2478f630");
  assert.equal(table.get("task_ebc84efd-2815-430c-847d-49706c38b800"), "task_ebc84efd");
});

test("the subagent marker survives shortening, because it is what says the work was delegated", () => {
  // `patchmesh agents` groups a family by this marker. Truncating through it would render a
  // subagent as what looks like an unrelated agent.
  const sub = "agent_7a1033a6.sub.a1b2c3d4e5f6a7b8c9d0";
  const table = shortIds([sub]);
  assert.equal(table.get(sub), "agent_7a1033a6.sub.a1b2c3d4");
});

test("two ids that would collide keep their full length, together", () => {
  // Distinctness is the whole job: two workers rendered identically is worse than a long id.
  const first = "agent_aaaaaaaa-1111-1111-1111-111111111111";
  const second = "agent_aaaaaaaa-2222-2222-2222-222222222222";
  const table = shortIds([first, second]);
  assert.notEqual(table.get(first), table.get(second));

  // And the answer stays internally consistent: mixed lengths in one answer read as mixed
  // kinds of thing, so a collision lengthens everything rather than just the pair.
  const withThird = shortIds([first, second, B]);
  const lengths = new Set([...withThird.values()].map((id) => id.length));
  assert.equal(lengths.size, 1, "one answer renders ids at one length");
});

test("an id with no prefix separator is returned unchanged", () => {
  assert.equal(shortIds(["unstructured"]).get("unstructured"), "unstructured");
});
