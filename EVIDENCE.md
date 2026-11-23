# Evidence

Every claim Augury makes about the `qorechain-diana` testnet is listed here with its proof. Nothing is deployed yet, so the tables are empty. Rows are added only with real transaction hashes and addresses.

## Read-only checks

Checks that read the chain with `eth_call` only. They send no transaction, so they have no hash; anyone can rerun them.

| Date | Check | Result | Rerun |
|---|---|---|---|
| 2026-11-23 | Chain adapters read the testnet: rollup info, inbox head, and inbox posts 12..14 of the public rollup `vigil-pay-1` read back through the RDK and verified against the chain's inbox accumulator; EVM block height; `pqcKeyStatus` through the EVM kit | All reads succeeded; the three posts were correctly skipped as non-Augury payloads | `cd packages/chain && node scripts/probe.ts` |
| 2026-11-23 | `pqcKeyStatus` (0x0A02) on `qorechain-diana` for an account with a registered ML-DSA-87 key (the public BIP-39 test account `0x9858EfFD232B4033E47d90003D41EC34EcaEda94`, read during a dry run of `setup-account.ts`) | `registered = true`, algorithm id 1, matching the `ML_DSA_87_ALGORITHM_ID` AuguryHub is deployed with | `node packages/node/scripts/setup-account.ts --account <any account file>` (dry run) |
| 2026-11-23 | `pqcVerify` (0x0A01) on `qorechain-diana` (EVM chain id 9800) accepts an ML-DSA-87 signature made with `@qorechain/pqc` 0.2.3, and rejects it over a changed message | valid / invalid, as expected. `eth_estimateGas` for one call: 321,430 gas including the 21,000 base and about 7.4 KB of calldata | `pnpm --filter @augury/shared check:precompile` |

## Accounts

| Role | Address | PQC key registered (tx) |
|---|---|---|
| Sequencer | | |
| Committee member 1 | | |
| Committee member 2 | | |
| Committee member 3 | | |
| Reporter(s) | | |

## Contracts

| Contract | Address | Deploy tx |
|---|---|---|

## Protocol Builders requirements

| Requirement | Proof |
|---|---|
| ML-DSA-signed batches | |
| Withdrawal | |
| Verified settlement receipt | |
| Watchtower | |
| ML-KEM data protection | |
| Threat model | [THREAT_MODEL.md](THREAT_MODEL.md) |

## Drills

| Date | What we did | Result | Transactions |
|---|---|---|---|
