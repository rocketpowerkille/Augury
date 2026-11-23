import { median, parsePrice } from "@augury/shared";

/**
 * Public price sources. Each reporter fetches every source it is configured with and
 * reports the median of the answers it got, so one broken or manipulated exchange does not
 * decide the reporter's value.
 */

export type FeedName = "fBTC/USD" | "fETH/USD";

export interface PriceSource {
  name: string;
  /** Price with 8 decimals. */
  fetchPrice(feed: FeedName, fetchFn: typeof fetch): Promise<bigint>;
}

const ASSET: Record<FeedName, "BTC" | "ETH"> = { "fBTC/USD": "BTC", "fETH/USD": "ETH" };

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** Read a field path from untrusted JSON; throws if it is missing. */
function pick(value: unknown, path: (string | number)[]): unknown {
  let v: unknown = value;
  for (const key of path) {
    if (v === null || typeof v !== "object") throw new Error(`missing ${path.join(".")}`);
    v = (v as Record<string | number, unknown>)[key];
  }
  if (v === undefined) throw new Error(`missing ${path.join(".")}`);
  return v;
}

/** Exchange prices come as decimal strings with up to 8+ decimals; keep 8. */
function toPrice(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("price is not a number");
  const text = String(value);
  const [whole, frac = ""] = text.split(".");
  const price = parsePrice(frac ? `${whole}.${frac.slice(0, 8)}` : whole!);
  if (price <= 0n) throw new Error("price is not positive");
  return price;
}

export const coinbase: PriceSource = {
  name: "coinbase",
  async fetchPrice(feed, fetchFn) {
    const json = await getJson(fetchFn, `https://api.coinbase.com/v2/prices/${ASSET[feed]}-USD/spot`);
    return toPrice(pick(json, ["data", "amount"]));
  },
};

export const kraken: PriceSource = {
  name: "kraken",
  async fetchPrice(feed, fetchFn) {
    const pair = ASSET[feed] === "BTC" ? "XBTUSD" : "ETHUSD";
    const json = await getJson(fetchFn, `https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    const result = pick(json, ["result"]);
    const first = Object.values(result as Record<string, unknown>)[0];
    // "c" is the last trade: [price, lot volume].
    return toPrice(pick(first, ["c", 0]));
  },
};

export const binance: PriceSource = {
  name: "binance",
  async fetchPrice(feed, fetchFn) {
    const json = await getJson(fetchFn, `https://api.binance.com/api/v3/ticker/price?symbol=${ASSET[feed]}USDT`);
    return toPrice(pick(json, ["price"]));
  },
};

export const DEFAULT_SOURCES: readonly PriceSource[] = [coinbase, kraken, binance];

export interface Observation {
  price: bigint;
  used: string[];
  failed: { source: string; error: string }[];
}

/** Median of the sources that answered. Throws if fewer than `minSources` answered. */
export async function observePrice(
  feed: FeedName,
  opts: { sources?: readonly PriceSource[]; minSources?: number; fetchFn?: typeof fetch } = {},
): Promise<Observation> {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const fetchFn = opts.fetchFn ?? fetch;
  const results = await Promise.allSettled(sources.map((s) => s.fetchPrice(feed, fetchFn)));

  const prices: bigint[] = [];
  const used: string[] = [];
  const failed: Observation["failed"] = [];
  results.forEach((r, i) => {
    const name = sources[i]!.name;
    if (r.status === "fulfilled") {
      prices.push(r.value);
      used.push(name);
    } else {
      failed.push({ source: name, error: String(r.reason instanceof Error ? r.reason.message : r.reason) });
    }
  });

  const minSources = opts.minSources ?? 2;
  if (prices.length < minSources) {
    throw new Error(`only ${prices.length} of ${sources.length} sources answered for ${feed}`);
  }
  return { price: median(prices), used, failed };
}
