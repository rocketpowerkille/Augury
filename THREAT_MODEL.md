# Augury threat model

> **Status.** Last security review: 2026-11-26 (signing, sealing, key handling, the fraud proof and settlement anchoring; see section 6). It changes with every change to those parts.
>
> **Deployed.** The fixes for T14 and T15 are live in AuguryHub v3 `0x74a9cf2c448328d0bbde986228c4ca340ff04054` on `qorechain-diana` (see EVIDENCE.md). The superseded v2 hub `0x49bc74d9ad38f805f52984cc2f6d338429b4d3bd` still has both flaws; `deployments/testnet.json` and the nodes now use v3.

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
| T7 | Reporter copies others' values | Reports are sealed with QoreSeal (ML-KEM-1024 + X25519) to the round key until the round closes | Implemented (shared, reporter); live on testnet (EVIDENCE.md, "Live rounds") |
| T8 | Reporter withholds a value after seeing others (commit-reveal hole) | The committee releases the round key, not the reporters | Implemented (committee); live on testnet (EVIDENCE.md, "Live rounds") |
| T9 | Committee member releases a wrong key part | Parts are checked against SHA-256 commitments published when the round opens | Implemented (shared) |
| T10 | Reporter exits just before being caught | Exit delay must be at least the challenge window; inactive status is judged at the batch's post time | Implemented (AuguryHub) |
| T11 | Harvest-now-decrypt-later on private feeds | Values sealed with QoreSeal epoch keys, distributed with ML-KEM-1024 to subscribers' registered KEM keys; every change of subscribers rotates the key, so a removed subscriber cannot read later values and a new one cannot read earlier ones | Implemented (shared, PrivateFeeds); live on testnet (EVIDENCE.md, "Private feeds") |
| T19 | A private value is guessed from its public commitment, or a subscriber is shown a value other than the one published | The commitment is SHA-256 over the domain, feed, round, value, time and a 32-byte salt sealed with the value; the publication (commitment and QoreSeal ciphertext hash) is signed with the publisher's ML-DSA-87 key and checked with `pqcVerify`; subscribers check the blob hash, feed, round and commitment before using a value | Implemented (shared, PrivateFeeds) |
| T12 | Sequencer posts a wrong batch but hides its reports, so nobody can build a fraud proof | `postBatch` takes the signed reports in calldata and the hub derives the report root from them, so every batch's reports are public | Implemented (AuguryHub) |
| T13 | A report's signature is public before the close (rollup posts are capped at 6,144 bytes, so it cannot ride inside the sealed envelope), and prices are guessable, so an observer could test candidate prices against it | The signed message includes 32 random bytes of salt that travel only inside the sealed envelope; without them a guessed price cannot be checked against the signature. Two different signed reports for one round are equivocation even at the same price | Implemented (AuguryHub, shared) |
| T14 | A reporter in an honest batch gets the honest sequencer slashed: it is slashed for equivocation (so it looks inactive) or rotates its ML-DSA key on chain (so its report no longer verifies) during the challenge window, then challenges the batch and collects half the bond. Slashing itself costs 1 QOR and returns 0.5; the bond pays 5. Rotating costs nothing | AuguryHub pins each reporter's key when it starts staking (`reporterKeys`) and checks reports and equivocation evidence against the pinned key. Activity is judged from recorded times (`activeSince`, `exitRequestedAt`, `slashedAt`), not the current stake. A slashed reporter can never stake again. The off-chain chain view reads the pinned key too, so the sequencer never accepts a report the hub would reject | Fixed with regression tests; live in hub v3 |
| T15 | A reporter's stake drops below the minimum when a batch is posted, then is topped up during the challenge window, so its fraudulent inclusion can no longer be proven | `activeSince` records when the stake reached the minimum; a report counts only if that was at or before the batch's post time | Fixed with a regression test; live in hub v3 |
| T16 | An honest reporter is slashed for equivocation because its node signs a round twice: a post that landed was reported as failed, or the inbox read lagged, and the retry built a new report with a fresh salt | The reporter node keeps the posts it signed for each feed and round (`ReportBook`) and resends exactly those bytes. An identical repost is a duplicate, not equivocation, both off chain and in `reportEquivocation` | Implemented (node); the book survives restarts (gap 14) |
| T17 | One ML-DSA-87 key signs for several protocols: the sequencer's key signs Augury batches, hybrid native transactions and RDK settlement anchors, so a signature made for one might be accepted by another | Each format starts with a different fixed prefix: Augury messages with a 32-byte keccak tag, RDK v2 anchors with the ASCII domain `qorechain-multilayer-anchor-v2` and the length-prefixed chain id, native transactions with the chain's sign document. None of them can parse as another | Reviewed; accepted |
| T18 | An invalid settlement receipt is cited as evidence | `settle.ts` verifies every receipt against live chain state and exits with an error when it does not verify | Implemented (node) |

## 5. Known gaps and open questions

