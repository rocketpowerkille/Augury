import { dealerFor, layerDealerFor } from "@augury/committee";
import { findOpens, layerOf, type Hex, type InboxEntry, type Layer, type MemberIndex, type RoundConfig, type RoundOpen } from "@augury/shared";

/**
 * Pure planning: given the inbox and the current height, what should each role do now?
 * The runners execute these plans against the chain; keeping the decisions here makes them
 * testable without a network.
 */

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const key = (feedId: Hex, round: bigint) => `${feedId.toLowerCase()}:${round}`;

export interface OpenedRound {
  open: RoundOpen;
  entry: InboxEntry;
}

/**
 * The valid rounds on the inbox: per (feed, round), the first layer 0 open posted by its
 * claimed dealer. A two-dealer round's layer 1 open is found with `outerOpenOf`.
 */
export function roundOpens(cfg: RoundConfig, entries: readonly InboxEntry[]): OpenedRound[] {
  const seen = new Map<string, OpenedRound>();
  for (const entry of [...entries].sort((a, b) => (a.seq < b.seq ? -1 : 1))) {
    const p = entry.post;
    if (p.kind !== "open" || layerOf(p) !== 0 || !same(entry.poster, cfg.committee[p.dealer])) continue;
    const k = key(p.feedId, p.round);
    if (!seen.has(k)) seen.set(k, { open: p, entry });
  }
  return [...seen.values()];
}

export function latestOpen(cfg: RoundConfig, entries: readonly InboxEntry[], feedId: Hex): OpenedRound | undefined {
  return roundOpens(cfg, entries)
    .filter((o) => same(o.open.feedId, feedId))
    .reduce<OpenedRound | undefined>((best, o) => (!best || o.open.round > best.open.round ? o : best), undefined);
}

/** The layer 1 open of a two-dealer round, by the round rules; undefined if not posted yet. */
export function outerOpenOf(cfg: RoundConfig, entries: readonly InboxEntry[], open: RoundOpen): RoundOpen | undefined {
  const found = findOpens(cfg, entries, open.feedId, open.round);
  return typeof found === "string" ? undefined : found.outer;
}

/** The opens of a round, layer 0 first; a two-dealer round lists its layer 1 open once posted. */
function layerOpens(cfg: RoundConfig, entries: readonly InboxEntry[], open: RoundOpen): RoundOpen[] {
  const outer = (open.layers ?? 1) === 2 ? outerOpenOf(cfg, entries, open) : undefined;
  return outer ? [open, outer] : [open];
}

function postedBy(
  entries: readonly InboxEntry[],
  poster: Hex,
  kind: string,
  feedId: Hex,
  round: bigint,
  layer?: Layer,
): boolean {
  return entries.some(
    (e) =>
      e.post.kind === kind &&
      same(e.poster, poster) &&
      same(e.post.feedId, feedId) &&
      e.post.round === round &&
      (layer === undefined || layerOf(e.post as { layer?: Layer }) === layer),
  );
}

// ------------------------------------------------------------------------------------------
// Committee
// ------------------------------------------------------------------------------------------

export type CommitteeAction =
  | { kind: "deal"; feedId: Hex; round: bigint; closeHeight: bigint; layer: Layer }
  | { kind: "release"; open: RoundOpen };

