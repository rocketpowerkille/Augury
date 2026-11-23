import { mldsa87 } from "@qorechain/pqc";
import {
  open,
  recipientOf,
  seal,
  sealKeysFromSeed,
  type SealKeyPair,
  type SealRecipient,
} from "@qorechain/qoreseal";
import { encodeAddress, encodeBytes32, encodeUint } from "./abi.ts";
import { concatBytes } from "./bytes.ts";
import {
  batchMessage,
  decodeReportMessage,
  REPORT_MESSAGE_LENGTH,
  reportMessage,
  type BatchHeader,
  type Domain,
  type Report,
} from "./messages.ts";

/**
 * Signing and sealing for Augury, built only on the official QoreChain kits:
 * ML-DSA-87 from @qorechain/pqc and ML-KEM-1024 envelopes from QoreSeal.
 *
 * Security-relevant: changes here need review by the team's PQC/security member.
 */

/**
 * Algorithm id pqcKeyStatus reports for ML-DSA-87 keys: `AlgorithmDilithium5 = 1` in
 * @qorechain/sdk 0.14.0. Pass it to AuguryHub's constructor as `mldsaAlgorithmId`.
 */
export const ML_DSA_87_ALGORITHM_ID = 1;

export const ML_DSA_87_SIGNATURE_LENGTH = 4627;
export const ML_DSA_87_PUBLIC_KEY_LENGTH = 2592;

/** QoreSeal purpose string for sealed reports. */
export const REPORT_SEAL_PURPOSE = "augury-report";

export interface SignedReport extends Report {
  signature: Uint8Array;
}

export interface SigningKey {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

// ------------------------------------------------------------------------------------------
// ML-DSA-87 signatures
// ------------------------------------------------------------------------------------------

/** A new ML-DSA-87 key pair. Pass a 32-byte seed only in tests. */
export function generateSigningKey(seed?: Uint8Array): SigningKey {
  return mldsa87.keygen(seed);
}

export function signReport(secretKey: Uint8Array, d: Domain, report: Report): SignedReport {
  return { ...report, signature: mldsa87.sign(secretKey, reportMessage(d, report)) };
}

export function verifyReport(publicKey: Uint8Array, d: Domain, report: SignedReport): boolean {
  return mldsa87.verify(publicKey, reportMessage(d, report), report.signature);
}

export function signBatch(secretKey: Uint8Array, d: Domain, header: BatchHeader): Uint8Array {
  return mldsa87.sign(secretKey, batchMessage(d, header));
}

export function verifyBatch(
  publicKey: Uint8Array,
  d: Domain,
  header: BatchHeader,
  signature: Uint8Array,
): boolean {
  return mldsa87.verify(publicKey, batchMessage(d, header), signature);
}

// ------------------------------------------------------------------------------------------
// Round keys and sealed reports (ML-KEM-1024 + X25519 via QoreSeal)
// ------------------------------------------------------------------------------------------

/** The round's QoreSeal key pairs, derived from its 32-byte seed. */
export function roundKeys(seed: Uint8Array): SealKeyPair {
  return sealKeysFromSeed(seed);
}

/** The public half of a round key, published when the round opens. */
export function roundRecipient(keys: SealKeyPair): SealRecipient {
  return recipientOf(keys);
}

const AAD_DOMAIN = new TextEncoder().encode("augury-report-aad-v1");

/** Authenticated data binding a sealed report to its domain, feed and round. */
export function reportAad(d: Domain, feedId: Report["feedId"], round: bigint): Uint8Array {
  return concatBytes(
    AAD_DOMAIN,
    encodeUint(d.chainId),
    encodeAddress(d.hub),
    encodeBytes32(feedId),
    encodeUint(round, 64),
  );
}

export interface SealReportArgs {
  /** Native QoreChain chain id used by QoreSeal, e.g. `qorechain-diana`. */
  sealChainId: string;
  domain: Domain;
  recipient: SealRecipient;
  report: SignedReport;
}

/** Seal a signed report to the round key. The envelope reveals nothing about the price. */
export function sealReport({ sealChainId, domain, recipient, report }: SealReportArgs): Uint8Array {
  if (report.signature.length !== ML_DSA_87_SIGNATURE_LENGTH) {
    throw new Error(`signature must be ${ML_DSA_87_SIGNATURE_LENGTH} bytes`);
  }
  return seal({
    chainId: sealChainId,
    purpose: REPORT_SEAL_PURPOSE,
    recipients: [recipient],
    plaintext: concatBytes(reportMessage(domain, report), report.signature),
    aad: reportAad(domain, report.feedId, report.round),
  });
}

export interface OpenReportArgs {
  sealChainId: string;
  domain: Domain;
  keys: SealKeyPair;
  envelope: Uint8Array;
  /** The feed and round this envelope was posted for. */
  feedId: Report["feedId"];
  round: bigint;
}

/**
 * Open a sealed report with the round key. Throws if the envelope was sealed for another
 * feed, round or domain, or if its contents are malformed. The signature is not checked
 * here; call `verifyReport` with the reporter's registered key.
 */
export function openReport(args: OpenReportArgs): SignedReport {
  const plaintext = open({
    chainId: args.sealChainId,
    purpose: REPORT_SEAL_PURPOSE,
    envelope: args.envelope,
    keys: args.keys,
    aad: reportAad(args.domain, args.feedId, args.round),
  });
  if (plaintext.length !== REPORT_MESSAGE_LENGTH + ML_DSA_87_SIGNATURE_LENGTH) {
    throw new Error("sealed report has the wrong length");
  }
  const report = decodeReportMessage(args.domain, plaintext.subarray(0, REPORT_MESSAGE_LENGTH));
  if (report.feedId.toLowerCase() !== args.feedId.toLowerCase() || report.round !== args.round) {
    throw new Error("sealed report is for another feed or round");
  }
  return { ...report, signature: plaintext.slice(REPORT_MESSAGE_LENGTH) };
}
