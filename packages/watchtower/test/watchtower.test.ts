import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bytesToHex,
  FEEDS,
  generateSigningKey,
  median,
  reportRoot,
  signReport,
  type ChainView,
  type Hex,
  type RoundConfig,
  type SignedReport,
} from "@augury/shared";
import { auditBatch, provableFraud, type PostedBatch } from "../src/index.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const cfg: RoundConfig = {
  domain: { chainId: 9800n, hub: addr(0x4b) },
  sealChainId: "qorechain-diana",
  committee: [addr(0xc0), addr(0xc1), addr(0xc2)],
  minReports: 3,
  maxReports: 16,
};

const reporters = [100n, 102n, 101n].map((price, i) => ({ address: addr(0x100 + i), key: generateSigningKey(), price }));
const view = (inactive: Hex[] = []): ChainView => ({
  reporterKey: (a) => reporters.find((r) => r.address === a.toLowerCase())?.key.publicKey,
  isActive: (a) => !inactive.includes(a),
});

function signed(i: number, price = reporters[i]!.price): SignedReport {
  const r = reporters[i]!;
  return signReport(r.key.secretKey, cfg.domain, {
    feedId: FEEDS["fBTC/USD"],
    round: 1n,
    reporter: r.address,
    price,
    observedAt: 1764000000n,
    // Fixed per reporter, so signing the same report twice gives the same bytes.
    salt: `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`,
  });
}

function batch(reports: SignedReport[], price = median(reports.map((r) => r.price))): PostedBatch {
  return {
    header: {
      feedId: FEEDS["fBTC/USD"],
      round: 1n,
      price,
      reportRoot: bytesToHex(reportRoot(cfg.domain, reports)),
      reportCount: reports.length,
    },
    reports,
  };
}

describe("provableFraud mirrors AuguryHub.challengeBatch", () => {
  const honest = [signed(0), signed(1), signed(2)];

  it("accepts an honest batch", () => {
    assert.equal(provableFraud(cfg, view(), batch(honest)), undefined);
  });

  it("finds a wrong median", () => {
    assert.equal(provableFraud(cfg, view(), batch(honest, 1n)), "wrong-median");
  });

  it("finds a duplicate reporter", () => {
    assert.equal(provableFraud(cfg, view(), batch([signed(0), signed(1), signed(0)])), "duplicate-reporter");
  });

  it("finds an inactive reporter", () => {
    assert.equal(provableFraud(cfg, view([reporters[1]!.address]), batch(honest)), "inactive-reporter");
  });

  it("finds a bad signature", () => {
    const forged = { ...signed(2), price: 999n };
    assert.equal(provableFraud(cfg, view(), batch([signed(0), signed(1), forged])), "bad-signature");
  });

  it("reports the first fraud in the hub's order", () => {
    const forged = { ...signed(2), price: 999n };
    assert.equal(provableFraud(cfg, view(), batch([signed(0), signed(0), forged], 1n)), "duplicate-reporter");
  });
});

describe("auditBatch", () => {
  it("flags a batch posted for a round the inbox never opened", () => {
    const findings = auditBatch(cfg, view(), [], batch([signed(0), signed(1), signed(2)]));
    assert.deepEqual(findings, [{ kind: "no-canonical-batch", status: "no-open" }]);
  });
});
