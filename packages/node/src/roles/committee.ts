import { evmAddress, fetchKemKeys, inboxPostMessage, NativeSender } from "@augury/chain";
import { acceptDelivery, dealRound, releaseShare } from "@augury/committee";
import { bytesEqual, bytesToHex, hexToBytes, type Hex, type MemberIndex } from "@augury/shared";
import { deriveSealKeys } from "@qorechain/qoreseal";
import type { UnifiedAccount } from "@qorechain/sdk";
import { planCommittee } from "../plan.ts";
import { latestHeight, runLoop, type NodeContext } from "../runtime.ts";

export interface CommitteeOptions {
  account: UnifiedAccount;
  feeds: Hex[];
  roundBlocks: bigint;
  intervalMs: number;
  once: boolean;
}

/** A key committee member: deals its rounds and releases its shares after each close. */
export async function runCommittee(ctx: NodeContext, opts: CommitteeOptions): Promise<void> {
  const me = evmAddress(opts.account);
  const index = ctx.deployment.committee.indexOf(me);
  if (index < 0) throw new Error(`${me} is not on this deployment's committee`);
  const member = index as MemberIndex;
  if (!opts.account.mnemonic) throw new Error("committee accounts must come from a mnemonic");
  const sealKeys = deriveSealKeys({ mnemonic: opts.account.mnemonic });

  // Every member must have published its ML-KEM key; ours must match the one we hold.
  const memberKeys = await fetchKemKeys(ctx.net.rest, ctx.deployment.committee);
  if (!bytesEqual(memberKeys[member]!, sealKeys.mlkemPublicKey)) {
    throw new Error("the ML-KEM key registered for this account is not the one derived from its mnemonic");
  }
  const native = await NativeSender.connect(ctx.net, opts.account);
  const rollupId = ctx.deployment.rollupId;
  ctx.log(`member ${member} (${me}) ready`);

  await runLoop(
    ctx,
    async () => {
      await ctx.inbox.refresh();
      const height = await latestHeight(ctx.net.rest);
      const actions = planCommittee({
        cfg: ctx.cfg,
        entries: ctx.inbox.entries,
        member,
        height,
        feeds: opts.feeds,
        roundBlocks: opts.roundBlocks,
      });

      for (const action of actions) {
        if (action.kind === "deal") {
          const deal = dealRound({
            sealChainId: ctx.net.chainId,
            feedId: action.feedId,
            round: action.round,
            closeHeight: action.closeHeight,
            members: [
              { mlkemPublicKey: memberKeys[0]! },
              { mlkemPublicKey: memberKeys[1]! },
              { mlkemPublicKey: memberKeys[2]! },
            ],
          });
          const messages = [
            inboxPostMessage(native.address, rollupId, deal.open),
            ...deal.deliveries.map((d) =>
              inboxPostMessage(native.address, rollupId, {
                kind: "delivery",
                feedId: action.feedId,
                round: action.round,
                member: d.member,
                envelope: bytesToHex(d.envelope),
              }),
            ),
          ];
          const tx = await native.send(messages);
          ctx.log(`opened round ${action.round} of ${action.feedId.slice(0, 10)}…, closes at ${action.closeHeight} (tx ${tx.hash})`);
        } else {
          const { open } = action;
          const delivery = ctx.inbox.entries.find(
            (e) =>
              e.post.kind === "delivery" &&
              e.post.member === member &&
              e.post.feedId === open.feedId &&
              e.post.round === open.round &&
              e.poster === ctx.cfg.committee[open.dealer],
          );
          if (!delivery || delivery.post.kind !== "delivery") continue;
          const share = acceptDelivery({
            sealChainId: ctx.net.chainId,
            member,
            keys: sealKeys,
            open,
            envelope: hexToBytes(delivery.post.envelope),
          });
          const tx = await native.send([inboxPostMessage(native.address, rollupId, releaseShare(open, share, height))]);
          ctx.log(`released share for round ${open.round} (tx ${tx.hash})`);
        }
      }
    },
    opts,
  );
}
