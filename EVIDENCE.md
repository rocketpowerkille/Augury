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

Every account registered an ML-DSA-87 key with a proof of possession (`MsgRegisterPQCKeyV2`, algorithm 1). Committee members also published an ML-KEM-1024 key in the chain's KEM registry. Native transaction hashes; all on `qorechain-diana`, 2026-11-24.

| Role | Address (native / EVM) | ML-DSA-87 key registered | ML-KEM-1024 key published |
|---|---|---|---|
| Sequencer, rollup creator | `qor1yrnfky7jq8tp33ftr6qrh43jp3gsx7a6jy6stv` / `0x20e69B13d201d618c52B1e803Bd6320C51037bbA` | `4664D5320B06ED7FE7430F94CACE75E2D92D4D57C64B8248A3EA8646DD1AE17A` | |
| Committee member 0 | `qor1wfq5axlqy9dltke82trh8d25mmsu557wj0ztju` / `0x72414e9bE0215BF5dB2752c773B554DEe1ca53ce` | `6F597B76A0F86DC783725EB0DC88EEA8F360388B222EE31E5347C4940EEA0D3B` | `ECFEAFEAA9E55A403FECA8909EBF21885807936DB3B703F6BE8F66A3203FED8B` |
| Committee member 1 | `qor1r9zmaagpg69ggdphsqeefp39c2vgxphwuxwsk4` / `0x1945bEf501468a8434378033948625c2988306EE` | `4F2E73D71DD0787767367AC6A9BBD9F35908916370E1F2103D1E9231D8E16F4E` | `A7B6E93F1E9A1F6F25DAF7630F36723C979E84BC263B64219FEF971A059C10E9` |
| Committee member 2 | `qor1dt63e253udqqsrwkzrsrwyzpzuux7cvazafee2` / `0x6Af51CAA91E340080dD610e037104117386f619D` | `9173A189E85C9EA21106BBCA2BB744A3A18F8D79F1FB0138D61B1EE3DFBB1905` | `7EBD492CDACEB7A895F4A527F498C938CD1A74B908A5258FAA6B08BCAA719729` |
| Reporter 0 | `qor13r2c8flljmc7j2wp3vd3ag0mfzev3klxa7utxh` / `0x88d583a7Ff96F1E929c18b1b1Ea1Fb48b2C8DBE6` | `EAAFCB6BAB053FC894304A96B1AA2D59445E16C77575170D7A77D9ECB4CD6277` | |
| Reporter 1 | `qor1t5e4vxq6fspggh5lmp6y7wj8kmyvz8zlseg5vy` / `0x5D3356181A4C02845E9fD8744f3A47B6c8C11C5f` | `2395E5FD6FF0BAF19B25F52681318855E1057442C9E2D7F32CB0FEB81A41E3DC` | |
| Reporter 2 | `qor1sgkuem0hed58795xkdacyfhudpslpsae828tye` / `0x822dcceDF7cB687f1686B37B8226fc6861F0c3B9` | `E128B9A1B734A0C8BE1A58FC52367D53AF80BD557AFD5B353E0B8C675C81B6BE` | |
| Watchtower | `qor1j447tc5n92gqnu7dp0u5qx0d5s72c99543cfxv` / `0x956be5e2932A9009F3Cd0BF94019Eda43cac14b4` | `DEBB4A5FD7A60CB132042FD7CB1ABC213C62FF7AF7DC76140D59B5CAC3CB8EBE` | |

The sequencer funded the other seven accounts with hybrid-signed bank sends: `2FE5011DAE80ABDB455F2141F056538F89082BCD8FAD3397CEA4B5B01D51B368` and `DBF1C7E83169DE86248D1DA82FFC67C2987FFF9B73A1EF350BB53DE58DF26670`.

## Deployment

| What | Where | Transaction |
|---|---|---|
| Rollup `augury-oracle` (based sequencing, `qledger-v1`, 10,000 QOR stake) | native | `A08941A73C3F11081F2435B6CBF1B135668D65DAF471CEC3CDB251079C4116B4` |
| **AuguryHub (current, salted reports)** | `0x49bc74d9ad38f805f52984cc2f6d338429b4d3bd` (EVM) | `0xeb5e7f8686557bc8780c8821889c924b59616cac9c79db83800c5a1d0bd27d02` |
| Sequencer bond, 10 QOR (through a hub-scoped EVM window) | current hub | `0x6fea5145481cdc017bbdb0562157d66864039b4b6d1b33bef23d38f8fd26c872` |
| Reporter 0 stake, 1 QOR | current hub | `0xfe2a7133235d7e24c4dad1264a5af48d40d1c782b98338a6dbfd0a9ba2045786` |
| Reporter 1 stake, 1 QOR | current hub | `0xe089cb673f508d471640596d522ba5d5588be68ebf2a1489cb3cd54272075c75` |
| Reporter 2 stake, 1 QOR | current hub | `0x4074b1c248f3005f21e14bbca961c00c336a08be5f96e2af871185efe6c7729c` |

