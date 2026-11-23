import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  batchMessage,
  bytesToHex,
  encodeInt256,
  FEEDS,
  reportLeaf,
  reportMessage,
  reportRoot,
  sha256,
  concatBytes,
  TAGS,
  withdrawMessage,
  type Domain,
  type Report,
} from "../src/index.ts";

// Expected bytes produced by Foundry's `cast abi-encode`, i.e. Solidity's abi.encode.
const domain: Domain = { chainId: 9800n, hub: "0x1111111111111111111111111111111111111111" };

const report: Report = {
  feedId: FEEDS["fBTC/USD"],
  round: 42n,
  reporter: "0x2222222222222222222222222222222222222222",
  price: 9712345000000n,
  observedAt: 1764000000n,
  salt: `0x${"77".repeat(32)}`,
};

const EXPECTED_REPORT =
  "0xde27b797c84cbdc91a7c574a77ca25092b7ae1342f803884235a3775df6eafba" +
  "0000000000000000000000000000000000000000000000000000000000002648" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad" +
  "000000000000000000000000000000000000000000000000000000000000002a" +
  "0000000000000000000000002222222222222222222222222222222222222222" +
  "000000000000000000000000000000000000000000000000000008d554dfa840" +
  "0000000000000000000000000000000000000000000000000000000069248100" +
  "7777777777777777777777777777777777777777777777777777777777777777";

const EXPECTED_BATCH =
  "0x2360d05af57c90d2666345da3fbbeaa6d5b62565e01282b906e9abf7287cd413" +
  "0000000000000000000000000000000000000000000000000000000000002648" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "4bb79407dfad9e433ad54bfd5353fe075f319ef31887ca79b4b5b54a584bb1ad" +
  "000000000000000000000000000000000000000000000000000000000000002a" +
  "000000000000000000000000000000000000000000000000000008d554dfa840" +
  "3333333333333333333333333333333333333333333333333333333333333333" +
  "0000000000000000000000000000000000000000000000000000000000000005";

const EXPECTED_WITHDRAW =
  "0x37b6364c94d7831cde44bed5ea7b3fff4290cd7077dc378636c7d49078ce0280" +
  "0000000000000000000000000000000000000000000000000000000000002648" +
  "0000000000000000000000001111111111111111111111111111111111111111" +
  "0000000000000000000000002222222222222222222222222222222222222222" +
  "0000000000000000000000004444444444444444444444444444444444444444" +
  "0000000000000000000000000000000000000000000000000000000000000007";

describe("messages match Solidity abi.encode", () => {
  it("report message", () => {
    assert.equal(bytesToHex(reportMessage(domain, report)), EXPECTED_REPORT);
  });

  it("batch message", () => {
    const msg = batchMessage(domain, {
      feedId: FEEDS["fBTC/USD"],
      round: 42n,
      price: 9712345000000n,
      reportRoot: `0x${"33".repeat(32)}`,
      reportCount: 5,
    });
    assert.equal(bytesToHex(msg), EXPECTED_BATCH);
  });

  it("withdraw message", () => {
    const msg = withdrawMessage(
      domain,
      TAGS.reporterWithdraw,
      "0x2222222222222222222222222222222222222222",
      "0x4444444444444444444444444444444444444444",
      7n,
    );
    assert.equal(bytesToHex(msg), EXPECTED_WITHDRAW);
  });

  it("encodes negative int256 as two's complement", () => {
    assert.equal(bytesToHex(encodeInt256(-5n)), `0x${"ff".repeat(31)}fb`);
  });

  it("rejects out-of-range fields", () => {
    assert.throws(() => reportMessage(domain, { ...report, round: 1n << 64n }), RangeError);
    assert.throws(() => reportMessage(domain, { ...report, reporter: "0x1234" }));
  });
});

describe("report root", () => {
  it("is SHA-256 of the concatenated leaves in order", () => {
    const second: Report = { ...report, reporter: "0x3333333333333333333333333333333333333333" };
    const expected = sha256(concatBytes(reportLeaf(domain, report), reportLeaf(domain, second)));
    assert.deepEqual(reportRoot(domain, [report, second]), expected);
  });

  it("depends on order", () => {
    const second: Report = { ...report, reporter: "0x3333333333333333333333333333333333333333" };
    assert.notDeepEqual(reportRoot(domain, [report, second]), reportRoot(domain, [second, report]));
  });
});
