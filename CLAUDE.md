# CLAUDE.md

Instructions for AI agents working in the Ember EVM vault contracts (Solidity).

## Read first

This tree is already well documented — twelve documents under `docs/`. Start with the router, not the code.

| Doc | Read it when |
|---|---|
| [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) | **First.** Routes you to the right document for the task, maps the contracts, and covers what the others leave out. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Orienting on how the pieces fit. |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Working in a specific contract. |
| [docs/ACCESS_CONTROL.md](docs/ACCESS_CONTROL.md) | Anything touching roles or permissions. |
| [docs/TIMELOCK.md](docs/TIMELOCK.md) | Anything touching a privileged action. |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Deploying or upgrading. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Setting up, building, testing. |
| [docs/BRIDGE.md](docs/BRIDGE.md) | The OFT adapter and cross-chain share movement. |
| [docs/FUZZING.md](docs/FUZZING.md) | Property tests, Echidna, Foundry fuzzing. |
| [docs/AtomicLiquidity.md](docs/AtomicLiquidity.md) | Anything touching atomic liquidity. |

When you learn something during a change that one of these should have told you, update it in the same PR. Put it in the document that owns the topic — do not start a thirteenth overview.

## This is contract code

A defect here is a withdrawal, and it is final. Three rules follow.

**Prove it, don't reason about it.** Before claiming a change is safe, write the test that would fail if it were not. A green suite that never had a failing case proves nothing. This tree has Foundry fuzzing and Echidna property tests — for an invariant, a property is stronger evidence than a unit test. If you cannot construct the failing case, say so and lower your confidence, not the severity.

**The chain is ground truth.** `deployments/`, a README, and your own earlier conclusion all drift from it. Read the deployed contract. Most retracted conclusions come from trusting a second-hand source.

**Scope every claim to what you ran.** This tree has two test runners. "Tests pass" after `yarn test` says nothing about the Foundry suites. Name what you ran and quote the count.

## Solidity specifics that bite

- **Upgrade storage layout.** No reordering, no type changes, appends only, gaps preserved. Check the layout before and after, not just that it compiles.
- **Reentrancy.** Any external call can re-enter: a token transfer with a callback, a hook, a strategy adapter. Write state before the call, or hold a guard. A transfer to a contract address counts.
- **Token assumptions.** Fee-on-transfer, rebasing, missing return values and blocklists each break a naive `transfer`. State which the vault tolerates.
- **Rounding direction, and who absorbs the dust.** Every division picks a winner. The vault should absorb dust on both deposit and redemption; rounding in the user's favour on both sides is a slow drain no single transaction reveals.
- **First-depositor and empty-vault cases.** Zero supply, zero assets, and a direct donation to the vault's balance. Share-price inflation is the classic 4626 attack — know what prevents it before changing anything near it.
- **`unchecked` blocks.** Confirm the bound that makes each one safe still holds after your change.
- **Event layout is a wire contract** with the off-chain indexer. Changing a parameter's type, order or indexing breaks decoding downstream even when the contract is fine. Treat it as breaking and name the consumer.

## Where this chain differs from the others

Ember runs the same vault model on three chains. The Sui implementation (`sui/`) and the Solana implementation (`solana/`) differ from this one in ways that matter when porting a change or writing shared tooling:

- **This tree has no deposit slippage bound**, because ERC-4626 fixes the `deposit` and `mint` signatures. Sui and Solana take a minimum-shares argument. Do not build an interface or a doc implying EVM depositors have that protection.
- **This tree uses `OwnableUpgradeable` for admin.** Sui and Solana use a two-step handover.
- **This tree has two OpenZeppelin timelocks. Solana has none** — a privileged change lands immediately there.
- **The withdrawal allow list is Solana-only.**
- **Confirm the rate's direction before touching arithmetic that uses it.** Shares-per-collateral and its inverse are both plausible readings, the mistake is silent, and a symmetric test passes either way.

## Settlement

The highest-value code in the protocol, and where a plausible-looking improvement does the most damage.

