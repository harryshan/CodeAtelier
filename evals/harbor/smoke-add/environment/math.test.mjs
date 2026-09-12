import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./math.mjs";

test("adds positive numbers", () => {
  assert.equal(add(2, 3), 5);
});
