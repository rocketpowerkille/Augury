import { StargateClient } from "@cosmjs/stargate";
import { RDK_TYPES } from "@qorechain/rdk";
import {
  EthNativeSigner,
  qorechainRegistry,
  recommendedGasPriceUqor,
  type EthTxParams,
  type UnifiedAccount,
} from "@qorechain/sdk";
import type { Network } from "./network.ts";

/** A native-lane message, as the SDK's registry encodes it. */
export type NativeMessage = EthTxParams["messages"][number];

/**
 * Every message Augury signs: the SDK's QoreChain types (PQC keys, EVM windows, bank) plus
 * the RDK's rollup types. The SDK's default registry lacks `MsgPostRollupData`, and the RDK's
 * definitions are the newer ones for the rollup messages both know.
 */
export function auguryRegistry(): ReturnType<typeof qorechainRegistry> {
  return qorechainRegistry(RDK_TYPES as Parameters<typeof qorechainRegistry>[0]);
}

export interface NativeTxResult {
  hash: string;
  height?: number;
}

/** Account number and sequence from `/cosmos/auth/v1beta1/accounts/{address}`. */
export function parseAccountSequence(body: unknown): { accountNumber: bigint; sequence: bigint } {
  const account = (body as { account?: Record<string, unknown> } | null)?.account;
  if (!account) throw new Error("no account in response");
  // eth_secp256k1 accounts may nest the base account.
  const base = (account.base_account as Record<string, unknown> | undefined) ?? account;
  const num = base.account_number;
  const seq = base.sequence ?? "0";
  if (typeof num !== "string" || typeof seq !== "string") throw new Error("account has no number or sequence");
  return { accountNumber: BigInt(num), sequence: BigInt(seq) };
}

/**
 * A gas limit sized from what the transaction carries: a base for execution, plus 20 gas per
 * byte of messages and of the hybrid signature (about 8 KB with ML-DSA-87), roughly twice the
 * usual per-byte charge. Generous on purpose; pass an exact limit to `send` when known.
 */
export function gasFor(messages: readonly NativeMessage[]): bigint {
  const registry = auguryRegistry();
  const bytes = messages.reduce((n, m) => n + registry.encodeAsAny(m).value.length, 0);
  return 200_000n + 20n * BigInt(bytes + 8_000);
}

/** Fee in uqor for `gas` at `pricePerGas` (a decimal string), rounded up. */
export function feeFor(gas: bigint, pricePerGas: string): bigint {
  const [whole, frac = ""] = pricePerGas.split(".");
  const scale = 10n ** BigInt(frac.length);
  const priceScaled = BigInt(whole! + frac);
  return (gas * priceScaled + scale - 1n) / scale;
}

/**
 * Sends hybrid-signed (secp256k1 + ML-DSA-87) native transactions from a unified account.
 * The account's PQC key must already be registered on chain.
 */
export class NativeSender {
  readonly address: string;
  private readonly net: Network;
  private readonly signer: EthNativeSigner;
  private readonly transport: StargateClient;

  private constructor(net: Network, account: UnifiedAccount, transport: StargateClient, signMode: "hybrid" | "classical") {
    this.net = net;
    this.address = account.cosmos;
    this.signer = new EthNativeSigner(account, { rest: net.rest, registry: auguryRegistry(), signMode });
    this.transport = transport;
  }

  /**
   * `signMode: "classical"` exists only for the one-time, bootstrap-exempt registration of the
   * account's PQC key (`pqcRegistrationMessage`); everything else is signed hybrid.
   */
  static async connect(
    net: Network,
    account: UnifiedAccount,
    opts: { signMode?: "hybrid" | "classical" } = {},
  ): Promise<NativeSender> {
    return new NativeSender(net, account, await StargateClient.connect(net.rpc), opts.signMode ?? "hybrid");
  }

  async accountSequence(): Promise<{ accountNumber: bigint; sequence: bigint }> {
    const res = await fetch(`${this.net.rest}/cosmos/auth/v1beta1/accounts/${this.address}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`account ${this.address} not found (${res.status}); fund it first`);
    return parseAccountSequence(await res.json());
  }

  /** Sign and broadcast `messages`. Throws if the chain refuses the transaction. */
  async send(messages: readonly NativeMessage[], gas = gasFor(messages), memo = ""): Promise<NativeTxResult> {
    const { accountNumber, sequence } = await this.accountSequence();
    const price = await recommendedGasPriceUqor({ rest: this.net.rest });
    const result = await this.signer.signAndBroadcast(this.transport, {
      chainId: this.net.chainId,
      accountNumber,
      sequence,
      messages,
      memo,
      fee: { amount: [{ denom: "uqor", amount: feeFor(gas, price).toString() }], gas: gas.toString() },
    });
    if (result.code !== 0) {
      throw new Error(`transaction ${result.transactionHash} failed with code ${result.code}: ${result.rawLog ?? ""}`);
    }
    return result.height === undefined
      ? { hash: result.transactionHash }
      : { hash: result.transactionHash, height: result.height };
  }

  disconnect(): void {
    this.transport.disconnect();
  }
}
