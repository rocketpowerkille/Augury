import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SettlementReceipt } from "@qorechain/rdk";
import { qorToEvm as sdkQorToEvm } from "@qorechain/sdk";
import { encodeFunctionData, toFunctionSelector } from "viem";
import { receiptVerifierArgs, settlementReceiptsAbi } from "../src/index.ts";

// The browser verifier (web/verify-receipt/verify.js) is plain JavaScript with no
// dependencies; these tests hold it to viem's encoder and the SDK's address decoding.
const web = (await import(new URL("../../../web/verify-receipt/verify.js", import.meta.url).href)) as {
  VERIFY_ANCHOR_SELECTOR: string;
  qorToEvm(address: string): string;
  verifyAnchorCalldata(receipt: SettlementReceipt): string;
};
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/receipt-cloister-dev-1-1.json", import.meta.url), "utf8"),
) as SettlementReceipt;

describe("browser receipt verifier", () => {
  it("uses the selector of SettlementReceipts.verifyAnchor", () => {
    const item = settlementReceiptsAbi.find((x) => x.type === "function" && x.name === "verifyAnchor")!;
    assert.equal(`0x${web.VERIFY_ANCHOR_SELECTOR}`, toFunctionSelector(item as Parameters<typeof toFunctionSelector>[0]));
  });

  it("encodes the same calldata as viem for a real receipt", () => {
    const expected = encodeFunctionData({ abi: settlementReceiptsAbi, functionName: "verifyAnchor", args: receiptVerifierArgs(fixture) });
    assert.equal(web.verifyAnchorCalldata(fixture), expected.toLowerCase());
  });

  it("encodes the same calldata as viem with every dynamic field non-empty", () => {
    const r = { ...fixture, validatorSetHash: "ab".repeat(40), compressedStateProof: "cd".repeat(3), layerId: "a-much-longer-layer-id-over-thirty-two-bytes" };
    const expected = encodeFunctionData({ abi: settlementReceiptsAbi, functionName: "verifyAnchor", args: receiptVerifierArgs(r) });
    assert.equal(web.verifyAnchorCalldata(r), expected.toLowerCase());
  });

  it("decodes qor1 addresses like the SDK and rejects a bad checksum", () => {
    assert.equal(web.qorToEvm(fixture.creator), sdkQorToEvm(fixture.creator).toLowerCase());
    const broken = fixture.creator.slice(0, -1) + (fixture.creator.endsWith("q") ? "p" : "q");
    assert.throws(() => web.qorToEvm(broken), /checksum/);
  });

  it("refuses version-1 receipts", () => {
    assert.throws(() => web.verifyAnchorCalldata({ ...fixture, version: 1 }), /version-2/);
  });
});