- **A missing or invalid destination aborts the batch. It does not skip the request.** Turning an abort into a skip converts a stuck batch into a silent mass cancellation. It reads in review as robustness. It is the worst change anyone can make here.
- **Batch bounds come from the gas budget, not from a request count.**
- **FIFO ordering determines who gets paid.** A change that reorders, skips or compacts the queue needs its ordering guarantee proved, not asserted.

## Safety boundaries

- **Agents never broadcast a mainnet transaction.** Stop at a fork, a local node or a testnet. Check what a script's network argument defaults to before running it at all.
- **Never deploy or upgrade against mainnet.** That needs a human.
- **Keys come from the environment, never from a file in the tree.** Custody is off-chain Fordefi multisig plus AWS KMS. Never commit key material and never log it — check error paths, where a signer error that stringifies its input is the usual leak.
- **Record what you deploy** under `deployments/`. A manifest that drifts from chain is how the next operator targets the wrong address.
- **Git hygiene for parallel agents:** create your own worktree rather than entering one you found; stage explicit paths, never `git add -A`; update a stale PR with `git merge origin/main` and a plain push, never a rebase plus force-push; never run a bare `git stash pop`.

## Implementation discipline

Structure any new behaviour or bugfix around red-green-refactor — a failing test before the implementation, for each behaviour, without being asked. Skip it only for trivial or config-only changes, and say so rather than silently omitting it. If you did not watch the test fail, you do not know it tests the right thing. Zero output is not a pass: a `--match` filter that matches nothing prints nothing and exits 0.

A change to accounting, authority or settlement that adds no test is incomplete. For an invariant, add or extend a property test rather than a single case.

### Code comments

Default to zero, in every file type. Add one only when it captures a non-obvious WHY — a hidden constraint, an invariant, a workaround for a specific bug — that a reader who knows Solidity and this codebase could not get from the code. NatSpec on a public interface is documentation, not a comment, and is welcome.

Never write a comment that restates the code, references the current ticket, or narrates a migration ("used to live in X", "no longer needed now that Z"). That belongs in the PR description, and it rots into a false statement the next time the code changes. Before calling a diff done, grep your own added lines for the ticket number and for "previously", "used to", "no longer", "now that".

## Build and test

```bash
yarn compile          # hardhat compile
yarn test             # hardhat test
yarn coverage         # what CI runs
yarn format:check     # CI fails on unformatted code
yarn typecheck
forge test            # the Foundry suites
yarn fuzz             # forge test --match-contract Fuzz
yarn fuzz:echidna     # property tests, echidna.yaml
yarn size             # contract sizes
```

Both runners matter: Hardhat covers the integration tests, Foundry the fuzz and property suites. CI is `.github/workflows/ci.yml` — format check, compile, coverage. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/FUZZING.md](docs/FUZZING.md).

## Before opening a PR

Run the `security-review` skill, and again after every push. It runs the built-in security pass, then the fund-loss checks specific to these vaults: authority, accounting, settlement, external interaction, upgrade safety, deployment scripts. `yarn audit:slither` is a useful complement for this tree.

**Every PR touching `contracts/` needs a human approval.** The `auto-pr-review` skill will not approve one, and will not fix a finding in it automatically.

## Skills

`.claude/skills/` holds two procedures, loaded when their description matches what you are doing:

- **`security-review`** — the pre-PR pass above. Identical across all three of Ember's contract repos.
- **`auto-pr-review`** — automated review of open PRs through the built-in `code-review` skill at high effort, posting findings as inline comments. Repo-specific settings are a single block at the top of the file.

## Consolidation

Ember's contract repositories are being consolidated into `ember-contracts`, where this whole tree becomes the `evm/` directory. Keep the move cheap:

- No relative link that reaches above this tree's root.
- Never "this repo" — say "the EVM contracts" or "this tree".
- Refer to a sibling chain by its future directory name: `sui/`, `solana/`.

---

`CLAUDE.md` is the single source of agent instructions; `AGENTS.md` is a symlink to it for tools that read that name, so edit `CLAUDE.md` only.
