import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptDelivery, dealRound, layerDealerFor, releaseShare, type Deal } from "@augury/committee";
import { buildReportPosts } from "@augury/reporter";
import { buildBatch } from "@augury/sequencer";
import {
  bytesToHex,
  combineShares,
  FEEDS,
  generateSigningKey,
  hexToBytes,
  median,
  openReport,
  processRound,
  roundKeys,
  sealReport,
  type ChainView,
  type Hex,
  type InboxEntry,
  type InboxPost,
  type Layer,
  type MemberIndex,
  type MemberShare,
  type RoundConfig,
} from "@augury/shared";
import { auditBatch } from "@augury/watchtower";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const FEED = FEEDS["fETH/USD"];
const ROUND = 3n; // layer 0 dealt by member 0, layer 1 by member 1
const CLOSE = 100n;

const committee = [addr(0xc0), addr(0xc1), addr(0xc2)] as const;
const sealKeys = [generateSealKeys(), generateSealKeys(), generateSealKeys()] as const;
const members = [recipientOf(sealKeys[0]), recipientOf(sealKeys[1]), recipientOf(sealKeys[2])] as const;
const sequencerKey = generateSigningKey();

const cfg: RoundConfig = {
  domain: { chainId: 9800n, hub: addr(0x4b) },
  sealChainId: "qorechain-diana",
  committee,
  minReports: 3,
  maxReports: 16,
};

const reporters = [171_585_000_000n, 171_600_000_000n, 171_550_000_000n].map((price, i) => ({
  address: addr(0x100 + i),
  key: generateSigningKey(),
  price,
}));

const view: ChainView = {
  reporterKey: (a) => reporters.find((r) => r.address === a.toLowerCase())?.key.publicKey,
  isActive: (a) => reporters.some((r) => r.address === a.toLowerCase()),
};

/** Every member's share of one layer, as each member recovers it from its delivery. */
function sharesOf(deal: Deal): Map<MemberIndex, MemberShare> {
  const held = new Map<MemberIndex, MemberShare>();
  for (const d of deal.deliveries) {
    held.set(
      d.member,
      acceptDelivery({ sealChainId: cfg.sealChainId, member: d.member, keys: sealKeys[d.member], open: deal.open, envelope: d.envelope }),
    );
  }
  return held;
}

function playRound(opts: { releaseLayer1?: boolean; postLayer1?: boolean } = {}) {
  const entries: InboxEntry[] = [];
  const post = (poster: Hex, height: bigint, p: InboxPost) => entries.push({ seq: BigInt(entries.length + 1), height, poster, post: p });
  const deliveriesOf = (deal: Deal, layer: Layer) =>
    deal.deliveries.map((d) => ({ kind: "delivery" as const, feedId: FEED, round: ROUND, member: d.member, envelope: bytesToHex(d.envelope), layer }));

  // 1. Two members deal: layer 0 first, then layer 1 with the same close height.
  const deal0 = dealRound({ sealChainId: cfg.sealChainId, feedId: FEED, round: ROUND, closeHeight: CLOSE, members, layer: 0, layers: 2 });
  const deal1 = dealRound({ sealChainId: cfg.sealChainId, feedId: FEED, round: ROUND, closeHeight: CLOSE, members, layer: 1 });
  assert.equal(deal0.open.dealer, layerDealerFor(ROUND, 0));
  assert.equal(deal1.open.dealer, layerDealerFor(ROUND, 1));
  post(committee[deal0.open.dealer], 10n, deal0.open);
  for (const d of deliveriesOf(deal0, 0)) post(committee[deal0.open.dealer], 10n, d);
  if (opts.postLayer1 !== false) {
    post(committee[deal1.open.dealer], 12n, deal1.open);
    for (const d of deliveriesOf(deal1, 1)) post(committee[deal1.open.dealer], 12n, d);
  }
  const held = [sharesOf(deal0), sharesOf(deal1)] as const;

  // 2. Reporters seal to both keys and post report + signature.
  for (const r of reporters) {
    const posts = buildReportPosts({
      domain: cfg.domain,
      sealChainId: cfg.sealChainId,
      reporter: r.address,
      secretKey: r.key.secretKey,
      open: deal0.open,
      outer: deal1.open,
      price: r.price,
      observedAt: 1764000000n,
    });
    for (const p of posts) post(r.address, 50n, p);
  }

  // 3. After the close, members 1 and 2 release their shares of both layers.
  for (const m of [1, 2] as const) {
    post(committee[m], CLOSE + 1n, releaseShare(deal0.open, held[0].get(m)!, CLOSE + 1n));
    if (opts.releaseLayer1 !== false) post(committee[m], CLOSE + 1n, releaseShare(deal1.open, held[1].get(m)!, CLOSE + 1n));
  }
  return { entries, deal0, deal1, held };
}

