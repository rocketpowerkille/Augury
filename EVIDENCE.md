# Evidence

Every claim Augury makes about the `qorechain-diana` testnet is listed here with its proof. Rows are added only with real transaction hashes and addresses.

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
| AuguryHub v2 (salted reports; superseded, see below) | `0x49bc74d9ad38f805f52984cc2f6d338429b4d3bd` (EVM) | `0xeb5e7f8686557bc8780c8821889c924b59616cac9c79db83800c5a1d0bd27d02` |
| Sequencer bond, 10 QOR (through a hub-scoped EVM window) | v2 hub | `0x6fea5145481cdc017bbdb0562157d66864039b4b6d1b33bef23d38f8fd26c872` |
| Reporter 0 stake, 1 QOR | v2 hub | `0xfe2a7133235d7e24c4dad1264a5af48d40d1c782b98338a6dbfd0a9ba2045786` |
| Reporter 1 stake, 1 QOR | v2 hub | `0xe089cb673f508d471640596d522ba5d5588be68ebf2a1489cb3cd54272075c75` |
| Reporter 2 stake, 1 QOR | v2 hub | `0x4074b1c248f3005f21e14bbca961c00c336a08be5f96e2af871185efe6c7729c` |

| AuguryHub v3 (pinned reporter keys, post-time activity; superseded, see below) | `0x74a9cf2c448328d0bbde986228c4ca340ff04054` (EVM) | `0xf4ef42cb3a77cee3d9d7062f34609d0d52891224fdc06dbad8ad6359fa0825d2` |
| Sequencer bond, 10 QOR | v3 hub | `0x6a4f07b00769bc1ea9cbfa983948b5e44f588fd81887e8b81ac0418d9318c816` |
| Reporter 0 stake, 1 QOR (pins its 2,592-byte ML-DSA-87 key) | v3 hub | `0x36362bc80ed4dcdaf210f94f8944185814148dc2a47100ce69076c48210601b9` |
| Reporter 1 stake, 1 QOR (pins its key) | v3 hub | `0x9fd613ed9afa90c1eba788dcd52175cfb6f9444beced01c170d2ba6a74a60cc3` |
| Reporter 2 stake, 1 QOR (pins its key) | v3 hub | `0x8312d7080bc39634aa7f5d3c73a20ce4a6524e30e467ba0bd53ec94ca671b847` |
| Watchtower sends 5 QOR to the sequencer for the v3 bond (native, hybrid-signed) | native | `F9E3F263031D27B6D5553DD6A32D709099CCBA94148DC2AE3FD0FD5C16321603` |

| **AuguryHub v4 (current: also an overflow-free median)** | `0xa31ff9fa4435250040950267f185ad7bb9301500` (EVM) | `0xa515af31c3d609175f88d4b00555d68dfb7b26fea0f944fcd7c9fe8702694deb` |
| Sequencer bond, 10 QOR | v4 hub | `0xb4c7a11111a8af9f2c4c2bb73756c1e5cdc938bc78abfd7100c63eab02664cba` |
| Reporter 0, 1, 2 stakes, 1 QOR each (each pins its ML-DSA-87 key) | v4 hub | `0x37152f287d42a7d854411c6e72452438310059e75f180ae8cf02df8dc8a9f587`, `0x3af843be8ba9b6b56ea59fc9a6b6d415d69019c304b906a185f6bc1e0cce189a`, `0x7e67775c02e1c030f2316468843086d5ca131d12f079c0891a4ffdf27238ecb4` |
| QOR moved to the sequencer for the v4 bond: 6 from the watchtower, 3 from committee member 0, 3 from committee member 2 (native, hybrid-signed) | native | `48677470545A7D2522A29DF570E9D42C277A9D97A90B577BCA56934C93C3FC0A`, `0E6EE7768BE403DF9D4B258C9EB6C822B4C075F187EC85F48F26A28E49FDEFA6`, `AD0C5D82771F6DBC1267347EA3CBBAB2E8D90829ED93BA4A4C2854D321F658CD` |

