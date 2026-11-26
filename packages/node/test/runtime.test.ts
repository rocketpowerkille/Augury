import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FailureCounter, forEachSafely } from "../src/runtime.ts";

describe("forEachSafely", () => {
  /** Regression: one delivery that would not open aborted every later release in the tick. */
  it("keeps going after an item fails, and reports the failure", async () => {
    const done: number[] = [];
    const failed: number[] = [];
    await forEachSafely(
      [1, 2, 3],
      async (n) => {
        if (n === 1) throw new Error("bad delivery");
        done.push(n);
      },
      (n) => failed.push(n),
    );
    assert.deepEqual(done, [2, 3]);
    assert.deepEqual(failed, [1]);
  });
});

describe("FailureCounter", () => {
  it("gives up on a key after the limit, per key", () => {
    const f = new FailureCounter(2);
    assert.equal(f.fail("a"), false);
    assert.equal(f.exhausted("a"), false);
    assert.equal(f.fail("a"), true);
    assert.equal(f.exhausted("a"), true);
    assert.equal(f.exhausted("b"), false);
  });
});
