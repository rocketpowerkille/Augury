import { bytesEqual, bytesToHex, hexToBytes, type Hex } from "./bytes.ts";
import { openReport, roundKeys, verifyReport, type SignedReport } from "./crypto.ts";
import { shareFromPost, type InboxEntry, type Layer, type RoundOpen, type SharePost } from "./inbox.ts";
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
  | "missing-signature"
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
  layer: Layer;
}

interface Findings {
  rejected: Rejection[];
  equivocations: Equivocation[];
  earlyShares: EarlyShare[];
}

/**
 * `open` is the round's layer 0 open (its only open in a single-dealer round); `outer` is the
 * layer 1 open of a two-dealer round.
 */
type Opened = { open: RoundOpen; outer?: RoundOpen };

export type RoundOutcome =
  | { status: "no-open" }
  | ({ status: "awaiting-shares" } & Opened & Pick<Findings, "earlyShares">)
  | ({ status: "bad-round-key" } & Opened & Pick<Findings, "earlyShares">)
  | ({ status: "too-few-reports"; reports: SignedReport[] } & Opened & Findings)
  | ({ status: "ready"; header: BatchHeader; reports: SignedReport[] } & Opened & Findings);

/** The layer an open, share or delivery belongs to; posts without one are layer 0. */
export const layerOf = (post: { layer?: Layer }): Layer => post.layer ?? 0;

/**
 * The opens of a round, in the order the round rules accept them. Layer 0: the first open
 * posted by the committee member it names as dealer. Layer 1 (only when the layer 0 open
 * declares `layers: 2`): the first layer 1 open posted by a different member, named as its
 * dealer, with the same close height and posted no later than the close.
 */
export function findOpens(
  cfg: RoundConfig,
  entries: readonly InboxEntry[],
  feedId: Hex,
  round: bigint,
): { open: RoundOpen; openEntry: InboxEntry; outer?: RoundOpen; outerEntry?: InboxEntry } | "no-open" | "awaiting-outer" {
  const forRound = [...entries]
    .filter((e) => same(e.post.feedId, feedId) && e.post.round === round && e.post.kind === "open")
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const openEntry = forRound.find(
    (e) => e.post.kind === "open" && layerOf(e.post) === 0 && same(e.poster, cfg.committee[e.post.dealer]),
  );
  if (!openEntry || openEntry.post.kind !== "open") return "no-open";
  const open = openEntry.post;
  if ((open.layers ?? 1) === 1) return { open, openEntry };
  const outerEntry = forRound.find(
    (e) =>
      e.post.kind === "open" &&
      layerOf(e.post) === 1 &&
      e.post.dealer !== open.dealer &&
      same(e.poster, cfg.committee[e.post.dealer]) &&
      e.post.closeHeight === open.closeHeight &&
      e.height <= open.closeHeight,
  );
  if (!outerEntry || outerEntry.post.kind !== "open") return "awaiting-outer";
  return { open, openEntry, outer: outerEntry.post, outerEntry };
}

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

  // 1. The round opens with its layer 0 open, and in a two-dealer round also its layer 1 open.
  const found = findOpens(cfg, entries, feedId, round);
  if (found === "no-open" || found === "awaiting-outer") return { status: "no-open" };
  const { open, openEntry, outer, outerEntry } = found;
  const opened: Opened = outer ? { open, outer } : { open };
  const layerOpens: RoundOpen[] = outer ? [open, outer] : [open];

  // 2. Shares, per layer: only from the member they belong to, only after the round closed.
  const earlyShares: EarlyShare[] = [];
  const validShares = layerOpens.map(() => new Map<MemberIndex, MemberShare>());
  for (const e of forRound) {
    if (e.post.kind !== "share" || !same(e.poster, cfg.committee[e.post.member])) continue;
    const layer = layerOf(e.post);
    if (layer >= layerOpens.length) continue;
    if (e.height <= open.closeHeight) {
      earlyShares.push({ seq: e.seq, member: e.post.member, layer });
      continue;
    }
    const share = shareFromPost(e.post as SharePost);
    const valid = validShares[layer]!;
    if (!valid.has(share.member) && verifyShare(share, round, layerOpens[layer]!.commitments)) {
      valid.set(share.member, share);
    }
  }
  if (validShares.some((v) => v.size < 2)) return { status: "awaiting-shares", ...opened, earlyShares };

  // Rebuild each layer's key; each must match the public key its dealer published.
  const layerKeys = layerOpens.map((o, i) => roundKeys(combineShares([...validShares[i]!.values()], round, o.commitments)));
  const keyMismatch = layerOpens.some(
    (o, i) =>
      !bytesEqual(layerKeys[i]!.mlkemPublicKey, hexToBytes(o.mlkemPublicKey)) ||
      !bytesEqual(layerKeys[i]!.x25519PublicKey, hexToBytes(o.x25519PublicKey)),
  );
  if (keyMismatch) {
    // A dealer published a public key that does not match its committed seed.
    return { status: "bad-round-key", ...opened, earlyShares };
  }
  const keys = layerKeys[0]!;
  const outerKeys = layerKeys[1];
  // Reports count only once every open of the round is on the inbox.
  const openedAt = outerEntry && outerEntry.seq > openEntry.seq ? outerEntry.seq : openEntry.seq;

  // 3. Reports, in inbox order.
  const rejected: Rejection[] = [];
  const equivocations: Equivocation[] = [];
  const included = new Map<string, SignedReport>();
  const reject = (e: InboxEntry, reason: RejectReason) =>
    rejected.push({ seq: e.seq, poster: e.poster, reason });

  const bySeq = new Map(forRound.map((x) => [x.seq, x]));

  for (const e of forRound) {
    if (e.post.kind !== "report") continue;
    if (e.seq < openedAt) {
      reject(e, "before-open");
      continue;
    }
    if (e.height > open.closeHeight) {
      reject(e, "late");
      continue;
    }
    // The signature is the very next inbox entry, from the same poster (same transaction).
    const next = bySeq.get(e.seq + 1n);
    if (!next || next.post.kind !== "signature" || !same(next.poster, e.poster) || next.height !== e.height) {
      reject(e, "missing-signature");
      continue;
    }
    let report: SignedReport;
    try {
      report = {
        ...openReport({
          sealChainId: cfg.sealChainId,
          domain: cfg.domain,
          keys,
          ...(outerKeys ? { outerKeys } : {}),
          envelope: hexToBytes(e.post.envelope),
          feedId,
          round,
        }),
        signature: hexToBytes(next.post.signature),
      };
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
    return { status: "too-few-reports", ...opened, reports, ...findings };
  }

  const header: BatchHeader = {
    feedId,
    round,
    price: median(reports.map((r) => r.price)),
    reportRoot: bytesToHex(reportRoot(cfg.domain, reports)),
    reportCount: reports.length,
  };
  return { status: "ready", ...opened, header, reports, ...findings };
}