export function planCommittee(args: {
  cfg: RoundConfig;
  entries: readonly InboxEntry[];
  member: MemberIndex;
  height: bigint;
  feeds: readonly Hex[];
  /** How many blocks a round stays open for reports. */
  roundBlocks: bigint;
}): CommitteeAction[] {
  const { cfg, entries, member, height } = args;
  const me = cfg.committee[member];
  const actions: CommitteeAction[] = [];

  for (const feedId of args.feeds) {
    const latest = latestOpen(cfg, entries, feedId);
    // Deal layer 0 of the next round once the latest round has closed, if it is our turn.
    if (!latest || height > latest.open.closeHeight) {
      const next = (latest?.open.round ?? 0n) + 1n;
      if (dealerFor(next) === member) {
        actions.push({ kind: "deal", feedId, round: next, closeHeight: height + args.roundBlocks, layer: 0 });
      }
      continue;
    }
    // Deal layer 1 of an open two-dealer round, if we are its second dealer and it is missing.
    const open = latest.open;
    if (
      (open.layers ?? 1) === 2 &&
      layerDealerFor(open.round, 1) === member &&
      !outerOpenOf(cfg, entries, open) &&
      !postedBy(entries, me, "open", feedId, open.round, 1)
    ) {
      actions.push({ kind: "deal", feedId, round: open.round, closeHeight: open.closeHeight, layer: 1 });
    }
  }

  // Release our share of every layer of every closed round we have a delivery for and have
  // not released yet.
  for (const { open: first } of roundOpens(cfg, entries)) {
    if (height <= first.closeHeight) continue;
    for (const open of layerOpens(cfg, entries, first)) {
      const layer = open.layer;
      if (postedBy(entries, me, "share", open.feedId, open.round, layer ?? 0)) continue;
      const delivered = entries.some(
        (e) =>
          e.post.kind === "delivery" &&
          e.post.member === member &&
          e.post.layer === layer &&
          same(e.poster, cfg.committee[open.dealer]) &&
          same(e.post.feedId, open.feedId) &&
          e.post.round === open.round,
      );
      if (delivered) actions.push({ kind: "release", open });
    }
  }
  return actions;
}

// ------------------------------------------------------------------------------------------
// Reporter
// ------------------------------------------------------------------------------------------

/**
 * Rounds `reporter` should report in now: each feed's latest open round, still open, fully
 * opened (both layers of a two-dealer round) and not yet reported.
 */
export function planReporter(args: {
  cfg: RoundConfig;
  entries: readonly InboxEntry[];
  reporter: Hex;
  height: bigint;
  feeds: readonly Hex[];
  /** Blocks of slack kept before the close, so the report lands in time. */
  marginBlocks: bigint;
}): { open: RoundOpen; outer?: RoundOpen }[] {
  const out: { open: RoundOpen; outer?: RoundOpen }[] = [];
  for (const feedId of args.feeds) {
    const latest = latestOpen(args.cfg, args.entries, feedId);
    if (!latest) continue;
    if (args.height + args.marginBlocks > latest.open.closeHeight) continue;
    if (postedBy(args.entries, args.reporter, "report", feedId, latest.open.round)) continue;
    if ((latest.open.layers ?? 1) === 2) {
      const outer = outerOpenOf(args.cfg, args.entries, latest.open);
      if (!outer) continue; // wait for the second dealer
      out.push({ open: latest.open, outer });
    } else {
      out.push({ open: latest.open });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Sequencer
// ------------------------------------------------------------------------------------------

/**
 * Blocks after a round's close that the sequencer waits for its shares (about ten minutes at
 * QoreChain's one-second blocks). Rounds reach the hub in order, so until then later rounds of
 * the feed wait too; after it the round is given up, so a dealer whose deliveries never open,
 * or committee members who stay offline, cannot stall the feed forever.
 */
export const SHARE_TIMEOUT_BLOCKS = 600n;

/** Whether the sequencer should stop waiting for the shares of a round that closed at `closeHeight`. */
export function sharesOverdue(closeHeight: bigint, height: bigint, timeoutBlocks = SHARE_TIMEOUT_BLOCKS): boolean {
  return height > closeHeight + timeoutBlocks;
}

/** Closed rounds newer than what the hub has settled, oldest first. */
export function planSequencer(args: {
  cfg: RoundConfig;
  entries: readonly InboxEntry[];
  height: bigint;
  /** AuguryHub.latestRound per feed. */
  settled: ReadonlyMap<string, bigint>;
  /** Rounds already given up on (e.g. too few reports). */
  skipped: ReadonlySet<string>;
}): { feedId: Hex; round: bigint }[] {
  return roundOpens(args.cfg, args.entries)
    .filter(({ open }) => args.height > open.closeHeight)
    .filter(({ open }) => open.round > (args.settled.get(open.feedId.toLowerCase()) ?? 0n))
    .filter(({ open }) => !args.skipped.has(key(open.feedId, open.round)))
    .map(({ open }) => ({ feedId: open.feedId, round: open.round }))
    .sort((a, b) => (a.round < b.round ? -1 : a.round > b.round ? 1 : 0));
}

export { key as roundKey };
