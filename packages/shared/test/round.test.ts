import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  bytesToHex,
  FEEDS,
  generateSigningKey,
  median,
  newSalt,
  postFromShare,
  processRound,
  reportRoot,
  roundKeys,
  sealReport,
  signReport,
  splitSeed,
  type ChainView,
  type Hex,
  type InboxEntry,
  type InboxPost,
  type RoundConfig,
  type SigningKey,
} from "../src/index.ts";

const FEED = FEEDS["fBTC/USD"];
const ROUND = 5n;
const CLOSE = 100n;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;

const committee = [addr(0xc0), addr(0xc1), addr(0xc2)] as const;
const cfg: RoundConfig = {
  domain: { chainId: 9800n, hub: addr(0x4b) },
  sealChainId: "qorechain-diana",
  committee,
  minReports: 3,
  maxReports: 16,
};

interface Reporter {
  address: Hex;
  key: SigningKey;
}
const reporters: Reporter[] = Array.from({ length: 6 }, (_, i) => ({
  address: addr(0x100 + i),
  key: generateSigningKey(),
}));

function view(overrides: Partial<ChainView> = {}): ChainView {
  return {
    reporterKey: (a) => reporters.find((r) => r.address === a.toLowerCase())?.key.publicKey,
    isActive: () => true,
    ...overrides,
  };
}

/** Builds an inbox for one round. Every helper appends an entry. */
class Inbox {
  entries: InboxEntry[] = [];
  seed = new Uint8Array(randomBytes(32));
  split = splitSeed(this.seed, ROUND);
  keys = roundKeys(this.seed);

  private add(poster: Hex, height: bigint, post: InboxPost) {
    this.entries.push({ seq: BigInt(this.entries.length + 1), height, poster, post });
  }

  open(opts: { dealer?: 0 | 1 | 2; poster?: Hex; mlkemPublicKey?: Hex } = {}) {
    const dealer = opts.dealer ?? 0;
    this.add(opts.poster ?? committee[dealer], 10n, {
      kind: "open",
      feedId: FEED,
      round: ROUND,
      dealer,
      closeHeight: CLOSE,
      mlkemPublicKey: opts.mlkemPublicKey ?? bytesToHex(this.keys.mlkemPublicKey),
      x25519PublicKey: bytesToHex(this.keys.x25519PublicKey),
      commitments: this.split.commitments,
    });
    return this;
  }

  /** A report: the sealed message, then (unless `noSignature`) its signature right after. */
  report(
    r: Reporter,
    price: bigint,
    opts: {
      height?: bigint;
      poster?: Hex;
      signer?: SigningKey;
      observedAt?: bigint;
      noSignature?: boolean;
      salt?: Hex;
      signatureHeight?: bigint;
    } = {},
  ) {
    const signed = signReport((opts.signer ?? r.key).secretKey, cfg.domain, {
      feedId: FEED,
      round: ROUND,
      reporter: r.address,
      price,
      observedAt: opts.observedAt ?? 1764000000n,
      salt: opts.salt ?? newSalt(),
    });
    const envelope = sealReport({
      sealChainId: cfg.sealChainId,
      domain: cfg.domain,
      recipient: { mlkemPublicKey: this.keys.mlkemPublicKey, x25519PublicKey: this.keys.x25519PublicKey },
      report: signed,
    });
    const poster = opts.poster ?? r.address;
    const height = opts.height ?? 50n;
    this.add(poster, height, { kind: "report", feedId: FEED, round: ROUND, envelope: bytesToHex(envelope) });
    if (!opts.noSignature) {
      this.add(poster, opts.signatureHeight ?? height, {
        kind: "signature",
        feedId: FEED,
        round: ROUND,
        signature: bytesToHex(signed.signature),
      });
    }
    return this;
  }

  share(member: 0 | 1 | 2, opts: { height?: bigint; poster?: Hex } = {}) {
    this.add(opts.poster ?? committee[member], opts.height ?? CLOSE + 1n, postFromShare(FEED, ROUND, this.split.shares[member]));
    return this;
  }

  run(v: ChainView = view(), c: RoundConfig = cfg) {
    return processRound(c, v, this.entries, FEED, ROUND);
  }
}

const prices = [100n, 104n, 101n, 103n, 102n];
function fullRound() {
  const inbox = new Inbox().open();
  prices.forEach((p, i) => inbox.report(reporters[i]!, p));
  return inbox;
}

