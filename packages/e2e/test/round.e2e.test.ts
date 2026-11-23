import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptDelivery, dealRound, releaseShare } from "@augury/committee";
import { buildReportPosts } from "@augury/reporter";
import { buildBatch } from "@augury/sequencer";
import {
  FEEDS,
  generateSigningKey,
  median,
  newSalt,
  signReport,
  verifyBatch,
  bytesToHex,
  reportRoot,
  type ChainView,
  type Hex,
  type InboxEntry,
  type InboxPost,
  type RoundConfig,
  type SignedReport,
} from "@augury/shared";
import { auditBatch, type PostedBatch } from "@augury/watchtower";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const FEED = FEEDS["fBTC/USD"];
const ROUND = 3n; // dealer = member 0
const CLOSE = 100n;

const committee = [addr(0xc0), addr(0xc1), addr(0xc2)] as const;
const committeeSealKeys = [generateSealKeys(), generateSealKeys(), generateSealKeys()] as const;
const sequencerKey = generateSigningKey();

const cfg: RoundConfig = {
  domain: { chainId: 9800n, hub: addr(0x4b) },
  sealChainId: "qorechain-diana",
  committee,
  minReports: 3,
  maxReports: 16,
};

const reporters = [9712345000000n, 9710000000000n, 9715000000000n, 9711000000000n, 9790000000000n].map(
  (price, i) => ({ address: addr(0x100 + i), key: generateSigningKey(), price }),
);

const view: ChainView = {
  reporterKey: (a) => reporters.find((r) => r.address === a.toLowerCase())?.key.publicKey,
  isActive: (a) => reporters.some((r) => r.address === a.toLowerCase()),
};

/** Play a full round and return the inbox it leaves behind. */
function playRound(): InboxEntry[] {
  const entries: InboxEntry[] = [];
  const post = (poster: Hex, height: bigint, p: InboxPost) =>
    entries.push({ seq: BigInt(entries.length + 1), height, poster, post: p });

  // 1. The dealer deals; the other members accept their sealed shares.
  const deal = dealRound({
    sealChainId: cfg.sealChainId,
    feedId: FEED,
    round: ROUND,
    closeHeight: CLOSE,
    members: [recipientOf(committeeSealKeys[0]), recipientOf(committeeSealKeys[1]), recipientOf(committeeSealKeys[2])],
  });
  post(committee[deal.open.dealer], 10n, deal.open);
  const held = new Map([[deal.ownShare.member, deal.ownShare]]);
  for (const d of deal.deliveries) {
    held.set(
      d.member,
      acceptDelivery({ sealChainId: cfg.sealChainId, member: d.member, keys: committeeSealKeys[d.member], open: deal.open, envelope: d.envelope }),
    );
  }

  // 2. Reporters post their sealed observation and its signature, back to back (one tx).
  for (const r of reporters) {
    const posts = buildReportPosts({
      domain: cfg.domain,
      sealChainId: cfg.sealChainId,
      reporter: r.address,
      secretKey: r.key.secretKey,
      open: deal.open,
      price: r.price,
      observedAt: 1764000000n,
    });
    for (const p of posts) post(r.address, 50n, p);
  }

  // 3. After the close, two members release their shares.
  post(committee[1], CLOSE + 1n, releaseShare(deal.open, held.get(1)!, CLOSE + 1n));
  post(committee[2], CLOSE + 2n, releaseShare(deal.open, held.get(2)!, CLOSE + 2n));
  return entries;
}

describe("a full Augury round", () => {
  const entries = playRound();
  const built = buildBatch(cfg, view, entries, FEED, ROUND, sequencerKey.secretKey);

  it("the sequencer produces a signed batch with the median of all reports", () => {
    assert.equal(built.outcome.status, "ready");
    const batch = built.batch!;
    assert.equal(batch.header.price, median(reporters.map((r) => r.price)));
    assert.equal(batch.header.reportCount, reporters.length);
    assert.equal(verifyBatch(sequencerKey.publicKey, cfg.domain, batch.header, batch.signature), true);
  });

  it("the watchtower finds nothing wrong with the honest batch", () => {
    const batch = built.batch!;
    assert.deepEqual(auditBatch(cfg, view, entries, { header: batch.header, reports: batch.reports }), []);
  });

  it("the watchtower proves a lying median", () => {
    const batch = built.batch!;
    const lie: PostedBatch = { header: { ...batch.header, price: 1n }, reports: batch.reports };
    const findings = auditBatch(cfg, view, entries, lie);
    assert.deepEqual(findings.map((f) => f.kind), ["challenge"]);
    assert.equal(findings[0]!.kind === "challenge" && findings[0]!.fraud, "wrong-median");
  });

  it("the watchtower flags a batch that drops a report, even with an honest median", () => {
    const batch = built.batch!;
    const kept = batch.reports.slice(1);
    const header = {
      ...batch.header,
      price: median(kept.map((r) => r.price)),
      reportRoot: bytesToHex(reportRoot(cfg.domain, kept)),
      reportCount: kept.length,
    };
    const findings = auditBatch(cfg, view, entries, { header, reports: kept });
    assert.deepEqual(findings, [{ kind: "omitted-reports", reporters: [reporters[0]!.address] }]);
  });

  it("the watchtower flags a report smuggled in from outside the inbox", () => {
    const batch = built.batch!;
    const r = reporters[0]!;
    // A real signature from a real reporter, but never sealed into this round's inbox.
    const smuggled: SignedReport = signReport(r.key.secretKey, cfg.domain, {
      feedId: FEED,
      round: ROUND,
      reporter: r.address,
      price: 1n,
      observedAt: 1764000001n,
      salt: newSalt(),
    });
    const reports = [smuggled, ...batch.reports.slice(1)];
    const header = { ...batch.header, price: median(reports.map((x) => x.price)), reportCount: reports.length };
    const kinds = auditBatch(cfg, view, entries, { header, reports }).map((f) => f.kind).sort();
    assert.deepEqual(kinds, ["omitted-reports", "unexpected-reports"]);
  });
});
