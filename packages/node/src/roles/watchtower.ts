import {
  batchPostedAt,
  challengeBatchCalldata,
  evmAddress,
  HubSender,
  loadChainView,
  NativeSender,
  postedBatches,
  reportEquivocationCalldata,
  type PostedBatchOnChain,
} from "@augury/chain";
import type { Hex } from "@augury/shared";
import { auditBatch } from "@augury/watchtower";
import type { UnifiedAccount } from "@qorechain/sdk";
import { runLoop, type NodeContext } from "../runtime.ts";

export interface WatchtowerOptions {
  account: UnifiedAccount;
  /** EVM block to start watching from. */
  fromBlock: bigint;
  intervalMs: number;
  once: boolean;
}

/** A batch whose audit keeps failing is given up on after this many attempts. */
const MAX_ATTEMPTS = 3;

/**
 * The watchtower: re-checks every batch posted to AuguryHub against the inbox, proves fraud
 * on chain, slashes equivocating reporters and logs what cannot be proven yet.
 */
export async function runWatchtower(ctx: NodeContext, opts: WatchtowerOptions): Promise<void> {
  const me = evmAddress(opts.account);
  const native = await NativeSender.connect(ctx.net, opts.account);
  const hub = new HubSender({ net: ctx.net, hub: ctx.deployment.hub, account: opts.account, native });
  const audited = new Set<string>();
  const attempts = new Map<string, number>();
  const reportedEquivocations = new Set<string>();
  ctx.log(`watchtower ${me} watching from block ${opts.fromBlock}`);

  async function audit(batch: PostedBatchOnChain): Promise<void> {
    const { feedId, round } = batch.header;
    const accounts: Hex[] = [
      ...new Set([
        ...batch.reports.map((r) => r.reporter),
        ...ctx.inbox.entries
          .filter((e) => e.post.kind === "report" && e.post.feedId === feedId && e.post.round === round)
          .map((e) => e.poster),
      ]),
    ];
    // Judge activity when the batch was posted, as the hub's fraud proof does.
    const postedAt = await batchPostedAt(ctx.evm, ctx.deployment.hub, feedId, round);
    const view = await loadChainView(ctx.evm, ctx.deployment.hub, accounts, postedAt);
    const findings = auditBatch(ctx.cfg, view, ctx.inbox.entries, { header: batch.header, reports: batch.reports });

    if (findings.length === 0) ctx.log(`round ${round}: batch ${batch.txHash} checks out`);
    for (const f of findings) {
      if (f.kind === "challenge") {
        const tx = await hub.send(challengeBatchCalldata(feedId, round, f.reports, me));
        ctx.log(`round ${round}: ${f.fraud}, challenged (tx ${tx.hash}, ${tx.status})`);
      } else if (f.kind === "equivocation") {
        const id = `${f.evidence.first.reporter}:${feedId}:${round}`;
        if (reportedEquivocations.has(id)) continue;
        const tx = await hub.send(reportEquivocationCalldata(feedId, round, f.evidence.first, f.evidence.second, me));
        reportedEquivocations.add(id);
        ctx.log(`round ${round}: ${f.evidence.first.reporter} equivocated, reported (tx ${tx.hash}, ${tx.status})`);
      } else {
        const detail = JSON.stringify(f, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
        ctx.log(`round ${round}: ALERT ${f.kind} ${detail}`);
      }
    }
  }

  await runLoop(
    ctx,
    async () => {
      await ctx.inbox.refresh();
      for (const batch of await postedBatches(ctx.evm, ctx.deployment.hub, opts.fromBlock)) {
        if (audited.has(batch.txHash)) continue;
        try {
          await audit(batch);
          audited.add(batch.txHash);
        } catch (err) {
          const n = (attempts.get(batch.txHash) ?? 0) + 1;
          attempts.set(batch.txHash, n);
          ctx.log(`batch ${batch.txHash}: attempt ${n} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (n >= MAX_ATTEMPTS) audited.add(batch.txHash);
        }
      }
    },
    opts,
  );
}
