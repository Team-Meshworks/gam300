import { assert, it } from "vitest";
import { MAX_SCALE, scaleBy, wheelScaleFactor } from "./scaling";

it("grows on scroll up and shrinks on scroll down", () => {
  assert.ok(wheelScaleFactor(-100, 0) > 1);
  assert.ok(wheelScaleFactor(100, 0) < 1);
  assert.ok(Math.abs(wheelScaleFactor(3, 1) - wheelScaleFactor(48, 0)) < 1e-12);
});

it("scales one axis or all three", () => {
  assert.deepEqual(scaleBy([1, 1, 1], 2, 1), [1, 2, 1]);
  assert.deepEqual(scaleBy([1, 2, 3], 2), [2, 4, 6]);
});

it("keeps proportions when uniform scaling reaches a limit", () => {
  assert.deepEqual(scaleBy([MAX_SCALE / 2, 1, 1], 4), [MAX_SCALE, 2, 2]);
});

it("never jumps a value that is already outside the limits", () => {
  assert.deepEqual(scaleBy([0.001, 1, 1], 0.5, 0), [0.001, 1, 1]);
  assert.deepEqual(scaleBy([0.001, 1, 1], 0.5), [0.001, 1, 1]);
  assert.deepEqual(scaleBy([0.001, 1, 1], 2, 0), [0.002, 1, 1]);
});
