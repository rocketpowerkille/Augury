import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bytesToHex,
  combineShares,
  FEEDS,
  roundKeys,
  shareFromPost,
  type MemberShare,
} from "@augury/shared";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";
import { acceptDelivery, dealerFor, dealRound, releaseShare } from "../src/index.ts";

const sealChainId = "qorechain-diana";
const memberKeys = [generateSealKeys(), generateSealKeys(), generateSealKeys()] as const;
const members = [recipientOf(memberKeys[0]), recipientOf(memberKeys[1]), recipientOf(memberKeys[2])] as const;
const round = 7n; // dealer = 7 % 3 = 1

function deal() {
  return dealRound({ sealChainId, feedId: FEEDS["fETH/USD"], round, closeHeight: 100n, members });
}

function acceptAll(d: ReturnType<typeof deal>): MemberShare[] {
  const received = d.deliveries.map((x) =>
    acceptDelivery({ sealChainId, member: x.member, keys: memberKeys[x.member], open: d.open, envelope: x.envelope }),
  );
  return [d.ownShare, ...received];
}

describe("committee", () => {
  it("rotates the dealer every round", () => {
    assert.deepEqual([0n, 1n, 2n, 3n].map(dealerFor), [0, 1, 2, 0]);
    assert.equal(deal().open.dealer, 1);
  });

  it("delivers a share to each other member", () => {
    const d = deal();
    assert.deepEqual(d.deliveries.map((x) => x.member).sort(), [0, 2]);
    assert.equal(d.ownShare.member, 1);
  });

  it("any two released shares rebuild the published round key", () => {
    const d = deal();
    const shares = acceptAll(d);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) {
      const posts = [shares[a]!, shares[b]!].map((s) => releaseShare(d.open, s, 101n));
      const seed = combineShares(posts.map(shareFromPost), round, d.open.commitments);
      assert.equal(bytesToHex(roundKeys(seed).mlkemPublicKey), d.open.mlkemPublicKey);
    }
  });

  it("refuses to release before the round closes", () => {
    const d = deal();
    assert.throws(() => releaseShare(d.open, d.ownShare, 100n), /not releasing/);
  });

  it("a member cannot open another member's delivery", () => {
    const d = deal();
    const toZero = d.deliveries.find((x) => x.member === 0)!;
    assert.throws(() =>
      acceptDelivery({ sealChainId, member: 2, keys: memberKeys[2], open: d.open, envelope: toZero.envelope }),
    );
  });

  it("rejects a delivery checked against another round's open", () => {
    const d = deal();
    const other = deal();
    const x = d.deliveries[0]!;
    assert.throws(() =>
      acceptDelivery({ sealChainId, member: x.member, keys: memberKeys[x.member], open: other.open, envelope: x.envelope }),
    );
  });

  it("rejects a tampered delivery", () => {
    const d = deal();
    const x = d.deliveries[0]!;
    const envelope = Uint8Array.from(x.envelope);
    envelope[envelope.length - 1]! ^= 1;
    assert.throws(() =>
      acceptDelivery({ sealChainId, member: x.member, keys: memberKeys[x.member], open: d.open, envelope }),
    );
  });
});
