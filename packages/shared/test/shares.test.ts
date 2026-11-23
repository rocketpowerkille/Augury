import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { combineShares, splitSeed, verifyShare, type MemberShare } from "../src/shares.ts";

const round = 7n;

function freshSeed(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

describe("2-of-3 round seed sharing", () => {
  it("any two members rebuild the seed", () => {
    const seed = freshSeed();
    const { shares, commitments } = splitSeed(seed, round);
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      assert.deepEqual(combineShares([shares[a], shares[b]], round, commitments), seed);
    }
  });

  it("all three members also rebuild the seed", () => {
    const seed = freshSeed();
    const { shares, commitments } = splitSeed(seed, round);
    assert.deepEqual(combineShares(shares, round, commitments), seed);
  });

  it("one member alone cannot rebuild the seed", () => {
    const { shares, commitments } = splitSeed(freshSeed(), round);
    for (const share of shares) {
      assert.throws(() => combineShares([share], round, commitments), /two different/);
    }
  });

  it("each member is missing exactly its own part", () => {
    const { shares } = splitSeed(freshSeed(), round);
    for (const share of shares) {
      const held = share.parts.map((p) => p.index).sort();
      assert.deepEqual(held, [0, 1, 2].filter((i) => i !== share.member));
    }
  });

  it("every share verifies against its commitments", () => {
    const { shares, commitments } = splitSeed(freshSeed(), round);
    for (const share of shares) assert.equal(verifyShare(share, round, commitments), true);
  });

  it("rejects a tampered part", () => {
    const { shares, commitments } = splitSeed(freshSeed(), round);
    const bad: MemberShare = structuredClone(shares[0]);
    bad.parts[0].value[0] = bad.parts[0].value[0]! ^ 1;
    assert.equal(verifyShare(bad, round, commitments), false);
    assert.throws(() => combineShares([bad, shares[1]], round, commitments), /does not match/);
  });

  it("rejects a share replayed into another round", () => {
    const { shares, commitments } = splitSeed(freshSeed(), round);
    assert.equal(verifyShare(shares[0], round + 1n, commitments), false);
  });

  it("is deterministic with injected randomness", () => {
    const seed = new Uint8Array(32).fill(9);
    let counter = 0;
    const random = (n: number) => new Uint8Array(n).fill(++counter);
    const a = splitSeed(seed, round, random);
    counter = 0;
    const b = splitSeed(seed, round, random);
    assert.deepEqual(a.commitments, b.commitments);
  });

  it("rejects a seed of the wrong length", () => {
    assert.throws(() => splitSeed(new Uint8Array(31), round));
  });
});
