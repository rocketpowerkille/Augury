import { readFileSync } from "node:fs";
import type { Hex, RoundConfig } from "@augury/shared";
import { getNetwork } from "@qorechain/sdk";

/** Endpoints and ids of the network Augury runs on. */
export interface Network {
  /** Native chain id, e.g. `qorechain-diana`. */
  chainId: string;
  /** EVM chain id (EIP-155). */
  evmChainId: bigint;
  rest: string;
  rpc: string;
  evmRpc: string;
}

/** QoreChain's public testnet, from the official SDK preset. */
export function testnet(): Network {
  const n = getNetwork("testnet");
  if (n.evmChainId === undefined) throw new Error("testnet preset has no EVM chain id");
  return {
    chainId: n.chainId,
    evmChainId: BigInt(n.evmChainId),
    rest: n.endpoints.rest,
    rpc: n.endpoints.rpc,
    evmRpc: n.endpoints.evmRpc,
  };
}

/**
 * What a deployment of Augury consists of. Written by the deploy script to
 * `deployments/<network>.json` and read by every role.
 */
export interface Deployment {
  network: string;
  /** AuguryHub address on the EVM lane. */
  hub: Hex;
  /** The RDK rollup whose inbox carries rounds, reports and shares. */
  rollupId: string;
  /** EVM addresses of key committee members 0, 1 and 2. */
  committee: [Hex, Hex, Hex];
  sequencer: Hex;
  minReports: number;
  maxReports: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseDeployment(raw: unknown): Deployment {
  if (raw === null || typeof raw !== "object") throw new Error("deployment must be an object");
  const d = raw as Record<string, unknown>;
  const address = (v: unknown, name: string): Hex => {
    if (typeof v !== "string" || !ADDRESS.test(v)) throw new Error(`deployment.${name} must be a 0x address`);
    return v.toLowerCase() as Hex;
  };
  const count = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`deployment.${name} must be a positive integer`);
    return v;
  };
  if (typeof d.network !== "string") throw new Error("deployment.network must be a string");
  if (typeof d.rollupId !== "string" || d.rollupId.length < 3) throw new Error("deployment.rollupId must be a rollup id");
  if (!Array.isArray(d.committee) || d.committee.length !== 3) throw new Error("deployment.committee must list 3 addresses");
  const minReports = count(d.minReports, "minReports");
  const maxReports = count(d.maxReports, "maxReports");
  if (maxReports < minReports) throw new Error("deployment.maxReports must be at least minReports");
  return {
    network: d.network,
    hub: address(d.hub, "hub"),
    rollupId: d.rollupId,
    committee: [
      address(d.committee[0], "committee[0]"),
      address(d.committee[1], "committee[1]"),
      address(d.committee[2], "committee[2]"),
    ],
    sequencer: address(d.sequencer, "sequencer"),
    minReports,
    maxReports,
  };
}

export function loadDeployment(path: string): Deployment {
  return parseDeployment(JSON.parse(readFileSync(path, "utf8")));
}

/** The round rules for this deployment. */
export function roundConfig(net: Network, d: Deployment): RoundConfig {
  return {
    domain: { chainId: net.evmChainId, hub: d.hub },
    sealChainId: net.chainId,
    committee: d.committee,
    minReports: d.minReports,
    maxReports: d.maxReports,
  };
}
