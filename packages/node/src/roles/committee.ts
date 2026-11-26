import { evmAddress, fetchKemKeys, inboxPostMessage, NativeSender } from "@augury/chain";
import { acceptFirstValidDelivery, dealRound, releaseShare } from "@augury/committee";
import { bytesEqual, bytesToHex, hexToBytes, type Hex, type MemberIndex } from "@augury/shared";
import { deriveSealKeys } from "@qorechain/qoreseal";
import type { UnifiedAccount } from "@qorechain/sdk";
import { planCommittee, type CommitteeAction } from "../plan.ts";
import { FailureCounter, forEachSafely, latestHeight, runLoop, type NodeContext } from "../runtime.ts";

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
  // An action that keeps failing (say, no delivery for us opens) is given up after a few tries.
  const failures = new FailureCounter(3);
  const actionKey = (a: CommitteeAction) =>
    a.kind === "deal" ? `deal:${a.feedId}:${a.round}:${a.layer}` : `release:${a.open.feedId}:${a.open.round}:${a.open.layer ?? 0}`;
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

      // Each action on its own: one round that cannot be handled must not stall the others.
      const pending = actions.filter((a) => !failures.exhausted(actionKey(a)));
      await forEachSafely(pending, async (action) => {
        if (action.kind === "deal") {
          const deal = dealRound({
            sealChainId: ctx.net.chainId,
            feedId: action.feedId,
            round: action.round,
            closeHeight: action.closeHeight,
            // Two-dealer rounds: we deal one layer; the other member deals the other.
            layer: action.layer,
            layers: 2,
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
                layer: action.layer,
              }),
            ),
          ];
          const tx = await native.send(messages);
          ctx.log(
            `opened layer ${action.layer} of round ${action.round} of ${action.feedId.slice(0, 10)}…, closes at ${action.closeHeight} (tx ${tx.hash})`,
          );
        } else {
          const { open } = action;
          // Every delivery the round's dealer posted for us, in inbox order; the first valid one counts.
          const envelopes = ctx.inbox.entries.flatMap((e) =>
            e.post.kind === "delivery" &&
            e.post.member === member &&
            e.post.layer === open.layer &&
            e.post.feedId === open.feedId &&
            e.post.round === open.round &&
            e.poster === ctx.cfg.committee[open.dealer]
              ? [hexToBytes(e.post.envelope)]
              : [],
          );
          const share = acceptFirstValidDelivery({ sealChainId: ctx.net.chainId, member, keys: sealKeys, open }, envelopes);
          const tx = await native.send([inboxPostMessage(native.address, rollupId, releaseShare(open, share, height))]);
          ctx.log(`released layer ${open.layer ?? 0} share for round ${open.round} (tx ${tx.hash})`);
        }
      }, (action, err) => {
        const gaveUp = failures.fail(actionKey(action));
        ctx.log(`${actionKey(action)} failed${gaveUp ? ", giving up" : ""}: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    opts,
  );
}