**Superseded v3 hub** `0x74a9cf2c448328d0bbde986228c4ca340ff04054`, recorded in `deployments/testnet-v3.json`. Its median computed `(a + b) / 2` for an even number of reports, which overflows for extreme values and makes `challengeBatch` revert (gap 16 in [THREAT_MODEL.md](THREAT_MODEL.md)). v4 computes the same value without overflowing.

**Superseded v2 hub** `0x49bc74d9ad38f805f52984cc2f6d338429b4d3bd`, recorded in `deployments/testnet-v2.json`. A security review on 2026-11-26 found that a reporter included in an honest batch could get the sequencer slashed on it, by being slashed for equivocation or rotating its ML-DSA key during the challenge window (T14 and T15 in [THREAT_MODEL.md](THREAT_MODEL.md)). The v3 hub pins each reporter's key at stake time and judges activity by recorded times. `reporterKeys` on the v3 hub returns a 2,592-byte key for each of the three reporters.

**Superseded first hub (v1)** `0x86a901909cad74ee281622243dac06c6c33d6236` (deploy `0x4ff215ee2a06514998935683275032f9f1d6baf644317aac204e9fbc59d7f08b`, bond `0x506e1c97bc09b28eafbba272095a7e350b78518bd147393911af4222b9c77f86`, stakes `0x3187eb49…`, `0xcb82b86a…`, `0xd80f3cf8…`). Its first live round showed that a qledger-v1 post is limited to 6,144 bytes, while a sealed report carrying its 4,627-byte ML-DSA-87 signature was about 13 KB in the old encoding. Reports are now a sealed message plus a separate signature post, and the signed message carries a sealed random salt so the public signature cannot be used to test guessed prices. That changed the signed format, so the hub was redeployed. Recorded in `deployments/testnet-v1.json`.

## Protocol Builders requirements

| Requirement | Proof |
|---|---|
| ML-DSA-signed batches | Latest: v3 hub batches fBTC/USD `0xd95aadf4dbd5c2d3f3cdc6f9787852e3384fe9e3c38c3b742710a6dbb687ecac` and fETH/USD `0xcfd52da90eee8758cbbd08f24551d210ab336e52e172253d2d1265d33901b6d2`. First: round 1 batches on the v2 hub, each verified on chain with `pqcVerify` against the sequencer's registered ML-DSA-87 key: fBTC/USD `0xdf93fb41b93b855593a611c4d856959daff23d55738380aa342d1cc66ca4a222`, fETH/USD `0x4cb985dc84e969c7f246d33ba4c9c84a27bbb71bbe6517f9864a62221195605c` (see "Live rounds") |
| Withdrawal | Pending: reporter and sequencer withdrawals after the exit delay; rollup withdrawals with settlement receipts |
| Verified settlement receipt | Verified in the CLI (RDK chain mode), in Solidity on chain and through the browser verifier, on a real public receipt (see "Settlement receipts in Solidity and the browser"); anchoring Augury's own batches is pending a 1,000 QOR submitter bond |
| Watchtower | Audited every live batch from its calldata against the rollup inbox ("checks out"), and in the fraud drill proved a lying batch wrong on chain: the batch was invalidated and the sequencer's bond slashed (see "Drills") |
| ML-KEM data protection | Reports sealed with QoreSeal (ML-KEM-1024 + X25519) to each round's key; share deliveries sealed in ML-KEM-1024 mode to the committee's registered KEM keys (see "Live rounds"); a private feed whose epoch key is sealed to subscribers' registered ML-KEM-1024 keys and rotated when a subscriber is removed, who then cannot read the next value (see "Private feeds") |
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

**v3 hub, 2026-11-26 (UTC 2026-11-25 23:22–23:25), hub `0x74a9cf2c448328d0bbde986228c4ca340ff04054`.** All eight roles ran with `pnpm augury <role>`. Round numbers continue the shared rollup inbox, so this is fBTC/USD round 6 and fETH/USD round 4. The sequencer skipped the earlier inbox rounds as `too-few-reports`, because their reports were signed and sealed for the v2 hub's address.

