import {
  evmAddress,
  HubSender,
  latestRounds,
  loadChainView,
  NativeSender,
  postBatchCalldata,
} from "@augury/chain";
import { buildBatch } from "@augury/sequencer";
import { ML_DSA_87_ALGORITHM_ID, type Hex } from "@augury/shared";
import type { UnifiedAccount } from "@qorechain/sdk";
import { planSequencer, roundKey } from "../plan.ts";
import { latestHeight, runLoop, type NodeContext } from "../runtime.ts";

export interface SequencerOptions {
  account: UnifiedAccount;
  feeds: Hex[];
  intervalMs: number;
  once: boolean;
}

/** The sequencer: turns each closed round into a signed batch on AuguryHub, in round order. */
export async function runSequencer(ctx: NodeContext, opts: SequencerOptions): Promise<void> {
  const me = evmAddress(opts.account);
  if (me !== ctx.deployment.sequencer) throw new Error(`${me} is not this deployment's sequencer`);
  const native = await NativeSender.connect(ctx.net, opts.account);
  const hub = new HubSender({ net: ctx.net, hub: ctx.deployment.hub, account: opts.account, native });
  const skipped = new Set<string>();
  ctx.log(`sequencer ${me} ready`);

  await runLoop(
    ctx,
    async () => {
      await ctx.inbox.refresh();
      const height = await latestHeight(ctx.net.rest);
      const settled = await latestRounds(ctx.evm, ctx.deployment.hub, opts.feeds);
      const rounds = planSequencer({ cfg: ctx.cfg, entries: ctx.inbox.entries, height, settled, skipped });
      const blockedFeeds = new Set<string>();

      for (const { feedId, round } of rounds) {
        if (blockedFeeds.has(feedId.toLowerCase())) continue;
        const reporters = [
          ...new Set(
            ctx.inbox.entries
              .filter((e) => e.post.kind === "report" && e.post.feedId === feedId && e.post.round === round)
              .map((e) => e.poster),
          ),
        ];
        const view = await loadChainView(ctx.evm, ctx.deployment.hub, reporters, ML_DSA_87_ALGORITHM_ID);
        const { outcome, batch } = buildBatch(ctx.cfg, view, ctx.inbox.entries, feedId, round, opts.account.pqc.secretKey);

        if (batch) {
          const tx = await hub.send(postBatchCalldata(batch));
          ctx.log(`posted round ${round}: ${batch.header.reportCount} reports, median ${batch.header.price} (tx ${tx.hash}, ${tx.status})`);
        } else if (outcome.status === "awaiting-shares") {
          // Rounds must reach the hub in order: wait for this one before any later round.
          blockedFeeds.add(feedId.toLowerCase());
        } else {
          skipped.add(roundKey(feedId, round));
          ctx.log(`skipping round ${round}: ${outcome.status}`);
        }
      }
    },
    opts,
  );
}
