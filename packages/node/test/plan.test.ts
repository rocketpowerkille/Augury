import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEEDS, type Hex, type InboxEntry, type InboxPost, type RoundConfig, type RoundOpen } from "@augury/shared";
import { latestOpen, planCommittee, planReporter, planSequencer, roundKey } from "../src/plan.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const committee = [addr(0xc0), addr(0xc1), addr(0xc2)] as const;
const cfg: RoundConfig = {
  domain: { chainId: 9800n, hub: addr(0x4b) },
  sealChainId: "qorechain-diana",
  committee,
  minReports: 3,
  maxReports: 16,
};
const BTC = FEEDS["fBTC/USD"];
const ETH = FEEDS["fETH/USD"];
const z32 = `0x${"00".repeat(32)}` as const;

function open(feedId: Hex, round: bigint, closeHeight: bigint): RoundOpen {
  return {
    kind: "open",
    feedId,
    round,
    dealer: Number(round % 3n) as 0 | 1 | 2,
    closeHeight,
    mlkemPublicKey: "0x01",
    x25519PublicKey: "0x02",
    commitments: [z32, z32, z32],
  };
}

function inbox(...posts: [Hex, InboxPost][]): InboxEntry[] {
  return posts.map(([poster, post], i) => ({ seq: BigInt(i + 1), height: BigInt(i + 1), poster, post }));
}

const dealerOf = (round: bigint) => committee[Number(round % 3n)]!;

describe("planCommittee", () => {
  const base = { cfg, feeds: [BTC], roundBlocks: 30n };

  it("the dealer of round 1 opens the first round", () => {
    assert.deepEqual(planCommittee({ ...base, entries: [], member: 1, height: 100n }), [
      { kind: "deal", feedId: BTC, round: 1n, closeHeight: 130n },
    ]);
    assert.deepEqual(planCommittee({ ...base, entries: [], member: 0, height: 100n }), []);
  });

  it("does not open a new round while the latest is still open", () => {
    const entries = inbox([dealerOf(1n), open(BTC, 1n, 130n)]);
    assert.deepEqual(planCommittee({ ...base, entries, member: 2, height: 130n }), []);
  });

  it("the next dealer opens the next round once the latest has closed", () => {
    const entries = inbox([dealerOf(1n), open(BTC, 1n, 130n)]);
    assert.deepEqual(planCommittee({ ...base, entries, member: 2, height: 131n }), [
      { kind: "deal", feedId: BTC, round: 2n, closeHeight: 161n },
    ]);
  });

  it("releases a share after the close, once, and only with a delivery", () => {
    const o = open(BTC, 1n, 130n);
    const delivery = { kind: "delivery", feedId: BTC, round: 1n, member: 0, envelope: "0xaa" } as const;
    const withDelivery = inbox([dealerOf(1n), o], [dealerOf(1n), delivery]);
    const run = (entries: InboxEntry[], height: bigint) =>
      planCommittee({ ...base, feeds: [], entries, member: 0, height }).map((a) => a.kind);

    assert.deepEqual(run(withDelivery, 130n), []); // not closed yet
    assert.deepEqual(run(withDelivery, 131n), ["release"]);
    assert.deepEqual(run(inbox([dealerOf(1n), o]), 131n), []); // no delivery
    const share: InboxPost = {
      kind: "share",
      feedId: BTC,
      round: 1n,
      member: 0,
      parts: [
        { index: 1, value: z32 },
        { index: 2, value: z32 },
      ],
    };
    assert.deepEqual(run([...withDelivery, ...inbox([committee[0], share])], 131n), []); // already released
  });

  it("ignores a delivery not posted by the round's dealer", () => {
    const fake = { kind: "delivery", feedId: BTC, round: 1n, member: 0, envelope: "0xaa" } as const;
    const entries = inbox([dealerOf(1n), open(BTC, 1n, 130n)], [addr(0xbad), fake]);
    assert.deepEqual(planCommittee({ ...base, feeds: [], entries, member: 0, height: 131n }), []);
  });
});

describe("planReporter", () => {
  const me = addr(0x100);
  const base = { cfg, reporter: me, feeds: [BTC, ETH], marginBlocks: 5n };

  it("reports in each feed's latest open round with time to spare", () => {
    const entries = inbox([dealerOf(1n), open(BTC, 1n, 130n)], [dealerOf(2n), open(ETH, 2n, 110n)]);
    const rounds = planReporter({ ...base, entries, height: 106n }).map((o) => [o.feedId, o.round]);
    assert.deepEqual(rounds, [[BTC, 1n]]); // ETH closes at 110: 106 + 5 > 110
  });

  it("does not report twice", () => {
    const report = { kind: "report", feedId: BTC, round: 1n, envelope: "0x00" } as const;
    const entries = inbox([dealerOf(1n), open(BTC, 1n, 130n)], [me, report]);
    assert.deepEqual(planReporter({ ...base, entries, height: 100n }), []);
  });

  it("ignores an open from someone who is not that round's dealer", () => {
    const entries = inbox([addr(0xbad), open(BTC, 1n, 130n)]);
    assert.equal(latestOpen(cfg, entries, BTC), undefined);
    assert.deepEqual(planReporter({ ...base, entries, height: 100n }), []);
  });
});

describe("planSequencer", () => {
  const entries = inbox(
    [dealerOf(1n), open(BTC, 1n, 100n)],
    [dealerOf(2n), open(BTC, 2n, 140n)],
    [dealerOf(3n), open(BTC, 3n, 180n)],
  );

  it("settles closed rounds newer than the hub's, oldest first", () => {
    const rounds = planSequencer({ cfg, entries, height: 150n, settled: new Map(), skipped: new Set() });
    assert.deepEqual(rounds.map((r) => r.round), [1n, 2n]);
  });

  it("skips rounds the hub already has and rounds given up on", () => {
    const rounds = planSequencer({
      cfg,
      entries,
      height: 200n,
      settled: new Map([[BTC.toLowerCase(), 1n]]),
      skipped: new Set([roundKey(BTC, 2n)]),
    });
    assert.deepEqual(rounds.map((r) => r.round), [3n]);
  });
});
