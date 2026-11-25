import { bytesToHex, hexToBytes, type ChainView, type Hex, type SignedReport } from "@augury/shared";
import { evmWindowCost, evmWindowStatus, openEvmWindowMessage } from "@qorechain/evm";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { UnifiedAccount } from "@qorechain/sdk";
import { auguryHubAbi, auguryHubBytecode } from "./abi/auguryHub.ts";
import type { NativeSender } from "./native.ts";
import type { Network } from "./network.ts";

/** AuguryHub's SignedReport tuple. */
function reportTuple(r: SignedReport) {
  return {
    reporter: r.reporter,
    price: r.price,
    observedAt: r.observedAt,
    salt: r.salt,
    signature: bytesToHex(r.signature),
  };
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
 * A snapshot of what the round processor needs to know about `accounts`: the ML-DSA-87 key
 * AuguryHub pinned for each one when it staked, and whether it is an active reporter. The
 * pinned key is used rather than the account's current key in pqcKeyStatus, because the hub's
 * fraud proof checks reports against the pinned key: a reporter that rotated its key must not
 * be accepted here and then fail on chain. `ChainView` is synchronous, so the reads happen
 * here, up front.
 *
 * Without `at`, activity is judged for a batch posted now (the sequencer's view). With `at`,
 * the timestamp a batch was posted at, it is read from the hub's `isActiveAt`, the rule the
 * fraud proof applies, so a watchtower auditing an older batch agrees with the hub.
 */
export async function loadChainView(
  client: PublicClient,
  hub: Hex,
  accounts: readonly Hex[],
  at?: bigint,
): Promise<ChainView> {
  const keys = new Map<string, Uint8Array>();
  const active = new Set<string>();
  const minStake = await client.readContract({ address: hub, abi: auguryHubAbi, functionName: "minReporterStake" });

  await Promise.all(
    accounts.map(async (account) => {
      const id = account.toLowerCase();
      const [pinned, [stake, exitRequestedAt, activeSince, slashedAt]] = await Promise.all([
        client.readContract({ address: hub, abi: auguryHubAbi, functionName: "reporterKeys", args: [account] }),
        client.readContract({ address: hub, abi: auguryHubAbi, functionName: "reporters", args: [account] }),
      ]);
      if (pinned.length > 2) keys.set(id, Uint8Array.from(Buffer.from(pinned.slice(2), "hex")));
      const isActive =
        at === undefined
          ? isActiveNow({ stake, exitRequestedAt, activeSince, slashedAt }, minStake)
          : await client.readContract({ address: hub, abi: auguryHubAbi, functionName: "isActiveAt", args: [account, at] });
      if (isActive) active.add(id);
    }),
  );

  return {
    reporterKey: (a) => keys.get(a.toLowerCase()),
    isActive: (a) => active.has(a.toLowerCase()),
  };
}

/** The timestamp AuguryHub recorded when the batch for `feedId` and `round` was posted. */
export async function batchPostedAt(client: PublicClient, hub: Hex, feedId: Hex, round: bigint): Promise<bigint> {
  const [, , , postedAt] = await client.readContract({ address: hub, abi: auguryHubAbi, functionName: "batches", args: [feedId, round] });
  return postedAt;
}

/** A reporter's record in AuguryHub (`reporters(address)`). */
export interface StakerRecord {
  stake: bigint;
  exitRequestedAt: bigint;
  activeSince: bigint;
  slashedAt: bigint;
}

/** Whether a reporter counts as active for a batch posted now, by the same rule as `isActiveAt`. */
export function isActiveNow(s: StakerRecord, minStake: bigint): boolean {
  return s.stake >= minStake && s.activeSince !== 0n && s.exitRequestedAt === 0n && s.slashedAt === 0n;
}

/** AuguryHub.latestRound for each feed, keyed by lowercase feed id. */
export async function latestRounds(client: PublicClient, hub: Hex, feeds: readonly Hex[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const feedId of feeds) {
    const round = await client.readContract({ address: hub, abi: auguryHubAbi, functionName: "latestRound", args: [feedId] });
    out.set(feedId.toLowerCase(), round);
  }
  return out;
}

/** A batch as posted to the hub, rebuilt from the postBatch transaction's calldata. */
export interface PostedBatchOnChain {
  txHash: Hex;
  blockNumber: bigint;
  header: { feedId: Hex; round: bigint; price: bigint; reportRoot: Hex; reportCount: number };
  reports: SignedReport[];
}

/**
 * Every batch posted since `fromBlock`. The reports come from the transaction's calldata,
 * which AuguryHub requires to carry them, so every batch can be checked and challenged.
 */
export async function postedBatches(client: PublicClient, hub: Hex, fromBlock: bigint): Promise<PostedBatchOnChain[]> {
  const logs = await client.getContractEvents({ address: hub, abi: auguryHubAbi, eventName: "BatchPosted", fromBlock });
  const out: PostedBatchOnChain[] = [];
  for (const log of logs) {
    const tx = await client.getTransaction({ hash: log.transactionHash });
    const call = decodeFunctionData({ abi: auguryHubAbi, data: tx.input });
    if (call.functionName !== "postBatch") continue;
    const [feedId, round, price, reports] = call.args;
    out.push({
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      header: {
        feedId,
        round,
        price,
        reportRoot: log.args.reportRoot!,
        reportCount: Number(log.args.reportCount!),
      },
      reports: reports.map((r) => ({
        feedId,
        round,
        reporter: r.reporter.toLowerCase() as Hex,
        price: r.price,
        observedAt: r.observedAt,
        salt: r.salt,
        signature: hexToBytes(r.signature),
      })),
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Deployment
// ------------------------------------------------------------------------------------------

export interface HubParams {
  sequencer: Hex;
  mldsaAlgorithmId: number;
  /** In wei (QOR has 18 decimals on the EVM lane). */
  minReporterStake: bigint;
  minSequencerBond: bigint;
  /** Seconds. */
  challengeWindow: bigint;
  exitDelay: bigint;
  minReports: number;
  maxReports: number;
}

/** Deploy AuguryHub from `account`. */
export async function deployAuguryHub(opts: {
  net: Network;
  account: UnifiedAccount;
  native: NativeSender;
  params: HubParams;
}): Promise<{ address: Hex; txHash: Hex }> {
  const p = opts.params;
  return deployThroughWindow({
    ...opts,
    label: "AuguryHub",
    abi: auguryHubAbi,
    bytecode: auguryHubBytecode,
    args: [
      p.sequencer,
      p.mldsaAlgorithmId,
      p.minReporterStake,
      p.minSequencerBond,
      p.challengeWindow,
      p.exitDelay,
      p.minReports,
      p.maxReports,
    ],
  });
}

/**
 * Deploy a contract from `account`. Contract creation is refused inside a target-scoped
 * window, so this opens an unscoped window that admits exactly one transaction.
 */
export async function deployThroughWindow(opts: {
  net: Network;
  account: UnifiedAccount;
  native: NativeSender;
  label: string;
  abi: Abi;
  bytecode: Hex;
  args: readonly unknown[];
}): Promise<{ address: Hex; txHash: Hex }> {
  const client = publicClient(opts.net);
  const wallet = createWalletClient({
    account: privateKeyToAccount(opts.account.privateKey as Hex),
    chain: evmChain(opts.net),
    transport: http(opts.net.evmRpc),
  });

  const gas = 6_000_000n;
  const fees = await client.estimateFeesPerGas();
  await opts.native.send(
    [
      openEvmWindowMessage({
        sender: opts.native.address,
        blocks: 200n,
        maxTxs: 1n,
        maxValue: evmWindowCost({ gas, maxFeePerGas: fees.maxFeePerGas }).toString(),
      }),
    ],
    300_000n,
    `augury: one-transaction window to deploy ${opts.label}`,
  );
  const nonce = await client.getTransactionCount({ address: wallet.account.address, blockTag: "pending" });
  const txHash = await wallet.deployContract({
    abi: opts.abi,
    bytecode: opts.bytecode,
    args: opts.args,
    gas,
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deployment ${txHash} failed`);
  return { address: receipt.contractAddress.toLowerCase() as Hex, txHash };
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
