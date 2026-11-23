import { evmAddress, inboxPostMessage, NativeSender } from "@augury/chain";
import { buildReportPosts, observePrice, type FeedName } from "@augury/reporter";
import { FEEDS, type Hex } from "@augury/shared";
import type { UnifiedAccount } from "@qorechain/sdk";
import { planReporter } from "../plan.ts";
import { latestHeight, runLoop, type NodeContext } from "../runtime.ts";

export const REPORTABLE_FEEDS: readonly FeedName[] = ["fBTC/USD", "fETH/USD"];

export interface ReporterOptions {
  account: UnifiedAccount;
  feeds: FeedName[];
  marginBlocks: bigint;
  intervalMs: number;
  once: boolean;
}

/** A reporter: for each open round, observe the price, sign it, seal it and post it. */
export async function runReporter(ctx: NodeContext, opts: ReporterOptions): Promise<void> {
  const me = evmAddress(opts.account);
  const native = await NativeSender.connect(ctx.net, opts.account);
  const byId = new Map<string, FeedName>(opts.feeds.map((name) => [FEEDS[name].toLowerCase(), name]));
  const feedIds: Hex[] = opts.feeds.map((name) => FEEDS[name]);
  ctx.log(`reporter ${me} ready for ${opts.feeds.join(", ")}`);

  await runLoop(
    ctx,
    async () => {
      await ctx.inbox.refresh();
      const height = await latestHeight(ctx.net.rest);
      const rounds = planReporter({
        cfg: ctx.cfg,
        entries: ctx.inbox.entries,
        reporter: me,
        height,
        feeds: feedIds,
        marginBlocks: opts.marginBlocks,
      });

      for (const open of rounds) {
        const name = byId.get(open.feedId.toLowerCase())!;
        const observation = await observePrice(name);
        const posts = buildReportPosts({
          domain: ctx.cfg.domain,
          sealChainId: ctx.net.chainId,
          reporter: me,
          secretKey: opts.account.pqc.secretKey,
          open,
          price: observation.price,
          observedAt: BigInt(Math.floor(Date.now() / 1000)),
        });
        // Both posts in one transaction, so they sit next to each other in the inbox.
        const tx = await native.send(posts.map((p) => inboxPostMessage(native.address, ctx.deployment.rollupId, p)));
        ctx.log(`reported ${name} round ${open.round} from ${observation.used.join("+")} (tx ${tx.hash})`);
      }
    },
    opts,
  );
}
