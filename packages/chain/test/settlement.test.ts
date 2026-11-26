import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mldsa87 } from "@qorechain/pqc";
import { readFileSync } from "node:fs";
import { anchorSignBytesForBatch, QledgerLedger, qledgerEmptyRoot, type QledgerBatchPlan, type SettlementReceipt } from "@qorechain/rdk";
import { deriveUnifiedAccount, qorToEvm } from "@qorechain/sdk";
import { decodeFunctionData } from "viem";
import {
  anchoredBatchMessage,
  anchorOfReceipt,
  anchorSignature,
  auguryRegistry,
  bondSubmitterMessage,
  receiptVerifierArgs,
  recordReceiptCalldata,
  settlementReceiptsAbi,
} from "../src/index.ts";

// A well-known BIP-39 test mnemonic: never use it for anything real.
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const plan: QledgerBatchPlan = {
  input: {
    rollupId: "augury-oracle",
    batchIndex: 1n,
    prevStateRoot: qledgerEmptyRoot(),
    stateRoot: qledgerEmptyRoot(),
    txCount: 0n,
    dataHash: new Uint8Array(32).fill(9),
    withdrawalsRoot: new Uint8Array(0),
    inboxEnd: 42n,
  },
  entries: [],
  result: { stateRoot: qledgerEmptyRoot(), withdrawals: [], withdrawalsRoot: new Uint8Array(0) },
  ledger: new QledgerLedger(),
};

describe("settlement batches", () => {
  it("signs the anchor with the creator's ML-DSA-87 key over the chain's anchor bytes", async () => {
    const creator = await deriveUnifiedAccount(TEST_MNEMONIC);
    const signature = anchorSignature(plan, creator, "qorechain-diana");
    const bytes = anchorSignBytesForBatch({
      chainId: "qorechain-diana",
      layerId: "augury-oracle",
      batchIndex: 1n,
      stateRoot: qledgerEmptyRoot(),
      txCount: 0n,
    });
    assert.equal(mldsa87.verify(creator.pqc.publicKey, bytes, signature), true);
    // Bound to the chain: the same signature does not verify for mainnet's anchor bytes.
    const mainnet = anchorSignBytesForBatch({ chainId: "qorechain-vladi", layerId: "augury-oracle", batchIndex: 1n, stateRoot: qledgerEmptyRoot(), txCount: 0n });
    assert.equal(mldsa87.verify(creator.pqc.publicKey, mainnet, signature), false);
  });

  it("builds an anchored MsgSubmitBatch the Augury registry encodes", async () => {
    const creator = await deriveUnifiedAccount(TEST_MNEMONIC);
    const registry = auguryRegistry();
    const decoded = registry.decode(registry.encodeAsAny(anchoredBatchMessage(plan, creator, "qorechain-diana"))) as {
      sequencer: string;
      rollupId: string;
      anchorSignature: Uint8Array;
    };
    assert.equal(decoded.sequencer, creator.cosmos);
    assert.equal(decoded.rollupId, "augury-oracle");
    assert.equal(decoded.anchorSignature.length, 4627);
  });

  it("builds a submitter bond the Augury registry encodes", () => {
    const registry = auguryRegistry();
    const decoded = registry.decode(
      registry.encodeAsAny(bondSubmitterMessage("qor1yrnfky7jq8tp33ftr6qrh43jp3gsx7a6jy6stv", "augury-oracle", 1_000_000_000n)),
    ) as { amount: string | bigint };
    assert.equal(String(decoded.amount), "1000000000");
  });
});

describe("receipts in Solidity", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/receipt-cloister-dev-1-1.json", import.meta.url), "utf8"),
  ) as SettlementReceipt;

  it("maps a v2 receipt to the verifier's anchor fields", () => {
    const [anchor, creator, signature] = receiptVerifierArgs(fixture);
    assert.deepEqual(anchor, {
      chainId: "qorechain-diana",
      layerId: "cloister-dev-1",
      batchIndex: 1n,
      stateRoot: "0x0000000000000000000000000000000000000000000000000000000000000002",
      validatorSetHash: "0x",
      transactionCount: 1n,
      compressedStateProof: "0x",
    });
    assert.equal(creator.toLowerCase(), qorToEvm(fixture.creator).toLowerCase());
    assert.equal((signature.length - 2) / 2, 4627); // ML-DSA-87
  });

  it("refuses version-1 receipts, whose anchors bind no chain id", () => {
    assert.throws(() => anchorOfReceipt({ ...fixture, version: 1 }), /version-2/);
  });

  it("builds record calldata that decodes to the same arguments", () => {
    const { functionName, args } = decodeFunctionData({ abi: settlementReceiptsAbi, data: recordReceiptCalldata(fixture) });
    assert.equal(functionName, "record");
    assert.equal(args[0].layerId, "cloister-dev-1");
    assert.equal(args[0].batchIndex, 1n);
  });
});
