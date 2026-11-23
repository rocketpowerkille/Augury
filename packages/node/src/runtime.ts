import {
  InboxReader,
  loadDeployment,
  publicClient,
  roundConfig,
  testnet,
  type Deployment,
  type Network,
} from "@augury/chain";
import type { InboxEntry, RoundConfig } from "@augury/shared";

export type EvmClient = ReturnType<typeof publicClient>;

/** Everything a role needs to read the chain. */
export interface NodeContext {
  net: Network;
  deployment: Deployment;
  cfg: RoundConfig;
  inbox: InboxCache;
  evm: EvmClient;
  log: (message: string) => void;
}

/** The rollup inbox, read incrementally and verified by the chain adapter. */
export class InboxCache {
  readonly entries: InboxEntry[] = [];
  private cursor = 0n;
  private readonly reader: InboxReader;

  constructor(reader: InboxReader) {
    this.reader = reader;
  }

  /** Read every post since the last refresh. */
  async refresh(): Promise<InboxEntry[]> {
    const head = await this.reader.head();
    if (head <= this.cursor) return [];
    const fresh = await this.reader.read(this.cursor, head);
    this.entries.push(...fresh);
    this.cursor = head;
    return fresh;
  }
}

/** Latest native block height, from `/cosmos/base/tendermint/v1beta1/blocks/latest`. */
export async function latestHeight(rest: string): Promise<bigint> {
  const res = await fetch(`${rest}/cosmos/base/tendermint/v1beta1/blocks/latest`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`latest block: ${res.status}`);
  const body = (await res.json()) as { block?: { header?: { height?: string } } };
  const height = body.block?.header?.height;
  if (!height) throw new Error("latest block has no height");
  return BigInt(height);
}

export function createContext(deploymentPath: string, role: string): NodeContext {
  const net = testnet();
  const deployment = loadDeployment(deploymentPath);
  return {
    net,
    deployment,
    cfg: roundConfig(net, deployment),
    inbox: new InboxCache(new InboxReader({ rest: net.rest, chainId: net.chainId, rollupId: deployment.rollupId })),
    evm: publicClient(net),
    log: (message) => console.log(`${new Date().toISOString()} [${role}] ${message}`),
  };
}

/**
 * Run `tick` every `intervalMs` until the process is stopped. A failing tick is logged and
 * retried on the next one; with `once`, the first tick runs alone and its error is thrown.
 */
export async function runLoop(
  ctx: NodeContext,
  tick: () => Promise<void>,
  opts: { intervalMs: number; once: boolean },
): Promise<void> {
  if (opts.once) return tick();
  for (;;) {
    try {
      await tick();
    } catch (err) {
      ctx.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}
