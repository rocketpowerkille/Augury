import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportPosts } from "@augury/reporter";
import {
  bytesToHex,
  FEEDS,
  generateSigningKey,
  openReport,
  roundKeys,
  type Hex,
  type RoundOpen,
} from "@augury/shared";
import { ReportBook } from "../src/reportbook.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const domain = { chainId: 9800n, hub: addr(0x4b) };
const sealChainId = "qorechain-diana";
const BTC = FEEDS["fBTC/USD"];
const ETH = FEEDS["fETH/USD"];
const z32 = `0x${"00".repeat(32)}` as const;
const keys = roundKeys(new Uint8Array(32).fill(7));
const reporter = addr(0x100);
const signer = generateSigningKey(new Uint8Array(32).fill(1));

function open(feedId: Hex, round: bigint): RoundOpen {
  return {
    kind: "open",
    feedId,
    round,
    dealer: 0,
    closeHeight: 100n,
    mlkemPublicKey: bytesToHex(keys.mlkemPublicKey),
    x25519PublicKey: bytesToHex(keys.x25519PublicKey),
    commitments: [z32, z32, z32],
  };
}

const build = (o: RoundOpen) => () =>
  buildReportPosts({ domain, sealChainId, reporter, secretKey: signer.secretKey, open: o, price: 6_000_000_000_000n, observedAt: 1n });

const signedMessage = (o: RoundOpen, envelope: Hex) =>
  openReport({ sealChainId, domain, keys, envelope: Uint8Array.from(Buffer.from(envelope.slice(2), "hex")), feedId: o.feedId, round: o.round });

describe("ReportBook", () => {
  it("shows why retries must not sign again: two builds of one round are two different signed reports", () => {
    const o = open(BTC, 5n);
    const [first] = build(o)();
    const [second] = build(o)();
    // Same price and time, but a fresh salt: AuguryHub treats this pair as equivocation.
    assert.notEqual(signedMessage(o, first.envelope).salt, signedMessage(o, second.envelope).salt);
  });

  it("signs once per feed and round and resends the same posts on retry", () => {
    const book = new ReportBook();
    const o = open(BTC, 5n);
    let builds = 0;
    const counted = () => {
      builds++;
      return build(o)();
    };
    const first = book.postsFor(BTC, 5n, counted);
    assert.equal(book.has(BTC, 5n), true);
    const retry = book.postsFor(BTC, 5n, counted);
    assert.equal(builds, 1);
    assert.deepEqual(retry, first);
    assert.equal(signedMessage(o, retry[0].envelope).salt, signedMessage(o, first[0].envelope).salt);
  });

  it("keeps feeds and rounds apart", () => {
    const book = new ReportBook();
    const a = book.postsFor(BTC, 5n, build(open(BTC, 5n)));
    const b = book.postsFor(ETH, 5n, build(open(ETH, 5n)));
    const c = book.postsFor(BTC, 6n, build(open(BTC, 6n)));
    assert.notDeepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.equal(book.has(BTC.toUpperCase().replace("0X", "0x") as Hex, 5n), true);
  });

  it("forgets only earlier rounds of the same feed", () => {
    const book = new ReportBook();
    book.postsFor(BTC, 5n, build(open(BTC, 5n)));
    book.postsFor(BTC, 6n, build(open(BTC, 6n)));
    book.postsFor(ETH, 5n, build(open(ETH, 5n)));
    book.forgetBefore(BTC, 6n);
    assert.equal(book.has(BTC, 5n), false);
    assert.equal(book.has(BTC, 6n), true);
    assert.equal(book.has(ETH, 5n), true);
  });
});