| Step | fBTC/USD round 6 | fETH/USD round 4 |
|---|---|---|
| Committee opens the round (closes at height 10,755,327) | `0D7428E4E480C252AD469AE7F6F14C71B65D63E5B5D86BD7ECC8AEE61BE58410` | `9A35180713952B9F2E64C793073B15CB0224263B2D45B9020A0807FCF5AC9D62` |
| Reporters post sealed report + signature | `8ECE20904B5DEDD3EDC7CD825EE476EA985A0BC1662312FBF9118B839D2A29F7`, `24ACCD80FC2AE9D285A7F5D5C5375607D8E4EF492AEC476EF0724B736D8115BC`, `FB632C4592AE49492D0100AC2F2C76CFDA590847F8E79B33989C80BDFAA88F04` | `612EF63F09F99E99450DB6BED4AD0D97C7FD74DAAEA090F20FF9DD3A3BD5A5F3`, `AAC970509E41A09E4EAF70947344020F4A0CEF4395F632D723EC31100BA9324D`, `0A22FD6CC1F1DEDDCAA18D098F2EA529CDD2A01A0B86F9DD6AB5DE0FDCD42C8F` |
| Committee members release shares after the close | `60E5B5AB9958E21B625F6228F62285A06A5430C60A9AB26F765D987220DEA33B`, `291B0FE8E0BDAD9D5A1A4C0282E8C5EE822E79E53798E3586B78684F207FFB85`, `36643B9BC42E4A1559C4F2D655D9F160CFA4FB8C3D8C7CE23551802EA9B755A3` | `9D990EAEF8598E0EE52DECC0983BF0F261279FD01E440EA0E150763E07BF9DAC`, `CA51A91F8C88A955F8E7702210ED31C886B2379BF7EC373BE9B9F95ECA63D403`, `3FA2A5BC8FF7686E3363EA484A8FC19EC84D0721A1FAC0487CA3A89F3F8AC1BC` |
| Sequencer posts the ML-DSA-87 signed median (block, gas) | `0xd95aadf4dbd5c2d3f3cdc6f9787852e3384fe9e3c38c3b742710a6dbb687ecac` (10,755,344; 547,673 gas) | `0xcfd52da90eee8758cbbd08f24551d210ab336e52e172253d2d1265d33901b6d2` (10,755,354; 547,493 gas) |
| Settled price read with `getPrice` | 6,017,810,000,000 (USD 60,178.10), 3 reports | 168,825,000,000 (USD 1,688.25), 3 reports |
| Watchtower audit | checks out | checks out |

**v4 hub, two dealers per round, 2026-11-26 (UTC 00:08–00:11), hub `0xa31ff9fa4435250040950267f185ad7bb9301500`.** Every round now has two dealers, each knowing only its own seed, and every report is sealed to both round keys (section 7 of THREAT_MODEL.md). Round numbers continue the shared inbox: fBTC/USD round 8 and fETH/USD round 7.

