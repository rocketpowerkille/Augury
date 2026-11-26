// Fail if a QoreScan CBOM lists any quantum-vulnerable cryptography.
//
//   npx --yes @qorechain/qorescan@0.1.0 solidity contracts/src --out cbom.json
//   node scripts/check-cbom.mjs cbom.json
//
// QoreScan classifies each algorithm it finds (for example `post-quantum` for ML-DSA-87,
// `symmetric` for SHA-256, `quantum-vulnerable` for ECDSA secp256k1 from `ecrecover`). Augury's
// contracts must authorize with ML-DSA-87 only, so any quantum-vulnerable entry fails CI.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-cbom.mjs <cbom.json>");
  process.exit(2);
}

const cbom = JSON.parse(readFileSync(file, "utf8"));
if (cbom.bomFormat !== "CycloneDX") {
  console.error(`${file} is not a CycloneDX BOM`);
  process.exit(2);
}

const classOf = (c) => (c.properties ?? []).find((p) => p.name === "qorescan:classification")?.value;
const where = (c) => (c.evidence?.occurrences ?? []).map((o) => o.location).filter(Boolean);
const algorithms = (cbom.components ?? []).filter((c) => classOf(c) !== undefined);

for (const c of algorithms) console.log(`${classOf(c).padEnd(18)} ${c.name}  (${[...new Set(where(c))].join(", ")})`);
const vulnerable = algorithms.filter((c) => classOf(c) === "quantum-vulnerable");
if (algorithms.length === 0) {
  console.error("QoreScan found no cryptography at all; the scan probably ran on the wrong folder");
  process.exit(1);
}
if (vulnerable.length > 0) {
  console.error(`quantum-vulnerable cryptography found: ${vulnerable.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log(`ok: ${algorithms.length} algorithms, none quantum-vulnerable`);
