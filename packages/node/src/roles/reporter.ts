import { evmAddress, inboxPostMessage, NativeSender } from "@augury/chain";
import { buildReportPosts, observePrice, type FeedName } from "@augury/reporter";
import { FEEDS, type Hex } from "@augury/shared";
import type { UnifiedAccount } from "@qorechain/sdk";
import { planReporter } from "../plan.ts";
import { join } from "node:path";
import { ReportBook } from "../reportbook.ts";
import { forEachSafely, latestHeight, runLoop, type NodeContext } from "../runtime.ts";

export const REPORTABLE_FEEDS: readonly FeedName[] = ["fBTC/USD", "fETH/USD"];

export interface ReporterOptions {
  account: UnifiedAccount;
  feeds: FeedName[];
  marginBlocks: bigint;
  intervalMs: number;
  once: boolean;
  /** Folder where the reporter keeps the reports it signed, so a restart resends them. */
  stateDir: string;
}

/** A reporter: for each open round, observe the price, sign it, seal it and post it. */
export async function runReporter(ctx: NodeContext, opts: ReporterOptions): Promise<void> {
  const me = evmAddress(opts.account);
  const native = await NativeSender.connect(ctx.net, opts.account);
  const byId = new Map<string, FeedName>(opts.feeds.map((name) => [FEEDS[name].toLowerCase(), name]));
  const feedIds: Hex[] = opts.feeds.map((name) => FEEDS[name]);
  // One signed report per round, resent unchanged on retry (signing again would equivocate).
  const book = new ReportBook(join(opts.stateDir, `reports-${ctx.deployment.hub.toLowerCase()}-${me.toLowerCase()}.json`));
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

      // Each feed on its own: one feed's sources being down must not stop the others.
      await forEachSafely(rounds, async ({ open, outer }) => {
        const name = byId.get(open.feedId.toLowerCase())!;
        book.forgetBefore(open.feedId, open.round);
        let sources = "an earlier signing (resent)";
        let observation: Awaited<ReturnType<typeof observePrice>> | undefined;
        if (!book.has(open.feedId, open.round)) {
          observation = await observePrice(name);
          sources = observation.used.join("+");
        }
        const posts = book.postsFor(open.feedId, open.round, () =>
          buildReportPosts({
            domain: ctx.cfg.domain,
            sealChainId: ctx.net.chainId,
            reporter: me,
            secretKey: opts.account.pqc.secretKey,
            open,
            ...(outer ? { outer } : {}),
            price: observation!.price,
            observedAt: BigInt(Math.floor(Date.now() / 1000)),
          }),
        );
        // Both posts in one transaction, so they sit next to each other in the inbox.
        const tx = await native.send(posts.map((p) => inboxPostMessage(native.address, ctx.deployment.rollupId, p)));
        ctx.log(`reported ${name} round ${open.round} from ${sources} (tx ${tx.hash})`);
      }, ({ open }, err) => ctx.log(`round ${open.round} of ${byId.get(open.feedId.toLowerCase())}: ${err instanceof Error ? err.message : String(err)}`));
    },
    opts,
  );
}
