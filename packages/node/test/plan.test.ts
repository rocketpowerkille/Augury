import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEEDS, type Hex, type InboxEntry, type InboxPost, type RoundConfig, type RoundOpen } from "@augury/shared";
import {
  latestOpen,
  outerOpenOf,
  planCommittee,
  planReporter,
  planSequencer,
  roundKey,
  SHARE_TIMEOUT_BLOCKS,
  sharesOverdue,
} from "../src/plan.ts";

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
      { kind: "deal", feedId: BTC, round: 1n, closeHeight: 130n, layer: 0 },
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
      { kind: "deal", feedId: BTC, round: 2n, closeHeight: 161n, layer: 0 },
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

describe("two-dealer rounds", () => {
  const base = { cfg, feeds: [BTC], roundBlocks: 30n };
  const second = (round: bigint) => committee[Number((round + 1n) % 3n)]!;
  const layer0 = { ...open(BTC, 1n, 130n), layer: 0, layers: 2 } as const;
  const layer1 = { ...open(BTC, 1n, 130n), dealer: 2, layer: 1, layers: 2 } as const;

  it("the second dealer opens layer 1 with the same close height, once", () => {
    const entries = inbox([dealerOf(1n), layer0]);
    assert.deepEqual(planCommittee({ ...base, entries, member: 2, height: 105n }), [
      { kind: "deal", feedId: BTC, round: 1n, closeHeight: 130n, layer: 1 },
    ]);
    assert.deepEqual(planCommittee({ ...base, entries, member: 0, height: 105n }), []); // not its turn
    const both = inbox([dealerOf(1n), layer0], [second(1n), layer1]);
    assert.deepEqual(planCommittee({ ...base, entries: both, member: 2, height: 105n }), []);
  });

  it("ignores a layer 1 open with another close height or from the layer 0 dealer", () => {
    const wrongClose = inbox([dealerOf(1n), layer0], [second(1n), { ...layer1, closeHeight: 999n }]);
    assert.equal(outerOpenOf(cfg, wrongClose, layer0), undefined);
    const sameDealer = inbox([dealerOf(1n), layer0], [dealerOf(1n), { ...layer1, dealer: 1 }]);
    assert.equal(outerOpenOf(cfg, sameDealer, layer0), undefined);
  });

  it("reporters wait for layer 1, then get both opens", () => {
    const me = addr(0x100);
    const args = { cfg, reporter: me, feeds: [BTC], marginBlocks: 5n, height: 105n };
    assert.deepEqual(planReporter({ ...args, entries: inbox([dealerOf(1n), layer0]) }), []);
    const both = inbox([dealerOf(1n), layer0], [second(1n), layer1]);
    assert.deepEqual(planReporter({ ...args, entries: both }), [{ open: layer0, outer: layer1 }]);
  });

  it("members release a share of each layer they were dealt", () => {
    const d0 = { kind: "delivery", feedId: BTC, round: 1n, member: 0, envelope: "0xaa", layer: 0 } as const;
    const d1 = { kind: "delivery", feedId: BTC, round: 1n, member: 0, envelope: "0xbb", layer: 1 } as const;
    const entries = inbox([dealerOf(1n), layer0], [second(1n), layer1], [dealerOf(1n), d0], [second(1n), d1]);
    const released = planCommittee({ ...base, feeds: [], entries, member: 0, height: 131n });
    assert.deepEqual(
      released.map((a) => (a.kind === "release" ? a.open.layer : -1)),
      [0, 1],
    );
    const share0: InboxPost = {
      kind: "share",
      feedId: BTC,
      round: 1n,
      member: 0,
      layer: 0,
      parts: [
        { index: 1, value: z32 },
        { index: 2, value: z32 },
      ],
    };
    const after = planCommittee({ ...base, feeds: [], entries: [...entries, ...inbox([committee[0], share0])], member: 0, height: 131n });
    assert.deepEqual(after.map((a) => (a.kind === "release" ? a.open.layer : -1)), [1]);
  });
});

describe("planReporter", () => {
  const me = addr(0x100);
  const base = { cfg, reporter: me, feeds: [BTC, ETH], marginBlocks: 5n };

  it("reports in each feed's latest open round with time to spare", () => {
    const entries = inbox([dealerOf(1n), open(BTC, 1n, 130n)], [dealerOf(2n), open(ETH, 2n, 110n)]);
    const rounds = planReporter({ ...base, entries, height: 106n }).map((o) => [o.open.feedId, o.open.round]);
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

describe("sharesOverdue", () => {
  /** Regression: a round whose shares never came blocked every later round of its feed forever. */
  it("gives up on a round's shares only after the timeout past its close", () => {
    assert.equal(sharesOverdue(100n, 100n + SHARE_TIMEOUT_BLOCKS), false);
    assert.equal(sharesOverdue(100n, 101n + SHARE_TIMEOUT_BLOCKS), true);
    assert.equal(sharesOverdue(100n, 150n, 10n), true);
  });
});
