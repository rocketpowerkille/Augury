import { bytesToHex, type ChainView, type Hex, type SignedReport } from "@augury/shared";
import { evmWindowCost, evmWindowStatus, openEvmWindowMessage, pqcKeyStatus } from "@qorechain/evm";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { UnifiedAccount } from "@qorechain/sdk";
import { auguryHubAbi } from "./abi/auguryHub.ts";
import type { NativeSender } from "./native.ts";
import type { Network } from "./network.ts";

/** AuguryHub's SignedReport tuple. */
function reportTuple(r: SignedReport) {
  return { reporter: r.reporter, price: r.price, observedAt: r.observedAt, signature: bytesToHex(r.signature) };
}

// ------------------------------------------------------------------------------------------
// Calldata
// ------------------------------------------------------------------------------------------

export function postBatchCalldata(b: {
  header: { feedId: Hex; round: bigint; price: bigint };
  reports: readonly SignedReport[];
  signature: Uint8Array;
}): Hex {
  return encodeFunctionData({
    abi: auguryHubAbi,
    functionName: "postBatch",
    args: [b.header.feedId, b.header.round, b.header.price, b.reports.map(reportTuple), bytesToHex(b.signature)],
  });
}

export function challengeBatchCalldata(feedId: Hex, round: bigint, reports: readonly SignedReport[], rewardTo: Hex): Hex {
  return encodeFunctionData({
    abi: auguryHubAbi,
    functionName: "challengeBatch",
    args: [feedId, round, reports.map(reportTuple), rewardTo],
  });
}

export function reportEquivocationCalldata(
  feedId: Hex,
  round: bigint,
  a: SignedReport,
  b: SignedReport,
  rewardTo: Hex,
): Hex {
  return encodeFunctionData({
    abi: auguryHubAbi,
    functionName: "reportEquivocation",
    args: [feedId, round, reportTuple(a), reportTuple(b), rewardTo],
  });
}

export function stakeCalldata(reporter: Hex): Hex {
  return encodeFunctionData({ abi: auguryHubAbi, functionName: "stake", args: [reporter] });
}

export function bondSequencerCalldata(): Hex {
  return encodeFunctionData({ abi: auguryHubAbi, functionName: "bondSequencer", args: [] });
}

// ------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------

/** viem chain for `net`. QOR has 18 decimals on the EVM lane (1 uqor = 10^12 wei). */
export function evmChain(net: Network): Chain {
  return defineChain({
    id: Number(net.evmChainId),
    name: `QoreChain ${net.chainId}`,
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [net.evmRpc] } },
  });
}

export function publicClient(net: Network): PublicClient {
  return createPublicClient({ chain: evmChain(net), transport: http(net.evmRpc) });
}

/**
 * A snapshot of what the round processor needs to know about `accounts`: each one's
 * registered ML-DSA-87 key and whether it is an active reporter. `ChainView` is synchronous,
 * so the reads happen here, up front.
 */
export async function loadChainView(
  client: PublicClient,
  hub: Hex,
  accounts: readonly Hex[],
  mldsaAlgorithmId: number,
): Promise<ChainView> {
  const keys = new Map<string, Uint8Array>();
  const active = new Set<string>();
  const minStake = await client.readContract({ address: hub, abi: auguryHubAbi, functionName: "minReporterStake" });

  await Promise.all(
    accounts.map(async (account) => {
      const id = account.toLowerCase();
      const status = await pqcKeyStatus(client, account);
      if (status.registered && status.algorithmId === mldsaAlgorithmId) {
        keys.set(id, Uint8Array.from(Buffer.from(status.pubkey.slice(2), "hex")));
      }
      const [stake, exitRequestedAt] = await client.readContract({
        address: hub,
        abi: auguryHubAbi,
        functionName: "reporters",
        args: [account],
      });
      if (stake >= minStake && exitRequestedAt === 0n) active.add(id);
    }),
  );

  return {
    reporterKey: (a) => keys.get(a.toLowerCase()),
    isActive: (a) => active.has(a.toLowerCase()),
  };
}

// ------------------------------------------------------------------------------------------
// Writes through a scoped EVM window
// ------------------------------------------------------------------------------------------

/** How a window is sized when one has to be opened. */
export interface WindowPolicy {
  blocks: bigint;
  maxTxs: bigint;
  /** Gas limit assumed per transaction when bounding the window's value. */
  gasPerTx: bigint;
}

export const DEFAULT_WINDOW: WindowPolicy = { blocks: 600n, maxTxs: 10n, gasPerTx: 6_000_000n };

/**
 * Sends EVM transactions to AuguryHub from a unified account. QoreChain admits an EVM
 * transaction only inside an authorisation window opened by a hybrid-signed native message;
 * every window this sender opens is scoped to the hub address alone, so the account's
 * classical key cannot reach any other contract through it.
 */
export class HubSender {
  private readonly net: Network;
  private readonly hub: Hex;
  private readonly native: NativeSender;
  private readonly client: PublicClient;
  private readonly wallet;
  private readonly policy: WindowPolicy;

  constructor(opts: {
    net: Network;
    hub: Hex;
    account: UnifiedAccount;
    native: NativeSender;
    policy?: WindowPolicy;
  }) {
    this.net = opts.net;
    this.hub = opts.hub;
    this.native = opts.native;
    this.client = publicClient(opts.net);
    this.wallet = createWalletClient({
      account: privateKeyToAccount(opts.account.privateKey as Hex),
      chain: evmChain(opts.net),
      transport: http(opts.net.evmRpc),
    });
    this.policy = opts.policy ?? DEFAULT_WINDOW;
  }

  /** Open a hub-scoped window unless a live one can still pay for `costUqor`. */
  private async ensureWindow(costUqor: bigint): Promise<void> {
    const w = await evmWindowStatus({ rest: this.net.rest, address: this.native.address });
    if (w.found && w.live && w.remainingTxs >= 1n && w.remainingValue >= costUqor) return;
    const fees = await this.client.estimateFeesPerGas();
    const perTx = evmWindowCost({ gas: this.policy.gasPerTx, maxFeePerGas: fees.maxFeePerGas });
    const msg = openEvmWindowMessage({
      sender: this.native.address,
      blocks: this.policy.blocks,
      maxTxs: this.policy.maxTxs,
      maxValue: (perTx * this.policy.maxTxs + costUqor).toString(),
      allowedTargets: [this.hub],
    });
    await this.native.send([msg], 300_000n, "augury: open hub-scoped EVM window");
  }

  /** Send `data` (and `value` wei) to the hub; resolves once the receipt is in. */
  async send(data: Hex, value = 0n): Promise<{ hash: Hex; status: "success" | "reverted" }> {
    const gas = await this.client.estimateGas({ account: this.wallet.account, to: this.hub, data, value });
    const fees = await this.client.estimateFeesPerGas();
    await this.ensureWindow(evmWindowCost({ value, gas, maxFeePerGas: fees.maxFeePerGas }));
    // Opening a window advances the nonce, so read it only now.
    const nonce = await this.client.getTransactionCount({ address: this.wallet.account.address, blockTag: "pending" });
    const hash = await this.wallet.sendTransaction({
      to: this.hub,
      data,
      value,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status };
  }
}
