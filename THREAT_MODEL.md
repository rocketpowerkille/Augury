# Augury threat model

> **Draft.** Written alongside the first contract and shared code. It still needs review by the team's PQC/security member, and it will change as the rollup, committee and watchtower are built.

## 1. What we protect

| Asset | Why it matters |
|---|---|
| Published prices | Consumer contracts act on them: liquidations, rebalances, agent spending |
| Reporter stakes and the sequencer bond | Funds at risk of theft or of unfair slashing |
| Sealed reports before the round closes | If revealed early, reporters can copy each other |
| Private feed values | Confidential data with a long secrecy lifetime |

## 2. Actors

| Actor | Can do | Trusted for |
|---|---|---|
| Reporter | Sign and post a sealed report each round | Nothing individually; only an honest majority per round |
| Key committee (3 members) | Hold parts of each round's key seed; release them at close | Not releasing early (2 colluding members could) |
| Sequencer | Decrypt rounds, post signed median batches | Liveness only; correctness is enforced by fraud proofs |
| Watchtower | Re-check every batch, submit fraud proofs | Nothing; anyone can run one |
| Consumer contract | Read prices | n/a |
| Attacker | Holds classical (secp256k1) keys, possibly a quantum computer; can copy all public data | n/a |

## 3. Assumptions

1. ML-DSA-87 (FIPS 204) signatures cannot be forged, including by a quantum attacker.
2. ML-KEM-1024 (FIPS 203), as used by QoreSeal, keeps sealed data confidential against a quantum attacker.
3. QoreChain's `pqcVerify` (0x0A01) and `pqcKeyStatus` (0x0A02) precompiles behave as documented. AuguryHub fails closed if they are inactive or return malformed data.
4. QoreChain orders the rollup inbox and cannot be bribed to reorder it.
5. At least one honest watchtower is online during each challenge window.
6. Fewer than two of the three committee members collude with a reporter.
7. More than half of the reporters in each round report honestly.

## 4. Threats and mitigations

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Forged report or batch using a stolen or quantum-recovered classical key | Reports and batches are authorized only by ML-DSA-87 signatures, checked with `pqcVerify` against keys read with `pqcKeyStatus`. No `ecrecover` anywhere | Implemented (AuguryHub) |
| T2 | Stake or bond stolen with a classical key | Exits and withdrawals need an ML-DSA-87 signature, with a per-account nonce and an exit delay | Implemented (AuguryHub) |
| T3 | Signature replayed in another round, feed, chain or deployment | Every message binds the tag, chain id, hub address, feed id and round (or nonce) | Implemented (AuguryHub, shared) |
| T4 | Sequencer posts a wrong median | One-step fraud proof recomputes the median from the signed reports; the bond is slashed | Implemented (AuguryHub) |
| T5 | Sequencer includes an invalid, inactive or duplicate report | Fraud proof checks every included report | Implemented (AuguryHub) |
| T6 | Reporter signs two prices in one round | Equivocation proof slashes the reporter's stake | Implemented (AuguryHub) |
| T7 | Reporter copies others' values | Reports are sealed to the round key until the round closes | Designed; sealing not yet implemented |
| T8 | Reporter withholds a value after seeing others (commit-reveal hole) | The committee releases the round key, not the reporters | Designed; committee not yet implemented |
| T9 | Committee member releases a wrong key part | Parts are checked against SHA-256 commitments published when the round opens | Implemented (shared) |
| T10 | Reporter exits just before being caught | Exit delay must be at least the challenge window; inactive status is judged at the batch's post time | Implemented (AuguryHub) |
| T11 | Harvest-now-decrypt-later on private feeds | Values sealed with ML-KEM-1024 via QoreSeal epoch keys | Planned |
| T12 | Sequencer posts a wrong batch but hides its reports, so nobody can build a fraud proof | `postBatch` takes the signed reports in calldata and the hub derives the report root from them, so every batch's reports are public | Implemented (AuguryHub) |

## 5. Known gaps and open questions

1. **Omitted reports are not yet provable on the EVM.** The inbox lives on QoreChain's native lane, which AuguryHub cannot read. The watchtower can detect an omission, but slashing for it needs a bridge from inbox data to the hub. Until then, omission is an alert, not a slashable fault.
2. **Report freshness is not enforced on-chain.** `observedAt` is signed but not checked against the round's time window.
3. **Two colluding committee members can open reports early** and leak them to a reporter. A larger threshold or time-lock encryption would reduce this.
4. **The member who deals a round's seed knows it alone.** The planned design rotates the dealer each round, so the 2-of-3 guarantee holds against the other members, not against that round's dealer. Removing the dealer needs distributed key generation for ML-KEM, which is open work for our PQC member.
5. **Challenger rewards are pushed** to the `rewardTo` address the challenger names. A caller that cannot receive QOR can still challenge by naming an account that can.
6. **The ML-DSA-87 algorithm id** returned by `pqcKeyStatus` is a deploy-time parameter. It is 1: the official SDK defines `AlgorithmDilithium5 = 1`, and `pqcKeyStatus` on `qorechain-diana` reports 1 for a registered ML-DSA-87 key (see EVIDENCE.md).
7. **`getPrice` is optimistic.** It returns batches still inside their challenge window. Consumers that need certainty must use `getFinalPrice`.
8. **A majority of dishonest reporters moves the median.** The median tolerates a minority of bad reporters, not a majority.
9. **Manipulated source markets** are reported faithfully by honest reporters.
10. **Liveness.** If fewer than two committee members are online, a round cannot be opened and is skipped; consumers see an older timestamp.
11. **Slashed funds not paid to challengers stay locked in the hub.** There is deliberately no admin key to move them.
12. **Testnet only, not audited.**
