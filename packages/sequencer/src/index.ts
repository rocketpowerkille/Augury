import {
  processRound,
  signBatch,
  type BatchHeader,
  type ChainView,
  type Hex,
  type InboxEntry,
  type RoundConfig,
  type RoundOutcome,
  type SignedReport,
} from "@augury/shared";

/** Everything AuguryHub.postBatch needs. */
export interface BatchToPost {
  header: BatchHeader;
  reports: SignedReport[];
  /** The sequencer's ML-DSA-87 signature over the batch message. */
  signature: Uint8Array;
}

export interface BuildResult {
  outcome: RoundOutcome;
  /** Present only when the round produced a batch. */
  batch?: BatchToPost;
}

/**
 * Run the canonical round rules and, if the round is ready, sign its batch.
 * The sequencer adds nothing of its own: a watchtower running `processRound` on the same
 * inbox gets the same header.
 */
export function buildBatch(
  cfg: RoundConfig,
  view: ChainView,
  entries: readonly InboxEntry[],
  feedId: Hex,
  round: bigint,
  secretKey: Uint8Array,
): BuildResult {
  const outcome = processRound(cfg, view, entries, feedId, round);
  if (outcome.status !== "ready") return { outcome };
  return {
    outcome,
    batch: {
      header: outcome.header,
      reports: outcome.reports,
      signature: signBatch(secretKey, cfg.domain, outcome.header),
    },
  };
}