describe("processRound", () => {
  it("builds a batch from sealed reports once two members release shares", () => {
    const inbox = fullRound().share(0).share(2);
    const out = inbox.run();
    assert.equal(out.status, "ready");
    if (out.status !== "ready") return;
    assert.equal(out.header.price, median(prices));
    assert.equal(out.header.reportCount, 5);
    assert.equal(out.header.reportRoot, bytesToHex(reportRoot(cfg.domain, out.reports)));
    assert.deepEqual(out.reports.map((r) => r.price), prices);
    assert.deepEqual(out.rejected, []);
  });

  it("waits while fewer than two members have released", () => {
    assert.equal(fullRound().share(1).run().status, "awaiting-shares");
  });

  it("ignores and records shares released before the round closed", () => {
    const out = fullRound().share(0, { height: CLOSE }).share(1).run();
    assert.equal(out.status, "awaiting-shares");
    if (out.status !== "awaiting-shares") return;
    assert.deepEqual(out.earlyShares.map((s) => s.member), [0]);
  });

  it("ignores a share posted by an account that is not that member", () => {
    assert.equal(fullRound().share(0).share(1, { poster: addr(0xbad) }).run().status, "awaiting-shares");
  });

  it("ignores an open not posted by the round's dealer", () => {
    assert.equal(new Inbox().open({ dealer: 1, poster: committee[0] }).run().status, "no-open");
  });

  it("detects a dealer whose public key does not match the committed seed", () => {
    const other = roundKeys(new Uint8Array(randomBytes(32)));
    const inbox = new Inbox().open({ mlkemPublicKey: bytesToHex(other.mlkemPublicKey) });
    prices.forEach((p, i) => inbox.report(reporters[i]!, p));
    assert.equal(inbox.share(0).share(1).run().status, "bad-round-key");
  });

  it("rejects late reports", () => {
    const out = fullRound().report(reporters[5]!, 1n, { height: CLOSE + 1n }).share(0).share(1).run();
    assert.equal(out.status, "ready");
    if (out.status !== "ready") return;
    assert.equal(out.header.reportCount, 5);
    assert.deepEqual(out.rejected.map((r) => r.reason), ["late"]);
  });

  it("rejects a sealed report without its signature right after it", () => {
    const out = fullRound().report(reporters[5]!, 1n, { noSignature: true }).share(0).share(1).run();
    assert.ok(out.status === "ready");
    assert.deepEqual(out.rejected.map((r) => r.reason), ["missing-signature"]);
    assert.equal(out.header.reportCount, 5);
  });

  it("rejects a signature posted in a later block than its report", () => {
    const out = fullRound().report(reporters[5]!, 1n, { signatureHeight: 51n }).share(0).share(1).run();
    assert.ok(out.status === "ready");
    assert.deepEqual(out.rejected.map((r) => r.reason), ["missing-signature"]);
  });

  it("rejects a report posted by someone other than its reporter", () => {
    const out = fullRound().report(reporters[5]!, 1n, { poster: reporters[0]!.address }).share(0).share(1).run();
    assert.ok(out.status === "ready");
    assert.deepEqual(out.rejected.map((r) => r.reason), ["wrong-poster"]);
  });

  it("rejects bad signatures, unknown keys and inactive reporters", () => {
    const stranger: Reporter = { address: addr(0x999), key: generateSigningKey() };
    const out = fullRound()
      .report(reporters[5]!, 1n, { signer: generateSigningKey() })
      .report(stranger, 1n)
      .share(0)
      .share(1)
      .run(view({ isActive: (a) => a !== reporters[4]!.address }));
    assert.ok(out.status === "ready");
    assert.deepEqual(out.rejected.map((r) => r.reason), ["inactive", "bad-signature", "unknown-key"]);
    assert.equal(out.header.reportCount, 4);
  });

  it("keeps one copy of an identical duplicate", () => {
    const salt = newSalt();
    const inbox = new Inbox().open().report(reporters[0]!, prices[0]!, { salt });
    prices.slice(1).forEach((p, i) => inbox.report(reporters[i + 1]!, p));
    const out = inbox.report(reporters[0]!, prices[0]!, { salt }).share(0).share(1).run();
    assert.ok(out.status === "ready");
    assert.deepEqual(out.rejected.map((r) => r.reason), ["duplicate"]);
    assert.equal(out.equivocations.length, 0);
    assert.equal(out.header.reportCount, 5);
  });

  it("treats the same price under another salt as equivocation", () => {
    const out = fullRound().report(reporters[0]!, prices[0]!).share(0).share(1).run();
    assert.ok(out.status === "ready");
    assert.equal(out.equivocations.length, 1);
    assert.equal(out.header.reportCount, 4);
  });

  it("drops an equivocating reporter and records the evidence", () => {
    const out = fullRound().report(reporters[0]!, 999n).share(0).share(1).run();
    assert.ok(out.status === "ready");
    assert.equal(out.equivocations.length, 1);
    assert.equal(out.equivocations[0]!.second.price, 999n);
    assert.equal(out.header.reportCount, 4);
    assert.ok(!out.reports.some((r) => r.reporter === reporters[0]!.address));
  });

  it("caps the batch at maxReports, in inbox order", () => {
    const out = fullRound().share(0).share(1).run(view(), { ...cfg, maxReports: 3 });
    assert.ok(out.status === "ready");
    assert.deepEqual(out.reports.map((r) => r.price), prices.slice(0, 3));
    assert.equal(out.rejected.filter((r) => r.reason === "over-capacity").length, 2);
  });

  it("does not build a batch with too few reports", () => {
    const inbox = new Inbox().open().report(reporters[0]!, 1n).report(reporters[1]!, 2n).share(0).share(1);
    assert.equal(inbox.run().status, "too-few-reports");
  });
});
