import { dealerFor } from "@augury/committee";
import type { Hex, InboxEntry, MemberIndex, RoundConfig, RoundOpen } from "@augury/shared";

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

/** The valid opens on the inbox: per (feed, round), the first one posted by its claimed dealer. */
export function roundOpens(cfg: RoundConfig, entries: readonly InboxEntry[]): OpenedRound[] {
  const seen = new Map<string, OpenedRound>();
  for (const entry of [...entries].sort((a, b) => (a.seq < b.seq ? -1 : 1))) {
    const p = entry.post;
    if (p.kind !== "open" || !same(entry.poster, cfg.committee[p.dealer])) continue;
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

function postedBy(entries: readonly InboxEntry[], poster: Hex, kind: string, feedId: Hex, round: bigint): boolean {
  return entries.some(
    (e) => e.post.kind === kind && same(e.poster, poster) && same(e.post.feedId, feedId) && e.post.round === round,
  );
}

// ------------------------------------------------------------------------------------------
// Committee
// ------------------------------------------------------------------------------------------

export type CommitteeAction =
  | { kind: "deal"; feedId: Hex; round: bigint; closeHeight: bigint }
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

  // Deal the next round of a feed once its latest round has closed, if it is our turn.
  for (const feedId of args.feeds) {
    const latest = latestOpen(cfg, entries, feedId);
    if (latest && height <= latest.open.closeHeight) continue;
    const next = (latest?.open.round ?? 0n) + 1n;
    if (dealerFor(next) === member) actions.push({ kind: "deal", feedId, round: next, closeHeight: height + args.roundBlocks });
  }

  // Release our share of every closed round we have a delivery for and have not released.
  for (const { open } of roundOpens(cfg, entries)) {
    if (height <= open.closeHeight) continue;
    if (postedBy(entries, me, "share", open.feedId, open.round)) continue;
    const delivered = entries.some(
      (e) =>
        e.post.kind === "delivery" &&
        e.post.member === member &&
        same(e.poster, cfg.committee[open.dealer]) &&
        same(e.post.feedId, open.feedId) &&
        e.post.round === open.round,
    );
    if (delivered) actions.push({ kind: "release", open });
  }
  return actions;
}

// ------------------------------------------------------------------------------------------
// Reporter
// ------------------------------------------------------------------------------------------

/** Rounds `reporter` should report in now: each feed's latest open round, still open, not yet reported. */
export function planReporter(args: {
  cfg: RoundConfig;
  entries: readonly InboxEntry[];
  reporter: Hex;
  height: bigint;
  feeds: readonly Hex[];
  /** Blocks of slack kept before the close, so the report lands in time. */
  marginBlocks: bigint;
}): RoundOpen[] {
  const out: RoundOpen[] = [];
  for (const feedId of args.feeds) {
    const latest = latestOpen(args.cfg, args.entries, feedId);
    if (!latest) continue;
    if (args.height + args.marginBlocks > latest.open.closeHeight) continue;
    if (postedBy(args.entries, args.reporter, "report", feedId, latest.open.round)) continue;
    out.push(latest.open);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Sequencer
// ------------------------------------------------------------------------------------------

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