describe("a two-dealer round", () => {
  const { entries, deal0, deal1, held } = playRound();

  it("settles with the median of all reports, and the watchtower agrees", () => {
    const built = buildBatch(cfg, view, entries, FEED, ROUND, sequencerKey.secretKey);
    assert.equal(built.outcome.status, "ready");
    assert.equal(built.batch!.header.price, median(reporters.map((r) => r.price)));
    assert.equal(built.batch!.header.reportCount, 3);
    assert.deepEqual(auditBatch(cfg, view, entries, { header: built.batch!.header, reports: built.batch!.reports }), []);
  });

  it("keeps a report sealed from either dealer alone, even with its whole seed", () => {
    const reportEntry = entries.find((e) => e.post.kind === "report")!;
    assert.ok(reportEntry.post.kind === "report");
    const sealed = hexToBytes(reportEntry.post.envelope);
    // Each dealer knows its own seed: model that with all three parts of its layer.
    const seedOf = (layer: 0 | 1, open = layer === 0 ? deal0.open : deal1.open) =>
      roundKeys(combineShares([...held[layer].values()], ROUND, open.commitments));
    const k0 = seedOf(0);
    const k1 = seedOf(1);
    const tryOpen = (keys: typeof k0, outerKeys?: typeof k0) =>
      openReport({
        sealChainId: cfg.sealChainId,
        domain: cfg.domain,
        keys,
        ...(outerKeys ? { outerKeys } : {}),
        envelope: sealed,
        feedId: FEED,
        round: ROUND,
      });
    assert.throws(() => tryOpen(k0)); // layer 0 dealer alone
    assert.throws(() => tryOpen(k0, k0));
    assert.throws(() => tryOpen(k1, k1)); // layer 1 dealer alone
    assert.throws(() => tryOpen(k1, k0)); // both keys, wrong order
    assert.equal(tryOpen(k0, k1).reporter, reporters[0]!.address); // both seeds open it
  });

  it("waits for both layers' shares", () => {
    const partial = playRound({ releaseLayer1: false });
    assert.equal(processRound(cfg, view, partial.entries, FEED, ROUND).status, "awaiting-shares");
  });

  it("does not start until the second dealer has opened layer 1", () => {
    const missing = playRound({ postLayer1: false });
    assert.equal(processRound(cfg, view, missing.entries, FEED, ROUND).status, "no-open");
  });

  it("rejects a report sealed to the layer 0 key only", () => {
    const r = reporters[0]!;
    const single = sealReport({
      sealChainId: cfg.sealChainId,
      domain: cfg.domain,
      recipient: recipientOf(roundKeys(combineShares([...held[0].values()], ROUND, deal0.open.commitments))),
      report: { feedId: FEED, round: ROUND, reporter: r.address, price: 1n, observedAt: 1n, salt: `0x${"11".repeat(32)}` },
    });
    // Replace reporter 0's report envelope with the single-sealed one, keeping its position.
    const at = entries.findIndex((e) => e.post.kind === "report" && e.poster === r.address);
    const replaced = entries.map((e, i) => (i === at && e.post.kind === "report" ? { ...e, post: { ...e.post, envelope: bytesToHex(single) } } : e));
    const out = processRound(cfg, view, replaced, FEED, ROUND);
    assert.ok(out.status === "ready" || out.status === "too-few-reports");
    assert.ok("rejected" in out && out.rejected.some((x) => x.poster === r.address && x.reason === "cannot-open"));
  });
});
