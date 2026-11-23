import { bytesEqual, bytesToHex, hexToBytes, type Hex } from "./bytes.ts";
import { openReport, roundKeys, verifyReport, type SignedReport } from "./crypto.ts";
import { shareFromPost, type InboxEntry, type RoundOpen, type SharePost } from "./inbox.ts";
import { median } from "./median.ts";
import { reportMessage, reportRoot, type BatchHeader, type Domain } from "./messages.ts";
import { combineShares, verifyShare, type MemberIndex, type MemberShare } from "./shares.ts";

/**
 * The canonical rules that turn a round's inbox entries into a batch. The sequencer runs
 * this to build batches and the watchtower runs it to check them, so both always agree.
 */

export interface RoundConfig {
  domain: Domain;
  /** Native chain id used by QoreSeal, e.g. `qorechain-diana`. */
  sealChainId: string;
  /** EVM addresses of committee members 0, 1 and 2. */
  committee: readonly [Hex, Hex, Hex];
  minReports: number;
  maxReports: number;
}

/** What the round processor needs to know about the chain. */
export interface ChainView {
  /** The ML-DSA-87 public key registered for `account`, if any. */
  reporterKey(account: Hex): Uint8Array | undefined;
  /** Whether `account` is an active, staked reporter. */
  isActive(account: Hex): boolean;
}

export type RejectReason =
  | "before-open"
  | "late"
  | "cannot-open"
  | "wrong-poster"
  | "unknown-key"
  | "bad-signature"
  | "inactive"
  | "duplicate"
  | "over-capacity";

export interface Rejection {
  seq: bigint;
  poster: Hex;
  reason: RejectReason;
}

/** Two different signed reports by the same reporter for the same round. */
export interface Equivocation {
  first: SignedReport;
  second: SignedReport;
}

export interface EarlyShare {
  seq: bigint;
  member: MemberIndex;
}

interface Findings {
  rejected: Rejection[];
  equivocations: Equivocation[];
  earlyShares: EarlyShare[];
}

export type RoundOutcome =
  | { status: "no-open" }
  | ({ status: "awaiting-shares"; open: RoundOpen } & Pick<Findings, "earlyShares">)
  | ({ status: "bad-round-key"; open: RoundOpen } & Pick<Findings, "earlyShares">)
  | ({ status: "too-few-reports"; open: RoundOpen; reports: SignedReport[] } & Findings)
  | ({ status: "ready"; open: RoundOpen; header: BatchHeader; reports: SignedReport[] } & Findings);

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

export function processRound(
  cfg: RoundConfig,
  view: ChainView,
  entries: readonly InboxEntry[],
  feedId: Hex,
  round: bigint,
): RoundOutcome {
  const forRound = [...entries]
    .filter((e) => same(e.post.feedId, feedId) && e.post.round === round)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  // 1. The round opens with the first open posted by its dealer.
  const openEntry = forRound.find(
    (e) => e.post.kind === "open" && same(e.poster, cfg.committee[e.post.dealer]),
  );
  if (!openEntry || openEntry.post.kind !== "open") return { status: "no-open" };
  const open = openEntry.post;

  // 2. Shares: only from the member they belong to, only after the round closed.
  const earlyShares: EarlyShare[] = [];
  const validShares = new Map<MemberIndex, MemberShare>();
  for (const e of forRound) {
    if (e.post.kind !== "share" || !same(e.poster, cfg.committee[e.post.member])) continue;
    if (e.height <= open.closeHeight) {
      earlyShares.push({ seq: e.seq, member: e.post.member });
      continue;
    }
    const share = shareFromPost(e.post as SharePost);
    if (!validShares.has(share.member) && verifyShare(share, round, open.commitments)) {
      validShares.set(share.member, share);
    }
  }
  if (validShares.size < 2) return { status: "awaiting-shares", open, earlyShares };

  const keys = roundKeys(combineShares([...validShares.values()], round, open.commitments));
  if (
    !bytesEqual(keys.mlkemPublicKey, hexToBytes(open.mlkemPublicKey)) ||
    !bytesEqual(keys.x25519PublicKey, hexToBytes(open.x25519PublicKey))
  ) {
    // The dealer published a public key that does not match the committed seed.
    return { status: "bad-round-key", open, earlyShares };
  }

  // 3. Reports, in inbox order.
  const rejected: Rejection[] = [];
  const equivocations: Equivocation[] = [];
  const included = new Map<string, SignedReport>();
  const reject = (e: InboxEntry, reason: RejectReason) =>
    rejected.push({ seq: e.seq, poster: e.poster, reason });

  for (const e of forRound) {
    if (e.post.kind !== "report") continue;
    if (e.seq < openEntry.seq) {
      reject(e, "before-open");
      continue;
    }
    if (e.height > open.closeHeight) {
      reject(e, "late");
      continue;
    }
    let report: SignedReport;
    try {
      report = openReport({
        sealChainId: cfg.sealChainId,
        domain: cfg.domain,
        keys,
        envelope: hexToBytes(e.post.envelope),
        feedId,
        round,
      });
    } catch {
      reject(e, "cannot-open");
      continue;
    }
    if (!same(report.reporter, e.poster)) {
      reject(e, "wrong-poster");
      continue;
    }
    const key = view.reporterKey(report.reporter);
    if (!key) {
      reject(e, "unknown-key");
      continue;
    }
    if (!verifyReport(key, cfg.domain, report)) {
      reject(e, "bad-signature");
      continue;
    }
    if (!view.isActive(report.reporter)) {
      reject(e, "inactive");
      continue;
    }
    const id = report.reporter.toLowerCase();
    const earlier = included.get(id);
    if (earlier) {
      const differs = !bytesEqual(reportMessage(cfg.domain, earlier), reportMessage(cfg.domain, report));
      if (differs) equivocations.push({ first: earlier, second: report });
      reject(e, "duplicate");
      continue;
    }
    if (included.size >= cfg.maxReports) {
      reject(e, "over-capacity");
      continue;
    }
    included.set(id, report);
  }

  // An equivocating reporter is dropped from the batch entirely.
  for (const eq of equivocations) included.delete(eq.first.reporter.toLowerCase());

  const reports = [...included.values()];
  const findings = { rejected, equivocations, earlyShares };
  if (reports.length < cfg.minReports) {
    return { status: "too-few-reports", open, reports, ...findings };
  }

  const header: BatchHeader = {
    feedId,
    round,
    price: median(reports.map((r) => r.price)),
    reportRoot: bytesToHex(reportRoot(cfg.domain, reports)),
    reportCount: reports.length,
  };
  return { status: "ready", open, header, reports, ...findings };
}