1. **Omitted reports are not yet provable on the EVM.** The inbox lives on QoreChain's native lane, which AuguryHub cannot read. The watchtower can detect an omission, but slashing for it needs a bridge from inbox data to the hub. Until then, omission is an alert, not a slashable fault.
2. **Report freshness is not enforced on-chain.** `observedAt` is signed but not checked against the round's time window.
3. **Two colluding committee members can open reports early** and leak them to a reporter. A larger threshold or time-lock encryption would reduce this.
4. **Resolved in code: no single member knows a round's whole key.** Rounds now have two dealers, each knowing only its own seed, and reports are sealed to both keys (section 7). Not yet run on testnet: the live rounds in EVIDENCE.md used one dealer.
5. **Challenger rewards are pushed** to the `rewardTo` address the challenger names. A caller that cannot receive QOR can still challenge by naming an account that can.
6. **The ML-DSA-87 algorithm id** returned by `pqcKeyStatus` is a deploy-time parameter. It is 1: the official SDK defines `AlgorithmDilithium5 = 1`, and `pqcKeyStatus` on `qorechain-diana` reports 1 for a registered ML-DSA-87 key (see EVIDENCE.md).
7. **`getPrice` is optimistic.** It returns batches still inside their challenge window. Consumers that need certainty must use `getFinalPrice`.
8. **A majority of dishonest reporters moves the median.** The median tolerates a minority of bad reporters, not a majority.
9. **Manipulated source markets** are reported faithfully by honest reporters.
10. **Liveness.** If fewer than two committee members are online, a round cannot be opened and is skipped; consumers see an older timestamp.
11. **Slashed funds not paid to challengers stay locked in the hub.** There is deliberately no admin key to move them.
12. **Testnet only, not audited.**
13. **A compromised reporter key stays pinned until the reporter exits.** Rotating the key on chain does not change the key AuguryHub checks reports against (that is what stops T14). A reporter whose key leaks must sign `requestExit` with its current key; until then, whoever holds the old key can sign reports or equivocation evidence in its name, and the stake can be slashed.
14. **Resolved: the reporter's signed-report book is kept on disk.** It is saved before each post is sent (`state/`, git-ignored, owner-only file mode), so a node that restarts mid-round resends its report instead of signing again. The file holds sealed salts until each round closes; protect it like a key file.
15. **Resolved: the watchtower judges activity at the batch's post time.** It reads `isActiveAt(reporter, postedAt)` from the hub, the rule the fraud proof applies, so it no longer sends challenges the hub rejects.
16. **The on-chain median can overflow.** For an even count, the median is the mean of the two middle values, and their sum can exceed `int256`. Then `challengeBatch` reverts and the batch cannot be challenged. This needs at least half of a round's reporters to sign absurd prices, which is already outside assumption 7.

## 6. Security review log

| Date | Scope | Findings |
|---|---|---|
| 2026-11-26 | Report signing and salting, QoreSeal sealing (hybrid for reports, ML-KEM-only for share deliveries), 2-of-3 seed sharing and commitments, the round processor, AuguryHub's signature checks, fraud proof and equivocation proof, the PQC precompile wrappers, settlement anchoring and receipts | T14 and T15 fixed in the contract; T16 fixed in the reporter node; T17 reviewed and accepted; T18 fixed in `settle.ts`; gaps 13 to 16 added. Confirmed sound: the CSPRNG salt; the round key is checked against the committed seed before any report is opened; canonical re-encoding of decoded reports; domain separation by tag, chain id, hub, feed and round; the precompile wrappers fail closed. Prepared with an AI assistant (see AI_USAGE.md) and owned by the team's PQC/security member |

## 7. Two dealers per round

With one dealer, that member knows the round's seed alone. True distributed key generation for ML-KEM is open research and not offered by the kits, so Augury uses a simpler construction with the same kits. Built in `packages/committee`, `packages/shared` (`round.ts`, `crypto.ts`, inbox format version 3) and `packages/node`; tested end to end in `packages/e2e/test/two-dealer.e2e.test.ts`:

1. **Two dealers per round.** Member `round mod 3` deals layer 0 and declares two layers; member `(round + 1) mod 3` then deals layer 1 with the same close height. Each layer has an independent seed, its 2-of-3 parts with commitments, and sealed deliveries bound to the layer. Reports count only once both opens are on the inbox.
2. **Reports sealed twice.** A reporter seals its signed message to the layer 0 key, then seals that envelope to the layer 1 key under a separate QoreSeal purpose. Measured with QoreSeal 0.1.0: one layer is 2,008 bytes and two layers are 3,728 bytes, inside the 6,144-byte post limit.
3. **Opening needs both seeds.** Each dealer knows only its own seed, so neither can open a report before the close. Opening early needs both seeds, which takes both dealers or two members releasing early: the same two-member collusion threshold as gap 3, with no single member able to cheat alone.
4. **Cost.** One more round-open post and its deliveries per round, about 1,720 more bytes per report, and a second decryption for the sequencer and watchtower. Nothing changes on chain: AuguryHub never sees the envelopes.

The end-to-end test checks that either dealer's whole seed, alone or used twice, cannot open a report, that both seeds can, and that a report sealed to one key only is rejected. This removes gap 4 without new cryptography. Gap 3 (two colluding members) remains, and needs a larger committee or time-lock encryption.