| Step | fBTC/USD round 8 | fETH/USD round 7 |
|---|---|---|
| Layer 0 dealer opens (round key, commitments, sealed deliveries; closes at 10,757,251) | `55D4F6507234DCB08642F56AD3390841FC425BD7259BE5FC34F0FBCF4CE50D8D` | `978BF055074C53FCA4EF81D6AFAED07E47D5AE59CB25B9E42C44A0A19B2C218C` |
| Layer 1 dealer, a different member, opens with its own seed and the same close | `56F0DCB230560017B225D6BF07AEAA7F9D350F68D89502A8758A1E2F2A816022` | `419A5A32E91843C3A7ADA574E8EC4D09B602DD614D59F6703F57BB94C6467140` |
| Reporters post a report sealed to both keys + its signature | `BB870B1D066A7BBC22AB1AFDC698248FD58C2B47C3CCE30DC21F2D7287C531E3`, `D988D7BD498B392BD34EB68AFC5A5AC56F0D45F40E1586966CCEE14C72F7A7DE`, `2D2C0AF08C7F359C1C8E5C3436D80302AAAA88E9EE26003E44D9F9B636E357CD` | `1422141F99348615B28AD825D5CEB13A5568AE67BBF8E935682FA6BF3459D2AC`, `72541CB84D56708952BFC1FC220AB40045E517D80491AA77BDCE7C43E5DD36F6`, `1821E0BAA8B0D7A9CD78486728A3E769F486EAA7AE7EE14B9A353EEB5D55814D` |
| Layer 0 shares released after the close | `E8918E93DFBFB900317B4E5839152577AC76EF8B903A215EC0A72B3780FFA013`, `3F7627F65C9CCD52E414E7BD7B176C7047B2D5A2DE50384101696690D967E3B5`, `A79CF590055C058370B1C042FDF1430EFD5708B6C2BA42F4AFD29C1E0FEAFC35` | `8D3B95D05EEFCCD006D4B89C173086152702AE9C8A08204165FF8A67690CF6F1`, `9A2A70DAB518018D3150EC16B723E53D039FA2D58D5698DE860FFCEB4942378A`, `88141D8BAEC12398B788F436FC02CA63FE4F6ECC7F1715F1D0FDF8C4182FCAC4` |
| Layer 1 shares released after the close | `E97278D3F2448E0EDD45E05894809FFFCD12A650D1130997451149AB69BA7140`, `A55A50172E9E3DDE12C826CDE59AE8CC0AB9717FA196D3B1986F9BAFFFDE3163`, `729823CC9FCB1B4EDB47E80D7F6A3E6FD3C9D65E30D55A25054F61748BE94B50` | `001FEA1A6B3CEB3654187801C773615ABE6E54266F95159FA71611A6BAC92D49`, `5B2C1947FD4FD2C7E873A7D7742B7A043C90884B6BE756A95831DC3092EAFB83`, `10B86770CA927ECA657D33B4CA819A4C0789B86C0D6D0BCF35CEA4898C006269` |
| Sequencer opens both layers, verifies, posts the ML-DSA-87 signed median | `0x0f827567e593673f5f85a954c66c179d52e8474764d4e1f203184af1e0bcc37e` | `0xa71311d75abf7208785d4936920e401bc7ba8bc8005cf72b626f7bbfc3762ef8` |
| Settled price read with `getPrice` | 6,041,410,000,000 (USD 60,414.10), 3 reports | 169,109,000,000 (USD 1,691.09), 3 reports |
| Watchtower audit | checks out | checks out |

The first batch attempts failed before broadcast: the sequencer had just used the same account to record a receipt, and the node reused that EVM window, which was scoped to the receipt contract instead of the hub. The fix checks a window's allowed targets before reusing it (`windowAdmits`, with a regression test); the batches above were posted after it.

## Settlement receipts in Solidity and the browser

`SettlementReceipts` rebuilds the RDK's canonical v2 anchor message byte for byte, resolves the rollup creator's key with `pqcKeyStatus` and checks the ML-DSA-87 signature with `pqcVerify`. Our own rollup has no anchored batch yet (the chain requires a 1,000 QOR submitter bond), so it was checked on a real receipt of the public rollup `cloister-dev-1`, batch 1, which the RDK verifies as valid against live chain state (`packages/chain/test/fixtures/receipt-cloister-dev-1-1.json`).

| Step | Result | Transaction |
|---|---|---|
| Deployless `eth_call` of `verifyAnchor` against the real precompiles | valid; the same receipt with another state root or chain id is rejected | read-only |
| Deploy SettlementReceipts `0xdbd2aba7128ceb68a392b4b218b7cfd742b44a6b` | | `0x0019f88a77fb4e401f18d9fd7f9f43b3511c8394355ea0aaf24111a93c585137` |
| `record` the receipt: signature verified on chain, `ReceiptRecorded` emitted | success | `0x120d8cd5eaf0b272c6ace8f31f0d1eb12b6d8e27d6b0dda64cb08a948fb6021c` |
| The browser verifier's own code (`web/verify-receipt/verify.js`) calls the deployed contract | valid | read-only |

