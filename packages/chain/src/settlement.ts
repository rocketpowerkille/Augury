import { mldsa87 } from "@qorechain/pqc";
import {
  anchorSignBytesForBatch,
  bondRollupSubmitterMsg,
  buildSettlementReceipt,
  createRdkClient,
  EMPTY_INBOX_ACC,
  executeQledger,
  fetchQledgerEntries,
  planQledgerBatch,
  QledgerLedger,
  RestClient,
  submitBatchMsg,
  verifySettlementReceipt,
  type QledgerBatchPlan,
  type ReceiptVerification,
  type SettlementReceipt,
} from "@qorechain/rdk";
import { qorToEvm, type UnifiedAccount } from "@qorechain/sdk";
import { decodeFunctionResult, encodeDeployData, encodeFunctionData, type PublicClient } from "viem";
import type { Hex } from "@augury/shared";
import { settlementReceiptsAbi, settlementReceiptsBytecode } from "./abi/settlementReceipts.ts";
import type { NativeMessage } from "./native.ts";

/**
 * Settling the rollup on QoreChain. Augury's rollup is a based qledger-v1 rollup: each
 * settlement batch consumes a range of the inbox, and the chain anchors it in x/multilayer
 * only when it carries the rollup creator's ML-DSA-87 signature over the batch. An anchored
 * batch yields a settlement receipt anyone can verify against live chain state.
 *
 * Augury's posts are not qledger transactions, so executing them leaves the ledger as it
 * was; the ledger is still rebuilt by replaying the inbox, which keeps this correct if
 * anyone deposits into the rollup.
 */

/** The qledger state after the first `consumed` inbox entries, rebuilt from the chain. */
export async function ledgerAfter(rest: RestClient, chainId: string, rollupId: string, consumed: bigint): Promise<QledgerLedger> {
  const ledger = new QledgerLedger();
  if (consumed === 0n) return ledger;
  const entries = await fetchQledgerEntries(rest, { chainId, rollupId, from: 0n, to: consumed, accFrom: EMPTY_INBOX_ACC });
  executeQledger({ chainId, rollupId }, ledger, entries);
  return ledger;
}

/** Plan the next settlement batch for `submitter` (`qor1…`), which must be bonded. */
export async function planSettlement(rest: RestClient, opts: { chainId: string; rollupId: string; submitter: string }): Promise<QledgerBatchPlan> {
  const inbox = await rest.getInbox(opts.rollupId);
  const ledger = await ledgerAfter(rest, opts.chainId, opts.rollupId, BigInt(inbox.consumedSequence));
  return planQledgerBatch(rest, { ...opts, ledger });
}

/**
 * The rollup creator's ML-DSA-87 signature over the batch's anchor sign bytes. A rollup
 * registers its layer under its own id, so the layer id is the rollup id.
 */
export function anchorSignature(plan: QledgerBatchPlan, creator: UnifiedAccount, chainId: string): Uint8Array {
  const bytes = anchorSignBytesForBatch({
    chainId,
    layerId: plan.input.rollupId,
    batchIndex: plan.input.batchIndex,
    stateRoot: plan.input.stateRoot,
    txCount: plan.input.txCount,
  });
  return mldsa87.sign(creator.pqc.secretKey, bytes);
}

/** `MsgSubmitBatch` for `plan`, anchored with the creator's signature. */
export function anchoredBatchMessage(plan: QledgerBatchPlan, creator: UnifiedAccount, chainId: string): NativeMessage {
  return submitBatchMsg({ sequencer: creator.cosmos, ...plan.input, anchorSignature: anchorSignature(plan, creator, chainId) });
}

/** Add `amountUqor` to `submitter`'s bond (the chain requires at least 1,000 QOR to submit). */
export function bondSubmitterMessage(submitter: string, rollupId: string, amountUqor: bigint): NativeMessage {
  return bondRollupSubmitterMsg({ submitter, rollupId, amount: amountUqor.toString() });
}

/** The settlement receipt of an anchored batch, built from chain state. */
export async function settlementReceipt(rollupId: string, batchIndex: number): Promise<SettlementReceipt> {
  return buildSettlementReceipt(createRdkClient({ network: "testnet" }), rollupId, batchIndex);
}

/** Re-verify a receipt against live chain state: every field is re-read from the node. */
export async function verifyReceipt(receipt: SettlementReceipt): Promise<ReceiptVerification> {
  return verifySettlementReceipt(receipt, { client: createRdkClient({ network: "testnet" }) });
}

// ------------------------------------------------------------------------------------------
// Verification in Solidity (contracts/src/SettlementReceipts.sol)
// ------------------------------------------------------------------------------------------

/** The anchor fields of a receipt, as SettlementReceipts takes them. Only v2 receipts carry them all. */
export function anchorOfReceipt(r: SettlementReceipt): {
  chainId: string;
  layerId: string;
  batchIndex: bigint;
  stateRoot: Hex;
  validatorSetHash: Hex;
  transactionCount: bigint;
  compressedStateProof: Hex;
} {
  if (r.version !== 2 || !r.chainId || r.transactionCount === undefined) {
    throw new Error("only version-2 receipts can be verified in Solidity (v1 anchors carry no chain id)");
  }
  const hex = (s: string | undefined): Hex => `0x${(s ?? "").replace(/^0x/, "")}`;
  return {
    chainId: r.chainId,
    layerId: r.layerId,
    batchIndex: BigInt(r.batchIndex),
    stateRoot: hex(r.stateRoot),
    validatorSetHash: hex(r.validatorSetHash),
    transactionCount: BigInt(r.transactionCount),
    compressedStateProof: hex(r.compressedStateProof),
  };
}

/** Arguments for `SettlementReceipts.verifyAnchor` and `record`: the anchor, the creator's EVM address, the signature. */
export function receiptVerifierArgs(r: SettlementReceipt) {
  return [anchorOfReceipt(r), qorToEvm(r.creator) as Hex, `0x${r.pqcSignature.replace(/^0x/, "")}` as Hex] as const;
}

/**
 * Check a receipt's anchor signature with SettlementReceipts against live chain keys and the
 * real pqcVerify precompile. With `verifier`, calls the deployed contract; without it, runs the
 * contract's code in a deployless `eth_call`, so nothing is deployed or sent.
 */
export async function verifyReceiptOnEvm(client: PublicClient, r: SettlementReceipt, verifier?: Hex): Promise<boolean> {
  const data = encodeFunctionData({ abi: settlementReceiptsAbi, functionName: "verifyAnchor", args: receiptVerifierArgs(r) });
  const result = verifier
    ? await client.call({ to: verifier, data })
    : await client.call({ code: settlementReceiptsDeployless(), data });
  if (!result.data) return false;
  return decodeFunctionResult({ abi: settlementReceiptsAbi, functionName: "verifyAnchor", data: result.data });
}

/** Creation code of SettlementReceipts for ML-DSA-87 (algorithm id 1), for deployless calls. */
function settlementReceiptsDeployless(): Hex {
  return encodeDeployData({ abi: settlementReceiptsAbi, bytecode: settlementReceiptsBytecode, args: [1] });
}

/** Calldata for `SettlementReceipts.record`. */
export function recordReceiptCalldata(r: SettlementReceipt): Hex {
  return encodeFunctionData({ abi: settlementReceiptsAbi, functionName: "record", args: receiptVerifierArgs(r) });
}
