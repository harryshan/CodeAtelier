import assert from "node:assert/strict";
import { add } from "/app/math.mjs";

// Independent tests: the agent's edits to visible tests cannot change this verdict.
for (const [a, b, expected] of [
  [2, 3, 5],
  [-2, -3, -5],
  [0, 7, 7],
  [8, -3, 5],
  [0.25, 0.5, 0.75],
]) {
  assert.equal(add(a, b), expected);
}
