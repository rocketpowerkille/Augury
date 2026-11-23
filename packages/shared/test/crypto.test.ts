import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  decodeReportMessage,
  FEEDS,
  generateSigningKey,
  ML_DSA_87_PUBLIC_KEY_LENGTH,
  ML_DSA_87_SIGNATURE_LENGTH,
  openReport,
  reportMessage,
  roundKeys,
  roundRecipient,
  sealReport,
  signBatch,
  signReport,
  verifyBatch,
  verifyReport,
  type Domain,
  type Report,
} from "../src/index.ts";

const domain: Domain = { chainId: 9800n, hub: "0x1111111111111111111111111111111111111111" };
const sealChainId = "qorechain-diana";
const reporterKey = generateSigningKey();

const report: Report = {
  feedId: FEEDS["fBTC/USD"],
  round: 42n,
  reporter: "0x2222222222222222222222222222222222222222",
  price: 9712345000000n,
  observedAt: 1764000000n,
};

describe("ML-DSA-87 report and batch signatures", () => {
  it("uses ML-DSA-87 sizes", () => {
    assert.equal(reporterKey.publicKey.length, ML_DSA_87_PUBLIC_KEY_LENGTH);
    assert.equal(signReport(reporterKey.secretKey, domain, report).signature.length, ML_DSA_87_SIGNATURE_LENGTH);
  });

  it("verifies a signed report", () => {
    const signed = signReport(reporterKey.secretKey, domain, report);
    assert.equal(verifyReport(reporterKey.publicKey, domain, signed), true);
  });

  it("rejects a changed price", () => {
    const signed = signReport(reporterKey.secretKey, domain, report);
    assert.equal(verifyReport(reporterKey.publicKey, domain, { ...signed, price: 1n }), false);
  });

  it("rejects a signature from another hub", () => {
    const signed = signReport(reporterKey.secretKey, domain, report);
    const other: Domain = { ...domain, hub: "0x9999999999999999999999999999999999999999" };
    assert.equal(verifyReport(reporterKey.publicKey, other, signed), false);
  });

  it("rejects another key", () => {
    const signed = signReport(reporterKey.secretKey, domain, report);
    assert.equal(verifyReport(generateSigningKey().publicKey, domain, signed), false);
  });

  it("signs and verifies a batch", () => {
    const header = {
      feedId: report.feedId,
      round: 42n,
      price: report.price,
      reportRoot: `0x${"ab".repeat(32)}` as const,
      reportCount: 3,
    };
    const sig = signBatch(reporterKey.secretKey, domain, header);
    assert.equal(verifyBatch(reporterKey.publicKey, domain, header, sig), true);
    assert.equal(verifyBatch(reporterKey.publicKey, domain, { ...header, price: 1n }, sig), false);
  });
});

describe("report messages", () => {
  it("decode back to the same report", () => {
    assert.deepEqual(decodeReportMessage(domain, reportMessage(domain, report)), report);
  });

  it("refuse a message for another hub", () => {
    const other: Domain = { ...domain, hub: "0x9999999999999999999999999999999999999999" };
    assert.throws(() => decodeReportMessage(other, reportMessage(domain, report)), /another hub/);
  });
});

describe("sealed reports", () => {
  const seed = new Uint8Array(randomBytes(32));
  const keys = roundKeys(seed);
  const signed = signReport(reporterKey.secretKey, domain, report);
  const envelope = sealReport({ sealChainId, domain, recipient: roundRecipient(keys), report: signed });
  const openArgs = { sealChainId, domain, keys, envelope, feedId: report.feedId, round: report.round };

  it("open with the round key to the same signed report", () => {
    const opened = openReport(openArgs);
    assert.deepEqual(opened, signed);
    assert.equal(verifyReport(reporterKey.publicKey, domain, opened), true);
  });

  it("the same seed rebuilds the same round key", () => {
    assert.deepEqual(openReport({ ...openArgs, keys: roundKeys(seed) }), signed);
  });

  it("do not open with another round's key", () => {
    assert.throws(() => openReport({ ...openArgs, keys: roundKeys(new Uint8Array(randomBytes(32))) }));
  });

  it("cannot be replayed into another round", () => {
    assert.throws(() => openReport({ ...openArgs, round: report.round + 1n }));
  });

  it("cannot be replayed into another feed", () => {
    assert.throws(() => openReport({ ...openArgs, feedId: FEEDS["fETH/USD"] }));
  });

  it("do not contain the report message in the clear", () => {
    const message = Buffer.from(reportMessage(domain, report)).toString("hex");
    assert.equal(Buffer.from(envelope).toString("hex").includes(message.slice(0, 64)), false);
  });
});
