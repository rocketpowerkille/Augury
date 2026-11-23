import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEEDS, generateSigningKey, type Hex, type RoundConfig } from "@augury/shared";
import { buildBatch } from "../src/index.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const cfg: RoundConfig = {
  domain: { chainId: 9800n, hub: addr(0x4b) },
  sealChainId: "qorechain-diana",
  committee: [addr(0xc0), addr(0xc1), addr(0xc2)],
  minReports: 3,
  maxReports: 16,
};

describe("buildBatch", () => {
  it("signs nothing when the round is not ready", () => {
    const view = { reporterKey: () => undefined, isActive: () => false };
    const result = buildBatch(cfg, view, [], FEEDS["fBTC/USD"], 1n, generateSigningKey().secretKey);
    assert.equal(result.outcome.status, "no-open");
    assert.equal(result.batch, undefined);
  });
});
