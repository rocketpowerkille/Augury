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
  unbondRollupSubmitterMsg,
  verifySettlementReceipt,
  type QledgerBatchPlan,
  type ReceiptVerification,
  type SettlementReceipt,
} from "@qorechain/rdk";
import type { UnifiedAccount } from "@qorechain/sdk";
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

/** Withdraw `submitter`'s whole bond, a full challenge window after its last batch. */
export function unbondSubmitterMessage(submitter: string, rollupId: string): NativeMessage {
  return unbondRollupSubmitterMsg({ submitter, rollupId });
}

/** The settlement receipt of an anchored batch, built from chain state. */
export async function settlementReceipt(rollupId: string, batchIndex: number): Promise<SettlementReceipt> {
  return buildSettlementReceipt(createRdkClient({ network: "testnet" }), rollupId, batchIndex);
}

/** Re-verify a receipt against live chain state: every field is re-read from the node. */
export async function verifyReceipt(receipt: SettlementReceipt): Promise<ReceiptVerification> {
  return verifySettlementReceipt(receipt, { client: createRdkClient({ network: "testnet" }) });
}