**Superseded first hub** `0x86a901909cad74ee281622243dac06c6c33d6236` (deploy `0x4ff215ee2a06514998935683275032f9f1d6baf644317aac204e9fbc59d7f08b`, bond `0x506e1c97bc09b28eafbba272095a7e350b78518bd147393911af4222b9c77f86`, stakes `0x3187eb49…`, `0xcb82b86a…`, `0xd80f3cf8…`). Its first live round showed that a qledger-v1 post is limited to 6,144 bytes, while a sealed report carrying its 4,627-byte ML-DSA-87 signature was about 13 KB in the old encoding. Reports are now a sealed message plus a separate signature post, and the signed message carries a sealed random salt so the public signature cannot be used to test guessed prices. That changed the signed format, so the hub was redeployed. Recorded in `deployments/testnet-v1.json`.

## Protocol Builders requirements

| Requirement | Proof |
|---|---|
| ML-DSA-signed batches | Round 1 batches on AuguryHub, each verified on chain with `pqcVerify` against the sequencer's registered ML-DSA-87 key: fBTC/USD `0xdf93fb41b93b855593a611c4d856959daff23d55738380aa342d1cc66ca4a222`, fETH/USD `0x4cb985dc84e969c7f246d33ba4c9c84a27bbb71bbe6517f9864a62221195605c` (see "Live rounds") |
| Withdrawal | Pending: reporter and sequencer withdrawals after the exit delay; rollup withdrawals with settlement receipts |
| Verified settlement receipt | Pending: anchoring rollup batches with the creator's ML-DSA-87 key |
| Watchtower | Audited both round 1 batches from their calldata against the rollup inbox: "checks out". A fraud drill is pending |
| ML-KEM data protection | Reports sealed with QoreSeal (ML-KEM-1024 + X25519) to each round's key; share deliveries sealed in ML-KEM-1024 mode to the committee's registered KEM keys (see "Live rounds") |
| Threat model | [THREAT_MODEL.md](THREAT_MODEL.md) |

## Live rounds

**Round 1, 2026-11-24 (UTC 2026-11-23 23:18–23:21), rollup `augury-oracle`, hub `0x49bc74d9ad38f805f52984cc2f6d338429b4d3bd`.** All eight roles ran with `pnpm augury <role>`; round length 60 blocks, closing at height 10,634,354.

| Step | fBTC/USD | fETH/USD |
|---|---|---|
| Committee member 1 opens the round (round public key, share commitments, three sealed deliveries; one native tx) | `162EE0B6E64018B29F4F239E44A1479CF813C1E290BEA9AE0B8233B9B2387717` | `5AAD02AF86B57CF856008969726A09DB283BD7BDB7B002F160450FB2C91B4F1C` |
| Reporters post sealed report + signature (one native tx each) | `C4097EA6A73CF486F5CF2965247C7AF6D989CD8F6C33D97559199FCD30BC926D`, `584411DD4937D48B7488425311B0D36A7F6B7D7C5320E0BC9FCA0ED749A6943D`, `9D19A6795D37DF92A76A3562DEF2963AF11128842005117BD860A658B4F8F234` | `D55DD654B4F0CFD7A1DC1863693C21D1494E8D38F98ED1FD9A0C2997CA120BF5`, `0F92BE73CC78E43493BF50CC1AC9F816B37CCED50CE185B990FE00F74047BE6E`, `8C35270965430981C8DFBA5744B1091FC553CE00A7E647501496E10C382B5D8C` |
| Committee members release shares after the close (six releases, three members × two feeds; the log does not say which is which) | `40B033C17B7DB3158DAB028433B49F6582E47599A70E4008FD2F492B4EE1CB41`, `4CC6680657E067A5103279C3D8613FD471461D86EE0AAAB80248222283347D98`, `B68F7882DB73E91CCB8A55CC2EC594E248C5C9373EEF6A26B54733864D58DFBB` | `64F1515EE9E776D0E2FF64212A8E861AAF9F6B5D4C67EC034D3762107B8B4988`, `9A9DC5762DFE7EA251A41E500EB42809FCBA5837AC0B7886EA155356F1A75FC4`, `A178735CF4EE0C326878AD2AD738EA4B9AA875CD3B07B296A831F5F0BF1CE6C4` |
| Sequencer posts the ML-DSA-87 signed median through a hub-scoped EVM window | `0xdf93fb41b93b855593a611c4d856959daff23d55738380aa342d1cc66ca4a222` | `0x4cb985dc84e969c7f246d33ba4c9c84a27bbb71bbe6517f9864a62221195605c` |
| Settled price read with `getPrice` | 6,143,114,750,000 (USD 61,431.1475), 3 reports | 171,585,000,000 (USD 1,715.85), 3 reports |
| Watchtower audit | checks out | checks out |

**Round 2** settled the same way a minute later: fBTC/USD 6,146,789,250,000 (USD 61,467.8925), batch `0xa703357071fcdcaf4f0e18d15fe9ffbe61ccc8ac4d5277aec20cdcf92f448ae8`, audited "checks out"; fETH/USD 171,648,250,000 (USD 1,716.4825), batch `0xebe852856818bf797d949dfa4e7a2551d4572901d0dee9489fcb67a6b10783ca`. The roles were stopped during round 3 to save fees. During the run one reporter correctly skipped a round when only one of its three price sources answered, and another retried after a transient network error.

## Drills

| Date | What we did | Result | Transactions |
|---|---|---|---|
