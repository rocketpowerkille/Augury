import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bytesToHex,
  decodePost,
  encodePost,
  FEEDS,
  MAX_POST_BYTES,
  postFromShare,
  shareFromPost,
  splitSeed,
  type InboxPost,
  type RoundOpen,
} from "../src/index.ts";

const h32 = (b: string) => `0x${b.repeat(32)}` as const;
const filled = (n: number, byte: number) => bytesToHex(new Uint8Array(n).fill(byte));

const open: RoundOpen = {
  kind: "open",
  feedId: FEEDS["fBTC/USD"],
  round: 12345678901234567890n,
  dealer: 1,
  closeHeight: 100n,
  mlkemPublicKey: filled(1568, 0xab),
  x25519PublicKey: filled(32, 0x01),
  commitments: [h32("01"), h32("02"), h32("03")],
};

describe("inbox posts", () => {
  it("round-trip a round open, keeping large integers exact", () => {
    assert.deepEqual(decodePost(encodePost(open)), open);
  });

  it("round-trip a sealed report and its signature", () => {
    const report: InboxPost = { kind: "report", feedId: FEEDS["QOR/USD"], round: 3n, envelope: "0xdeadbeef" };
    const signature: InboxPost = { kind: "signature", feedId: FEEDS["QOR/USD"], round: 3n, signature: filled(4627, 0x5a) };
    assert.deepEqual(decodePost(encodePost(report)), report);
    assert.deepEqual(decodePost(encodePost(signature)), signature);
  });

  it("round-trip a sealed share delivery", () => {
    const post: InboxPost = { kind: "delivery", feedId: FEEDS["QOR/USD"], round: 3n, member: 2, envelope: "0xabcdef" };
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

  it("keep every post kind under the chain's 6,144-byte limit", () => {
    const sizes = {
      open: encodePost(open).length,
      signature: encodePost({ kind: "signature", feedId: open.feedId, round: 1n, signature: filled(4627, 1) }).length,
      // A real sealed report envelope is about 2,000 bytes.
      report: encodePost({ kind: "report", feedId: open.feedId, round: 1n, envelope: filled(2008, 1) }).length,
    };
    for (const [kind, size] of Object.entries(sizes)) assert.ok(size <= MAX_POST_BYTES, `${kind}: ${size}`);
  });

  it("refuse to encode a post over the limit", () => {
    assert.throws(
      () => encodePost({ kind: "report", feedId: open.feedId, round: 1n, envelope: filled(MAX_POST_BYTES, 1) }),
      /limit/,
    );
  });

  it("refuse fields of the wrong size", () => {
    assert.throws(() => encodePost({ ...open, mlkemPublicKey: "0xabcd" }), /mlkemPublicKey/);
    assert.throws(() => encodePost({ kind: "signature", feedId: open.feedId, round: 1n, signature: "0x01" }), /signature/);
  });

  it("ignore anything that is not a valid Augury post", () => {
    const valid = encodePost(open);
    assert.equal(decodePost(new Uint8Array([0xff, 0xfe])), undefined);
    assert.equal(decodePost(new TextEncoder().encode('{"v":"augury/1","kind":"open"}')), undefined);
    assert.equal(decodePost(Uint8Array.from([...valid.slice(0, 3), 0x01, ...valid.slice(4)])), undefined); // old version
    assert.equal(decodePost(Uint8Array.from([...valid.slice(0, 4), 9, ...valid.slice(5)])), undefined); // unknown kind
    assert.equal(decodePost(valid.slice(0, valid.length - 1)), undefined); // truncated
    const badDealer = Uint8Array.from(valid);
    badDealer[45] = 3;
    assert.equal(decodePost(badDealer), undefined);
  });
});
