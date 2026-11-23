import { decodePost, encodePost, type Hex, type InboxEntry, type InboxPost } from "@augury/shared";
import {
  EMPTY_INBOX_ACC,
  fetchQledgerEntries,
  postRollupDataMsg,
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  RestClient,
  type QledgerEntry,
} from "@qorechain/rdk";
import { qorToEvm } from "@qorechain/sdk";
import type { NativeMessage } from "./native.ts";

/**
 * The rollup inbox as Augury sees it. QoreChain orders every post and records its height and
 * poster; the RDK reads the payloads back from block history and checks them against the
 * chain's inbox accumulator, so what we decode is exactly what was posted.
 */

/**
 * Turn raw inbox entries `from + 1 ..` into Augury entries. Deposits and payloads that are
 * not Augury posts are skipped; their sequence numbers are simply absent.
 */
export function toInboxEntries(raw: readonly QledgerEntry[], from: bigint): InboxEntry[] {
  const out: InboxEntry[] = [];
  raw.forEach((e, i) => {
    if (e.poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX)) return;
    const post = decodePost(e.payload);
    if (!post) return;
    out.push({
      seq: from + BigInt(i) + 1n,
      height: BigInt(e.height),
      poster: qorToEvm(e.poster).toLowerCase() as Hex,
      post,
    });
  });
  return out;
}

export class InboxReader {
  private readonly rest: RestClient;
  private readonly chainId: string;
  private readonly rollupId: string;

  constructor(opts: { rest: string; chainId: string; rollupId: string }) {
    this.rest = new RestClient(opts.rest);
    this.chainId = opts.chainId;
    this.rollupId = opts.rollupId;
  }

  /** Sequence of the newest post (0 when the inbox is empty). */
  async head(): Promise<bigint> {
    return BigInt((await this.rest.getInbox(this.rollupId)).headSequence);
  }

  /** The chain's inbox accumulator after post `seq`. */
  async accumulatorAt(seq: bigint): Promise<Uint8Array | string> {
    if (seq === 0n) return EMPTY_INBOX_ACC;
    return (await this.rest.getPostedData(this.rollupId, seq)).inboxAcc;
  }

  /** Augury entries `from + 1 .. to`, verified against the chain's accumulator. */
  async read(from: bigint, to: bigint): Promise<InboxEntry[]> {
    if (to <= from) return [];
    const raw = await fetchQledgerEntries(this.rest, {
      chainId: this.chainId,
      rollupId: this.rollupId,
      from,
      to,
      accFrom: await this.accumulatorAt(from),
    });
    return toInboxEntries(raw, from);
  }
}

/** The native message that posts `post` to the rollup inbox from `poster` (`qor1…`). */
export function inboxPostMessage(poster: string, rollupId: string, post: InboxPost): NativeMessage {
  return postRollupDataMsg({ poster, rollupId, data: encodePost(post) });
}