What this proves and does not: the creator's registered post-quantum key signed exactly these anchor fields. That QoreChain recorded the anchor is native chain state, checked by the RDK's chain-mode verification (`settle.ts`), not by the EVM or a browser.

## Private feeds

**2026-11-26, PrivateFeeds `0x298bccca3fc740a5a80ffb8bfbf4a7f7b716adf1`, feed `NAV/demo-fund` (`0xc617c2c2b69484e58e7a6fc23d8f665ad507bea6f12e9c0a8e385aed8b203c36`).** Run with `packages/node/scripts/private-feed.ts`. The publisher is the sequencer account; the subscribers are committee members 0 and 1, known only by the ML-KEM-1024 keys they published in the chain's KEM registry. The values are demo numbers, not a real fund's NAV.

| Step | Transaction |
|---|---|
| Deploy PrivateFeeds | `0xae39461c86fe5754211b41e10f0829c59c8227a567f45fa4afa3070a55ded0da` |
| Round 1: epoch 3 key (sealed to both subscribers) and the sealed value posted to the rollup inbox | `6566BE8BF18E6D5060EBE3D059021D0DAA43C38E3E85B3E1735D6C4BA09CC1C3` |
| Round 1: commitment `0xa18474aba676f98c67a18fc956762aac6341c554b72b40df74a4fcc84e7ceda2` published, ML-DSA-87 signature checked with `pqcVerify` | `0xe3ac90d3080407d5cc2ca4085942946fc56c1bf510acfbf5392821f88d24f5fb` |
| Committee member 1 removed; round 2: epoch 4 key (sealed to member 0 only) and the sealed value posted | `AEA7E39089ABF5AF2BC6B7782F213E861C0F344EAFCF6D80BE4A472C8B957A1A` |
| Round 2: commitment `0xd93bd2925299185550e60efdd6f872808db5d0106f218dd16c39a3b818a3fc13` published | `0x4cc0deb2b3eb433c77cac672de97ff554a794428520ff04dac200ce28aabfa0c` |

Reading the posts back from the chain's inbox and opening them with each subscriber's own key:

| Subscriber | Round 1 (USD 104.25) | Round 2 (USD 104.26) |
|---|---|---|
| Committee member 0 `0x72414e9be0215bf5db2752c773b554dee1ca53ce` | read; `verifyValue` on chain = true | read; `verifyValue` on chain = true |
| Committee member 1 `0x1945bef501468a8434378033948625c2988306ee` (removed before round 2) | read; `verifyValue` on chain = true | cannot read: no key for epoch 4 |

## Drills

| Date | What we did | Result | Transactions |
|---|---|---|---|
| 2026-11-24 | **Fraud drill.** Acting as a dishonest sequencer, `drill.ts` built round 3 of fBTC/USD honestly from the inbox (3 valid reports, median 6,141,687,500,000 = USD 61,416.875), replaced the median with double the value (12,283,375,000,000), signed that header with the sequencer's real ML-DSA-87 key and posted it. The hub accepted it (valid signature). The running watchtower rebuilt the round from the inbox, found `wrong-median`, and submitted the one-step fraud proof (three on-chain ML-DSA-87 verifications plus the median, 677,998 gas). | Batch status Invalid; sequencer bond 10 QOR to 0; 5 QOR paid to the watchtower (balance 9.909 to 14.788 QOR after fees); 5 QOR kept in the hub (`slashedTotal`). Between the post and the challenge, `getPrice` briefly returned the lie while `getFinalPrice` kept returning round 2; after the challenge `getPrice` fell back to round 2 (USD 61,467.89). | Lying batch `0xf411756f0bc0d3c2bb3208428c56ac0f1de2d377bd403c878ab76ea7128e71c1`; challenge `0x620969a68679940e0c8de8b16bf41c7c78444a1c10b914c4d73077ffad846ad1` (block 10,637,254) |
