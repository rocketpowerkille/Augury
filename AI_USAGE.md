# AI Usage

How we use AI coding assistants (Claude Code and others) to build Augury, and the rules they follow in this repository. Humans own every decision and every line that ships; AI assistants draft, research and check.

## 1. Rules for AI assistants

### Git and GitHub: only when asked
- Do not commit, push, merge, rebase, tag, or open or merge pull requests unless a team member asks for that specific action in the current conversation. Approval for one commit or push does not carry over to the next one.
- Do not create, switch or delete branches without being asked.
- Never force-push, rewrite published history (`reset --hard`, `commit --amend` on pushed commits, interactive rebase) or delete remote branches.
- Never skip hooks (`--no-verify`) or bypass signing.
- Before committing, show what will be committed (`git status`, `git diff --staged`) and stage files by name, not with `git add -A` or `git add .`.
- Commit messages contain no AI names and no AI co-author lines.
- Do not change `LICENSE`.

### Chain and keys
- Do not deploy contracts, broadcast transactions, register keys or spend faucet tokens without being asked. Everything on `qorechain-diana` is permanent and is read by the hackathon judges.
- Testnet (`qorechain-diana`, EVM chain ID 9800) only. Never touch mainnet.
- Never read, print, log or commit private keys, mnemonics, recovery phrases, ML-DSA or ML-KEM secret keys, or `.env` files. Keep secrets in git-ignored files.
- Never paste secrets into chat, issues, commit messages or code comments.

### Scope and changes
- Do what was asked. Propose anything beyond that instead of doing it.
- Ask before adding, removing or upgrading a dependency, and say why it is needed.
- Ask before deleting files or making large refactors.
- Prefer small, reviewable changes over large rewrites.
- Do not edit generated files, lockfiles or vendored code by hand.

### Honesty
- Do not claim something works without running it. Say what was tested and what was not.
- Report failing tests and errors as they are, with the output. Never weaken, skip or delete a test to make it pass.
- Every claim about the chain in the README or docs must link to a real transaction in `EVIDENCE.md`. No made-up hashes, addresses or numbers.
- When unsure, ask instead of guessing.

## 2. Development rules for everyone

### Cryptography
- Use the official kits (`@qorechain/pqc`, QoreSeal, the QoreChain SDK, RDK). Do not hand-write cryptographic primitives.
- No `ecrecover` or classical-only authorization in contracts. Sensitive actions are checked with `pqcVerify` against keys validated with `pqcKeyStatus`. QoreScan runs in CI to check this.
- Every change to signing, sealing, key handling or the fraud proof is reviewed by our PQC/security team member before merging.
- Changes that affect security assumptions update `THREAT_MODEL.md` in the same change.

### Code and tests
- Contracts are tested with Foundry. Run `forge test` before calling contract work done.
- TypeScript is type-checked and linted before calling it done. The exact commands go here once the packages exist.
- New behaviour comes with tests, and bug fixes come with a test that reproduces the bug.

### Git workflow
- `main` always works. Work on short branches named `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages follow Conventional Commits, e.g. `feat(hub): verify batch signature with pqcVerify`.
- One logical change per commit.

### Hackathon rules we must keep
- Only work done during the fest (from 4 November 2026) counts. Do not import pre-built projects.
- Credit every open-source library, kit and template in the README.
- Third-party code must have a licence compatible with MIT.
- Keep the README, `EVIDENCE.md` and `THREAT_MODEL.md` accurate, because the jury checks them against the chain.

## 3. Human review
- A team member reviews AI-generated code before it is merged and must be able to explain it.
- The team member who merges a change is responsible for it, whoever or whatever wrote it.

