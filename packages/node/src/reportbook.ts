import type { Hex, SealedReportPost, SignaturePost } from "@augury/shared";

export type ReportPosts = [SealedReportPost, SignaturePost];

/**
 * The reports this reporter has signed, one per feed and round.
 *
 * An honest reporter must sign exactly one report per round: two different signed reports
 * for the same round are equivocation, and AuguryHub slashes the whole stake for it. A
 * report is rebuilt with a fresh salt and timestamp every time it is signed, so retrying a
 * post by signing again would equivocate. That happens when a transaction lands but sending
 * it reports an error, or when the inbox read lags behind it. Retries must therefore resend
 * the exact posts signed the first time, which this book keeps.
 *
 * Security-relevant: changes here need review by the team's PQC/security member.
 */
export class ReportBook {
  readonly #signed = new Map<string, ReportPosts>();

  /** Whether a report was already signed for `feedId` and `round`. */
  has(feedId: Hex, round: bigint): boolean {
    return this.#signed.has(`${feedId.toLowerCase()}:${round}`);
  }

  /** The posts for `feedId` and `round`: built and signed on first use, the same posts after. */
  postsFor(feedId: Hex, round: bigint, build: () => ReportPosts): ReportPosts {
    const key = `${feedId.toLowerCase()}:${round}`;
    let posts = this.#signed.get(key);
    if (!posts) {
      posts = build();
      this.#signed.set(key, posts);
    }
    return posts;
  }

  /** Forget rounds before `round` for `feedId`; they can no longer be reported in. */
  forgetBefore(feedId: Hex, round: bigint): void {
    const prefix = `${feedId.toLowerCase()}:`;
    for (const key of this.#signed.keys()) {
      if (key.startsWith(prefix) && BigInt(key.slice(prefix.length)) < round) this.#signed.delete(key);
    }
  }
}
