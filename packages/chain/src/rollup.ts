import { createRollupMsg, rollupIdError } from "@qorechain/rdk";
import { msg } from "@qorechain/sdk";
import type { NativeMessage } from "./native.ts";

/**
 * `MsgRegisterSidechain` for a rollup's layer in x/multilayer, where settlement anchors live.
 * `MsgCreateRollup` normally registers this layer itself (event `sidechain_registered`), but
 * for Augury's rollup (profile `custom`, vm `custom`) it did not, and anchoring then fails
 * with "layer not found". The fields copy what the chain registers on its own for other
 * rollups (e.g. `ledgerpump`).
 */
export function registerLayerMessage(creator: string, rollupId: string, profile: string): NativeMessage {
  return msg.multilayer.registerSidechain({
    creator,
    layerId: rollupId,
    description: `RDK rollup: ${rollupId} (${profile})`,
    targetBlockTimeMs: "1000",
    maxTransactionsPerBlock: "10000",
    minValidators: 1,
    settlementIntervalBlocks: "100",
    supportedVmTypes: [],
    supportedDomains: [],
  });
}

/** The chain's minimum stake to create a rollup (live `min_stake_for_rollup`, 10,000 QOR). */
export const MIN_ROLLUP_STAKE_UQOR = 10_000_000_000n;

/**
 * `MsgCreateRollup` for Augury's rollup. Every new optimistic rollup on QoreChain uses based
 * sequencing and `qledger-v1` execution: the chain orders the inbox, and Augury's own rules
 * are enforced by AuguryHub's fraud proof. 1% of the stake is burned at creation.
 */
export function createRollupMessage(creator: string, rollupId: string, stakeUqor: bigint): NativeMessage {
  const idError = rollupIdError(rollupId);
  if (idError) throw new Error(`rollup id ${rollupId}: ${idError}`);
  if (stakeUqor < MIN_ROLLUP_STAKE_UQOR) throw new Error(`stake must be at least ${MIN_ROLLUP_STAKE_UQOR} uqor`);
  return createRollupMsg({
    creator,
    rollupId,
    profile: "custom",
    vmType: "custom",
    stakeAmount: stakeUqor.toString(),
    sequencing: "based",
    executionVm: "qledger-v1",
  });
}
