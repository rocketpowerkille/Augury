import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedId, FEEDS, median, parsePrice } from "../src/index.ts";

describe("median", () => {
  it("takes the middle of an odd count", () => {
    assert.equal(median([5n, 1n, 3n]), 3n);
  });

  it("averages the two middle values of an even count", () => {
    assert.equal(median([1n, 2n, 3n, 4n]), 2n); // (2 + 3) / 2 truncated
    assert.equal(median([10n, 20n]), 15n);
  });

  it("truncates toward zero like Solidity", () => {
    assert.equal(median([-3n, 0n]), -1n); // -1.5 -> -1
  });

  it("does not modify its input", () => {
    const values = [3n, 1n, 2n];
    median(values);
    assert.deepEqual(values, [3n, 1n, 2n]);
  });

  it("rejects an empty list", () => {
    assert.throws(() => median([]));
  });
});

describe("feeds and prices", () => {
  it("derives stable feed ids", () => {
    assert.equal(FEEDS["fBTC/USD"], "0x4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad");
    assert.notEqual(feedId("fBTC/USD"), feedId("fETH/USD"));
  });

  it("parses decimal prices to 8 decimals", () => {
    assert.equal(parsePrice("97123.45"), 9712345000000n);
    assert.equal(parsePrice("1"), 100000000n);
    assert.equal(parsePrice("0.00000001"), 1n);
    assert.throws(() => parsePrice("1.123456789"));
    assert.throws(() => parsePrice("abc"));
  });
});
