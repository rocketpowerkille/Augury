import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bytesToHex,
  encodePost,
  MAX_POST_BYTES,
  FEEDS,
  generateSigningKey,
  hexToBytes,
  openReport,
  roundKeys,
  verifyReport,
  type Domain,
  type RoundOpen,
} from "@augury/shared";
import { binance, buildReportPosts, coinbase, kraken, observePrice } from "../src/index.ts";

const domain: Domain = { chainId: 9800n, hub: "0x1111111111111111111111111111111111111111" };

/** A fetch stub answering from a URL-substring table. */
function stubFetch(table: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    return Response.json(hit[1]);
  }) as typeof fetch;
}

const answers = {
  "coinbase.com/v2/prices/BTC-USD": { data: { amount: "97123.45" } },
  "kraken.com/0/public/Ticker?pair=XBTUSD": { result: { XXBTZUSD: { c: ["97100.123456789", "0.1"] } } },
  "binance.com/api/v3/ticker/price?symbol=BTCUSDT": { price: "97200.00000000" },
};

describe("price sources", () => {
  it("parse each exchange's answer to 8 decimals", async () => {
    const f = stubFetch(answers);
    assert.equal(await coinbase.fetchPrice("fBTC/USD", f), 9712345000000n);
    assert.equal(await kraken.fetchPrice("fBTC/USD", f), 9710012345678n);
    assert.equal(await binance.fetchPrice("fBTC/USD", f), 9720000000000n);
  });

  it("report the median of the sources that answered", async () => {
    const obs = await observePrice("fBTC/USD", { fetchFn: stubFetch(answers) });
    assert.equal(obs.price, 9712345000000n);
    assert.deepEqual(obs.used, ["coinbase", "kraken", "binance"]);
  });

  it("tolerate one failing source", async () => {
    const { ["binance.com/api/v3/ticker/price?symbol=BTCUSDT"]: _, ...two } = answers;
    const obs = await observePrice("fBTC/USD", { fetchFn: stubFetch(two) });
    assert.equal(obs.used.length, 2);
    assert.equal(obs.failed[0]?.source, "binance");
  });

  it("refuse to report with too few sources", async () => {
    await assert.rejects(observePrice("fBTC/USD", { fetchFn: stubFetch({}) }), /only 0 of 3/);
  });

  it("reject malformed answers", async () => {
    const f = stubFetch({ "coinbase.com": { data: { amount: "-1" } } });
    await assert.rejects(coinbase.fetchPrice("fBTC/USD", f));
  });
});

describe("buildReportPost", () => {
  it("produces a sealed report the round key opens and the reporter key verifies", () => {
    const key = generateSigningKey();
    const seed = new Uint8Array(32).fill(3);
    const keys = roundKeys(seed);
    const open: RoundOpen = {
      kind: "open",
      feedId: FEEDS["fBTC/USD"],
      round: 9n,
      dealer: 0,
      closeHeight: 50n,
      mlkemPublicKey: bytesToHex(keys.mlkemPublicKey),
      x25519PublicKey: bytesToHex(keys.x25519PublicKey),
      commitments: [`0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`],
    };
    const reporter = "0x2222222222222222222222222222222222222222" as const;
    const [sealed, signature] = buildReportPosts({
      domain,
      sealChainId: "qorechain-diana",
      reporter,
      secretKey: key.secretKey,
      open,
      price: 9712345000000n,
      observedAt: 1764000000n,
    });

    const opened = openReport({
      sealChainId: "qorechain-diana",
      domain,
      keys,
      envelope: hexToBytes(sealed.envelope),
      feedId: open.feedId,
      round: open.round,
    });
    assert.equal(opened.price, 9712345000000n);
    assert.equal(opened.reporter, reporter);
    assert.equal(verifyReport(key.publicKey, domain, { ...opened, signature: hexToBytes(signature.signature) }), true);
    // Both posts fit the chain's per-post limit.
    assert.ok(encodePost(sealed).length <= MAX_POST_BYTES);
    assert.ok(encodePost(signature).length <= MAX_POST_BYTES);
  });
});
