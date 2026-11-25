import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * With a `file`, the book is saved there before `postsFor` returns, so the posts are on disk
 * before they can be sent and a restarted node resends them instead of signing again. The
 * file holds sealed salts that must stay secret until the round closes, so it is written
 * readable by its owner only, like a key file.
 *
 * Security-relevant: changes here need review by the team's PQC/security member.
 */
export class ReportBook {
  readonly #signed = new Map<string, ReportPosts>();
  readonly #file: string | undefined;

  constructor(file?: string) {
    this.#file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, StoredPosts>;
      for (const [key, posts] of Object.entries(saved)) this.#signed.set(key, fromStored(posts));
    }
  }

  /** Whether a report was already signed for `feedId` and `round`. */
  has(feedId: Hex, round: bigint): boolean {
    return this.#signed.has(keyOf(feedId, round));
  }

  /** The posts for `feedId` and `round`: built and signed on first use, the same posts after. */
  postsFor(feedId: Hex, round: bigint, build: () => ReportPosts): ReportPosts {
    const key = keyOf(feedId, round);
    let posts = this.#signed.get(key);
    if (!posts) {
      posts = build();
      this.#signed.set(key, posts);
      this.#save();
    }
    return posts;
  }

  /** Forget rounds before `round` for `feedId`; they can no longer be reported in. */
  forgetBefore(feedId: Hex, round: bigint): void {
    const prefix = `${feedId.toLowerCase()}:`;
    let changed = false;
    for (const key of this.#signed.keys()) {
      if (key.startsWith(prefix) && BigInt(key.slice(prefix.length)) < round) {
        this.#signed.delete(key);
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  /** Write the book atomically (temporary file, then rename), readable by its owner only. */
  #save(): void {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const stored: Record<string, StoredPosts> = {};
    for (const [key, posts] of this.#signed) stored[key] = toStored(posts);
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#file);
  }
}

const keyOf = (feedId: Hex, round: bigint) => `${feedId.toLowerCase()}:${round}`;

type StoredPosts = [Omit<SealedReportPost, "round"> & { round: string }, Omit<SignaturePost, "round"> & { round: string }];

function toStored([report, signature]: ReportPosts): StoredPosts {
  return [
    { ...report, round: report.round.toString() },
    { ...signature, round: signature.round.toString() },
  ];
}

function fromStored([report, signature]: StoredPosts): ReportPosts {
  return [
    { ...report, round: BigInt(report.round) },
    { ...signature, round: BigInt(signature.round) },
  ];
}
