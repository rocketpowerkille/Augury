import {
  bytesToHex,
  median,
  processRound,
  reportLeaf,
  verifyReport,
  type BatchHeader,
  type ChainView,
  type EarlyShare,
  type Equivocation,
  type InboxEntry,
  type RoundConfig,
  type SignedReport,
} from "@augury/shared";

/** A batch as posted to AuguryHub (decoded from the postBatch call). */
export interface PostedBatch {
  header: BatchHeader;
  reports: SignedReport[];
}

/** Fraud AuguryHub.challengeBatch can prove on chain. Same checks, same order as the hub. */
export type ProvableFraud = "duplicate-reporter" | "inactive-reporter" | "bad-signature" | "wrong-median";

export type Finding =
  /** Submit `reports` to challengeBatch: the hub will slash the sequencer. */
  | { kind: "challenge"; fraud: ProvableFraud; reports: SignedReport[] }
  /** Submit to reportEquivocation: the hub will slash the reporter. */
  | { kind: "equivocation"; evidence: Equivocation }
  /** Valid reports from the inbox that the batch left out. Not yet provable on chain. */
  | { kind: "omitted-reports"; reporters: string[] }
  /** Reports in the batch that the round's inbox does not justify. Not yet provable on chain. */
  | { kind: "unexpected-reports"; reporters: string[] }
  /** The inbox does not produce a batch for this round, yet one was posted. */
  | { kind: "no-canonical-batch"; status: string }
  /** A committee member released its share before the round closed. */
  | { kind: "early-share"; share: EarlyShare };

/** The hub's own fraud checks, in the hub's order. */
export function provableFraud(cfg: RoundConfig, view: ChainView, posted: PostedBatch): ProvableFraud | undefined {
  const seen = new Set<string>();
  for (const r of posted.reports) {
    const id = r.reporter.toLowerCase();
    if (seen.has(id)) return "duplicate-reporter";
    seen.add(id);
    if (!view.isActive(r.reporter)) return "inactive-reporter";
    const key = view.reporterKey(r.reporter);
    if (!key || !verifyReport(key, cfg.domain, r)) return "bad-signature";
  }
  if (median(posted.reports.map((r) => r.price)) !== posted.header.price) return "wrong-median";
  return undefined;
}

/** Everything wrong with a posted batch, judged against the round's inbox. */
export function auditBatch(
  cfg: RoundConfig,
  view: ChainView,
  entries: readonly InboxEntry[],
  posted: PostedBatch,
): Finding[] {
  const findings: Finding[] = [];

  const fraud = provableFraud(cfg, view, posted);
  if (fraud) findings.push({ kind: "challenge", fraud, reports: posted.reports });

  const outcome = processRound(cfg, view, entries, posted.header.feedId, posted.header.round);
  if ("earlyShares" in outcome) {
    for (const share of outcome.earlyShares) findings.push({ kind: "early-share", share });
  }
  if (outcome.status === "too-few-reports" || outcome.status === "ready") {
    for (const evidence of outcome.equivocations) findings.push({ kind: "equivocation", evidence });
  }
  if (outcome.status !== "ready") {
    findings.push({ kind: "no-canonical-batch", status: outcome.status });
    return findings;
  }

  const leafOf = (r: SignedReport) => bytesToHex(reportLeaf(cfg.domain, r));
  const canonical = new Map(outcome.reports.map((r) => [leafOf(r), r]));
  const postedLeaves = new Map(posted.reports.map((r) => [leafOf(r), r]));
  const omitted = [...canonical].filter(([leaf]) => !postedLeaves.has(leaf)).map(([, r]) => r.reporter);
  const unexpected = [...postedLeaves].filter(([leaf]) => !canonical.has(leaf)).map(([, r]) => r.reporter);
  if (omitted.length > 0) findings.push({ kind: "omitted-reports", reporters: omitted });
  if (unexpected.length > 0) findings.push({ kind: "unexpected-reports", reporters: unexpected });

  return findings;
}
