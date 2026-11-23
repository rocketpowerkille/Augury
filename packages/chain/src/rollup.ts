import { createRollupMsg, rollupIdError } from "@qorechain/rdk";
import type { NativeMessage } from "./native.ts";

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
