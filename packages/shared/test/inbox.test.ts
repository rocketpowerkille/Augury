import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodePost,
  encodePost,
  FEEDS,
  postFromShare,
  shareFromPost,
  splitSeed,
  type RoundOpen,
} from "../src/index.ts";

const h32 = (b: string) => `0x${b.repeat(32)}` as const;

const open: RoundOpen = {
  kind: "open",
  feedId: FEEDS["fBTC/USD"],
  round: 12345678901234567890n,
  dealer: 1,
  closeHeight: 100n,
  mlkemPublicKey: "0xabcd",
  x25519PublicKey: "0x0102",
  commitments: [h32("01"), h32("02"), h32("03")],
};

describe("inbox posts", () => {
  it("round-trip a round open, keeping large integers exact", () => {
    assert.deepEqual(decodePost(encodePost(open)), open);
  });

  it("round-trip a sealed report", () => {
    const post = { kind: "report", feedId: FEEDS["QOR/USD"], round: 3n, envelope: "0xdeadbeef" } as const;
    assert.deepEqual(decodePost(encodePost(post)), post);
  });

  it("round-trip a share", () => {
    const { shares } = splitSeed(new Uint8Array(32).fill(7), 3n);
    const post = postFromShare(FEEDS["QOR/USD"], 3n, shares[2]);
    const decoded = decodePost(encodePost(post));
    assert.deepEqual(decoded, post);
    assert.ok(decoded && decoded.kind === "share");
    assert.deepEqual(shareFromPost(decoded), shares[2]);
  });

  it("ignore anything that is not a valid Augury post", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    assert.equal(decodePost(new Uint8Array([0xff, 0xfe])), undefined);
    assert.equal(decodePost(enc({ kind: "open" })), undefined); // no version
    assert.equal(decodePost(enc({ v: "augury/0", kind: "report" })), undefined);
    assert.equal(decodePost(enc({ v: "augury/1", kind: "nope" })), undefined);
    assert.equal(decodePost(enc({ v: "augury/1", kind: "report", feedId: "0x01", round: "1", envelope: "0x" })), undefined);
    assert.equal(decodePost(enc({ v: "augury/1", kind: "report", feedId: h32("00"), round: -1, envelope: "0x" })), undefined);
    assert.equal(decodePost(enc({ ...open, v: "augury/1", round: "1", closeHeight: "1", dealer: 3 })), undefined);
  });
});
